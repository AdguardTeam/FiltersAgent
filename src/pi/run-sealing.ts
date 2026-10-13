/**
 * How an agent session run seals: the two-phase nudge flow — drive the user task, re-prompt exactly
 * once when it ends in prose, classify every ending, and fold never-dropped prompt rejections
 * through the diagnosis — plus the no-terminal diagnosis of the final transcript and the
 * provider-determinism marker and status for `ProviderFailureSealed`. The sealed-outcome vocabulary
 * itself lives in `types.ts`. No session construction lives here (that is session-runner.ts, the
 * one module the codebase calls to RUN sessions); the flow takes the runner's own option fields as
 * its input through a TYPE-ONLY import of them, which is erased at compile time, so the runtime
 * import graph stays acyclic without a parallel declaration of the same four fields. pi types stay
 * hidden from everything outside src/pi/.
 */
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type {
    AssistantMessage,
    ImageContent,
    Message,
    TextContent,
    ThinkingContent,
    ToolCall,
} from '@earendil-works/pi-ai';
import type { Logger } from '../logger/logger';
import { TurnStopReason } from './stop-reason';
import {
    TerminalSettlement,
    type TerminalToolController,
    type TerminalToolSettlement,
} from './terminal-tool';
import { GuardCause, type RunBudgets, type RunGuards } from './guard-types';
import type { RunAgentSessionOptions } from './session-runner';
import { SealKind, type TerminalOutcome } from './seal-types';

/**
 * The sealing flow's slice of a run's inputs: exactly the four fields of the runner's options the
 * two-phase flow reads, taken from that declaration rather than restated beside it.
 */
type RunFlowInputs<T> = Pick<
    RunAgentSessionOptions<T>,
    'terminal' | 'userTask' | 'nudge' | 'budgets'
>;

/**
 * Map the terminal settlement onto the sealed outcome.
 *
 * @param settlement - How the terminal tool settled.
 * @param rejections - Rejections observed along the way.
 * @returns The sealed outcome.
 */
function sealFromSettlement<T>(
    settlement: TerminalToolSettlement<T>,
    rejections: number,
): TerminalOutcome<T> {
    if (settlement.kind === TerminalSettlement.Accepted) {
        return { kind: SealKind.Terminal, payload: settlement.payload, rejections };
    }
    return {
        kind: SealKind.RejectedTerminal,
        lastReason: settlement.lastReason,
        rejections,
        cappedBy: settlement.cappedBy,
    };
}

/**
 * How one prompt phase of a run ended.
 */
const PromptPhaseKind = {
    /**
     * The terminal tool settled first (or had already settled) and the race sealed.
     */
    Settled: 'settled',

    /**
     * The prompt ended (resolved or rejected) without a settlement; the captured rejection —
     * `undefined` on a clean resolve — travels with it and is never dropped.
     */
    PromptEnded: 'prompt-ended',
} as const;

/**
 * PromptPhaseKind value.
 */
type PromptPhaseKind = (typeof PromptPhaseKind)[keyof typeof PromptPhaseKind];

/**
 * Outcome of one prompt phase: the terminal settled (the abort raced and drained first, as the
 * single-phase runner did), or the prompt ended without a settlement, carrying the error
 * `session.prompt()` rejected with.
 */
type PromptPhase<T> =
    | {
          /**
           * Discriminator: the terminal settled during (or before) this phase.
           */
          phase: typeof PromptPhaseKind.Settled;

          /**
           * The settlement the runner seals from.
           */
          settlement: TerminalToolSettlement<T>;
      }
    | {
          /**
           * Discriminator: the prompt ended (resolved or rejected) with no settlement.
           */
          phase: typeof PromptPhaseKind.PromptEnded;

          /**
           * The captured `session.prompt()` rejection — `undefined` on a clean resolve, never
           * dropped.
           */
          rejection: unknown;
      };

/**
 * Maximum characters of the final assistant reply carried into a no-terminal diagnosis.
 *
 * Why 160: the snippet answers one question — what the model said INSTEAD of calling the terminal
 * tool — and the opening sentence answers it (an apology, a plan, a refusal and a "here is the rule
 * in prose" all read differently within their first clause). 160 characters is one sentence plus
 * room to spare, and it is the whole budget available: the diagnosis is a single line of a sealed
 * outcome that is logged and persisted for every run that ends this way, so a reply carried
 * verbatim — model prose runs to thousands of characters, and a reply can be a pasted DOM — would
 * put a transcript inside the seal. The untruncated reply stays in the session transcript for
 * anyone who needs more than the opening.
 */
const MAX_DIAGNOSIS_SNIPPET = 160;

