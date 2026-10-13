/**
 * The guards that stop one agent session run from outside pi's loop: the wall-clock budget, the
 * iteration backstop, the per-request provider deadline and caller cancellation. Split out of
 * `session-runner.ts`, which keeps session construction and the run itself; the runner is this
 * module's only caller. Sealing belongs to `run-sealing.ts` — it classifies every cause recorded
 * here, so a tripped guard produces its typed outcome in one place.
 */
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { Logger } from '../logger/logger';
import { GuardCause, type RunBudgets, type RunGuards } from './guard-types';

/**
 * What one run's guards need beyond the session they watch.
 */
export interface RunGuardOptions {
    /**
     * The operational bounds to enforce.
     */
    budgets: RunBudgets;

    /**
     * Optional caller cancellation. The runner guarantees it is not already aborted when guards
     * attach (it seals a pre-aborted signal without building a session at all).
     */
    signal?: AbortSignal;

    /**
     * Steering message queued once, `WRAP_UP_RESERVE_MS` before the wall-clock budget expires.
     */
    wrapUp?: string;

    /**
     * Diagnostics sink. A guard that trips and then fails to stop the run is the one failure this
     * layer cannot recover from — the run keeps issuing paid requests — so it is logged loudly.
     */
    logger: Logger;

    /**
     * Invoked exactly once, when the first guard trips. The runner uses it to turn pi's compaction
     * off: a run being stopped must not pay for a summarization on its way out.
     */
    onFired: () => void;
}

/**
 * How long before the wall-clock budget expires the wrap-up message is queued.
 *
 * Steering reaches the model only after the current turn's tool calls finish, and a reasoning turn
 * that submits a decision can itself take minutes. Without a reserve a long run can spend its whole
 * 60-minute budget and end with no decision and no report; ten minutes leaves room for one slow
 * tool call and the decision turn after it. A budget shorter than twice this reserve gets no
 * wrap-up: most of such a run would be spent wrapping up.
 */
export const WRAP_UP_RESERVE_MS = 10 * 60_000;

/**
 * Attach the run guards to a session, before prompting: the wall-clock budget, the iteration
 * backstop, the per-request provider deadline, and caller cancellation of one agent session. Guards
 * watch the session from outside the pi agent loop and abort it when their bound trips; the session
 * runner reads the recorded cause to seal the run with the matching typed outcome. Guards never
 * change the advertised tool list or any prompt; beyond stopping the run, the only thing they add
 * is the one wrap-up message queued shortly before the wall-clock budget expires.
 *
 * The per-request deadline is an INACTIVITY deadline over exactly the half of `requestTimeoutMs` pi
 * leaves unenforced. It is armed on the assistant's `message_start`, which pi emits once the
 * provider response resolves and the stream opens, RE-ARMED on every `message_update`, which pi
 * emits for each streamed delta of that message, and disarmed on its `message_end`, which pi emits
 * when the stream ends and BEFORE the turn's tool calls run. So it starts precisely where the
 * OpenAI SDK's own `timeout` stops — the SDK clears that timer as soon as the headers arrive — and
 * it bounds SILENCE inside one streamed response, never that response's total length and never a
 * legitimately long tool execution. A provider that never answers at all is still the SDK's timeout
 * and still seals as a provider failure.
 *
 * Measuring total length rather than liveness would kill healthy runs: a reasoning model streaming
 * its thinking for longer than `requestTimeoutMs` would trip the timer that exists for a wedged
 * provider and seal `request-deadline` with tokens still arriving, for instance right after a turn
 * whose completion was 10,554 tokens. A run's total duration is already bounded by the wall-clock
 * budget, so the only thing left for this timer to detect is a stream that has stopped producing.
 *
 * Determinism note: pi awaits every event listener between turns and `abort()` flips the run signal
 * synchronously, so a guard tripping on `turn_end` stops the run before the next provider request
 * starts; a guard tripping mid-request cancels that request instead.
 *
 * @param session - The pi agent session to watch.
 * @param options - Bounds, caller cancellation, the wrap-up message, diagnostics sink, and the
 *   first-trip callback.
 * @returns The guard handle the runner seals from.
 */
