import {
    ENUMERATION_NOTICE_KEY,
    ENUMERATION_STREAK_LIMIT,
    ENUMERATION_STREAK_PHASE,
} from '../../src/orchestrator/tool-enumeration-backstop';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createToolRegistry } from '../../src/agent/tool-factory';
import type { LlmConfig } from '../../src/config/config';
import { LlmApi } from '../../src/config/llm-api';
import { ReasoningEffort } from '../../src/config/reasoning-effort';
import { GuidanceDocumentOrigin, GuidanceDocumentRole } from '../../src/knowledge/guidance-source';
import type { LoadedInstruction } from '../../src/knowledge/instruction-loader';
import { AgentRuntime } from '../../src/orchestrator/agent-runtime';
import type { SingleShotClient } from '../../src/pi/single-shot-types';
import { type PiRuntime } from '../../src/pi/runtime';
import { SealKind } from '../../src/pi/seal-types';
import { ToolName } from '../../src/agent/tool-names';
import { ToolRegistry } from '../../src/agent/tool-registry';
import { buildFixSessionTools } from '../../src/orchestrator/fix-session-gates';
import { buildRegistrySessionTools } from '../../src/session/registry-session-tools';
import { toAdvertisedSchema } from '../../src/pi/tool-schema';
import { createObservationSink } from '../../src/orchestrator/fix-session-observations';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import { SEAL_DECISION_PHASE, TRACE_OUTCOME_SUCCESS } from '../../src/tracer/session-trace';
import { RunMode, TraceEventType } from '../../src/types/trace';
import { AgentTerminationReason } from '../../src/types/agent-termination-reason';
import {
    ExtensionManifestVersion,
    PreparedExtensionSource,
} from '../../src/environment/extension-preparation';
import type { IssueFacts } from '../../src/types/issue-facts';
import type { FixOutcome } from '../../src/types/fix-outcome';
import type { FinishFixValidationRejection } from '../../src/types/terminal-rejection';
import { runFixSession, type FixSessionOptions } from '../../src/orchestrator/fix-session';
import {
    FixTerminalSource,
    FixTracePhase,
    ROUTING_CHECK_HALT_REASON,
} from '../../src/orchestrator/fix-session-seal';
import {
    HermeticScenario,
    type HermeticProvider,
    type RecordedProviderRequest,
    type ScriptedReply,
    ScriptedReplyKind,
    startHermeticProvider,
} from '../pi/hermetic-provider';
import { ToolErrorKind } from '../../src/pi/session-tools';
import {
    REASONING_MODEL,
    TEST_API_KEY,
    VISION_MODEL,
    createTestPiRuntime,
} from '../pi/test-runtime';

const ISSUE_NUMBER = 235988;

const RAW_ISSUE = {
    number: ISSUE_NUMBER,
    url: `https://github.com/AdguardTeam/AdguardFilters/issues/${ISSUE_NUMBER}`,
    title: 'Ad leftover',
    body: [
        'AdGuard Browser Extension v5.4.3.99 MV3',
        '',
        '### System configuration',
        'Filters: | AdGuard Base filter',
    ].join('\n'),
    state: 'open' as const,
    labels: ['T: Ads'],
    assignee: null,
    comments: [],
};

/**
 * The facts a deterministic intake of {@link RAW_ISSUE} produced — spelled literally now that the
 * parser is gone.
 */
const RAW_FACTS: IssueFacts = {
    issueNumber: ISSUE_NUMBER,
    issueUrl: `https://github.com/AdguardTeam/AdguardFilters/issues/${ISSUE_NUMBER}`,
    reportedSiteUrls: [],
    labels: ['T: Ads'],
    problemType: 'unknown',
    product: 'AdGuard Browser Extension v5.4.3.99 MV3',
    enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
    screenshots: [],
};

const ANALYSIS_ONLY_PAYLOAD = {
    outcome: 'analysis_only',
    reasoning: 'Hermetic reasoning marker',
    summary: 'Hermetic run.',
} satisfies Record<string, unknown>;

const PROPOSE_RULE_PAYLOAD = {
    outcome: 'propose_rule',
    ruleProposal: {
        rule: 'example.org##.marker-ad',
        ruleType: 'cosmetic',
        risk: {
            level: 'low',
            reasons: ['test'],
        },
        placement: {
            filter: 'BaseFilter',
            filePath: 'BaseFilter/sections/foreign.txt',
            confidence: 0.9,
            alternatives: [],
        },
        duplicateCheck: { classification: 'none', matches: [] },
        productCompatibility: { extension: true },
    },
    policyDecision: { decision: 'allow_rule_generation', reasons: ['test'] },
    reasoning: 'draft proposal marker',
    summary: 'Draft run.',
    evidenceSummary: 'none',
} satisfies Record<string, unknown>;

/**
 * A launch_browser call the frozen fix schema accepts: the required extension/target/profile triple
 * with no optional settings profile, so a scenario can relaunch a session without restating the
 * whole reproduction profile vocabulary.
 */
const LAUNCH_BROWSER_ARGS = JSON.stringify({
    extension: 'none',
    targetUrl: 'https://example.test',
    profile: {
        viewport: 'desktop',
        locale: 'en-US',
        timezone: 'UTC',
        consentStrategy: 'untouched',
    },
});

/**
 * The rejection a host without a locked environment returns; also the fixture for cap and rejection
 * scenarios.
 */
const ENVIRONMENT_REQUIRED_REJECTION: FinishFixValidationRejection = {
    error: 'Inspect the advertised capabilities and call select_environment before finishing the run.',
    errorKind: 'environment_selection_required',
    retryable: true,
    requiredAction: 'select_environment',
    requiredTool: 'select_environment',
};

let workDir: string;
let provider: HermeticProvider | undefined;

beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'pi-fix-session-'));
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
 * One scripted terminal finish_fix reply.
 *
 * @param payload - The payload the scripted model submits.
 * @returns The scripted reply.
 */
function finishCall(payload: unknown): ScriptedReply {
    return {
        kind: ScriptedReplyKind.ToolCall,
        toolName: ToolName.FinishFix,
        toolArguments: JSON.stringify(payload),
    };
}

/**
 * Scripted non-terminal tool-call reply.
 *
 * @param toolName - The tool the scripted model calls.
 * @param toolArguments - JSON-encoded call arguments.
 * @returns The scripted reply.
 */
function toolCall(toolName: string, toolArguments: string): ScriptedReply {
    return { kind: ScriptedReplyKind.ToolCall, toolName, toolArguments };
}

/**
 * A stub tool definition for a session-surface name.
 *
 * @param name - The surface tool name.
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
 * The stub host surface runFixSession consumes: a ToolRegistry plus a per-outcome terminal hook.
 */
interface StubRuntime {
    registry: ToolRegistry;
    validateTerminalOutcome: (outcome: FixOutcome) => FinishFixValidationRejection | undefined;
}

/**
 * Build a stub runtime whose registry holds the given handlers and whose terminal hook answers from
 * a queue.
 *
 * @param handlers - Handler per tool name (surface names only).
 * @param rejections - Rejection queue consumed per finish_fix submission; `undefined` accepts.
 * @returns The stub runtime.
 */
