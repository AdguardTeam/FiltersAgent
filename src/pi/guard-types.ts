/**
 * The run-guard vocabulary: why a guard stopped a session, the operational bounds it enforces, and
 * the handle the runner reads the recorded cause from. A leaf module of its own rather than a
 * section of `types.ts`, because the seal vocabulary in `types.ts` names one of these causes
 * (`BudgetExceededSealed.budget`) while `run-guards.ts` implements them — so a shared leaf is the
 * only arrangement in which neither of those two modules has to import the other.
 */

/**
 * Why a guard aborted the session.
 */
export const GuardCause = {
    /**
     * The wall-clock investigation budget expired.
     */
    WallClock: 'wall-clock',

    /**
     * The iteration backstop caught a runaway tool loop.
     */
    Turns: 'turns',

    /**
     * The caller aborted the run through its abort signal.
     */
    Caller: 'caller',
} as const;

/**
 * GuardCause value.
 */
export type GuardCause = (typeof GuardCause)[keyof typeof GuardCause];

/**
 * Operational bounds of one agent session run.
 */
export interface RunBudgets {
    /**
     * Wall-clock budget in milliseconds, measured from guard attachment (run start). On expiry the
     * session is aborted and the run seals budget-exceeded.
     */
    wallClockMs?: number;

    /**
     * Iteration backstop: the session is aborted once this many turns have completed, bounding
     * runaway tool loops. pi emits one turn per provider request, so this also bounds provider
     * calls per run.
     */
    maxTurns?: number;

    /**
     * Per-request provider deadline in milliseconds, applied to silence rather than to elapsed
     * time. It is enforced in two halves, because neither half covers a whole request on its own:
     *
     * - Up to the response headers by pi's `retry.provider.timeoutMs` setting, which becomes the
     *   selected provider SDK's request timeout on OpenAI or Anthropic. A provider that never
     *   answers fails here, as a timeout error pi's auto-retry treats as transient.
     * - From there to the end of the assistant message by the silence bound every provider
     *   registration streams through (`stream-silence.ts`), which restarts on every streamed event
     *   and reads the same value from the request. A provider that stopped producing fails that one
     *   request with a timeout error, which pi retries the same way.
     *
     * This bounds a gap between events, never a response's total length: a reasoning model that
     * streams its thinking for many minutes is alive, and the run's total duration is bounded by
     * `wallClockMs` instead. Once the retries are spent the run seals `provider-failure`.
     *
     * Required: the deadline is a configuration field (`llm.requestTimeoutMs`, defaulted once at
     * the env boundary), so every run is bounded and no caller can leave a stalled response
     * unguarded.
     */
    requestTimeoutMs: number;
}

/**
 * Handle to the guards attached to one session.
 */
export interface RunGuards {
    /**
     * Why the guards aborted the session (the first cause to trip wins).
     *
     * @returns The recorded cause, or `undefined` while no guard has tripped.
     */
    cause: () => GuardCause | undefined;

    /**
     * Detach every listener and clear the guard timers.
     */
    dispose: () => void;
}
