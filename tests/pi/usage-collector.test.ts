import { afterEach, describe, expect, it } from 'vitest';
import * as v from 'valibot';
import type { Usage } from '@earendil-works/pi-ai';
import { RunUsageSummarySchema } from '../../src/types/usage-summary';
import { RunTraceSchema } from '../../src/types/trace';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import { runAgentSession } from '../../src/pi/session-runner';
import { buildTerminalTool } from '../../src/pi/terminal-tool';
import { createRunUsageCollector } from '../../src/pi/usage-collector';
import { toCompletionUsage } from '../../src/pi/usage-reporting';
import {
    HermeticScenario,
    type HermeticProvider,
    ScriptedReplyKind,
    startHermeticProvider,
} from './hermetic-provider';
import {
    REASONING_MODEL,
    TEST_REASONING_EFFORT,
    TEST_RUN_BUDGETS,
    TEST_RUN_RETRIES,
    createTestPiRuntime,
} from './test-runtime';

/**
 * The pi-ai zeroed usage object exactly as the 0.84.1 openai-completions adapter initializes a
 * streaming output message BEFORE any usage chunk arrives: no `reasoning` key, every count zero.
 */
const ZEROED_PRE_CHUNK_USAGE: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const REASONING_RATES = {
    inputUsdPerMillionTokens: 0.14,
    outputUsdPerMillionTokens: 0.28,
    cachedInputUsdPerMillionTokens: 0.0028,
};

describe('toCompletionUsage', () => {
    it('normalizes a reported usage with its reasoning subset', () => {
        const normalized = toCompletionUsage('reasoning-model', {
            ...ZEROED_PRE_CHUNK_USAGE,
            input: 11,
            output: 25,
            cacheRead: 1000,
            cacheWrite: 5,
            totalTokens: 1041,
            reasoning: 7,
        });

        expect(normalized).toEqual({
            model: 'reasoning-model',
            reported: true,
            input: 11,
            output: 25,
            cacheRead: 1000,
            cacheWrite: 5,
            reasoningTokens: 7,
        });
    });

    it('marks a usage without the reasoning key as unreported with zeroed counts', () => {
        const normalized = toCompletionUsage('quiet-model', ZEROED_PRE_CHUNK_USAGE);

        expect(normalized).toEqual({
            model: 'quiet-model',
            reported: false,
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoningTokens: 0,
        });
    });
});