function stubRuntime(
    handlers: Record<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>>,
    rejections: (FinishFixValidationRejection | undefined)[] = [undefined],
): StubRuntime {
    const registry = new ToolRegistry();
    for (const [name, handler] of Object.entries(handlers)) {
        registry.register({ definition: stubName(name), handler });
    }
    return {
        registry,
        validateTerminalOutcome: (_outcome) => {
            const rejection = rejections.shift();
            return rejection === undefined ? undefined : rejection;
        },
    };
}

/**
 * The tool names one recorded provider request advertised.
 *
 * @param request - The recorded request.
 * @returns The advertised names.
 */
function advertisedToolNames(request: { tools?: unknown }): string[] {
    return (request.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
}

/**
 * Start the hermetic provider and run one fix session.
 *
 * @param script - The reply sequence the provider serves.
 * @param options - Fix session options (runtime, policy, routing flag, budgets).
 * @returns The sealed run result and recorded requests.
 */
async function runSession(script: ScriptedReply[], options: FixSessionOptions) {
    provider = await startHermeticProvider({ scenario: HermeticScenario.Scripted, script });
    const piRuntime: PiRuntime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
    const result = await runFixSession({ ...options, piRuntime });
    return { result, requests: provider.requests };
}

/**
 * The provider slice the session derives its per-request deadline and retry bound from — the same
 * `llm` config every other mode session takes.
 *
 * @param overrides - Field overrides (requestMaxAttempts for the retry-parity scenarios).
 * @returns The validated-shaped provider configuration.
 */
function sessionLlm(overrides: Partial<LlmConfig> = {}): LlmConfig {
    return {
        api: LlmApi.OpenAiCompletions,
        baseUrl: 'https://provider.test',
        apiKey: TEST_API_KEY,
        model: REASONING_MODEL,
        visionModel: VISION_MODEL,
        requestTimeoutMs: 120_000,
        requestMaxAttempts: 2,
        contextWindowTokens: 1_048_576,
        maxOutputTokens: 384_000,
        visionMaxOutputTokens: 8_192,
        reasoningEffort: ReasoningEffort.High,
        singleShotReasoningEffort: ReasoningEffort.Medium,
        ...overrides,
    };
}

/**
 * Standard session options for the scenario tests: a stub runtime, pre-rendered task boundaries,
 * and generous budgets so only the scenario under test can end the run.
 *
 * @param runtime - The stub runtime.
 * @param overrides - Field overrides (routingCheck, policy, budgets).
 * @returns The options payload.
 */
function sessionOptions(
    runtime: StubRuntime,
    overrides: Partial<FixSessionOptions> = {},
): FixSessionOptions {
    const recorder = new TraceRecorder({
        runId: 'fix-session-test',
        issueNumber: ISSUE_NUMBER,
        mode: RunMode.Fix,
    });
    return {
        piRuntime: undefined as unknown as PiRuntime,
        runtime,
        recorder,
        facts: RAW_FACTS,
        issueNumber: ISSUE_NUMBER,
        routingCheck: false,
        llm: sessionLlm(),
        budgets: {
            wallClockMs: 60 * 60_000,
            maxTurns: 100,
        },
        workDir,
        ...overrides,
    };
}

/**
 * A run instruction fixture the fill test embeds into the fix task.
 *
 * @returns An instruction as the loader would produce it: exact text, digest, one linked document.
 */
function instructionFixture(): LoadedInstruction {
    return {
        path: 'AGENTS.md',
        content: 'Verify the header banner, not the sidebar.',
        sha256: 'a'.repeat(64),
        documents: [
            {
                role: GuidanceDocumentRole.Syntax,
                origin: GuidanceDocumentOrigin.Url,
                url: 'https://wiki.example.test/filter-syntax',
                content: 'Full syntax reference body.',
                sha256: 'd'.repeat(64),
            },
        ],
    };
}

/**
 * Distinctive fragments of the instruction-context scaffolding: the snippet prose from the
 * instruction-context document, the roster line format its fill produces for the fixture's one
 * linked document, and the fixture instruction text itself. Every fragment must appear in an
 * instructed fix task and none of them in a built-in one — a built-in render carrying any of them
 * means the empty fill started leaking the instruction machinery.
 */
const INSTRUCTION_CONTEXT_MARKERS = {
    /**
     * The rendered roster line: role, origin marker, and the linked URL.
     */
    rosterLine: '- syntax (url): https://wiki.example.test/filter-syntax',

    /**
     * Standing direction sentence naming the tool a gap report rides on.
     */
    standingDirection: 'call `report_missing_information` and name exactly what is missing',

    /**
     * The standing direction's result-carriage promise.
     */
    resultCarriage: 'every record reaches the run report',

    /**
     * The snippet's verbatim-instruction heading introducing the fill.
     */
    verbatimHeading: 'The instruction, verbatim:',

    /**
     * The roster intro naming the serving swap the linked documents cause.
     */
    rosterIntro: 'Documents the instruction links for rule guidance',

    /**
     * The governing-over-defaults sentence of the snippet's opening.
     */
    governanceLine: 'it governs this run over any default guidance',

    /**
     * The fixture instruction text, verbatim.
     */
    instructionText: 'Verify the header banner, not the sidebar.',
} as const;

/**
 * The user-role task text of one recorded provider request, the surface every prompt-fill contract
 * is asserted through. The system document is deliberately excluded: it names the selection tool
 * itself, qualified by whether the session advertises it.
 *
 * @param request - One request the hermetic provider recorded.
 * @returns The request's user messages, JSON-encoded and joined.
 */
function userTaskOf(request: RecordedProviderRequest): string {
    return request.messages
        .filter((message) => message['role'] === 'user')
        .map((message) => JSON.stringify(message['content']))
        .join('\n');
}

describe('fix session wiring', () => {
    it('seals with the corrected fix outcome after a host rejection', async () => {
        const runtime = stubRuntime({}, [ENVIRONMENT_REQUIRED_REJECTION, undefined]);
        const { result, requests } = await runSession(
            [finishCall(PROPOSE_RULE_PAYLOAD), finishCall(ANALYSIS_ONLY_PAYLOAD)],
            sessionOptions(runtime),
        );

        expect(result.terminalSource).toBe(FixTerminalSource.ModelFinishFix);
        expect(result.terminalRejected).toBe(false);
        expect(result.terminationReason).toBeUndefined();
        expect(result.terminal.outcome).toBe('analysis_only');
        // The rejection reason returned to the model as a tool error in the follow-up request.
        const secondRequest = JSON.stringify(requests[1]!.messages);
        expect(secondRequest).toContain('finish_fix: rejected');
        expect(secondRequest).toContain('call select_environment before finishing');
        expect(result.trace.outcome).toBe(TRACE_OUTCOME_SUCCESS);
        expect(
            result.trace.events.some(
                (event) =>
                    event.type === TraceEventType.Decision &&
                    event.payload['phase'] === FixTracePhase.TerminalAccepted,
            ),
        ).toBe(true);
        // Every fix ending but the routing halt writes the shared seal event the other modes do.
        expect(
            result.trace.events.some(
                (event) =>
                    event.type === TraceEventType.Decision &&
                    event.payload['phase'] === SEAL_DECISION_PHASE,
            ),
        ).toBe(true);
    });

    it('advertises every tool as one plain object and names the field finish_fix misses', async () => {
        // Contract: Anthropic refuses a request whose tool input_schema has anyOf, oneOf or allOf
        // at the top level, so one such tool fails the run on its first request. The terminal's
        // per-outcome rules then rest on the execute-time Valibot check, and its refusal must
        // still name the missing field.
        const { ruleProposal: _missing, ...branchIncomplete } = PROPOSE_RULE_PAYLOAD;
        const { result, requests } = await runSession(
            [finishCall(branchIncomplete), finishCall(ANALYSIS_ONLY_PAYLOAD)],
            sessionOptions(stubRuntime({})),
        );

        const tools = requests[0]!.tools as {
            function: { name: string; parameters: Record<string, unknown> };
        }[];
        expect(tools.map((tool) => tool.function.name)).toContain(ToolName.FinishFix);
        for (const { function: advertised } of tools) {
            expect(advertised.parameters['type'], advertised.name).toBe('object');
            expect(
                ['anyOf', 'oneOf', 'allOf'].filter((keyword) => keyword in advertised.parameters),
                advertised.name,
            ).toEqual([]);
        }
        expect(JSON.stringify(requests[1]!.messages)).toMatch(/invalid payload \(ruleProposal:/);
        expect(result.terminal.outcome).toBe('analysis_only');
    });

    it('exhausting the rejection cap seals rejected-terminal with preserved reasoning', async () => {
        const runtime = stubRuntime({}, [
            ENVIRONMENT_REQUIRED_REJECTION,
            ENVIRONMENT_REQUIRED_REJECTION,
            ENVIRONMENT_REQUIRED_REJECTION,
        ]);
        const { result } = await runSession(
            [
                finishCall(PROPOSE_RULE_PAYLOAD),
                finishCall(PROPOSE_RULE_PAYLOAD),
                finishCall(PROPOSE_RULE_PAYLOAD),
            ],
            sessionOptions(runtime),
        );

        expect(result.terminalSource).toBe(FixTerminalSource.HostFallback);
        expect(result.terminalRejected).toBe(true);
        expect(result.terminationReason).toBeUndefined();
        expect(result.terminal.outcome).toBe('analysis_only');
        expect(result.terminal.reasoning).toContain('call select_environment before finishing');
        expect(result.terminal.reasoning).toContain('draft proposal marker');
        // The report shows only the start of the reasoning: what the run found leads it.
        expect(result.terminal.reasoning.indexOf('draft proposal marker')).toBeLessThan(
            result.terminal.reasoning.indexOf('call select_environment before finishing'),
        );
        expect(result.trace.outcome).toBe(AgentTerminationReason.RetryBudgetExhausted);
        expect(
            result.trace.events.find(
                (event) =>
                    event.type === TraceEventType.Decision &&
                    event.payload['phase'] === SEAL_DECISION_PHASE,
            )?.payload,
        ).toMatchObject({ seal: SealKind.RejectedTerminal });
        expect(
            result.trace.events.some(
                (event) =>
                    event.type === TraceEventType.Error &&
                    event.payload['phase'] === FixTracePhase.TerminalRejected,
            ),
        ).toBe(true);
    });

    it('halts on the routing-check latch right after an accepted selection', async () => {
        const opened: string[] = [];
        const runtime = stubRuntime({
            select_environment: async () => ({ accepted: true, kind: 'browser_extension' }),
            open_page: async (args) => {
                opened.push(String(args['url']));
                return { url: String(args['url']), title: 'page', status: 200 };
            },
        });
        const { result, requests } = await runSession(
            [
                toolCall(
                    'select_environment',
                    JSON.stringify({
                        kind: 'browser_extension',
                        requiredCapabilities: ['browser_navigation'],
                        intent: {
                            issueType: 'ads',
                            rationale: 'The report describes a website-filtering symptom.',
                            confidence: 0.9,
                            evidence: [
                                { source: 'issue_body', observation: 'Website-filtering symptom.' },
                            ],
                            conflicts: [],
                        },
                        rationale: 'The selected environment best fits the issue.',
                        confidence: 0.85,
                    }),
                ),
                toolCall('open_page', '{"url":"https://example.org/article"}'),
            ],
            sessionOptions(runtime, { routingCheck: true }),
        );

        expect(result.terminalSource).toBe(FixTerminalSource.HostFallback);
        expect(result.terminationReason).toBe(AgentTerminationReason.HaltedByCaller);
        expect(result.terminalRejected).toBe(false);
        expect(result.terminal.outcome).toBe('analysis_only');
        expect(result.terminal.reasoning).toBe(ROUTING_CHECK_HALT_REASON);
        expect(result.trace.outcome).toBe(AgentTerminationReason.HaltedByCaller);
        expect(
            result.trace.events.some(
                (event) =>
                    event.type === TraceEventType.Decision &&
                    event.payload['phase'] === 'halted_by_caller',
            ),
        ).toBe(true);
        // The following turn was never consumed: no open_page request, no dispatch.
        expect(requests).toHaveLength(1);
        expect(opened).toEqual([]);
    });

    it('gates lifecycle and browser tools until the registry exposes them', async () => {
        let launched = false;
        const runtime = stubRuntime({
            select_environment: async () => {
                runtime.registry.register({
                    definition: stubName('launch_browser'),
                    handler: async () => {
                        launched = true;
                        return { ready: true };
                    },
                });
                return { accepted: true, kind: 'browser_extension' };
            },
        });
        const { result, requests } = await runSession(
            [
                toolCall(
                    'launch_browser',
                    '{"extension":"prepared","targetUrl":"https://example.test","profile":{"viewport":"desktop","locale":"en-US","timezone":"UTC","consentStrategy":"untouched"}}',
                ),
                toolCall('select_environment', JSON.stringify(environmentSelectionArgs())),
                toolCall(
                    'launch_browser',
                    '{"extension":"prepared","targetUrl":"https://example.test","profile":{"viewport":"desktop","locale":"en-US","timezone":"UTC","consentStrategy":"untouched"}}',
                ),
                finishCall(ANALYSIS_ONLY_PAYLOAD),
            ],
            sessionOptions(runtime),
        );

        expect(result.terminalSource).toBe(FixTerminalSource.ModelFinishFix);
        const gatedRequest = JSON.stringify(requests[1]!.messages);
        expect(gatedRequest).toContain(ToolErrorKind.ToolGated);
        expect(gatedRequest).toContain('environment-pending');
        expect(launched).toBe(true);
        // The finally accepted run kept the advertised list byte-identical.
        const advertised = requests.map((request) => JSON.stringify(request.tools));
        expect(new Set(advertised).size).toBe(1);
    });

    it('seeds lookup_rule_guidance NotApplicable when the runtime has no guidance source', async () => {
        const runtime = stubRuntime({});
        const { result, requests } = await runSession(
            [
                toolCall('lookup_rule_guidance', '{"topic":"element_hiding"}'),
                finishCall(ANALYSIS_ONLY_PAYLOAD),
            ],
            sessionOptions(runtime),
        );

        expect(result.terminalSource).toBe(FixTerminalSource.ModelFinishFix);
        const refusal = JSON.stringify(requests[1]!.messages);
        expect(refusal).toContain(ToolErrorKind.ToolGated);
        expect(refusal).toContain('not-applicable');
        expect(refusal).toContain('no rule-guidance session');
        expect(refusal).not.toContain('Tool not found');
    });

    it('dispatches lookup_rule_guidance to the real handler when the registry registers it', async () => {
        const seenArgs: Record<string, unknown>[] = [];
        const runtime = stubRuntime({
            lookup_rule_guidance: async (args) => {
                seenArgs.push(args);
                return { topic: String(args['topic']), citation: 'policy.md:12' };
            },
        });
        const { result, requests } = await runSession(
            [
                toolCall('lookup_rule_guidance', '{"topic":"element_hiding"}'),
                finishCall(ANALYSIS_ONLY_PAYLOAD),
            ],
            sessionOptions(runtime),
        );

        expect(result.terminalSource).toBe(FixTerminalSource.ModelFinishFix);
        expect(seenArgs).toEqual([{ topic: 'element_hiding' }]);
        expect(JSON.stringify(requests[1]!.messages)).toContain('policy.md:12');
    });

    it('refuses to build a session whose schema omits a registry parameter', () => {
        // The runtime widens some definitions at registration (analyze_screenshot gains
        // issueScreenshotIndex). A catalog schema that omits such a parameter makes the run
        // unwinnable: the model cannot pass what the advertisement does not declare, so a host
        // gate demanding it rejects every terminal submission until the budget seals the run.
        const runtime = stubRuntime({});
        runtime.registry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'analyze_screenshot',
                    description: 'Analyze a screenshot.',
                    parameters: {
                        type: 'object',
                        properties: {
                            artifactId: { type: 'string' },
                            issueScreenshotIndex: { type: 'number' },
                            prompt: { type: 'string' },
                            unknownWidening: { type: 'string' },
                        },
                        required: ['prompt'],
                    },
                },
            },
            handler: async () => ({ ok: true }),
        });

        expect(() =>
            buildFixSessionTools(
                { registry: runtime.registry, routingCheck: false },
                createObservationSink(),
                () => {},
            ),
        ).toThrow(/unknownWidening/);
    });

    it('refuses a late registration whose parameters the session never advertised', () => {
        // The lifecycle and browser tools land in the registry after the session was built, so the
        // build-time sweep alone never sees them. A drift introduced there is the same unwinnable
        // run: the model cannot pass a parameter the advertisement omits.
        const runtime = stubRuntime({});
        buildFixSessionTools(
            { registry: runtime.registry, routingCheck: false },
            createObservationSink(),
            () => {},
        );
        expect(() =>
            runtime.registry.register({
                definition: {
                    type: 'function',
                    function: {
                        name: ToolName.OpenPage,
                        description: 'Open a page.',
                        parameters: {
                            type: 'object',
                            properties: {
                                url: { type: 'string' },
                                lateWidening: { type: 'string' },
                            },
                            required: ['url'],
                        },
                    },
                },
                handler: async () => ({ ok: true }),
            }),
        ).toThrow(/lateWidening/);
    });

    it('advertises the reporter-aware analyze_screenshot only on the fix surface', () => {
        // The fix runtime re-registers analyze_screenshot so reporter evidence is addressed by
        // issueScreenshotIndex; every other surface dispatches into the tool-factory registry,
        // which accepts an artifactId and nothing else. Advertising one shape on both surfaces
        // makes one of the two runs unwinnable: either the fix model cannot name reporter
        // evidence, or another surface's model is told to pass a parameter its registry rejects.
        const fixRuntime = stubRuntime({});
        fixRuntime.registry.register({
            definition: {
                type: 'function',
                function: {
                    name: ToolName.AnalyzeScreenshot,
                    description: 'Analyze a screenshot.',
                    parameters: {
                        type: 'object',
                        properties: {
                            artifactId: { type: 'string' },
                            issueScreenshotIndex: { type: 'number' },
                            prompt: { type: 'string' },
                        },
                        required: ['prompt'],
                    },
                },
            },
            handler: async () => ({ ok: true }),
        });
        const fixTool = buildFixSessionTools(
            { registry: fixRuntime.registry, routingCheck: false },
            createObservationSink(),
            () => {},
        ).find((tool) => tool.name === ToolName.AnalyzeScreenshot);
        const fixShape = toAdvertisedSchema(fixTool!.parameters, fixTool!.name) as {
            properties?: Record<string, unknown>;
            required?: string[];
        };
        expect(Object.keys(fixShape.properties ?? {}).sort()).toEqual([
            'artifactId',
            'issueScreenshotIndex',
            'prompt',
        ]);
        expect(fixShape.required ?? []).toEqual(['prompt']);
        expect(fixTool!.description).toContain('issueScreenshotIndex');

        const sharedRegistry = new ToolRegistry();
        sharedRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: ToolName.AnalyzeScreenshot,
                    description: 'Analyze a screenshot.',
                    parameters: {
                        type: 'object',
                        properties: {
                            artifactId: { type: 'string' },
                            prompt: { type: 'string' },
                        },
                        required: ['artifactId', 'prompt'],
                    },
                },
            },
            handler: async () => ({ ok: true }),
        });
        const sharedTool = buildRegistrySessionTools(
            sharedRegistry,
            new TraceRecorder({
                runId: 'analyze-surface-test',
                issueNumber: ISSUE_NUMBER,
                mode: RunMode.Fix,
            }),
            {},
        ).find((tool) => tool.name === ToolName.AnalyzeScreenshot);
        const sharedShape = toAdvertisedSchema(sharedTool!.parameters, sharedTool!.name) as {
            properties?: Record<string, unknown>;
            required?: string[];
        };
        expect(Object.keys(sharedShape.properties ?? {}).sort()).toEqual(['artifactId', 'prompt']);
        expect(sharedShape.required ?? []).toEqual(['artifactId', 'prompt']);
        expect(sharedTool!.description).not.toContain('issueScreenshotIndex');
    });

    it('refuses a browser tool the runtime withdrew without a lifecycle call', async () => {
        // The runtime retires a failed-navigation session by unregistering its browser tools
        // directly, with no close_browser call to hang a gate flip on.
        const runtime = stubRuntime({
            open_page: async () => ({ error: 'navigation failed', errorKind: 'technical' }),
            get_dom: async () => ({ html: '<html></html>' }),
        });
        runtime.registry.register({
            definition: stubName('open_page'),
            handler: async () => {
                runtime.registry.unregister('get_dom');
                return { error: 'navigation failed', errorKind: 'technical' };
            },
        });
        const { result, requests } = await runSession(
            [
                toolCall('open_page', '{"url":"https://example.test"}'),
                toolCall('get_dom', '{}'),
                finishCall(ANALYSIS_ONLY_PAYLOAD),
            ],
            sessionOptions(runtime),
        );

        expect(result.terminalSource).toBe(FixTerminalSource.ModelFinishFix);
        const refusal = JSON.stringify(requests[2]!.messages);
        expect(refusal).toContain(ToolErrorKind.ToolGated);
        expect(refusal).toContain('get_dom is unavailable');
        expect(refusal).toContain('launch_browser');
        expect(refusal).not.toContain('Tool not found');
    });

    it('refuses inspect_page_state with the typed gate reason when no session is live', async () => {
        // The state probe is a browser-session tool: with the session gone it must answer the
        // typed gate refusal naming launch_browser, never a bare "Tool not found".
        const runtime = stubRuntime({
            close_browser: async () => ({ closed: true }),
            inspect_page_state: async () => ({ cookies: [], frames: [] }),
        });
        runtime.registry.register({
            definition: stubName('close_browser'),
            handler: async () => {
                runtime.registry.unregister('inspect_page_state');
                return { closed: true };
            },
        });
        const { result, requests } = await runSession(
            [
                toolCall('close_browser', '{}'),
                toolCall('inspect_page_state', '{}'),
                finishCall(ANALYSIS_ONLY_PAYLOAD),
            ],
            sessionOptions(runtime),
        );

        expect(result.terminalSource).toBe(FixTerminalSource.ModelFinishFix);
        const refusal = JSON.stringify(requests[2]!.messages);
        expect(refusal).toContain(ToolErrorKind.ToolGated);
        expect(refusal).toContain('browser-closed');
        expect(refusal).toContain('inspect_page_state is unavailable');
        expect(refusal).toContain('launch_browser');
        expect(refusal).not.toContain('Tool not found');
    });

    it('answers get_applied_rules in a session that does not offer it with why, not a closed session', async () => {
        // A live session without a reporting engine (a control session, a blocker the run's own
        // instruction prepares) never registers the tool. The generic refusals would send the
        // agent to relaunch or select an environment, which cannot make this session report.
        const runtime = stubRuntime({
            open_page: async () => ({ ok: true }),
        });
        const { result, requests } = await runSession(
            [toolCall('get_applied_rules', '{}'), finishCall(ANALYSIS_ONLY_PAYLOAD)],
            sessionOptions(runtime),
        );

        expect(result.terminalSource).toBe(FixTerminalSource.ModelFinishFix);
        const refusal = JSON.stringify(requests[1]!.messages);
        expect(refusal).toContain(ToolErrorKind.ToolGated);
        expect(refusal).toContain('not-offered');
        expect(refusal).toContain('availableBrowserTools');
        expect(refusal).not.toContain('browser-closed');
        expect(refusal).not.toContain('environment-pending');
    });

    it('asks the model to stop a same-tool streak of any tool, a repository search included', async () => {
        // AdguardFilters #242193 spent its 35-minute budget on 293 search_rules calls, a 40-call
        // streak among them, all looking for one rule the text search could not find. The backstop
        // saw only browser tools then. Arguments differ on every call: a streak is same-tool,
        // regardless of what each call asks.
        const runtime = stubRuntime({
            search_rules: async (args) => ({ totalMatches: 0, matches: [], asked: args }),
            get_detail: async () => ({ filtered: [] }),
        });
        const search = (index: number) =>
            toolCall('search_rules', JSON.stringify({ urlPattern: `||ex.co^$variant-${index}` }));
        const options = sessionOptions(runtime);
        const { result, requests } = await runSession(
            [
                // Eleven searches, a different tool, then eleven more: the streak resets.
                ...Array.from({ length: ENUMERATION_STREAK_LIMIT - 1 }, (_, index) =>
                    search(index),
                ),
                toolCall('get_detail', '{"artifactId":"inventory"}'),
                ...Array.from({ length: ENUMERATION_STREAK_LIMIT - 1 }, (_, index) =>
                    search(100 + index),
                ),
                // The twelfth in a row trips the bound.
                search(200),
                finishCall(ANALYSIS_ONLY_PAYLOAD),
            ],
            options,
        );

        expect(result.terminalSource).toBe(FixTerminalSource.ModelFinishFix);
        const tripIndex = 2 * (ENUMERATION_STREAK_LIMIT - 1) + 2;
        const beforeTrip = JSON.stringify(requests[tripIndex - 1]!.messages.at(-1));
        const atTrip = JSON.stringify(requests[tripIndex]!.messages.at(-1));
        expect(beforeTrip).not.toContain(ENUMERATION_NOTICE_KEY);
        // The real result still reaches the model, with the notice beside it.
        expect(atTrip).toContain(ENUMERATION_NOTICE_KEY);
        expect(atTrip).toContain('variant-200');
        expect(
            options.recorder
                .toJSON()
                .events.filter(
                    (event) =>
                        event.type === TraceEventType.Decision &&
                        event.payload.phase === ENUMERATION_STREAK_PHASE,
                )
                .map((event) => event.payload),
        ).toEqual([
            {
                phase: ENUMERATION_STREAK_PHASE,
                tool: 'search_rules',
                consecutiveCalls: ENUMERATION_STREAK_LIMIT,
            },
        ]);
    });

    it('quarantines evaluate_js diagnostics after three policy rejections', async () => {
        const runtime = stubRuntime({
            evaluate_js: async () => ({
                error: 'read-only policy rejection',
                errorKind: 'policy_rejection',
            }),
        });
        const { result, requests } = await runSession(
            [
                toolCall('evaluate_js', '{"expression":"document.body"}'),
                toolCall('evaluate_js', '{"expression":"document.body"}'),
                toolCall('evaluate_js', '{"expression":"document.body"}'),
                toolCall('evaluate_js', '{"expression":"document.body"}'),
                finishCall(ANALYSIS_ONLY_PAYLOAD),
            ],
            sessionOptions(runtime),
        );

        expect(result.terminalSource).toBe(FixTerminalSource.ModelFinishFix);
        const refusal = JSON.stringify(requests[4]!.messages);
        expect(refusal).toContain(ToolErrorKind.ToolGated);
        expect(refusal).toContain('quarantined');
        expect(refusal).toContain('evaluate_js is disabled');
    });

    it('keeps an evaluate_js quarantine across a browser relaunch', async () => {
        // The quarantine notice tells the model evaluate_js is disabled "for the remainder of
        // this run". Closing and relaunching the browser withdraws and re-registers the browser
        // tools, and availability is restored by that — but the budget three read-only policy
        // rejections already spent is not, or the model buys three more by cycling the session.
        const runtime = stubRuntime({
            evaluate_js: async () => ({
                error: 'read-only policy rejection',
                errorKind: 'policy_rejection',
            }),
        });
        const evaluateJs = {
            definition: stubName('evaluate_js'),
            handler: async () => ({
                error: 'read-only policy rejection',
                errorKind: 'policy_rejection',
            }),
        };
        runtime.registry.register({
            definition: stubName('close_browser'),
            handler: async () => {
                runtime.registry.unregister('evaluate_js');
                return { closed: true };
            },
        });
        runtime.registry.register({
            definition: stubName('launch_browser'),
            handler: async () => {
                runtime.registry.register(evaluateJs);
                return { launched: true };
            },
        });
        const { result, requests } = await runSession(
            [
                toolCall('evaluate_js', '{"expression":"document.body"}'),
                toolCall('evaluate_js', '{"expression":"document.body"}'),
                toolCall('evaluate_js', '{"expression":"document.body"}'),
                toolCall('close_browser', '{}'),
                toolCall('launch_browser', LAUNCH_BROWSER_ARGS),
                toolCall('evaluate_js', '{"expression":"document.body"}'),
                finishCall(ANALYSIS_ONLY_PAYLOAD),
            ],
            sessionOptions(runtime),
        );

        expect(result.terminalSource).toBe(FixTerminalSource.ModelFinishFix);
        const refusal = JSON.stringify(requests[6]!.messages);
        expect(refusal).toContain('quarantined');
        expect(refusal).toContain('evaluate_js is disabled');
        expect(refusal).not.toContain('browser-closed');
    });

    it('quarantines inspect_full_page_capture after three incomplete captures', async () => {
        const runtime = stubRuntime({
            inspect_full_page_capture: async () => ({
                error: 'The latest full-page tile capture is incomplete.',
                errorKind: 'full_page_capture_incomplete',
            }),
        });
        const { result, requests } = await runSession(
            [
                toolCall('inspect_full_page_capture', '{}'),
                toolCall('inspect_full_page_capture', '{}'),
                toolCall('inspect_full_page_capture', '{}'),
                toolCall('inspect_full_page_capture', '{}'),
                finishCall(ANALYSIS_ONLY_PAYLOAD),
            ],
            sessionOptions(runtime),
        );

        expect(result.terminalSource).toBe(FixTerminalSource.ModelFinishFix);
        const refusal = JSON.stringify(requests[4]!.messages);
        expect(refusal).toContain(ToolErrorKind.ToolGated);
        expect(refusal).toContain('inspect_full_page_capture is disabled');
    });

    it('delivers observations only across successful later model turns', async () => {
        const runtime = stubRuntime({
            lint_rule: async () => ({ valid: true, errors: [] }),
        });

        // Error turn: the turn 0 result stays undelivered because turn 1 never succeeded.
        const failed = await runSession(
            [
                toolCall('lint_rule', '{"rule":"example.org##.ad","filePath":"filters/list.txt"}'),
                { kind: ScriptedReplyKind.Error, status: 401, message: 'auth failed' },
            ],
            sessionOptions(runtime),
        );
        expect(failed.result.observations).toEqual([]);

        // Successful follow-up turn: the turn 0 result is delivered; the accepting finish_fix turn
        // carries no tool results of its own.
        const accepted = await runSession(
            [
                toolCall('lint_rule', '{"rule":"example.org##.ad","filePath":"filters/list.txt"}'),
                finishCall(ANALYSIS_ONLY_PAYLOAD),
            ],
            sessionOptions(runtime),
        );
        expect(accepted.result.observations).toHaveLength(1);
        const [observation] = accepted.result.observations;
        expect(observation).toMatchObject({
            sequence: 0,
            toolCallId: 'obs-0',
            tool: 'lint_rule',
            result: { valid: true, errors: [] },
        });
    });

    it('ends terminal_not_called when the model answers prose after the nudge', async () => {
        const runtime = stubRuntime({});
        const { result, requests } = await runSession(
            [
                { kind: ScriptedReplyKind.Text, text: 'I have finished my analysis.' },
                { kind: ScriptedReplyKind.Text, text: 'Still no tool call.' },
            ],
            sessionOptions(runtime),
        );

        expect(result.terminalSource).toBe(FixTerminalSource.HostFallback);
        expect(result.terminationReason).toBe(AgentTerminationReason.TerminalNotCalled);
        expect(result.terminal.outcome).toBe('analysis_only');
        expect(result.trace.outcome).toBe(AgentTerminationReason.TerminalNotCalled);
        // One nudge only.
        expect(requests).toHaveLength(2);
    });

    it('maps the iteration backstop to max_iterations_exceeded', async () => {
        const runtime = stubRuntime({ lint_rule: async () => ({ valid: true, errors: [] }) });
        const { result } = await runSession(
            [
                toolCall('lint_rule', '{"rule":"example.org##.ad","filePath":"filters/list.txt"}'),
                toolCall('lint_rule', '{"rule":"example.org##.ad","filePath":"filters/list.txt"}'),
                toolCall('lint_rule', '{"rule":"example.org##.ad","filePath":"filters/list.txt"}'),
            ],
            sessionOptions(runtime, {
                budgets: { wallClockMs: 60_000, maxTurns: 2 },
            }),
        );

        expect(result.terminationReason).toBe(AgentTerminationReason.MaxIterationsExceeded);
        expect(result.terminal.outcome).toBe('analysis_only');
        expect(result.trace.outcome).toBe(AgentTerminationReason.MaxIterationsExceeded);
        // The host-fallback ending seals through the shared writer like every other mode, so the
        // tripped bound and its detail survive in the trace instead of only in the prose reasoning.
        expect(
            result.trace.events.find(
                (event) =>
                    event.type === TraceEventType.Decision &&
                    event.payload['phase'] === SEAL_DECISION_PHASE,
            )?.payload,
        ).toMatchObject({ seal: SealKind.BudgetExceeded });
    });

    it('maps a caller abort to interrupted', async () => {
        const runtime = stubRuntime({});
        const controller = new AbortController();
        controller.abort();
        const { result, requests } = await runSession(
            [finishCall(ANALYSIS_ONLY_PAYLOAD)],
            sessionOptions(runtime, { signal: controller.signal }),
        );

        expect(result.terminationReason).toBe(AgentTerminationReason.Interrupted);
        expect(result.terminal.outcome).toBe('analysis_only');
        expect(result.trace.outcome).toBe(AgentTerminationReason.Interrupted);
        expect(requests).toHaveLength(0);
    });

    it('maps a deterministic provider rejection to llm_rejected and a transient one to llm_error', async () => {
        // Mid-run errors (after a successful tool turn) reliably persist into the seal; the first
        // turn of a session does not, so both scripts lead with a successful lint turn.
        const runtime = stubRuntime({ lint_rule: async () => ({ valid: true, errors: [] }) });
        const deterministic = await runSession(
            [
                toolCall('lint_rule', '{"rule":"example.org##.ad","filePath":"filters/list.txt"}'),
                { kind: ScriptedReplyKind.Error, status: 400, message: 'malformed request' },
            ],
            sessionOptions(runtime, { llm: sessionLlm({ requestMaxAttempts: 1 }) }),
        );
        expect(deterministic.result.terminationReason).toBe(AgentTerminationReason.LlmRejected);
        expect(deterministic.result.trace.outcome).toBe(AgentTerminationReason.LlmRejected);

        const transient = await runSession(
            [
                toolCall('lint_rule', '{"rule":"example.org##.ad","filePath":"filters/list.txt"}'),
                { kind: ScriptedReplyKind.Error, status: 503, message: 'overloaded' },
            ],
            sessionOptions(runtime, { llm: sessionLlm({ requestMaxAttempts: 1 }) }),
        );
        expect(transient.result.terminationReason).toBe(AgentTerminationReason.LlmError);
        expect(transient.result.trace.outcome).toBe(AgentTerminationReason.LlmError);
    });

    it('carries the provider HTTP status on the seal, or none when the message names none', async () => {
        // A maintainer reading the eventual report needs the status a provider failure actually
        // carried (401/402/403/429 name something they can act on) rather than a generic
        // "unreachable" — but only when pi's composed message actually named one; an SDK-folded
        // body or a mid-stream fault never did, and the seal must not invent a status for it.
        const runtime = stubRuntime({ lint_rule: async () => ({ valid: true, errors: [] }) });
        const billing = await runSession(
            [
                toolCall('lint_rule', '{"rule":"example.org##.ad","filePath":"filters/list.txt"}'),
                {
                    kind: ScriptedReplyKind.Error,
                    status: 402,
                    message: 'This request requires more credits, or fewer max_tokens.',
                },
            ],
            sessionOptions(runtime, { llm: sessionLlm({ requestMaxAttempts: 1 }) }),
        );
        expect(billing.result.providerFailureStatus).toBe(402);
        expect(billing.result.terminationReason).toBe(AgentTerminationReason.LlmError);

        const noStatus = await runSession(
            [
                toolCall('lint_rule', '{"rule":"example.org##.ad","filePath":"filters/list.txt"}'),
                {
                    kind: ScriptedReplyKind.StreamFault,
                    message: 'the assistant reply could not be parsed',
                    code: 1,
                },
            ],
            sessionOptions(runtime, { llm: sessionLlm({ requestMaxAttempts: 1 }) }),
        );
        expect(noStatus.result.providerFailureStatus).toBeUndefined();
        expect(noStatus.result.terminationReason).toBe(AgentTerminationReason.LlmError);
    });

    it('renders the fix task without extension-preparation guidance', async () => {
        const runtime = stubRuntime({});
        const { result: _result, requests } = await runSession(
            [finishCall(ANALYSIS_ONLY_PAYLOAD)],
            sessionOptions(runtime),
        );

        const system = String(requests[0]!.messages[0]?.content);
        expect(system).toContain('Current working directory');
        const userTask = requests[0]!.messages
            .filter((message) => message.role === 'user')
            .map((message) => JSON.stringify(message.content))
            .join('\n');
        expect(userTask).toContain(`Resolve issue #${ISSUE_NUMBER}`);
        // The host prepares the run's one pinned build before the session starts, so the
        // settings context carries no preparation prose for any run.
        expect(userTask).not.toContain('selection=current first');
        expect(userTask).not.toContain('selection=reported');
    });

    it('tells the session the instruction preparation is done only when there is one', async () => {
        // The contract: the preparation section belongs to the host's own preparation session,
        // which runs before this one, and the fix surface advertises no command execution. A live
        // run spent its ending reporting the instruction's XPI download as work it could not do,
        // for an XPI the host had already installed. `launch_browser` is the marker because the
        // note names the tool the prepared build actually reaches the model through, and nothing
        // else in the fix task's user turn names it.
        const prepared = await runSession(
            [finishCall(ANALYSIS_ONLY_PAYLOAD)],
            sessionOptions(stubRuntime({}), {
                instruction: {
                    ...instructionFixture(),
                    content: [
                        'Verify the header banner, not the sidebar.',
                        '',
                        '## Preparation',
                        '',
                        'Download the current signed release and unpack it.',
                        'launch: firefox-signed-xpi',
                    ].join('\n'),
                },
            }),
        );
        expect(userTaskOf(prepared.requests[0]!)).toContain(ToolName.LaunchBrowser);

        const unprepared = await runSession(
            [finishCall(ANALYSIS_ONLY_PAYLOAD)],
            sessionOptions(stubRuntime({}), { instruction: instructionFixture() }),
        );
        expect(userTaskOf(unprepared.requests[0]!)).not.toContain(ToolName.LaunchBrowser);
    });

    it('asks for an environment selection only when the session advertises that tool', async () => {
        // The contract: what the task tells the model to call must be what the surface advertises.
        // A run whose registry holds no select_environment had its environment locked by the
        // runner, and a task naming the tool there costs the session a turn and a
        // missing-information record instead of an investigation.
        const locked = await runSession(
            [finishCall(ANALYSIS_ONLY_PAYLOAD)],
            sessionOptions(stubRuntime({})),
        );
        expect(userTaskOf(locked.requests[0]!)).not.toContain(ToolName.SelectEnvironment);

        const selecting = await runSession(
            [finishCall(ANALYSIS_ONLY_PAYLOAD)],
            sessionOptions(stubRuntime({ [ToolName.SelectEnvironment]: async () => ({}) })),
        );
        expect(userTaskOf(selecting.requests[0]!)).toContain(ToolName.SelectEnvironment);
    });

    it('advertises lint_rule only when the repository configured a lint command', async () => {
        // A run without the repository's lint command registers no lint tool; advertising the
        // name anyway would answer every call with a refusal no later step can lift.
        const unlinted = await runSession(
            [finishCall(ANALYSIS_ONLY_PAYLOAD)],
            sessionOptions(stubRuntime({})),
        );
        expect(advertisedToolNames(unlinted.requests[0]!)).not.toContain(ToolName.LintRule);

        const linted = await runSession(
            [finishCall(ANALYSIS_ONLY_PAYLOAD)],
            sessionOptions(stubRuntime({ [ToolName.LintRule]: async () => ({}) })),
        );
        expect(advertisedToolNames(linted.requests[0]!)).toContain(ToolName.LintRule);
    });

    it('embeds the run instruction into the fix task and keeps built-in runs free of it', async () => {
        const runtime = stubRuntime({});
        const { requests: instructionRequests } = await runSession(
            [finishCall(ANALYSIS_ONLY_PAYLOAD)],
            sessionOptions(runtime, { instruction: instructionFixture() }),
        );
        const instructedTask = instructionRequests[0]!.messages
            .filter((message) => message.role === 'user')
            .map((message) => JSON.stringify(message.content))
            .join('\n');
        for (const marker of Object.values(INSTRUCTION_CONTEXT_MARKERS)) {
            expect(instructedTask).toContain(marker);
        }

        const { requests: builtinRequests } = await runSession(
            [finishCall(ANALYSIS_ONLY_PAYLOAD)],
            sessionOptions(runtime),
        );
        const builtinTask = builtinRequests[0]!.messages
            .filter((message) => message.role === 'user')
            .map((message) => JSON.stringify(message.content))
            .join('\n');
        // Behavioral containment, not byte pinning: the built-in render must carry no trace of the
        // instruction machinery — every scaffolding fragment below lives only in the
        // instruction-context snippet, so an accidental empty-fill change (a stray roster line, a
        // blanket-filled standing direction) fails here. The marker set deliberately includes the
        // roster line format and the instruction text itself; neither appears anywhere else in the
        // system document or the remaining fix-task fills.
        for (const marker of Object.values(INSTRUCTION_CONTEXT_MARKERS)) {
            expect(builtinTask).not.toContain(marker);
        }
    });

    it('renders the incorrect-blocking targeting guidance for an incorrect-blocking report', async () => {
        const runtime = stubRuntime({});
        const { result: _result, requests } = await runSession(
            [finishCall(ANALYSIS_ONLY_PAYLOAD)],
            sessionOptions(runtime, {
                facts: {
                    issueNumber: ISSUE_NUMBER,
                    issueUrl: `https://github.com/AdguardTeam/AdguardFilters/issues/${ISSUE_NUMBER}`,
                    reportedSiteUrls: ['https://example.org/article'],
                    labels: ['T: Incorrect Blocking'],
                    declaredIssueType: 'incorrect blocking',
                    problemType: 'incorrect-blocking',
                    product: 'Unknown',
                    enabledFilters: [],
                    screenshots: [],
                },
            }),
        );

        const userTask = requests[0]!.messages
            .filter((message) => message.role === 'user')
            .map((message) => JSON.stringify(message.content))
            .join('\n');
        expect(userTask).toContain('FALSE POSITIVE');
    });
});

