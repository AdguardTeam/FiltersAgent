import * as v from 'valibot';
import type { IBrowserSession } from '../browser/browser-interfaces';
import {
    CANDIDATE_VISUAL_VERDICT_VALUES,
    CandidateVisualReviewSchema,
} from '../types/candidate-visual-review';
import { ReporterSymptomPresenceSchema } from '../types/reporter-symptom-presence';
import { ReproProfileSchema } from '../types/repro-profile';
import { ExecutorNameSchema } from './executor-name';
import { EnvironmentCapabilitySchema } from './environment-vocabulary';
import { ActualExecutionContextSchema } from './environment-selection-contract';
import {
    BoundedIdSchema,
    DigestSchema,
    EnvironmentPhaseSchema,
    EnvironmentPhaseStateProofSchema,
    PublicDetailSchema,
    PublishedBaselineProvenanceSchema,
    type EnvironmentPhase,
    type EnvironmentPhaseStateProof,
} from './environment-proofs';
import { FilterListRef } from './filter-list-ref';
import { PhaseLabel } from '../types/validation';

/**
 * Lifecycle stage of one filtering environment adapter instance.
 */
export const EnvironmentLifecycle = {
    /**
     * The adapter has not yet been prepared.
     */
    Unprepared: 'unprepared',

    /**
     * The adapter is prepared and ready to open phases.
     */
    Ready: 'ready',

    /**
     * The adapter prepared with a lesser capability than requested.
     */
    Limited: 'limited',

    /**
     * The adapter finished cleanup successfully.
     */
    Cleaned: 'cleaned',

    /**
     * Adapter cleanup did not complete successfully.
     */
    CleanupFailed: 'cleanup_failed',
} as const;

/**
 * Every EnvironmentLifecycle value, for schemas and exhaustive listings.
 */
export const ENVIRONMENT_LIFECYCLE_VALUES = Object.values(EnvironmentLifecycle);

export const EnvironmentLifecycleSchema = v.picklist(ENVIRONMENT_LIFECYCLE_VALUES);

/**
 * EnvironmentLifecycle value.
 */
export type EnvironmentLifecycle = (typeof EnvironmentLifecycle)[keyof typeof EnvironmentLifecycle];

/**
 * Stage at which an environment adapter limitation was raised.
 */
export const EnvironmentLimitationStage = {
    /**
     * Raised while preparing and integrity-locking the baseline.
     */
    Preparation: 'preparation',

    /**
     * Raised while establishing or observing the published-baseline phase.
     */
    Baseline: 'baseline',

    /**
     * Raised while opening or proving an arbitrary phase.
     */
    Phase: 'phase',

    /**
     * Raised while applying a candidate operation.
     */
    Candidate: 'candidate',

    /**
     * Raised while finishing adapter cleanup.
     */
    Cleanup: 'cleanup',
} as const;

/**
 * Every EnvironmentLimitationStage value, for schemas and exhaustive listings.
 */
export const ENVIRONMENT_LIMITATION_STAGE_VALUES = Object.values(EnvironmentLimitationStage);

export const EnvironmentLimitationStageSchema = v.picklist(ENVIRONMENT_LIMITATION_STAGE_VALUES);

/**
 * EnvironmentLimitationStage value.
 */
export type EnvironmentLimitationStage =
    (typeof EnvironmentLimitationStage)[keyof typeof EnvironmentLimitationStage];

/**
 * Stable public capability limitation code raised by a filtering environment adapter.
 */
