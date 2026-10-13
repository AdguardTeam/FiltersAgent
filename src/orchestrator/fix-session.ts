/**
 * Fix-mode pi session wiring: one runAgentSession per fix run on the frozen fix surface — the 28
 * registry tool names plus finish_fix — with lifecycle gate sync derived from the runtime's own
 * registry mutations, the shared diagnostic quarantine, the seeded lookup_rule_guidance stub, the
 * typed finish_fix terminal with a validateHost adapter over the runtime's terminal hook, the
 * rendered prompt documents, and the seal mapping back onto the `FixSessionRun` the fix core
 * consumes. There is no forced-tool-choice finalization turn: a host-rejected submission returns to
 * the model as a tool error, and the terminal's streak cap counts resubmissions at the same
 * evidence progress (`terminal-rejection-fingerprint.ts`).
 */
import { TraceEventType } from '../types/trace';
import { createToolEnumerationBackstop } from './tool-enumeration-backstop';
import { ToolName } from '../agent/tool-names';
import type { ToolRegistry } from '../agent/tool-registry';
import type { LlmConfig } from '../config/config';
import type { LoadedInstruction } from '../knowledge/instruction-loader';
import { extractPreparationSection } from '../knowledge/instruction-preparation';
import { isIncorrectBlockingReport, type IssueFacts } from '../types/issue-facts';
import type { TraceRecorder } from '../tracer/trace-recorder';
import { createLogger, type Logger } from '../logger/logger';
import type { FixOutcome } from '../types/fix-outcome';
import { PromptDocumentLoader, PromptDocumentName } from '../prompts/prompt-documents';
import { recordTerminalTool, withExecutionRecording } from '../tracer/session-trace';
import type { PiRuntime } from '../pi/runtime';
import type { RunUsageCollector } from '../pi/usage-collector';
import { buildFixSessionTools } from './fix-session-gates';
import {
    launchBrowserSessionDescriptions,
    launchBrowserSessionParameters,
} from './launch-browser-arguments';
import type { PreparedExtension } from '../local/prepared-extension';
import { createObservationSink } from './fix-session-observations';
import { launchModeSession } from '../session/mode-session';
import { sealFixTrace, type FixSessionRun } from './fix-session-seal';
import { buildFixTerminal, type FixTerminalHost } from './fix-session-terminal';

/**
 * The runtime slice the fix session consumes: its live registry as the dispatch bus, the per-run
 * tool descriptions composed from its executor set, and the terminal outcome hook it shares with
 * the terminal builder. `AgentRuntime` satisfies it; tests use a narrow stub.
 */
export interface FixSessionRuntime extends FixTerminalHost {
    /**
     * The runtime's live tool registry (names, dispatch, and lifecycle mutations).
     */
    registry: ToolRegistry;

    /**
     * Per-run model-facing description overrides the runtime composed from its own state, keyed by
     * tool name; the sole-executor wired composition leaves the map empty.
     */
    sessionToolDescriptions?(): Readonly<Record<string, string>>;

    /**
     * The run's one host-prepared extension build, when it prepared one.
     *
     * The session reads it for exactly one thing: `launch_browser`'s shape and description follow
     * the prepared blocker's family, because a Firefox-family build has no host-writable settings
     * surface for the model to select into.
     *
     * @returns The prepared build, or undefined for a run that prepared none.
     */
    getPreparedExtension?(): PreparedExtension | undefined;
}

/**
 * What one fix session needs: pi runtime, the agent runtime surface, run recorder, issue identity,
 * selection policy, the routing-check flag, operational bounds, and caller cancellation.
 */
export interface FixSessionOptions {
    /**
     * The configured pi runtime handle.
     */
    piRuntime: PiRuntime;

    /**
     * The agent runtime whose registry is the dispatch bus.
     */
    runtime: FixSessionRuntime;

    /**
     * The run trace recorder.
     */
    recorder: TraceRecorder;

    /**
     * Parsed issue facts (drives targeting guidance selection and app-visible checks).
     */
    facts: IssueFacts;

    /**
     * Issue number rendered into the fix task.
     */
    issueNumber: number;

    /**
     * Stop the run right after the accepted environment selection (routing check).
     */
    routingCheck: boolean;

    /**
     * The validated LLM provider configuration: the one place the per-request deadline and the
     * provider retry bound are derived from, exactly as every other mode session derives them.
     */
    llm: LlmConfig;

    /**
     * Operational bounds mapped onto the pi runner.
     */
    budgets: {
        /**
         * Wall-clock investigation budget.
         */
        wallClockMs: number;

        /**
         * Runaway iteration backstop.
         */
        maxTurns: number;
    };

    /**
     * Logical work dir for pi's CWD line and shielded session state.
     */
    workDir: string;

    /**
     * Caller cancellation (composed with the routing latch).
     */
    signal?: AbortSignal;

    /**
     * Optional pino logger for wiring diagnostics.
     */
    logger?: Logger;

    /**
     * The run instruction loaded at run start, when this run carries one. Its text and linked
     * document roster ride the fix task's `{{instructionContext}}` fill; absent (built-in mode)
     * keeps the fill '' and the session renders byte-comparably to today's runs.
     */
    instruction?: LoadedInstruction;

    /**
     * Optional run-scoped usage collector threaded from the fix core; session usage lands in it and
     * the sealed trace carries the rendered summary block.
     */
    usageCollector?: RunUsageCollector;
}

