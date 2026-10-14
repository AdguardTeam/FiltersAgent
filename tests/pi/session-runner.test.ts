import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import * as v from 'valibot';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { type PiRuntime } from '../../src/pi/runtime';
import {
    type RunAgentSessionOptions,
    runAgentSession,
    type RunRetryBounds,
} from '../../src/pi/session-runner';
import {
    type AbortedSealed,
    type BudgetExceededSealed,
    type NoTerminalSealed,
    type ProviderFailureSealed,
    RejectionCap,
    type RejectedTerminalSealed,
    SealKind,
    type TerminalSealed,
} from '../../src/pi/seal-types';
import { GuardCause, type RunBudgets } from '../../src/pi/guard-types';
import {
    buildTerminalTool,
    TerminalSettlement,
    type TerminalToolOptions,
} from '../../src/pi/terminal-tool';
import { createToolCallObservation } from '../../src/pi/tool-bounce';
import type { SessionToolResult, SessionToolSpec } from '../../src/pi/session-tool-types';
import {
    type HermeticProvider,
    type HermeticUsageSpec,
    HermeticScenario,
    type ScriptedReply,
    ScriptedReplyKind,
    startHermeticProvider,
    type StreamPacing,
} from './hermetic-provider';
import type { UsageReport } from '../../src/pi/usage-reporting';
import type { Logger } from '../../src/logger/logger';
import {
    CompactionReason,
    type SessionCompactionObservation,
    type ToolBounceObserver,
} from '../../src/pi/session-observations';
import type { SessionTurnObservation } from '../../src/pi/session-observations';
import { createRunUsageCollector } from '../../src/pi/usage-collector';
import { createRuntimeTraceRecorder } from '../../src/tracer/runtime-recorder';
import {
    COMPACTION_DECISION_PHASE,
    recordSessionCompaction,
    recordSessionTurn,
    recordToolBounce,
    SEAL_DECISION_PHASE,
    sealSessionTrace,
} from '../../src/tracer/session-trace';
import { RunMode, TraceEventType, type RunTrace } from '../../src/types/trace';
import { ReasoningEffort } from '../../src/config/reasoning-effort';
import { UsageCompleteness } from '../../src/types/usage-status';
import {
    REASONING_MODEL,
    TEST_MAX_OUTPUT_TOKENS,
    TEST_REASONING_EFFORT,
    TEST_RUN_BUDGETS,
    TEST_RUN_RETRIES,
    createTestPiRuntime,
} from './test-runtime';

const TERMINAL_TOOL_NAME = 'submit_verdict';
const NUDGE_TEXT = 'You ended your turn without calling submit_verdict. Call it now.';

const VerdictSchema = v.object({
    verdict: v.picklist(['ok', 'retry']),
    summary: v.string(),
});
type Verdict = v.InferOutput<typeof VerdictSchema>;

const VALID_PAYLOAD: Verdict = { verdict: 'ok', summary: 'all good' };

/**
 * Character ceiling advertised on the terminal summary. Small enough that one scripted reply can
 * overshoot it by a plausible margin — the live failure this exists for was a summary 39 characters
 * over its limit, resubmitted until the run sealed.
 */
const MAX_SUMMARY_CHARS = 40;

/**
 * The terminal schema with a bound pi can enforce itself: the bound is advertised verbatim, so an
 * over-long summary is refused by pi's pre-execute check and never reaches `execute`.
 */
const BoundedVerdictSchema = v.object({
    verdict: v.picklist(['ok', 'retry']),
    summary: v.pipe(v.string(), v.maxLength(MAX_SUMMARY_CHARS)),
});

/**
 * One over-long summary payload, `extra` characters past the advertised ceiling.
 *
 * @param extra - How far past the ceiling this submission goes.
 * @returns The scripted terminal payload.
 */
function overlongVerdict(extra: number) {
    return { verdict: 'ok', summary: 'x'.repeat(MAX_SUMMARY_CHARS + extra) };
}

/**
 * The per-path issue line pi reports for a summary past the advertised ceiling. Its wording is
 * irrelevant; what matters is that both bounces of the unpaired-branch suite carry the SAME one, so
 * the payloads are the only thing that differs between them.
 */
const OVERLONG_SUMMARY_ISSUE = `  - /summary: Expected string length less or equal to ${MAX_SUMMARY_CHARS}`;

/**
 * Compose one pre-`execute` validation bounce the way pi does: the per-path issue lines, then the
 * whole submission echoed back (pi-ai `utils/validation.js`, verified against the installed dist).
 *
 * @param submission - The arguments pi echoes at the end of the message.
 * @returns The model-facing bounce text.
 */
function piValidationBounce(submission: unknown): string {
    return [
        `Validation failed for tool "${TERMINAL_TOOL_NAME}":`,
        OVERLONG_SUMMARY_ISSUE,
        '',
        'Received arguments:',
        JSON.stringify(submission, null, 2),
    ].join('\n');
}

/**
 * One refused-call end event with no `tool_execution_start` before it, typed by pi's own session
 * event union so the fixture cannot drift from the contract the observation subscribes to.
 *
 * @param toolCallId - Pi's id for the refused call.
 * @param text - The model-facing bounce text pi returned.
 * @returns The session event to deliver.
 */
function unpairedBounce(toolCallId: string, text: string): AgentSessionEvent {
    return {
        type: 'tool_execution_end',
        toolCallId,
        toolName: TERMINAL_TOOL_NAME,
        result: { content: [{ type: 'text', text }], details: {} },
        isError: true,
    };
}

/**
 * A logger that swallows every level, for a suite that deliberately provokes a diagnostic.
 *
 * @returns The silent logger.
 */
function silentLogger(): Logger {
    return {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
    } as unknown as Logger;
}

/**
 * A deliberately small registered context window, so a compaction suite can reach the threshold
 * band with a plausible token count instead of a million-token one.
 */
const SMALL_CONTEXT_WINDOW_TOKENS = 128_000;

/**
 * Prompt tokens a turn reports to put the run into pi's THRESHOLD compaction band for
 * `SMALL_CONTEXT_WINDOW_TOKENS`: above the compaction threshold (window minus pi's default 16,384
 * reserve, so 111,616) and still inside the window. A larger count would report a context the
 * window cannot hold at all, which pi classifies as `overflow` and recovers differently; this is
 * the ordinary "the run outgrew its context" case.
 */
const OVER_THRESHOLD_PROMPT_TOKENS = 120_000;

/**
 * An assistant reply long enough for pi to find a compaction cut point: it keeps the most recent
 * ~20k estimated tokens intact, so only a run whose transcript is bigger than that is compactable.
 */
const COMPACTABLE_REPLY = 'thinking out loud '.repeat(8_000);

/**
 * The scripted model's answer to pi's summarization request. It is the only marker that proves the
 * text pi generated for the compaction actually travelled into the trace event.
 */
const COMPACTION_SUMMARY_TEXT = 'Compacted: the agent must still submit the verdict.';

