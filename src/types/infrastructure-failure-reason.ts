/**
 * Which of our own boundaries failed before the investigation could conclude.
 *
 * Every member is a wire value persisted in run results. A retry scheduler reads it: most members
 * describe outages that earn the bounded retry budget, while the deterministic members are terminal
 * — keep that distinction when adding a member.
 */
export const InfrastructureFailureReason = {
    /**
     * The issue snapshot or report bundle could not be read.
     */
    InputUnavailable: 'input_unavailable',

    /**
     * The locked execution environment could not be prepared.
     */
    EnvironmentUnavailable: 'environment_unavailable',

    /**
     * The browser stack failed before the target was exercised.
     */
    BrowserUnavailable: 'browser_unavailable',

    /**
     * The reasoning provider was unreachable or failed transiently.
     */
    LlmUnavailable: 'llm_unavailable',

    /**
     * The reasoning provider deterministically rejected the pinned request; retries meet the
     * identical rejection and are never paid for.
     */
    LlmRejected: 'llm_rejected',

    /**
     * The vision provider was unreachable or failed transiently.
     */
    VisionProviderUnavailable: 'vision_provider_unavailable',

    /**
     * The investigation ran but its result could not be persisted or validated.
     */
    OutputUnavailable: 'output_unavailable',

    /**
     * The run instruction declares a file-backed state-verification method (`user-rules-file` or
     * `managed-storage-file`); no session in this run writes the file the host would read back, and
     * nothing tells one where the run's host-state directory is, so the run can never verify a
     * phase this way. Deterministic and terminal: retrying meets the identical instruction and is
     * never paid for.
     */
    FileBackedApplicationUnsupported: 'file_backed_application_unsupported',
} as const;

/**
 * Every InfrastructureFailureReason value, for schemas and exhaustive listings.
 */
export const INFRASTRUCTURE_FAILURE_REASON_VALUES = Object.values(InfrastructureFailureReason);

/**
 * InfrastructureFailureReason value.
 */
export type InfrastructureFailureReason =
    (typeof InfrastructureFailureReason)[keyof typeof InfrastructureFailureReason];
