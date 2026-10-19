/**
 * Why the agent loop ended without an accepted model decision.
 *
 * Every member is a wire value persisted in run results and read back by whatever schedules
 * retries: it decides from it whether another paid attempt can change anything, so a new member
 * must be classified there before it ships.
 */
export const AgentTerminationReason = {
    /**
     * A provider request failed after its bounded transport retries — an outage, not a verdict.
     */
    LlmError: 'llm_error',

    /**
     * The provider deterministically rejected this exact request (invalid, unroutable, or
     * oversized) or refused its content. The prompt is pinned by digest, so a retry meets the
     * identical rejection.
     */
    LlmRejected: 'llm_rejected',

    /**
     * The model kept answering prose instead of calling finish_fix within the bounded reminder.
     */
    TerminalNotCalled: 'terminal_not_called',

    /**
     * One tool exhausted its failure budget without a successful call.
     */
    RetryBudgetExhausted: 'retry_budget_exhausted',

    /**
     * The loop reached its iteration backstop without a terminal decision.
     */
    MaxIterationsExceeded: 'max_iterations_exceeded',

    /**
     * The investigation's wall-clock budget expired before a terminal decision.
     */
    WallClockExceeded: 'wall_clock_exceeded',

    /**
     * The Host abort signal fired before the next paid operation.
     */
    Interrupted: 'interrupted',

    /**
     * The Host's haltAfterTool hook ended the loop after a tool call.
     */
    HaltedByCaller: 'halted_by_caller',

    /**
     * The prepared CLI capability could not be transferred to the evidence route.
     */
    CliInstallationCapabilityUnavailable: 'cli_installation_capability_unavailable',

    /**
     * The locked CLI environment selection could not be retained for the evidence route.
     */
    CliEnvironmentSelectionUnavailable: 'cli_environment_selection_unavailable',

    /**
     * Durable cleanup recovery could not be armed before continuing.
     */
    CleanupObligationUnavailable: 'cleanup_obligation_unavailable',
} as const;

/**
 * Every AgentTerminationReason value, for schemas and exhaustive listings.
 */
export const AGENT_TERMINATION_REASON_VALUES = Object.values(AgentTerminationReason);

/**
 * AgentTerminationReason value.
 */
export type AgentTerminationReason =
    (typeof AgentTerminationReason)[keyof typeof AgentTerminationReason];
