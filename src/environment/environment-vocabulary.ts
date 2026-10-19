/**
 * The filtering-environment vocabulary every executor, the selection host and the run report share:
 * capabilities, preparation and availability states, limitation codes, the reserved unsupported
 * case and the selection states, with the descriptor an executor advertises.
 */
import * as v from 'valibot';
import { BoundedIdentifierSchema, ExecutorNameSchema, type ExecutorName } from './executor-name';

/**
 * Capability supported by one filtering environment.
 */
export const EnvironmentCapability = {
    /**
     * The environment can drive a controlled browser to the reported page.
     */
    BrowserNavigation: 'browser_navigation',

    /**
     * The environment can enable, disable, or otherwise steer what filtering runs.
     */
    FilteringControl: 'filtering_control',

    /**
     * Filtering is enforced by the AdGuard browser extension under test.
     */
    ExtensionFiltering: 'extension_filtering',

    /**
     * Filtering is enforced by a command-line filtering proxy instead of the extension.
     */
    CliFiltering: 'cli_filtering',

    /**
     * The environment can apply a proposed candidate rule for verification.
     */
    CandidateApplication: 'candidate_application',

    /**
     * The environment can verify the published filter baseline it started from.
     */
    BaselineIntegrity: 'baseline_integrity',

    /**
     * The environment can produce the three-phase A/B/C validation proof.
     */
    PhaseProof: 'phase_proof',

    /**
     * The environment can install the filtering proxy CLI.
     */
    CliInstallation: 'cli_installation',

    /**
     * The environment can activate an installed filtering proxy CLI.
     */
    CliActivation: 'cli_activation',
} as const;

/**
 * Every EnvironmentCapability value, for schemas and exhaustive listings.
 */
export const ENVIRONMENT_CAPABILITY_VALUES = Object.values(EnvironmentCapability);

export const EnvironmentCapabilitySchema = v.picklist(ENVIRONMENT_CAPABILITY_VALUES);

/**
 * Preparation model of one filtering environment descriptor: how the executor behind the descriptor
 * becomes ready, or why it cannot.
 */
export const EnvironmentPreparationState = {
    /**
     * The executor needs no preparation pass: a locked selection can execute immediately.
     */
    NotStarted: 'not_started',

    /**
     * The executor runs a preparation pass after the lock and before execution.
     */
    Preparable: 'preparable',

    /**
     * The executor adapter cannot be prepared in this delivery slice.
     */
    AdapterUnavailable: 'adapter_unavailable',
} as const;

/**
 * Every EnvironmentPreparationState value, for schemas and exhaustive listings.
 */
export const ENVIRONMENT_PREPARATION_STATE_VALUES = Object.values(EnvironmentPreparationState);

export const EnvironmentPreparationStateSchema = v.picklist(ENVIRONMENT_PREPARATION_STATE_VALUES);

/**
 * EnvironmentPreparationState value.
 */
export type EnvironmentPreparationState =
    (typeof EnvironmentPreparationState)[keyof typeof EnvironmentPreparationState];

/**
 * Whether a filtering environment adapter can currently be selected.
 */
export const FilteringEnvironmentAvailability = {
    /**
     * The adapter can be selected and prepared for this run.
     */
    Available: 'available',

    /**
     * The adapter cannot be selected in this delivery slice.
     */
    Unavailable: 'unavailable',
} as const;

/**
 * Every FilteringEnvironmentAvailability value, for schemas and exhaustive listings.
 */
export const FILTERING_ENVIRONMENT_AVAILABILITY_VALUES = Object.values(
    FilteringEnvironmentAvailability,
);

/**
 * Stable reason the locked environment selection could not fully execute.
 */
export const EnvironmentLimitationCode = {
    /**
     * The executor adapter is not available in this delivery slice. Reachable only for descriptors
     * shipped `unavailable` — the defaults carry no limitation.
     */
    ExecutorUnavailable: 'executor_unavailable',

    /**
     * The locked environment does not advertise a capability the request required.
     */
    RequiredCapabilityUnavailable: 'required_capability_unavailable',

    /**
     * Automatic executor preparation did not become ready.
     */
    EnvironmentPreparationFailed: 'environment_preparation_failed',

    /**
     * The prepared environment failed to activate for the run.
     */
    EnvironmentActivationFailed: 'environment_activation_failed',

    /**
     * The reported filter selection resolved to no executable official filter baseline.
     */
    FilterSelectionNotExecutable: 'filter_selection_not_executable',
} as const;

/**
 * Every EnvironmentLimitationCode value, for schemas and exhaustive listings.
 */
export const ENVIRONMENT_LIMITATION_CODE_VALUES = Object.values(EnvironmentLimitationCode);

/**
 * Durable limitation-code acceptance: the finite codes this generation writes first, plus the
 * bounded identifier shape that admits the renamed codes persisted by pre-registry artifacts — the
 * persisted run-result read-back must keep parsing what earlier runs wrote, while fresh writes
 * always come from {@link EnvironmentLimitationCode}.
 */
export const EnvironmentLimitationCodeSchema = v.union([
    v.picklist(ENVIRONMENT_LIMITATION_CODE_VALUES),
    BoundedIdentifierSchema,
]);