describe('RunUsageCollector', () => {
    it('prices reported usage at configured rates with pi cache semantics', () => {
        const collector = createRunUsageCollector({
            rates: { 'reasoning-model': REASONING_RATES },
        });
        collector.addSession({
            completions: [
                {
                    model: 'reasoning-model',
                    reported: true,
                    input: 1_000_000,
                    output: 100_000,
                    cacheRead: 500_000,
                    cacheWrite: 100_000,
                    reasoningTokens: 20_000,
                },
            ],
            durationMs: 1250,
        });

        const summary = collector.summary();
        expect(summary.costUsd).toBe(0.1834);
        expect(summary.tokens).toEqual({
            input: 1_000_000,
            output: 100_000,
            cacheRead: 500_000,
            cacheWrite: 100_000,
            reasoningTokens: 20_000,
        });
        expect(summary.usageCompleteness).toBe('complete');
        expect(summary.costCoverage).toBe('full');
        expect(summary.requests).toBe(1);
        expect(summary.completions).toBe(1);
        expect(summary.durationMs).toBe(1250);
        expect(summary.bySource.loop.costUsd).toBe(0.1834);
        expect(summary.bySource.singleShot.costUsd).toBeNull();
    });

    it('falls back to the input rate for a cached subset when no cached rate is configured', () => {
        const collector = createRunUsageCollector({
            rates: {
                'reasoning-model': {
                    inputUsdPerMillionTokens: 0.14,
                    outputUsdPerMillionTokens: 0.28,
                },
            },
        });
        collector.addSession({
            completions: [
                {
                    model: 'reasoning-model',
                    reported: true,
                    input: 1_000_000,
                    output: 100_000,
                    cacheRead: 500_000,
                    cacheWrite: 0,
                    reasoningTokens: 0,
                },
            ],
            durationMs: 0,
        });

        expect(collector.summary().costUsd).toBe(0.238);
    });

    it('prices cache writes at their own rate when the pin carries one', () => {
        // The catalog pins price cache writes above plain input (gemini: 0.79 vs 0.75); a pin
        // without the rate keeps the input-rate fallback.
        const collector = createRunUsageCollector({
            rates: {
                'vision-model': {
                    inputUsdPerMillionTokens: 0.75,
                    outputUsdPerMillionTokens: 3.75,
                    cachedInputUsdPerMillionTokens: 0.07,
                    cacheWriteUsdPerMillionTokens: 0.79,
                },
            },
        });
        collector.addSingleShot({
            completions: [
                {
                    model: 'vision-model',
                    reported: true,
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 1_000_000,
                    reasoningTokens: 0,
                },
            ],
            durationMs: 0,
        });

        expect(collector.summary().costUsd).toBe(0.79);
    });

    it('sums the priceable part only and labels partial coverage', () => {
        const collector = createRunUsageCollector({
            rates: {
                'priced-model': { inputUsdPerMillionTokens: 0.1, outputUsdPerMillionTokens: 0.1 },
            },
        });
        collector.addSession({
            completions: [
                {
                    model: 'priced-model',
                    reported: true,
                    input: 1_000_000,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    reasoningTokens: 0,
                },
            ],
            durationMs: 250,
        });
        collector.addSession({
            completions: [
                {
                    model: 'unpriced-model',
                    reported: true,
                    input: 1_000_000,
                    output: 100_000,
                    cacheRead: 0,
                    cacheWrite: 0,
                    reasoningTokens: 0,
                },
            ],
            durationMs: 75,
        });

        const summary = collector.summary();
        expect(summary.costUsd).toBe(0.1);
        expect(summary.costCoverage).toBe('partial');
        expect(summary.durationMs).toBe(325);
        expect(summary.byModel.find((entry) => entry.model === 'priced-model')?.costUsd).toBe(0.1);
        expect(
            summary.byModel.find((entry) => entry.model === 'unpriced-model')?.costUsd,
        ).toBeNull();
    });

    it('reports explicit unknowns for a run with only unreported completions', () => {
        const collector = createRunUsageCollector({ rates: {} });
        collector.addSession({
            completions: [
                {
                    model: 'quiet-model',
                    reported: false,
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    reasoningTokens: 0,
                },
            ],
            durationMs: 300,
        });

        const summary = collector.summary();
        expect(summary.usageCompleteness).toBe('unreported');
        expect(summary.unreportedCompletions).toBe(1);
        expect(summary.completions).toBe(1);
        expect(summary.tokens).toEqual({
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoningTokens: 0,
        });
        expect(summary.costUsd).toBeNull();
        expect(summary.costCoverage).toBe('none');
    });

    it('renders zeroed counts with explicit unknowns for an empty run', () => {
        const summary = createRunUsageCollector({ rates: {} }).summary();

        expect(summary.requests).toBe(0);
        expect(summary.completions).toBe(0);
        expect(summary.unreportedCompletions).toBe(0);
        expect(summary.repairAttempts).toBe(0);
        expect(summary.durationMs).toBe(0);
        expect(summary.usageCompleteness).toBe('unreported');
        expect(summary.costUsd).toBeNull();
        expect(summary.costCoverage).toBe('none');
        expect(summary.byModel).toEqual([]);
        expect(summary.bySource.loop.tokens.input).toBe(0);
        expect(summary.bySource.singleShot.completions).toBe(0);
    });

    it('counts a repaired single-shot as one request with its attempts', () => {
        const collector = createRunUsageCollector({ rates: {} });
        collector.addSingleShot({
            completions: [
                {
                    model: 'vision-model',
                    reported: true,
                    input: 11,
                    output: 5,
                    cacheRead: 0,
                    cacheWrite: 0,
                    reasoningTokens: 0,
                },
                {
                    model: 'vision-model',
                    reported: true,
                    input: 11,
                    output: 5,
                    cacheRead: 0,
                    cacheWrite: 0,
                    reasoningTokens: 0,
                },
            ],
            durationMs: 100,
        });

        const summary = collector.summary();
        expect(summary.requests).toBe(1);
        expect(summary.completions).toBe(2);
        expect(summary.repairAttempts).toBe(1);
        expect(summary.bySource.singleShot.requests).toBe(1);
    });

    it('survives a JSON round-trip through the schema', () => {
        const collector = createRunUsageCollector({
            rates: { 'reasoning-model': REASONING_RATES },
        });
        collector.addSession({
            completions: [
                {
                    model: 'reasoning-model',
                    reported: true,
                    input: 11,
                    output: 25,
                    cacheRead: 1000,
                    cacheWrite: 0,
                    reasoningTokens: 10,
                },
            ],
            durationMs: 42,
        });
        const summary = collector.summary();

        expect(v.parse(RunUsageSummarySchema, JSON.parse(JSON.stringify(summary)))).toEqual(
            summary,
        );
    });
});

