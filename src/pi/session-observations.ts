import type { TurnStopReason } from './stop-reason';
import type { CompletionUsage } from './usage-reporting';

/**
 * The observation vocabulary: what a run reports about itself while it runs — one completed turn,
 * one completed context compaction, and one tool call pi refused before `execute` — together with
 * the observer callback each is delivered through. Kept in its own leaf so the session runner, the
 * telemetry seam, the tool-bounce observation and the trace recorders share one spelling of an
 * observation without importing each other.
 */

/**
 * One completed pi turn.
 */
export interface SessionTurnObservation {
    /**
     * Zero-based turn index; one turn per provider request, including error/aborted turns.
     */
    index: number;

    /**
     * How the turn ended, mapped onto the app-owned `TurnStopReason` set at the observation seam —
     * a stop reason pi grows arrives as `Unknown` rather than as an unnamed string in the trace.
     */
    stopReason: TurnStopReason;

    /**
     * Pi's composed provider/session error message when the turn failed (HTTP status plus the
     * provider's parsed error body); absent on a turn that ended cleanly. It is built from the
     * provider response, never from request credentials, so it carries no secrets. This is the only
     * host-visible record of a transiently failed attempt: pi deletes the failed message from agent
     * state before retrying, so the seal never sees it.
     */
    errorMessage?: string;

    /**
     * Model id that served the turn, when the provider message carries one.
     */
    model?: string;

    /**
     * Plain text of the turn's assistant message (empty when the turn only called tools).
     */
    text: string;

    /**
     * Names of the tools the turn called, in call order.
     */
    toolCallNames: string[];

    /**
     * Normalized usage of the turn — the SAME object the run's usage report counts for it, so a
     * turn the provider sent no usage chunk for reads as `reported: false` in the trace instead of
     * as four zeros indistinguishable from a free request. Its `model` is the pricing attribution
     * (the id the run asked for); the observation's own `model` is the gateway's echoed build
     * name.
     */
    usage: CompletionUsage;
}

/**
 * Observed turn-end callback. Observer errors are swallowed by the attachment — an observer must
 * never break the run it watches.
 */
export type TurnObserver = (observation: SessionTurnObservation) => void;

/**
 * Why pi rewrote the run's context into a generated summary. The members spell pi's own
 * `compaction_start`/`compaction_end` reasons, so the observation seam maps the event across
 * without inventing a second vocabulary.
 */
export const CompactionReason = {
    /**
     * A host asked for compaction explicitly. This layer never calls pi's manual `compact()`, so a
     * run reporting it would mean something outside `runAgentSession` drove the session.
     */
    Manual: 'manual',

    /**
     * The last reported context passed pi's configured share of the model's registered window. The
     * ordinary reason: the run outgrew its context and pi traded transcript for survival.
     */
    Threshold: 'threshold',

    /**
     * The provider itself refused or truncated the request for an over-window context, and pi
     * compacted to recover the interrupted turn.
     */
    Overflow: 'overflow',
} as const;

/**
 * CompactionReason value.
 */
export type CompactionReason = (typeof CompactionReason)[keyof typeof CompactionReason];

/**
 * One completed pi context compaction: everything the run can still learn about a rewrite that has
 * already replaced part of the transcript. Compaction is lossy by design — the summary below is the
 * ONLY evidence of what the model kept — so every field pi reports travels to the trace.
 */
export interface SessionCompactionObservation {
    /**
     * Zero-based index of this compaction within the run; one per pi `compaction_end`, aborted and
     * failed attempts included, so a log line and a trace event can be lined up.
     */
    index: number;

    /**
     * Why pi compacted.
     */
    reason: CompactionReason;

    /**
     * The generated summary that replaced the compacted prefix. Present exactly when pi produced a
     * result — that is, exactly when the run history was actually rewritten — and absent for an
     * aborted or failed attempt.
     */
    summary?: string;

    /**
     * Context tokens pi measured before the rewrite, when it produced a result.
     */
    tokensBefore?: number;

    /**
     * Pi's estimate of the context tokens left after the rewrite, when it reported one.
     */
    estimatedTokensAfter?: number;

    /**
     * Whether the compaction was aborted before it rewrote anything.
     */
    aborted: boolean;

    /**
     * Whether pi will retry the interrupted turn on the compacted context (the overflow-recovery
     * path); `false` for a threshold compaction, which just continues.
     */
    willRetry: boolean;

    /**
     * Pi's message when the summarization itself failed; absent on a compaction that completed.
     */
    errorMessage?: string;
}

/**
 * Observed compaction callback, invoked once per completed pi compaction. Observer errors are
 * swallowed by the attachment — an observer must never break the run it watches.
 */
export type CompactionObserver = (observation: SessionCompactionObservation) => void;

/**
 * One tool call the model made that never reached its `execute`: pi refused it against the
 * advertised schema, blocked it, could not find the tool, or dropped it with the truncated
 * assistant message that carried it.
 *
 * It is a distinct observation from a tool that ran and failed, because nothing else in the run
 * sees it: the execute wrapper is never entered, so without this the whole submission and the
 * reason it was refused exist only inside the provider transcript, and the run evidence shows a
 * tool name on the turn event and nothing more.
 */
export interface SessionToolBounceObservation {
    /**
     * The tool the model called.
     */
    toolName: string;

    /**
     * The arguments the assistant message carried, as pi received them.
     */
    args: Record<string, unknown>;

    /**
     * Why the call was refused — pi's own text with its echoed copy of the arguments stripped, so
     * the reason is a reason and the payload is recorded once, as the call's arguments. Stripped on
     * EVERY bounce, whatever recorded the call, because this same text is the fingerprint the
     * terminal tool's same-reason streak compares: with pi's echoed submission left inside, the
     * streak degrades into a byte-comparison of payloads and a model shortening its answer by one
     * character each time never repeats a "reason".
     */
    reason: string;

    /**
     * Pi's un-normalised bounce message, echoed submission included.
     *
     * Present exactly when the observation never saw this call's `tool_execution_start` — so
     * {@link args} is empty and nothing else in the run holds the payload — AND the normalization
     * described above actually removed something. On that branch the echoed block is the only
     * surviving copy of what the model submitted, so it travels as its own field instead of being
     * carried inside the reason, where it would corrupt the streak fingerprint.
     */
    rawBounceText?: string;
}

/**
 * Observed tool-bounce callback, invoked once per refused call. Observer errors are swallowed by
 * the observation — an observer must never break the run it watches.
 */
export type ToolBounceObserver = (observation: SessionToolBounceObservation) => void;
