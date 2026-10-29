import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolName } from '../../src/agent/tool-names';
import { RunMode } from '../../src/types/trace';
import { SealKind } from '../../src/pi/seal-types';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import {
    PreparationTerminalStatus,
    runPreparationSession,
    type PreparationSessionResult,
} from '../../src/orchestrator/preparation-session';
import { PREPARATION_WRITE_MAX_BYTES } from '../../src/orchestrator/preparation-tools';
import type { LlmConfig } from '../../src/config/config';
import { LlmApi } from '../../src/config/llm-api';
import { ReasoningEffort } from '../../src/config/reasoning-effort';
import type { HermeticProvider, ScriptedReply } from '../pi/hermetic-provider';
import {
    HermeticScenario,
    ScriptedReplyKind,
    startHermeticProvider,
} from '../pi/hermetic-provider';
import {
    createTestPiRuntime,
    REASONING_MODEL,
    TEST_API_KEY,
    VISION_MODEL,
} from '../pi/test-runtime';
import {
    advertisedToolNames,
    logicalSkillFile,
    REPORT_STYLE_SKILL,
    systemPromptOf,
    writeSkill,
} from '../pi/skill-fixtures';

let workDir: string;
let provider: HermeticProvider | undefined;

afterEach(async () => {
    if (!provider) {
        return;
    }
    await provider.close();
    provider = undefined;
    if (workDir !== undefined) {
        rmSync(workDir, { recursive: true, force: true });
    }
});

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
 * Scripted finish_preparation reply.
 *
 * @param payload - The terminal payload the scripted model submits.
 * @returns The scripted reply.
 */
function finishPreparation(payload: Record<string, unknown>): ScriptedReply {
    return toolCall(ToolName.FinishPreparation, JSON.stringify(payload));
}

/**
 * The provider slice the session derives its per-request deadline and retry bound from — the same
 * `llm` config every other mode session takes.
 *
 * @returns The validated-shaped provider configuration.
 */
function preparationLlm(): LlmConfig {
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
    };
}

/**
 * The secret-bearing source environment the preparation subprocess must filter. Every value below
 * is real parent-run material, deliberate so their absence is assertable in the child's printenv.
 */
const SECRET_ENV = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LLM_API_KEY: 'sk-secret-llm-key',
    GITHUB_TOKEN: 'github-token-secret',
    AGENT_INVESTIGATION_BUDGET_MS: '3600000',
} as const;

/**
 * Overrides beyond the shared options; the provider flag stays a provider option, the rest are
 * session options.
 */
interface RunSessionOverrides {
    /**
     * Reply served for requests past the end of the script queue.
     */
    scriptExhausted?: ScriptedReply;

    /**
     * Session wall-clock budget override.
     */
    wallClockMs?: number;

    /**
     * Session turn-cap override.
     */
    maxTurns?: number;

    /**
     * Repository skills directory the session lists to the model; absent keeps the session without
     * skills.
     */
    skillsDir?: string;
}

/**
 * Start the hermetic provider and run one preparation session.
 *
 * @param script - The reply sequence the provider serves.
 * @param overrides - Optional provider and session overrides.
 * @returns The session result and the recorded trace events.
 */
async function runSession(
    script: ScriptedReply[],
    overrides: RunSessionOverrides = {},
): Promise<{ result: PreparationSessionResult; events: unknown[] }> {
    workDir = mkdtempSync(join(tmpdir(), 'preparation-session-'));
    mkdirSync(workDir, { recursive: true });
    const recorder = new TraceRecorder({
        runId: 'preparation-session-test',
        issueNumber: 1,
        mode: RunMode.Fix,
    });
    provider = await startHermeticProvider({
        scenario: HermeticScenario.Scripted,
        script,
        ...(overrides.scriptExhausted === undefined
            ? {}
            : { scriptExhausted: overrides.scriptExhausted }),
    });
    const runtime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
    const result = await runPreparationSession({
        runtime,
        llm: preparationLlm(),
        recorder,
        workDir,
        preparationSection: 'Run the blocker build steps of the instruction.',
        sourceEnvironment: SECRET_ENV,
        ...(overrides.wallClockMs === undefined ? {} : { wallClockMs: overrides.wallClockMs }),
        ...(overrides.maxTurns === undefined ? {} : { maxTurns: overrides.maxTurns }),
        ...(overrides.skillsDir === undefined ? {} : { skillsDir: overrides.skillsDir }),
    });
    const events = recorder.toJSON().events;
    return { result, events };
}