/**
 * EnvironmentLimitationCode value.
 */
export type EnvironmentLimitationCode =
    (typeof EnvironmentLimitationCode)[keyof typeof EnvironmentLimitationCode];

/**
 * Reserved outcome the model may ask for instead of one executor: the run reproduces no filtering
 * at all and records the unsupported-product verdict.
 */
export const EnvironmentSelectionReservedCase = {
    /**
     * The agent declares the reported product unsupported, locking no environment.
     */
    UnsupportedProductCase: 'unsupported_product_case',
} as const;

/**
 * EnvironmentSelectionReservedCase value.
 */
export type EnvironmentSelectionReservedCase =
    (typeof EnvironmentSelectionReservedCase)[keyof typeof EnvironmentSelectionReservedCase];

/**
 * EnvironmentSelectionKind schema: the reserved unsupported-product case, or an executor name. The
 * kind stays open because the executor set is a run input, not a closed list; the reserved case
 * keeps its own literal inside the same schema.
 */
export const EnvironmentSelectionKindSchema = v.union([
    v.literal(EnvironmentSelectionReservedCase.UnsupportedProductCase),
    ExecutorNameSchema,
]);

/**
 * EnvironmentSelectionKind value: the reserved unsupported-product case, or an executor name.
 */
export type EnvironmentSelectionKind =
    | (typeof EnvironmentSelectionReservedCase)[keyof typeof EnvironmentSelectionReservedCase]
    | ExecutorName;

/**
 * Readiness state of the one locked environment selection.
 */
export const EnvironmentSelectionState = {
    /**
     * The preparable executor was selected but its preparation has not finished yet.
     */
    Preparing: 'preparing',

    /**
     * The locked environment can execute: it advertises every required capability, or a prepared
     * executor lacks only what its evidence route grants on the first session.
     */
    Ready: 'ready',

    /**
     * The locked environment is missing a required capability or cannot fully execute.
     */
    CapabilityLimited: 'capability_limited',

    /**
     * The agent declared the reported product unsupported; no environment is locked.
     */
    Unsupported: 'unsupported',
} as const;

/**
 * Every EnvironmentSelectionState value, for schemas and exhaustive listings.
 */
export const ENVIRONMENT_SELECTION_STATE_VALUES = Object.values(EnvironmentSelectionState);

export const EnvironmentSelectionStateSchema = v.picklist(ENVIRONMENT_SELECTION_STATE_VALUES);

/**
 * EnvironmentSelectionState value.
 */
export type EnvironmentSelectionState =
    (typeof EnvironmentSelectionState)[keyof typeof EnvironmentSelectionState];

/**
 * The decision an investigation asks its canonical environment execution to back.
 */
export const EnvironmentDispositionStatus = {
    /**
     * The controlled experiment verified the candidate.
     */
    Verified: 'verified',

    /**
     * The investigation rejected the candidate it ran.
     */
    Rejected: 'rejected',

    /**
     * The investigation reached no verified decision.
     */
    Inconclusive: 'inconclusive',

    /**
     * The investigation or the environment's cleanup failed.
     */
    Failed: 'failed',

    /**
     * The environment lacked a capability the investigation required.
     */
    CapabilityLimited: 'capability_limited',
} as const;

/**
 * EnvironmentDispositionStatus value.
 */
export type EnvironmentDispositionStatus =
    (typeof EnvironmentDispositionStatus)[keyof typeof EnvironmentDispositionStatus];

/**
 * Every EnvironmentDispositionStatus value, for the disposition schema.
 */
export const ENVIRONMENT_DISPOSITION_STATUS_VALUES = Object.values(EnvironmentDispositionStatus);

/**
 * FilteringEnvironmentAvailability value.
 */
export type FilteringEnvironmentAvailability =
    (typeof FilteringEnvironmentAvailability)[keyof typeof FilteringEnvironmentAvailability];

/**
 * Immutable host capability descriptor shown to the model. The `kind` is the executor name the
 * descriptor belongs to — an executor registration spells its own descriptor, so the accepted
 * identifier set is the open executor-name vocabulary rather than a closed picklist.
 */
export const FilteringEnvironmentDescriptorSchema = v.strictObject({
    kind: ExecutorNameSchema,
    availability: v.picklist(FILTERING_ENVIRONMENT_AVAILABILITY_VALUES),
    preparationState: EnvironmentPreparationStateSchema,
    limitationCode: v.nullable(EnvironmentLimitationCodeSchema),
    capabilities: v.pipe(v.array(EnvironmentCapabilitySchema), v.maxLength(16)),
    // What a preparable environment can do once the Host has prepared it. Without it the model
    // sees only the preparation capabilities and judges the environment unable to browse.
    preparedCapabilities: v.optional(v.pipe(v.array(EnvironmentCapabilitySchema), v.maxLength(16))),
});

/**
 * EnvironmentCapability value.
 */
export type EnvironmentCapability =
    (typeof EnvironmentCapability)[keyof typeof EnvironmentCapability];

/**
 * Immutable host capability descriptor shown to the model.
 */
export type FilteringEnvironmentDescriptor = v.InferOutput<
    typeof FilteringEnvironmentDescriptorSchema
>;
