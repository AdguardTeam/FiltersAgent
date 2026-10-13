/**
 * The executable filter baseline a run declares instead of resolving.
 *
 * For a Firefox-family preparation nothing is resolved against AdGuard's official catalog. The
 * run's executable baseline is the list selection of the instruction's own managed-storage
 * declaration — the `selectedFilterLists` the blocker reads at startup, plus the user-filters
 * pseudo-list the candidate rule is applied through — and the reporter's own filter names are
 * compared against that selection for the report only.
 *
 * The two names this module knows (`selectedFilterLists`, `user-filters`) are the uBlock Origin
 * managed-storage convention; the rest of the template's shape stays the instruction's own
 * business. The lookup is keyed off the declared user-filters key path rather than a hardcoded
 * `adminSettings`, so an instruction that nests its settings elsewhere still resolves.
 */
import * as v from 'valibot';
import { FilterBaselineStatus } from './filter-baseline-status';
import type { FirefoxExtensionLaunch } from './extension-launch';
import {
    FilterListKeySchema,
    LIST_KEY_MAX_COUNT,
    LIST_KEY_MAX_LENGTH,
    type FilterListKey,
} from './filter-list-ref';
import {
    ExecutableFilterDecisionSchema,
    ReportedFilterNameSchema,
    SkippedFilterSourceSchema,
    SUBSCRIPTION_URL_PATTERN,
} from './official-filter-catalog';

/**
 * Key prefix of every list a run's own instruction declares; the suffix is the declared list name.
 */
export const DECLARED_LIST_KEY_PREFIX = 'declared:';

/**
 * The managed-storage member naming the lists the blocker enables at startup.
 */
const SELECTED_FILTER_LISTS_MEMBER = 'selectedFilterLists';

/**
 * The pseudo-list through which a blocker applies the user filters the host maintains.
 *
 * Without it in the selection the candidate rule is never applied at all, so it belongs to the
 * executable baseline whether or not the template spells it.
 */
export const USER_FILTERS_LIST_NAME = 'user-filters';

/**
 * Maximum declared list names one baseline carries, matching the key-list bound every request,
 * proof and durable record already enforces.
 */
const DECLARED_LIST_MAX_COUNT = LIST_KEY_MAX_COUNT;

/**
 * Maximum reported names a declared baseline records as unmatched.
 *
 * The reported selection is untrusted and unbounded — the issue parser splits the report's list
 * cell with no cap — so the list is truncated before validation, exactly as the official decision
 * bounds its own unresolved names.
 */
const UNMATCHED_REPORTED_NAMES_MAX_COUNT = 32;

/**
 * Maximum skipped reporter sources a declared baseline records.
 */
const SKIPPED_SOURCES_MAX_COUNT = 128;

/**
 * Maximum characters a declared list key's suffix carries, so the whole key stays inside the key
 * bound the request vocabulary enforces.
 */
const DECLARED_SLUG_MAX_LENGTH = LIST_KEY_MAX_LENGTH - DECLARED_LIST_KEY_PREFIX.length;

export const DeclaredFilterBaselineSchema = v.strictObject({
    status: v.literal(FilterBaselineStatus.Declared),
    listKeys: v.pipe(
        v.array(FilterListKeySchema),
        v.minLength(1),
        v.maxLength(DECLARED_LIST_MAX_COUNT),
    ),
    unmatchedReportedNames: v.pipe(
        v.array(ReportedFilterNameSchema),
        v.maxLength(UNMATCHED_REPORTED_NAMES_MAX_COUNT),
    ),
    skippedSources: v.pipe(
        v.array(SkippedFilterSourceSchema),
        v.maxLength(SKIPPED_SOURCES_MAX_COUNT),
    ),
});

export const SelectionFilterBaselineSchema = v.union([
    ExecutableFilterDecisionSchema,
    DeclaredFilterBaselineSchema,
]);

/**
 * The executable baseline a Firefox-family run declares: its own list selection, plus what the
 * reporter named that the selection does not cover.
 */
export type DeclaredFilterBaseline = v.InferOutput<typeof DeclaredFilterBaselineSchema>;

/**
 * The filter baseline one locked environment selection carries: the official AdGuard resolution, or
 * the selection a run's own instruction declared.
 */
export type SelectionFilterBaseline = v.InferOutput<typeof SelectionFilterBaselineSchema>;

/**
 * Build the list key of one declared list name.
 *
 * @param name - The list name exactly as the declaration spells it.
 * @returns The bounded `declared:` key, or null when no key characters remain.
 */
