import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { SESSION_SKILLS_ROOT } from '../../src/pi/session-logical-paths';
import type { RecordedProviderRequest } from './hermetic-provider';

/**
 * The file name pi requires of a skill.
 */
export const SKILL_FILE_NAME = 'SKILL.md';

/**
 * One repository skill fixture written to disk.
 */
export interface SkillFixture {
    /**
     * Skill name written into the frontmatter and used as the skill's folder name.
     */
    name: string;

    /**
     * Skill description written into the frontmatter. Absent writes a skill pi rejects, which is
     * how a suite exercises the broken-skill path.
     */
    description?: string;

    /**
     * Writes `disable-model-invocation: true` into the frontmatter when set: pi loads such a skill
     * but never lists it to the model.
     */
    disableModelInvocation?: boolean;

    /**
     * Markdown body following the frontmatter.
     */
    body: string;
}

/**
 * The valid repository skill the suites write and look for: every suite that lists, reads or
 * forwards a skill uses this one, so its name, description and body are spelled once.
 */
export const REPORT_STYLE_SKILL = {
    name: 'report-style',
    description: 'How this repository writes its report.',
    body: 'Follow the repository report template.',
} satisfies SkillFixture;

/**
 * Write one skill as `<skillsDir>/<name>/SKILL.md`.
 *
 * @param skillsDir - Directory pi loads skills from.
 * @param skill - The skill to write.
 * @returns Absolute path of the written `SKILL.md`.
 */
export function writeSkill(skillsDir: string, skill: SkillFixture): string {
    const skillFile = join(skillsDir, skill.name, SKILL_FILE_NAME);
    mkdirSync(dirname(skillFile), { recursive: true });
    const frontmatter = ['---', `name: ${skill.name}`];
    if (skill.description !== undefined) {
        frontmatter.push(`description: ${skill.description}`);
    }
    if (skill.disableModelInvocation === true) {
        frontmatter.push('disable-model-invocation: true');
    }
    frontmatter.push('---');
    writeFileSync(skillFile, `${frontmatter.join('\n')}\n${skill.body}`, 'utf8');
    return skillFile;
}

/**
 * The location a session lists for one skill written by {@link writeSkill}: its `SKILL.md` under the
 * logical skills root, whatever real directory the skill was written to.
 *
 * @param name - The skill's name, which is also its folder name.
 * @returns The logical path of the skill's `SKILL.md`.
 */
export function logicalSkillFile(name: string): string {
    return posix.join(SESSION_SKILLS_ROOT, name, SKILL_FILE_NAME);
}

/**
 * One entry of a request's advertised tools array, as the OpenAI chat-completions body carries it.
 */
interface AdvertisedTool {
    /**
     * The function the tool advertises.
     */
    function: {
        /**
         * The tool name the model calls it by.
         */
        name: string;
    };
}

/**
 * The tool names one recorded request advertised to the model.
 *
 * @param request - The recorded provider request.
 * @returns The tool names, in advertisement order.
 */
export function advertisedToolNames(request: RecordedProviderRequest): string[] {
    return (request.tools as AdvertisedTool[]).map((tool) => tool.function.name);
}

/**
 * The system prompt one recorded request sent: the text of its first message.
 *
 * @param request - The recorded provider request.
 * @returns The system message content.
 */
export function systemPromptOf(request: RecordedProviderRequest): string {
    return String(request.messages[0]?.content);
}
