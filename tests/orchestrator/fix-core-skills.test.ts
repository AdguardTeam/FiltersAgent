import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { levels, pino } from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolName } from '../../src/agent/tool-names';
import { ToolRegistry } from '../../src/agent/tool-registry';
import { ExtensionManifestVersion } from '../../src/environment/extension-preparation';
import type { LoggerOptions } from '../../src/logger/logger';
import { runFixCore } from '../../src/orchestrator/fix-core';
import { reportRepositorySkills } from '../../src/pi/repository-skills-report';
import type { FixRunResult } from '../../src/types/fix-run-result';
import { BrowserMode } from '../../src/types/browser-mode';
import { FixOutcomeKind } from '../../src/types/fix-outcome';
import { TraceEventType } from '../../src/types/trace';
import {
    type HermeticProvider,
    HermeticScenario,
    type ScriptedReply,
    ScriptedReplyKind,
    startHermeticProvider,
} from '../pi/hermetic-provider';
import {
    logicalSkillFile,
    REPORT_STYLE_SKILL,
    systemPromptOf,
    writeSkill,
} from '../pi/skill-fixtures';
import { createTestPiRuntime } from '../pi/test-runtime';
import {
    CORE_PROBE_NAME,
    coreConfig,
    environmentSelectionArgs,
    localFacts,
    localIssue,
} from './fix-core-fixtures';

/**
 * The seams this suite replaces: the pinned-release download, so a run resolves a fixture build
 * instead of reaching the release network, and the run logger, so the suite reads what a run logs.
 */
const { pinnedReleaseSeamMock, runLog } = vi.hoisted(() => ({
    pinnedReleaseSeamMock: vi.fn(),
    runLog: [] as Record<string, unknown>[],
}));

vi.mock('../../src/local/pinned-extension-release', () => ({
    downloadPinnedExtensionRelease: pinnedReleaseSeamMock,
}));

vi.mock('../../src/logger/logger', () => ({
    createLogger: (options: LoggerOptions = {}) =>
        pino(
            { level: options.verbose ? 'debug' : 'info' },
            {
                write: (line: string) => {
                    runLog.push(JSON.parse(line) as Record<string, unknown>);
                },
            },
        ),
}));

vi.mock('../../src/pi/repository-skills-report', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/pi/repository-skills-report')>();
    return { reportRepositorySkills: vi.fn(actual.reportRepositorySkills) };
});

/**
 * The shared fixture build the pinned-release seam resolves to, and its disposable root.
 */
const PINNED_RELEASE_FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'fix-core-skills-release-'));
const PINNED_RELEASE_FIXTURE_DIR = join(PINNED_RELEASE_FIXTURE_ROOT, 'unpacked');
mkdirSync(PINNED_RELEASE_FIXTURE_DIR, { recursive: true });
writeFileSync(
    join(PINNED_RELEASE_FIXTURE_DIR, 'manifest.json'),
    JSON.stringify({ version: '5.5.2.3', manifest_version: 3 }),
);

let hermetic: HermeticProvider | undefined;
const createdDirs: string[] = [];

