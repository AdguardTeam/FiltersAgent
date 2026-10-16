/**
 * Session trace recording for pi session modes: map each pi seal kind onto the trace outcome
 * vocabulary (shared by analyze, observe, and replay), record the run_sealed decision event, and
 * end the run trace — plus the per-execution, per-bounce, per-turn and per-compaction recording
 * wrappers every mode wiring shares (tool execution, terminal submission, calls pi refused before
 * execution, llm_request/llm_response pairs, and pi's context rewrites with the summaries they left
 * behind). Kept out of the pi layer because these are tracer concerns: they own no run behavior,
 * only what lands in the run trace.
 */
import type { TraceRecorder } from './trace-recorder';
import { TraceEventType, type RunTrace } from '../types/trace';
import { AgentTerminationReason } from '../types/agent-termination-reason';
import { SealKind } from '../pi/seal-types';
import { GuardCause } from '../pi/guard-types';
import type {
    BudgetExceededSealed,
    NonTerminalSeal,
    RejectionCap,
    TerminalOutcome,
} from '../pi/seal-types';
import type {
    CompactionObserver,
    SessionCompactionObservation,
    SessionToolBounceObservation,
    SessionTurnObservation,
    ToolBounceObserver,
    TurnObserver,
} from '../pi/session-observations';
import type { SessionToolResult, SessionToolSpec } from '../pi/session-tool-types';
import type { TerminalToolController } from '../pi/terminal-tool';

/**
 * Trace outcome for a terminally sealed run — the exact string every mode writes on normal
 * completion.
 */
export const TRACE_OUTCOME_SUCCESS = 'analysis_complete';

/**
 * `phase` of the decision event written at seal time. Traces are queried by this marker — the CLI
 * smokes and every trace reader look the seal up by phase — so it is declared once here instead of
 * being respelled at the record call.
 */
export const SEAL_DECISION_PHASE = 'run_sealed';

/**
 * `phase` of the decision event written for each pi context compaction. Declared beside the seal
 * phase for the same reason: it is the marker a trace reader looks a compaction up by, so it is
 * spelled once here instead of being respelled at the record call.
 */
export const COMPACTION_DECISION_PHASE = 'context_compacted';

/**
 * Which typed reason each run budget ends a run for, total over the budget union so a new bound
 * cannot silently inherit another's reason.
 *
 * The three endings are not the same failure, and a maintainer reading the issue comment has only
 * this to tell them apart: a provider response that went silent says nothing about the
 * investigation (the model was mid-thought), an expired wall clock says the work did not fit the
 * time it was given, and the iteration backstop says the loop was going in circles. Collapsing all
 * three onto `max_iterations_exceeded` would report every one of them as "The agent loop reached
 * its budget".
 */
const BUDGET_TERMINATION_REASONS: Record<BudgetExceededSealed['budget'], AgentTerminationReason> = {
    [GuardCause.Turns]: AgentTerminationReason.MaxIterationsExceeded,
    [GuardCause.RequestDeadline]: AgentTerminationReason.RequestDeadlineExceeded,
    [GuardCause.WallClock]: AgentTerminationReason.WallClockExceeded,
};

/**
 * Map a seal that produced no accepted payload onto the typed reason the run ended for.
 *
 * A provider failure forks on `deterministic`: a rejection of this exact request (the pinned
 * 400/404/413/422 statuses or a content refusal) seals llm_rejected — which `fix-core` reads back
 * as `InfrastructureFailureReason.LlmRejected` and a retry scheduler refuses to pay for again. Only
 * a transient failure (`false` or absent, the conservative default) seals `llm_error` and stays
 * eligible for another attempt.
 *
 * Every pi-driven mode ends a run through this one mapping — the trace outcome below and the fix
 * session's host-fallback seal alike — so the fork can never be decided two different ways.
 *
 * @param outcome - The sealed pi outcome, minus the accepted-terminal arm.
 * @returns The typed termination reason.
 */
