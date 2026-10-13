import * as v from 'valibot';
import { FilterBaselineStatus } from './filter-baseline-status';
import { adguardListKey, FilterListKeySchema } from './filter-list-ref';
import {
    expandCombinedOfficialFilterIds,
    OFFICIAL_ADGUARD_FILTERS,
    OFFICIAL_FILTER_PUBLISHED_URL_TEMPLATE,
} from './official-filter-table';
import { THIRD_PARTY_FILTER_CATALOG } from './third-party-filter-catalog';
import type { ReportedFilter } from '../types/issue-facts';

export { OFFICIAL_ADGUARD_FILTERS, OFFICIAL_FILTER_PUBLISHED_URL_TEMPLATE };

/**
 * Third-party names the CLI catalog publishes and the pinned extension registry snapshot does not.
 *
 * The union below spans both catalogs, while `THIRD_PARTY_FILTER_CATALOG` pins the extension
 * registry alone, so a CLI-only list — which carries no extension registry ID to be tabulated with
 * — belongs here. It is empty in the current snapshots, where every CLI third-party list is also an
 * extension one, and exists so the next such list is added in one line instead of by re-typing the
 * union and silently forking the spelling of everything else in it.
 */
const CLI_ONLY_THIRD_PARTY_FILTER_NAMES: readonly string[] = Object.freeze([]);

/**
 * Every remaining name in either pinned catalog: known third-party lists AdGuard redistributes but
 * does not author. They are recorded and skipped, never executed, so no identifier is retained.
 *
 * Derived from `THIRD_PARTY_FILTER_CATALOG` rather than re-typed, because that snapshot already
 * pins each name beside the numeric id the extension route resolves it from. Two hand-maintained
 * copies of ~70 names diverge as soon as one is refreshed alone, and the same list would then
 * resolve on the extension route while the CLI proxy route — which matches reporter text against
 * these names — recorded it as an unrecognized name. One copy also means the exact bytes of an
 * awkward name (both `uBlock Origin` entries contain an en dash, U+2013) exist only once.
 */
export const KNOWN_THIRD_PARTY_FILTER_NAMES = Object.freeze([
    ...THIRD_PARTY_FILTER_CATALOG.map((entry) => entry.name),
    ...CLI_ONLY_THIRD_PARTY_FILTER_NAMES,
]);

/**
 * Names upstream has renamed, kept only so a stale report still classifies.
 *
 * Deliberately narrow: an alias may only ever resolve to a **third-party** name. Aliasing an
 * official name would change what the run executes, so that invariant is enforced by a test over
 * this whole table rather than by convention. Reported text keeps its own `reportedName`; the alias
 * only decides the class, which moves a stale name from "unresolved" — which fails the entire
 * decision closed — to "skipped", which it always was.
 */
export const LEGACY_THIRD_PARTY_FILTER_ALIASES: ReadonlyMap<string, string> = new Map([
    ['List-KR', 'List-KR Classic filter list'],
]);

/**
 * Maximum reported-name length retained anywhere in the decision.
 */
const REPORTED_NAME_MAX_LENGTH = 200;

/**
 * Maximum number of skipped sources either decision variant carries.
 *
 * The reported selection is untrusted and unbounded — the issue parser splits the `Filters` cell
 * with no cap — so both list bounds are enforced by truncation before validation. An oversized
 * selection must still receive its finite classification instead of losing it to a schema error.
 */
const SKIPPED_SOURCES_MAX_COUNT = 128;

export const ReportedFilterNameSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(REPORTED_NAME_MAX_LENGTH),
    v.regex(/^[^\r\n]+$/u),
);

export const OfficialFilterIdentitySchema = v.strictObject({
    filterId: v.pipe(v.number(), v.integer(), v.minValue(1)),
    listKey: FilterListKeySchema,
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(REPORTED_NAME_MAX_LENGTH)),
    reportedName: ReportedFilterNameSchema,
});

/**
 * Why a reported filter source is recorded and skipped rather than executed.
 */
export const SkippedFilterSourceKind = {
    /**
     * A known third-party list AdGuard redistributes but does not author.
     */
    ThirdPartyCatalog: 'third_party_catalog',

    /**
     * A subscription the reporter named by URL.
     */
    CustomSubscription: 'custom_subscription',

    /**
     * A name that matches neither catalog: a private list, a DNS filter, or a misspelled name. The
     * run cannot fetch what it cannot identify, so the name is recorded and the baseline runs on
     * the official filters that did resolve. Failing the whole selection on one such name would
     * cost the run its investigation before a browser ever opens.
     */
    UnresolvedName: 'unresolved_name',
} as const;

/**
 * SkippedFilterSourceKind value.
 */
export type SkippedFilterSourceKind =
    (typeof SkippedFilterSourceKind)[keyof typeof SkippedFilterSourceKind];

/**
 * Every skipped-source kind, for the schema picklist.
 */
