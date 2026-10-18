/**
 * Exit codes of the manual golden benchmark command.
 */
export const GoldenE2EExitCode = {
    /**
     * Every selected case produced an agent outcome, whatever the agent reached.
     */
    Completed: 0,
    /**
     * A case produced no agent outcome — an infrastructure failure or an unreachable site — or the
     * command failed.
     */
    Incomplete: 3,
} as const;

/**
 * Command-line classification of a benchmark invocation.
 */
export type GoldenE2EExitCode = (typeof GoldenE2EExitCode)[keyof typeof GoldenE2EExitCode];
