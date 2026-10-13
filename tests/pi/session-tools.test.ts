import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import * as v from 'valibot';
import { ToolRegistry } from '../../src/agent/tool-registry';
import { type PiRuntime } from '../../src/pi/runtime';
import { runAgentSession } from '../../src/pi/session-runner';
import {
    adaptSessionTools,
    type AdaptedToolInput,
    withToolDeadline,
} from '../../src/pi/session-tools';
import {
    MAX_TOOL_RESULT_BYTES,
    serializeToolResultForModel,
    TRUNCATED_TOOL_RESULT_HEAD_CHARS,
} from '../../src/pi/tool-result-envelope';
import { buildTerminalTool } from '../../src/pi/terminal-tool';
import { buildRegistrySessionTools } from '../../src/session/registry-session-tools';
import { SealKind } from '../../src/pi/seal-types';
import { ToolGateCause, type SessionToolSpec } from '../../src/pi/session-tool-types';
import { TOOL_GUIDANCE } from '../../src/agent/tool-catalog';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
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
const NUDGE_TEXT = 'You ended your turn without calling submit_verdict. Call it now.';

const VerdictSchema = v.object({
    verdict: v.picklist(['ok', 'retry']),
    summary: v.string(),
});
type Verdict = v.InferOutput<typeof VerdictSchema>;

const VALID_PAYLOAD: Verdict = { verdict: 'ok', summary: 'all good' };

let workDir: string;
let provider: HermeticProvider | undefined;

beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'pi-session-tools-'));
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
 * @returns The scripted reply.
 */
function verdictCall(payload: unknown): ScriptedReply {
    return {
        kind: ScriptedReplyKind.ToolCall,
        toolName: TERMINAL_TOOL_NAME,
        toolArguments: JSON.stringify(payload),
    };
}

/**
 * One scripted non-terminal tool-call reply.
 *
 * @param toolName - The tool the scripted model calls.
 * @param toolArguments - JSON-encoded call arguments.
 * @returns The scripted reply.
 */
function toolCall(toolName: string, toolArguments: string): ScriptedReply {
    return { kind: ScriptedReplyKind.ToolCall, toolName, toolArguments };
}

/**
 * A stub tool definition for a registered session-surface tool name.
 *
 * @param name - The tool name (must resolve in TOOL_PARAMETER_SCHEMAS and TOOL_GUIDANCE).
 * @returns The definition record for ToolRegistry.register.
 */
function stubName(name: string) {
    return {
        type: 'function' as const,
        function: {
            name,
            description: name,
            parameters: { type: 'object' as const, properties: {}, required: [] },
        },
    };
}

/**
 * Run one session with an adapted tool set against a scripted hermetic provider.
 *
 * @param script - The reply sequence the provider serves.
 * @param tools - The adapted session tools.
 * @returns The sealed outcome and the provider's recorded requests.
 */
async function runScriptedTools(script: ScriptedReply[], tools: SessionToolSpec[]) {
    provider = await startHermeticProvider({ scenario: HermeticScenario.Scripted, script });
    const runtime: PiRuntime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
    const terminal = buildTerminalTool<Verdict>({
        name: TERMINAL_TOOL_NAME,
        description: 'Submit the final verdict.',
        schema: VerdictSchema,
    });
    const outcome = await runAgentSession<Verdict>({
        runtime,
        systemPrompt: 'You are a test agent. Finish by calling submit_verdict.',
        userTask: 'Work the tools, then submit the verdict.',
        nudge: NUDGE_TEXT,
        terminal,
        tools,
        budgets: TEST_RUN_BUDGETS,
        retries: TEST_RUN_RETRIES,
        reasoningEffort: TEST_REASONING_EFFORT,
        workDir,
    });
    return { outcome, requests: provider.requests };
}