export const EnvironmentAdapterLimitationCode = {
    /**
     * The adapter could not prove the exact baseline content it executed.
     */
    BaselineIntegrityUnavailable: 'baseline_integrity_unavailable',

    /**
     * The baseline filter manifest could not be parsed or validated.
     */
    BaselineManifestInvalid: 'baseline_manifest_invalid',

    /**
     * A baseline resource exceeded a bounded size or count limit.
     */
    BaselineResourceLimitExceeded: 'baseline_resource_limit_exceeded',

    /**
     * A baseline resource failed a safety check before use.
     */
    BaselineResourceUnsafe: 'baseline_resource_unsafe',

    /**
     * A baseline resource no longer matches what was locked at preparation.
     */
    BaselineResourceChanged: 'baseline_resource_changed',

    /**
     * The adapter's active settings do not match the requested configuration.
     */
    SettingsMismatch: 'settings_mismatch',

    /**
     * The requested candidate operation cannot be executed by this adapter.
     */
    CandidateOperationUnsupported: 'candidate_operation_unsupported',

    /**
     * The between-phases application was refused before any model turn: the run instruction
     * describes no way to apply or verify a rule, so the adapter invents none.
     */
    ApplicationInstructionRefused: 'application_instruction_refused',

    /**
     * The candidate mutation was attempted but did not apply.
     */
    CandidateApplicationFailed: 'candidate_application_failed',

    /**
     * The adapter could not open the requested phase.
     */
    PhaseOpenFailed: 'phase_open_failed',

    /**
     * The adapter could not produce proof of the phase's exact filtering state.
     */
    PhaseProofUnavailable: 'phase_proof_unavailable',

    /**
     * Adapter cleanup did not complete.
     */
    CleanupFailed: 'cleanup_failed',
} as const;

/**
 * Every EnvironmentAdapterLimitationCode value, for schemas and exhaustive listings.
 */
export const ENVIRONMENT_ADAPTER_LIMITATION_CODE_VALUES = Object.values(
    EnvironmentAdapterLimitationCode,
);

export const EnvironmentAdapterLimitationCodeSchema = v.picklist(
    ENVIRONMENT_ADAPTER_LIMITATION_CODE_VALUES,
);

/**
 * EnvironmentAdapterLimitationCode value.
 */
export type EnvironmentAdapterLimitationCode =
    (typeof EnvironmentAdapterLimitationCode)[keyof typeof EnvironmentAdapterLimitationCode];

export const EnvironmentAdapterLimitationSchema = v.strictObject({
    code: EnvironmentAdapterLimitationCodeSchema,
    stage: EnvironmentLimitationStageSchema,
    detail: PublicDetailSchema,
});

export const EnvironmentPreparationProofSchema = v.strictObject({
    preparedAt: v.pipe(v.string(), v.isoTimestamp()),
    buildDigest: DigestSchema,
    extensionRootDigest: v.nullable(DigestSchema),
});

export const EnvironmentCleanupReceiptSchema = v.pipe(
    v.strictObject({
        attempted: v.boolean(),
        completed: v.boolean(),
        finalizerAttempts: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(128)),
        finalizerCompleted: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(128)),
        finalizerFailed: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(128)),
        failures: v.pipe(v.array(EnvironmentAdapterLimitationSchema), v.maxLength(128)),
    }),
    v.check(
        (receipt) =>
            receipt.finalizerCompleted + receipt.finalizerFailed === receipt.finalizerAttempts &&
            (!receipt.completed ||
                (receipt.finalizerFailed === 0 && receipt.failures.length === 0)),
        'Cleanup receipt counts and completion state must agree.',
    ),
);

export const EnvironmentHandleDrainReceiptSchema = v.strictObject({
    attempted: v.pipe(v.number(), v.integer(), v.minValue(0)),
    closed: v.pipe(v.number(), v.integer(), v.minValue(0)),
    failed: v.pipe(v.number(), v.integer(), v.minValue(0)),
    failures: v.pipe(v.array(EnvironmentAdapterLimitationSchema), v.maxLength(128)),
});

export const FilteringEnvironmentAdapterStateSchema = v.strictObject({
    kind: ExecutorNameSchema,
    lifecycle: EnvironmentLifecycleSchema,
    stateDigest: DigestSchema,
    actualContext: ActualExecutionContextSchema,
    capabilities: v.pipe(v.array(EnvironmentCapabilitySchema), v.maxLength(16)),
    preparation: v.nullable(EnvironmentPreparationProofSchema),
    baseline: v.nullable(PublishedBaselineProvenanceSchema),
    openLeaseIds: v.pipe(v.array(BoundedIdSchema), v.maxLength(32)),
    cleanup: v.nullable(EnvironmentCleanupReceiptSchema),
});

/**
 * Canonical baseline-mutation vocabulary shared by the tool schema, the runtime ledger, and every
 * environment adapter.
 */
