import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type {
    AssistantMessage,
    TextContent,
    ThinkingContent,
    ToolCall,
    Usage,
} from '@earendil-works/pi-ai';
import type { Logger } from '../logger/logger';
import { messageText, parseProviderFailureStatus } from './run-sealing';
import { toTurnStopReason, TurnStopReason } from './stop-reason';
import type {
    CompactionObserver,
    SessionCompactionObservation,
    SessionTurnObservation,
    TurnObserver,
} from './session-observations';
import {
    recordUsageReport,
    TelemetryObserver,
    toCompletionUsage,
    type CompletionUsage,
    type UsageReport,
} from './usage-reporting';

/**
 * Telemetry of one agent session run: the turn-end and compaction observation seams feeding trace
 * recording, the live usage accumulation both of them write into, and the once-per-run usage report
 * built from it. Split out of `session-runner.ts` so the runner keeps session construction, guards
 * and sealing; the runner is this module's only caller.
 *
 * The usage report is ACCUMULATED, never reconstructed from `session.messages`, because compaction
 * is enabled: once pi rewrites the transcript into a summary, every pre-compaction assistant
 * message is gone from session state, and a seal-time scan of it would silently under-report a
 * compacted run as a handful of unreported completions. Every provider request instead lands here
 * the moment it completes — one completion per `turn_end`, plus one per compaction for the
 * summarization call pi paid for — so a compacted run still accounts for exactly what it spent.
 *
 * Both observers are non-fatal by design — a trace or usage sink must never break a run it only
 * watches — but a swallowed failure must still leave a trace: every failure is logged with its
 * observer context through the injected logger. It does NOT change what the turn reports: a
 * trace-recording failure is not a usage failure, the provider's counts are in hand either way, and
 * `usageCompleteness: partial` means one thing only — the provider sent no usage chunk.
 */

/**
 * What one run's telemetry attachment needs.
 */
export interface SessionTelemetryOptions {
    /**
     * The pi session to observe, subscribed once for the whole run.
     */
    session: AgentSession;

    /**
     * The wall-clock run start, for the LLM-engaged duration of the usage report.
     */
    startedAtMs: number;

    /**
     * The configured model id of the run. It is the pricing attribution for every completion the
     * run reports — the turns and the compaction summarization calls alike — whenever pi's own
     * message carries no model id.
     */
    model: string;

    /**
     * Diagnostics sink for observer failures, failed turns, and the compaction log lines.
     */
    logger: Logger;

    /**
     * Optional per-turn observer invoked once per completed pi turn.
     */
    onTurnEnd?: TurnObserver;

    /**
     * Optional per-compaction observer invoked once per completed pi compaction.
     */
    onCompaction?: CompactionObserver;
}

/**
 * Handle to one run's attached telemetry.
 */
export interface SessionTelemetryHandle {
    /**
     * Detach the observation from the session.
     */
    detach: () => void;

    /**
     * Build the run's pi-free usage report from everything accumulated so far.
     *
     * @returns The usage report of the run.
     */
    usageReport: () => UsageReport;
}

/**
 * Collect the called tool names from an assistant message's content blocks.
 *
 * @param content - The pi content blocks of the turn's assistant message.
 * @returns Tool call names in call order.
 */
function extractToolCallNames(
    content: readonly (TextContent | ThinkingContent | ToolCall)[],
): string[] {
    const names: string[] = [];
    for (const block of content) {
        if (block.type === 'toolCall') {
            names.push(block.name);
        }
    }
    return names;
}

/**
 * Project one pi assistant message onto the pi-free turn observation.
 *
 * @param message - The assistant message pi just produced.
 * @param index - Zero-based turn index within the run.
 * @param usage - The turn's normalized counts, mapped once and shared with the usage report so the
 *   trace and the report can never state different things about the same completion.
 * @returns The observation handed to the run's turn observer.
 */