/**
 * Plain text of a message's content (a string or pi's content blocks), typed on pi's own content
 * shapes so the seam never re-declares them.
 *
 * @param content - The raw message content.
 * @returns Joined text blocks.
 */
export function messageText(
    content: string | readonly (TextContent | ThinkingContent | ToolCall | ImageContent)[],
): string {
    if (typeof content === 'string') {
        return content;
    }
    return content.map((block) => (block.type === 'text' ? block.text : '')).join(' ');
}

/**
 * Last assistant message in a session transcript, or undefined when the transcript has none.
 *
 * @param messages - The session transcript.
 * @returns The final assistant message.
 */
function lastAssistantMessage(messages: readonly Message[]): AssistantMessage | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message !== undefined && message.role === 'assistant') {
            return message;
        }
    }
    return undefined;
}

/**
 * Diagnose a run that ended without the terminal call: the provider/session error message when one
 * surfaced, otherwise what the model did instead (final reply snippet and stop reason). A
 * `prompt()` rejection that left no assistant error message is never dropped: its message is folded
 * into the diagnosis (and error-logged by the caller) so a single run stays diagnosable.
 *
 * @param messages - The session transcript.
 * @param promptRejection - The error `session.prompt()` rejected with, when it did.
 * @returns The diagnosis text.
 */
function diagnoseNoTerminal(messages: readonly Message[], promptRejection: unknown): string {
    const rejectionText =
        promptRejection === undefined
            ? undefined
            : promptRejection instanceof Error && promptRejection.message !== ''
              ? promptRejection.message
              : String(promptRejection);
    const last = lastAssistantMessage(messages);
    if (last === undefined) {
        const base = 'agent finished without calling the terminal tool (no final assistant turn)';
        return rejectionText === undefined ? base : `${base}; prompt error: ${rejectionText}`;
    }
    if (typeof last.errorMessage === 'string' && last.errorMessage !== '') {
        return `session error: ${last.errorMessage}`;
    }
    const stopReason = last.stopReason;
    if (stopReason === TurnStopReason.Length) {
        return 'agent finished without calling the terminal tool (output truncated, length stop)';
    }
    const text = messageText(last.content).replace(/\s+/g, ' ').trim();
    const reply =
        text === ''
            ? '(no text)'
            : text.length > MAX_DIAGNOSIS_SNIPPET
              ? `"${text.slice(0, MAX_DIAGNOSIS_SNIPPET)}…"`
              : `"${text}"`;
    return (
        'agent finished without calling the terminal tool ' +
        `(final reply: ${reply}; stopReason: ${stopReason})`
    );
}

/**
 * HTTP statuses that prove the provider rejected this exact request, not a passing outage.
 *
 * Everything here is non-retryable at the request level already (retryable statuses are
 * 408/409/429/5xx). The narrower claim this list makes is determinism across whole runs: the prompt
 * is pinned by digest, so a request refused as malformed (400), unroutable (404), too large (413),
 * or semantically invalid (422) is refused identically on every paid retry. 401/403 are
 * deliberately absent - credentials can be rotated between attempts, so an auth failure is an
 * outage to retry, not a property of the request.
 */
const DETERMINISTIC_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 404, 413, 422]);

/**
 * Leading status token of pi's composed provider message, as `formatProviderError` emits it for the
 * openai-completions API this runtime registers (`"<status>: <body>"`, no provider prefix).
 */
const LEADING_STATUS_PATTERN = /^(\d{3}):\s/u;

/**
 * Decide whether pi's composed provider message names a deterministic rejection of this exact
 * request.
 *
 * Pi exposes a provider failure to the host only as the composed `errorMessage` string of the
 * turn's assistant message; the status is not otherwise surfaced. For our provider (registered with
 * `api: 'openai-completions'`), pi-ai composes `"<status>: <body>"` without a prefix
 * (`formatProviderError`), so a LEADING three-digit status token inside the message is the only
 * structural evidence available. When the message has no leading status (an SDK-folded body or an
 * alternate composition), the answer is `false` — the conservative direction: true only for a
 * structurally identified deterministic status.
 *
 * @param message - Pi's provider-failure message (final failed request).
 * @returns True when the message carries a deterministic rejection status.
 */
export function isDeterministicProviderMessage(message: string): boolean {
    const leading = LEADING_STATUS_PATTERN.exec(message);
    if (leading === null) {
        return false;
    }
    return DETERMINISTIC_REJECTION_STATUSES.has(Number(leading[1]));
}

