import type {
    AgentSession,
    AgentSessionEvent,
    AgentToolResult,
} from '@earendil-works/pi-coding-agent';
import type { Logger } from '../logger/logger';
import { messageText } from './run-sealing';
import type { TerminalToolController } from './terminal-tool';
import { TelemetryObserver } from './usage-reporting';
import type { SessionToolBounceObservation, ToolBounceObserver } from './session-observations';

/**
 * Tool-call observation: the ONE place a tool call the model made is matched with how it ended.
 *
 * Two things depend on seeing a call pi refused BEFORE `execute` — a schema bounce against the
 * advertised parameters, a blocked or unknown tool, a call on a message truncated by the output
 * limit. Such a call reaches no wrapper this codebase installs, so:
 *
 * - The terminal tool's rejection cap is fed from here, because counting inside `execute` would miss
 *   every pre-`execute` bounce and leave a schema-invalid submission loop unbounded; and
 * - The bounce itself is RECORDED from here, because the execute wrapper never sees it. Without this,
 *   a failure such as a summary 39 characters over its limit, resubmitted until the run seals, is
 *   visible in the run evidence only as a tool name on the turn event, with neither the payload nor
 *   pi's reason anywhere.
 *
 * The two are told apart by `markExecuted`, which the runner's pi tool adapter calls with the call
 * id the moment `execute` runs: an id the observation never saw marked is a call that never
 * executed. Anything else would double-record, since the execute wrapper already writes its own
 * tool_call/tool_result pair for a rejection it threw.
 */

/**
 * The payload pi echoes back at the end of its validation message.
 *
 * Pi composes a bounce as `Validation failed for tool "x":\n - <path>: <message>\n\nReceived
 * arguments:\n<pretty-printed arguments>` (pi-ai `utils/validation.js`), and the echoed arguments
 * are the whole submission — a fix outcome with its reasoning and summary. Two things break if that
 * block travels on as the reason: the same-reason streak can then only trip on a byte-identical
 * resubmission, so a model shortening its summary by one character each time never repeats a
 * "reason" and only the total ceiling ever fires; and the reason is persisted (the seal's
 * `lastReason`, the fix host summary, the analysis-only fallback reasoning, run reports), where a
 * whole payload is not a reason. The per-path issue lines are kept, which is the same shape
 * `formatIssues` gives the execute path, so the two bounce paths compare and read alike.
 */
const PI_ECHOED_ARGUMENTS_BLOCK = /\n\s*Received arguments:\n[\s\S]*$/u;

/**
 * Strip pi's echoed submission from one tool bounce message.
 *
 * @param reason - The model-facing error text of a tool result.
 * @returns The reason without the echoed arguments block; other texts are returned unchanged.
 */
export function normalizeToolBounceReason(reason: string): string {
    return reason.replace(PI_ECHOED_ARGUMENTS_BLOCK, '').trimEnd();
}

/**
 * What the tool-call observation of one run needs.
 */
export interface ToolCallObservationOptions<T> {
    /**
     * The mode's terminal tool controller. Every error result of ITS tool — pi's pre-`execute`
     * bounces and execute-thrown rejections alike — is forwarded to `observeRejection`, the one
     * counter feeding the cap.
     */
    terminal: TerminalToolController<T>;

    /**
     * Optional sink for calls that never reached `execute`, invoked once per bounce. Observer
     * failures are swallowed and logged: evidence recording must never break the run it watches.
     */
    onBounce?: ToolBounceObserver;

    /**
     * Diagnostics sink for bounces and observer failures.
     */
    logger: Logger;
}

/**
 * One run's attached tool-call observation.
 */
export interface ToolCallObservation {
    /**
     * Mark one tool call as having reached `execute`. Called by the runner's pi tool adapter with
     * pi's own call id, which is what distinguishes a bounced call from an executed one.
     *
     * @param toolCallId - Pi's id for the tool call now executing.
     */
    markExecuted: (toolCallId: string) => void;

    /**
     * Subscribe the observation to a built session.
     *
     * @param session - The built pi session.
     * @returns The unsubscribe function.
     */
    attach: (session: AgentSession) => () => void;
}

/**
 * One tool call pi announced, held until its end event says how it finished.
 */
interface PendingToolCall {
    /**
     * The tool the model called.
     */
    toolName: string;