function toTurnObservation(
    message: AssistantMessage,
    index: number,
    usage: CompletionUsage,
): SessionTurnObservation {
    return {
        index,
        stopReason: toTurnStopReason(message.stopReason),
        // Only a failed turn carries one, and it is the sole host-visible record of an attempt
        // pi retries: pi deletes the failed message from agent state before the retry, so the
        // seal reads a transcript the failure has already been erased from.
        ...(message.errorMessage === undefined || message.errorMessage === ''
            ? {}
            : { errorMessage: message.errorMessage }),
        model: message.model,
        text: messageText(message.content),
        toolCallNames: extractToolCallNames(message.content),
        usage,
    };
}

/**
 * Deliver one turn observation and return the completion usage the run's report counts for it.
 *
 * EVERY turn counts as one attempted provider call, error and aborted turns included: their zeroed
 * usage is reported as an explicit unreported completion rather than dropped, because a dropped
 * attempt let a run of one success plus one provider failure render as `complete` usage. Model
 * attribution takes the message's own id and falls back to the CONFIGURED id when pi left it empty:
 * pricing tables are keyed by the id the run asked for (`deepseek-v4-flash`), never by a gateway's
 * echoed build name (`DeepSeek-V4-Flash-0731`), which stays on the turn observation for
 * diagnostics.
 *
 * A failing observer changes nothing about what is reported: the provider's counts are already in
 * hand, and reporting the turn as unreported would say the provider sent no usage chunk — the one
 * thing `usageCompleteness` means — because a trace recorder threw. The failure is logged instead.
 *
 * @param message - The assistant message pi just produced.
 * @param index - Zero-based turn index within the run.
 * @param model - The configured model id, used when the message carries none.
 * @param observe - The run's turn observer, when one is attached.
 * @param logger - Diagnostics sink.
 * @returns The completion usage of this turn.
 */
function observeTurnEnd(
    message: AssistantMessage,
    index: number,
    model: string,
    observe: TurnObserver | undefined,
    logger: Logger,
): CompletionUsage {
    const turnModel = message.model === '' ? model : message.model;
    // Mapped once: the observation and the run's report carry the SAME usage object.
    const usage = toCompletionUsage(turnModel, message.usage);
    const observation = toTurnObservation(message, index, usage);
    if (observation.stopReason === TurnStopReason.Error) {
        // A provider failure pi retries away leaves no other evidence: the seal only ever sees
        // the transcript pi already pruned the failed message from. The parsed status is logged
        // alongside the full message — never in place of it — so a status this turn's message
        // named is diagnosable without re-parsing this line by hand.
        logger.warn(
            {
                turnIndex: observation.index,
                stopReason: observation.stopReason,
                errorMessage: observation.errorMessage,
                ...(observation.errorMessage === undefined
                    ? {}
                    : {
                          providerFailureStatus: parseProviderFailureStatus(
                              observation.errorMessage,
                          ),
                      }),
            },
            'provider turn failed',
        );
    } else {
        // Without a line for a clean turn a run's timeline has to be inferred from the tool calls
        // around it: nothing says when the model was thinking, for how long, or what it asked for
        // next.
        logger.info(
            {
                turnIndex: observation.index,
                stopReason: observation.stopReason,
                toolCallNames: observation.toolCallNames,
                usage,
            },
            'agent turn ended',
        );
    }
    if (observe !== undefined) {
        try {
            observe(observation);
        } catch (error) {
            // A trace/usage observer failure must not poison pi's listener chain and break the
            // run; a trace gap is diagnosable, a crashed session is not. Diagnosable requires
            // evidence, so the caught error is logged — and only logged: what the provider
            // reported for this turn is unaffected by a recorder that could not write it down.
            logger.error(
                {
                    err: error,
                    observer: TelemetryObserver.TurnEnd,
                    turnIndex: observation.index,
                    stopReason: observation.stopReason,
                    toolCallNames: observation.toolCallNames,
                },
                'turn observer failed; this turn has no trace evidence',
            );
        }
    }
    return usage;
}