/**
 * Per-request deadline the two stream suites share. Small enough that both a stalled stream and a
 * live one cross it within a test's patience, and the same number for both so the ONLY difference
 * between the two runs is whether the stream keeps producing.
 */
const STALL_DEADLINE_MS = 300;

/**
 * Gap between the paced deltas of the live-stream suite: comfortably inside `STALL_DEADLINE_MS`, so
 * no single gap can trip the guard.
 */
const SLOW_STREAM_INTERVAL_MS = 100;

/**
 * Paced deltas of the live-stream suite. `SLOW_STREAM_DELTAS * SLOW_STREAM_INTERVAL_MS` puts the
 * response's total length several times past `STALL_DEADLINE_MS` — the exact condition that used to
 * seal a live run budget-exceeded.
 */
const SLOW_STREAM_DELTAS = 10;

let workDir: string;
let provider: HermeticProvider | undefined;

beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'pi-session-runner-'));
});

afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
});

afterEach(async () => {
    if (!provider) {
        return;
    }
    await provider.close();
    provider = undefined;
});

/**
 * One scripted terminal tool-call reply.
 *
 * @param payload - The payload the scripted model submits.
 * @param pacing - Optional delta pacing, to serve the call over a live-but-slow stream instead of
 *   in one burst.
 * @returns The scripted reply.
 */
function verdictCall(payload: unknown, pacing?: StreamPacing): ScriptedReply {
    return {
        kind: ScriptedReplyKind.ToolCall,
        toolName: TERMINAL_TOOL_NAME,
        toolArguments: JSON.stringify(payload),
        ...(pacing === undefined ? {} : { pacing }),
    };
}

/**
 * Extra knobs of one scripted run.
 */
interface ScriptedRunOptions {
    terminal?: Partial<TerminalToolOptions<Verdict>>;
    responseModel?: string;
    tools?: SessionToolSpec[];
    scenario?: HermeticScenario;
    scriptExhausted?: ScriptedReply;
    budgets?: Partial<RunBudgets>;
    retries?: Partial<RunRetryBounds>;
    reasoningEffort?: ReasoningEffort;
    signal?: AbortSignal;
    onSessionUsage?: (report: UsageReport) => void;
    onTurnEnd?: (observation: SessionTurnObservation) => void;
    onCompaction?: (observation: SessionCompactionObservation) => void;
    onToolBounce?: ToolBounceObserver;
    logger?: Logger;
    usage?: HermeticUsageSpec | null;
    contextWindowTokens?: number;
}

/**
 * Run one session against a scripted hermetic provider.
 *
 * @param script - The reply sequence the provider serves.
 * @param options - Terminal overrides, tools, scenario, budgets, retry bounds, and cancellation.
 * @returns The sealed outcome and the provider's recorded requests.
 */
async function runScripted(script: ScriptedReply[], options: ScriptedRunOptions = {}) {
    provider = await startHermeticProvider({
        scenario: options.scenario ?? HermeticScenario.Scripted,
        script,
        ...(options.responseModel === undefined ? {} : { responseModel: options.responseModel }),
        ...(options.scriptExhausted === undefined
            ? {}
            : { scriptExhausted: options.scriptExhausted }),
        ...(options.usage === undefined ? {} : { usage: options.usage }),
    });
    const runtime: PiRuntime = await createTestPiRuntime({
        baseUrl: provider.baseUrl,
        ...(options.contextWindowTokens === undefined
            ? {}
            : { contextWindowTokens: options.contextWindowTokens }),
    });
    const terminal = buildTerminalTool<Verdict>({
        name: TERMINAL_TOOL_NAME,
        description: 'Submit the final verdict.',
        schema: options.terminal?.schema ?? VerdictSchema,
        validateHost: options.terminal?.validateHost,
        maxRejections: options.terminal?.maxRejections,
    });
    const outcome = await runAgentSession<Verdict>({
        runtime,
        systemPrompt: 'You are a test agent. Finish by calling submit_verdict.',
        userTask: 'Submit the verdict now.',
        nudge: NUDGE_TEXT,
        terminal,
        tools: options.tools,
        budgets: { ...TEST_RUN_BUDGETS, ...options.budgets },
        retries: { ...TEST_RUN_RETRIES, ...options.retries },
        reasoningEffort: options.reasoningEffort ?? TEST_REASONING_EFFORT,
        signal: options.signal,
        workDir,
        onSessionUsage: options.onSessionUsage,
        onTurnEnd: options.onTurnEnd,
        onCompaction: options.onCompaction,
        onToolBounce: options.onToolBounce,
        logger: options.logger,
    });
    return { outcome, requests: provider.requests };
}

