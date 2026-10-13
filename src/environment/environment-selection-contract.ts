/**
 * The environment selection contract: the model's selection and intent requests, the execution
 * contexts, capability and fidelity limits, rejection reasons, and the durable selection snapshot
 * with the responses the host returns. The host that enforces it is `environment-selection.ts`.
 */
import * as v from 'valibot';
import { ExecutorNameSchema } from './executor-name';
import { ExecutorPreparationState, ExecutorPreparationSchema } from './executor-preparation';
import {
    SelectionFilterBaselineSchema,
    type SelectionFilterBaseline,
} from './declared-filter-baseline';
import { DeclaredIssueContextSchema } from './declared-issue-context';
import { FilterBaselineStatus } from './filter-baseline-status';
import {
    EnvironmentCapabilitySchema,
    EnvironmentLimitationCode,
    EnvironmentLimitationCodeSchema,
    EnvironmentPreparationState,
    EnvironmentSelectionKind,
    EnvironmentSelectionKindSchema,
    EnvironmentSelectionReservedCase,
    EnvironmentSelectionState,
    EnvironmentSelectionStateSchema,
    FilteringEnvironmentDescriptorSchema,
} from './environment-vocabulary';

const BoundedModelTextSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(2_000));
export const BoundedContextTextSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(200));

/**
 * Where one piece of the model's intent evidence came from.
 */
export const IntentEvidenceSource = {
    /**
     * The issue text.
     */
    IssueBody: 'issue_body',

    /**
     * An issue label.
     */
    Label: 'label',

    /**
     * A reporter screenshot.
     */
    Screenshot: 'screenshot',

    /**
     * What the run's browser showed.
     */
    Browser: 'browser',

    /**
     * Another tool result.
     */
    Tool: 'tool',
} as const;

/**
 * IntentEvidenceSource value.
 */
export type IntentEvidenceSource = (typeof IntentEvidenceSource)[keyof typeof IntentEvidenceSource];

/**
 * The model's classification of what the report is about.
 */
export const IntentIssueType = {
    /**
     * Ads the filters miss.
     */
    Ads: 'ads',

    /**
     * An annoyance.
     */
    Annoyance: 'annoyance',

    /**
     * Filtering breaks the site.
     */
    IncorrectBlocking: 'incorrect_blocking',

    /**
     * An anti-adblock wall or detector.
     */
    AntiAdblock: 'anti_adblock',

    /**
     * A problem with the product itself rather than a filter.
     */
    ProductSpecific: 'product_specific',

    /**
     * Not classified yet.
     */
    Unknown: 'unknown',
} as const;

/**
 * IntentIssueType value.
 */
export type IntentIssueType = (typeof IntentIssueType)[keyof typeof IntentIssueType];

/**
 * Most capability limits one selection snapshot records; later ones are dropped, the earliest kept.
 */
export const MAX_CAPABILITY_LIMITS = 8;

/**
 * Most entries the intent and rejected-request histories keep; the intent history keeps its first
 * entry and the latest ones past this bound.
 */
export const MAX_SELECTION_HISTORY = 4;

export const AgentIntentEvidenceSchema = v.strictObject({
    source: v.picklist(Object.values(IntentEvidenceSource)),
    observation: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
});

export const AgentIntentAssessmentSchema = v.strictObject({
    issueType: v.picklist(Object.values(IntentIssueType)),
    rationale: BoundedModelTextSchema,
    confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    evidence: v.pipe(v.array(AgentIntentEvidenceSchema), v.maxLength(12)),
    conflicts: v.pipe(
        v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))),
        v.maxLength(8),
    ),
});

export const AgentEnvironmentSelectionRequestSchema = v.strictObject({
    kind: EnvironmentSelectionKindSchema,
    requiredCapabilities: v.pipe(v.array(EnvironmentCapabilitySchema), v.maxLength(16)),
    intent: AgentIntentAssessmentSchema,
    rationale: BoundedModelTextSchema,
    confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
});

export const ReportedExecutionContextSchema = v.strictObject({
    product: v.nullable(BoundedContextTextSchema),
    os: v.nullable(BoundedContextTextSchema),
    browser: v.nullable(BoundedContextTextSchema),
});