/**
 * The tool_result payload of the first recorded call of one tool.
 *
 * The executed result is recorded with the model envelope as the `content`/`details` pair, so the
 * structured payload the trace keeps lives under `result.details`.
 *
 * @param events - Recorded trace events.
 * @param tool - Tool name to look up.
 * @returns The recorded result payload.
 */
function firstToolResultPayload(events: unknown[], tool: string): Record<string, unknown> {
    const results = (events as { type: string; payload: Record<string, unknown> }[]).filter(
        (event) => event.type === 'tool_result' && event.payload['tool'] === tool,
    );
    const first = results[0];
    if (first === undefined) {
        throw new Error(`No ${tool} tool_result event was recorded.`);
    }
    const recorded = (first as unknown as { payload: { result: Record<string, unknown> } }).payload[
        'result'
    ];
    const details = recorded['details'];
    if (typeof details === 'object' && details !== null) {
        return details as Record<string, unknown>;
    }
    return recorded;
}

/**
 * The managed-storage document the uBlock Origin example declares, as the payload carries it.
 */
const UBLOCK_MANAGED_STORAGE = {
    adminSettings: { selectedFilterLists: ['user-filters', 'ublock-filters'] },
};

describe('preparation session', () => {
    it('seals a Firefox launch declaration with its XPI resolved inside the workdir', async () => {
        const { result } = await runSession([
            finishPreparation({
                status: 'done',
                launchFamily: 'firefox',
                extensionId: 'uBlock0@raymondhill.net',
                xpiPath: 'ublock-origin.firefox.signed.xpi',
                managedStorage: JSON.stringify(UBLOCK_MANAGED_STORAGE),
                userFiltersKeyPath: ['adminSettings', 'userFilters'],
            }),
        ]);

        expect(result.status).toBe('done');
        expect(result.extensionDir).toBeUndefined();
        expect(result.firefoxLaunch).toStrictEqual({
            launchFamily: 'firefox',
            extensionId: 'uBlock0@raymondhill.net',
            xpiPath: join(workDir, 'ublock-origin.firefox.signed.xpi'),
            managedStorageTemplate: UBLOCK_MANAGED_STORAGE,
            userFiltersKeyPath: ['adminSettings', 'userFilters'],
        });
    });

    it('refuses an unusable Firefox declaration inside the session so the model corrects it', async () => {
        const { result } = await runSession([
            // The declared key path crosses the filter-list array, which cannot carry the filters.
            finishPreparation({
                status: 'done',
                launchFamily: 'firefox',
                extensionId: 'uBlock0@raymondhill.net',
                xpiPath: 'ublock-origin.firefox.signed.xpi',
                managedStorage: JSON.stringify(UBLOCK_MANAGED_STORAGE),
                userFiltersKeyPath: ['adminSettings', 'selectedFilterLists', 'userFilters'],
            }),
            finishPreparation({
                status: 'done',
                launchFamily: 'firefox',
                extensionId: 'uBlock0@raymondhill.net',
                xpiPath: 'ublock-origin.firefox.signed.xpi',
                managedStorage: JSON.stringify(UBLOCK_MANAGED_STORAGE),
                userFiltersKeyPath: ['adminSettings', 'userFilters'],
            }),
        ]);

        expect(result.status).toBe('done');
        expect(result.firefoxLaunch?.userFiltersKeyPath).toStrictEqual([
            'adminSettings',
            'userFilters',
        ]);
    });

    it('executes run_command in the workdir with a secret-free env and records the full output', async () => {
        const { result, events } = await runSession([
            toolCall(ToolName.RunCommand, JSON.stringify({ command: ['printenv'] })),
            toolCall(
                ToolName.RunCommand,
                JSON.stringify({ command: ['echo', 'build-step-marker'] }),
            ),
            finishPreparation({ status: 'done', extensionDir: '.' }),
        ]);

        expect(result.status).toBe('done');
        expect(result.workDir).toBe(workDir);
        // Full captured output returned to the model...
        const envOutput = String(firstToolResultPayload(events, ToolName.RunCommand)['stdout']);
        expect(envOutput).toContain('PATH=');
        // ...and the same full text lands in the trace recorder.
        expect(JSON.stringify(events)).toContain('build-step-marker');
        // The preparation environment holds neither the LLM key, the token, the derived
        // GIT_CONFIG_* credential, nor an arbitrary parent variable (AC4 boundary).
        expect(envOutput).not.toContain('sk-secret-llm-key');
        expect(envOutput).not.toContain('github-token-secret');
        expect(envOutput).not.toContain('3600000');
        expect(envOutput).not.toContain('GIT_CONFIG_');
    });

    it('refuses further step tools after a failed command and accepts only the failed seal', async () => {
        const afterFailurePath = join(workDir, 'after-failure.txt');
        const { result, events } = await runSession([
            toolCall(
                ToolName.RunCommand,
                JSON.stringify({
                    command: [
                        'sh',
                        '-c',
                        'echo failed-stdout-marker; echo failed-stderr-marker >&2; exit 3',
                    ],
                }),
            ),
            toolCall(ToolName.RunCommand, JSON.stringify({ command: ['true'] })),
            toolCall(
                ToolName.WriteFile,
                JSON.stringify({ path: 'after-failure.txt', content: 'x' }),
            ),
            finishPreparation({ status: 'failed', failedCommand: 'sh' }),
        ]);

        expect(result.status).toBe('failed');
        expect(result.failedCommand).toBe('sh');
        expect(JSON.stringify(events)).toContain('step-failed');
        // A failed step yields an error with its output: the model envelope carries the failed
        // command's full captured streams...
        const failedResult = firstToolResultPayload(events, ToolName.RunCommand);
        expect(failedResult['exitCode']).toBe(3);
        expect(String(failedResult['stdout'])).toContain('failed-stdout-marker');
        expect(String(failedResult['stderr'])).toContain('failed-stderr-marker');
        // ...and the same full text lands in the trace the run report is built from.
        expect(JSON.stringify(events)).toContain('failed-stdout-marker');
        expect(JSON.stringify(events)).toContain('failed-stderr-marker');
        // The refuse-after-latch calls never wrote or ran.
        expect(statSync(afterFailurePath, { throwIfNoEntry: false })).toBeUndefined();
    });

    it('seals done with the workDir when every step exits zero', async () => {
        const { result } = await runSession([
            toolCall(ToolName.RunCommand, JSON.stringify({ command: ['true'] })),
            toolCall(
                ToolName.WriteFile,
                JSON.stringify({ path: 'out/report.txt', content: 'built' }),
            ),
            finishPreparation({ status: 'done', extensionDir: 'out' }),
        ]);

        expect(result).toEqual({
            status: 'done',
            workDir,
            extensionDir: join(workDir, 'out'),
        });
        expect(readFileSync(join(workDir, 'out', 'report.txt'), 'utf8')).toBe('built');
    });

    it('confines write_file to the workdir and caps the payload', async () => {
        expect(PREPARATION_WRITE_MAX_BYTES).toBeGreaterThan(0);
        const oversized = 'a'.repeat(PREPARATION_WRITE_MAX_BYTES + 1);
        const { result, events } = await runSession([
            toolCall(ToolName.WriteFile, JSON.stringify({ path: '../escape.txt', content: 'x' })),
            toolCall(
                ToolName.WriteFile,
                JSON.stringify({ path: '/absolute/path.txt', content: 'x' }),
            ),
            toolCall(ToolName.WriteFile, JSON.stringify({ path: 'big.bin', content: oversized })),
            toolCall(ToolName.WriteFile, JSON.stringify({ path: 'inside.txt', content: 'kept' })),
            finishPreparation({ status: 'done', extensionDir: 'inside.txt' }),
        ]);

        expect(result.status).toBe('done');
        expect(result.extensionDir).toBe(join(workDir, 'inside.txt'));
        const refusals = JSON.stringify(events).match(/preparation workdir|byte cap/gu) ?? [];
        expect(refusals).toHaveLength(3);
        expect(statSync(join(workDir, 'inside.txt'), { throwIfNoEntry: false })).toBeDefined();
        expect(statSync(join(tmpdir(), 'escape.txt'), { throwIfNoEntry: false })).toBeUndefined();
        expect(statSync('/absolute/path.txt', { throwIfNoEntry: false })).toBeUndefined();
        expect(statSync(join(workDir, 'big.bin'), { throwIfNoEntry: false })).toBeUndefined();
    });

    it('rejects a done seal while a failed step is latched, with user-shaped guidance', async () => {
        const { result, events } = await runSession([
            toolCall(ToolName.RunCommand, JSON.stringify({ command: ['false'] })),
            finishPreparation({ status: 'done', extensionDir: '.' }),
            finishPreparation({ status: 'done', extensionDir: '.' }),
            finishPreparation({ status: 'done', extensionDir: '.' }),
        ]);

        expect(result.status).toBe('failed');
        expect(result.failedCommand).toBe('false');
        // The finite rejection the model is told names the failed step; no done payload was
        // accepted while the latch held.
        expect(JSON.stringify(events)).toContain('failed preparation step');
        expect(result.extensionDir).toBeUndefined();
    });

    it('ends the phase with the typed failure status when the wall-clock budget expires', async () => {
        const { result } = await runSession(
            [toolCall(ToolName.RunCommand, JSON.stringify({ command: ['sleep', '0.05'] }))],
            {
                scriptExhausted: toolCall(
                    ToolName.RunCommand,
                    JSON.stringify({ command: ['sleep', '0.05'] }),
                ),
                wallClockMs: 300,
            },
        );

        expect(result.status).toBe('failed');
        expect(result.detail).toContain('budget');
        expect(result.extensionDir).toBeUndefined();
    });

    it('ends the phase with the typed failure status when the turn cap is exhausted', async () => {
        const { result } = await runSession(
            [
                { kind: ScriptedReplyKind.Text, text: 'no terminal call' },
                { kind: ScriptedReplyKind.Text, text: 'still none' },
            ],
            { maxTurns: 2 },
        );

        expect(result.status).toBe('failed');
        expect(typeof result.detail).toBe('string');
        expect(SealKind.NoTerminal).toBeDefined();
        expect(result.extensionDir).toBeUndefined();
    });

    it('lists the repository skills in the preparation session prompt', async () => {
        const skillsDir = mkdtempSync(join(tmpdir(), 'preparation-skills-'));
        writeSkill(skillsDir, REPORT_STYLE_SKILL);
        try {
            const { result } = await runSession(
                [finishPreparation({ status: PreparationTerminalStatus.Done, extensionDir: '.' })],
                { skillsDir },
            );

            expect(result.status).toBe(PreparationTerminalStatus.Done);
            const system = systemPromptOf(provider!.requests[0]!);
            expect(system).toContain(REPORT_STYLE_SKILL.name);
            expect(system).toContain(REPORT_STYLE_SKILL.description);
            expect(system).toContain(logicalSkillFile(REPORT_STYLE_SKILL.name));
            expect(system).not.toContain(skillsDir);
            expect(advertisedToolNames(provider!.requests[0]!)).toContain(ToolName.Read);
        } finally {
            rmSync(skillsDir, { recursive: true, force: true });
        }
    });
});