describe('runAgentSession', () => {
    it('seals via the terminal tool with the validated payload', async () => {
        const { outcome, requests } = await runScripted([verdictCall(VALID_PAYLOAD)]);

        expect(outcome.kind).toBe(SealKind.Terminal);
        if (outcome.kind !== SealKind.Terminal) {
            return;
        }
        expect(outcome.payload).toEqual(VALID_PAYLOAD);
        expect(outcome.rejections).toBe(0);
        expect(requests).toHaveLength(1);
    });

    it('advertises the faithfully converted terminal parameters from the first request', async () => {
        const { requests } = await runScripted([verdictCall(VALID_PAYLOAD)]);

        const tools = requests[0]!.tools as {
            function: { name: string; parameters: Record<string, unknown> };
        }[];
        const advertised = tools.find((tool) => tool.function.name === TERMINAL_TOOL_NAME);
        expect(advertised).toBeDefined();
        // The faithful conversion: pi pre-validates against this shape, so it is the contract the
        // model is guided AND filtered by, and it must never be stricter than the Valibot re-check
        // that owns the typed rejection.
        expect(advertised!.function.parameters).toEqual({
            type: 'object',
            properties: {
                verdict: { type: 'string', enum: ['ok', 'retry'] },
                summary: { type: 'string' },
            },
            required: ['verdict', 'summary'],
        });
    });

    it('sends the configured reasoning effort and the completion cap on every request', async () => {
        // The configured level must reach the wire on EVERY request of the run, not just the
        // first: it is a session-wide setting, and a run whose nudge turn thought less than its
        // opening turn would be neither reproducible nor comparable across a benchmark. Pi's own
        // default is `medium`, so pinning the value here is what keeps the configuration — rather
        // than a pi upgrade — deciding it. The completion cap cannot be suppressed at all and is
        // pinned alongside for the same reason.
        const { requests } = await runScripted([
            { kind: ScriptedReplyKind.Text, text: 'thinking about it' },
            verdictCall(VALID_PAYLOAD),
        ]);

        expect(requests).toHaveLength(2);
        for (const request of requests) {
            expect(request.reasoningEffort).toBe(ReasoningEffort.High);
            // The LOOP model's own configured cap, not the vision one and not pi's default: a
            // cap a thinking burst can exhaust truncates the terminal submission that follows it.
            expect(request.maxCompletionTokens).toBe(TEST_MAX_OUTPUT_TOKENS);
        }
    });

    it('sends the system prompt under the system role, never developer', async () => {
        // pi-ai puts the system prompt under `developer` for any model registered
        // `reasoning: true` unless the catalog entry says otherwise, and the gateway's upstream
        // pool is not uniform on that role: a live campaign had one replica answer 400 "unknown
        // variant `developer`" on the 26th request of a session whose first 25 had been accepted
        // elsewhere. `system` is the one role every OpenAI-shaped upstream understands, so the
        // reasoning model's registration must pin it — the wire is the only place that shows.
        const { requests } = await runScripted([verdictCall(VALID_PAYLOAD)]);

        expect(requests[0]!.messages[0]!.role).toBe('system');
    });

    it('carries a lowered reasoning effort onto the wire unchanged', async () => {
        // The other half of the contract: the runner sends what it was given, so the level is a
        // knob the configuration turns rather than a constant compiled into the harness. `low` is
        // inside the set pi supports for this catalog entry, so nothing clamps it on the way.
        const { requests } = await runScripted([verdictCall(VALID_PAYLOAD)], {
            reasoningEffort: ReasoningEffort.Low,
        });

        expect(requests[0]!.reasoningEffort).toBe(ReasoningEffort.Low);
    });

    it('lets the Valibot re-check strip a stray key pi would otherwise bounce', async () => {
        // The terminal schema is a plain `v.object`, which strips an unknown key and accepts. An
        // advertisement claiming `additionalProperties: false` made pi's pre-execute check stricter
        // than the authoritative re-check, so a model that adds one stray field burned rejection
        // budget on a payload this run accepts.
        const { outcome, requests } = await runScripted([
            verdictCall({ ...VALID_PAYLOAD, confidence: 'high' }),
        ]);

        expect(outcome.kind).toBe(SealKind.Terminal);
        if (outcome.kind !== SealKind.Terminal) {
            return;
        }
        expect(outcome.payload).toEqual(VALID_PAYLOAD);
        expect(outcome.rejections).toBe(0);
        expect(requests).toHaveLength(1);
    });

    it('returns a pi schema rejection as a tool error and seals with the corrected payload', async () => {
        // `{ verdict: 'maybe' }` fails the advertised picklist BEFORE execute runs: pi bounces
        // it with its own validation wording, the runner counts it through the
        // tool_execution_end observation, and the corrected call seals the run.
        const { outcome, requests } = await runScripted([
            verdictCall({ verdict: 'maybe' }),
            verdictCall(VALID_PAYLOAD),
        ]);

        expect(outcome.kind).toBe(SealKind.Terminal);
        if (outcome.kind !== SealKind.Terminal) {
            return;
        }
        expect(outcome.payload).toEqual(VALID_PAYLOAD);
        expect(outcome.rejections).toBe(1);
        expect(requests).toHaveLength(2);
        const toolMessages = requests[1]!.messages.filter((m) => m.role === 'tool');
        const toolText = JSON.stringify(toolMessages);
        // pi's wording, not ours — assert only what it contractually carries: the tool name and
        // the offending property path (verified against the installed dists).
        expect(toolText).toContain(TERMINAL_TOOL_NAME);
        expect(toolText).toContain('verdict');
    });

    it('accepts pi-coerced primitive arguments through the Valibot re-check', async () => {
        // pi's pre-execute validation coerces `summary: 1` to '1' (Value.Convert against the
        // advertised string type); the Valibot re-check inside execute then accepts the
        // coerced value. Documented boundary of the strict-advertisement decision.
        const { outcome } = await runScripted([verdictCall({ verdict: 'ok', summary: 1 })]);

        expect(outcome.kind).toBe(SealKind.Terminal);
        if (outcome.kind !== SealKind.Terminal) {
            return;
        }
        expect(outcome.payload).toEqual({ verdict: 'ok', summary: '1' });
    });

    it('returns host-hook rejections as tool errors and seals with the corrected payload', async () => {
        const { outcome, requests } = await runScripted(
            [
                verdictCall({ verdict: 'ok', summary: 'stale' }),
                verdictCall({ verdict: 'ok', summary: 'fresh' }),
            ],
            {
                terminal: {
                    validateHost: (payload) =>
                        payload.summary === 'stale'
                            ? { reason: 'evidence is stale, refresh it' }
                            : undefined,
                },
            },
        );

        expect(outcome.kind).toBe(SealKind.Terminal);
        if (outcome.kind !== SealKind.Terminal) {
            return;
        }
        expect(outcome.payload.summary).toBe('fresh');
        expect(outcome.rejections).toBe(1);
        expect(JSON.stringify(requests[1]!.messages)).toContain('evidence is stale');
    });

    it('reports every rejection in the seal, not just the last same-reason streak', async () => {
        // Two DIFFERENT rejection reasons: each one restarts the cap's streak, but the run still
        // rejected two submissions and the seal is what an operator reads.
        const { outcome } = await runScripted([
            verdictCall({ verdict: 'maybe', summary: 'first try' }),
            verdictCall({ verdict: 'ok' }),
            verdictCall(VALID_PAYLOAD),
        ]);

        expect(outcome.kind).toBe(SealKind.Terminal);
        if (outcome.kind !== SealKind.Terminal) {
            return;
        }
        expect(outcome.rejections).toBe(2);
    });

    it('attributes usage to the configured model id, not the gateway echo', async () => {
        // The pricing table is keyed by the id the run asked for; a gateway answers with its own
        // build name, and attributing to that silently prices the entire run at null.
        const reports: UsageReport[] = [];
        await runScripted([verdictCall(VALID_PAYLOAD)], {
            responseModel: 'DeepSeek-V4-Flash-0731',
            onSessionUsage: (report) => reports.push(report),
        });

        const models = reports.flatMap((report) =>
            report.completions.map((completion) => completion.model),
        );
        expect(models.length).toBeGreaterThan(0);
        expect(models.every((model) => model === REASONING_MODEL)).toBe(true);
    });

    it('seals as rejected-terminal with the last reason when the cap is reached', async () => {
        // Both submissions are schema-invalid, so pi bounces them BEFORE execute — a cap that
        // only counted execute-side rejections could never fire here. With observation-channel
        // counting both bounces are counted, and repeating the SAME invalid payload is what the
        // cap exists for: the model is stuck rather than converging.
        const { outcome, requests } = await runScripted(
            [verdictCall({ verdict: 'maybe' }), verdictCall({ verdict: 'maybe' })],
            { terminal: { maxRejections: 2 } },
        );

        expect(outcome.kind).toBe(SealKind.RejectedTerminal);
        if (outcome.kind !== SealKind.RejectedTerminal) {
            return;
        }
        // The reason is pi's validation text, which contractually names the tool (verified
        // against the installed dists).
        expect(outcome.lastReason).toContain(TERMINAL_TOOL_NAME);
        expect(outcome.rejections).toBe(2);
        // The cap settled inside the inline-awaited event listener and the runner aborted the
        // session: no third completion request was made.
        expect(requests).toHaveLength(2);
    });

    it('records a bounced submission in the trace with the field and the reason', async () => {
        // pi refuses a bound violation BEFORE `execute`, so no tool wrapper sees it: without the
        // bounce observation the run evidence shows a tool name on the turn event and nothing
        // else — not the payload, not why it was refused. That is the exact benchmark failure the
        // streak cap was relaxed for (a summary 39 characters over its limit, resubmitted).
        const recorder = createRuntimeTraceRecorder({
            runId: 'bounced-run',
            issueNumber: 12,
            mode: RunMode.Fix,
        });

        const { outcome } = await runScripted([verdictCall(overlongVerdict(39))], {
            terminal: { schema: BoundedVerdictSchema, maxRejections: 1 },
            onToolBounce: recordToolBounce(recorder),
        });

        expect(outcome.kind).toBe(SealKind.RejectedTerminal);
        const trace = sealSessionTrace(recorder, outcome);
        const call = trace.events.find((event) => event.type === TraceEventType.ToolCall);
        const result = trace.events.find((event) => event.type === TraceEventType.ToolResult);
        expect(call!.payload['tool']).toBe(TERMINAL_TOOL_NAME);
        // The submission itself, which exists nowhere else once the call never executes.
        expect((call!.payload['args'] as Record<string, unknown>)['summary']).toContain('x');
        const rejection = result!.payload['result'] as Record<string, unknown>;
        expect(rejection['rejectedBeforeExecution']).toBe(true);
        // The offending field and pi's own reason, so an operator learns WHICH bound was missed.
        expect(String(rejection['error'])).toContain('summary');
        expect(String(rejection['error'])).toContain(TERMINAL_TOOL_NAME);
    });

    it('records a non-object submission verbatim instead of an empty argument record', async () => {
        // Pi's JSON repair can hand back an array (or a string, or a number) where the tool
        // parameters demand an object; TypeBox bounces it as a type error before `execute`, so
        // this observation is the only place the payload exists. Projecting it onto an empty
        // record recorded a refusal with nothing refused.
        const recorder = createRuntimeTraceRecorder({
            runId: 'raw-payload-run',
            issueNumber: 12,
            mode: RunMode.Fix,
        });

        const { outcome } = await runScripted([verdictCall([VALID_PAYLOAD]), verdictCall('ok')], {
            terminal: { maxRejections: 2 },
            onToolBounce: recordToolBounce(recorder),
        });

        expect(outcome.kind).toBe(SealKind.RejectedTerminal);
        const trace = sealSessionTrace(recorder, outcome);
        const args = trace.events
            .filter((event) => event.type === TraceEventType.ToolCall)
            .map((event) => event.payload['args']);
        // An array would otherwise be filed under numeric keys and read as an object the model
        // never sent; a bare string became an empty record and vanished entirely.
        expect(args).toEqual([{ rawArguments: [VALID_PAYLOAD] }, { rawArguments: 'ok' }]);
    });

    it('counts two bounces off the same wall as one streak and persists no payload', async () => {
        // pi echoes the whole submission back inside its validation text. Carried through
        // verbatim, that made the same-reason streak a byte-comparison of payloads — a model
        // shortening its summary by one character never "repeats" a reason — and put a whole fix
        // outcome into the persisted `lastReason` the seal, the host summary and the campaign
        // reports read. Two differing over-long payloads, one wall, one streak.
        const { outcome, requests } = await runScripted(
            [verdictCall(overlongVerdict(39)), verdictCall(overlongVerdict(7))],
            { terminal: { schema: BoundedVerdictSchema, maxRejections: 2 } },
        );

        expect(outcome.kind).toBe(SealKind.RejectedTerminal);
        if (outcome.kind !== SealKind.RejectedTerminal) {
            return;
        }
        expect(outcome.cappedBy).toBe(RejectionCap.Streak);
        expect(outcome.rejections).toBe(2);
        expect(requests).toHaveLength(2);
        expect(outcome.lastReason).toContain('summary');
        // The reason is a reason: pi's echoed copy of the payload is not part of it.
        expect(outcome.lastReason).not.toContain('Received arguments');
        expect(outcome.lastReason).not.toContain('xxxxx');
    });

    it('normalises an unpaired bounce for the streak and keeps its echo in the trace', async () => {
        // The other bounce branch: a `tool_execution_end` the observation has no recorded call
        // for, so `args` is empty and the echoed submission is the only surviving copy of what
        // the model sent. Normalizing only the paired branch made THIS one a payload comparison
        // — two differently-worded submissions off one wall counted as two streaks of one — and
        // put a whole submission into the persisted reason. Pi's own event stream always pairs
        // start with end (all four `tool_execution_end` emit sites of pi-agent-core's agent-loop
        // are preceded by a start with the same id), so this branch is driven at the observation's
        // own boundary: pi's `AgentSession.subscribe` listener, fed pi-shaped events.
        const recorder = createRuntimeTraceRecorder({
            runId: 'unpaired-bounce-run',
            issueNumber: 12,
            mode: RunMode.Fix,
        });
        const terminal = buildTerminalTool<Verdict>({
            name: TERMINAL_TOOL_NAME,
            description: 'Submit the final verdict.',
            schema: BoundedVerdictSchema,
            maxRejections: 2,
        });
        let deliver: ((event: AgentSessionEvent) => void) | undefined;
        createToolCallObservation({
            terminal,
            onBounce: recordToolBounce(recorder),
            logger: silentLogger(),
        }).attach({
            subscribe: (listener: (event: AgentSessionEvent) => void) => {
                deliver = listener;
                return () => undefined;
            },
        } as unknown as AgentSession);

        deliver!(unpairedBounce('call-a', piValidationBounce(overlongVerdict(39))));
        deliver!(unpairedBounce('call-b', piValidationBounce(overlongVerdict(7))));

        // One wall, one streak: the differing payloads are not part of the fingerprint. Asserted
        // before the settlement is awaited, because a reason still carrying the payload never
        // repeats and the run would simply never settle here.
        expect(terminal.repeatedRejections()).toBe(2);
        const settlement = await terminal.settled;
        expect(settlement.kind).toBe(TerminalSettlement.Capped);
        if (settlement.kind !== TerminalSettlement.Capped) {
            return;
        }
        expect(settlement.cappedBy).toBe(RejectionCap.Streak);
        expect(settlement.lastReason).toContain('summary');
        expect(settlement.lastReason).not.toContain('Received arguments');
        expect(settlement.lastReason).not.toContain('xxxxx');
        // ...and the submission still reaches the run evidence, beside the reason rather than
        // inside it: with no recorded call there is no other copy of it anywhere.
        const echoes = recorder
            .toJSON()
            .events.filter((event) => event.type === TraceEventType.ToolResult)
            .map((event) => (event.payload['result'] as Record<string, unknown>)['rawBounceText']);
        expect(echoes).toHaveLength(2);
        expect(String(echoes[0])).toContain('Received arguments');
        expect(String(echoes[0])).toContain('x'.repeat(MAX_SUMMARY_CHARS + 39));
        expect(String(echoes[1])).toContain('x'.repeat(MAX_SUMMARY_CHARS + 7));
    });

    it('re-prompts exactly once with the nudge and seals when the terminal call follows it', async () => {
        const { outcome, requests } = await runScripted([
            { kind: ScriptedReplyKind.Text, text: 'Let me think out loud instead.' },
            verdictCall(VALID_PAYLOAD),
        ]);

        expect(outcome.kind).toBe(SealKind.Terminal);
        if (outcome.kind !== SealKind.Terminal) {
            return;
        }
        expect(outcome.payload).toEqual(VALID_PAYLOAD);
        // Exactly two provider requests: the prose turn and the nudged turn.
        expect(requests).toHaveLength(2);
        const nudgedUsers = requests[1]!.messages.filter((m) => m.role === 'user');
        expect(JSON.stringify(nudgedUsers)).toContain(NUDGE_TEXT);
    });

    it('seals as no-terminal with a diagnosis naming the final reply when prose ends both turns', async () => {
        const { outcome, requests } = await runScripted([
            { kind: ScriptedReplyKind.Text, text: 'I am done talking.' },
            { kind: ScriptedReplyKind.Text, text: 'Still no tool call.' },
        ]);

        expect(outcome.kind).toBe(SealKind.NoTerminal);
        if (outcome.kind !== SealKind.NoTerminal) {
            return;
        }
        expect(outcome.diagnosis).toContain('Still no tool call.');
        // One nudge and no more: a third request would mean a second nudge.
        expect(requests).toHaveLength(2);
        expect(JSON.stringify(requests[1]!.messages)).toContain(NUDGE_TEXT);
    });

    it('retries a transient 500 within bounds and seals provider-failure with the provider message', async () => {
        const { outcome, requests } = await runScripted([], {
            scriptExhausted: {
                kind: ScriptedReplyKind.Error,
                status: 500,
                message: 'upstream overloaded',
            },
            retries: { maxRetries: 2, baseDelayMs: 1 },
        });

        expect(outcome.kind).toBe(SealKind.ProviderFailure);
        if (outcome.kind !== SealKind.ProviderFailure) {
            return;
        }
        expect(outcome.message).toContain('upstream overloaded');
        // Initial request plus the two configured agent-turn retries (pi counts maxRetries
        // retries AFTER the initial attempt — verified against the installed dist).
        expect(requests).toHaveLength(3);
    });

    it('recovers from a transient failure in-session and seals via the terminal tool', async () => {
        const { outcome, requests } = await runScripted(
            [
                { kind: ScriptedReplyKind.Error, status: 503, message: 'service unavailable' },
                verdictCall(VALID_PAYLOAD),
            ],
            { retries: { maxRetries: 2, baseDelayMs: 1 } },
        );

        expect(outcome.kind).toBe(SealKind.Terminal);
        if (outcome.kind !== SealKind.Terminal) {
            return;
        }
        expect(outcome.payload).toEqual(VALID_PAYLOAD);
        expect(requests).toHaveLength(2);
    });

    it('seals provider-failure without retrying when a 401 arrives mid-run', async () => {
        const lookup: SessionToolSpec = {
            name: 'lookup',
            description: 'Look up a fact.',
            parameters: v.object({ q: v.string() }),
            execute: async () => ({ content: 'lookup ok' }),
        };

        // The seam stamps this 4xx with the non-retryable `invalid_request_error` body — the
        // same shape as the committed AuthError scenario. pi classifies by message text, so a
        // `server_error`-typed 401 WOULD be retried (verified against the installed dist); this
        // scenario exercises the fail-fast path.
        const { outcome, requests } = await runScripted(
            [
                {
                    kind: ScriptedReplyKind.ToolCall,
                    toolName: 'lookup',
                    toolArguments: '{"q":"x"}',
                },
                { kind: ScriptedReplyKind.Error, status: 401, message: 'auth failed' },
            ],
            { tools: [lookup], retries: { maxRetries: 3, baseDelayMs: 1 } },
        );

        expect(outcome.kind).toBe(SealKind.ProviderFailure);
        if (outcome.kind !== SealKind.ProviderFailure) {
            return;
        }
        expect(outcome.message).toContain('auth failed');
        // The auth-shaped 401 is not retryable in pi's message classification: no auto-retry,
        // no third request, no nudge.
        expect(requests).toHaveLength(2);
    });

    it('stops the run at the wall-clock budget and seals budget-exceeded', async () => {
        const { outcome, requests } = await runScripted([], {
            scenario: HermeticScenario.Hang,
            budgets: { wallClockMs: 150 },
        });

        expect(outcome.kind).toBe(SealKind.BudgetExceeded);
        if (outcome.kind !== SealKind.BudgetExceeded) {
            return;
        }
        expect(outcome.budget).toBe(GuardCause.WallClock);
        // The single hanging request was cancelled in flight; no second request started.
        expect(requests).toHaveLength(1);
    });

    it('stops a runaway tool loop at the iteration backstop', async () => {
        const loopCall: ScriptedReply = {
            kind: ScriptedReplyKind.ToolCall,
            toolName: 'lookup',
            toolArguments: '{"q":"x"}',
        };
        const lookup: SessionToolSpec = {
            name: 'lookup',
            description: 'Look up a fact.',
            parameters: v.object({ q: v.string() }),
            execute: async () => ({ content: 'lookup ok' }),
        };

        const { outcome, requests } = await runScripted([loopCall], {
            tools: [lookup],
            scriptExhausted: loopCall,
            budgets: { maxTurns: 3 },
        });

        expect(outcome.kind).toBe(SealKind.BudgetExceeded);
        if (outcome.kind !== SealKind.BudgetExceeded) {
            return;
        }
        expect(outcome.budget).toBe(GuardCause.Turns);
        expect(outcome.detail).toContain('3');
        // One provider request per turn; the abort lands between turns, so turn 4 never starts.
        expect(requests).toHaveLength(3);
    });

    it('seals aborted when the caller aborts mid-run', async () => {
        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), 150);

        try {
            const { outcome } = await runScripted([], {
                scenario: HermeticScenario.Hang,
                signal: controller.signal,
            });

            expect(outcome.kind).toBe(SealKind.Aborted);
        } finally {
            clearTimeout(abortTimer);
        }
    });

    it('seals aborted immediately when the caller signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        const { outcome, requests } = await runScripted([], { signal: controller.signal });

        // Nothing is dispatched for a signal aborted before the run: pi's Agent.abort() only
        // touches an ACTIVE run, so the only clean seal is a pre-start short-circuit.
        expect(outcome.kind).toBe(SealKind.Aborted);
        expect(requests).toHaveLength(0);
    });

    it('turns a hanging provider into provider-failure through the per-request deadline', async () => {
        const { outcome, requests } = await runScripted([], {
            scenario: HermeticScenario.Hang,
            budgets: { requestTimeoutMs: 100 },
            retries: { maxRetries: 1, baseDelayMs: 1 },
        });

        expect(outcome.kind).toBe(SealKind.ProviderFailure);
        if (outcome.kind !== SealKind.ProviderFailure) {
            return;
        }
        expect(outcome.message).toMatch(/timed? ?out|timeout/i);
        // The hang timed out, was retried once within bounds, then exhausted.
        expect(requests).toHaveLength(2);
    });

    it('seals budget-exceeded when a streamed response stalls past the request deadline', async () => {
        // The half of requestTimeoutMs pi does not enforce: the OpenAI SDK clears its own timer
        // the moment the response headers arrive, so before this guard a provider that answered
        // and then went silent left the turn — and the run — unbounded.
        const started = Date.now();
        const { outcome, requests } = await runScripted([], {
            scenario: HermeticScenario.StallAfterHeaders,
            budgets: { requestTimeoutMs: STALL_DEADLINE_MS },
        });

        expect(outcome.kind).toBe(SealKind.BudgetExceeded);
        if (outcome.kind !== SealKind.BudgetExceeded) {
            return;
        }
        expect(outcome.budget).toBe(GuardCause.RequestDeadline);
        expect(outcome.detail).toContain(`${STALL_DEADLINE_MS}ms`);
        expect(requests).toHaveLength(1);
        // Bounded by the deadline, not by the suite's own timeout.
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    it('lets a live response keep streaming past the request deadline', async () => {
        // The deadline bounds SILENCE, not a response's total length. Two live runs sealed
        // request-deadline with tokens still arriving — the model had simply reasoned for more
        // than five minutes — so a stream that keeps producing must reach its own ending however
        // long that takes, with the wall-clock budget bounding the run instead.
        const started = Date.now();
        const { outcome, requests } = await runScripted(
            [
                verdictCall(VALID_PAYLOAD, {
                    deltas: SLOW_STREAM_DELTAS,
                    intervalMs: SLOW_STREAM_INTERVAL_MS,
                }),
            ],
            { budgets: { requestTimeoutMs: STALL_DEADLINE_MS } },
        );

        expect(outcome.kind).toBe(SealKind.Terminal);
        if (outcome.kind !== SealKind.Terminal) {
            return;
        }
        expect(outcome.payload).toEqual(VALID_PAYLOAD);
        // One request: the deadline never aborted the turn, so there is no retry and no nudge.
        expect(requests).toHaveLength(1);
        // The whole response outlived the deadline several times over, which is the point.
        expect(Date.now() - started).toBeGreaterThan(STALL_DEADLINE_MS);
    });

    it('runs non-terminal tools whose results reach the model context', async () => {
        const receivedArgs: unknown[] = [];
        const lookup: SessionToolSpec = {
            name: 'lookup',
            description: 'Look up a fact.',
            parameters: v.object({ q: v.string() }),
            execute: async (args) => {
                receivedArgs.push(args);
                return { content: 'lookup says hi' };
            },
        };

        const { outcome, requests } = await runScripted(
            [
                {
                    kind: ScriptedReplyKind.ToolCall,
                    toolName: 'lookup',
                    toolArguments: '{"q":"x"}',
                },
                verdictCall(VALID_PAYLOAD),
            ],
            { tools: [lookup] },
        );

        expect(outcome.kind).toBe(SealKind.Terminal);
        expect(receivedArgs).toEqual([{ q: 'x' }]);
        const firstTools = requests[0]!.tools as { function: { name: string } }[];
        expect(firstTools.map((tool) => tool.function.name)).toEqual(
            expect.arrayContaining(['lookup', TERMINAL_TOOL_NAME]),
        );
        expect(JSON.stringify(requests[1]!.messages)).toContain('lookup says hi');
    });

    it('keeps the seam surface free of pi types', () => {
        // Compile-time guard (checked by pnpm typecheck; a no-op at runtime): the public seam
        // types stay pi-free. The `runtime` option is intentionally the opaque PiRuntime
        // handle from createPiRuntime and is not re-asserted here.
        expectTypeOf<SessionToolSpec['parameters']>().toEqualTypeOf<v.GenericSchema>();
        expectTypeOf<SessionToolResult['content']>().toEqualTypeOf<string>();
        expectTypeOf<RunAgentSessionOptions<Verdict>['systemPrompt']>().toEqualTypeOf<string>();
        expectTypeOf<RunAgentSessionOptions<Verdict>['userTask']>().toEqualTypeOf<string>();
        expectTypeOf<RunAgentSessionOptions<Verdict>['workDir']>().toEqualTypeOf<string>();
        expectTypeOf<TerminalSealed<Verdict>['payload']>().toEqualTypeOf<Verdict>();
        expectTypeOf<RejectedTerminalSealed['lastReason']>().toEqualTypeOf<string>();
        expectTypeOf<NoTerminalSealed['diagnosis']>().toEqualTypeOf<string>();
        expectTypeOf<RunAgentSessionOptions<Verdict>['nudge']>().toEqualTypeOf<string>();
        expectTypeOf<RunAgentSessionOptions<Verdict>['signal']>().toEqualTypeOf<
            AbortSignal | undefined
        >();
        expectTypeOf<ProviderFailureSealed['message']>().toEqualTypeOf<string>();
        expectTypeOf<BudgetExceededSealed['budget']>().toEqualTypeOf<
            | typeof GuardCause.WallClock
            | typeof GuardCause.Turns
            | typeof GuardCause.RequestDeadline
        >();
        expectTypeOf<AbortedSealed['message']>().toEqualTypeOf<string>();
    });
});

