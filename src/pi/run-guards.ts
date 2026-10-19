/**
 * The guards that stop one agent session run from outside pi's loop: the wall-clock budget, the
 * iteration backstop and caller cancellation. A silent provider response is not theirs to stop: it
 * fails that one request, bounded where the request streams (`stream-silence.ts`), and pi retries
 * it. Split out of `session-runner.ts`, which keeps session construction and the run itself; the
 * runner is this module's only caller. Sealing belongs to `run-sealing.ts` — it classifies every
 * cause recorded here, so a tripped guard produces its typed outcome in one place.
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
 * backstop, and caller cancellation of one agent session. Guards watch the session from outside the
 * pi agent loop and abort it when their bound trips; the session runner reads the recorded cause to
 * seal the run with the matching typed outcome. Guards never change the advertised tool list or any
 * prompt; beyond stopping the run, the only thing they add is the one wrap-up message queued
 * shortly before the wall-clock budget expires.
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
    const fire = (next: GuardCause): void => {
        if (cause !== undefined) {
            return;
        }
        cause = next;
        // Without this line the moment a bound trips is invisible in a run log, and a long run has
        // to be reconstructed from the timestamps around it to tell when its wall clock expired.
        logger.warn(
            {
                guard: next,
                turns,
                wallClockMs: budgets.wallClockMs,
                maxTurns: budgets.maxTurns,
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
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
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
            unsubscribe();
            signal?.removeEventListener('abort', onCallerAbort);
        },
    };
}