export const CANDIDATE_OPERATION_VALUES = ['add', 'edit', 'remove'] as const;

/**
 * Named candidate operations, so behaviour that branches on one never spells it inline.
 */
export const CandidateOperation = {
    Add: 'add',
    Edit: 'edit',
    Remove: 'remove',
} as const satisfies Record<string, CandidateOperation>;

/**
 * One baseline mutation an environment may be asked to execute for a candidate.
 */
export type CandidateOperation = (typeof CANDIDATE_OPERATION_VALUES)[number];

export const EnvironmentCandidateSchema = v.strictObject({
    operation: v.picklist(CANDIDATE_OPERATION_VALUES),
    rule: v.pipe(v.string(), v.minLength(1), v.maxLength(4_096), v.regex(/^[^\r\n]+$/u)),
    // Exact existing line the candidate replaces; present only for an `edit`, whose C state is the
    // published baseline with that one line rewritten rather than one rule installed beside it.
    originalRule: v.optional(
        v.pipe(v.string(), v.minLength(1), v.maxLength(4_096), v.regex(/^[^\r\n]+$/u)),
    ),
});

export const EnvironmentArtifactReferenceSchema = v.strictObject({
    artifactId: BoundedIdSchema,
    kind: v.picklist(['screenshot', 'har', 'dom', 'vision', 'validation', 'interaction']),
    path: v.pipe(v.string(), v.minLength(1), v.maxLength(4_096)),
});

export const EnvironmentTargetObservationSchema = v.strictObject({
    symptomPresent: v.boolean(),
    pageUsable: v.boolean(),
});

export const EnvironmentVisionReferenceSchema = v.strictObject({
    artifactId: BoundedIdSchema,
    verdict: v.picklist(CANDIDATE_VISUAL_VERDICT_VALUES),
});

export const EnvironmentCandidateValidationSchema = v.strictObject({
    validationArtifactId: BoundedIdSchema,
    candidateDigest: DigestSchema,
    candidateRule: v.optional(
        v.pipe(v.string(), v.minLength(1), v.maxLength(4_096), v.regex(/^[^\r\n]+$/u)),
    ),
    verified: v.boolean(),
    screenshotArtifactIds: v.pipe(v.array(BoundedIdSchema), v.length(4)),
    validationArtifact: v.optional(EnvironmentArtifactReferenceSchema),
    visualReviewArtifact: v.optional(EnvironmentArtifactReferenceSchema),
    beforeViewport: v.optional(EnvironmentArtifactReferenceSchema),
    afterViewport: v.optional(EnvironmentArtifactReferenceSchema),
    beforeFullPage: v.optional(EnvironmentArtifactReferenceSchema),
    afterFullPage: v.optional(EnvironmentArtifactReferenceSchema),
});

export const EnvironmentRejectedCandidateSchema = v.strictObject({
    experimentId: BoundedIdSchema,
    phase: EnvironmentPhaseSchema,
    candidateDigest: DigestSchema,
    reasonCodes: v.pipe(v.array(BoundedIdSchema), v.minLength(1), v.maxLength(20)),
});

export const EnvironmentBrowserCaptureSchema = v.strictObject({
    visionVerified: v.boolean(),
    viewportArtifactId: v.nullable(BoundedIdSchema),
    viewport: v.nullable(v.pipe(v.string(), v.minLength(1))),
    fullPageOverviewArtifactId: v.nullable(BoundedIdSchema),
    fullPageOverview: v.nullable(v.pipe(v.string(), v.minLength(1))),
    tileArtifactIds: v.array(BoundedIdSchema),
    tiles: v.array(v.pipe(v.string(), v.minLength(1))),
    coverageComplete: v.boolean(),
    reporterSymptomPresence: v.optional(v.nullable(ReporterSymptomPresenceSchema)),
});

