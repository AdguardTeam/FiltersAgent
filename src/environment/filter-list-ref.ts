import * as v from 'valibot';
import {
    OFFICIAL_ADGUARD_FILTERS,
    OFFICIAL_FILTER_PUBLISHED_URL_TEMPLATE,
} from './official-filter-table';

/**
 * Maximum total length of a list key, so a key stays a bounded stable identifier across captures
 * and artifacts rather than an unbounded echoed string.
 */
export const LIST_KEY_MAX_LENGTH = 128;

/**
 * Maximum number of entries in a key list carried by requests, proofs, and recorded evidence.
 */
export const LIST_KEY_MAX_COUNT = 128;

/**
 * Maximum length of a list title, the human-readable name the catalog publishes.
 */
export const LIST_TITLE_MAX_LENGTH = 200;

/**
 * Maximum length of a repository-relative list path, the same human-scale budget as a title.
 */
export const LIST_PATH_MAX_LENGTH = 200;

/**
 * Key prefix of every list the AdGuard registry owns; the suffix is the registry id.
 */
export const ADGUARD_LIST_KEY_PREFIX = 'adguard:';

/**
 * Registry ids are the positive integers of the AdGuard catalogs; zero and signed forms never
 * resolve.
 */
const ADGUARD_KEY_SUFFIX_PATTERN = /^[1-9][0-9]*$/;

/**
 * Every key in the referenced-list vocabularies, for any supported catalog family.
 */
export const FilterListKeySchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(LIST_KEY_MAX_LENGTH),
    v.regex(/^[a-z][a-z0-9-]*:[^\s:]+$/u),
);

/**
 * A bounded list of list keys, as requests and proofs carry them.
 */
export const FilterListKeyListSchema = v.pipe(
    v.array(FilterListKeySchema),
    v.maxLength(LIST_KEY_MAX_COUNT),
);

/**
 * Where the referenced list text lives for this run, per its catalog family.
 */
export const FilterListSourceKind = {
    /**
     * A list file checked into the run's repository.
     */
    RepositoryPath: 'repository_path',

    /**
     * A list published at an absolute URL.
     */
    Url: 'url',
} as const;

/**
 * One `FilterListSourceKind` value.
 */
export type FilterListSourceKind = (typeof FilterListSourceKind)[keyof typeof FilterListSourceKind];

/**
 * Where the referenced list text lives: a repository file path or a published URL.
 */
export const FilterListSourceSchema = v.variant('kind', [
    v.strictObject({
        kind: v.literal(FilterListSourceKind.RepositoryPath),
        path: v.pipe(
            v.string(),
            v.minLength(1),
            v.maxLength(LIST_PATH_MAX_LENGTH),
            v.regex(/^[^\r\n]+$/u),
        ),
    }),
    v.strictObject({
        kind: v.literal(FilterListSourceKind.Url),
        url: v.pipe(v.string(), v.url()),
    }),
]);

/**
 * One filter list described by an opaque key and its catalog metadata, never by a registry id.
 */
export const FilterListRefSchema = v.strictObject({
    key: FilterListKeySchema,
    title: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(LIST_TITLE_MAX_LENGTH),
        v.regex(/^[^\r\n]+$/u),
    ),
    source: FilterListSourceSchema,
    owned: v.boolean(),
});

/**
 * A stable `catalog:entry` identifier of one filter list.
 */
export type FilterListKey = v.InferOutput<typeof FilterListKeySchema>;

/**
 * One filter list described by an opaque reference, never by a numeric registry id.
 */
export type FilterListRef = v.InferOutput<typeof FilterListRefSchema>;

/**
 * Registry ids the pinned catalog actually publishes.
 *
 * A well-formed `adguard:` key naming a list upstream does not carry is unresolvable: requesting it
 * must fail the preparation closed instead of reaching a native layer that would reject it later.
 */
const PINNED_OFFICIAL_FILTER_IDS: ReadonlySet<number> = new Set(
    OFFICIAL_ADGUARD_FILTERS.map((filter) => filter.filterId),
);

/**
 * Resolve a list key to a pinned AdGuard registry id.
 *
 * @param key - The opaque list key.
 * @returns The registry id, or null when the key is not a pinned official `adguard:` key.
 */
export function resolveAdguardListKey(key: string): number | null {
    const id = parseAdguardListKey(key);
    return id !== null && PINNED_OFFICIAL_FILTER_IDS.has(id) ? id : null;
}

/**
 * Build the list key of one AdGuard registry entry.
 *
 * @param id - Numeric AdGuard registry id.
 * @returns The `adguard:<id>` key.
 */
export function adguardListKey(id: number): FilterListKey {
    return `${ADGUARD_LIST_KEY_PREFIX}${id}` as FilterListKey;
}

/**
 * Resolve a list key to its AdGuard registry id.
 *
 * Only keys this slice's vocabulary can honor resolve; anything else is foreign or malformed and
 * must surface as unresolvable rather than degrade silently.
 *
 * @param key - The opaque list key.
 * @returns The registry id, or null when the key is not a resolvable `adguard:` key.
 */
export function parseAdguardListKey(key: string): number | null {
    if (!key.startsWith(ADGUARD_LIST_KEY_PREFIX)) {
        return null;
    }
    const suffix = key.slice(ADGUARD_LIST_KEY_PREFIX.length);
    if (!ADGUARD_KEY_SUFFIX_PATTERN.test(suffix)) {
        return null;
    }
    return Number(suffix);
}

/**
 * Build the filter list reference of one pinned official AdGuard list.
 *
 * The reference is what the executor interface exchanges instead of the registry id: the title is
 * the canonical catalog name, the source is the published list URL, and the list is owned by the
 * AdGuard repositories this agent reproduces.
 *
 * @param id - Numeric AdGuard registry id.
 * @returns The catalog reference, or null when the id is not a pinned official list.
 */
export function officialAdguardListRef(id: number): FilterListRef | null {
    const filter = OFFICIAL_ADGUARD_FILTERS.find((entry) => entry.filterId === id);
    if (!filter) {
        return null;
    }
    return {
        key: adguardListKey(id),
        title: filter.name,
        source: {
            kind: FilterListSourceKind.Url,
            url: OFFICIAL_FILTER_PUBLISHED_URL_TEMPLATE.replace('{id}', String(id)),
        },
        owned: true,
    };
}

/**
 * Canonicalize a set of list keys into lexicographic order.
 *
 * Key set-equality checks canonicalize both sides through this helper, so the comparison never
 * depends on the order evidence happened to arrive in.
 *
 * @param keys - The keys in any order.
 * @returns A new lexicographically ascending array; the input is not mutated.
 */
export function sortListKeys(keys: readonly string[]): string[] {
    return [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Translate requested list references into the numeric registry ids the native surfaces need.
 *
 * This is the single shared boundary helper: the resolved ids are sorted numeric-ascending so both
 * adapters hand their native layers exactly today's order. A key that is foreign, malformed, or
 * names an id outside the pinned catalog fails the whole request closed — preparation must derive
 * its baseline manifest from the requested lists, so silently dropping an unresolvable key would
 * build a narrower baseline than requested.
 *
 * @param refs - The requested list references.
 * @returns The registry ids, numeric-ascending, or null on the first unresolvable key.
 */
export function requestedListsToRegistryIds(
    refs: readonly FilterListRef[],
): readonly number[] | null {
    const ids: number[] = [];
    for (const ref of refs) {
        const id = resolveAdguardListKey(ref.key);
        if (id === null) {
            return null;
        }
        ids.push(id);
    }
    return ids.sort((a, b) => a - b);
}