afterAll(() => {
    rmSync(PINNED_RELEASE_FIXTURE_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
    runLog.splice(0);
    vi.mocked(reportRepositorySkills).mockClear();
    pinnedReleaseSeamMock.mockReset();
    pinnedReleaseSeamMock.mockResolvedValue({
        extensionDir: PINNED_RELEASE_FIXTURE_DIR,
        manifestVersion: ExtensionManifestVersion.Mv3,
        sha256: 'e'.repeat(64),
        tag: 'v5.5.2.3',
        fromCache: false,
    });
});

afterEach(async () => {
    await hermetic?.close();
    hermetic = undefined;
    for (const dir of createdDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/**
 * Scripted tool-call reply for the hermetic provider.
 *
 * @param name - The tool the scripted model calls.
 * @param args - JSON-encodable call arguments.
 * @returns The scripted reply.
 */
function toolCall(name: string, args: unknown): ScriptedReply {
    return {
        kind: ScriptedReplyKind.ToolCall,
        toolName: name,
        toolArguments: JSON.stringify(args),
    };
}

/**
 * Run one agentic core investigation in which the model reads the skill, selects an environment it
 * cannot prepare and finishes with an analysis.
 *
 * @param root - Throwaway directory the run's filters checkout and artifacts go under.
 * @param skillsDir - The skills directory the run carries, if any.
 * @returns The run result.
 */
async function runWithSkills(root: string, skillsDir: string | undefined): Promise<FixRunResult> {
    const filtersPath = join(root, 'filters');
    mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
    writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
    hermetic = await startHermeticProvider({
        scenario: HermeticScenario.Scripted,
        script: [
            toolCall(ToolName.Read, { path: logicalSkillFile(REPORT_STYLE_SKILL.name) }),
            toolCall(ToolName.FetchIssue, { issueNumber: 4 }),
            toolCall(ToolName.SelectEnvironment, environmentSelectionArgs(CORE_PROBE_NAME)),
            toolCall(ToolName.FinishFix, {
                outcome: FixOutcomeKind.AnalysisOnly,
                reasoning: 'The selected desktop executor could not be prepared.',
            }),
        ],
    });
    const piRuntime = await createTestPiRuntime({
        baseUrl: hermetic.baseUrl,
        model: 'test-model',
        visionModel: 'gemini-3.5-flash',
    });
    return await runFixCore(
        { ...coreConfig(), repositoryPath: filtersPath },
        { rawIssue: localIssue(), facts: localFacts() },
        {
            artifactsDir: join(root, 'artifacts'),
            browserMode: BrowserMode.On,
            ...(skillsDir === undefined ? {} : { skillsDir }),
            agentRuntime: {},
        },
        {
            piRuntime,
            agentRuntime: { createBaseRegistry: async () => new ToolRegistry() },
        },
    );
}

/**
 * Create one throwaway directory that a test owns.
 *
 * @returns Absolute path of the created directory.
 */
function scratchDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'fix-core-skills-'));
    createdDirs.push(dir);
    return dir;
}

describe('the agentic core threads the repository skills to its sessions', () => {
    it('lists the skills in the fix session prompt and records the read call in the trace', async () => {
        const root = scratchDir();
        const skillsDir = join(root, 'skills');
        writeSkill(skillsDir, REPORT_STYLE_SKILL);

        const result = await runWithSkills(root, skillsDir);

        const system = systemPromptOf(hermetic!.requests[0]!);
        expect(system).toContain(REPORT_STYLE_SKILL.name);
        expect(system).toContain(REPORT_STYLE_SKILL.description);
        expect(system).toContain(logicalSkillFile(REPORT_STYLE_SKILL.name));
        const toolMessages = hermetic!.requests[1]!.messages.filter(
            (message) => message.role === 'tool',
        );
        expect(JSON.stringify(toolMessages)).toContain(REPORT_STYLE_SKILL.body);
        const trace = JSON.parse(readFileSync(result.artifactPaths.trace!, 'utf8')) as {
            events: { type: string; payload: Record<string, unknown> }[];
        };
        expect(
            trace.events.some(
                (event) =>
                    event.type === TraceEventType.ToolCall &&
                    event.payload['tool'] === ToolName.Read,
            ),
        ).toBe(true);
    });

    it('warns once in the run log about a skill pi skipped', async () => {
        const root = scratchDir();
        const skillsDir = join(root, 'skills');
        writeSkill(skillsDir, REPORT_STYLE_SKILL);
        const brokenFile = writeSkill(skillsDir, {
            name: 'broken-style',
            body: REPORT_STYLE_SKILL.body,
        });

        await runWithSkills(root, skillsDir);

        const brokenWarnings = runLog.filter(
            (entry) => entry['level'] === levels.values.warn && entry['path'] === brokenFile,
        );
        expect(brokenWarnings).toHaveLength(1);
        expect(reportRepositorySkills).toHaveBeenCalledOnce();
        expect(reportRepositorySkills).toHaveBeenCalledWith(skillsDir, expect.anything());
    });

    it('reports no skills for a run without a skills directory', async () => {
        await runWithSkills(scratchDir(), undefined);

        expect(reportRepositorySkills).not.toHaveBeenCalled();
    });
});
