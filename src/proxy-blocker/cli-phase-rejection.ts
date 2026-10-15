import {
    BaselineLineRefusal,
    EnvironmentAdapterLimitationCode,
    EnvironmentLimitationStage,
    type EnvironmentAdapterLimitation,
} from '../environment/filtering-environment';

/**
 * Finite local reason one phase was refused.
 *
 * These never cross the public boundary: each maps to one already-defined public limitation code,
 * while the observed catalog facts behind it stay in the local diagnostic log. Four distinct
 * invariants collapse into `phase_proof_unavailable`, so without the log a refusal could not say
 * which of them it stands for.
 */
export const CliPhaseRejection = {
    /**
     * The adapter is not in a ready lifecycle state when a phase is opened.
     */
    EnvironmentNotReady: 'environment_not_ready',

    /**
     * A control or published baseline phase request carried a candidate.
     */
    CandidateNotApplicable: 'candidate_not_applicable',

    /**
     * The candidate phase's requested shape is not one this adapter can execute.
     */
    CandidateUnsupported: 'candidate_unsupported',

    /**
     * The published baseline phase was opened before the control phase.
     */
    ControlPhaseAbsent: 'control_phase_absent',

    /**
     * The candidate phase was opened before the published baseline phase.
     */
    BaselinePhaseAbsent: 'baseline_phase_absent',

    /**
     * An enable or disable command for a pinned official filter failed.
     */
    FilterCommandFailed: 'filter_command_failed',

    /**
     * The native catalog listing could not be read or parsed.
     */
    CatalogUnreadable: 'catalog_unreadable',

    /**
     * The control phase did not prove every requested official filter disabled.
     */
    ControlStateUnproven: 'control_state_unproven',

    /**
     * The published baseline phase did not prove every requested official filter enabled.
     */
    BaselineStateUnproven: 'baseline_state_unproven',

    /**
     * The catalog IDs enabled beyond the requested set changed between phases.
     */
    CoenabledSetChanged: 'coenabled_set_changed',

    /**
     * The requested official filter subset is not part of the locked baseline.
     */
    IsolationSubsetInvalid: 'isolation_subset_invalid',

    /**
     * Applying the proposed candidate rule or baseline mutation through the native port failed.
     */
    CandidateApplyFailed: 'candidate_apply_failed',

    /**
     * The published line a baseline mutation names is in no list the installation executes.
     */
    BaselineLineNotFound: BaselineLineRefusal.NotFound,

    /**
     * The published line a baseline mutation names occurs more than once in the executed lists.
     */
    BaselineLineNotUnique: BaselineLineRefusal.NotUnique,

    /**
     * The native receipt for the applied candidate or baseline mutation did not match expectations.
     */
    CandidateReceiptInvalid: 'candidate_receipt_invalid',

    /**
     * The official filtering state diverged from the published baseline by more than the candidate.
     */
    CandidateStateDiverged: 'candidate_state_diverged',

    /**
     * The controlled browser session for the phase could not be established.
     */
    SessionUnavailable: 'session_unavailable',
} as const;

/**
 * CliPhaseRejection value.
 */
export type CliPhaseRejection = (typeof CliPhaseRejection)[keyof typeof CliPhaseRejection];

/**
 * Public limitation each finite local reason collapses to.
 */