export const ActualExecutionContextSchema = v.strictObject({
    kind: ExecutorNameSchema,
    product: BoundedContextTextSchema,
    browser: BoundedContextTextSchema,
    productVersion: v.nullable(BoundedContextTextSchema),
});

export const ActualExecutionContextInputSchema = v.strictObject({
    product: BoundedContextTextSchema,
    browser: BoundedContextTextSchema,
    productVersion: v.optional(BoundedContextTextSchema),
});

export const CapabilityLimitSchema = v.strictObject({
    kind: ExecutorNameSchema,
    code: EnvironmentLimitationCodeSchema,
    capability: v.nullable(EnvironmentCapabilitySchema),
    detail: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
});

export const CapabilityLimitInputSchema = v.strictObject({
    code: EnvironmentLimitationCodeSchema,
    capability: v.optional(EnvironmentCapabilitySchema),
    detail: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
});

/**
 * How a locked filtering environment approximates the reporter's exact configuration.
 */
export const FidelityLimitationCode = {
    /**
     * The executing product differs from the product named in the report.
     */
    ProductApproximation: 'product_approximation',

    /**
     * The executing controlled browser differs from the browser named in the report.
     */
    BrowserApproximation: 'browser_approximation',

    /**
     * The reported filter selection could not be reproduced exactly.
     */
    FilterSelectionApproximation: 'filter_selection_approximation',

    /**
     * The reported filter selection exceeds the executing browser's MV3 limits, so the run could
     * execute it only in part and the terminal evidence comes from a session that selects fewer
     * filters (a request can name 52 filters while Chrome allows 50 static rulesets).
     */
    Mv3LimitsApproximation: 'mv3_limits_approximation',

    /**
     * The executor passed a host through without reading its content, so rules that act inside a
     * page (element hiding, scripts, HTML filtering) could not apply there.
     */
    ContentNotFiltered: 'content_not_filtered',
} as const;

/**
 * Every FidelityLimitationCode value, for schemas and exhaustive listings.
 */
export const FIDELITY_LIMITATION_CODE_VALUES = Object.values(FidelityLimitationCode);

/**
 * FidelityLimitationCode value.
 */
export type FidelityLimitationCode =
    (typeof FidelityLimitationCode)[keyof typeof FidelityLimitationCode];

/**
 * The fidelity codes an executor route reports about what it actually executed; the product and
 * browser approximations are derived from the reported-versus-actual comparison instead.
 */
export type RouteFidelityLimitationCode =
    | typeof FidelityLimitationCode.FilterSelectionApproximation
    | typeof FidelityLimitationCode.Mv3LimitsApproximation
    | typeof FidelityLimitationCode.ContentNotFiltered;

export const FidelityLimitationSchema = v.strictObject({
    code: v.picklist(FIDELITY_LIMITATION_CODE_VALUES),
    detail: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
});

/**
 * Stable reason a selection request was rejected outright.
 */
export const EnvironmentSelectionRejectionReason = {
    /**
     * The model's request failed schema validation.
     */
    InvalidEnvironmentSelection: 'invalid_environment_selection',

    /**
     * An environment was already locked by an earlier accepted request.
     */
    EnvironmentLocked: 'environment_locked',
} as const;

/**
 * EnvironmentSelectionRejectionReason value.
 */
export type EnvironmentSelectionRejectionReason =
    (typeof EnvironmentSelectionRejectionReason)[keyof typeof EnvironmentSelectionRejectionReason];

/**
 * Stable reason an observed-intent update was rejected.
 */
export const IntentUpdateRejectionReason = {
    /**
     * No environment has been locked yet, so there is nothing to update.
     */
    EnvironmentSelectionRequired: 'environment_selection_required',

    /**
     * The model's intent assessment failed schema validation.
     */
    InvalidIntentAssessment: 'invalid_intent_assessment',
} as const;

/**
 * IntentUpdateRejectionReason value.
 */
export type IntentUpdateRejectionReason =
    (typeof IntentUpdateRejectionReason)[keyof typeof IntentUpdateRejectionReason];