/**
 * A terminal payload shaped like a fix verdict: a union keyed by `outcome` whose rule branch nests
 * an object holding another object and a list.
 */
const ProposalSchema = v.variant('outcome', [
    v.object({
        outcome: v.literal('propose_rule'),
        ruleProposal: v.object({
            rule: v.string(),
            risk: v.object({ level: v.picklist(['low', 'high']), reasons: v.array(v.string()) }),
        }),
    }),
    v.object({ outcome: v.literal('analysis_only'), summary: v.string() }),
]);
type Proposal = v.InferOutput<typeof ProposalSchema>;

const RULE_PROPOSAL = {
    rule: 'example.com##.ad',
    risk: { level: 'low', reasons: ['scoped to one site'] },
} as const;

/**
 * Run one session whose terminal tool takes a {@link ProposalSchema} payload.
 *
 * @param payloads - The terminal arguments the scripted model submits, one reply each.
 * @returns The sealed outcome.
 */
async function runProposal(payloads: Record<string, unknown>[]) {
    provider = await startHermeticProvider({
        scenario: HermeticScenario.Scripted,
        script: payloads.map((payload) => ({
            kind: ScriptedReplyKind.ToolCall,
            toolName: TERMINAL_TOOL_NAME,
            toolArguments: JSON.stringify(payload),
        })),
    });
    const runtime: PiRuntime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
    return runAgentSession<Proposal>({
        runtime,
        systemPrompt: 'You are a test agent. Finish by calling submit_verdict.',
        userTask: 'Submit the verdict now.',
        nudge: NUDGE_TEXT,
        terminal: buildTerminalTool<Proposal>({
            name: TERMINAL_TOOL_NAME,
            description: 'Submit the final verdict.',
            schema: ProposalSchema,
        }),
        budgets: TEST_RUN_BUDGETS,
        retries: TEST_RUN_RETRIES,
        reasoningEffort: TEST_REASONING_EFFORT,
        workDir,
    });
}

