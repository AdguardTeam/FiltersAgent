/**
 * How one host-performed application step is timed, logged and recorded.
 *
 * A host-performed application (the built-in AdGuard route, the file-backed one) has no model tool
 * trace to assemble its action log from, so it records its own: one `ActionLogEntry` per step of
 * the procedure, with a bounded summary of what that step did. This module owns that recording so
 * the protocol modules stay about their protocol: it checks the caller's cancellation before each
 * step, times it, logs it at info with its duration, and on a throw logs the caught error whole —
 * message, stack and cause — before reducing it to the one-line reason the phase record carries.
 */
import {
    PROOF_ACTION_LOG_SUMMARY_MAX,
    type ActionLogEntry,
} from '../environment/environment-proofs';
import type { HostApplicationStep } from '../environment/host-application-step';
import type { Logger } from '../logger/logger';

/**
 * One host application step that did not complete, naming the step in its own message.
 *
 * The message is the bounded detail the runner reports, so the step name a run log shows and the
 * step name the phase record names are one string built in one place.
 */
export class HostApplicationStepFailure extends Error {
    /**
     * The step that did not complete.
     */
    readonly step: HostApplicationStep;

    /**
     * @param step - The step that did not complete.
     * @param reason - Why it did not, already reduced to one line.
     * @param cause - The caught error, when one was caught, kept for the run log's stack.
     */
    constructor(step: HostApplicationStep, reason: string, cause?: unknown) {
        super(
            `The host application step "${step}" did not complete: ${reason}`,
            cause === undefined ? undefined : { cause },
        );
        this.name = 'HostApplicationStepFailure';
        this.step = step;
    }
}

/**
 * What one recorded step contributes to the action log.
 */
export interface HostApplicationStepRecord {
    /**
     * Whether the step did what it was asked to. A false record leaves the application incomplete
     * without throwing: the state the steps left behind is still read back and credited.
     */
    ok: boolean;

    /**
     * One-line summary of what the step did, bounded before it reaches the proof.
     */
    summary: string;
}

/**
 * Perform one recorded application step: abort check, timing, action-log entry, failure diagnostic.
 */
export type HostApplicationStepPerformer = <T>(
    step: HostApplicationStep,
    perform: () => Promise<T>,
    describe: (value: T) => HostApplicationStepRecord,
) => Promise<T>;

/**
 * Reduce one caught value to a single-line reason.
 *
 * @param error - The caught value.
 * @returns Its message, or the stringified value when something other than an Error was thrown.
 */
export function failureReason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Bound one text to a maximum length without an ellipsis marker that could be read as content.
 *
 * @param text - The text to bound.
 * @param maxLength - Maximum characters kept.
 * @returns The text, or its prefix at the bound.
 */
export function boundedText(text: string, maxLength: number): string {
    return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/**
 * Build the recorded-step performer for one host-performed application.
 *
 * @param actionLog - The action log every step appends its entry to.
 * @param logger - Run logger receiving each step with its duration and each failure with its error.
 * @param signal - Caller cancellation, checked before every step.
 * @returns The step performer.
 */
export function hostApplicationStepPerformer(
    actionLog: ActionLogEntry[],
    logger: Logger,
    signal: AbortSignal | undefined,
): HostApplicationStepPerformer {
    return async <T>(
        step: HostApplicationStep,
        perform: () => Promise<T>,
        describe: (value: T) => HostApplicationStepRecord,
    ): Promise<T> => {
        const startedAt = Date.now();
        try {
            if (signal?.aborted ?? false) {
                throw new Error('the phase deadline aborted before this step could run');
            }
            const value = await perform();
            const durationMs = Date.now() - startedAt;
            const record = describe(value);
            const summary = boundedText(record.summary, PROOF_ACTION_LOG_SUMMARY_MAX);
            if (record.ok) {
                logger.info(
                    { step, durationMs, summary },
                    'the host performed an application step',
                );
            } else {
                logger.warn(
                    { step, durationMs, summary },
                    'the host application step did not do what it was asked to',
                );
            }
            actionLog.push({ tool: step, ok: record.ok, summary });
            return value;
        } catch (error) {
            const durationMs = Date.now() - startedAt;
            // The caught error goes to the log whole — message, stack and cause — before it is
            // reduced to the one-line reason the phase record carries.
            logger.error({ err: error, step, durationMs }, 'the host application step failed');
            actionLog.push({
                tool: step,
                ok: false,
                summary: boundedText(
                    `failed after ${durationMs}ms: ${failureReason(error)}`,
                    PROOF_ACTION_LOG_SUMMARY_MAX,
                ),
            });
            throw new HostApplicationStepFailure(step, failureReason(error), error);
        }
    };
}
