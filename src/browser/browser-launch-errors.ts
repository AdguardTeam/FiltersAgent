/**
 * Closest known launch boundaries a browser launch failure can be attributed to.
 */
export const BrowserLaunchBoundary = {
    RuntimeOrContext: 'runtime_or_context',
    PageSetup: 'page_setup',
} as const;

/**
 * One browser launch boundary.
 */
export type BrowserLaunchBoundary =
    (typeof BrowserLaunchBoundary)[keyof typeof BrowserLaunchBoundary];

/**
 * Stable configuration-failure categories used by the core result classifier.
 */
export const SettingsFailureReason = {
    SettingsLimitsExceeded: 'settings_limits_exceeded',
    SettingsApplyFailed: 'settings_apply_failed',
} as const;

/**
 * One settings failure reason.
 */
export type SettingsFailureReason =
    (typeof SettingsFailureReason)[keyof typeof SettingsFailureReason];

/**
 * Thrown when the browser engine fails to launch (e.g., binary not found, sandbox error).
 *
 * Launch failures are not recoverable — the caller should escalate to analysis-only report.
 */
export class BrowserLaunchError extends Error {
    /**
     * The underlying error from the browser engine.
     */
    readonly cause: unknown;

    /**
     * Launch failures are not recoverable — escalate to analysis-only.
     */
    readonly recoverable = false;

    /**
     * Closest known launch boundary.
     */
    readonly boundary: BrowserLaunchBoundary;

    /**
     * @param message - Human-readable description of the failure.
     * @param cause - The underlying error from the browser engine.
     * @param boundary - Closest known launch boundary.
     */
    constructor(
        message: string,
        cause: unknown,
        boundary: BrowserLaunchBoundary = BrowserLaunchBoundary.RuntimeOrContext,
    ) {
        super(message);
        this.name = 'BrowserLaunchError';
        this.cause = cause;
        this.boundary = boundary;
    }
}

/**
 * Thrown when the reported browser-extension settings cannot be applied and verified exactly.
 */
export class BrowserConfigurationError extends Error {
    /**
     * Underlying extension or postcondition error.
     */
    readonly cause: unknown;

    /**
     * Stable configuration-failure category used by the core result classifier.
     */
    readonly reason: SettingsFailureReason;

    /**
     * @param message - Human-readable setup failure.
     * @param cause - Underlying error, when available.
     * @param reason - Stable settings failure category.
     */
    constructor(
        message: string,
        cause?: unknown,
        reason: SettingsFailureReason = SettingsFailureReason.SettingsApplyFailed,
    ) {
        super(message);
        this.name = 'BrowserConfigurationError';
        this.cause = cause;
        this.reason = reason;
    }
}
