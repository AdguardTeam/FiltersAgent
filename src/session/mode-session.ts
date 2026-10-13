/**
 * The launch procedure the prompt-driven session modes share — analyze, replay, the
 * pre-orchestrated fix path and the agentic fix session. Each mode owns what genuinely differs (its
 * task document and fills, its terminal payload schema, its tool surface, its bounds, and what it
 * makes of the sealed outcome); everything between those choices is one procedure written once
 * here: render the three prompt documents from one loader, map the configured provider bounds onto
 * the pi runner, record every turn, every refused tool call and every context compaction into the
 * run trace, and attach the run's usage summary.
 *
 * `launchModeSession` runs the session and hands back the sealed outcome plus the run's compaction
 * count; each session caller maps the seal onto its own result.
 */
import type { ToolName } from '../agent/tool-names';
import type { LlmConfig } from '../config/config';
import type { Logger } from '../logger/logger';
import { providerMaxRetries } from '../pi/llm-wiring';
import type { PiRuntime } from '../pi/runtime';
import { runAgentSession } from '../pi/session-runner';
import type { TerminalToolController } from '../pi/terminal-tool';
import type { TerminalOutcome } from '../pi/seal-types';
import type { TurnObserver } from '../pi/session-observations';
import type { SessionToolSpec } from '../pi/session-tool-types';
import type { RunUsageCollector } from '../pi/usage-collector';
import {
    createPromptDocumentLoader,
    PromptDocumentName,
    type PromptDocumentLoader,
} from '../prompts/prompt-documents';
import {
    recordSessionCompaction,
    recordSessionTurn,
    recordToolBounce,
} from '../tracer/session-trace';
import type { TraceRecorder } from '../tracer/trace-recorder';

/**
 * The three rendered documents one mode session runs on.
 */
export interface SessionPrompts {
    /**
     * The shared system document, identical for every mode.
     */
    systemPrompt: string;

    /**
     * The mode's rendered task document.
     */
    userTask: string;

    /**
     * The re-prompt sent once when a turn ends without the terminal call.
     */
    nudge: string;

    /**
     * The steering message sent once when the wall-clock budget is about to expire.
     */
    wrapUp: string;
}

/**
 * Renders one mode's task document. The terminal tool name arrives as an argument rather than being
 * restated by the mode, so a task fill can never name a different tool than the session
 * advertises.
 */
export type TaskRenderer = (prompts: PromptDocumentLoader, terminalToolName: ToolName) => string;

/**
 * Render the prompt trio of one mode session from a single loader.
 *
 * The terminal tool name is spelled once and filled into the task document, the nudge and the
 * wrap-up, so they can never name different tools to the model.
 *
 * @param terminalToolName - The mode's terminal tool name.
 * @param renderTask - Renders the mode's own task document from the session's loader.
 * @returns The rendered documents.
 */
export function renderSessionPrompts(
    terminalToolName: ToolName,
    renderTask: TaskRenderer,
): SessionPrompts {
    const prompts = createPromptDocumentLoader();
    return {
        systemPrompt: prompts.render(PromptDocumentName.System),
        userTask: renderTask(prompts, terminalToolName),
        nudge: prompts.render(PromptDocumentName.Nudge, { terminalToolName }),
        wrapUp: prompts.render(PromptDocumentName.WrapUp, { terminalToolName }),
    };
}

/**
 * What one mode session launch needs beyond the mode's own tools, terminal and task document.
 */
export interface ModeSessionRequest<T> {
    /**
     * The run's pi runtime handle.
     */
    runtime: PiRuntime;

    /**
     * The validated LLM provider configuration the request bounds and retries are mapped from.
     */
    llm: LlmConfig;

    /**
     * The run trace recorder: every turn, the usage summary and the seal land in it.
     */
    recorder: TraceRecorder;

    /**
     * The mode's terminal tool name, filled into the task document and the nudge.
     */
    terminalToolName: ToolName;

    /**
     * Renders the mode's task document from the session's prompt loader.
     */
    renderTask: TaskRenderer;

    /**
     * The mode's terminal tool controller, already wrapped for trace recording.
     */
    terminal: TerminalToolController<T>;

    /**
     * The mode's non-terminal tool surface, already wrapped for trace recording.
     */
    tools: SessionToolSpec[];

    /**
     * The mode's turn cap.
     */
    maxTurns: number;

    /**
     * Wall-clock investigation budget; unset leaves the run bounded by turns alone, which is what
     * every mode but the agentic fix path wants.
     */
    wallClockMs?: number;

    /**
     * Directory the session is logically rooted at (also pi's work directory).
     */
    workDir: string;

    /**
     * Application logger, forwarded into the session so a `--verbose` run keeps one logger — and
     * one level — for the whole run instead of letting the runner build a second one at info.
     */
    logger?: Logger;

    /**
     * Caller cancellation; aborted runs seal as `aborted`.
     */
    signal?: AbortSignal;

    /**
     * Optional run-scoped usage collector; when present the session's usage lands in it and the
     * sealed trace carries the rendered summary block.
     */
    usageCollector?: RunUsageCollector;

    /**
     * Extra per-turn sink, invoked after the trace recording of the same turn. The agentic fix run
     * feeds its delivered-frontier observation sink from here.
     */
    onTurnEnd?: TurnObserver;
}

/**
 * What one launched mode session hands back before any seal is written.
 */
export interface ModeSessionLaunch<T> {
    /**
     * The sealed pi outcome (typed terminal payload or a failure seal).
     */
    outcome: TerminalOutcome<T>;

    /**
     * How many times pi compacted this run's context, for the seal that marks the run with it.
     */
    compactions: number;
}

/**
 * Run one mode session on pi and attach the run's usage summary, leaving the trace unsealed.
 *
 * @param request - The launch request.
 * @returns The sealed pi outcome and the run's compaction count.
 */
export async function launchModeSession<T>(
    request: ModeSessionRequest<T>,
): Promise<ModeSessionLaunch<T>> {
    const { recorder, usageCollector } = request;
    const compaction = recordSessionCompaction(recorder);
    const recordTurn = recordSessionTurn(recorder);
    const extraTurnSink = request.onTurnEnd;
    const { systemPrompt, userTask, nudge, wrapUp } = renderSessionPrompts(
        request.terminalToolName,
        request.renderTask,
    );
    const outcome = await runAgentSession<T>({
        runtime: request.runtime,
        systemPrompt,
        userTask,
        nudge,
        wrapUp,
        terminal: request.terminal,
        tools: request.tools,
        budgets: {
            maxTurns: request.maxTurns,
            wallClockMs: request.wallClockMs,
            requestTimeoutMs: request.llm.requestTimeoutMs,
        },
        retries: { maxRetries: providerMaxRetries(request.llm) },
        reasoningEffort: request.llm.reasoningEffort,
        signal: request.signal,
        workDir: request.workDir,
        logger: request.logger,
        onTurnEnd:
            extraTurnSink === undefined
                ? recordTurn
                : (turn) => {
                      recordTurn(turn);
                      extraTurnSink(turn);
                  },
        onCompaction: compaction.observe,
        // Every mode records them: a call pi refused before `execute` reaches no tool wrapper, so
        // without this the submission and pi's reason are absent from the run evidence entirely.
        onToolBounce: recordToolBounce(recorder),
        onSessionUsage: (report) => usageCollector?.addSession(report),
    });
    if (usageCollector) {
        recorder.setUsageSummary(usageCollector.summary());
    }
    return { outcome, compactions: compaction.count() };
}