export function sealTerminationReason(outcome: NonTerminalSeal): AgentTerminationReason {
    switch (outcome.kind) {
        case SealKind.RejectedTerminal:
            return AgentTerminationReason.RetryBudgetExhausted;
        case SealKind.NoTerminal:
            return AgentTerminationReason.TerminalNotCalled;
        case SealKind.ProviderFailure:
            return outcome.deterministic === true
                ? AgentTerminationReason.LlmRejected
                : AgentTerminationReason.LlmError;
        case SealKind.BudgetExceeded:
            return BUDGET_TERMINATION_REASONS[outcome.budget];
        case SealKind.Aborted:
            return AgentTerminationReason.Interrupted;
    }
}

/**
 * Map a pi seal kind to the trace outcome string for that ending.
 *
 * @param outcome - The sealed pi outcome.
 * @returns The run_end outcome string.
 */
export function traceOutcomeForSeal(outcome: TerminalOutcome<unknown>): string {
    return outcome.kind === SealKind.Terminal
        ? TRACE_OUTCOME_SUCCESS
        : sealTerminationReason(outcome);
}

/**
 * The typed seal information persisted with the `run_sealed` decision event. Every field is
 * optional because each belongs to exactly one seal kind — the event's `seal` field says which arm
 * is populated — and a badly ended run is only diagnosable from a single run when the cause travels
 * with the kind instead of being dropped at the seal. `compactions` is the one exception: it
 * belongs to no arm and marks the run itself.
 *
 * The keys are STABLE and explicitly mapped, never spread from the outcome: a seal kind's own field
 * names are free to change with the pi vocabulary, while a trace reader must be able to read traces
 * written before and after such a change with one shape. Spreading would also collide two different
 * meanings on one key — a provider error message and an abort reason both land as `message` — which
 * no reader can tell apart without re-deriving the seal kind first.
 */
export interface SealTraceDetails {
    /**
     * How many times pi compacted this run's context, present only when it did at all. Absence is
     * therefore the ordinary reading "the transcript this run reasoned over is the one it built" —
     * and any value says the opposite, with the `context_compacted` events carrying the summaries
     * that replaced the lost turns.
     */
    compactions?: number;

    /**
     * Terminal submissions the host rejected before the run ended (terminal and rejected-terminal
     * seals).
     */
    rejections?: number;

    /**
     * The last rejection reason shown to the model (rejected-terminal seals).
     */
    lastReason?: string;

    /**
     * Which of the terminal tool's two bounds tripped: one wall repeated, or rejections accumulated
     * across differing reasons (rejected-terminal seals).
     */
    cappedBy?: RejectionCap;

    /**
     * What the model did instead of calling the terminal tool (no-terminal seals).
     */
    diagnosis?: string;

    /**
     * Pi's normalized provider message of the final failed request — HTTP status plus the parsed
     * provider error body (provider-failure seals).
     */
    providerMessage?: string;

    /**
     * Whether an HTTP status or content-refusal stop reason rejected this exact request.
     */
    deterministic?: boolean;

    /**
     * Which operational bound tripped: the wall-clock budget or the iteration backstop
     * (budget-exceeded seals).
     */
    budget?: GuardCause;

    /**
     * Human-readable detail naming the tripped limit (budget-exceeded seals).
     */
    budgetDetail?: string;

    /**
     * Why the caller aborted the run (aborted seals).
     */
    abortMessage?: string;
}

/**
 * Project one sealed outcome onto the typed detail record persisted with the seal event.
 *
 * Written once, here: every arm names the keys it populates, so the persisted vocabulary is this
 * declaration and nothing else. The accepted terminal `payload` is deliberately absent — it is the
 * mode's verdict and the terminal tool's own tool-call event records it — and so is `kind`, which
 * the event's `seal` field already carries.
 *
 * The values are pi's own diagnostic strings. They are handed to the recorder rather than written
 * to the trace directly, so the runtime recorder's redaction pass — the shared recursive redactor
 * plus the run's exact host secrets — scrubs them like every other persisted payload.
 *
 * @param outcome - The sealed pi outcome.
 * @returns The seal's typed detail fields.
 */
