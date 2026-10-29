import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolName } from '../../src/agent/tool-names';
import { ToolRegistry } from '../../src/agent/tool-registry';
import { runFixSession } from '../../src/orchestrator/fix-session';
import { FixTerminalSource } from '../../src/orchestrator/fix-session-seal';
import {
    ENUMERATION_NOTICE_KEY,
    ENUMERATION_STREAK_LIMIT,
    ENUMERATION_STREAK_PHASE,
} from '../../src/orchestrator/tool-enumeration-backstop';
import { SESSION_SKILLS_ROOT } from '../../src/pi/session-logical-paths';
import { skillsReadFailureMessage } from '../../src/pi/skills-read-tool';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import { FixOutcomeKind } from '../../src/types/fix-outcome';
import { type IssueFacts, ProblemType } from '../../src/types/issue-facts';
import { RunMode, TraceEventType } from '../../src/types/trace';
import {
    HermeticScenario,
    type HermeticProvider,
    type RecordedProviderRequest,
    type ScriptedReply,
    ScriptedReplyKind,
    startHermeticProvider,
} from '../pi/hermetic-provider';
import { logicalSkillFile, REPORT_STYLE_SKILL, writeSkill } from '../pi/skill-fixtures';
import { createTestPiRuntime } from '../pi/test-runtime';
import { testCoreConfig } from '../config/test-core-config';

const ISSUE_NUMBER = 7;

const FACTS: IssueFacts = {
    issueNumber: ISSUE_NUMBER,
    issueUrl: `https://github.com/example-owner/example-repo/issues/${ISSUE_NUMBER}`,
    reportedSiteUrls: [],
    labels: [],
    problemType: ProblemType.Unknown,
    product: 'AdGuard Browser Extension',
    enabledFilters: [],
    screenshots: [],
};

const ANALYSIS_ONLY_PAYLOAD = {
    outcome: FixOutcomeKind.AnalysisOnly,
    reasoning: 'Hermetic reasoning marker',
    summary: 'Hermetic run.',
};

/**
 * A file the skill's folder does not hold, so every read of it is refused.
 */
const MISSING_SKILL_FILE = posix.join(SESSION_SKILLS_ROOT, REPORT_STYLE_SKILL.name, 'missing.md');

const createdDirs: string[] = [];
let provider: HermeticProvider | undefined;

afterEach(async () => {
    await provider?.close();
    provider = undefined;
    for (const dir of createdDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/**
 * Create one throwaway directory that a test owns.
 *
 * @returns Absolute path of the created directory.
 */
function scratchDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'fix-session-skills-'));
    createdDirs.push(dir);
    return dir;
}

/**
 * One scripted tool-call reply.
 *
 * @param toolName - The tool the scripted model calls.
 * @param args - The call arguments.
 * @returns The scripted reply.
 */
function toolCall(toolName: string, args: Record<string, unknown>): ScriptedReply {
    return { kind: ScriptedReplyKind.ToolCall, toolName, toolArguments: JSON.stringify(args) };
}

/**
 * One scripted read of the skill's listed location.
 *
 * @returns The scripted reply.
 */
function readSkill(): ScriptedReply {
    return toolCall(ToolName.Read, { path: logicalSkillFile(REPORT_STYLE_SKILL.name) });
}

/**
 * One scripted read of a file the skill does not hold, which the read tool refuses.
 *
 * @returns The scripted reply.
 */
function readMissing(): ScriptedReply {
    return toolCall(ToolName.Read, { path: MISSING_SKILL_FILE });
}

/**
 * One scripted repository search, each with its own pattern.
 *
 * @param index - Makes the pattern of this call different from every other.
 * @returns The scripted reply.
 */
function search(index: number): ScriptedReply {
    return toolCall(ToolName.SearchRules, { urlPattern: `||ex.co^$variant-${index}` });
}

/**
 * The last message of one recorded request: the tool result the model just received.
 *
 * @param request - The recorded request.
 * @returns The message, JSON-encoded.
 */
function lastMessageOf(request: RecordedProviderRequest): string {
    return JSON.stringify(request.messages.at(-1));
}

/**
 * Run one fix session over a skills directory holding one skill, with a registry that answers
 * `search_rules`.
 *
 * @param script - The reply sequence the provider serves.
 * @returns The sealed run result, the recorded requests and the streak decisions the trace holds.
 */
