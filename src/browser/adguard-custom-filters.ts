/**
 * Custom-filter facts of the pinned AdGuard Browser Extension build.
 *
 * A settings import carries its custom filters under `filters['custom-filters']`; the build
 * downloads each entry's URL, allocates the filter an id of its own and files it under the custom
 * filters group. Both numbers are the build's constants, not this run's choice, and every consumer
 * — the payload that installs a custom filter, the reconciliation that must not turn it off, the
 * fake surface that models the build — reads them from here so a custom filter is recognised the
 * same way everywhere.
 */

/**
 * The first id the build allocates to a custom filter (`CUSTOM_FILTERS_START_ID` in the pinned
 * build): every id from here up is a custom filter, every id below it a built-in list from the
 * registry. An import ignores ids from here up in `enabled-filters` — a custom filter is enabled by
 * its own entry's `enabled` flag, never by id.
 */
export const CUSTOM_FILTERS_START_ID = 1000;

/**
 * The group every custom filter belongs to (`CUSTOM_FILTERS_GROUP_ID` in the pinned build). A
 * custom filter's rules run only while this group is in `enabled-groups`; installed without it, the
 * filter is listed and inert.
 */
export const CUSTOM_FILTERS_GROUP_ID = 0;

/**
 * One custom filter as the settings-import document lists it.
 */
export interface ExtensionCustomFilterEntry {
    /**
     * The URL the build downloads the filter text from at import; an empty body fails the import of
     * that entry silently.
     */
    customUrl: string;

    /**
     * The name the build stores for the filter and shows in its options metadata and filtering log.
     * Absent, the build titles the filter from its text or URL.
     */
    title?: string;

    /**
     * Whether the filter may carry rules the build otherwise refuses from an untrusted source, such
     * as scriptlets and extended-CSS.
     */
    trusted: boolean;

    /**
     * Whether the filter is switched on once installed.
     */
    enabled: boolean;
}

/**
 * One enabled custom filter as the options metadata lists it after an import.
 */
export interface EnabledCustomFilter {
    /**
     * The id the import allocated, from {@link CUSTOM_FILTERS_START_ID} up.
     */
    filterId: number;

    /**
     * The name the build stores for it: the import entry's title.
     */
    name: string;
}

/**
 * Whether a filter id names a custom filter rather than a built-in list.
 *
 * @param filterId - A filter id as the extension reports it.
 * @returns True from {@link CUSTOM_FILTERS_START_ID} up.
 */
export function isCustomFilterId(filterId: number): boolean {
    return filterId >= CUSTOM_FILTERS_START_ID;
}