export const PHASE_LIMITATIONS: Readonly<Record<CliPhaseRejection, EnvironmentAdapterLimitation>> =
    Object.freeze({
        [CliPhaseRejection.EnvironmentNotReady]: {
            code: EnvironmentAdapterLimitationCode.PhaseOpenFailed,
            stage: EnvironmentLimitationStage.Phase,
            detail: 'The AdGuard CLI environment is not ready for phase execution.',
        },
        [CliPhaseRejection.CandidateNotApplicable]: {
            code: EnvironmentAdapterLimitationCode.PhaseOpenFailed,
            stage: EnvironmentLimitationStage.Phase,
            detail: 'A control or published baseline phase cannot carry a candidate.',
        },
        [CliPhaseRejection.CandidateUnsupported]: {
            code: EnvironmentAdapterLimitationCode.CandidateOperationUnsupported,
            stage: EnvironmentLimitationStage.Candidate,
            detail: 'The selected environment cannot apply this candidate operation.',
        },
        [CliPhaseRejection.ControlPhaseAbsent]: {
            code: EnvironmentAdapterLimitationCode.PhaseProofUnavailable,
            stage: EnvironmentLimitationStage.Phase,
            detail: 'The published baseline phase requires an established control phase.',
        },
        [CliPhaseRejection.BaselinePhaseAbsent]: {
            code: EnvironmentAdapterLimitationCode.PhaseProofUnavailable,
            stage: EnvironmentLimitationStage.Phase,
            detail: 'The candidate phase requires an established published baseline phase.',
        },
        [CliPhaseRejection.FilterCommandFailed]: {
            code: EnvironmentAdapterLimitationCode.PhaseOpenFailed,
            stage: EnvironmentLimitationStage.Phase,
            detail: 'The requested filtering state could not be applied.',
        },
        [CliPhaseRejection.CatalogUnreadable]: {
            code: EnvironmentAdapterLimitationCode.PhaseProofUnavailable,
            stage: EnvironmentLimitationStage.Phase,
            detail: 'The filtering state of the isolated installation could not be read.',
        },
        [CliPhaseRejection.ControlStateUnproven]: {
            code: EnvironmentAdapterLimitationCode.PhaseProofUnavailable,
            stage: EnvironmentLimitationStage.Phase,
            detail: 'The requested official filters were not proven disabled for the control.',
        },
        [CliPhaseRejection.BaselineStateUnproven]: {
            code: EnvironmentAdapterLimitationCode.PhaseProofUnavailable,
            stage: EnvironmentLimitationStage.Phase,
            detail: 'The requested official filters were not proven enabled for the baseline.',
        },
        [CliPhaseRejection.CoenabledSetChanged]: {
            code: EnvironmentAdapterLimitationCode.PhaseProofUnavailable,
            stage: EnvironmentLimitationStage.Phase,
            detail: 'The filters enabled beyond the requested set differ between the two phases.',
        },
        [CliPhaseRejection.IsolationSubsetInvalid]: {
            code: EnvironmentAdapterLimitationCode.SettingsMismatch,
            stage: EnvironmentLimitationStage.Phase,
            detail: 'The requested official filter subset is not part of the locked baseline.',
        },
        [CliPhaseRejection.CandidateApplyFailed]: {
            code: EnvironmentAdapterLimitationCode.CandidateApplicationFailed,
            stage: EnvironmentLimitationStage.Candidate,
            detail: 'The proposed rule could not be applied beside the published baseline.',
        },
        [CliPhaseRejection.BaselineLineNotFound]: {
            code: EnvironmentAdapterLimitationCode.BaselineLineNotFound,
            stage: EnvironmentLimitationStage.Candidate,
            detail: 'The published lists the environment executes do not carry the line to change.',
        },
        [CliPhaseRejection.BaselineLineNotUnique]: {
            code: EnvironmentAdapterLimitationCode.BaselineLineNotUnique,
            stage: EnvironmentLimitationStage.Candidate,
            detail: 'The line to change occurs more than once in the executed published lists.',
        },
        [CliPhaseRejection.CandidateReceiptInvalid]: {
            code: EnvironmentAdapterLimitationCode.CandidateApplicationFailed,
            stage: EnvironmentLimitationStage.Candidate,
            detail: 'The isolated installation does not execute exactly the one proposed rule.',
        },
        [CliPhaseRejection.CandidateStateDiverged]: {
            code: EnvironmentAdapterLimitationCode.PhaseProofUnavailable,
            stage: EnvironmentLimitationStage.Phase,
            detail: 'The official filtering state differs between the baseline and candidate phases.',
        },
        [CliPhaseRejection.SessionUnavailable]: {
            code: EnvironmentAdapterLimitationCode.PhaseOpenFailed,
            stage: EnvironmentLimitationStage.Phase,
            detail: 'The controlled browser session could not be established.',
        },
    });

/**
 * Refusal carrying one finite local reason across the internal call stack.
 */
export class PhaseRejectionError extends Error {
    /**
     * Finite local reason behind the refusal.
     */
    readonly reason: CliPhaseRejection;

    constructor(reason: CliPhaseRejection) {
        super(reason);
        this.reason = reason;
    }
}

/**
 * Stop the phase with one finite local reason.
 *
 * @param reason - Finite local reason behind the refusal.
 * @returns Never; always throws.
 */
export function reject(reason: CliPhaseRejection): never {
    throw new PhaseRejectionError(reason);
}
