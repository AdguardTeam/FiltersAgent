import path from 'node:path';
import {
    createAgentSession,
    DefaultResourceLoader,
    defineTool,
    SessionManager,
    SettingsManager,
    type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { ReasoningEffort } from '../config/reasoning-effort';
import { createLogger, type Logger } from '../logger/logger';
import { attachRunGuards } from './run-guards';
import { settleRun } from './run-sealing';
import type { PiRuntime } from './runtime';
import { attachSessionTelemetry, emitSessionUsage } from './session-telemetry';
import { type TerminalToolController } from './terminal-tool';
import { createToolCallObservation } from './tool-bounce';
import { unwrapStringifiedArguments } from './stringified-arguments';
import { toAdvertisedSchema } from './tool-schema';
import { extendRateLimitBackoff } from './rate-limit-retry';
import { extendTransientGatewayRetry } from './transient-gateway-retry';
import type { RunBudgets } from './guard-types';
import { SealKind, type TerminalOutcome } from './seal-types';
import {
    type CompactionObserver,
    type ToolBounceObserver,
    type TurnObserver,
} from './session-observations';
import { type SessionToolSpec } from './session-tool-types';
import { SESSION_LOGICAL_CWD } from './session-logical-paths';
import { logicalSkillsOverride, skillSessionTools, type SessionSkills } from './session-skills';
import type { UsageReport } from './usage-reporting';

/**
 * Agent session runner: the one seam the rest of the codebase talks to. Given a system prompt text,
 * a tool set, and the mode's terminal tool, it builds a pi agent session, runs one user task, and
 * returns a sealed Terminal Outcome. Every pi type is hidden behind this module; the runner never
 * throws for model/provider behavior — every ending seals as a typed outcome.
 *
 * The runner owns the tool-call observation boundary: it attaches `tool-bounce.ts` ONCE PER RUN in
 * `runAgentSession` — established before the first prompt and unsubscribed in the run's `finally`,
 * so the observation spans both prompt phases of the nudge flow. That attachment feeds the terminal
 * tool's rejection cap from pi's own tool events (pre-`execute` schema bounces and execute-thrown
 * rejections alike) and reports every call pi refused before `execute` to `onToolBounce`, which is
 * the only way such a call reaches the run evidence at all.
 *
 * Sealing paths: terminal acceptance, the rejection cap, the nudge-exhausted no-terminal diagnosis,
 * provider-failure after the configured retry bounds (or immediately for a non-transient message),
 * budget-exceeded from the wall-clock or iteration guards, and caller abort (mid-run or before the
 * run started). A provider response that goes silent is one of the transient failures: the provider
 * registration bounds it (`stream-silence.ts`) and pi retries it like any other. The two-phase
 * nudge flow and the sealed-outcome vocabulary live in `run-sealing.ts`, the turn-end and
 * compaction observation and the run's usage report in `session-telemetry.ts`, and the guards that
 * stop a run in `run-guards.ts`. `mode-session.ts` supplies the production prompt texts, budgets
 * and retry values per mode.
 */

/**
 * Logical pi agent dir shielding the real `~/.pi/agent`.
 *
 * With in-memory session/settings managers and an in-memory credential store nothing is read from
 * or written to it for session state (the knowledge-base analyze package proves this shape against
 * the same pi version); it exists so pi's settings, credentials and default resources never come
 * from the operator's home directory. Pi still lists `<agentDir>/skills` and `~/.agents/skills` on
 * every `reload()`, before `noSkills` drops what it found, so nothing is ever loaded from either.
 *
 * Exported so a suite can plant a skill exactly where pi's own agent-directory discovery would look
 * and prove the session never loads it.
 */
export const PI_AGENT_DIR = '.pi-agent';

/**
 * Configured bounds for retrying transient provider failures inside a run. Unset members keep pi's
 * defaults (3 retries, 2 s base).
 *
 * Three consequences of running retries through pi rather than through a transport of our own, none
 * of which the bounds themselves show:
 *
 * - Transience is pi's MESSAGE-based classification, not an HTTP status: it matches the composed
 *   `"<status>: <body>"` text against a substring/regex list (`overloaded`, `429`, `5xx`,
 *   `timeout`, `terminated`, `fetch failed`, `socket hang up`, …) and fails fast on quota/billing
 *   wording. Transport and timeout failures are covered by that list, but the match is textual, so
 *   a body that merely CONTAINS `500` classifies as transient. It is also incomplete for a gateway
 *   behind Cloudflare — the origin-side 52x/530 range is absent from it, so `runAgentSession`
 *   extends the session's decision through `transient-gateway-retry.ts`, within these same bounds.
 *   Single-shot calls do not use this path at all: they pass `maxRetries` into pi-ai's own
 *   status-based transport retry (408/409/429/5xx), which the agent loop leaves disabled — that one
 *   covers the whole 5xx range and therefore needs no extension. One gateway, two classifiers.
 * - Every retried attempt is a fresh agent run, so it emits its own `turn_end`: a transient failure
 *   consumes one of `RunBudgets.maxTurns` and is counted as a completion in the usage report.
 * - There is no per-tool failure budget: pi has no equivalent of ending a run after repeated tool
 *   failures, and only the terminal tool's rejection cap ends a run on rejections.
 */
export interface RunRetryBounds {
    /**
     * Agent-turn retries of transient provider failures, counted AFTER the initial attempt
     * (maxRetries: 2 means at most three provider requests for one failing turn). Derived from the
     * required `llm.requestMaxAttempts` by `providerMaxRetries`, so it is always stated.
     */
    maxRetries: number;

    /**
     * Base backoff in milliseconds; attempt n waits `baseDelayMs * 2^(n-1)`. Unset keeps pi's own
     * backoff.
     */
    baseDelayMs?: number;
}

/**
 * What the runner needs to execute one user task.
 */
export interface RunAgentSessionOptions<T> {
    /**
     * The configured pi runtime handle from `createPiRuntime` (held opaquely by callers).
     */
    runtime: PiRuntime;

    /**
     * The session's system prompt text. Passed through verbatim except for what pi appends: the
     * skills block, when the run carries a skill the model is shown, which lists each `SKILL.md`
     * under `SESSION_SKILLS_ROOT`, and the CWD line pi's agent-session constructor unconditionally
     * appends, which names `SESSION_LOGICAL_CWD`. Neither names the run's own directories, so for
     * the same prompt and the same skills the whole prefix is byte-identical across runs, machines
     * and CI jobs, which is what prompt-cache reuse needs.
     */
    systemPrompt: string;

    /**
     * The rendered user task the session runs to a seal.
     */
    userTask: string;

    /**
     * The nudge re-prompt sent exactly once when a turn ends without the terminal call. Callers
     * inject the rendered nudge template text; the prompt documents live with the mode wiring
     * (`mode-session.ts` renders them from the tracked prompt files).
     */
    nudge: string;

    /**
     * The steering message sent once when the wall-clock budget is about to expire, so the model
     * can still submit its decision; without it the run ends with no message of its own.
     */
    wrapUp?: string;

    /**
     * The mode's terminal tool controller (built by `buildTerminalTool`).
     */
    terminal: TerminalToolController<T>;

    /**
     * Non-terminal tools advertised for the whole session.
     */
    tools?: SessionToolSpec[];

    /**
     * The run's repository skills, when its checkout ships a skills directory. Absent keeps pi's
     * skill discovery off exactly as today; present passes the directory as the one explicit skill
     * path, lists its skills under `SESSION_SKILLS_ROOT`, and offers the confined `read` tool when
     * pi loaded at least one skill the model is shown.
     */
    skills?: SessionSkills;

    /**
     * Operational bounds of the run. The per-request deadline is required; the wall-clock and turn
     * bounds stay unbounded when unset (the runner invents no defaults). `mode-session.ts` passes
     * the production values.
     */
    budgets: RunBudgets;

    /**
     * Configured bounds for transient provider-failure retries, derived from the provider
     * configuration by `providerMaxRetries`.
     */
    retries: RunRetryBounds;

    /**
     * The session's thinking level, mapped to the configured API on every request of the run.
     * Required: `llm.reasoningEffort` is defaulted once at the env boundary, so this is always
     * stated and the runner never falls back to pi's own `medium`.
     */
    reasoningEffort: ReasoningEffort;

    /**
     * Caller cancellation; aborting seals the run as `aborted`, including when the signal is
     * already aborted before the run starts (sealed immediately, nothing dispatched).
     */
    signal?: AbortSignal;

    /**
     * The run's own directory (its artifacts root). It roots the shielded pi agent dir and nothing
     * else: pi lists the default resource folders under it but loads nothing from them, and writes
     * nothing there, since session state is held in memory. It deliberately does NOT reach the
     * session's logical cwd — see `SESSION_LOGICAL_CWD` for why the prompt must not carry a per-run
     * path.
     */
    workDir: string;

    /**
     * Optional pino logger for diagnostics the typed seals must not lose (prompt rejections folded
     * into no-terminal diagnoses are also logged); defaults to the application logger.
     */
    logger?: Logger;

    /**
     * Optional per-turn observer invoked after each completed pi turn with the observation used for
     * trace recording. Attached before the run starts and disposed with the run guards.
     */
    onTurnEnd?: TurnObserver;

    /**
     * Optional per-compaction observer invoked after each pi context compaction, carrying the
     * generated summary the rewrite left behind. Attached and disposed alongside `onTurnEnd`.
     */
    onCompaction?: CompactionObserver;

    /**
     * Optional observer invoked for every tool call pi refused before `execute` — a schema bounce
     * against the advertised parameters, a blocked or unknown tool — carrying the call's arguments
     * and pi's reason. Attached and disposed alongside `onTurnEnd`.
     */
    onToolBounce?: ToolBounceObserver;

    /**
     * Optional usage observer invoked exactly once per run — for EVERY seal kind, including the
     * pre-start abort (which fires an empty report: no session was built). The report is pi-free
     * and failures of the observer are swallowed (usage is observational and must not break a
     * sealed run).
     */
    onSessionUsage?: (report: UsageReport) => void;
}

/**
 * Map one seam tool spec onto a pi tool definition.
 *
 * @param spec - The pi-free tool specification.
 * @param terminal - Whether this is the mode's terminal tool; accepted results then carry pi's
 *   stop-after-batch hint.
 * @param markExecuted - Records that this call reached `execute`, which is what tells the run's
 *   tool-call observation a failed call apart from one pi refused before `execute`.
 * @param logger - Run logger; every argument the model sent as JSON text is logged when parsed.
 * @returns The pi tool definition to register as a custom tool.
 */
function toPiTool(
    spec: SessionToolSpec,
    terminal: boolean,
    markExecuted: (toolCallId: string) => void,
    logger: Logger,
): ToolDefinition {
    const parameters = toAdvertisedSchema(spec.parameters, spec.name);
    return defineTool({
        name: spec.name,
        label: spec.name,
        description: spec.description,
        parameters,
        // pi runs this on the raw arguments before its own schema check.
        prepareArguments: (args) => {
            const { args: prepared, unwrapped } = unwrapStringifiedArguments(args, parameters);
            if (unwrapped.length > 0) {
                logger.info(
                    { tool: spec.name, paths: unwrapped.map((argument) => argument.path) },
                    'parsed tool arguments the model sent as JSON text',
                );
            }
            return prepared;
        },
        ...(spec.executionMode === undefined ? {} : { executionMode: spec.executionMode }),
        execute: async (toolCallId, params, signal) => {
            markExecuted(toolCallId);
            const result = await spec.execute(params, signal);
            return {
                content: [{ type: 'text', text: result.content }],
                details: result.details,
                ...(terminal ? { terminate: true } : {}),
            };
        },
    });
}

/**
 * Build a pi agent session and run one user task to a sealed Terminal Outcome.
 *
 * The session advertises one frozen tool list (the terminal tool plus the given tools, plus the
 * confined `read` tool when the caller's skills directory loaded a skill the model is shown) from
 * its first request, holds every piece of configuration in memory, and uses the given system prompt
 * — verbatim except the skills block, listed under the logical skills root, and the constant CWD
 * line pi appends — with nothing loaded from any pi resource location except the repository skills
 * directory the caller names. The loader must be reloaded explicitly: `createAgentSession` only
 * reloads a loader IT constructs, and an unreloaded caller-supplied loader would silently drop the
 * custom prompt (verified against the installed dists).
 *
 * The run enforces exactly one nudge re-prompt when a turn ends in prose, the configured bounds for
 * retrying transient provider failures, and the run budgets (wall-clock, iteration backstop, and
 * the per-request provider deadline pi passes to every request); the two-phase flow and the
 * sealed-outcome vocabulary themselves live in `run-sealing.ts`, while this stays the only way to
 * run a session. The terminal-rejection observation is established once per run and spans both
 * prompt phases. Caller aborts seal as `aborted`, including a signal already aborted when this
 * function is entered — that seals immediately, without building or dispatching anything.
 *
 * @param options - Runtime, prompt texts, tool set, budgets, retry bounds, cancellation, work
 *   directory, and optional logger.
 * @returns The sealed outcome.
 */
export async function runAgentSession<T>(
    options: RunAgentSessionOptions<T>,
): Promise<TerminalOutcome<T>> {
    const logger = options.logger ?? createLogger();
    const runStartedAtMs = Date.now();
    if (options.signal?.aborted === true) {
        // pi's Agent.abort() only touches the ACTIVE run: firing a guard before any run exists
        // would record a Caller cause while the upcoming prompt proceeded normally. Seal cleanly
        // instead — no session, no request. Every seal kind still emits the usage report (here:
        // the empty report — no session was built).
        emitSessionUsage(options.onSessionUsage, { completions: [], durationMs: 0 }, logger);
        return { kind: SealKind.Aborted, message: 'run aborted before it started' };
    }
    const agentDir = path.join(options.workDir, PI_AGENT_DIR);
    const settingsManager = SettingsManager.inMemory({
        // Compaction is enabled DELIBERATELY, spelled out rather than inherited from pi's default:
        // a run that degrades through a lossy summary but still reaches a verdict beats a run that
        // dies at the context ceiling with nothing to show. The price is real — once the context
        // passes its threshold pi rewrites `agent.state.messages` into a generated summary, losing
        // the frozen prompt prefix this layer's cache reuse depends on and the evidence transcript
        // behind it — so the trade is paid for in visibility instead of being hidden: the telemetry
        // attachment subscribes to both compaction events, logs each, records a trace decision
        // event carrying the generated summary (the only evidence of what the model kept), counts
        // the summarization request as a completion of the run, and accumulates per-turn usage live
        // so the rewrite cannot erase turns from the usage report. reserveTokens/keepRecentTokens
        // stay at pi's defaults: nothing here knows better than pi how much of its own window to
        // hold back. It is switched back off the moment the run is over (see `endCompaction`).
        compaction: { enabled: true },
        retry: {
            enabled: true,
            maxRetries: options.retries.maxRetries,
            ...(options.retries.baseDelayMs === undefined
                ? {}
                : { baseDelayMs: options.retries.baseDelayMs }),
            provider: { timeoutMs: options.budgets.requestTimeoutMs },
        },
    });
    const resourceLoader = new DefaultResourceLoader({
        cwd: SESSION_LOGICAL_CWD,
        agentDir,
        settingsManager,
        systemPrompt: options.systemPrompt,
        // The last uncontrolled discovery input: `reload()` walks for
        // `<cwd>/.pi/APPEND_SYSTEM.md` and `<agentDir>/APPEND_SYSTEM.md` only while this option is
        // absent, so a stray file under the logical cwd or the run's own dir would mutate every
        // run's system prompt invisibly. An empty list is truthy, so the walk never runs.
        appendSystemPrompt: [],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        // The one discovery input the caller names explicitly. pi still lists its default skill
        // locations (`~/.agents/skills`, `<agentDir>/skills`), but `noSkills` drops whatever it
        // found there while `additionalSkillPaths` is still honoured, so a run without a skills
        // directory passes nothing and loads nothing. The override lists the skills under the
        // logical root, so the skills block names no per-run checkout path.
        ...(options.skills === undefined
            ? {}
            : {
                  additionalSkillPaths: [options.skills.dir],
                  skillsOverride: logicalSkillsOverride(options.skills.dir),
              }),
    });
    await resourceLoader.reload();
    const nonTerminalTools = [
        ...(options.tools ?? []),
        ...skillSessionTools(resourceLoader.getSkills(), options.skills),
    ];
    const toolSpecs = [...nonTerminalTools, options.terminal.tool];
    // Built before the session so the pi tool adapter can mark each executing call: the observation
    // needs pi's own call id to tell a refused call from one that ran and failed.
    const toolCalls = createToolCallObservation({
        terminal: options.terminal,
        ...(options.onToolBounce === undefined ? {} : { onBounce: options.onToolBounce }),
        logger,
    });
    const customTools = [
        ...nonTerminalTools.map((spec) => toPiTool(spec, false, toolCalls.markExecuted, logger)),
        toPiTool(options.terminal.tool, true, toolCalls.markExecuted, logger),
    ];
    const { session } = await createAgentSession({
        cwd: SESSION_LOGICAL_CWD,
        agentDir,
        modelRuntime: options.runtime.modelRuntime,
        model: options.runtime.reasoningModel,
        tools: toolSpecs.map((spec) => spec.name),
        customTools,
        resourceLoader,
        sessionManager: SessionManager.inMemory(SESSION_LOGICAL_CWD),
        settingsManager,
        // The configured API carries this thinking level on every eligible session request.
        // The default is resolved once at the environment boundary, so the session never inherits
        // pi's own medium default. With no thinkingLevelMap, pi supports off through high and
        // clamps higher levels to high. Off requests no thinking. ReasoningEffort uses pi's own
        // spellings, so a renamed level breaks this assignment at compile time.
        thinkingLevel: options.reasoningEffort,
    });
    // Applied to every session before the first prompt: pi's own retry classification does not know
    // the Cloudflare origin statuses this gateway answers with, and its retry settings carry no
    // hook to teach it. `transient-gateway-retry.ts` holds the whole pinned-vendor seam and the
    // reasons for it.
    extendTransientGatewayRetry(session, logger);
    // Pi's one backoff starts at seconds, and a provider rate limit does not clear in seconds:
    // `rate-limit-retry.ts` makes a rate-limited turn wait out the window first.
    extendRateLimitBackoff(session, logger);
    // pi checks compaction after EVERY agent run, the one the terminal tool ended included: the
    // last assistant message stops on `toolUse`, so the aborted-skip does not apply, and a run
    // sitting above the threshold would buy one full summarization request after its payload was
    // already accepted — and both `abort()` and `prompt()` wait for it. `_checkCompaction` reads
    // the setting at call time, so switching it off the moment the run is over (the terminal
    // settled, or a guard tripped) leaves compaction on exactly where it can still help: the
    // phase-1 → nudge transition.
    const endCompaction = (): void => settingsManager.setCompactionEnabled(false);
    void options.terminal.settled.then(endCompaction, endCompaction);
    // Both per-run subscriptions live here, closed in the same finally: the tool-call observation
    // (the single counting point feeding the cap, and the only record of a call pi refused before
    // execute; attached per run so it spans both prompt phases) and the run guards.
    const unsubscribeToolCalls = toolCalls.attach(session);
    const guards = attachRunGuards(session, {
        budgets: options.budgets,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.wrapUp === undefined ? {} : { wrapUp: options.wrapUp }),
        logger,
        onFired: endCompaction,
    });
    // Always attached, observers or not: it is the run's usage accounting, not just a trace feed.
    const telemetry = attachSessionTelemetry({
        session,
        startedAtMs: runStartedAtMs,
        model: options.runtime.reasoningModel.id,
        logger,
        ...(options.onTurnEnd === undefined ? {} : { onTurnEnd: options.onTurnEnd }),
        ...(options.onCompaction === undefined ? {} : { onCompaction: options.onCompaction }),
    });
    try {
        const outcome = await settleRun(
            session,
            {
                terminal: options.terminal,
                userTask: options.userTask,
                nudge: options.nudge,
                budgets: options.budgets,
            },
            guards,
            logger,
        );
        // Built from what the telemetry accumulated turn by turn, never from `session.messages`:
        // compaction rewrites that transcript, so a seal-time scan of it would report a compacted
        // run as the handful of turns that survived the rewrite.
        emitSessionUsage(options.onSessionUsage, telemetry.usageReport(), logger);
        return outcome;
    } finally {
        guards.dispose();
        unsubscribeToolCalls();
        telemetry.detach();
    }
}