export const ValidatorObservedPhaseCompletionSchema = v.strictObject({
    kind: v.literal('observed'),
    sessionId: BoundedIdSchema,
    targetUrl: v.pipe(v.string(), v.url()),
    targetObservation: EnvironmentTargetObservationSchema,
    navigationVerified: v.boolean(),
    artifacts: v.pipe(v.array(EnvironmentArtifactReferenceSchema), v.maxLength(256)),
    vision: v.nullable(EnvironmentVisionReferenceSchema),
    candidateValidation: v.nullable(EnvironmentCandidateValidationSchema),
    rejectedCandidates: v.pipe(v.array(EnvironmentRejectedCandidateSchema), v.maxLength(32)),
    profile: v.optional(ReproProfileSchema),
    captures: v.optional(v.pipe(v.array(EnvironmentBrowserCaptureSchema), v.maxLength(32))),
    visualReview: v.optional(CandidateVisualReviewSchema),
});

export const ValidatorFailedPhaseCompletionSchema = v.strictObject({
    kind: v.literal('failed'),
    sessionId: BoundedIdSchema,
    limitation: EnvironmentAdapterLimitationSchema,
});

export const ValidatorPhaseCompletionSchema = v.variant('kind', [
    ValidatorObservedPhaseCompletionSchema,
    ValidatorFailedPhaseCompletionSchema,
]);

export const EnvironmentPhaseEvidenceSchema = v.strictObject({
    runId: BoundedIdSchema,
    experimentId: BoundedIdSchema,
    phase: EnvironmentPhaseSchema,
    proof: EnvironmentPhaseStateProofSchema,
    completion: ValidatorPhaseCompletionSchema,
});

export const ProvisionalEnvironmentDispositionSchema = v.strictObject({
    status: v.picklist(['verified', 'rejected', 'inconclusive', 'failed', 'capability_limited']),
    candidateDigest: v.nullable(DigestSchema),
    failure: v.nullable(EnvironmentAdapterLimitationSchema),
});

export const FilteringEnvironmentExecutionSchema = v.pipe(
    v.strictObject({
        recorderVersion: v.literal(1),
        runId: BoundedIdSchema,
        kind: ExecutorNameSchema,
        actualContext: ActualExecutionContextSchema,
        capabilities: v.pipe(v.array(EnvironmentCapabilitySchema), v.maxLength(16)),
        preparation: v.nullable(EnvironmentPreparationProofSchema),
        baseline: v.nullable(PublishedBaselineProvenanceSchema),
        phases: v.pipe(v.array(EnvironmentPhaseEvidenceSchema), v.maxLength(32)),
        rejectedCandidates: v.pipe(v.array(EnvironmentRejectedCandidateSchema), v.maxLength(128)),
        drain: EnvironmentHandleDrainReceiptSchema,
        cleanup: EnvironmentCleanupReceiptSchema,
        investigationDisposition: ProvisionalEnvironmentDispositionSchema,
        secondaryFailures: v.pipe(v.array(EnvironmentAdapterLimitationSchema), v.maxLength(128)),
        disposition: ProvisionalEnvironmentDispositionSchema,
    }),
    v.check(
        (execution) =>
            execution.disposition.status !== 'verified' ||
            (execution.cleanup.completed &&
                execution.phases.some((phase) => phase.phase === PhaseLabel.A) &&
                execution.phases.some((phase) => phase.phase === PhaseLabel.B) &&
                execution.phases.some((phase) => phase.phase === PhaseLabel.C)),
        'Verified execution requires successful cleanup and complete A/B/C evidence.',
    ),
    v.check((execution) => {
        const cleanupFailed = !execution.cleanup.completed || execution.drain.failed > 0;
        if (!cleanupFailed) {
            return (
                execution.secondaryFailures.length === 0 &&
                JSON.stringify(execution.disposition) ===
                    JSON.stringify(execution.investigationDisposition)
            );
        }
        return (
            execution.disposition.status === 'failed' &&
            execution.disposition.candidateDigest === null &&
            execution.disposition.failure?.code === EnvironmentAdapterLimitationCode.CleanupFailed
        );
    }, 'Final disposition must retain investigation evidence and apply cleanup precedence.'),
);

/**
 * State of one environment phase.
 */
export type EnvironmentAdapterLimitation = v.InferOutput<typeof EnvironmentAdapterLimitationSchema>;

/**
 * Adapter-owned immutable state without validator observations.
 */
export type FilteringEnvironmentAdapterState = v.InferOutput<
    typeof FilteringEnvironmentAdapterStateSchema
