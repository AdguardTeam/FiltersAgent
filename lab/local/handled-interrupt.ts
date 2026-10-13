/**
 * First owned interruption intent.
 */
/**
 * Signals that can interrupt a local run.
 */
export const InterruptSignal = {
    Sigint: 'SIGINT',
    Sigterm: 'SIGTERM',
    QueueAbort: 'queue_abort',
} as const;

/**
 * One interrupt signal.
 */
export type InterruptSignal = (typeof InterruptSignal)[keyof typeof InterruptSignal];

export interface HandledInterruptIntent {
    /**
     * Owned signal or queue-abort source.
     */
    signal: InterruptSignal;
    /**
     * Conventional signal exit code, or null for queue cancellation.
     */
    exitCode: 130 | 143 | null;
}

/**
 * Minimal process signal boundary used by production and deterministic tests.
 */
export interface HandledInterruptProcessTarget {
    /**
     * Add one owned signal listener.
     *
     * @param event - Signal name.
     * @param listener - Exact owned listener.
     * @returns Event target.
     */
    on(
        event: typeof InterruptSignal.Sigint | typeof InterruptSignal.Sigterm,
        listener: () => void,
    ): unknown;

    /**
     * Remove one exact owned signal listener.
     *
     * @param event - Signal name.
     * @param listener - Exact owned listener.
     * @returns Event target.
     */
    removeListener(
        event: typeof InterruptSignal.Sigint | typeof InterruptSignal.Sigterm,
        listener: () => void,
    ): unknown;
}

/**
 * Construction options for one disposable interruption scope.
 */
export interface HandledInterruptScopeOptions {
    /**
     * Optional queue lease-loss signal.
     */
    queueSignal?: AbortSignal;
    /**
     * Injectable process-like signal target.
     */
    processTarget?: HandledInterruptProcessTarget;
}

/**
 * Disposable merged cancellation and exit-intent scope.
 */
export interface HandledInterruptScope {
    /**
     * Merged first-wins cancellation signal.
     */
    signal: AbortSignal;
    /**
     * Read the first interruption intent.
     *
     * @returns First intent or null before cancellation.
     */
    intent(): HandledInterruptIntent | null;
    /**
     * Remove only listeners owned by this scope.
     */
    dispose(): void;
}

/**
 * Create a first-wins merged signal scope with exact listener ownership.
 *
 * @param options - Optional queue signal and process seam.
 * @returns Disposable interruption scope.
 */
export function createHandledInterruptScope(
    options: HandledInterruptScopeOptions = {},
): HandledInterruptScope {
    const processTarget = options.processTarget ?? (process as HandledInterruptProcessTarget);
    const controller = new AbortController();
    let first: HandledInterruptIntent | null = null;
    let disposed = false;

    /**
     * Record only the first interruption and abort merged work.
     *
     * @param intent - Candidate interruption intent.
     */
    const interrupt = (intent: HandledInterruptIntent): void => {
        if (first) {
            return;
        }
        first = Object.freeze(intent);
        controller.abort(intent.signal);
    };
    const onSigint = (): void => interrupt({ signal: InterruptSignal.Sigint, exitCode: 130 });
    const onSigterm = (): void => interrupt({ signal: InterruptSignal.Sigterm, exitCode: 143 });
    const onQueueAbort = (): void =>
        interrupt({ signal: InterruptSignal.QueueAbort, exitCode: null });

    processTarget.on(InterruptSignal.Sigint, onSigint);
    processTarget.on(InterruptSignal.Sigterm, onSigterm);
    options.queueSignal?.addEventListener('abort', onQueueAbort, { once: true });
    if (options.queueSignal?.aborted) {
        onQueueAbort();
    }

    return Object.freeze({
        signal: controller.signal,
        intent: () => first,
        dispose: () => {
            if (disposed) {
                return;
            }
            disposed = true;
            processTarget.removeListener(InterruptSignal.Sigint, onSigint);
            processTarget.removeListener(InterruptSignal.Sigterm, onSigterm);
            options.queueSignal?.removeEventListener('abort', onQueueAbort);
        },
    });
}