export const SKIPPED_FILTER_SOURCE_KIND_VALUES = Object.values(SkippedFilterSourceKind);

export const SkippedFilterSourceSchema = v.strictObject({
    kind: v.picklist(SKIPPED_FILTER_SOURCE_KIND_VALUES),
    reportedName: ReportedFilterNameSchema,
});

/**
 * Finite reason a reported filter selection yields no executable official baseline.
 */
export const NonExecutableFilterCode = {
    /**
     * The reporter's filter selection contained no named entries at all.
     */
    FilterSelectionMissing: 'filter_selection_missing',

    /**
     * The named entries carried no official AdGuard filter to reproduce: only third-party, custom
     * or unrecognized sources, all of them recorded as skipped.
     */
    NoOfficialFilterBaseline: 'no_official_filter_baseline',
} as const;

/**
 * Every NonExecutableFilterCode value, for schemas and exhaustive listings.
 */
export const NON_EXECUTABLE_FILTER_CODE_VALUES = Object.values(NonExecutableFilterCode);

export const NonExecutableFilterCodeSchema = v.picklist(NON_EXECUTABLE_FILTER_CODE_VALUES);

export const ExecutableFilterDecisionSchema = v.pipe(
    v.variant('status', [
        v.strictObject({
            status: v.literal(FilterBaselineStatus.Executable),
            officialFilters: v.pipe(
                v.array(OfficialFilterIdentitySchema),
                v.minLength(1),
                v.maxLength(OFFICIAL_ADGUARD_FILTERS.length),
            ),
            skippedSources: v.pipe(
                v.array(SkippedFilterSourceSchema),
                v.maxLength(SKIPPED_SOURCES_MAX_COUNT),
            ),
        }),
        v.strictObject({
            status: v.literal(FilterBaselineStatus.NotExecutable),
            code: NonExecutableFilterCodeSchema,
            skippedSources: v.pipe(
                v.array(SkippedFilterSourceSchema),
                v.maxLength(SKIPPED_SOURCES_MAX_COUNT),
            ),
        }),
    ]),
    v.check(
        (decision) =>
            decision.status !== FilterBaselineStatus.Executable ||
            (decision.officialFilters.every(
                (filter, index) =>
                    index === 0 || decision.officialFilters[index - 1]!.filterId < filter.filterId,
            ) &&
                new Set(decision.officialFilters.map((filter) => filter.listKey)).size ===
                    decision.officialFilters.length),
        'Official filter identities must be unique and ascending.',
    ),
);

/**
 * One official AdGuard filter the run may reproduce, bound to the reporter text that named it.
 */
export type OfficialFilterIdentity = v.InferOutput<typeof OfficialFilterIdentitySchema>;

/**
 * One reported filter source that is recorded as a fidelity signal and never executed.
 */
export type SkippedFilterSource = v.InferOutput<typeof SkippedFilterSourceSchema>;

/**
 * Finite reason a reported filter selection yields no executable official baseline.
 */
export type NonExecutableFilterCode =
    (typeof NonExecutableFilterCode)[keyof typeof NonExecutableFilterCode];

/**
 * Deterministic offline verdict on whether the reported filter selection can be reproduced.
 */
export type ExecutableFilterDecision = v.InferOutput<typeof ExecutableFilterDecisionSchema>;

/**
 * Matches any absolute URL scheme prefix, which identifies a custom subscription rather than a
 * name.
 *
 * Shared beyond this module so every URL-detection seam classifies reporter text identically.
 */
export const SUBSCRIPTION_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//iu;

/**
 * Build the single lookup key used for both reporter text and the pinned canonical names.
 *
 * Reporter text arrives in several real shapes: the plain extension form (`AdGuard Base filter`),
 * the desktop form with a trailing version (`AdGuard Base filter v2.0.54.62`), and either form with
 * backticks, a trailing separator, or collapsed whitespace left over from the issue table.
 *
 * @param raw - Untrusted reported filter text or a pinned canonical name.
 * @returns Lowercased lookup key, or an empty string when no name text remains.
 */
