import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { WRAP_UP_RESERVE_MS } from '../../src/pi/run-guards';
import { runAgentSession } from '../../src/pi/session-runner';
import type { SessionToolSpec } from '../../src/pi/session-tool-types';
import { SealKind } from '../../src/pi/seal-types';
import { buildTerminalTool } from '../../src/pi/terminal-tool';
import {
    HermeticScenario,
    type HermeticProvider,
    ScriptedReplyKind,
    startHermeticProvider,
} from './hermetic-provider';
import {
    TEST_REASONING_EFFORT,
    TEST_RUN_BUDGETS,
    TEST_RUN_RETRIES,
    createTestPiRuntime,
} from './test-runtime';

const TERMINAL_TOOL_NAME = 'submit_verdict';
const WRAP_UP_TEXT = 'Time is almost up. Call submit_verdict now.';
const VerdictSchema = v.object({ verdict: v.string() });

/**
 * A promise with its resolver held outside it.
 *
 * @returns The promise and the function that settles it.
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve: (() => void) | undefined;
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    return { promise, resolve: () => resolve?.() };
}

let workDir: string;
let provider: HermeticProvider | undefined;

beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'pi-wrap-up-'));
});

afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
});

afterEach(async () => {
    vi.useRealTimers();
    await provider?.close();
    provider = undefined;
});

describe('wall-clock wrap-up', () => {
    it('asks the model for its decision before the wall-clock budget expires', async () => {
        // An investigation that spends its whole budget and ends with no decision posts nothing. The wrap-up message gives the model one more turn.
        const toolEntered = deferred();
        const toolReleased = deferred();
        const slowTool: SessionToolSpec = {
            name: 'slow_probe',
            description: 'Probe the page slowly.',
            parameters: v.object({}),
            execute: async () => {
                toolEntered.resolve();
                await toolReleased.promise;
                return { content: 'probe done' };
            },
        };
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                { kind: ScriptedReplyKind.ToolCall, toolName: 'slow_probe', toolArguments: '{}' },
                {
                    kind: ScriptedReplyKind.ToolCall,
                    toolName: TERMINAL_TOOL_NAME,
                    toolArguments: '{"verdict":"partial"}',
                },
            ],
        });
        const runtime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        const pending = runAgentSession({
            runtime,
            systemPrompt: 'You are a test agent.',
            userTask: 'Investigate, then submit the verdict.',
            nudge: 'Call submit_verdict now.',
            wrapUp: WRAP_UP_TEXT,
            terminal: buildTerminalTool({
                name: TERMINAL_TOOL_NAME,
                description: 'Submit the final verdict.',
                schema: VerdictSchema,
            }),
            tools: [slowTool],
            budgets: { ...TEST_RUN_BUDGETS, wallClockMs: 3 * WRAP_UP_RESERVE_MS },
            retries: TEST_RUN_RETRIES,
            reasoningEffort: TEST_REASONING_EFFORT,
            workDir,
        });
        await toolEntered.promise;
        await vi.advanceTimersByTimeAsync(2 * WRAP_UP_RESERVE_MS);
        toolReleased.resolve();
        vi.useRealTimers();
        const outcome = await pending;

        expect(outcome.kind).toBe(SealKind.Terminal);
        expect(provider.requests).toHaveLength(2);
        expect(JSON.stringify(provider.requests[1]!.messages)).toContain(WRAP_UP_TEXT);
    });
});
