import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { ToolName } from '../../src/agent/tool-names';
import { SealKind } from '../../src/pi/seal-types';
import type { SessionTurnObservation } from '../../src/pi/session-observations';
import { PI_AGENT_DIR, runAgentSession } from '../../src/pi/session-runner';
import type { SessionSkills } from '../../src/pi/session-skills';
import { buildTerminalTool } from '../../src/pi/terminal-tool';
import { createSkillsReadTool, SKILLS_READ_OUTSIDE_MESSAGE } from '../../src/pi/skills-read-tool';
import {
    type HermeticProvider,
    HermeticScenario,
    type ScriptedReply,
    ScriptedReplyKind,
    startHermeticProvider,
} from './hermetic-provider';
import {
    advertisedToolNames,
    logicalSkillFile,
    REPORT_STYLE_SKILL,
    systemPromptOf,
    writeSkill,
} from './skill-fixtures';
import {
    createTestPiRuntime,
    TEST_REASONING_EFFORT,
    TEST_RUN_BUDGETS,
    TEST_RUN_RETRIES,
} from './test-runtime';

const TERMINAL_TOOL_NAME = 'submit_verdict';
const SYSTEM_PROMPT = 'You are a test agent. Finish by calling submit_verdict.';
const NUDGE_TEXT = 'You ended your turn without calling submit_verdict. Call it now.';

const READ_DESCRIPTION = 'Read one file of a repository skill.';

const VerdictSchema = v.object({
    verdict: v.picklist(['ok', 'retry']),
    summary: v.string(),
});
type Verdict = v.InferOutput<typeof VerdictSchema>;

const VALID_PAYLOAD: Verdict = { verdict: 'ok', summary: 'all good' };

let workDir: string | undefined;
let provider: HermeticProvider | undefined;
const createdDirs: string[] = [];