export function attachRunGuards(session: AgentSession, options: RunGuardOptions): RunGuards {
    const { budgets, signal, logger } = options;
    let cause: GuardCause | undefined;
    let turns = 0;
    let requestTimer: NodeJS.Timeout | undefined;
    const clearRequestTimer = (): void => {
        if (requestTimer !== undefined) {
            clearTimeout(requestTimer);
            requestTimer = undefined;
        }
    };
    const fire = (next: GuardCause): void => {
        if (cause !== undefined) {
            return;
        }
        cause = next;
        clearRequestTimer();
        // Without this line the moment a bound trips is invisible in a run log, and a long run has
        // to be reconstructed from the timestamps around it to tell when its wall clock expired.
        logger.warn(
            {
                guard: next,
                turns,
                wallClockMs: budgets.wallClockMs,
                maxTurns: budgets.maxTurns,
                requestTimeoutMs: budgets.requestTimeoutMs,
            },
            'run guard tripped; aborting the session',
        );
        options.onFired();
        // Fire-and-forget: abort() flips the agent signal synchronously and then waits for the
        // run to settle, which can only happen after this listener returns — awaiting abort()
        // here would deadlock the loop's awaited listener chain.
        void session.abort().catch((error: unknown) => {
            // The bound tripped and the run did not stop: it keeps issuing paid provider requests
            // until pi ends on its own, and this line is the only record of why the guard failed.
            logger.warn(
                { err: error, guard: next },
                'pi session abort after a guard tripped failed',
            );
        });
    };
    // Restart the inactivity window. Called on the stream's opening event and again on every delta,
    // so the deadline always measures the gap since the last sign of life rather than the response's
    // total length.
    const armRequestTimer = (): void => {
        clearRequestTimer();
        requestTimer = setTimeout(() => fire(GuardCause.RequestDeadline), budgets.requestTimeoutMs);
        requestTimer.unref();
    };
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        if (event.type === 'message_start' || event.type === 'message_update') {
            if (event.message.role === 'assistant') {
                armRequestTimer();
            }
            return;
        }
        if (event.type === 'message_end') {
            if (event.message.role === 'assistant') {
                clearRequestTimer();
            }
            return;
        }
        if (event.type !== 'turn_end') {
            return;
        }
        turns += 1;
        if (budgets.maxTurns !== undefined && turns >= budgets.maxTurns) {
            fire(GuardCause.Turns);
        }
    });
    const timer =
        budgets.wallClockMs === undefined
            ? undefined
            : setTimeout(() => fire(GuardCause.WallClock), budgets.wallClockMs);
    timer?.unref();
    const wrapUpTimer =
        options.wrapUp === undefined ||
        budgets.wallClockMs === undefined ||
        budgets.wallClockMs < 2 * WRAP_UP_RESERVE_MS
            ? undefined
            : setTimeout(() => {
                  if (cause !== undefined) {
                      return;
                  }
                  logger.info(
                      { turns, wallClockMs: budgets.wallClockMs, reserveMs: WRAP_UP_RESERVE_MS },
                      'wall-clock budget nearly spent; asking the model for its decision',
                  );
                  session.steer(options.wrapUp!).catch((error: unknown) => {
                      logger.warn({ err: error }, 'queueing the wrap-up message failed');
                  });
              }, budgets.wallClockMs - WRAP_UP_RESERVE_MS);
    wrapUpTimer?.unref();
    const onCallerAbort = (): void => fire(GuardCause.Caller);
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    return {
        cause: () => cause,
        dispose: () => {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
            if (wrapUpTimer !== undefined) {
                clearTimeout(wrapUpTimer);
            }
            clearRequestTimer();
            unsubscribe();
            signal?.removeEventListener('abort', onCallerAbort);
        },
    };
}