    /**
     * The arguments the assistant message carried, exactly as pi received them — the payload a
     * bounced call was rejected for, which exists nowhere else once the call never executes. A
     * payload that is not a JSON object is kept verbatim under `rawArguments`.
     */
    args: Record<string, unknown>;
}

/**
 * Wrapper key under which a submission that is not a JSON object is recorded.
 *
 * The trace records a tool call's arguments as a record, but pi's JSON repair can hand back an
 * array, a string or a number — which TypeBox then bounces as a type error, so the call never
 * executes and this observation is the only place the payload exists. Dropping it for an empty
 * record loses exactly the evidence needed to see WHAT the model submitted, so the payload is kept
 * verbatim under one key instead.
 */
const RAW_ARGUMENTS_KEY = 'rawArguments';

/**
 * Project pi's untyped tool-call arguments onto the record shape the trace records.
 *
 * Arrays are wrapped like every other non-object payload: spreading one into a record would file
 * its entries under numeric keys and read as an object the model never sent.
 *
 * @param args - Arguments from pi's tool execution event.
 * @returns The arguments as a record, or the payload under {@link RAW_ARGUMENTS_KEY}.
 */
function toArgumentRecord(args: unknown): Record<string, unknown> {
    return typeof args === 'object' && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : { [RAW_ARGUMENTS_KEY]: args };
}

/**
 * Build one run's tool-call observation.
 *
 * @param options - The terminal controller, the optional bounce sink, and the diagnostics sink.
 * @returns The execute marker and the session attachment.
 */
export function createToolCallObservation<T>(
    options: ToolCallObservationOptions<T>,
): ToolCallObservation {
    const executed = new Set<string>();
    const pending = new Map<string, PendingToolCall>();

    /**
     * Deliver one bounce observation, never letting the sink break the run.
     *
     * @param observation - The pi-free bounce observation.
     */
    const emitBounce = (observation: SessionToolBounceObservation): void => {
        options.logger.warn(
            { tool: observation.toolName, reason: observation.reason },
            'tool call rejected before execution',
        );
        if (options.onBounce === undefined) {
            return;
        }
        try {
            options.onBounce(observation);
        } catch (error) {
            options.logger.error(
                {
                    err: error,
                    observer: TelemetryObserver.ToolBounce,
                    tool: observation.toolName,
                },
                'tool bounce observer failed; this rejection has no trace evidence',
            );
        }
    };

    return {
        markExecuted: (toolCallId: string): void => {
            executed.add(toolCallId);
        },
        attach: (session: AgentSession): (() => void) =>
            session.subscribe((event: AgentSessionEvent) => {
                if (event.type === 'tool_execution_start') {
                    pending.set(event.toolCallId, {
                        toolName: event.toolName,
                        args: toArgumentRecord(event.args),
                    });
                    return;
                }
                if (event.type !== 'tool_execution_end') {
                    return;
                }
                const call = pending.get(event.toolCallId);
                pending.delete(event.toolCallId);
                const reachedExecute = executed.delete(event.toolCallId);
                if (event.isError !== true) {
                    return;
                }
                // Pi's echoed copy of the submission is stripped on EVERY bounce, because this
                // text is both the persisted reason and the streak fingerprint: a reason still
                // carrying the payload turns the same-reason streak into a byte-comparison of
                // submissions, which a model shortening its answer by one character each time
                // never trips. That holds whether or not a `tool_execution_start` recorded the
                // call, so the normalization cannot depend on it.
                const bounceText = messageText((event.result as AgentToolResult<unknown>).content);
                const reason = normalizeToolBounceReason(bounceText);
                if (event.toolName === options.terminal.tool.name) {
                    // Listener delivery is inline-awaited by pi's agent loop, so a cap settlement
                    // reached here races ahead of any further completion request.
                    options.terminal.observeRejection(reason);
                }
                if (reachedExecute) {
                    // The execute wrapper recorded this call with its own result already.
                    return;
                }
                emitBounce({
                    toolName: event.toolName,
                    args: call?.args ?? {},
                    reason,
                    // Without a pending call `args` is empty, so what the normalization just cut
                    // away is the run's only copy of the submission: it travels beside the reason
                    // rather than inside it. A pending call already holds the payload in `args`,
                    // and a message nothing was stripped from has no echo to keep.
                    ...(call === undefined && bounceText !== reason
                        ? { rawBounceText: bounceText }
                        : {}),
                });
            }),
    };
}
