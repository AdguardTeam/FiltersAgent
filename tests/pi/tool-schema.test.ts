import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { runAgentSession } from '../../src/pi/session-runner';
import { buildTerminalTool } from '../../src/pi/terminal-tool';
import { SealKind } from '../../src/pi/seal-types';
import { type SessionToolSpec } from '../../src/pi/session-tool-types';
import { toAdvertisedSchema } from '../../src/pi/tool-schema';
import { FixOutcomeSchema } from '../../src/types/fix-outcome';
import {
    type HermeticProvider,
    HermeticScenario,
    type ScriptedReply,
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
const BOUNDED_TOOL_NAME = 'record_note';
const MAX_NOTE_LENGTH = 8;

const VerdictSchema = v.object({ verdict: v.picklist(['ok', 'retry']) });
type Verdict = v.InferOutput<typeof VerdictSchema>;

const NoteSchema = v.object({
    note: v.pipe(v.string(), v.maxLength(MAX_NOTE_LENGTH)),
});

/**
 * A terminal payload shaped like the fix outcome: a union of object branches, each with its own
 * required fields, so the rendered JSON Schema is an `anyOf` rather than one object.
 */
const UnionVerdictSchema = v.union([
    v.object({ verdict: v.literal('ok'), summary: v.string() }),
    v.object({ verdict: v.literal('retry'), reason: v.string() }),
]);
type UnionVerdict = v.InferOutput<typeof UnionVerdictSchema>;

let workDir: string;
let provider: HermeticProvider | undefined;

beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'pi-tool-schema-'));
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
 * One scripted tool-call reply.
 *
 * @param toolName - Tool the scripted model calls.
 * @param payload - Arguments the scripted model submits.
 * @returns The scripted reply.
 */
function call(toolName: string, payload: unknown): ScriptedReply {
    return {
        kind: ScriptedReplyKind.ToolCall,
        toolName,
        toolArguments: JSON.stringify(payload),
    };
}

/**
 * Run one session whose tool surface carries a bounded string parameter.
 *
 * @param script - The reply sequence the hermetic provider serves.
 * @returns The sealed outcome, the recorded provider requests, and the arguments the bounded tool
 *   actually executed on.
 */
async function runBounded(script: ScriptedReply[]) {
    const executed: Record<string, unknown>[] = [];
    provider = await startHermeticProvider({ scenario: HermeticScenario.Scripted, script });
    const runtime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
    const terminal = buildTerminalTool<Verdict>({
        name: TERMINAL_TOOL_NAME,
        description: 'Submit the final verdict.',
        schema: VerdictSchema,
    });
    const noteTool: SessionToolSpec = {
        name: BOUNDED_TOOL_NAME,
        description: 'Record one short note.',
        parameters: NoteSchema,
        execute: async (args) => {
            executed.push(args as Record<string, unknown>);
            return { content: '{"recorded":true}' };
        },
    };
    const outcome = await runAgentSession<Verdict>({
        runtime,
        systemPrompt: 'You are a test agent. Finish by calling submit_verdict.',
        userTask: 'Record a note, then submit the verdict.',
        nudge: 'Call submit_verdict now.',
        terminal,
        tools: [noteTool],
        budgets: TEST_RUN_BUDGETS,
        retries: TEST_RUN_RETRIES,
        reasoningEffort: TEST_REASONING_EFFORT,
        workDir,
    });
    return { outcome, requests: provider.requests, executed };
}

/**
 * Run one session whose terminal payload is a union of object shapes.
 *
 * @param script - The reply sequence the hermetic provider serves.
 * @returns The sealed outcome and the recorded provider requests.
 */
async function runUnionTerminal(script: ScriptedReply[]) {
    provider = await startHermeticProvider({ scenario: HermeticScenario.Scripted, script });
    const runtime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
    const terminal = buildTerminalTool<UnionVerdict>({
        name: TERMINAL_TOOL_NAME,
        description: 'Submit the final verdict.',
        schema: UnionVerdictSchema,
    });
    const outcome = await runAgentSession<UnionVerdict>({
        runtime,
        systemPrompt: 'You are a test agent. Finish by calling submit_verdict.',
        userTask: 'Submit the verdict.',
        nudge: 'Call submit_verdict now.',
        terminal,
        tools: [],
        budgets: TEST_RUN_BUDGETS,
        retries: TEST_RUN_RETRIES,
        reasoningEffort: TEST_REASONING_EFFORT,
        workDir,
    });
    return { outcome, requests: provider.requests };
}

describe('toAdvertisedSchema', () => {
    it('roots a union terminal at type object without loosening what pi enforces', async () => {
        // Contract: strict OpenAI-compatible upstreams refuse a function whose parameters have no
        // root `type: "object"` — one live pass lost two fix runs mid-session that way —
        // while the union branches must still gate what pi accepts before execute.
        const { outcome, requests } = await runUnionTerminal([
            call(TERMINAL_TOOL_NAME, { verdict: 'ok' }),
            call(TERMINAL_TOOL_NAME, { verdict: 'retry', reason: 'later' }),
        ]);

        const tools = requests[0]!.tools as {
            function: { name: string; parameters: Record<string, unknown> };
        }[];
        const advertised = tools.find((tool) => tool.function.name === TERMINAL_TOOL_NAME);
        expect(advertised?.function.parameters).toMatchObject({
            type: 'object',
            anyOf: [{ type: 'object' }, { type: 'object' }],
        });
        // The branch-incomplete first submission was bounced by pi; the complete one sealed.
        expect(requests.length).toBe(2);
        expect(outcome).toMatchObject({
            kind: SealKind.Terminal,
            payload: { verdict: 'retry', reason: 'later' },
        });
    });

    it('roots the shipped fix outcome at type object', () => {
        expect(toAdvertisedSchema(FixOutcomeSchema)).toMatchObject({ type: 'object' });
    });

    it('advertises the schema bound on the wire and lets pi enforce it before execute', async () => {
        // The advertisement is not decoration: pi compiles it with TypeBox and checks the raw
        // arguments BEFORE execute runs. A bound the advertisement drops is a bound the model is
        // never machine-checked against, so it burns a whole turn discovering it from prose.
        const { outcome, requests, executed } = await runBounded([
            call(BOUNDED_TOOL_NAME, { note: 'far too long for the bound' }),
            call(TERMINAL_TOOL_NAME, { verdict: 'ok' }),
        ]);

        const tools = requests[0]!.tools as {
            function: { name: string; parameters: Record<string, unknown> };
        }[];
        const advertised = tools.find((tool) => tool.function.name === BOUNDED_TOOL_NAME);
        expect(advertised?.function.parameters).toEqual({
            type: 'object',
            properties: { note: { type: 'string', maxLength: MAX_NOTE_LENGTH } },
            required: ['note'],
        });

        // pi bounced the over-long note itself: the handler never saw the call.
        expect(executed).toEqual([]);
        expect(outcome.kind).toBe(SealKind.Terminal);
        const toolReplies = JSON.stringify(requests[1]!.messages.filter((m) => m.role === 'tool'));
        expect(toolReplies).toContain(BOUNDED_TOOL_NAME);
    });

    it('passes an in-bounds call through to the tool handler', async () => {
        const { outcome, executed } = await runBounded([
            call(BOUNDED_TOOL_NAME, { note: 'short' }),
            call(TERMINAL_TOOL_NAME, { verdict: 'ok' }),
        ]);

        expect(executed).toEqual([{ note: 'short' }]);
        expect(outcome.kind).toBe(SealKind.Terminal);
    });
});
