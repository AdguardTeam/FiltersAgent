export const HistoricalBuildFailureCode = {
    /**
     * The requested release is not supported by the verified release catalog.
     */
    ReleaseUnknown: 'release_unknown',
    /**
     * The release archive could not be downloaded or verified.
     */
    ReleaseUnavailable: 'release_unavailable',
    /**
     * The pinned autobuild filter tree could not be fetched or verified.
     */
    AutobuildUnavailable: 'autobuild_unavailable',
    /**
     * The release bundle does not expose the expected script-rules module.
     */
    BundleLayoutMismatch: 'bundle_layout_mismatch',
    /**
     * The rewritten background bundle is not valid JavaScript.
     */
    BundleParseFailed: 'bundle_parse_failed',
    /**
     * The rewritten script-rules object is missing keys from the autobuild inventory.
     */
    ScriptRulesNotCovered: 'script_rules_not_covered',
    /**
     * A ruleset declared by the release manifest is absent from the assembled tree.
     */
    RulesetMissing: 'ruleset_missing',
} as const;

/**
 * Stable refusal classifications for historical reporter builds.
 */
export type HistoricalBuildFailureCode =
    (typeof HistoricalBuildFailureCode)[keyof typeof HistoricalBuildFailureCode];

/**
 * Historical preparation failure with a named stage and the complete underlying cause.
 */
export class HistoricalBuildError extends Error {
    /**
     * Public preparation failure classification.
     */
    readonly code: HistoricalBuildFailureCode;
    /**
     * Original failure retained for detailed local diagnostics.
     */
    override readonly cause?: unknown;

    constructor(code: HistoricalBuildFailureCode, message: string, cause?: unknown) {
        super(message);
        this.name = 'HistoricalBuildError';
        this.code = code;
        this.cause = cause;
    }
}