describe('adapted tools through the session runner', () => {
    it('quarantines inspect_full_page_capture after three incomplete captures', async () => {
        const recorder = new TraceRecorder({
            runId: 'session-quarantine',
            issueNumber: 1,
            mode: 'fix',
        });
        const registry = new ToolRegistry();
        registry.register({
            definition: stubName('inspect_full_page_capture'),
            handler: async () => ({
                error: 'The latest full-page tile capture is incomplete.',
                errorKind: 'full_page_capture_incomplete',
            }),
        });
        const tools = buildRegistrySessionTools(registry, recorder);

        const { outcome, requests } = await runScriptedTools(
            [
                toolCall('inspect_full_page_capture', '{}'),
                toolCall('inspect_full_page_capture', '{}'),
                toolCall('inspect_full_page_capture', '{}'),
                toolCall('inspect_full_page_capture', '{}'),
                verdictCall(VALID_PAYLOAD),
            ],
            tools,
        );

        expect(outcome.kind).toBe(SealKind.Terminal);
        expect(requests).toHaveLength(5);
        // The fourth call was refused before dispatch: the session continued on the gate refusal.
        const refusalRequest = JSON.stringify(requests[4]!.messages);
        expect(refusalRequest).toContain('tool_gated');
        expect(refusalRequest).toContain('inspect_full_page_capture is disabled');
        expect(refusalRequest).toContain(ToolGateCause.Quarantined);
        const advertised = requests.map((request) => JSON.stringify(request.tools));
        expect(new Set(advertised).size).toBe(1);
    });

    it('resets the evaluate_js policy-rejection counter on a success', async () => {
        const recorder = new TraceRecorder({
            runId: 'session-quarantine-reset',
            issueNumber: 1,
            mode: 'fix',
        });
        const results = [
            { errorKind: 'policy_rejection', error: 'rejected 1' },
            { errorKind: 'policy_rejection', error: 'rejected 2' },
            { ok: true },
            { errorKind: 'policy_rejection', error: 'rejected 3' },
            { errorKind: 'policy_rejection', error: 'rejected 4' },
            { errorKind: 'policy_rejection', error: 'rejected 5' },
            { errorKind: 'policy_rejection', error: 'rejected 6' },
        ];
        const registry = new ToolRegistry();
        registry.register({
            definition: stubName('evaluate_js'),
            handler: async () => results.shift() ?? { ok: true },
        });
        const tools = buildRegistrySessionTools(registry, recorder);

        const { outcome, requests } = await runScriptedTools(
            [
                toolCall('evaluate_js', '{"expression":"document.body"}'),
                toolCall('evaluate_js', '{"expression":"document.body"}'),
                toolCall('evaluate_js', '{"expression":"document.body"}'),
                toolCall('evaluate_js', '{"expression":"document.body"}'),
                toolCall('evaluate_js', '{"expression":"document.body"}'),
                toolCall('evaluate_js', '{"expression":"document.body"}'),
                toolCall('evaluate_js', '{"expression":"document.body"}'),
                verdictCall(VALID_PAYLOAD),
            ],
            tools,
        );

        expect(outcome.kind).toBe(SealKind.Terminal);
        const refusalRequest = JSON.stringify(requests[7]!.messages);
        expect(refusalRequest).toContain('tool_gated');
        expect(refusalRequest).toContain('evaluate_js is disabled');
        expect(refusalRequest).toContain(ToolGateCause.Quarantined);
    });

    it('advertises a byte-identical tool list while a gate flips, the refusal naming reason and remedy', async () => {
        // The environment latch prepare_env owns: use_browser's gate callback reads it on every
        // call, so availability flips between the provider's second and third requests without
        // the advertised list moving.
        let environmentLocked = false;
        const tools = adaptSessionTools([
            {
                name: 'prepare_env',
                description: 'Select and lock the environment.',
                parameters: v.object({}),
                execute: async () => {
                    environmentLocked = true;
                    return { prepared: true };
                },
            },
            {
                name: 'use_browser',
                description: 'Use the browser of the selected environment.',
                parameters: v.object({ url: v.string() }),
                gate: () =>
                    environmentLocked
                        ? undefined
                        : {
                              cause: ToolGateCause.EnvironmentPending,
                              reason: 'no environment is selected yet',
                              remedy: 'Call prepare_env first.',
                          },
                execute: async () => ({ browsed: true }),
            },
        ]);

        const { outcome, requests } = await runScriptedTools(
            [
                toolCall('use_browser', '{"url":"https://example.test"}'),
                toolCall('prepare_env', '{}'),
                toolCall('use_browser', '{"url":"https://example.test"}'),
                verdictCall(VALID_PAYLOAD),
            ],
            tools,
        );

        expect(outcome.kind).toBe(SealKind.Terminal);
        if (outcome.kind !== SealKind.Terminal) {
            return;
        }
        expect(outcome.payload).toEqual(VALID_PAYLOAD);
        expect(requests).toHaveLength(4);

        // AC1: the advertised tool list is byte-identical on every request of the session.
        const advertised = requests.map((request) => JSON.stringify(request.tools));
        for (const list of advertised) {
            expect(list).toBe(advertised[0]);
        }
        const firstTools = requests[0]!.tools as { function: { name: string } }[];
        expect(firstTools.map((tool) => tool.function.name)).toEqual(
            expect.arrayContaining(['prepare_env', 'use_browser', TERMINAL_TOOL_NAME]),
        );

        // AC2: the gated call returned the reason and the unblocking action, and the run went on.
        const afterGatedCall = JSON.stringify(requests[1]!.messages);
        expect(afterGatedCall).toContain('no environment is selected yet');
        expect(afterGatedCall).toContain('Call prepare_env first.');
        expect(JSON.stringify(requests[3]!.messages)).toContain('browsed');
    });

    it('delivers the deadline envelope when a tool exceeds its deadline, and the session continues', async () => {
        const tools = adaptSessionTools([
            {
                name: 'slow_probe',
                description: 'A probe that hangs.',
                parameters: v.object({}),
                deadlineMs: 50,
                execute: async (_args, signal) =>
                    new Promise<Record<string, unknown>>((_resolve, reject) => {
                        signal?.addEventListener(
                            'abort',
                            () => reject(new Error('slow_probe aborted')),
                            { once: true },
                        );
                    }),
            },
        ]);

        const { outcome, requests } = await runScriptedTools(
            [toolCall('slow_probe', '{}'), verdictCall(VALID_PAYLOAD)],
            tools,
        );

        expect(outcome.kind).toBe(SealKind.Terminal);
        expect(requests).toHaveLength(2);
        const afterDeadline = JSON.stringify(requests[1]!.messages);
        expect(afterDeadline).toContain('tool_deadline_exceeded');
        expect(afterDeadline).toContain('choose_a_different_action');
    });

    it('delivers an oversized tool result as the truncation envelope', async () => {
        const tools = adaptSessionTools([
            {
                name: 'fat_log',
                description: 'Returns a huge log.',
                parameters: v.object({}),
                execute: async () => ({ blob: 'x'.repeat(70 * 1024) }),
            },
        ]);

        const { outcome, requests } = await runScriptedTools(
            [toolCall('fat_log', '{}'), verdictCall(VALID_PAYLOAD)],
            tools,
        );

        expect(outcome.kind).toBe(SealKind.Terminal);
        expect(requests).toHaveLength(2);
        const toolMessages = requests[1]!.messages.filter((m) => m.role === 'tool');
        const envelope = JSON.parse(String(toolMessages.at(-1)?.content)) as Record<
            string,
            unknown
        >;
        expect(envelope.truncated).toBe(true);
        expect(envelope.originalBytes).toBeGreaterThan(MAX_TOOL_RESULT_BYTES);
        expect(typeof envelope.head).toBe('string');
        expect((envelope.head as string).length).toBeLessThanOrEqual(
            TRUNCATED_TOOL_RESULT_HEAD_CHARS,
        );
        expect(String(envelope.note)).toContain(String(MAX_TOOL_RESULT_BYTES));
    });

    it('hands the result observer the truncation envelope the model saw, not the full result', async () => {
        const observed: Record<string, unknown>[] = [];
        const tools = adaptSessionTools([
            {
                name: 'fat_log',
                description: 'Returns a huge log.',
                parameters: v.object({}),
                execute: async () => ({ blob: 'x'.repeat(70 * 1024) }),
                onResult: (modelFacing) => observed.push(modelFacing),
            },
        ]);

        const { outcome } = await runScriptedTools(
            [toolCall('fat_log', '{}'), verdictCall(VALID_PAYLOAD)],
            tools,
        );

        // agent-observations.json is published as the results proven to have reached the model, so
        // an oversized call must be recorded at the envelope, not at the megabytes behind it.
        expect(outcome.kind).toBe(SealKind.Terminal);
        expect(observed).toHaveLength(1);
        expect(observed[0]!.truncated).toBe(true);
        expect(observed[0]!.blob).toBeUndefined();
        expect(Buffer.byteLength(JSON.stringify(observed[0]), 'utf8')).toBeLessThanOrEqual(
            MAX_TOOL_RESULT_BYTES,
        );
    });

    it('delivers pi-coerced arguments through the adapter re-check to the handler', async () => {
        const tools = adaptSessionTools([
            {
                name: 'echo_probe',
                description: 'Echoes its text argument.',
                parameters: v.object({ text: v.string() }),
                execute: async (args) => ({ echo: args.text, echoType: typeof args.text }),
            },
        ]);

        const { outcome, requests } = await runScriptedTools(
            [toolCall('echo_probe', '{"text":42}'), verdictCall(VALID_PAYLOAD)],
            tools,
        );

        expect(outcome.kind).toBe(SealKind.Terminal);
        expect(requests).toHaveLength(2);
        // The real boundary: pi's pre-execute validation converts the number to '42' for the
        // advertised string field, the adapter's Valibot re-check lets the converted value
        // through, and the handler observes a string — the documented coercion deviation from
        // legacy raw-argument semantics, pinned as shipped behavior.
        const toolMessages = requests[1]!.messages.filter((m) => m.role === 'tool');
        const echo = JSON.parse(String(toolMessages.at(-1)?.content)) as Record<string, unknown>;
        expect(echo).toEqual({ echo: '42', echoType: 'string' });
    });
});

