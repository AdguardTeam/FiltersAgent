/**
 * The pinned AdGuard registry snapshot shared as leaf data.
 *
 * Both the catalog decision (`official-filter-catalog.ts`) and the list-reference helpers
 * (`filter-list-ref.ts`) read this table, so it lives below them and neither may import the other
 * at module load: the reference helpers need the table to build refs, and the catalog needs the key
 * schema of those helpers to type its identities.
 */

/**
 * What is pinned here, and why the partition is authorship rather than an id range.
 *
 * Both tables behind this snapshot are the 2026-07-28 snapshot of the two catalogs behind the
 * environments this agent supports: `https://filters.adtidy.org/cli/filters.json` and
 * `https://filters.adtidy.org/extension/chromium/filters.json`. A reporter may be running either
 * product, so neither catalog alone is authoritative for what a report may name:
 *
 * - Their AdGuard-authored sets are identical name-for-name, so `OFFICIAL_ADGUARD_FILTERS` is that
 *   shared set with the ids the CLI catalog assigns;
 * - Their third-party sets are not (see `third-party-filter-catalog.ts` for the union).
 *
 * Nothing here is fetched at runtime. The report extraction shows the model this table and the
 * model names the id of each reported list it recognises, whatever the report calls it; a list this
 * table lacks gets no id and is recorded as an `unresolved_name` skipped source on the run's
 * baseline — the report names it beside the other sources the run left out, so the reduced baseline
 * is stated, never silent. Refreshing both tables from both catalogs together is the documented
 * maintenance action; a list present in only one catalog belongs in the union, never dropped.
 */
export const OFFICIAL_ADGUARD_FILTERS = Object.freeze([
    Object.freeze({ filterId: 1, name: 'AdGuard Russian filter' }),
    Object.freeze({ filterId: 2, name: 'AdGuard Base filter' }),
    Object.freeze({ filterId: 3, name: 'AdGuard Tracking Protection filter' }),
    Object.freeze({ filterId: 4, name: 'AdGuard Social Media filter' }),
    Object.freeze({ filterId: 5, name: 'AdGuard Experimental filter' }),
    Object.freeze({ filterId: 6, name: 'AdGuard German filter' }),
    Object.freeze({ filterId: 7, name: 'AdGuard Japanese filter' }),
    Object.freeze({ filterId: 8, name: 'AdGuard Dutch filter' }),
    Object.freeze({ filterId: 9, name: 'AdGuard Spanish/Portuguese filter' }),
    Object.freeze({ filterId: 10, name: 'Filter unblocking search ads and self-promotion' }),
    Object.freeze({ filterId: 11, name: 'AdGuard Mobile Ads filter' }),
    Object.freeze({ filterId: 13, name: 'AdGuard Turkish filter' }),
    Object.freeze({ filterId: 14, name: 'AdGuard Annoyances filter' }),
    Object.freeze({ filterId: 15, name: 'AdGuard DNS filter' }),
    Object.freeze({ filterId: 16, name: 'AdGuard French filter' }),
    Object.freeze({ filterId: 17, name: 'AdGuard URL Tracking filter' }),
    Object.freeze({ filterId: 18, name: 'AdGuard Cookie Notices filter' }),
    Object.freeze({ filterId: 19, name: 'AdGuard Popups filter' }),
    Object.freeze({ filterId: 20, name: 'AdGuard Mobile App Banners filter' }),
    Object.freeze({ filterId: 21, name: 'AdGuard Other Annoyances filter' }),
    Object.freeze({ filterId: 22, name: 'AdGuard Widgets filter' }),
    Object.freeze({ filterId: 23, name: 'AdGuard Ukrainian filter' }),
    Object.freeze({ filterId: 25, name: 'AdGuard Mail Tracking Protection filter' }),
    Object.freeze({ filterId: 224, name: 'AdGuard Chinese filter' }),
]);

/**
 * Deprecated combined official filters and the lists each one is built from.
 *
 * The AdGuard Annoyances filter (14) is the concatenation of Cookie Notices, Popups, Mobile App
 * Banners, Other Annoyances and Widgets, as its own header says. The registry marks it deprecated,
 * the MV3 extension build no longer ships it, yet older products such as AdGuard for iOS still
 * report it. A run reproduces the reporter's filtering through the component lists instead: the
 * rules are the same, every build carries them, and a rule's source file names its component list.
 */
export const COMBINED_OFFICIAL_FILTER_COMPONENTS: ReadonlyMap<number, readonly number[]> = new Map([
    [14, Object.freeze([18, 19, 20, 21, 22])],
]);

/**
 * Replace every deprecated combined official filter with the lists it is built from.
 *
 * @param filterIds - Official filter ids as the reporter named them.
 * @returns The ids with each combined filter expanded, ascending and without repeats.
 */
export function expandCombinedOfficialFilterIds(filterIds: readonly number[]): number[] {
    const expanded = filterIds.flatMap(
        (filterId) => COMBINED_OFFICIAL_FILTER_COMPONENTS.get(filterId) ?? [filterId],
    );
    return [...new Set(expanded)].sort((left, right) => left - right);
}

/**
 * Endpoint template for the published official lists, instantiated per registry id.
 *
 * The single owner of the AdGuard published-list URL shape: the downloader fetches from it and the
 * `FilterListRef` records cite it. The Chromium build is used deliberately: it is the same rule
 * text the filter engine consumes, and it is what the reporter's product ultimately executes after
 * its own list manager fetches it.
 */
export const OFFICIAL_FILTER_PUBLISHED_URL_TEMPLATE =
    'https://filters.adtidy.org/extension/chromium/filters/{id}.txt';