>;

/**
 * Candidate operation requested for phase C.
 */
export type EnvironmentCandidate = v.InferOutput<typeof EnvironmentCandidateSchema>;

/**
 * One artifact owned by canonical environment evidence.
 */
export type EnvironmentArtifactReference = v.InferOutput<typeof EnvironmentArtifactReferenceSchema>;

/**
 * Successful validator observation for one environment phase.
 */
export type ValidatorObservedPhaseCompletion = v.InferOutput<
    typeof ValidatorObservedPhaseCompletionSchema
>;

/**
 * One canonical browser capture projected into compatibility evidence.
 */
export type EnvironmentBrowserCapture = v.InferOutput<typeof EnvironmentBrowserCaptureSchema>;

/**
 * Request used to prepare an environment baseline.
 */
export interface EnvironmentPreparationRequest {
    /**
     * Filter lists requested by the reporter, as opaque catalog references.
     */
    requestedLists: readonly FilterListRef[];
}

/**
 * Successfully prepared environment state.
 */
export interface ReadyEnvironmentPreparation {
    /**
     * Discriminator for a ready environment.
     */
    ready: true;

    /**
     * Immutable prepared adapter state.
     */
    state: FilteringEnvironmentAdapterState;
}

/**
 * Preparation result stopped by a typed limitation.
 */
export interface LimitedEnvironmentPreparation {
    /**
     * Discriminator for an unavailable environment.
     */
    ready: false;

    /**
     * Stable preparation limitation.
     */
    limitation: EnvironmentAdapterLimitation;
}

/**
 * Successful or limited preparation result.
 */
export type EnvironmentPreparationResult =
    | ReadyEnvironmentPreparation
    | LimitedEnvironmentPreparation;

/**
 * Request to establish one exact environment phase.
 */
export interface EnvironmentPhaseRequest {
    /**
     * Experiment identity shared by its A/B/C phases.
     */
    experimentId: string;

    /**
     * Phase requested from the environment.
     */
    phase: EnvironmentPhase;

    /**
     * Canonical target URL used by the controlled browser.
     */
    targetUrl: string;

    /**
     * Exact candidate for C or null for A/B.
     */
    candidate: EnvironmentCandidate | null;

    /**
     * Official list subset to enable for phase B, or null for the whole locked baseline.
     *
     * The locked baseline content never changes; only which of its lists are enabled does. An
     * adapter that cannot narrow its enabled set must refuse the phase rather than silently run the
     * whole baseline.
     */
    enabledListKeys?: readonly string[] | null;

    /**
     * Caller cancellation for the whole experiment, when the outer deadline provides one.
     *
     * An adapter whose phase runs a between-phases application session (B/C) must forward this into
     * that session, so a B/C application aborts with the experiment instead of outliving it on its
     * own per-session budget.
     */
    signal?: AbortSignal;
}
export interface AdapterPhaseLease {
    /**
     * Environment-independent browser session used by validators.
     */
    readonly session: IBrowserSession;

    /**
     * Adapter-authored proof of the exact filtering state.
     */
    readonly adapterProof: EnvironmentPhaseStateProof;

    /**
     * Close this lease without affecting other phase handles.
     *
     * @returns Nothing after the resource is closed.
     */
    close(): Promise<void>;
}

/**
 * Successfully opened environment phase.
 */
export interface ReadyEnvironmentPhase {
    /**
     * Discriminator for an available phase.
     */
    ready: true;

    /**
     * Adapter-owned browser lease.
     */
    handle: AdapterPhaseLease;
}

/**
 * Phase result stopped by a typed limitation.
 */
export interface LimitedEnvironmentPhase {
    /**
     * Discriminator for an unavailable phase.
     */
    ready: false;

    /**
     * Stable phase limitation.
     */
    limitation: EnvironmentAdapterLimitation;
}

/**
 * Ready phase lease or a typed capability limitation.
 */
export type EnvironmentPhaseOpenResult = ReadyEnvironmentPhase | LimitedEnvironmentPhase;

/**
 * Receipt for draining all adapter-owned browser handles.
 */
export type EnvironmentHandleDrainReceipt = v.InferOutput<
    typeof EnvironmentHandleDrainReceiptSchema
