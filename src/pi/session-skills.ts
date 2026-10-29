import type { LoadSkillsResult } from '@earendil-works/pi-coding-agent';
import { toLogicalSkillsPath } from './session-logical-paths';
import type { SessionToolSpec } from './session-tool-types';

/**
 * What one run's repository skills bring to its sessions: the directory pi loads them from and the
 * confined `read` tool that serves them.
 *
 * The read tool is built and wrapped by the caller — its description lives in the tool catalog and
 * its trace recording in the session layer, neither of which `src/pi` may import — so the runner
 * only decides whether pi loaded anything worth offering it for.
 */
export interface SessionSkills {
    /**
     * Absolute path of the existing skills directory pi loads.
     */
    dir: string;

    /**
     * The confined read tool, already wrapped by the caller for trace recording.
     */
    readTool: SessionToolSpec;
}

/**
 * Decide which tools a session's repository skills add.
 *
 * `read` is offered exactly when pi loaded at least one skill the model is shown — one whose
 * frontmatter does not set `disable-model-invocation: true`. Pi appends its skills block to the
 * system prompt only for such a skill and only while `read` is active, so a session without a
 * visible skill gets no read tool and no skills block. The skill diagnostics are not logged here:
 * every session reloads the directory, so `reportRepositorySkills` logs them once per issue run.
 *
 * @param loaded - What pi's resource loader reported for this session.
 * @param skills - The caller's skills directory and confined read tool, when the run carries one.
 * @returns The session tools the skills add, in advertisement order.
 */
export function skillSessionTools(
    loaded: LoadSkillsResult,
    skills: SessionSkills | undefined,
): SessionToolSpec[] {
    if (skills === undefined || loaded.skills.every((skill) => skill.disableModelInvocation)) {
        return [];
    }
    return [skills.readTool];
}

/**
 * Build pi's `skillsOverride` that lists one run's skills under the logical skills root.
 *
 * Each skill's `filePath` and `baseDir` move from the real directory to the same relative path
 * under `SESSION_SKILLS_ROOT`, so the skills block pi appends to the system prompt is the same for
 * every run with the same skills, wherever its checkout sits. The diagnostics keep their real
 * paths: they never reach the model, and `reportRepositorySkills` logs them for the operator. Pi
 * reads a skill's `filePath` itself only to expand a `/skill:<name>` prompt, which no session
 * sends.
 *
 * @param skillsDir - The real skills directory pi loads the skills from.
 * @returns The override pi applies to what it loaded.
 */
export function logicalSkillsOverride(
    skillsDir: string,
): (loaded: LoadSkillsResult) => LoadSkillsResult {
    return (loaded) => ({
        skills: loaded.skills.map((skill) => ({
            ...skill,
            filePath: toLogicalSkillsPath(skillsDir, skill.filePath),
            baseDir: toLogicalSkillsPath(skillsDir, skill.baseDir),
        })),
        diagnostics: loaded.diagnostics,
    });
}