function normalizeReportedFilterName(raw: string): string {
    return raw
        .replace(/[\p{Cc}\p{Cf}]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim()
        .replace(/`/gu, '')
        .replace(/\s*[,;]$/u, '')
        .replace(/\s+v\d+(?:\.\d+)*$/iu, '')
        .trim()
        .toLowerCase();
}

/**
 * Reduce untrusted reporter text to the bounded single-line form the decision schemas admit.
 *
 * @param raw - Untrusted reported filter text.
 * @returns Control-free, whitespace-collapsed, length-bounded text.
 */
function sanitizeReportedName(raw: string): string {
    return raw
        .replace(/[\p{Cc}\p{Cf}]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, REPORTED_NAME_MAX_LENGTH);
}

/**
 * Official catalog entries indexed by their registry id.
 */
const OFFICIAL_FILTERS_BY_ID: ReadonlyMap<number, (typeof OFFICIAL_ADGUARD_FILTERS)[number]> =
    new Map(OFFICIAL_ADGUARD_FILTERS.map((filter) => [filter.filterId, filter]));

/**
 * Normalized forms of every known third-party catalog name.
 */
const THIRD_PARTY_FILTER_KEYS: ReadonlySet<string> = new Set(
    KNOWN_THIRD_PARTY_FILTER_NAMES.map((name) => normalizeReportedFilterName(name)),
);

/**
 * Normalized forms of every legacy alias key.
 */
const LEGACY_ALIAS_KEYS: ReadonlySet<string> = new Set(
    [...LEGACY_THIRD_PARTY_FILTER_ALIASES.keys()].map((name) => normalizeReportedFilterName(name)),
);

/**
 * Decide, offline and without inventing defaults, which reported filters this run may reproduce.
 *
 * Classification is single-pass: an entry the extraction recognised as an official list carries its
 * catalog id and becomes that official identity, or the identities of its component lists when it
 * is a deprecated combined filter; every other entry is recorded as a skipped source — a known
 * third-party name, a subscription URL, or a name neither catalog knows — and never fetched or
 * applied. Which reported name is which official list is the extraction model's reading, checked
 * against the catalog at that boundary; nothing here matches names to official lists. The run
 * executes the official identities that resolved and the report names every source it left out, so
 * a narrower baseline is stated rather than silent. Only a selection with nothing official in it
 * yields no baseline at all.
 *
 * The verdict is decided over the whole selection, but the recorded evidence list is truncated to
 * its schema bound: an unbounded selection of unknown names or custom URLs still returns its finite
 * code rather than failing validation and degrading into an unclassified run.
 *
 * @param reportedFilters - The reporter's filter selection exactly as parsed from the issue.
 * @returns Schema-validated executable identities or the finite reason no baseline exists.
 */
export function decideExecutableFilters(
    reportedFilters: readonly ReportedFilter[],
): ExecutableFilterDecision {
    const officialByFilterId = new Map<number, OfficialFilterIdentity>();
    const skippedByKey = new Map<string, SkippedFilterSource>();
    let namedEntries = 0;

    for (const entry of reportedFilters) {
        const key = normalizeReportedFilterName(entry.name);
        if (key === '') {
            continue;
        }
        namedEntries += 1;
        const reportedName = sanitizeReportedName(entry.name);
        if (entry.officialFilterId !== undefined) {
            const official = OFFICIAL_FILTERS_BY_ID.get(entry.officialFilterId);
            if (official === undefined) {
                throw new Error(
                    `Reported filter "${reportedName}" carries official id ` +
                        `${entry.officialFilterId}, which the catalog does not have; the ` +
                        'extraction boundary admits only catalog ids.',
                );
            }
            for (const filterId of expandCombinedOfficialFilterIds([official.filterId])) {
                if (!officialByFilterId.has(filterId)) {
                    officialByFilterId.set(filterId, {
                        filterId,
                        listKey: adguardListKey(filterId),
                        name: OFFICIAL_FILTERS_BY_ID.get(filterId)!.name,
                        reportedName,
                    });
                }
            }
            continue;
        }
        if (SUBSCRIPTION_URL_PATTERN.test(key)) {
            if (!skippedByKey.has(key)) {
                skippedByKey.set(key, {
                    kind: SkippedFilterSourceKind.CustomSubscription,
                    reportedName,
                });
            }
            continue;
        }
        if (THIRD_PARTY_FILTER_KEYS.has(key) || LEGACY_ALIAS_KEYS.has(key)) {
            if (!skippedByKey.has(key)) {
                skippedByKey.set(key, {
                    kind: SkippedFilterSourceKind.ThirdPartyCatalog,
                    reportedName,
                });
            }
            continue;
        }
        if (!skippedByKey.has(key)) {
            skippedByKey.set(key, { kind: SkippedFilterSourceKind.UnresolvedName, reportedName });
        }
    }

    const skippedSources = [...skippedByKey.values()].slice(0, SKIPPED_SOURCES_MAX_COUNT);
    const decision: ExecutableFilterDecision =
        namedEntries === 0
            ? {
                  status: FilterBaselineStatus.NotExecutable,
                  code: NonExecutableFilterCode.FilterSelectionMissing,
                  skippedSources,
              }
            : officialByFilterId.size === 0
              ? {
                    status: FilterBaselineStatus.NotExecutable,
                    code: NonExecutableFilterCode.NoOfficialFilterBaseline,
                    skippedSources,
                }
              : {
                    status: FilterBaselineStatus.Executable,
                    officialFilters: OFFICIAL_ADGUARD_FILTERS.map((filter) =>
                        officialByFilterId.get(filter.filterId),
                    ).filter((identity) => identity !== undefined),
                    skippedSources,
                };
    return v.parse(ExecutableFilterDecisionSchema, decision);
}
