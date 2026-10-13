import * as v from 'valibot';
import { FixRunStatus, type FixRunResult } from '../../src/types/fix-run-result';
import { InfrastructureFailureReason } from '../../src/types/infrastructure-failure-reason';

/**
 * Terminal product category retained for an unchanged issue revision.
 */
export const LocalProductOutcomeCategory = {
    /**
     * The reported product behavior was confirmed and a candidate fix verified.
     */
    Verified: 'verified',

    /**
     * The reported product behavior could not be confirmed and the candidate was rejected.
     */
    Rejected: 'rejected',

    /**
     * Neither confirmation nor rejection could be reached from the available evidence.
     */
    Inconclusive: 'inconclusive',

    /**
     * The target could not be reached to investigate the report.
     */
    Inaccessible: 'inaccessible',

    /**
     * The queued issue snapshot did not carry the input this run required.
     */
    InvalidInput: 'invalid_input',

    /**
     * The reported case falls outside a product configuration this run supports.
     */
    Unsupported: 'unsupported',

    /**
     * The investigation completed but environment cleanup did not.
     */
    CleanupFailed: 'cleanup_failed',
} as const;

/**
 * Every LocalProductOutcomeCategory value, for schemas and exhaustive listings.
 */
export const LOCAL_PRODUCT_OUTCOME_CATEGORY_VALUES = Object.values(LocalProductOutcomeCategory);

export const LocalProductOutcomeCategorySchema = v.picklist(LOCAL_PRODUCT_OUTCOME_CATEGORY_VALUES);

/**
 * Which local execution boundary failed after a queue attempt started.
 *
 * Spellings collide with other sets on purpose-neutral words — `'interrupted'` is also an
 * AgentTerminationReason and `'environment'` also a LocalFailureStage — so value positions must
 * name this object, never a literal, or a reader cannot tell the sets apart.
 */
export const LocalInfrastructureFailureCategory = {
    /**
     * The queued issue snapshot or bundle could not be read.
     */
    InvestigationInput: 'investigation_input',

    /**
     * An LLM or vision provider boundary failed.
     */
    Provider: 'provider',

    /**
     * The browser stack failed before or during the investigation.
     */
    Browser: 'browser',

    /**
     * The locked execution environment could not be prepared.
     */
    Environment: 'environment',

    /**
     * The investigation ran but produced no readable result.
     */
    InvestigationOutput: 'investigation_output',

    /**
     * The finished result could not be published to its durable destination.
     */
    ResultPublication: 'result_publication',

    /**
     * An unclassified orchestration failure with no typed boundary evidence.
     */
    Runtime: 'runtime',

    /**
     * The queue lease was lost and the attempt was abandoned mid-flight.
     */
    Interrupted: 'interrupted',
} as const;

/**
 * Every LocalInfrastructureFailureCategory value, for schemas and exhaustive listings.
 */
export const LOCAL_INFRASTRUCTURE_FAILURE_CATEGORY_VALUES = Object.values(
    LocalInfrastructureFailureCategory,
);

export const LocalInfrastructureFailureCategorySchema = v.picklist(
    LOCAL_INFRASTRUCTURE_FAILURE_CATEGORY_VALUES,
);

export const LocalCycleOutcomeSchema = v.variant('kind', [
    v.strictObject({
        kind: v.literal('product'),
        category: LocalProductOutcomeCategorySchema,
    }),
    v.strictObject({
        kind: v.literal('infrastructure'),
        category: LocalInfrastructureFailureCategorySchema,
    }),
]);

/**
 * LocalProductOutcomeCategory value.
 */
export type LocalProductOutcomeCategory =
    (typeof LocalProductOutcomeCategory)[keyof typeof LocalProductOutcomeCategory];

/**
 * Retryable infrastructure category recorded after work has started.
 */
/**
 * LocalInfrastructureFailureCategory value.
 */
export type LocalInfrastructureFailureCategory =
    (typeof LocalInfrastructureFailureCategory)[keyof typeof LocalInfrastructureFailureCategory];

/**
 * Bounded result classification consumed by durable queue finalization.
 */
export type LocalCycleOutcome = v.InferOutput<typeof LocalCycleOutcomeSchema>;

/**
 * Typed failure raised at a known local execution infrastructure boundary.
 */
export class LocalExecutionInfrastructureError extends Error {
    /**
     * Stable infrastructure category that failed.
     */
    readonly category: LocalInfrastructureFailureCategory;

    /**
     * Create one bounded execution error without deriving its category from prose.
     *
     * @param category - Stable infrastructure boundary category.
     * @param message - Sanitizable diagnostic for the host-only result.
     * @param options - Optional native error cause.
     */
    constructor(
        category: LocalInfrastructureFailureCategory,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = 'LocalExecutionInfrastructureError';
        this.category = category;
    }
}

/**
 * Fail compilation when a bounded enum gains an unhandled value.
 *
 * @param value - Statically impossible value.
 * @returns Never.
 */
function assertNever(value: never): never {
    throw new Error(`Unhandled local outcome value: ${String(value)}`);
}

/**
 * Convert one explicit runner infrastructure reason to the local retry taxonomy.
 *
 * @param reason - Validated runner infrastructure reason.
 * @returns Stable retry category.
 */