describe('serializeToolResultForModel', () => {
    it('serializes a redacted small result without an envelope', () => {
        const { content, redacted, truncatedFromBytes } = serializeToolResultForModel({
            ok: true,
            authorization: 'Bearer secret',
        });

        expect(JSON.parse(content)).toEqual({ ok: true, authorization: '[redacted]' });
        expect(redacted).toEqual({ ok: true, authorization: '[redacted]' });
        expect(truncatedFromBytes).toBeUndefined();
    });

    it('hands the model the page-authored evidence a persisted copy would scrub', () => {
        // The model-facing redaction scope: credentials still go, but the two rules that match on
        // shape rather than secrecy must not rewrite what the run is investigating — the consent
        // banner's DOM line a selector is derived from, and the URL parameters a report is about.
        const { content } = serializeToolResultForModel({
            dom: 'Cookie: settings\nSee https://shop.example/checkout?sid=abc&step=2',
            authorization: 'Bearer live-key',
        });

        const result = JSON.parse(content) as Record<string, string>;
        expect(result.dom).toContain('Cookie: settings');
        expect(result.dom).toContain('sid=abc');
        expect(result.authorization).toBe('[redacted]');
    });

    it('replaces an oversized result with the structural envelope', () => {
        const blob = 'x'.repeat(70 * 1024);

        const { content, truncatedFromBytes } = serializeToolResultForModel({ blob });

        const envelope = JSON.parse(content) as Record<string, unknown>;
        expect(envelope.truncated).toBe(true);
        expect(envelope.originalBytes).toBe(truncatedFromBytes);
        expect(truncatedFromBytes).toBeGreaterThan(MAX_TOOL_RESULT_BYTES);
        expect(typeof envelope.head).toBe('string');
        expect((envelope.head as string).length).toBeLessThanOrEqual(
            TRUNCATED_TOOL_RESULT_HEAD_CHARS,
        );
        expect(String(envelope.note)).toContain(String(MAX_TOOL_RESULT_BYTES));
    });

    it('never ends the envelope head on a lone UTF-16 high surrogate', () => {
        // 8182 x's after the 9-character `{"blob":"` prefix place the emoji's high surrogate
        // exactly at the head cut index.
        const blob = `${'x'.repeat(8182)}😀${'y'.repeat(70 * 1024)}`;

        const { content } = serializeToolResultForModel({ blob });

        const envelope = JSON.parse(content) as { head: string };
        expect(envelope.head.length).toBe(TRUNCATED_TOOL_RESULT_HEAD_CHARS - 1);
        expect(envelope.head.endsWith('x')).toBe(true);
    });
});