/**
 * Render the fix task's run-instruction fill from one loaded instruction.
 *
 * The scaffolding prose (headings, the standing missing-information direction) lives in the
 * `tasks/instruction-context` document; this render only supplies its data fills — the exact
 * instruction text, one roster line per linked document, and the preparation note. Absent
 * instruction keeps the fill '' so built-in runs render no instruction context.
 *
 * The instruction text rides the task verbatim because the instruction governs investigation and
 * proposals, but its preparation section does not govern this session: the host runs that section
 * in its own preparation session before any fix session exists (`prepareRunExtension` in
 * `pre-run-preparation.ts`, called from the fix core before `AgentRuntime.create`), and it is
 * skipped only for a run whose executor set consumes no extension build — where nothing would board
 * a prepared build either. Either way the steps are unreachable from here: the fix surface
 * advertises no shell or command execution at all. A model that reads the section as its own to
 * perform spends the ending on `No shell tool for the run instruction's XPI preparation steps`, for
 * an XPI the host has already downloaded, verified and force-installed.
 *
 * @param prompts - The session's prompt document loader.
 * @param instruction - The run instruction, or undefined for built-in mode.
 * @returns The rendered instruction context, or '' when the run carries none.
 */
function renderInstructionContext(
    prompts: PromptDocumentLoader,
    instruction: LoadedInstruction | undefined,
): string {
    if (!instruction) {
        return '';
    }
    const linkedDocuments = instruction.documents
        .map((document) => `- ${document.role} (${document.origin}): ${document.url}`)
        .join('\n');
    const preparationContext =
        extractPreparationSection(instruction.content) === undefined
            ? ''
            : prompts.render(PromptDocumentName.FixTaskInstructionPreparationDone);
    return prompts.render(PromptDocumentName.FixTaskInstructionContext, {
        instructionText: instruction.content,
        linkedDocuments,
        preparationContext,
    });
}

/**
 * Run the fix session for one issue and return the fix-run-shaped result.
 *
 * @param options - The session options.
 * @returns The fix-run-shaped result.
 */
export async function runFixSession(options: FixSessionOptions): Promise<FixSessionRun> {
    const logger = options.logger ?? createLogger();
    const routingController = options.routingCheck ? new AbortController() : undefined;
    const latchState = { fired: false };
    const sink = createObservationSink();
    const preparedExtension = options.runtime.getPreparedExtension?.();
    // The environment context follows the exact fact the tool surface follows: `select_environment`
    // is advertised only while the registry holds it, and a sole-executor run — its environment
    // locked at construction — never holds it. Rendering the selection-first framing there tells
    // the model to call a tool this session does not advertise, and the model reports a
    // `select_environment tool not advertised in this session` limitation instead of investigating.
    const environmentLocked = !options.runtime.registry
        .getToolNames()
        .includes(ToolName.SelectEnvironment);
    const enumerationBackstop = createToolEnumerationBackstop({
        onStreak: (streak) => {
            logger.warn(
                { tool: streak.tool, consecutiveCalls: streak.consecutiveCalls },
                'consecutive same-tool streak reached the enumeration bound; the model was asked ' +
                    'to stop repeating the call and act on the results it has',
            );
            options.recorder.record(TraceEventType.Decision, {
                phase: 'tool_enumeration_streak',
                tool: streak.tool,
                consecutiveCalls: streak.consecutiveCalls,
            });
        },
    });
    const tools = buildFixSessionTools(
        {
            registry: options.runtime.registry,
            routingCheck: options.routingCheck,
            enumerationBackstop,
            descriptionOverrides: {
                ...options.runtime.sessionToolDescriptions?.(),
                ...launchBrowserSessionDescriptions(preparedExtension),
            },
            parameterOverrides: launchBrowserSessionParameters(preparedExtension),
        },
        sink,
        () => {
            latchState.fired = true;
            routingController?.abort();
        },
    );
    const acceptingTurnState = { index: -1 };
    const terminalState = buildFixTerminal(options.runtime, options.recorder, () => {
        acceptingTurnState.index = sink.currentTurn();
    });
    const { outcome, compactions } = await launchModeSession<FixOutcome>({
        runtime: options.piRuntime,
        llm: options.llm,
        recorder: options.recorder,
        terminalToolName: ToolName.FinishFix,
        renderTask: (prompts, terminalToolName) =>
            prompts.render(PromptDocumentName.FixTask, {
                environmentContext: prompts.render(
                    environmentLocked
                        ? PromptDocumentName.FixContextPreOrchestrated
                        : PromptDocumentName.FixContextSelectionFirst,
                    { issueNumber: String(options.issueNumber) },
                ),
                terminalToolName,
                targetingGuidance: prompts.render(
                    isIncorrectBlockingReport(options.facts.problemType)
                        ? PromptDocumentName.FixTargetingIncorrectBlocking
                        : PromptDocumentName.FixTargetingAds,
                ),
                screenshotContext: '',
                preAgentEvidenceContext: '',
                settingsContext: '',
                instructionContext: renderInstructionContext(prompts, options.instruction),
                candidateConfirmation: '',
            }),
        terminal: recordTerminalTool(terminalState.controller, options.recorder),
        tools: tools.map((spec) => withExecutionRecording(spec, options.recorder)),
        maxTurns: options.budgets.maxTurns,
        wallClockMs: options.budgets.wallClockMs,
        workDir: options.workDir,
        logger,
        signal:
            options.signal !== undefined && routingController !== undefined
                ? AbortSignal.any([options.signal, routingController.signal])
                : (options.signal ?? routingController?.signal),
        usageCollector: options.usageCollector,
        onTurnEnd: sink.onTurnEnd,
    });
    return sealFixTrace(outcome, options, {
        routingFired: latchState.fired,
        acceptingTurn: acceptingTurnState.index,
        sink,
        compactions,
        lastRejectedOutcome: terminalState.lastRejectedOutcome(),
    });
}