/**
 * Log one compaction, deliver its observation, and return the completion usage of the summarization
 * call pi paid for.
 *
 * The summarization request is a provider call the run made, so it is reported like any other
 * completion and attributed to the configured model — pi summarizes with the session's own model. A
 * compaction that reported no usage (aborted, failed, or answered by an extension) contributes
 * nothing rather than an invented zero-cost call.
 *
 * @param observation - The pi-free compaction observation.
 * @param usage - The summarization call's pi usage, when pi reported one.
 * @param model - The configured model id (the pricing attribution).
 * @param observe - The run's compaction observer, when one is attached.
 * @param logger - Diagnostics sink.
 * @returns The summarization completion usage, or `undefined` when pi reported none.
 */
function observeCompactionEnd(
    observation: SessionCompactionObservation,
    usage: Usage | undefined,
    model: string,
    observe: CompactionObserver | undefined,
    logger: Logger,
): CompletionUsage | undefined {
    logger.info(
        {
            compactionIndex: observation.index,
            reason: observation.reason,
            tokensBefore: observation.tokensBefore,
            estimatedTokensAfter: observation.estimatedTokensAfter,
            aborted: observation.aborted,
            willRetry: observation.willRetry,
            errorMessage: observation.errorMessage,
        },
        'pi finished compacting the run context',
    );
    if (observe !== undefined) {
        try {
            observe(observation);
        } catch (error) {
            logger.error(
                {
                    err: error,
                    observer: TelemetryObserver.Compaction,
                    compactionIndex: observation.index,
                    reason: observation.reason,
                },
                'compaction observer failed; this compaction has no trace evidence',
            );
        }
    }
    return usage === undefined ? undefined : toCompletionUsage(model, usage);
}

/**
 * Attach one run's telemetry to a pi session: turn observation, compaction observation, and the
 * usage accumulation the run's report is built from.
 *
 * One turn observation is produced per provider request, including error and aborted turns —
 * matching pi's one-turn-per-request semantics — and one compaction observation per completed pi
 * compaction, whether it rewrote the history or failed trying.
 *
 * @param options - The session, run start, configured model, logger, and optional observers.
 * @returns The handle detaching the observation and reporting what it accumulated.
 */
export function attachSessionTelemetry(options: SessionTelemetryOptions): SessionTelemetryHandle {
    const { logger, model } = options;
    const completions: CompletionUsage[] = [];
    let turns = 0;
    let compactions = 0;
    const detach = options.session.subscribe((event) => {
        if (event.type === 'turn_end') {
            // turn_end always carries the assistant message pi just produced; pi's own type is
            // authoritative inside the layer.
            const message = event.message as AssistantMessage;
            completions.push(observeTurnEnd(message, turns, model, options.onTurnEnd, logger));
            turns += 1;
            return;
        }
        if (event.type === 'compaction_start') {
            logger.info(
                { compactionIndex: compactions, reason: event.reason },
                'pi started compacting the run context',
            );
            return;
        }
        if (event.type !== 'compaction_end') {
            return;
        }
        const result = event.result;
        const usage = observeCompactionEnd(
            {
                index: compactions,
                reason: event.reason,
                aborted: event.aborted,
                willRetry: event.willRetry,
                ...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
                ...(result === undefined
                    ? {}
                    : {
                          summary: result.summary,
                          tokensBefore: result.tokensBefore,
                          ...(result.estimatedTokensAfter === undefined
                              ? {}
                              : { estimatedTokensAfter: result.estimatedTokensAfter }),
                      }),
            },
            result?.usage,
            model,
            options.onCompaction,
            logger,
        );
        compactions += 1;
        if (usage !== undefined) {
            completions.push(usage);
        }
    });
    return {
        detach,
        usageReport: (): UsageReport => ({
            completions: [...completions],
            durationMs: Math.max(0, Math.round(Date.now() - options.startedAtMs)),
        }),
    };
}

/**
 * Deliver one usage report to the run's usage observer.
 *
 * @param reporter - The observer, when configured.
 * @param report - The pi-free usage report for the run.
 * @param logger - Diagnostics sink for observer failures.
 */
export function emitSessionUsage(
    reporter: ((report: UsageReport) => void) | undefined,
    report: UsageReport,
    logger: Logger,
): void {
    if (!reporter) {
        return;
    }
    recordUsageReport(reporter, report, TelemetryObserver.SessionUsage, logger);
}