it('advertises get_detail from the first request and never the preparation tools', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fix-session-surface-'));
    try {
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter', 'sections', 'foreign.txt'), '');
        // The host prepared this run's one build before the session; the unpacked root exists on
        // disk so the runtime's prepared-extension fixture is a loadable directory, not a dangling
        // path.
        const extensionPath = join(root, 'extension');
        mkdirSync(extensionPath, { recursive: true });
        writeFileSync(
            join(extensionPath, 'manifest.json'),
            JSON.stringify({
                name: 'prepared-fixture-extension',
                manifest_version: 3,
                version: '5.5.2.3',
            }),
        );
        const recorder = new TraceRecorder({
            runId: 'fix-session-surface',
            issueNumber: ISSUE_NUMBER,
            mode: RunMode.Fix,
        });
        const visionStub = {
            modelId: 'vision-model',
            structured: async () => {
                throw new Error('not used by this suite');
            },
            text: async () => {
                throw new Error('not used by this suite');
            },
        } as unknown as SingleShotClient;
        const baseRegistry = await createToolRegistry({
            allowedIssueNumber: ISSUE_NUMBER,
            checkoutPath: filtersPath,
            visionTools: {
                artifactsDir: root,
                recorder,
                vision: visionStub,
                reporterSymptom: () => undefined,
            },
            localIssueTools: { localIssue: RAW_ISSUE, reportedDomain: 'example.org' },
        });
        const runtime = await AgentRuntime.create(
            {
                issue: RAW_ISSUE,
                issueFacts: RAW_FACTS,
                issueAttachmentArtifactIds: [],
                allowedTargetUrls: ['https://example.org/'],
                artifactsDir: root,
                filtersPath,
                headless: true,
                noSandbox: false,
                vision: visionStub,
                recorder,
                preparedExtension: {
                    extensionPath,
                    manifestVersion: ExtensionManifestVersion.Mv3,
                    userScriptsPermission: true,
                    source: PreparedExtensionSource.PinnedRelease,
                    extensionSourceSha256: 'e'.repeat(64),
                    extensionSourceTag: 'v5.5.2.3',
                },
                // This scenario never scripts launch_browser, so the between-phases application
                // flow never runs; llm/piRuntime are required options with nothing to exercise.
                llm: sessionLlm(),
                piRuntime: undefined as unknown as PiRuntime,
            },
            { createBaseRegistry: async () => baseRegistry },
        );
        const createTimeNames = runtime.registry
            .getDefinitions()
            .map((definition) => definition.function.name);
        expect(createTimeNames).toContain('get_detail');

        const { result, requests } = await runSession(
            [
                toolCall('fetch_issue', JSON.stringify({ issueNumber: ISSUE_NUMBER })),
                toolCall('select_environment', JSON.stringify(environmentSelectionArgs())),
                finishCall(ANALYSIS_ONLY_PAYLOAD),
                { kind: ScriptedReplyKind.Text, text: 'I am still collecting evidence.' },
                { kind: ScriptedReplyKind.Text, text: 'No terminal decision.' },
            ],
            sessionOptions(runtime),
        );

        // The real runtime's terminal hook demands browser evidence for analysis_only, so this
        // run seals via the host fallback. The surface is checked through its names: the
        // preparation stage's tools must not be advertised, and the scenario below proves a call
        // to them is refused rather than dispatched. The public run resolves a one-element
        // executor set, so the choice tool is filtered from the surface.
        expect(result.terminationReason).toBeDefined();
        const advertisedNames = (requests[0]!.tools as { function: { name: string } }[]).map(
            (tool) => tool.function.name,
        );
        expect(advertisedNames).toContain('get_detail');
        expect(advertisedNames).toContain(ToolName.FinishFix);
        expect(advertisedNames).toContain('report_missing_information');
        expect(advertisedNames).not.toContain('select_environment');
        // The run's build was host-prepared before this session started, so the preparation
        // stage's `run_command` and `write_file` never appear on the fix surface the model sees.
        expect(advertisedNames).not.toContain(ToolName.RunCommand);
        expect(advertisedNames).not.toContain(ToolName.WriteFile);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it('refuses a fix-session run_command or write_file call without dispatching it', async () => {
    const runtime = stubRuntime({});
    const { result, requests } = await runSession(
        [
            toolCall(ToolName.RunCommand, JSON.stringify({ command: ['true'] })),
            toolCall(ToolName.WriteFile, JSON.stringify({ path: 'probe.txt', content: 'x' })),
            finishCall(ANALYSIS_ONLY_PAYLOAD),
        ],
        sessionOptions(runtime),
    );

    expect(result.terminalSource).toBe(FixTerminalSource.ModelFinishFix);
    // The names sit outside the frozen fix surface (they are deliberately not adapted, so no
    // tool_gated stub can re-advertise them), and that is exactly the runtime refusal a fix
    // session answers them with: pi bounces each call before execution, the run trace marks both
    // calls rejected-before-execution — no registry dispatch behind the model — and the model
    // sees a failed tool result naming the tool it called. The session continues to its terminal:
    // preparation tools cannot act during investigation (AC3).
    for (const [tool, request] of [
        [ToolName.RunCommand, requests[1]],
        [ToolName.WriteFile, requests[2]],
    ] as const) {
        const bounced = result.trace.events.find(
            (event) =>
                event.type === TraceEventType.ToolResult &&
                event.payload['tool'] === tool &&
                (event.payload['result'] as Record<string, unknown>)['rejectedBeforeExecution'] ===
                    true,
        );
        expect(bounced).toBeDefined();
        const refusal = request!.messages.at(-1) as { role: string; content: string };
        expect(refusal.role).toBe('tool');
        expect(refusal.content).toContain(tool);
    }
});

it('fails at wiring time when the runtime registry holds a name outside the surface', async () => {
    const runtime = stubRuntime({ stray_tool: async () => ({ ok: true }) });
    await expect(runFixSession(sessionOptions(runtime))).rejects.toThrow(
        'Fix session surface is missing registry tool',
    );
});

/**
 * The selection arguments the strict select_environment schema requires.
 *
 * @returns The selection call payload.
 */
function environmentSelectionArgs() {
    return {
        kind: 'browser_extension',
        requiredCapabilities: ['browser_navigation', 'filtering_control'],
        intent: {
            issueType: 'ads',
            rationale: 'The agent classified the issue from its prompt-safe evidence.',
            confidence: 0.9,
            evidence: [
                {
                    source: 'issue_body',
                    observation: 'The report describes a website-filtering symptom.',
                },
            ],
            conflicts: [],
        },
        rationale: 'The selected environment best fits the issue and host capabilities.',
        confidence: 0.85,
    };
}