export function sealTraceDetails(outcome: TerminalOutcome<unknown>): SealTraceDetails {
    switch (outcome.kind) {
        case SealKind.Terminal:
            return { rejections: outcome.rejections };
        case SealKind.RejectedTerminal:
            return {
                lastReason: outcome.lastReason,
                rejections: outcome.rejections,
                cappedBy: outcome.cappedBy,
            };
        case SealKind.NoTerminal:
            return { diagnosis: outcome.diagnosis };
        case SealKind.ProviderFailure:
            return {
                providerMessage: outcome.message,
                deterministic: outcome.deterministic === true,
            };
        case SealKind.BudgetExceeded:
            return { budget: outcome.budget, budgetDetail: outcome.detail };
        case SealKind.Aborted:
            return { abortMessage: outcome.message };
    }
}

/**
 * Record the terminal seal and end the run trace, mapping each pi seal kind onto the trace outcome
 * vocabulary and persisting the seal's typed detail beside it.
 *
 * @param recorder - The run trace recorder.
 * @param outcome - The sealed pi outcome.
 * @param compactions - How many times pi compacted the run's context (from the compaction
 *   recording); zero — the default — leaves the field off the seal entirely, so its presence alone
 *   tells a reader the run reasoned over a summarized transcript.
 * @returns The sealed run trace.
 */
export function sealSessionTrace(
    recorder: TraceRecorder,
    outcome: TerminalOutcome<unknown>,
    compactions = 0,
): RunTrace {
    const traceOutcome = traceOutcomeForSeal(outcome);
    recorder.record(TraceEventType.Decision, {
        phase: SEAL_DECISION_PHASE,
        seal: outcome.kind,
        outcome: traceOutcome,
        details: {
            ...sealTraceDetails(outcome),
            ...(compactions > 0 ? { compactions } : {}),
        },
    });
    return recorder.end(traceOutcome);
}

/**
 * Human-readable detail of a non-terminal seal, for replay's warn log and observe's fallback
 * reasoning.
 *
 * @param outcome - The sealed pi outcome.
 * @returns The seal detail string.
 */
export function sealDetail(outcome: TerminalOutcome<unknown>): string {
    switch (outcome.kind) {
        case SealKind.RejectedTerminal:
            return outcome.lastReason ?? 'no reason recorded';
        case SealKind.NoTerminal:
            return outcome.diagnosis;
        case SealKind.ProviderFailure:
            return outcome.message;
        case SealKind.BudgetExceeded:
            return `${outcome.budget}: ${outcome.detail}`;
        case SealKind.Aborted:
            return 'aborted';
        case SealKind.Terminal:
            return 'terminal';
    }
}

/**
 * Wrap one session tool so every execution — success, gated refusal, or throw — lands in the run
 * trace through the recorder's per-call recordToolCall. The wrapper sits outside the gate check
 * inside the adapted execute, so gated refusals are recorded as ordinary tool results.
 *
 * @param spec - The adapted session tool.
 * @param recorder - The run trace recorder.
 * @returns The recording session tool.
 */
export function withExecutionRecording(
    spec: SessionToolSpec,
    recorder: TraceRecorder,
): SessionToolSpec {
    return {
        ...spec,
        execute: async (args, signal) => {
            const safeArgs =
                typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
            try {
                const result = await spec.execute(args, signal);
                recorder.recordToolCall(spec.name, safeArgs, resultRecord(result));
                return result;
            } catch (error) {
                recorder.recordToolCall(spec.name, safeArgs, {
                    error: error instanceof Error ? error.message : String(error),
                });
                throw error;
            }
        },
    };
}

/**
 * Prefer the redacted structured result (SessionToolResult.details) over the model-facing prose.
 *
 * @param result - The serialized tool result.
 * @returns The record written to the trace.
 */
function resultRecord(result: SessionToolResult): Record<string, unknown> {
    if (typeof result.details === 'object' && result.details !== null) {
        return result.details as Record<string, unknown>;
    }
    return { content: result.content };
}

/**
 * Wrap a terminal tool controller so every submission — accepted or rejected — lands in the run
 * trace.
 *
 * @param controller - The mode's terminal tool controller.
 * @param recorder - The run trace recorder.
 * @returns The controller whose tool records each call.
 */
export function recordTerminalTool<T>(
    controller: TerminalToolController<T>,
    recorder: TraceRecorder,
): TerminalToolController<T> {
    return { ...controller, tool: withExecutionRecording(controller.tool, recorder) };
}

