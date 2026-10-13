/**
 * Why a reporter-requested filter id is absent from the installed build catalog.
 */
export const MissingCatalogFilterReason = {
    ThirdPartyNotInBuildCatalog: 'third_party_not_in_build_catalog',
    UnknownFilterId: 'unknown_filter_id',
} as const;

/**
 * Every MissingCatalogFilterReason value, for schemas and exhaustive listings.
 */
export const MISSING_CATALOG_FILTER_REASON_VALUES = Object.values(MissingCatalogFilterReason);

/**
 * MissingCatalogFilterReason value.
 */
export type MissingCatalogFilterReason =
    (typeof MissingCatalogFilterReason)[keyof typeof MissingCatalogFilterReason];
