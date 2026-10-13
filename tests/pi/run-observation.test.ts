import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { type PiRuntime } from '../../src/pi/runtime';
import { runAgentSession } from '../../src/pi/session-runner';
import { toTurnStopReason, TurnStopReason } from '../../src/pi/stop-reason';
import { SealKind } from '../../src/pi/seal-types';
import { buildTerminalTool } from '../../src/pi/terminal-tool';
import type { SessionTurnObservation } from '../../src/pi/session-observations';
import type { SessionToolSpec } from '../../src/pi/session-tool-types';
import type { Logger } from '../../src/logger/logger';
import {
    HermeticScenario,
    type HermeticProvider,
    type ScriptedReply,
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

const TERMINAL_TOOL_NAME = 'submit_verdict';

const VerdictSchema = v.object({
    verdict: v.picklist(['ok', 'retry']),
    summary: v.string(),
});
type Verdict = v.InferOutput<typeof VerdictSchema>;

const LOOKUP_TOOL: SessionToolSpec = {
    name: 'lookup',
    description: 'Look up a value.',
    parameters: v.object({}),
    execute: async () => ({ content: 'found' }),
};

/**
 * A logger that swallows every level, for the suites that deliberately provoke a diagnostic.
 *
 * @returns The quiet logger.
 */
function quietLogger(): Logger {
    return {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
    } as unknown as Logger;
}

let workDir: string;
let provider: HermeticProvider | undefined;

beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'pi-run-observation-'));
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
 * Run one session against a scripted hermetic provider with an optional turn observer.
 *
 * @param script - The reply sequence the provider serves.
 * @param onTurnEnd - Optional observer passed to the session runner.
 * @param logger - Optional logger, so a suite that provokes observer failures stays quiet.
 * @returns The sealed outcome.
 */
async function runScripted(
    script: ScriptedReply[],
    onTurnEnd?: (observation: SessionTurnObservation) => void,
    logger?: Logger,
) {
    provider = await startHermeticProvider({
        scenario: HermeticScenario.Scripted,
        script,
    });
    const runtime: PiRuntime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
    const terminal = buildTerminalTool<Verdict>({
        name: TERMINAL_TOOL_NAME,
        description: 'Submit the final verdict.',
        schema: VerdictSchema,
    });
    return runAgentSession<Verdict>({
        runtime,
        systemPrompt: 'You are a test agent. Finish by calling submit_verdict.',
        userTask: 'Test task.',
        nudge: 'Call submit_verdict now.',
        terminal,
        tools: [LOOKUP_TOOL],
        budgets: TEST_RUN_BUDGETS,
        retries: TEST_RUN_RETRIES,
        reasoningEffort: TEST_REASONING_EFFORT,
        workDir,
        onTurnEnd,
        logger,
    });
}

describe('onTurnEnd observation', () => {
    it('observes one turn per provider request with stop reasons, tool names, and usage', async () => {
        const observed: SessionTurnObservation[] = [];
        const outcome = await runScripted(
            [
                { kind: ScriptedReplyKind.ToolCall, toolName: 'lookup', toolArguments: '{}' },
                { kind: ScriptedReplyKind.Text, text: 'I am done talking.' },
                { kind: ScriptedReplyKind.Text, text: 'Still not calling the terminal tool.' },
            ],
            (observation) => observed.push(observation),
        );

        expect(outcome.kind).toBe(SealKind.NoTerminal);
        expect(observed).toHaveLength(3);
        expect(observed[0]).toMatchObject({
            index: 0,
            stopReason: 'toolUse',
            toolCallNames: ['lookup'],
        });
        expect(observed[0].usage).toMatchObject({ input: 11, output: 5 });
        expect(observed[1]).toMatchObject({
            index: 1,
            stopReason: 'stop',
            toolCallNames: [],
            text: 'I am done talking.',
        });
        expect(observed[2]).toMatchObject({ index: 2, stopReason: 'stop' });
    });

    it('never lets an observer failure break the run', async () => {
        const outcome = await runScripted(
            [
                { kind: ScriptedReplyKind.Text, text: 'one' },
                { kind: ScriptedReplyKind.Text, text: 'two' },
            ],
            () => {
                throw new Error('observer exploded');
            },
            // The failure IS logged (asserted in the session-runner suite, which owns that
            // contract); this suite only cares that the run survives, so it stays quiet here.
            quietLogger(),
        );

        expect(outcome.kind).toBe(SealKind.NoTerminal);
    });

    it('marks a turn the provider sent no usage chunk for as unreported', async () => {
        // The observation and the run's usage report are built from ONE mapping of pi's usage, so
        // a turn without a usage chunk cannot reach the trace as four zeros while the usage
        // summary counts it as unreported.
        const observed: SessionTurnObservation[] = [];
        const outcome = await runScripted(
            [{ kind: ScriptedReplyKind.Text, text: 'no telemetry for this one', usage: null }],
            (observation) => observed.push(observation),
        );

        expect(outcome.kind).toBe(SealKind.NoTerminal);
        expect(observed[0]!.usage).toEqual({
            // The usage carries its own pricing attribution now, so the trace and the usage report
            // are literally the same object rather than two copies that can drift.
            model: REASONING_MODEL,
            reported: false,
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoningTokens: 0,
        });
    });

    it('carries the provider error message of a failed turn', async () => {
        // A failed turn used to be observed as a bare `error` stop reason with no cause. It is the
        // only host-visible record of the attempt: pi deletes the failed message from agent state
        // before it retries, so a run that fails transiently and then succeeds seals with no trace
        // of the failures at all.
        const observed: SessionTurnObservation[] = [];
        const outcome = await runScripted(
            [
                {
                    kind: ScriptedReplyKind.Error,
                    status: 401,
                    message: 'the gateway rejected the key',
                },
            ],
            (observation) => observed.push(observation),
            quietLogger(),
        );

        expect(outcome.kind).toBe(SealKind.ProviderFailure);
        expect(observed).toHaveLength(1);
        expect(observed[0]!.stopReason).toBe(TurnStopReason.Error);
        expect(observed[0]!.errorMessage).toContain('the gateway rejected the key');
    });
});

describe('turn stop reasons', () => {
    it('degrades a stop reason this codebase does not name onto Unknown', () => {
        // Every observation stop reason reaches the trace and the orchestrator's drain decision, so
        // it must be a member of the declared set: a reason pi grows arrives as `unknown` instead
        // of as a raw harness string nothing downstream knows how to read.
        expect(toTurnStopReason('toolUse')).toBe(TurnStopReason.ToolUse);
        expect(toTurnStopReason('handoff')).toBe(TurnStopReason.Unknown);
    });
});
