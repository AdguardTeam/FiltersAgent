import * as v from 'valibot';

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
