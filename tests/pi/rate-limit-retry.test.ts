import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { LlmApi } from '../../src/config/llm-api';
import { SealKind } from '../../src/pi/seal-types';
import { createSingleShotClient } from '../../src/pi/single-shot';
import { SingleShotResultKind } from '../../src/pi/single-shot-types';
import {
    type HermeticAnthropicProvider,
    startHermeticAnthropicProvider,
} from './hermetic-anthropic-provider';
import { ScriptedReplyKind, type ScriptedReply } from './hermetic-provider';
import {
    createTestPiRuntime,
    runScriptedSession,
    TEST_TERMINAL_TOOL_NAME as TERMINAL_TOOL_NAME,
} from './test-runtime';

/**
 * The refusal two concurrent series runs met on one Anthropic organization.
 */
const CONCURRENCY_LIMIT: ScriptedReply = {
    kind: ScriptedReplyKind.Error,
    status: 429,
    message:
        "Number of concurrent requests across all models has exceeded your organization's limit.",
};

/**
 * A per-minute provider limit: the first retry has to land in the next window.
 */
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * One step of the faked clock; real I/O runs between steps, so a reply the client is still reading
 * schedules its wait before the clock moves past it.
 */
const STEP_MS = 1_000;

const VerdictSchema = v.object({ verdict: v.string() });

/**
 * Advance the faked clock in steps, letting real I/O run between them.
 *
 * @param totalMs - Fake time to pass.
 */
async function advanceInSteps(totalMs: number): Promise<void> {
    for (let elapsed = 0; elapsed < totalMs; elapsed += STEP_MS) {
        await vi.advanceTimersByTimeAsync(STEP_MS);
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

/**
 * Step the faked clock until the provider has seen the expected number of requests.
 *
 * @param count - Requests to wait for.
 */
async function stepUntilRequests(count: number): Promise<void> {
    await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(STEP_MS);
        expect(provider?.requests).toHaveLength(count);
    });
}

let workDir: string;
let provider: HermeticAnthropicProvider | undefined;

beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'pi-rate-limit-'));
});

afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
});

afterEach(async () => {
    vi.useRealTimers();
    await provider?.close();
    provider = undefined;
});

describe('a provider rate limit', () => {
    it('makes a loop turn wait out the window before its retry', async () => {
        provider = await startHermeticAnthropicProvider({
            script: [
                CONCURRENCY_LIMIT,
                {
                    kind: ScriptedReplyKind.ToolCall,
                    toolName: TERMINAL_TOOL_NAME,
                    toolArguments: JSON.stringify({ verdict: 'ok', summary: 'after the limit' }),
                },
            ],
        });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        const pending = runScriptedSession({
            baseUrl: provider.baseUrl,
            api: LlmApi.AnthropicMessages,
            retries: { maxRetries: 2 },
            workDir,
        });
        await vi.waitFor(() => expect(provider?.requests).toHaveLength(1));
        await advanceInSteps(RATE_LIMIT_WINDOW_MS - STEP_MS);
        expect(provider.requests).toHaveLength(1);
        await stepUntilRequests(2);
        vi.useRealTimers();
        const outcome = await pending;

        expect(outcome.kind).toBe(SealKind.Terminal);
        expect(provider.requests).toHaveLength(2);
    });

    it('makes a single-shot call wait out the window before its retry', async () => {
        // Pi's transport retry answers the first refusal on its own within a second; the call's
        // own retry starts once that one is spent.
        provider = await startHermeticAnthropicProvider({
            script: [
                CONCURRENCY_LIMIT,
                CONCURRENCY_LIMIT,
                { kind: ScriptedReplyKind.Text, text: '{"verdict":"present"}' },
            ],
        });
        const runtime = await createTestPiRuntime({
            api: LlmApi.AnthropicMessages,
            baseUrl: provider.baseUrl,
        });
        const client = createSingleShotClient(runtime, runtime.visionModel, { maxRetries: 1 });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        const pending = client.structured({
            messages: [{ role: 'user', text: 'inspect' }],
            schema: VerdictSchema,
        });
        await stepUntilRequests(2);
        await advanceInSteps(RATE_LIMIT_WINDOW_MS - STEP_MS);
        expect(provider.requests).toHaveLength(2);
        await stepUntilRequests(3);
        vi.useRealTimers();
        const result = await pending;

        expect(result.kind).toBe(SingleShotResultKind.Parsed);
        expect(provider.requests).toHaveLength(3);
    });
});
