import { InfrastructureFailureReason } from '../../src/types/infrastructure-failure-reason';
import { FixRunResultContractError } from '../../src/orchestrator/fix-core-context';
import {
    LocalExecutionInfrastructureError,
    LocalInfrastructureFailureCategory,
} from './cycle-outcome';

/**
 * Marks a model's explicit decision that the issue is not a filter report.
 */
export const INTAKE_SKIPPED_PREFIX = 'Intake skipped:';

/**
 * Lifecycle stage active when a local run fails before producing a complete result.
 *
 * The runner advances this cursor at each boundary to classify failures before a result exists.
 */
export const LocalFailureStage = {
    /**
     * Loading and parsing the issue snapshot and run configuration.
     */
    Input: 'input',

    /**
     * Preparing the locked execution environment and filters.
     */
    Environment: 'environment',

    /**
     * The investigation itself: agent loop, browser sessions, validation.
     */
    Core: 'core',

    /**
     * Persisting and validating the finished result.
     */
    Output: 'output',
} as const;

/**
 * LocalFailureStage value.
 */
export type LocalFailureStage = (typeof LocalFailureStage)[keyof typeof LocalFailureStage];

/**
 * The run's instruction declares a file-backed verification method, which no session can honour
 * yet; raised at the instruction load, before the core runs its paid investigation.
 */
export class FileBackedApplicationRefusalError extends Error {
    /**
     * @param detail - The shared gate's refusal detail naming the declared method.
     */
    constructor(detail: string) {
        super(detail);
        this.name = 'FileBackedApplicationRefusalError';
    }
}

/**
 * A repository instruction was loaded for a run that requires built-in guidance only.
 */
export class RepositoryInstructionRefusalError extends Error {
    /**
     * @param path - Checkout-relative path of the loaded repository instruction.
     */
    constructor(path: string) {
        super(`Repository instruction is forbidden for this run: ${path}`);
        this.name = 'RepositoryInstructionRefusalError';
    }
}

/**
 * Map wrapper failures to explicit infrastructure reasons without labelling generic core defects.
 *
 * @param stage - Local lifecycle boundary that raised the error.
 * @param error - Error raised at the active lifecycle boundary.
 * @returns Typed infrastructure reason, or undefined when the agent core must remain comparable.
 */
export function infrastructureFailureReasonForStage(
    stage: LocalFailureStage,
    error: unknown,
): InfrastructureFailureReason | undefined {
    if (error instanceof FileBackedApplicationRefusalError) {
        return InfrastructureFailureReason.FileBackedApplicationUnsupported;
    }
    if (stage === LocalFailureStage.Input) {
        return InfrastructureFailureReason.InputUnavailable;
    }
    if (stage === LocalFailureStage.Environment) {
        return InfrastructureFailureReason.EnvironmentUnavailable;
    }
    if (stage === LocalFailureStage.Output) {
        return InfrastructureFailureReason.OutputUnavailable;
    }
    // The finalized result violated its own schema: the investigation ran but produced no
    // publishable output. Typed as the output layer so the cycle records a precise category
    // instead of generic runtime infrastructure.
    if (error instanceof FixRunResultContractError) {
        return InfrastructureFailureReason.OutputUnavailable;
    }
    if (error instanceof LocalExecutionInfrastructureError) {
        if (error.category === LocalInfrastructureFailureCategory.Provider) {
            return InfrastructureFailureReason.LlmUnavailable;
        }
        if (error.category === LocalInfrastructureFailureCategory.Browser) {
            return InfrastructureFailureReason.BrowserUnavailable;
        }
        if (error.category === LocalInfrastructureFailureCategory.Environment) {
            return InfrastructureFailureReason.EnvironmentUnavailable;
        }
        if (error.category === LocalInfrastructureFailureCategory.InvestigationInput) {
            return InfrastructureFailureReason.InputUnavailable;
        }
        if (
            error.category === LocalInfrastructureFailureCategory.InvestigationOutput ||
            error.category === LocalInfrastructureFailureCategory.ResultPublication
        ) {
            return InfrastructureFailureReason.OutputUnavailable;
        }
    }
    return undefined;
}