function infrastructureCategory(
    reason: InfrastructureFailureReason,
): LocalInfrastructureFailureCategory {
    switch (reason) {
        case InfrastructureFailureReason.InputUnavailable:
            return LocalInfrastructureFailureCategory.InvestigationInput;
        case InfrastructureFailureReason.EnvironmentUnavailable:
        case InfrastructureFailureReason.FileBackedApplicationUnsupported:
            return LocalInfrastructureFailureCategory.Environment;
        case InfrastructureFailureReason.BrowserUnavailable:
            return LocalInfrastructureFailureCategory.Browser;
        case InfrastructureFailureReason.LlmUnavailable:
        case InfrastructureFailureReason.LlmRejected:
        case InfrastructureFailureReason.VisionProviderUnavailable:
            return LocalInfrastructureFailureCategory.Provider;
        case InfrastructureFailureReason.OutputUnavailable:
            return LocalInfrastructureFailureCategory.InvestigationOutput;
        default:
            return assertNever(reason);
    }
}

/**
 * Determine whether an analysis-only result retains a bound rejected candidate review.
 *
 * @param result - Validated investigation result.
 * @returns Whether the result contains canonical rejected-candidate evidence.
 */
function hasRejectedCandidateReview(result: FixRunResult): boolean {
    return result.artifactPaths.rejectedCandidateScreenshots !== undefined;
}

/**
 * Map one current product run status to the terminal or retryable local taxonomy.
 *
 * @param status - Validated current run status.
 * @param rejectedCandidate - Whether analysis-only retained bound rejected evidence.
 * @returns Stable local cycle outcome.
 */
function statusOutcome(status: FixRunStatus, rejectedCandidate: boolean): LocalCycleOutcome {
    switch (status) {
        case FixRunStatus.AlreadyFixedCurrent:
        case FixRunStatus.FixedUpstreamPendingExtension:
        case FixRunStatus.FixedInSourcePendingPublication:
        case FixRunStatus.PatchProposed:
            return { kind: 'product', category: LocalProductOutcomeCategory.Verified };
        case FixRunStatus.NotReproduced:
        case FixRunStatus.ConfigurationSpecific:
            return { kind: 'product', category: LocalProductOutcomeCategory.Rejected };
        case FixRunStatus.AnalysisOnly:
            return {
                kind: 'product',
                category: rejectedCandidate
                    ? LocalProductOutcomeCategory.Rejected
                    : LocalProductOutcomeCategory.Inconclusive,
            };
        case FixRunStatus.UnsupportedProductCase:
        case FixRunStatus.CapabilityLimited:
            return { kind: 'product', category: LocalProductOutcomeCategory.Unsupported };
        case FixRunStatus.TargetUrlUnavailable:
            return { kind: 'product', category: LocalProductOutcomeCategory.Inaccessible };
        case FixRunStatus.CleanupFailed:
            return { kind: 'product', category: LocalProductOutcomeCategory.CleanupFailed };
        case FixRunStatus.BrowserUnavailable:
            return { kind: 'infrastructure', category: LocalInfrastructureFailureCategory.Browser };
        case FixRunStatus.Failed:
            return { kind: 'infrastructure', category: LocalInfrastructureFailureCategory.Runtime };
        default:
            return assertNever(status);
    }
}

/**
 * Derive an outcome from the strict bounded fields stored in a locked investigation result.
 *
 * @param runStatus - Validated current product run status.
 * @param reason - Optional explicit infrastructure reason with precedence over the status.
 * @param rejectedCandidate - Whether analysis-only retained bound rejected candidate evidence.
 * @returns Strict product or infrastructure outcome.
 */
export function deriveLocalCycleOutcomeFields(
    runStatus: FixRunStatus,
    reason: InfrastructureFailureReason | undefined,
    rejectedCandidate: boolean,
): LocalCycleOutcome {
    let outcome: LocalCycleOutcome;
    if (reason) {
        outcome = {
            kind: 'infrastructure' as const,
            category: infrastructureCategory(reason),
        };
    } else {
        outcome = statusOutcome(runStatus, rejectedCandidate);
    }
    return v.parse(LocalCycleOutcomeSchema, outcome);
}

/**
 * Derive the durable local classification from a validated investigation result.
 *
 * Explicit infrastructure evidence has precedence over the product status. No prose or error
 * message participates in the decision.
 *
 * @param result - Validated locked investigation result.
 * @returns Strict product or infrastructure outcome.
 */
export function deriveLocalCycleOutcome(result: FixRunResult): LocalCycleOutcome {
    return deriveLocalCycleOutcomeFields(
        result.runStatus,
        result.infrastructureFailureReason,
        hasRejectedCandidateReview(result),
    );
}

/**
 * Classify an exception raised after a queue attempt has started.
 *
 * @param error - Typed boundary error or untyped orchestration failure.
 * @returns Provider-specific category when proven, otherwise runtime failure.
 */
export function classifyLocalExecutionError(error: unknown): LocalCycleOutcome {
    return v.parse(LocalCycleOutcomeSchema, {
        kind: 'infrastructure',
        category:
            error instanceof LocalExecutionInfrastructureError
                ? error.category
                : LocalInfrastructureFailureCategory.Runtime,
    });
}