/**
 * Parse the leading HTTP status token of pi's composed provider message, when it has one.
 *
 * Reuses the exact structural evidence `isDeterministicProviderMessage` reads (the same
 * `LEADING_STATUS_PATTERN`), so a status this parses and a message this classifies as deterministic
 * can never disagree about what the leading token was. Every caller that needs the provider's
 * status without its body — the seal built below, and the turn-level diagnostics log in
 * `session-telemetry.ts` — calls this instead of matching the pattern again.
 *
 * @param message - Pi's provider-failure message.
 * @returns The leading status, or undefined when the message carries none.
 */
export function parseProviderFailureStatus(message: string): number | undefined {
    const leading = LEADING_STATUS_PATTERN.exec(message);
    return leading === null ? undefined : Number(leading[1]);
}

/**
 * Race one prompt against the terminal settlement, mirroring the single-phase runner's race.
 *
 * Refuses to prompt at all once a guard cause exists: pi's `Agent.abort()` only touches an ACTIVE
 * run, so without this a guard that tripped while the session was being built (or between the two
 * phases) would record a cause while the upcoming prompt burned provider requests normally. The
 * runner then seals from the recorded cause.
 *
 * @param session - The built pi session.
 * @param terminal - The mode's terminal tool controller.
 * @param guards - The attached run guards (whose recorded cause gates phase start).
 * @param text - The user-task or nudge text to prompt.
 * @param logger - Application logger for the abort-drain debug diagnostics.
 * @returns The settlement when the terminal settled first (or had already settled), otherwise
 *   `prompt-ended` with the captured rejection.
 */
async function runPromptPhase<T>(
    session: AgentSession,
    terminal: TerminalToolController<T>,
    guards: RunGuards,
    text: string,
    logger: Logger,
): Promise<PromptPhase<T>> {
    if (guards.cause() !== undefined) {
        return { phase: PromptPhaseKind.PromptEnded, rejection: undefined };
    }
    let promptRejection: unknown;
    // Both racers resolve to the phase outcome itself, so the race needs no sentinel vocabulary
    // beside the declared PromptPhaseKind: the discriminant of the winner IS the answer.
    const promptDone: Promise<PromptPhase<T>> = session.prompt(text).then(
        () => ({ phase: PromptPhaseKind.PromptEnded, rejection: undefined }),
        (error: unknown) => {
            promptRejection = error;
            return { phase: PromptPhaseKind.PromptEnded, rejection: error };
        },
    );
    const terminalDone: Promise<PromptPhase<T>> = terminal.settled.then((settlement) => ({
        phase: PromptPhaseKind.Settled,
        settlement,
    }));
    const first = await Promise.race([promptDone, terminalDone]);
    if (first.phase === PromptPhaseKind.Settled) {
        await session.abort().catch((error: unknown) => {
            logger.debug({ err: error }, 'pi session abort after terminal seal failed');
        });
        await promptDone;
        if (promptRejection !== undefined) {
            logger.debug(
                { err: promptRejection },
                'expected abort-induced prompt rejection after terminal seal',
            );
        }
        return first;
    }
    // The prompt won, but the terminal may have settled in the same tick: an already-resolved
    // `terminalDone` queues its reaction before the already-resolved fallback, so the settlement
    // wins whenever it exists and the prompt ending stands otherwise.
    return await Promise.race([terminalDone, Promise.resolve(first)]);
}

/**
 * Classify a prompt phase that ended without a terminal settlement.
 *
 * Guard causes outrank transcript state: an aborted in-flight request can end `error`/`aborted`,
 * but the run sealed because the bound tripped. Every cause is named here — the wall-clock budget,
 * the iteration backstop, the per-request provider deadline and caller cancellation — so no caller
 * has to re-seal an outcome this function already produced. A clean prose ending is the only
 * classification that earns the nudge, and it is reported as the ABSENCE of a sealed outcome rather
 * than as a sentinel string beside the typed union.
 *
 * @param session - The built pi session.
 * @param guards - The run guards and their recorded cause.
 * @param budgets - The run budgets, for the budget-exceeded detail.
 * @returns The sealed outcome, or `undefined` when the model simply stopped talking in prose.
 */
