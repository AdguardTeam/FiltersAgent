import { createHash } from 'node:crypto';
import * as v from 'valibot';
import type { PlacementMap } from '../types/repo-context';
import {
    FilterListRefSchema,
    FilterListSourceKind,
    LIST_KEY_MAX_COUNT,
    LIST_KEY_MAX_LENGTH,
    LIST_TITLE_MAX_LENGTH,
    officialAdguardListRef,
    type FilterListRef,
} from './filter-list-ref';
import { SUBSCRIPTION_URL_PATTERN } from './official-filter-catalog';
import {
    classifyMissingCatalogFilterId,
    type MissingCatalogFilterClassification,
} from './third-party-filter-catalog';

/**
 * Key prefix of every list file checked into the run's repository; the suffix is the
 * checkout-relative path.
 */
const REPOSITORY_LIST_KEY_PREFIX = 'repo:';

/**
 * Key prefix of every third-party list the reporter enabled by URL; the suffix is the slugified URL
 * identity.
 */
const THIRD_PARTY_LIST_KEY_PREFIX = 'third-party:';

/**
 * Length of the hexadecimal sha-256 digest that restores key uniqueness once a slugified URL
 * identity has to be truncated — long enough to keep distinct report URLs from collapsing into one
 * key, short enough to leave a recognizable identity prefix.
 */
const SHA256_KEY_DIGEST_HEX_LENGTH = 16;

/**
 * Maximum slug characters a third-party key suffix carries, so the whole key stays bounded by
 * `LIST_KEY_MAX_LENGTH` even for a URL whose host and path alone would exceed it.
 */
const THIRD_PARTY_SLUG_MAX_LENGTH = LIST_KEY_MAX_LENGTH - THIRD_PARTY_LIST_KEY_PREFIX.length;

/**
 * Slug characters retained before the digest suffix, so slug plus digest never exceed
 * `THIRD_PARTY_SLUG_MAX_LENGTH`.
 */
const THIRD_PARTY_TRIMMED_SLUG_LENGTH = THIRD_PARTY_SLUG_MAX_LENGTH - SHA256_KEY_DIGEST_HEX_LENGTH;

/**
 * Finite reason a catalog candidate was recorded skipped rather than emitted.
 */
export const SkippedListReason = {
    /**
     * The candidate reference failed `FilterListRefSchema` validation — an over-long repository
     * path, a URL that does not parse, an empty title.
     */
    SchemaInvalid: 'schema_invalid',

    /**
     * The candidate belongs to a valid reference but would push the catalog past the list count
     * bound the request vocabulary enforces.
     */
    CountBound: 'count_bound',
} as const;

/**
 * One `SkippedListReason` value.
 */
export type SkippedListReason = (typeof SkippedListReason)[keyof typeof SkippedListReason];

/**
 * One catalog candidate the catalog refused to emit, kept for diagnosis instead of dropped.
 */
export interface SkippedListEntry {
    /**
     * Why the candidate was not emitted.
     */
    reason: SkippedListReason;

    /**
     * The raw repository path or reporter URL text that named the candidate.
     */
    source: string;
}

/**
 * The run's full list inventory: the repository's own files as owned entries, the reporter's
 * third-party URL lists as not-owned entries, and everything refused recorded as skipped.
 */
export interface ListCatalog {
    /**
     * The deterministic, deduplicated, count-bounded entries — owned repository files first, then
     * third-party URL lists.
     */
    lists: readonly FilterListRef[];

    /**
     * The candidates recorded skipped, in canonical order, never silently dropped.
     */
    skipped: readonly SkippedListEntry[];
}

/**
 * The executor projection of a list catalog: the convergent subset of official refs the preparation
 * request carries, and the classified conflict for every requested id that fell outside it.
 */
export interface ListCatalogProjection {
    /**
     * The convergent subset: exactly one official ref per requested id the pinned catalog
     * publishes, in evidence order. Empty when no requested id resolved at all — including the
     * empty request an instruction-declared launch makes.
     */
    convergentLists: readonly FilterListRef[];

    /**
     * Every requested id the pinned official catalog does not publish, classified against the
     * third-party registry snapshot so a known list is named with its subscription URL and anything
     * else is recorded as an unknown id. Empty when the whole requested set converged.
     */
    conflicts: readonly MissingCatalogFilterClassification[];
}

/**
 * One candidate entry as built, before the schema validation pass decides emission.
 */
