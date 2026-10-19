import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { loadCoreConfig } from '../../src/config/config';
import { createLogger } from '../../src/logger/logger';
import {
    createConfiguredSingleShotClient,
    createPiRuntimeFromConfig,
} from '../../src/pi/llm-wiring';
import { TEST_PROVIDER_ENV } from '../config/test-core-config';
import { LlmApi } from '../../src/config/llm-api';
import { ReasoningEffort } from '../../src/config/reasoning-effort';
import { registerAdditionalTextModel } from '../../src/pi/runtime';
import type { RunBudgets } from '../../src/pi/guard-types';
import { SealKind } from '../../src/pi/seal-types';
import { createSingleShotClient } from '../../src/pi/single-shot';
import { SingleShotResultKind } from '../../src/pi/single-shot-types';
import { VISION_IMAGE_LIMITS } from '../../src/pi/single-shot-input';
import { ProviderRefusalStopReason, TurnStopReason } from '../../src/pi/stop-reason';
import { createRunUsageCollector, meterSingleShotClient } from '../../src/pi/usage-collector';
import {
    type HermeticAnthropicProvider,
    startHermeticAnthropicProvider,
} from './hermetic-anthropic-provider';
import { ScriptedReplyKind, type ScriptedReply } from './hermetic-provider';
import { encodePng, imageSize } from './fixtures/png-image';
import {
    createTestPiRuntime,
    REASONING_MODEL,
    TEST_API_KEY,
    TEST_REASONING_EFFORT,
    runScriptedSession,
    TEST_TERMINAL_TOOL_NAME as TERMINAL_TOOL_NAME,
} from './test-runtime';

const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let workDir: string;
let provider: HermeticAnthropicProvider | undefined;

beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'pi-anthropic-messages-'));
});

afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
});

afterEach(async () => {
    await provider?.close();
    provider = undefined;
});

/**
 * Silence bound of the stall suite: long enough for a hermetic turn, short enough to keep the suite
 * fast.
 */
const STALL_DEADLINE_MS = 300;

async function runScripted(
    script: ScriptedReply[] = [
        {
            kind: ScriptedReplyKind.ToolCall,
            toolName: TERMINAL_TOOL_NAME,
            toolArguments: JSON.stringify({ verdict: 'ok', summary: 'done' }),
        },
    ],
    budgets?: RunBudgets,
) {
    provider = await startHermeticAnthropicProvider({
        script,
        scriptExhausted: {
            kind: ScriptedReplyKind.Error,
            status: 500,
            message: 'script exhausted',
        },
    });
    const outcome = await runScriptedSession({
        baseUrl: provider.baseUrl,
        api: LlmApi.AnthropicMessages,
        retries: { maxRetries: 2, baseDelayMs: 0 },
        ...(budgets === undefined ? {} : { budgets }),
        workDir,
    });
    return { outcome, requests: provider.requests };
}