export function declaredFilterListKey(name: string): FilterListKey | null {
    const slug = name
        .replace(/[\p{Cc}\p{Cf}]/gu, '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, DECLARED_SLUG_MAX_LENGTH);
    if (slug.length === 0) {
        return null;
    }
    const key = DECLARED_LIST_KEY_PREFIX + slug;
    const parsed = v.safeParse(FilterListKeySchema, key);
    return parsed.success ? parsed.output : null;
}

/**
 * Walk one managed-storage template to the object holding the declared user-filters member.
 *
 * @param template - The managed-storage document the instruction declared.
 * @param keyPath - The declared key path of the user-filters member inside it.
 * @returns The parent object of that member, or null when the path does not lead to one.
 */
function userFiltersParent(
    template: Record<string, unknown>,
    keyPath: readonly string[],
): Record<string, unknown> | null {
    let current: Record<string, unknown> = template;
    for (const segment of keyPath.slice(0, -1)) {
        const next = current[segment];
        if (typeof next !== 'object' || next === null || Array.isArray(next)) {
            return null;
        }
        current = next as Record<string, unknown>;
    }
    return current;
}

/**
 * The list names one Firefox launch declaration selects.
 *
 * The selection sits beside the declared user-filters member — that is what the blocker reads at
 * startup — and the user-filters pseudo-list is unioned in whether or not the template spells it. A
 * declaration carrying no selection therefore still names one executable list, so the baseline is
 * never empty and never invented.
 *
 * @param launch - The run's Firefox launch declaration.
 * @returns The declared list names in declaration order, user filters last when they were added.
 */
export function declaredManagedStorageListNames(launch: FirefoxExtensionLaunch): readonly string[] {
    const parent = userFiltersParent(launch.managedStorageTemplate, launch.userFiltersKeyPath);
    const declared = parent?.[SELECTED_FILTER_LISTS_MEMBER];
    const names = Array.isArray(declared)
        ? declared.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        : [];
    return names.includes(USER_FILTERS_LIST_NAME) ? names : [...names, USER_FILTERS_LIST_NAME];
}

/**
 * The executable list keys one Firefox launch declaration selects.
 *
 * The one derivation both the run's filter baseline and the executing adapter's proofs read, so the
 * set the selection records and the set every phase reports can never disagree.
 *
 * @param launch - The run's Firefox launch declaration.
 * @returns The declared list keys, deduplicated, canonically sorted and count-bounded.
 */
export function declaredBaselineListKeys(launch: FirefoxExtensionLaunch): FilterListKey[] {
    const listKeys: FilterListKey[] = [];
    for (const name of declaredManagedStorageListNames(launch)) {
        const key = declaredFilterListKey(name);
        if (key !== null && !listKeys.includes(key) && listKeys.length < DECLARED_LIST_MAX_COUNT) {
            listKeys.push(key);
        }
    }
    return listKeys.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Reduce untrusted reporter text to the bounded single-line form the schemas admit.
 *
 * @param raw - Untrusted reported filter text.
 * @returns Control-free, whitespace-collapsed, length-bounded text.
 */
function sanitizeReportedName(raw: string): string {
    return raw
        .replace(/[\p{Cc}\p{Cf}]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, LIST_KEY_MAX_LENGTH);
}

/**
 * Decide the executable baseline of a run whose blocker declares its own list selection.
 *
 * Nothing here resolves: the declared selection is the baseline by construction. The reporter's
 * names are only compared against it — a URL names a custom subscription this run does not
 * reproduce, a name whose key equals a declared list is covered, and anything left is recorded as
 * unmatched so the report can say the run browsed with a different selection than the reporter
 * did.
 *
 * @param input - The run's launch declaration and the reporter's own filter names.
 * @param input.launch - The Firefox launch declaration whose managed storage names the selection.
 * @param input.reportedFilters - The reporter's filter list texts, untrusted.
 * @returns The declared baseline, with the report-only comparison recorded beside it.
 */
export function decideDeclaredFilters(input: {
    /**
     * The Firefox launch declaration whose managed storage names the run's list selection.
     */
    launch: FirefoxExtensionLaunch;

    /**
     * The reporter's filter list texts, untrusted; compared against the selection, never resolved.
     */
    reportedFilters: readonly string[];
}): DeclaredFilterBaseline {
    const listKeys = declaredBaselineListKeys(input.launch);
    const declared = new Set(listKeys);
    const skippedSources: v.InferOutput<typeof SkippedFilterSourceSchema>[] = [];
    const unmatchedReportedNames: string[] = [];
    for (const reported of input.reportedFilters) {
        const reportedName = sanitizeReportedName(reported);
        if (reportedName.length === 0) {
            continue;
        }
        if (SUBSCRIPTION_URL_PATTERN.test(reportedName)) {
            skippedSources.push({ kind: 'custom_subscription', reportedName });
            continue;
        }
        const key = declaredFilterListKey(reportedName);
        if (key === null || !declared.has(key)) {
            unmatchedReportedNames.push(reportedName);
        }
    }
    return v.parse(DeclaredFilterBaselineSchema, {
        status: FilterBaselineStatus.Declared,
        listKeys,
        unmatchedReportedNames: unmatchedReportedNames.slice(0, UNMATCHED_REPORTED_NAMES_MAX_COUNT),
        skippedSources: skippedSources.slice(0, SKIPPED_SOURCES_MAX_COUNT),
    });
}