async function runSkillsSession(script: ScriptedReply[]) {
    const skillsDir = join(scratchDir(), 'skills');
    writeSkill(skillsDir, REPORT_STYLE_SKILL);
    const registry = new ToolRegistry();
    registry.register({
        definition: {
            type: 'function',
            function: {
                name: ToolName.SearchRules,
                description: ToolName.SearchRules,
                parameters: { type: 'object', properties: {}, required: [] },
            },
        },
        handler: async () => ({ totalMatches: 0, matches: [] }),
    });
    const recorder = new TraceRecorder({
        runId: 'fix-session-skills-test',
        issueNumber: ISSUE_NUMBER,
        mode: RunMode.Fix,
    });
    provider = await startHermeticProvider({ scenario: HermeticScenario.Scripted, script });
    const result = await runFixSession({
        piRuntime: await createTestPiRuntime({ baseUrl: provider.baseUrl }),
        runtime: { registry, validateTerminalOutcome: () => undefined },
        recorder,
        facts: FACTS,
        issueNumber: ISSUE_NUMBER,
        routingCheck: false,
        llm: testCoreConfig().llm,
        budgets: { wallClockMs: 60 * 60_000, maxTurns: 100 },
        workDir: scratchDir(),
        skillsDir,
    });
    const streaks = recorder
        .toJSON()
        .events.filter(
            (event) =>
                event.type === TraceEventType.Decision &&
                event.payload.phase === ENUMERATION_STREAK_PHASE,
        )
        .map((event) => event.payload);
    return { result, requests: provider.requests, streaks };
}

describe('fix session skills read and the enumeration backstop', () => {
    it('asks the model to stop a streak of skill reads', async () => {
        const { result, requests, streaks } = await runSkillsSession([
            ...Array.from({ length: ENUMERATION_STREAK_LIMIT }, () => readSkill()),
            toolCall(ToolName.FinishFix, ANALYSIS_ONLY_PAYLOAD),
        ]);

        expect(result.terminalSource).toBe(FixTerminalSource.ModelFinishFix);
        const beforeTrip = lastMessageOf(requests[ENUMERATION_STREAK_LIMIT - 1]!);
        const atTrip = lastMessageOf(requests[ENUMERATION_STREAK_LIMIT]!);
        expect(beforeTrip).not.toContain(ENUMERATION_NOTICE_KEY);
        // The skill text still reaches the model, with the notice after it.
        expect(atTrip).toContain(ENUMERATION_NOTICE_KEY);
        expect(atTrip).toContain(REPORT_STYLE_SKILL.body);
        expect(streaks).toEqual([
            {
                phase: ENUMERATION_STREAK_PHASE,
                tool: ToolName.Read,
                consecutiveCalls: ENUMERATION_STREAK_LIMIT,
            },
        ]);
    });

    it('counts refused skill reads toward their own streak', async () => {
        const { result, requests, streaks } = await runSkillsSession([
            ...Array.from({ length: ENUMERATION_STREAK_LIMIT }, () => readMissing()),
            toolCall(ToolName.FinishFix, ANALYSIS_ONLY_PAYLOAD),
        ]);

        expect(result.terminalSource).toBe(FixTerminalSource.ModelFinishFix);
        const refusal = skillsReadFailureMessage(MISSING_SKILL_FILE, 'ENOENT');
        const beforeTrip = lastMessageOf(requests[ENUMERATION_STREAK_LIMIT - 1]!);
        const atTrip = lastMessageOf(requests[ENUMERATION_STREAK_LIMIT]!);
        expect(beforeTrip).toContain(refusal);
        expect(beforeTrip).not.toContain(ENUMERATION_NOTICE_KEY);
        // The refusal still reaches the model, with the notice after it.
        expect(atTrip).toContain(refusal);
        expect(atTrip).toContain(ENUMERATION_NOTICE_KEY);
        expect(streaks).toEqual([
            {
                phase: ENUMERATION_STREAK_PHASE,
                tool: ToolName.Read,
                consecutiveCalls: ENUMERATION_STREAK_LIMIT,
            },
        ]);
    });

    it('lets a refused skill read break a streak of searches', async () => {
        const { result, requests, streaks } = await runSkillsSession([
            ...Array.from({ length: ENUMERATION_STREAK_LIMIT - 1 }, (_, index) => search(index)),
            readMissing(),
            search(100),
            toolCall(ToolName.FinishFix, ANALYSIS_ONLY_PAYLOAD),
        ]);

        expect(result.terminalSource).toBe(FixTerminalSource.ModelFinishFix);
        for (const request of requests) {
            expect(lastMessageOf(request)).not.toContain(ENUMERATION_NOTICE_KEY);
        }
        expect(streaks).toEqual([]);
    });

    it('lets a skill read break a streak of searches', async () => {
        const { result, requests, streaks } = await runSkillsSession([
            ...Array.from({ length: ENUMERATION_STREAK_LIMIT - 1 }, (_, index) => search(index)),
            readSkill(),
            search(100),
            toolCall(ToolName.FinishFix, ANALYSIS_ONLY_PAYLOAD),
        ]);

        expect(result.terminalSource).toBe(FixTerminalSource.ModelFinishFix);
        for (const request of requests) {
            expect(lastMessageOf(request)).not.toContain(ENUMERATION_NOTICE_KEY);
        }
        expect(streaks).toEqual([]);
    });
});