export const RejectedEnvironmentSelectionSchema = v.strictObject({
    requestedKind: EnvironmentSelectionKindSchema,
    rationale: BoundedModelTextSchema,
    confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    rejectedAt: v.pipe(v.string(), v.isoTimestamp()),
    errorKind: v.literal(EnvironmentSelectionRejectionReason.EnvironmentLocked),
});

export const EnvironmentSelectionSnapshotSchema = v.pipe(
    v.strictObject({
        selectedKind: EnvironmentSelectionKindSchema,
        state: EnvironmentSelectionStateSchema,
        rationale: BoundedModelTextSchema,
        confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
        requiredCapabilities: v.pipe(v.array(EnvironmentCapabilitySchema), v.maxLength(16)),
        advertisedCapabilities: v.pipe(v.array(EnvironmentCapabilitySchema), v.maxLength(16)),
        missingCapabilities: v.pipe(v.array(EnvironmentCapabilitySchema), v.maxLength(16)),
        descriptor: v.nullable(FilteringEnvironmentDescriptorSchema),
        lockedAt: v.pipe(v.string(), v.isoTimestamp()),
        declared: DeclaredIssueContextSchema,
        reported: ReportedExecutionContextSchema,
        observed: AgentIntentAssessmentSchema,
        intentHistory: v.pipe(
            v.array(AgentIntentAssessmentSchema),
            v.minLength(1),
            v.maxLength(MAX_SELECTION_HISTORY),
        ),
        rejectedRequests: v.pipe(
            v.array(RejectedEnvironmentSelectionSchema),
            v.maxLength(MAX_SELECTION_HISTORY),
        ),
        actual: v.nullable(ActualExecutionContextSchema),
        fidelityLimitations: v.pipe(v.array(FidelityLimitationSchema), v.maxLength(4)),
        capabilityLimits: v.pipe(
            v.array(CapabilityLimitSchema),
            v.maxLength(MAX_CAPABILITY_LIMITS),
        ),
        filterBaseline: v.optional(v.nullable(SelectionFilterBaselineSchema)),
        cliPreparation: v.optional(v.nullable(ExecutorPreparationSchema)),
    }),
    // The locked snapshot is correlated against its own descriptor rather than against any
    // particular executor name: the run's executor set is an input, so no executor kind may be
    // spelled here. Preparable executors carry the additional preparation correlations that
    // non-preparable executors must not.
    v.check((snapshot) => {
        if (snapshot.selectedKind === EnvironmentSelectionReservedCase.UnsupportedProductCase) {
            return (
                snapshot.state === EnvironmentSelectionState.Unsupported &&
                snapshot.descriptor === null &&
                snapshot.actual === null &&
                snapshot.filterBaseline == null
            );
        }
        if (
            snapshot.descriptor === null ||
            snapshot.descriptor.kind !== snapshot.selectedKind ||
            (snapshot.actual !== null && snapshot.actual.kind !== snapshot.selectedKind) ||
            !snapshot.capabilityLimits.every((limit) => limit.kind === snapshot.selectedKind)
        ) {
            return false;
        }
        if (snapshot.descriptor.preparationState !== EnvironmentPreparationState.Preparable) {
            return snapshot.cliPreparation == null;
        }
        if (snapshot.filterBaseline?.status === FilterBaselineStatus.NotExecutable) {
            return (
                snapshot.state === EnvironmentSelectionState.CapabilityLimited &&
                snapshot.cliPreparation == null &&
                snapshot.actual === null
            );
        }
        if (snapshot.state === EnvironmentSelectionState.Preparing) {
            return snapshot.cliPreparation === null;
        }
        if (snapshot.cliPreparation?.state === ExecutorPreparationState.Limited) {
            return (
                snapshot.state === EnvironmentSelectionState.CapabilityLimited &&
                snapshot.actual === null
            );
        }
        if (snapshot.cliPreparation?.state === ExecutorPreparationState.Ready) {
            return (
                (snapshot.state === EnvironmentSelectionState.Ready ||
                    snapshot.state === EnvironmentSelectionState.CapabilityLimited) &&
                snapshot.actual !== null &&
                // The actual context is bound from the same prepared provenance, so the version
                // it claims must equal the provenance version byte for byte.
                snapshot.actual.productVersion === snapshot.cliPreparation.provenance.version
            );
        }
        return false;
    }, 'Selection provenance must remain bound to the locked environment.'),
    v.check(
        (snapshot) =>
            snapshot.state !== EnvironmentSelectionState.Ready ||
            snapshot.filterBaseline?.status === FilterBaselineStatus.Executable ||
            snapshot.filterBaseline?.status === FilterBaselineStatus.Declared,
        'A ready environment requires an executable official or declared filter baseline.',
    ),
);

