/**
 * Hidden HTML comment markers that identify agent-generated or oracle issue content.
 *
 * Every marker is a complete, self-contained HTML comment written verbatim into an issue body or
 * comment. The publisher that emits a marker and every filter that must keep it out of a model
 * prompt read the same member here, so a new or renamed marker cannot reach an agent prompt because
 * one of the exclusion lists was not updated with it.
 */
export const GeneratedCommentMarker = {
    /**
     * Marks the single agent-owned benchmark summary comment published on an issue.
     */
    IssueSummary: '<!-- adguard-filters-agent:issue-summary -->',

    /**
     * Marks a generated agent answer copied into an issue history.
     */
    AgentSummary: '<!-- adguard-filters-agent:agent-summary -->',

    /**
     * Marks the recorded human fix for an issue — the benchmark oracle the agent must never read.
     */
    HumanSolution: '<!-- adguard-filters-agent:human-solution -->',

    /**
     * Marks maintainer reference material that can disclose the historical human fix.
     */
    HumanReference: '<!-- adguard-filters-agent:human-reference -->',
} as const;

export const GENERATED_COMMENT_MARKER_VALUES = Object.values(GeneratedCommentMarker);

/**
 * One complete generated-comment marker.
 */
export type GeneratedCommentMarker =
    (typeof GeneratedCommentMarker)[keyof typeof GeneratedCommentMarker];

/**
 * Opening prefixes of the generated markers that carry a JSON payload before their closing `-->`.
 *
 * These markers embed serialized state, so only their fixed opener is a stable literal. A prefix
 * keeps its trailing separator exactly as the writer emits it, so a substring test cannot match a
 * different marker whose name merely starts with the same words.
 */
export const GeneratedCommentMarkerPrefix = {
    /**
     * Opener of the historical benchmark metadata marker holding the pinned filters base SHA.
     */
    BenchmarkMetadata: '<!-- adguard-agent-benchmark:',

    /**
     * Opener of the marker that records which upstream issue a mirrored issue came from.
     */
    UpstreamMirror: '<!-- adguard-filters-agent:upstream-mirror ',

    /**
     * Opener of the marker that records the upstream synchronization cursor state.
     */
    UpstreamSyncState: '<!-- adguard-filters-agent:upstream-sync-state ',
} as const;

export const GENERATED_COMMENT_MARKER_PREFIX_VALUES = Object.values(GeneratedCommentMarkerPrefix);

/**
 * One generated-comment marker opener.
 */
export type GeneratedCommentMarkerPrefix =
    (typeof GeneratedCommentMarkerPrefix)[keyof typeof GeneratedCommentMarkerPrefix];
