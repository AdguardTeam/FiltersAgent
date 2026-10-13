/**
 * Filtering engine generation of the prepared extension: MV2 webRequest or MV3
 * declarativeNetRequest.
 */
export const FilterEngine = {
    WebRequest: 'web-request',
    DeclarativeNetRequest: 'declarative-net-request',
} as const;

/**
 * FilterEngine value.
 */
export type FilterEngine = (typeof FilterEngine)[keyof typeof FilterEngine];