describe('withToolDeadline', () => {
    it('returns the call result when the call beats the deadline', async () => {
        const result = await withToolDeadline('probe', async () => ({ ok: true }), 1_000);

        expect(result).toEqual({ ok: true });
    });

    it('aborts the call and returns the deadline envelope when the deadline expires', async () => {
        let observedSignal: AbortSignal | undefined;

        const result = await withToolDeadline(
            'slow_probe',
            (signal) =>
                new Promise<Record<string, unknown>>((_resolve, reject) => {
                    observedSignal = signal;
                    signal.addEventListener(
                        'abort',
                        () => reject(new Error('slow_probe aborted')),
                        { once: true },
                    );
                }),
            50,
        );

        expect(observedSignal?.aborted).toBe(true);
        expect(result.errorKind).toBe('tool_deadline_exceeded');
        expect(String(result.error)).toContain('slow_probe did not return within');
        expect(result.retryable).toBe(true);
        expect(result.requiredAction).toBe('choose_a_different_action');
    });

    it('propagates a call rejection instead of mapping it to the deadline envelope', async () => {
        await expect(
            withToolDeadline(
                'probe',
                async () => {
                    throw new Error('probe exploded');
                },
                1_000,
            ),
        ).rejects.toThrow('probe exploded');
    });
});