describe('stringified structured arguments', () => {
    it('accepts a nested object the model sent as JSON text on the first submission', async () => {
        // The live failure: deep into a session the model serialized `ruleProposal` a second
        // time, pi bounced every attempt with "must be object", and the run sealed on the cap.
        const outcome = await runProposal([
            { outcome: 'propose_rule', ruleProposal: JSON.stringify(RULE_PROPOSAL) },
        ]);

        expect(outcome.kind).toBe(SealKind.Terminal);
        if (outcome.kind !== SealKind.Terminal) {
            return;
        }
        expect(outcome.payload).toEqual({ outcome: 'propose_rule', ruleProposal: RULE_PROPOSAL });
        expect(outcome.rejections).toBe(0);
    });

    it('accepts a list nested inside an object, each sent as JSON text', async () => {
        const outcome = await runProposal([
            {
                outcome: 'propose_rule',
                ruleProposal: JSON.stringify({
                    rule: RULE_PROPOSAL.rule,
                    risk: JSON.stringify({
                        level: RULE_PROPOSAL.risk.level,
                        reasons: JSON.stringify(RULE_PROPOSAL.risk.reasons),
                    }),
                }),
            },
        ]);

        expect(outcome.kind).toBe(SealKind.Terminal);
        if (outcome.kind !== SealKind.Terminal) {
            return;
        }
        expect(outcome.payload).toEqual({ outcome: 'propose_rule', ruleProposal: RULE_PROPOSAL });
    });

    it('keeps JSON text in an argument the schema declares as a string', async () => {
        const summary = JSON.stringify({ note: 'the model quoted a JSON object' });

        const outcome = await runProposal([{ outcome: 'analysis_only', summary }]);

        expect(outcome.kind).toBe(SealKind.Terminal);
        if (outcome.kind !== SealKind.Terminal) {
            return;
        }
        expect(outcome.payload).toEqual({ outcome: 'analysis_only', summary });
    });

    it('still rejects a string that is not JSON where the schema expects an object', async () => {
        const outcome = await runProposal([
            { outcome: 'propose_rule', ruleProposal: 'example.com##.ad' },
            { outcome: 'propose_rule', ruleProposal: RULE_PROPOSAL },
        ]);

        expect(outcome.kind).toBe(SealKind.Terminal);
        if (outcome.kind !== SealKind.Terminal) {
            return;
        }
        expect(outcome.rejections).toBe(1);
    });
});