describe('Anthropic Messages API', () => {
    it('seals an Anthropic 400 as a deterministic rejection with its status', async () => {
        const { outcome, requests } = await runScripted([
            { kind: ScriptedReplyKind.Error, status: 400, message: 'malformed request' },
        ]);

        expect(outcome).toMatchObject({
            kind: SealKind.ProviderFailure,
            deterministic: true,
            status: 400,
        });
        expect(requests).toHaveLength(1);
    });

    it.each([ProviderRefusalStopReason.Refusal, ProviderRefusalStopReason.Sensitive])(
        'seals a %s stop as a deterministic rejection without a retry',
        async (reason) => {
            const { outcome, requests } = await runScripted([
                { kind: ScriptedReplyKind.FinishReason, reason },
            ]);

            expect(outcome).toMatchObject({
                kind: SealKind.ProviderFailure,
                deterministic: true,
            });
            expect(requests).toHaveLength(1);
        },
    );

    it('retries a 529 overload and reaches the terminal seal', async () => {
        const { outcome, requests } = await runScripted([
            { kind: ScriptedReplyKind.Error, status: 529, message: 'overloaded' },
            {
                kind: ScriptedReplyKind.ToolCall,
                toolName: TERMINAL_TOOL_NAME,
                toolArguments: JSON.stringify({ verdict: 'ok', summary: 'after the overload' }),
            },
        ]);

        expect(outcome.kind).toBe(SealKind.Terminal);
        expect(requests).toHaveLength(2);
    });

    it('retries a turn whose stream opened and then sent only pings', async () => {
        const { outcome, requests } = await runScripted(
            [
                { kind: ScriptedReplyKind.Stall },
                {
                    kind: ScriptedReplyKind.ToolCall,
                    toolName: TERMINAL_TOOL_NAME,
                    toolArguments: JSON.stringify({ verdict: 'ok', summary: 'after the stall' }),
                },
            ],
            { requestTimeoutMs: STALL_DEADLINE_MS },
        );

        expect(outcome.kind).toBe(SealKind.Terminal);
        expect(requests).toHaveLength(2);
    });

    it('sends loop turns to /v1/messages with the key in x-api-key', async () => {
        const { outcome, requests } = await runScripted();

        expect(outcome.kind).toBe(SealKind.Terminal);
        expect(requests).toHaveLength(1);
        expect(requests[0]!.url).toBe('/v1/messages');
        expect(requests[0]!.method).toBe('POST');
        expect(requests[0]!.headers['x-api-key']).toBe(TEST_API_KEY);
        expect(requests[0]!.headers).not.toHaveProperty('authorization');
    });

    it('marks the system prompt, the last tool and the last user message for caching', async () => {
        const { outcome, requests } = await runScripted();

        expect(outcome.kind).toBe(SealKind.Terminal);
        const body = requests[0]!.body;
        const system = body.system as Record<string, unknown>[];
        const tools = body.tools as Record<string, unknown>[];
        const messages = body.messages as { role: string; content: Record<string, unknown>[] }[];
        expect(system.at(-1)).toHaveProperty('cache_control', { type: 'ephemeral' });
        expect(tools.at(-1)).toHaveProperty('cache_control', { type: 'ephemeral' });
        const lastUser = messages.filter((message) => message.role === 'user').at(-1);
        expect(lastUser!.content.at(-1)).toHaveProperty('cache_control', { type: 'ephemeral' });
    });

    it('enables adaptive thinking at the loop effort and sends no temperature', async () => {
        const { outcome, requests } = await runScripted();

        expect(outcome.kind).toBe(SealKind.Terminal);
        expect(requests[0]!.body.thinking).toHaveProperty('type', 'adaptive');
        expect(requests[0]!.body.output_config).toHaveProperty('effort', TEST_REASONING_EFFORT);
        expect(requests[0]!.body).not.toHaveProperty('temperature');
    });

    it('carries the single-shot effort as adaptive thinking and sends no temperature', async () => {
        provider = await startHermeticAnthropicProvider({
            script: [{ kind: ScriptedReplyKind.Text, text: 'reviewed' }],
        });
        const runtime = await createTestPiRuntime({
            api: LlmApi.AnthropicMessages,
            baseUrl: provider.baseUrl,
        });
        const client = createSingleShotClient(runtime, runtime.reasoningModel, {
            reasoningEffort: ReasoningEffort.Low,
        });

        const result = await client.text({
            messages: [{ role: 'user', text: 'Review this.' }],
        });

        expect(result.kind).toBe(SingleShotResultKind.Parsed);
        expect(provider.requests).toHaveLength(1);
        expect(provider.requests[0]!.body.thinking).toHaveProperty('type', 'adaptive');
        expect(provider.requests[0]!.body.output_config).toHaveProperty(
            'effort',
            ReasoningEffort.Low,
        );
        expect(provider.requests[0]!.body).not.toHaveProperty('temperature');
    });

    it.each([
        'context length exceeded; please retry your request',
        'overloaded: insufficient_quota',
    ])('does not retry a terminal stream error (%s)', async (message) => {
        provider = await startHermeticAnthropicProvider({
            script: [{ kind: ScriptedReplyKind.StreamFault, code: 500, message }],
        });
        const runtime = await createTestPiRuntime({
            api: LlmApi.AnthropicMessages,
            baseUrl: provider.baseUrl,
        });
        const result = await createSingleShotClient(runtime, runtime.reasoningModel, {
            maxRetries: 1,
        }).text({ messages: [{ role: 'user', text: 'Return a verdict.' }] });
        expect(result.kind).toBe(SingleShotResultKind.ProviderFailure);
        expect(provider.requests).toHaveLength(1);
    });

    it.each([
        { structured: false, failedUsage: null },
        { structured: true, failedUsage: null },
        { structured: false, failedUsage: { promptTokens: 200, completionTokens: 10 } },
        { structured: true, failedUsage: { promptTokens: 200, completionTokens: 10 } },
    ])(
        'retries an Anthropic stream overload and meters every attempt ($structured, $failedUsage)',
        async ({ structured, failedUsage }) => {
            provider = await startHermeticAnthropicProvider({
                script: [
                    {
                        kind: ScriptedReplyKind.StreamFault,
                        code: 529,
                        message: 'Overloaded',
                        usage: failedUsage,
                    },
                    {
                        kind: ScriptedReplyKind.Text,
                        text: '{"verdict":"ok"}',
                        usage: {
                            promptTokens: 1000,
                            cachedTokens: 600,
                            cacheWriteTokens: 300,
                            completionTokens: 50,
                        },
                    },
                ],
            });
            const runtime = await createTestPiRuntime({
                api: LlmApi.AnthropicMessages,
                baseUrl: provider.baseUrl,
            });
            const collector = createRunUsageCollector({
                rates: {
                    [REASONING_MODEL]: {
                        inputUsdPerMillionTokens: 1,
                        outputUsdPerMillionTokens: 2,
                        cachedInputUsdPerMillionTokens: 0.1,
                        cacheWriteUsdPerMillionTokens: 1.25,
                    },
                },
            });
            const client = meterSingleShotClient(
                createSingleShotClient(runtime, runtime.reasoningModel, { maxRetries: 1 }),
                collector,
            );
            const messages = [{ role: 'user' as const, text: 'Return a verdict.' }];
            const result = structured
                ? await client.structured({ messages, schema: v.object({ verdict: v.string() }) })
                : await client.text({ messages });
            expect(result.kind).toBe(SingleShotResultKind.Parsed);
            if (result.kind === SingleShotResultKind.Parsed) {
                expect(result.attempts).toBe(2);
            }
            expect(provider.requests).toHaveLength(2);
            expect(result.usages).toHaveLength(2);
            const summary = collector.summary();
            expect(summary.completions).toBe(2);
            expect(summary.unreportedCompletions).toBe(failedUsage === null ? 1 : 0);
            expect(summary.tokens).toEqual({
                input: 100 + (failedUsage?.promptTokens ?? 0),
                output: 50 + (failedUsage?.completionTokens ?? 0),
                cacheRead: 600,
                cacheWrite: 300,
                reasoningTokens: 0,
            });
            expect(summary.costUsd).toBeCloseTo(failedUsage === null ? 0.000635 : 0.000855, 10);
        },
    );

    it('meters a turn without thinking as reported, with cache reads and writes priced', async () => {
        provider = await startHermeticAnthropicProvider({
            script: [{ kind: ScriptedReplyKind.Text, text: 'reviewed' }],
            usage: {
                promptTokens: 1000,
                cachedTokens: 600,
                cacheWriteTokens: 300,
                completionTokens: 50,
            },
        });
        const config = loadCoreConfig({
            ...TEST_PROVIDER_ENV,
            LLM_API: LlmApi.AnthropicMessages,
            LLM_BASE_URL: provider.baseUrl,
            LLM_MODEL: REASONING_MODEL,
            LLM_SINGLE_SHOT_REASONING_EFFORT: ReasoningEffort.Off,
        });
        const runtime = await createPiRuntimeFromConfig(config.llm);
        const rates = {
            inputUsdPerMillionTokens: 1,
            outputUsdPerMillionTokens: 2,
            cachedInputUsdPerMillionTokens: 0.1,
            cacheWriteUsdPerMillionTokens: 1.25,
        };
        const collector = createRunUsageCollector({ rates: { [REASONING_MODEL]: rates } });
        const client = createConfiguredSingleShotClient(
            runtime,
            runtime.reasoningModel,
            config.llm,
            {
                logger: createLogger(),
                usageCollector: collector,
            },
        );

        const result = await client.text({ messages: [{ role: 'user', text: 'Review this.' }] });

        expect(result.kind).toBe(SingleShotResultKind.Parsed);
        expect(provider.requests[0]!.body.thinking).toHaveProperty('type', 'disabled');
        expect(provider.requests[0]!.body).not.toHaveProperty('temperature');
        expect(provider.requests[0]!.body.max_tokens).toBe(
            Number(TEST_PROVIDER_ENV.LLM_MAX_OUTPUT_TOKENS),
        );
        const summary = collector.summary();
        expect(summary.unreportedCompletions).toBe(0);
        expect(summary.completions).toBe(1);
        expect(summary.tokens).toEqual({
            input: 100,
            output: 50,
            cacheRead: 600,
            cacheWrite: 300,
            reasoningTokens: 0,
        });
        expect(summary.costUsd).toBe(
            (100 * rates.inputUsdPerMillionTokens +
                50 * rates.outputUsdPerMillionTokens +
                600 * rates.cachedInputUsdPerMillionTokens +
                300 * rates.cacheWriteUsdPerMillionTokens) /
                1_000_000,
        );
    });

    it('keeps images on the vision role when it shares the reasoning model', async () => {
        provider = await startHermeticAnthropicProvider({
            script: [{ kind: ScriptedReplyKind.Text, text: 'an image arrived' }],
        });
        const runtime = await createTestPiRuntime({
            api: LlmApi.AnthropicMessages,
            baseUrl: provider.baseUrl,
            visionModel: REASONING_MODEL,
        });

        const result = await createSingleShotClient(runtime, runtime.visionModel).text({
            messages: [
                {
                    role: 'user',
                    text: 'Describe the image.',
                    images: [{ bytes: Buffer.from(PNG_1PX, 'base64') }],
                },
            ],
        });

        expect(result.kind).toBe(SingleShotResultKind.Parsed);
        expect(provider.requests[0]!.body.model).toBe(REASONING_MODEL);
        const messages = provider.requests[0]!.body.messages as {
            content: Record<string, unknown>[];
        }[];
        expect(messages.at(-1)!.content).toContainEqual(
            expect.objectContaining({
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: PNG_1PX },
            }),
        );
    });

    it('sends a page taller than the side limit within it', async () => {
        // The native API refuses an image above 8000 px on a side with HTTP 400, so a tall
        // full-page overview has to arrive scaled to fit.
        provider = await startHermeticAnthropicProvider({
            script: [{ kind: ScriptedReplyKind.Text, text: 'an image arrived' }],
        });
        const runtime = await createTestPiRuntime({
            api: LlmApi.AnthropicMessages,
            baseUrl: provider.baseUrl,
        });
        const page = encodePng(400, VISION_IMAGE_LIMITS.maxSidePx + 1_000, () => [200, 200, 200]);

        const result = await createSingleShotClient(runtime, runtime.visionModel).text({
            messages: [{ role: 'user', text: 'Describe the page.', images: [{ bytes: page }] }],
        });

        expect(result.kind).toBe(SingleShotResultKind.Parsed);
        const messages = provider.requests[0]!.body.messages as {
            content: { type: string; source?: { data: string } }[];
        }[];
        const image = messages.at(-1)!.content.find((part) => part.type === 'image')!;
        const size = imageSize(Buffer.from(image.source!.data, 'base64'));
        expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(
            VISION_IMAGE_LIMITS.maxSidePx,
        );
    });

    it('registers an override reviewer model on the configured API', async () => {
        provider = await startHermeticAnthropicProvider({
            script: [{ kind: ScriptedReplyKind.Text, text: 'reviewed' }],
        });
        const runtime = await createTestPiRuntime({
            api: LlmApi.AnthropicMessages,
            baseUrl: provider.baseUrl,
        });
        const handle = registerAdditionalTextModel(runtime, 'reviewer-model');

        const message = await runtime.modelRuntime.completeSimple(
            handle,
            {
                messages: [{ role: 'user', content: 'Review this.', timestamp: Date.now() }],
            },
            { reasoning: ReasoningEffort.High },
        );

        expect(message.stopReason).toBe(TurnStopReason.Stop);
        expect(provider.requests[0]!.url).toBe('/v1/messages');
        expect(provider.requests[0]!.body.model).toBe('reviewer-model');
        expect(provider.requests[0]!.body.thinking).toHaveProperty('type', 'adaptive');
        expect(provider.requests[0]!.body.output_config).toHaveProperty(
            'effort',
            ReasoningEffort.High,
        );
        expect(provider.requests[0]!.body).not.toHaveProperty('temperature');
    });
});