>;

/**
 * Receipt for final adapter cleanup.
 */
export type EnvironmentCleanupReceipt = v.InferOutput<typeof EnvironmentCleanupReceiptSchema>;

/**
 * Stable contract implemented by every filtering environment.
 */
export interface FilteringEnvironmentAdapter {
    /**
     * Filtering kind implemented by the adapter.
     */
    readonly kind: FilteringEnvironmentAdapterState['kind'];

    /**
     * Return advertised common capabilities.
     *
     * @returns Fresh capability values.
     */
    capabilities(): FilteringEnvironmentAdapterState['capabilities'];

    /**
     * Prepare and integrity-lock the requested baseline.
     *
     * @param request - Exact official filter selection.
     * @returns Ready state or a typed limitation.
     */
    prepare(request: EnvironmentPreparationRequest): Promise<EnvironmentPreparationResult>;

    /**
     * Establish one real filtering phase.
     *
     * @param request - Requested phase, target, and optional candidate.
     * @returns A browser lease or a typed limitation.
     */
    openPhase(request: EnvironmentPhaseRequest): Promise<EnvironmentPhaseOpenResult>;

    /**
     * Close every currently registered handle while continuing after failures.
     *
     * @returns Complete bounded drain receipt.
     */
    drainOpenHandles(): Promise<EnvironmentHandleDrainReceipt>;

    /**
     * Return immutable adapter-only state.
     *
     * @returns Fresh state without validator observations.
     */
    snapshot(): FilteringEnvironmentAdapterState;

    /**
     * Finish adapter-owned cleanup idempotently.
     *
     * @returns Complete cleanup receipt.
     */
    cleanup(): Promise<EnvironmentCleanupReceipt>;
}

/**
 * Opaque recorder token for one run/experiment/phase boundary.
 */
export interface EnvironmentPhaseToken {
    /**
     * Recorder-issued opaque identity.
     */
    readonly tokenId: string;

    /**
     * Run identity owning the token.
     */
    readonly runId: string;

    /**
     * Experiment identity owning the phase.
     */
    readonly experimentId: string;

    /**
     * Exact phase represented by this token.
     */
    readonly phase: EnvironmentPhase;
}

/**
 * Request for one recorder-issued phase token.
 */
export interface BeginEnvironmentPhaseRequest {
    /**
     * Run identity that must match the recorder.
     */
    runId: string;

    /**
     * Experiment identity for this phase.
     */
    experimentId: string;

    /**
     * Requested A/B/C phase.
     */
    phase: EnvironmentPhase;
}

/**
 * Lease after the recorder has bound its proof to a token.
 */
export interface BoundEnvironmentPhaseHandle {
    /**
     * Recorder token naming the bound phase.
     */
    readonly token: EnvironmentPhaseToken;

    /**
     * Adapter lease accepted for validator use.
     */
    readonly lease: AdapterPhaseLease;
}

/**
 * Complete validator-owned observation or typed phase failure.
 */
export type ValidatorPhaseCompletion = v.InferOutput<typeof ValidatorPhaseCompletionSchema>;

/**
 * Canonical recorder-owned evidence for one phase.
 */
export type EnvironmentPhaseEvidence = v.InferOutput<typeof EnvironmentPhaseEvidenceSchema>;

/**
 * Cleanup input accepted only after the outer owner has awaited all cleanup work.
 */
export interface FinalEnvironmentCleanupInput {
    /**
     * Final adapter-only state.
     */
    adapterState: FilteringEnvironmentAdapterState;

    /**
     * Complete handle-drain receipt.
     */
    drain: EnvironmentHandleDrainReceipt;

    /**
     * Complete adapter finalizer receipt.
     */
    cleanup: EnvironmentCleanupReceipt;
}

/**
 * Provisional investigation disposition applied after cleanup.
 */
export type ProvisionalEnvironmentDisposition = v.InferOutput<
    typeof ProvisionalEnvironmentDispositionSchema
>;

/**
 * Complete post-cleanup canonical environment execution.
 */
export type FilteringEnvironmentExecution = v.InferOutput<
    typeof FilteringEnvironmentExecutionSchema
>;