describe('adaptSessionTools', () => {
    it('attaches the moved guidance as the tool description', () => {
        const tools = adaptSessionTools(
            [
                {
                    name: 'search_rules',
                    parameters: v.object({}),
                    execute: async () => ({ ok: true }),
                },
            ],
            { guidance: TOOL_GUIDANCE },
        );

        expect(tools[0]!.description).toBe(TOOL_GUIDANCE.search_rules);
    });

    it('prefers an explicit description and refuses a tool with no guidance at all', () => {
        const tools = adaptSessionTools([
            {
                name: 'custom_probe',
                description: 'Custom probe.',
                parameters: v.object({}),
                execute: async () => ({}),
            },
        ]);
        expect(tools[0]!.description).toBe('Custom probe.');

        expect(() =>
            adaptSessionTools([
                { name: 'unguided', parameters: v.object({}), execute: async () => ({}) },
            ]),
        ).toThrow(/No usage guidance/);
    });

    it('throws on duplicate tool names instead of advertising one handler twice', () => {
        const input: AdaptedToolInput = {
            name: 'custom_probe',
            description: 'Custom probe.',
            parameters: v.object({}),
            execute: async () => ({}),
        };

        expect(() => adaptSessionTools([input, { ...input }])).toThrow(/duplicate tool name/i);
    });

    it('answers a gated call with the reason and remedy, then the redacted result once the gate lifts', async () => {
        // The owner's own latch, exactly as the wiring holds it: the adapter reads the callback
        // per call, so lifting the latch is what makes the tool usable again.
        let quarantined = true;
        const tools = adaptSessionTools([
            {
                name: 'custom_probe',
                description: 'Custom probe.',
                parameters: v.object({}),
                gate: () =>
                    quarantined
                        ? {
                              cause: ToolGateCause.Quarantined,
                              reason: 'disabled for the remainder of this run after repeated policy rejections',
                              remedy: 'Continue with the evidence already collected; do not retry it.',
                          }
                        : undefined,
                execute: async () => ({ token: 'secret-value', ok: true }),
            },
        ]);

        const gated = await tools[0]!.execute({}, undefined);
        const refusal = JSON.parse(gated.content) as Record<string, unknown>;
        expect(refusal.errorKind).toBe('tool_gated');
        expect(refusal.gate).toBe(ToolGateCause.Quarantined);
        expect(String(refusal.error)).toContain('disabled for the remainder of this run');
        expect(String(refusal.remedy)).toContain('do not retry');

        quarantined = false;
        const result = await tools[0]!.execute({}, undefined);
        expect(JSON.parse(result.content)).toEqual({ token: '[redacted]', ok: true });
        expect(result.details).toEqual({ token: '[redacted]', ok: true });
    });

    it('refuses a gated call before the argument re-check, so the model is never told to retry', async () => {
        // The order is the contract: a gated tool's remedy is actionable whatever the arguments
        // were. If the Valibot re-check ran first, this call would come back as a retryable
        // validation_error and the model would keep hammering a tool that will never run.
        const handler = vi.fn(async () => ({ ok: true }));
        const tools = adaptSessionTools([
            {
                name: 'custom_probe',
                description: 'Custom probe.',
                parameters: v.object({ query: v.pipe(v.string(), v.minLength(5)) }),
                gate: () => ({
                    cause: ToolGateCause.BrowserClosed,
                    reason: 'the browser session is no longer active',
                    remedy: 'Start a new browser session with launch_browser before using it.',
                }),
                execute: handler,
            },
        ]);

        const result = await tools[0]!.execute({ query: 'ab' }, undefined);

        const refusal = JSON.parse(result.content) as Record<string, unknown>;
        expect(handler).not.toHaveBeenCalled();
        expect(refusal.errorKind).toBe('tool_gated');
        expect(refusal.gate).toBe(ToolGateCause.BrowserClosed);
        expect(refusal.retryable).toBeUndefined();
    });

    it('refuses arguments that reach execute but fail the full Valibot schema', async () => {
        const handler = vi.fn(async () => ({ ok: true }));
        const tools = adaptSessionTools([
            {
                name: 'custom_probe',
                description: 'Custom probe.',
                // The advertisement now carries this bound too, so pi normally bounces such a call
                // before execute. The adapter still owns the guarantee that a handler never sees
                // unvalidated arguments: every caller that invokes execute without pi in front of
                // it (the registry stubs, the replayer) depends on this envelope, not on pi's.
                parameters: v.object({ query: v.pipe(v.string(), v.minLength(5)) }),
                execute: handler,
            },
        ]);

        const result = await tools[0]!.execute({ query: 'ab' }, undefined);

        const envelope = JSON.parse(result.content) as Record<string, unknown>;
        expect(handler).not.toHaveBeenCalled();
        expect(envelope.errorKind).toBe('validation_error');
        expect(String(envelope.error)).toContain('query');
        expect(envelope.retryable).toBe(true);
        expect(envelope.requiredAction).toBe('correct_the_arguments');
    });

    it('hands the handler the Valibot-parsed arguments, not the raw call', async () => {
        let received: Record<string, unknown> | undefined;
        const tools = adaptSessionTools([
            {
                name: 'custom_probe',
                description: 'Custom probe.',
                parameters: v.object({
                    url: v.string(),
                    limit: v.optional(v.number(), 10),
                }),
                execute: async (args) => {
                    received = args;
                    return { ok: true };
                },
            },
        ]);

        await tools[0]!.execute({ url: 'https://x.test' }, undefined);

        // Defaults applied by the schema — proof the handler sees the parsed output.
        expect(received).toEqual({ url: 'https://x.test', limit: 10 });
    });

    it('keeps the full redacted result in details when the content becomes the envelope', async () => {
        const blob = 'x'.repeat(70 * 1024);
        const tools = adaptSessionTools([
            {
                name: 'custom_probe',
                description: 'Custom probe.',
                parameters: v.object({}),
                execute: async () => ({ blob }),
            },
        ]);

        const result = await tools[0]!.execute({}, undefined);

        const envelope = JSON.parse(result.content) as Record<string, unknown>;
        expect(envelope.truncated).toBe(true);
        expect(result.details).toEqual({ blob });
    });

    it('logs a thrown handler error with its stack before mapping the envelope', async () => {
        const errorSpy = vi.fn();
        const logger = {
            info: vi.fn(),
            warn: vi.fn(),
            error: errorSpy,
        } as unknown as Logger;
        const tools = adaptSessionTools(
            [
                {
                    name: 'custom_probe',
                    description: 'Custom probe.',
                    parameters: v.object({}),
                    execute: async () => {
                        throw new Error('probe exploded');
                    },
                },
            ],
            { logger },
        );

        const result = await tools[0]!.execute({}, undefined);

        const logged = errorSpy.mock.calls[0]!;
        expect(logged[0]).toMatchObject({ tool: 'custom_probe' });
        expect((logged[0] as { err: Error }).err.message).toBe('probe exploded');
        expect((logged[0] as { err: Error }).err.stack).toEqual(expect.any(String));
        expect(JSON.parse(result.content)).toEqual({ error: 'probe exploded' });
    });

    it('tells the model what a non-Error rejection was, instead of an empty object', async () => {
        // A handler that rejects with a string (or any non-Error) used to be cast to Error and
        // read for `.message`: the model received `{}` and had nothing to react to.
        const tools = adaptSessionTools([
            {
                name: 'custom_probe',
                description: 'Custom probe.',
                parameters: v.object({}),
                execute: async () => {
                    throw 'probe rejected the request';
                },
            },
        ]);

        const result = await tools[0]!.execute({}, undefined);

        expect(JSON.parse(result.content)).toEqual({ error: 'probe rejected the request' });
    });
});

describe('buildRegistrySessionTools', () => {
    it('refuses to build when the catalog schema omits a parameter the registry declares', () => {
        // The drift class fix mode already guards, now enforced for every surface: the model
        // cannot pass a parameter the advertisement omits, so a handler that requires it makes
        // the run unwinnable rather than failing at wiring.
        const recorder = new TraceRecorder({
            runId: 'registry-schema-drift',
            issueNumber: 1,
            mode: 'fix',
        });
        const registry = new ToolRegistry();
        registry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'lint_rule',
                    description: 'Lint a rule.',
                    parameters: {
                        type: 'object',
                        properties: {
                            rule: { type: 'string' },
                            unknownWidening: { type: 'string' },
                        },
                        required: ['rule'],
                    },
                },
            },
            handler: async () => ({ valid: true, errors: [] }),
        });

        expect(() => buildRegistrySessionTools(registry, recorder)).toThrow(/unknownWidening/);
    });
});