function classifyEnd<T>(
    session: AgentSession,
    guards: RunGuards,
    budgets: RunBudgets,
): TerminalOutcome<T> | undefined {
    const cause = guards.cause();
    if (cause === GuardCause.RequestDeadline) {
        // The runner's own per-request INACTIVITY timer, armed on the assistant `message_start`,
        // re-armed on every streamed delta and disarmed on `message_end` — so it is never live
        // while the terminal tool runs, and an accepted or capped settlement always wins the race
        // in `settleRun` before this is consulted.
        return {
            kind: SealKind.BudgetExceeded,
            budget: GuardCause.RequestDeadline,
            detail: `no streamed progress for ${budgets.requestTimeoutMs}ms in one provider response`,
        };
    }
    if (cause === GuardCause.WallClock) {
        return {
            kind: SealKind.BudgetExceeded,
            budget: GuardCause.WallClock,
            detail: `wall-clock budget of ${budgets.wallClockMs ?? 0}ms expired`,
        };
    }
    if (cause === GuardCause.Turns) {
        return {
            kind: SealKind.BudgetExceeded,
            budget: GuardCause.Turns,
            // The configured limit, not guards.turns(): an aborted turn can emit one more
            // turn_end through handleRunFailure, and the detail must name the bound that tripped.
            detail: `iteration backstop reached (limit ${budgets.maxTurns ?? 0} turns)`,
        };
    }
    if (cause === GuardCause.Caller) {
        return { kind: SealKind.Aborted, message: 'run aborted by the caller' };
    }
    const last = lastAssistantMessage(session.messages as readonly Message[]);
    if (last?.stopReason === TurnStopReason.Error) {
        const message =
            typeof last.errorMessage === 'string' && last.errorMessage !== ''
                ? last.errorMessage
                : 'provider request failed without an error message';
        return {
            kind: SealKind.ProviderFailure,
            message,
            deterministic: isDeterministicProviderMessage(message),
            status: parseProviderFailureStatus(message),
        };
    }
    if (last?.stopReason === TurnStopReason.Aborted) {
        // Defensive: no guard recorded the abort, so pi ended the run aborted on its own.
        return { kind: SealKind.Aborted, message: 'session aborted' };
    }
    return undefined;
}

/**
 * Log a captured prompt rejection whose ending already sealed for another reason (guard cause or
 * transcript error). Kept at debug because the ending IS explained — the AGENTS.md never-swallow
 * rule only demands the error survive, and the typed seal plus this log carry it.
 *
 * @param logger - Application logger.
 * @param sealedAs - The kind the run sealed as despite (or alongside) the rejection.
 * @param rejection - The captured rejection, `undefined` when the prompt resolved cleanly.
 */
function logExplainedRejection(logger: Logger, sealedAs: SealKind, rejection: unknown): void {
    if (rejection === undefined) {
        return;
    }
    logger.debug(
        { err: rejection, sealedAs },
        'pi session prompt rejection explained by the guarded or transcript ending',
    );
}

/**
 * Run the user task and, when it ends in prose, exactly one nudge — sealing every ending as a typed
 * outcome. The terminal-rejection observation is NOT opened here: `runAgentSession` establishes it
 * for the whole run (spanning both phases) before calling this and closes it in its finally.
 *
 * A captured prompt rejection is never dropped: when the transcript or a guard cause explains the
 * ending it is debug-logged alongside the typed seal; when nothing explains it (prose → nudge →
 * prose), it is error-logged and folded into the final `diagnoseNoTerminal` call — the FINAL
 * phase's rejection, matching its two-parameter contract.
 *
 * @param session - The built pi session.
 * @param params - The sealing inputs the runner assembled (terminal, user task, nudge, budgets).
 * @param guards - The attached run guards.
 * @param logger - Application logger for never-dropped prompt rejections.
 * @returns The sealed outcome.
 */
export async function settleRun<T>(
    session: AgentSession,
    params: RunFlowInputs<T>,
    guards: RunGuards,
    logger: Logger,
): Promise<TerminalOutcome<T>> {
    const { terminal, budgets } = params;
    // One loop over the two phase texts preserves the ordering contract exactly: settle →
    // classify → log unexplained rejection → next phase, with the FINAL phase's rejection carried
    // into the no-terminal diagnosis.
    const phaseTexts = [params.userTask, params.nudge] as const;
    let lastRejection: unknown = undefined;
    for (const text of phaseTexts) {
        const phase = await runPromptPhase(session, terminal, guards, text, logger);
        if (phase.phase === PromptPhaseKind.Settled) {
            return sealFromSettlement(phase.settlement, terminal.rejections());
        }
        lastRejection = phase.rejection;
        const ended = classifyEnd<T>(session, guards, budgets);
        if (ended !== undefined) {
            logExplainedRejection(logger, ended.kind, phase.rejection);
            return ended;
        }
        if (phase.rejection !== undefined) {
            logger.error(
                { err: phase.rejection, phase: 'agent-session' },
                'pi session prompt rejected without a terminal seal',
            );
        }
    }
    return {
        kind: SealKind.NoTerminal,
        diagnosis: diagnoseNoTerminal(session.messages as readonly Message[], lastRejection),
    };
}
