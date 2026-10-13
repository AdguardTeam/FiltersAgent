/**
 * The usage-accounting honesty vocabularies, declared once for the whole codebase: how completely a
 * run's provider replies reported usage, how much of it could be priced, and the older spellings of
 * the same two questions.
 *
 * Both spellings live here TOGETHER rather than merged, and the merge is not available: each one is
 * pinned by documents already on disk. `costCoverage`/`usageCompleteness` are persisted fields of
 * the v2 run usage summary (`RunUsageSummarySchema`), and `costStatus`/`telemetryHealth` are
 * persisted fields of run artifacts written by earlier builds, which is also why `CostStatus` keeps
 * the `Reported` and `Mixed` members pi does not produce. Renaming either set to the other's
 * literals stops one of the two formats parsing.
 */

/**
 * How completely a run's provider replies reported usages. Persisted as `usageCompleteness` in the
 * v2 run usage summary.
 */
export const UsageCompleteness = {
    /**
     * Every completion reported its token usage.
     */
    Complete: 'complete',

    /**
     * Some completions reported usage and some did not.
     */
    Partial: 'partial',

    /**
     * No completion reported usage.
     */
    Unreported: 'unreported',
} as const;

/**
 * Every UsageCompleteness value, for schemas and exhaustive listings.
 */
export const USAGE_COMPLETENESS_VALUES = Object.values(UsageCompleteness);

/**
 * UsageCompleteness value.
 */
export type UsageCompleteness = (typeof UsageCompleteness)[keyof typeof UsageCompleteness];

/**
 * How much of a run's cost could be priced from the configured rates. Persisted as `costCoverage`
 * in the v2 run usage summary.
 */
export const CostCoverage = {
    /**
     * Every reported completion's model had configured rates.
     */
    Full: 'full',

    /**
     * Some completions were priced, some were not; the total is the priceable part and is labelled
     * as such.
     */
    Partial: 'partial',

    /**
     * Nothing was reported, or nothing reported could be priced.
     */
    None: 'none',
} as const;

/**
 * Every CostCoverage value, for schemas and exhaustive listings.
 */
export const COST_COVERAGE_VALUES = Object.values(CostCoverage);

/**
 * CostCoverage value.
 */
export type CostCoverage = (typeof CostCoverage)[keyof typeof CostCoverage];

/**
 * How trustworthy a run's LLM cost figure is. Persisted as `costStatus` in run artifacts written by
 * earlier builds.
 */
export const CostStatus = {
    Reported: 'reported',
    Estimated: 'estimated',
    Mixed: 'mixed',
    Partial: 'partial',
    Unavailable: 'unavailable',
} as const;

/**
 * CostStatus value.
 */
export type CostStatus = (typeof CostStatus)[keyof typeof CostStatus];

/**
 * Whether provider usage telemetry covered every request of a run. Persisted as `telemetryHealth`
 * in run artifacts written by earlier builds.
 */
export const TelemetryHealth = {
    Healthy: 'healthy',
    NoProviderCalls: 'no_provider_calls',
    Incomplete: 'incomplete',
} as const;

/**
 * Telemetry health value.
 */
export type TelemetryHealth = (typeof TelemetryHealth)[keyof typeof TelemetryHealth];