/**
 * Typed model request that chooses one environment.
 */
export type AgentEnvironmentSelectionRequest = v.InferOutput<
    typeof AgentEnvironmentSelectionRequestSchema
>;

/**
 * Host-bound actual execution context for the locked filtering environment.
 */
export type ActualExecutionContextInput = v.InferOutput<typeof ActualExecutionContextInputSchema>;

/**
 * Host-authored capability limitation recorded after selection.
 */
export type CapabilityLimitInput = v.InferOutput<typeof CapabilityLimitInputSchema>;

/**
 * Durable audit snapshot of the one locked environment decision.
 */
export type EnvironmentSelectionSnapshot = v.InferOutput<typeof EnvironmentSelectionSnapshotSchema>;

/**
 * Accepted selection response returned to the model.
 */
export interface AcceptedEnvironmentSelectionResponse {
    /**
     * Indicates that this request locked the host.
     */
    accepted: true;

    /**
     * Environment kind locked by this request.
     */
    kind: EnvironmentSelectionKind;

    /**
     * Indicates that later selection requests will be rejected.
     */
    locked: true;

    /**
     * Readiness state derived from immutable host capability data.
     */
    state: EnvironmentSelectionSnapshot['state'];

    /**
     * Stable host limitation code, when the choice cannot execute.
     */
    limitationCode: EnvironmentLimitationCode | null;

    /**
     * Official identities the reported selection resolved to, the selection the run's own
     * instruction declared, or the finite reason the reported selection resolved to none. Null only
     * for an unsupported product case, which reproduces no filtering at all.
     */
    filterBaseline: SelectionFilterBaseline | null;
}

/**
 * Rejected selection response returned for invalid input or a locked host.
 */
export interface RejectedEnvironmentSelectionResponse {
    /**
     * Indicates that the request did not change the locked selection.
     */
    accepted: false;

    /**
     * Stable reason for rejecting the request.
     */
    errorKind: EnvironmentSelectionRejectionReason;

    /**
     * Existing locked environment when one has already been chosen.
     */
    selectedKind?: EnvironmentSelectionKind;

    /**
     * Bounded validation explanation for malformed model input.
     */
    error?: string;
}

/**
 * Public response from the model-facing environment selection boundary.
 */
export type EnvironmentSelectionResponse =
    | AcceptedEnvironmentSelectionResponse
    | RejectedEnvironmentSelectionResponse;

/**
 * Response from the observed-intent refinement boundary.
 */
export interface IntentUpdateResponse {
    /**
     * Whether the assessment replaced the current observed intent.
     */
    accepted: boolean;

    /**
     * Locked environment retained by the update.
     */
    selectedKind?: EnvironmentSelectionKind;

    /**
     * Stable rejection reason when selection or input is missing.
     */
    errorKind?: IntentUpdateRejectionReason;

    /**
     * Bounded validation detail for invalid model input.
     */
    error?: string;
}

/**
 * Deterministic dependencies for the selection host.
 */
export interface EnvironmentSelectionHostOptions {
    /**
     * Clock used for lock and rejected-request audit timestamps.
     */
    now?: () => string;

    /**
     * The executable baseline the run supplies instead of resolving the reported names against
     * AdGuard's official catalog.
     *
     * A run whose blocker declares its own list selection resolves nothing — the declaration is the
     * baseline, and the reporter's names are only compared against it. When the run supplies none,
     * the reported selection is resolved against the official catalog.
     */
    filterBaseline?: SelectionFilterBaseline;
}