interface CatalogCandidate {
    /**
     * The reference as built; whether it satisfies `FilterListRefSchema` is still unknown.
     */
    ref: FilterListRef;

    /**
     * The raw repository path or reporter URL text naming the candidate in skip records.
     */
    identity: string;
}

/**
 * Reduce free text to the bounded single-line form a list title admits.
 *
 * @param raw - The unchecked title source: a path tail or reporter URL text.
 * @returns Control-free, whitespace-collapsed, length-bounded text.
 */
function boundedSingleLineTitle(raw: string): string {
    return raw
        .replace(/[\p{Cc}\p{Cf}]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, LIST_TITLE_MAX_LENGTH);
}

/**
 * Reduce a URL identity to the bounded lowercase characters a key suffix admits.
 *
 * @param raw - The unchecked URL identity: host, path and search, or the raw reporter text.
 * @returns The slug, with every unadmitted character run collapsed to a single dash.
 */
function slugifyIdentity(raw: string): string {
    return raw.toLowerCase().replace(/[^a-z0-9.-]+/gu, '-');
}

/**
 * Build the third-party list key of one slugified URL identity.
 *
 * A slug that fits the key budget is carried whole; an over-long slug is truncated and closed with
 * a sha-256 digest of the full identity, so distinct URLs sharing a long common prefix keep
 * distinct keys instead of silently collapsing into one entry.
 *
 * @param slug - The slugified URL identity.
 * @returns The `third-party:` key.
 */
function thirdPartyListKey(slug: string): string {
    if (slug.length <= THIRD_PARTY_SLUG_MAX_LENGTH) {
        return THIRD_PARTY_LIST_KEY_PREFIX + slug;
    }
    const digest = createHash('sha256').update(slug, 'utf8').digest('hex');
    return `${THIRD_PARTY_LIST_KEY_PREFIX}${slug.slice(0, THIRD_PARTY_TRIMMED_SLUG_LENGTH)}${digest.slice(0, SHA256_KEY_DIGEST_HEX_LENGTH)}`;
}

/**
 * Collect owned catalog candidates from the placement map's list files.
 *
 * @param placementMap - The map naming every `.txt` file of the checkout, checkout-relative.
 * @returns Deduplicated candidates, ascending by key — the repository paths' canonical order.
 */
function collectOwnedCandidates(placementMap: PlacementMap): CatalogCandidate[] {
    const unique = new Map<string, CatalogCandidate>();
    for (const entry of placementMap.files) {
        if (unique.has(entry.relativePath)) {
            continue;
        }
        unique.set(entry.relativePath, {
            identity: entry.relativePath,
            ref: {
                key: REPOSITORY_LIST_KEY_PREFIX + entry.relativePath,
                title: boundedSingleLineTitle(
                    entry.relativePath.slice(entry.relativePath.lastIndexOf('/') + 1),
                ),
                source: {
                    kind: FilterListSourceKind.RepositoryPath,
                    path: entry.relativePath,
                },
                owned: true,
            },
        });
    }
    return [...unique.values()].sort((a, b) =>
        a.ref.key < b.ref.key ? -1 : a.ref.key > b.ref.key ? 1 : 0,
    );
}

/**
 * Parse one unchecked URL text, or resolve to null when it is not a parseable URL.
 *
 * Valibot's `v.url()` action only validates a string; the identity slug needs the parsed parts, so
 * this is the one place a raw `URL` construction happens, and its failure feeds the schema
 * validation pass rather than an exception.
 *
 * @param raw - The unchecked URL text.
 * @returns The parsed URL, or null when the text does not parse.
 */
function parseUrlSafe(raw: string): URL | null {
    try {
        return new URL(raw);
    } catch {
        return null;
    }
}

/**
 * Collect third-party catalog candidates from the reporter's enabled list texts.
 *
 * Only URL texts become entries: a plain name names a catalog entry the official decision already
 * classifies, and inventing a list for it here would bypass that classification.
 *
 * @param enabledListTexts - The report's enabled list texts, untrusted.
 * @returns Deduplicated candidates, ascending by key. A text that matches the URL pattern but
 *   yields an unparseable URL still produces a candidate — the schema validation pass records it
 *   skipped rather than dropping it here.
 */