describe('run session to trace usage block', () => {
    const TERMINAL_TOOL_NAME = 'submit_verdict';
    const VerdictSchema = v.object({ verdict: v.string() });

    let provider: HermeticProvider | undefined;

    afterEach(async () => {
        if (!provider) {
            return;
        }
        await provider.close();
        provider = undefined;
    });

    /**
     * Run one scripted session and return the sealed trace with the collector's summary attached.
     *
     * @param usage - Hermetic usage control for every success reply.
     * @returns The sealed trace via the recorder.
     */
    async function sessionTraceWithUsage(
        usage: { promptTokens: number; completionTokens: number; cachedTokens?: number } | null,
    ) {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                {
                    kind: ScriptedReplyKind.ToolCall,
                    toolName: TERMINAL_TOOL_NAME,
                    toolArguments: JSON.stringify({ verdict: 'ok' }),
                },
            ],
            usage,
        });
        const runtime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
        const collector = createRunUsageCollector({
            rates: {
                [REASONING_MODEL]: {
                    inputUsdPerMillionTokens: 0.14,
                    outputUsdPerMillionTokens: 0.28,
                    cachedInputUsdPerMillionTokens: 0.0028,
                },
            },
        });
        const recorder = new TraceRecorder({
            runId: 'acceptance',
            issueNumber: 1,
            mode: 'fix',
        });
        const terminal = buildTerminalTool<{ verdict: string }>({
            name: TERMINAL_TOOL_NAME,
            description: 'Submit the final verdict.',
            schema: VerdictSchema,
        });
        const outcome = await runAgentSession<{ verdict: string }>({
            runtime,
            systemPrompt: 'You are a test agent. Finish by calling submit_verdict.',
            userTask: 'Submit the verdict now.',
            nudge: 'Call submit_verdict now.',
            terminal,
            budgets: TEST_RUN_BUDGETS,
            retries: TEST_RUN_RETRIES,
            reasoningEffort: TEST_REASONING_EFFORT,
            workDir: process.cwd(),
            onSessionUsage: (report) => collector.addSession(report),
        });
        expect(outcome.kind).toBe('terminal');
        recorder.setUsageSummary(collector.summary());
        return recorder.end('analysis_complete');
    }

    it('carries all four token counts and a configured-rate cost in the trace block', async () => {
        const trace = await sessionTraceWithUsage({
            promptTokens: 1011,
            completionTokens: 25,
            cachedTokens: 1000,
        });

        const parsed = v.parse(RunTraceSchema, trace);
        expect(parsed.usage).toBeDefined();
        expect(parsed.usage!.tokens).toEqual({
            input: 11,
            output: 25,
            cacheRead: 1000,
            cacheWrite: 0,
            reasoningTokens: 0,
        });
        expect(parsed.usage!.usageCompleteness).toBe('complete');
        expect(parsed.usage!.costCoverage).toBe('full');
        // (11·0.14 + 1000·0.0028 + 25·0.28)/1e6.
        expect(parsed.usage!.costUsd).toBe(0.00001134);
    });

    it('reports explicit unknowns in the trace block when the provider never sent usage', async () => {
        const trace = await sessionTraceWithUsage(null);

        const parsed = v.parse(RunTraceSchema, trace);
        expect(parsed.usage!.tokens).toEqual({
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoningTokens: 0,
        });
        expect(parsed.usage!.usageCompleteness).toBe('unreported');
        expect(parsed.usage!.costUsd).toBeNull();
        expect(parsed.usage!.costCoverage).toBe('none');
    });
});