afterEach(async () => {
    if (provider) {
        await provider.close();
        provider = undefined;
    }
    for (const dir of createdDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
    if (workDir !== undefined) {
        rmSync(workDir, { recursive: true, force: true });
        workDir = undefined;
    }
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
 * One scripted `read` tool-call reply.
 *
 * @param filePath - Path the scripted model asks to read.
 * @returns The scripted reply.
 */
function readCall(filePath: string): ScriptedReply {
    return {
        kind: ScriptedReplyKind.ToolCall,
        toolName: ToolName.Read,
        toolArguments: JSON.stringify({ path: filePath }),
    };
}

/**
 * Build the session skills option over one directory, with the confined read tool the caller's
 * session layer would wrap.
 *
 * @param skillsDir - Absolute skills directory.
 * @returns The session skills option.
 */
function skillsOf(skillsDir: string): SessionSkills {
    return { dir: skillsDir, readTool: createSkillsReadTool(skillsDir, READ_DESCRIPTION) };
}

/**
 * Extra knobs of one scripted run.
 */
interface ScriptedRunOptions {
    /**
     * Repository skills directory and confined read tool; absent keeps today's tool set.
     */
    skills?: SessionSkills;

    /**
     * Per-turn observer, for the tool-call names a turn carried.
     */
    onTurnEnd?: (observation: SessionTurnObservation) => void;

    /**
     * Run directory override; defaults to a fresh throwaway directory. A suite that plants a skill
     * where pi's own agent-directory discovery would look passes the directory holding it.
     */
    workDir?: string;
}

/**
 * Run one session against a scripted hermetic provider.
 *
 * @param script - The reply sequence the provider serves.
 * @param options - Skills, observer and run-directory overrides.
 * @returns The sealed outcome and the provider's recorded requests.
 */
async function runScripted(script: ScriptedReply[], options: ScriptedRunOptions = {}) {
    if (provider) {
        await provider.close();
        provider = undefined;
    }
    if (workDir !== undefined) {
        rmSync(workDir, { recursive: true, force: true });
    }
    workDir = options.workDir ?? mkdtempSync(join(tmpdir(), 'pi-session-skills-'));
    provider = await startHermeticProvider({ scenario: HermeticScenario.Scripted, script });
    const runtime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
    const terminal = buildTerminalTool<Verdict>({
        name: TERMINAL_TOOL_NAME,
        description: 'Submit the final verdict.',
        schema: VerdictSchema,
    });
    const outcome = await runAgentSession<Verdict>({
        runtime,
        systemPrompt: SYSTEM_PROMPT,
        userTask: 'Work the tools, then submit the verdict.',
        nudge: NUDGE_TEXT,
        terminal,
        ...(options.skills === undefined ? {} : { skills: options.skills }),
        budgets: TEST_RUN_BUDGETS,
        retries: TEST_RUN_RETRIES,
        reasoningEffort: TEST_REASONING_EFFORT,
        workDir,
        onTurnEnd: options.onTurnEnd,
    });
    return { outcome, requests: provider.requests };
}

/**
 * Create one throwaway directory that a test owns.
 *
 * @returns Absolute path of the created directory.
 */
function scratchDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pi-session-skills-fixture-'));
    createdDirs.push(dir);
    return dir;
}

describe('runAgentSession repository skills', () => {
    it('lists a loaded skill under the logical skills root and offers read', async () => {
        const skillsDir = join(scratchDir(), 'skills');
        writeSkill(skillsDir, REPORT_STYLE_SKILL);

        const { requests } = await runScripted([verdictCall(VALID_PAYLOAD)], {
            skills: skillsOf(skillsDir),
        });

        const system = systemPromptOf(requests[0]!);
        expect(system).toContain(REPORT_STYLE_SKILL.name);
        expect(system).toContain(REPORT_STYLE_SKILL.description);
        expect(system).toContain(logicalSkillFile(REPORT_STYLE_SKILL.name));
        expect(system).not.toContain(skillsDir);
        expect(advertisedToolNames(requests[0]!)).toContain(ToolName.Read);
    });

    it('sends the same system prompt for the same skills in different directories', async () => {
        const firstDir = join(scratchDir(), 'skills');
        const secondDir = join(scratchDir(), 'skills');
        writeSkill(firstDir, REPORT_STYLE_SKILL);
        writeSkill(secondDir, REPORT_STYLE_SKILL);

        const first = await runScripted([verdictCall(VALID_PAYLOAD)], {
            skills: skillsOf(firstDir),
        });
        const second = await runScripted([verdictCall(VALID_PAYLOAD)], {
            skills: skillsOf(secondDir),
        });

        expect(systemPromptOf(first.requests[0]!)).toContain(
            logicalSkillFile(REPORT_STYLE_SKILL.name),
        );
        expect(systemPromptOf(second.requests[0]!)).toBe(systemPromptOf(first.requests[0]!));
    });

    it('returns a skill file to the model through read of its listed location', async () => {
        const skillsDir = join(scratchDir(), 'skills');
        writeSkill(skillsDir, REPORT_STYLE_SKILL);
        const turnCalls: string[][] = [];

        const { outcome, requests } = await runScripted(
            [readCall(logicalSkillFile(REPORT_STYLE_SKILL.name)), verdictCall(VALID_PAYLOAD)],
            {
                skills: skillsOf(skillsDir),
                onTurnEnd: (observation) => turnCalls.push(observation.toolCallNames),
            },
        );

        expect(outcome.kind).toBe(SealKind.Terminal);
        const toolMessages = requests[1]!.messages.filter((message) => message.role === 'tool');
        expect(JSON.stringify(toolMessages)).toContain(REPORT_STYLE_SKILL.body);
        expect(turnCalls[0]).toContain(ToolName.Read);
    });

    it('returns a refused read to the model and still seals', async () => {
        const root = scratchDir();
        const skillsDir = join(root, 'skills');
        writeSkill(skillsDir, REPORT_STYLE_SKILL);
        writeFileSync(join(root, 'AGENTS.md'), 'outside-instruction-marker', 'utf8');

        const { outcome, requests } = await runScripted(
            [readCall('../AGENTS.md'), verdictCall(VALID_PAYLOAD)],
            { skills: skillsOf(skillsDir) },
        );

        expect(outcome.kind).toBe(SealKind.Terminal);
        const toolMessages = requests[1]!.messages.filter((message) => message.role === 'tool');
        expect(JSON.stringify(toolMessages)).toContain(SKILLS_READ_OUTSIDE_MESSAGE);
        expect(JSON.stringify(toolMessages)).not.toContain('outside-instruction-marker');
    });

    it.each([
        {
            name: 'the directory is empty',
            plant: (skillsDir: string) => {
                mkdirSync(skillsDir, { recursive: true });
            },
        },
        {
            name: 'the only skill carries no description',
            plant: (skillsDir: string) => {
                writeSkill(skillsDir, {
                    name: REPORT_STYLE_SKILL.name,
                    body: REPORT_STYLE_SKILL.body,
                });
            },
        },
        {
            name: 'the only skill sets disable-model-invocation',
            plant: (skillsDir: string) => {
                writeSkill(skillsDir, { ...REPORT_STYLE_SKILL, disableModelInvocation: true });
            },
        },
    ])('keeps the prompt and tools of a run without skills when $name', async ({ plant }) => {
        const skillsDir = join(scratchDir(), 'skills');
        plant(skillsDir);

        const baseline = await runScripted([verdictCall(VALID_PAYLOAD)]);
        const withSkills = await runScripted([verdictCall(VALID_PAYLOAD)], {
            skills: skillsOf(skillsDir),
        });

        expect(systemPromptOf(withSkills.requests[0]!)).toBe(systemPromptOf(baseline.requests[0]!));
        expect(advertisedToolNames(withSkills.requests[0]!)).toEqual(
            advertisedToolNames(baseline.requests[0]!),
        );
    });

    it('skips a broken skill and lists the valid one', async () => {
        const skillsDir = join(scratchDir(), 'skills');
        writeSkill(skillsDir, REPORT_STYLE_SKILL);
        writeSkill(skillsDir, { name: 'broken-style', body: REPORT_STYLE_SKILL.body });

        const { requests } = await runScripted([verdictCall(VALID_PAYLOAD)], {
            skills: skillsOf(skillsDir),
        });

        const system = systemPromptOf(requests[0]!);
        expect(system).toContain(REPORT_STYLE_SKILL.name);
        expect(system).not.toContain('broken-style');
        expect(advertisedToolNames(requests[0]!)).toContain(ToolName.Read);
    });

    it("lists no skill from the session's own agent directory", async () => {
        const ownAgentSkills = join(scratchDir(), 'run');
        writeSkill(join(ownAgentSkills, PI_AGENT_DIR, 'skills'), {
            name: 'own-agent-skill',
            description: 'A skill planted where the default discovery would look.',
            body: REPORT_STYLE_SKILL.body,
        });
        const emptySkillsDir = join(scratchDir(), 'skills');
        mkdirSync(emptySkillsDir, { recursive: true });

        const baseline = await runScripted([verdictCall(VALID_PAYLOAD)]);
        const withSkills = await runScripted([verdictCall(VALID_PAYLOAD)], {
            skills: skillsOf(emptySkillsDir),
            workDir: ownAgentSkills,
        });

        expect(systemPromptOf(withSkills.requests[0]!)).toBe(systemPromptOf(baseline.requests[0]!));
        expect(advertisedToolNames(withSkills.requests[0]!)).toEqual(
            advertisedToolNames(baseline.requests[0]!),
        );
    });
});