/**
 * Build the observer that records every tool call pi refused before `execute`.
 *
 * The same `tool_call`/`tool_result` pair an executed call gets, so one reader answers "what did
 * the model call and what came back" for both endings: the arguments are the submission pi bounced
 * — the only copy of it outside the provider transcript — and the result is pi's reason for
 * refusing. Both go through the recorder, so the redaction pass scrubs them like every other
 * persisted payload.
 *
 * @param recorder - The run trace recorder.
 * @returns The bounce observer for runAgentSession's onToolBounce.
 */
export function recordToolBounce(recorder: TraceRecorder): ToolBounceObserver {
    return (bounce: SessionToolBounceObservation) => {
        recorder.recordToolCall(bounce.toolName, bounce.args, {
            // Named `error` exactly like the execute wrapper's throw arm: a reader looking for
            // failed calls must not have to know which of the two paths refused this one.
            error: bounce.reason,
            // ...and marked, because only this arm means the tool never ran at all.
            rejectedBeforeExecution: true,
            // Pi's un-normalised message, present only on the bounce whose `args` are empty
            // because no `tool_execution_start` recorded them: there it carries the echoed
            // submission, which is otherwise lost with the reason it was cut from.
            ...(bounce.rawBounceText === undefined ? {} : { rawBounceText: bounce.rawBounceText }),
        });
    };
}

/**
 * Build the observer that records one llm_request/llm_response event pair per completed pi turn,
 * with the trace format's token-total field names and pi's cache counts as extra response fields.
 *
 * @param recorder - The run trace recorder.
 * @returns The turn observer for runAgentSession's onTurnEnd.
 */
export function recordSessionTurn(recorder: TraceRecorder): TurnObserver {
    return (turn: SessionTurnObservation) => {
        recorder.recordLlmTurn(
            { turn: turn.index, model: turn.model ?? null },
            {
                model: turn.model ?? null,
                stopReason: turn.stopReason,
                // The cause of a failed turn, when there is one. Without it a turn pi retried away
                // lands as `stopReason: 'error'` with empty content and nothing saying why: pi
                // deletes the failed message from agent state before retrying, so the seal cannot
                // recover it and the pino warn is the only other copy — process log output, not
                // part of the locked run evidence.
                ...(turn.errorMessage === undefined ? {} : { errorMessage: turn.errorMessage }),
                content: turn.text,
                toolCalls: turn.toolCallNames,
                // Absent when all four provider token counts are zero, rather than values a
                // reader would price as a reported free request.
                ...(turn.usage.reported
                    ? {
                          promptTokens: turn.usage.input,
                          completionTokens: turn.usage.output,
                          cacheReadTokens: turn.usage.cacheRead,
                          cacheWriteTokens: turn.usage.cacheWrite,
                      }
                    : {}),
            },
        );
    };
}

/**
 * One run's compaction recording: the observer that writes each compaction into the trace, and the
 * running count the seal marks the run with.
 */
export interface SessionCompactionRecording {
    /**
     * The observer for runAgentSession's `onCompaction`.
     */
    observe: CompactionObserver;

    /**
     * How many compactions have been recorded so far.
     *
     * @returns The compaction count, ready for `sealSessionTrace`.
     */
    count: () => number;
}

/**
 * Build the recording that writes one `context_compacted` decision event per pi context compaction
 * and counts them for the seal.
 *
 * @param recorder - The run trace recorder.
 * @returns The compaction observer and its running count.
 */
export function recordSessionCompaction(recorder: TraceRecorder): SessionCompactionRecording {
    let count = 0;
    return {
        observe: (compaction: SessionCompactionObservation) => {
            count += 1;
            // The observation IS the detail — pi-free already, every optional field present exactly
            // when pi reported it — so it is recorded as it stands rather than copied field by
            // field into a second declaration of the same six values. Two fields move up to the
            // event instead of being repeated inside it: `reason`, and `index`, whose one-based
            // twin is the `compactions` ordinal.
            const { index: _index, reason, ...details } = compaction;
            recorder.record(TraceEventType.Decision, {
                phase: COMPACTION_DECISION_PHASE,
                reason,
                // The run's compaction ordinal, so a multi-compaction trace reads in order and the
                // last event alone answers how many rewrites the run went through.
                compactions: count,
                details,
            });
        },
        count: () => count,
    };
}