function collectThirdPartyCandidates(enabledListTexts: readonly string[]): CatalogCandidate[] {
    const unique = new Map<string, CatalogCandidate>();
    for (const text of enabledListTexts) {
        if (!SUBSCRIPTION_URL_PATTERN.test(text) || unique.has(text)) {
            continue;
        }
        const parsed = parseUrlSafe(text);
        const identity = parsed ? `${parsed.host}${parsed.pathname}${parsed.search}` : text;
        const slug = slugifyIdentity(identity);
        unique.set(text, {
            identity: text,
            ref: {
                key: thirdPartyListKey(slug),
                title: boundedSingleLineTitle(text),
                source: { kind: FilterListSourceKind.Url, url: text },
                owned: false,
            },
        });
    }
    return [...unique.values()].sort((a, b) =>
        a.ref.key < b.ref.key ? -1 : a.ref.key > b.ref.key ? 1 : 0,
    );
}

/**
 * Build the run's list catalog from the repository's placement map and the reporter's enabled list
 * texts.
 *
 * The catalog is a pure per-run value with no configuration: every list file of the checkout is an
 * owned entry, and every third-party list the reporter enabled by URL is a not-owned entry. Every
 * candidate passes `FilterListRefSchema` validation; a candidate that fails, or that falls past the
 * list count bound, is recorded skipped instead of dropped, so a fidelity loss is always
 * diagnosable from the catalog itself.
 *
 * @param input - The catalog inputs, bundled.
 * @param input.placementMap - The map naming every `.txt` list file of the run's checkout.
 * @param input.enabledListTexts - The report's enabled list texts, untrusted.
 * @returns The built catalog.
 */
export function buildListCatalog(input: {
    /**
     * The map naming every `.txt` list file of the run's checkout.
     */
    placementMap: PlacementMap;

    /**
     * The report's enabled list texts, untrusted.
     */
    enabledListTexts: readonly string[];
}): ListCatalog {
    const candidates = [
        ...collectOwnedCandidates(input.placementMap),
        ...collectThirdPartyCandidates(input.enabledListTexts),
    ];
    const deduplicated = new Map<string, CatalogCandidate>();
    for (const candidate of candidates) {
        if (!deduplicated.has(candidate.ref.key)) {
            deduplicated.set(candidate.ref.key, candidate);
        }
    }
    const lists: FilterListRef[] = [];
    const skipped: SkippedListEntry[] = [];
    for (const candidate of deduplicated.values()) {
        if (lists.length >= LIST_KEY_MAX_COUNT) {
            skipped.push({ reason: SkippedListReason.CountBound, source: candidate.identity });
            continue;
        }
        const parsed = v.safeParse(FilterListRefSchema, candidate.ref);
        if (!parsed.success) {
            skipped.push({ reason: SkippedListReason.SchemaInvalid, source: candidate.identity });
            continue;
        }
        lists.push(parsed.output);
    }
    return { lists, skipped };
}

/**
 * Split the run's requested official filter ids into the lists the executor request carries and the
 * conflicts the run records instead.
 *
 * The split is the same policy the browser-extension launch already applies against the installed
 * build catalog: an id the catalog publishes becomes exactly one `officialAdguardListRef` in
 * evidence order, an id it does not is classified against the third-party registry snapshot and
 * left out of the request. Refusing the whole set on the first such id would end a run
 * `capability_limited` before `apply_rule` ever executes whenever the reporter has a third-party
 * list enabled (e.g. list 207, Adblock Warning Removal List), and reporters enable third-party
 * lists often enough that this would take out a large share of real desktop reports. Deciding what
 * an empty subset means belongs to the caller, which is the only layer that knows whether the
 * request was empty to begin with.
 *
 * No executor loads the repository's own list files yet, so a run's catalog entries never reach the
 * executor request this way; `namesOwnedPath` in `placement-tool.ts` is the ownership guard over
 * those entries.
 *
 * @param officialFilterIds - The requested official AdGuard filter ids, in evidence order.
 * @returns The projection the runtime hands to the executor request.
 */
export function requestedListsForExecutor(
    officialFilterIds: readonly number[],
): ListCatalogProjection {
    const convergentLists: FilterListRef[] = [];
    const conflicts: MissingCatalogFilterClassification[] = [];
    for (const filterId of officialFilterIds) {
        const listRef = officialAdguardListRef(filterId);
        if (listRef === null) {
            conflicts.push(classifyMissingCatalogFilterId(filterId));
            continue;
        }
        convergentLists.push(listRef);
    }
    return { convergentLists, conflicts };
}
