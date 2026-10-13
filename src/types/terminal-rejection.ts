/**
 * Retryable typed rejection returned by a caller-owned terminal evidence check.
 *
 * Owning module: the fix-session terminal host adapter and the pi session runner's rejection cap. A
 * returned object, never thrown — producers build object literals and consumers only read and
 * format them.
 */
export type FinishFixValidationRejection = {
    /**
     * Model-facing explanation of the missing terminal prerequisite.
     */
    error: string;

    /**
     * Stable machine-readable rejection category.
     */
    errorKind: string;

    /**
     * Whether the same loop may gather more evidence and call finish_fix again.
     */
    retryable: boolean;
} & Record<string, unknown>;
