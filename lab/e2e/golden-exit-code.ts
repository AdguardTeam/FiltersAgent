/**
 * Exit codes shared by manual golden case, suite and independent oracle commands.
 */
export const GoldenE2EExitCode = {
    /**
     * Every selected case passed or its human fix remains alive.
     */
    Pass: 0,
    /**
     * A verified human fix exposes an agent regression.
     */
    AgentRegression: 1,
    /**
     * No candidate human fix still resolves the live defect.
     */
    EnvironmentDrift: 2,
    /**
     * Infrastructure prevented a conclusive evaluation.
     */
    InfrastructureFailure: 3,
} as const;

/**
 * Command-line classification shared by all golden evaluation modes.
 */
export type GoldenE2EExitCode = (typeof GoldenE2EExitCode)[keyof typeof GoldenE2EExitCode];