describe('onSessionUsage', () => {
    it('reports one pi-free report carrying the accepted assistant replies', async () => {
        const reports: UsageReport[] = [];
        const { outcome } = await runScripted(
            [verdictCall({ verdict: 'maybe' }), verdictCall(VALID_PAYLOAD)],
            { onSessionUsage: (report) => reports.push(report) },
        );

        expect(outcome.kind).toBe(SealKind.Terminal);
        expect(reports).toHaveLength(1);
        const report = reports[0]!;
        expect(report.completions).toHaveLength(2);
        expect(report.completions.every((completion) => completion.reported)).toBe(true);
        expect(report.completions.every((completion) => completion.model === REASONING_MODEL)).toBe(
            true,
        );
        expect(report.completions[0]!.input).toBe(11);
        expect(report.completions[0]!.output).toBe(5);
        expect(report.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('reports a completion classified unreported with zeroed counts when no usage chunk arrived', async () => {
        const reports: UsageReport[] = [];
        const { outcome } = await runScripted([verdictCall(VALID_PAYLOAD)], {
            usage: null,
            onSessionUsage: (report) => reports.push(report),
        });

        expect(outcome.kind).toBe(SealKind.Terminal);
        const report = reports[0]!;
        // A success reply with `usage: null` still counts as a completion, but the run can never
        // invent its tokens.
        expect(report.completions).toHaveLength(1);
        expect(report.completions[0]!.reported).toBe(false);
        expect(report.completions[0]!.input).toBe(0);
        expect(report.completions[0]!.output).toBe(0);
    });

    it('reports an empty completion list when the provider failed before any completion', async () => {
        const reports: UsageReport[] = [];
        const { outcome } = await runScripted([], {
            scenario: HermeticScenario.AuthError,
            onSessionUsage: (report) => reports.push(report),
        });

        expect(outcome.kind).toBe(SealKind.ProviderFailure);
        expect(reports).toHaveLength(1);
        // The request WAS made: reporting no completion at all let a run of one success plus one
        // provider failure render as `complete` usage. The attempt is counted with explicit
        // unreported telemetry instead.
        expect(reports[0]!.completions).toEqual([
            {
                model: REASONING_MODEL,
                reported: false,
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                reasoningTokens: 0,
            },
        ]);
    });

    it('logs a failing turn observer without touching what the turn reports', async () => {
        // A recorder/redaction failure used to vanish into a bare catch, and then used to be
        // reported as an unreported completion — which says the PROVIDER sent no usage chunk, the
        // one thing usageCompleteness means. The counts are in hand either way; only the trace
        // evidence is lost, and the log line is what says so.
        const errors: unknown[][] = [];
        const logger = {
            info: () => undefined,
            warn: () => undefined,
            error: (...args: unknown[]) => {
                errors.push(args);
            },
        } as unknown as Logger;
        const reports: UsageReport[] = [];

        const { outcome } = await runScripted([verdictCall(VALID_PAYLOAD)], {
            logger,
            onTurnEnd: () => {
                throw new Error('recorder exploded');
            },
            onSessionUsage: (report) => reports.push(report),
        });

        expect(outcome.kind).toBe(SealKind.Terminal);
        const [payload, message] = errors[0]! as [Record<string, unknown>, string];
        expect(payload).toMatchObject({ observer: 'onTurnEnd', turnIndex: 0 });
        expect((payload.err as Error).message).toBe('recorder exploded');
        expect(message).toContain('turn observer failed');
        expect(reports[0]!.completions[0]).toMatchObject({ reported: true, input: 11, output: 5 });
    });

    it('logs a rejected usage report once instead of re-offering it', async () => {
        const errors: unknown[][] = [];
        const logger = {
            info: () => undefined,
            warn: () => undefined,
            error: (...args: unknown[]) => {
                errors.push(args);
            },
        } as unknown as Logger;
        const delivered: UsageReport[] = [];

        const { outcome } = await runScripted([verdictCall(VALID_PAYLOAD)], {
            logger,
            onSessionUsage: (report) => {
                delivered.push(report);
                throw new Error('collector exploded');
            },
        });

        expect(outcome.kind).toBe(SealKind.Terminal);
        // Offered exactly once — the observer is an array push into the run's collector, so a
        // second, degraded delivery would fail identically — and the failure is in the log.
        expect(delivered).toHaveLength(1);
        expect(errors).toHaveLength(1);
        const [payload] = errors[0]! as [Record<string, unknown>, string];
        expect(payload).toMatchObject({ observer: 'onSessionUsage', completions: 1 });
        expect((payload.err as Error).message).toBe('collector exploded');
    });

    it('fires the empty report even when the run is aborted before it started', async () => {
        const controller = new AbortController();
        controller.abort();
        const reports: UsageReport[] = [];

        const { outcome } = await runScripted([], {
            signal: controller.signal,
            onSessionUsage: (report) => reports.push(report),
        });

        expect(outcome.kind).toBe(SealKind.Aborted);
        expect(reports).toHaveLength(1);
        expect(reports[0]).toEqual({ completions: [], durationMs: 0 });
    });
});

/**
 * Read the typed detail records of the decision events carrying one phase marker.
 *
 * @param trace - The sealed run trace.
 * @param phase - The decision phase to look up.
 * @returns The matching events' detail payloads, in trace order.
 */
function decisionDetails(trace: RunTrace, phase: string): Record<string, unknown>[] {
    return trace.events
        .filter(
            (event) => event.type === TraceEventType.Decision && event.payload['phase'] === phase,
        )
        .map((event) => event.payload['details'] as Record<string, unknown>);
}

describe('context compaction', () => {
    it('does not compact a run far inside the real registered window', async () => {
        // The window is what pi measures its compaction threshold against, so registering a small
        // one buys a lossy summary — and a cold prompt cache after it — at a fraction of the
        // context the model actually has. A turn reporting 120k tokens is ~11% of the default
        // window and must simply continue.
        const compactions: SessionCompactionObservation[] = [];
        const { outcome, requests } = await runScripted(
            [
                {
                    kind: ScriptedReplyKind.Text,
                    text: COMPACTABLE_REPLY,
                    usage: { promptTokens: OVER_THRESHOLD_PROMPT_TOKENS, completionTokens: 5 },
                },
                verdictCall(VALID_PAYLOAD),
            ],
            { onCompaction: (observation) => compactions.push(observation) },
        );

        expect(outcome.kind).toBe(SealKind.Terminal);
        expect(compactions).toEqual([]);
        // Two agent turns and no summarization request in between.
        expect(requests).toHaveLength(2);
    });

    it('buys no summarization after the terminal tool has already sealed the run', async () => {
        // pi checks compaction after EVERY agent run, the one the terminal tool ended included:
        // above the threshold that is one more paid request for a summary of a run that is over.
        const compactions: SessionCompactionObservation[] = [];
        const { outcome, requests } = await runScripted(
            [
                // A transcript long enough for pi to find a cut point, reported well inside the
                // window so this turn compacts nothing.
                { kind: ScriptedReplyKind.Text, text: COMPACTABLE_REPLY },
                // The terminal call, reporting a context over the threshold: pi would summarize
                // that context right after accepting the payload the run is sealing on.
                {
                    kind: ScriptedReplyKind.ToolCall,
                    toolName: TERMINAL_TOOL_NAME,
                    toolArguments: JSON.stringify(VALID_PAYLOAD),
                    usage: { promptTokens: OVER_THRESHOLD_PROMPT_TOKENS, completionTokens: 5 },
                },
            ],
            {
                contextWindowTokens: SMALL_CONTEXT_WINDOW_TOKENS,
                onCompaction: (observation) => compactions.push(observation),
            },
        );

        expect(outcome.kind).toBe(SealKind.Terminal);
        expect(compactions).toEqual([]);
        // The two agent turns and nothing else: no summarization request after the seal.
        expect(requests).toHaveLength(2);
    });

    it('survives the context ceiling and accounts for the rewrite it paid for', async () => {
        // The contract compaction exists for: a run whose context outgrows the model's window
        // reaches a verdict instead of dying at the ceiling — and the lossy rewrite it took to get
        // there is visible in the trace and paid for in the usage report, never silent.
        const recorder = createRuntimeTraceRecorder({
            runId: 'compacted-run',
            issueNumber: 11,
            mode: RunMode.Fix,
        });
        const compaction = recordSessionCompaction(recorder);
        const collector = createRunUsageCollector();

        const { outcome, requests } = await runScripted(
            [
                // Turn 1 reports a context past pi's compaction threshold for the window this
                // run registers, in a reply long enough (~36k estimated tokens) for pi to find a
                // cut point at all: it keeps the most recent ~20k intact, so a short reply is
                // never compactable however large the reported context is.
                {
                    kind: ScriptedReplyKind.Text,
                    text: COMPACTABLE_REPLY,
                    usage: { promptTokens: OVER_THRESHOLD_PROMPT_TOKENS, completionTokens: 5 },
                },
                // pi's summarization request: a provider call this run makes and pays for. Only
                // turn 1 reports a context over the threshold, so the run compacts exactly once —
                // the nudged turn below reports the default counts and triggers nothing.
                { kind: ScriptedReplyKind.Text, text: COMPACTION_SUMMARY_TEXT },
                // The nudged turn, running on the compacted context, seals the run.
                verdictCall(VALID_PAYLOAD),
            ],
            {
                contextWindowTokens: SMALL_CONTEXT_WINDOW_TOKENS,
                onTurnEnd: recordSessionTurn(recorder),
                onCompaction: compaction.observe,
                onSessionUsage: (report) => collector.addSession(report),
            },
        );

        expect(outcome.kind).toBe(SealKind.Terminal);
        // Two agent turns plus the summarization request in between.
        expect(requests).toHaveLength(3);

        const trace = sealSessionTrace(recorder, outcome, compaction.count());
        const compactions = decisionDetails(trace, COMPACTION_DECISION_PHASE);
        expect(compactions).toHaveLength(1);
        // The summary is the only evidence of what the model carried past the rewrite.
        expect(compactions[0]!['summary']).toContain(COMPACTION_SUMMARY_TEXT);
        expect(compactions[0]!['aborted']).toBe(false);
        expect(compactions[0]!['tokensBefore']).toBeGreaterThan(0);
        const compactionEvent = trace.events.find(
            (event) =>
                event.type === TraceEventType.Decision &&
                event.payload['phase'] === COMPACTION_DECISION_PHASE,
        );
        expect(compactionEvent!.payload['reason']).toBe(CompactionReason.Threshold);
        // The run is marked at the seal too: a reader sees it reasoned over a summarized
        // transcript without having to count events.
        expect(decisionDetails(trace, SEAL_DECISION_PHASE)[0]!['compactions']).toBe(1);

        // Every attempted provider call is counted exactly once — including turn 1, which the
        // rewrite erased from session state, and the summarization request pi issued itself.
        const usage = collector.summary();
        expect(usage.completions).toBe(3);
        expect(usage.bySource.loop.completions).toBe(3);
        expect(usage.usageCompleteness).toBe(UsageCompleteness.Complete);
        expect(usage.byModel.map((entry) => entry.model)).toEqual([REASONING_MODEL]);
        expect(usage.tokens.input).toBe(OVER_THRESHOLD_PROMPT_TOKENS + 11 + 11);
    });
});
