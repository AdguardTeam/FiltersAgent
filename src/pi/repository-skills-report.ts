import { loadSkills } from '@earendil-works/pi-coding-agent';
import type { Logger } from '../logger/logger';

/**
 * Log once per issue run what pi makes of the repository's skills directory.
 *
 * The directory is loaded exactly as every session's resource loader loads it — `loadSkills` with
 * no default locations and the one directory as its skill path — so the log describes what each
 * prompt carries. `cwd` and `agentDir` are both the directory itself: with defaults off pi reads
 * neither, and uses them only to label a skill's source when the path sits under
 * `<agentDir>/skills` or `<cwd>/.pi/skills`, which a directory never does under itself. Sessions
 * load the directory again each time; the report lives here, called once per issue run, so one
 * broken skill gives one warning per issue, not one per session.
 *
 * What the log carries:
 *
 * - Every pi diagnostic, at warn. Per pi 0.84.1 a missing description, malformed YAML frontmatter and
 *   the losing side of a name collision skip the skill; an invalid name and a description over 1024
 *   characters only warn, and the skill still loads. A collision also names the winning file, so
 *   the log says which `SKILL.md` was used.
 * - One warning per loaded skill whose frontmatter sets `disable-model-invocation: true`: pi loads it
 *   but never lists it to the model.
 * - One warning when no skill loaded at all, because pi skips some files without any diagnostic: a
 *   skill file spelled other than `SKILL.md`, a skill under a dot-folder, a dangling symlink.
 * - One info line with the count and names of the skills the model is shown.
 *
 * @param skillsDir - Absolute path of the existing skills directory the sessions load.
 * @param logger - The run logger.
 */
export function reportRepositorySkills(skillsDir: string, logger: Logger): void {
    const loaded = loadSkills({
        cwd: skillsDir,
        agentDir: skillsDir,
        skillPaths: [skillsDir],
        includeDefaults: false,
    });
    for (const diagnostic of loaded.diagnostics) {
        logger.warn(
            {
                path: diagnostic.path,
                type: diagnostic.type,
                message: diagnostic.message,
                ...(diagnostic.collision === undefined
                    ? {}
                    : { winnerPath: diagnostic.collision.winnerPath }),
            },
            'repository skill diagnostic',
        );
    }
    if (loaded.skills.length === 0) {
        logger.warn(
            { dir: skillsDir },
            'no repository skill loaded: a skill is <folder>/SKILL.md, spelled exactly so, ' +
                'and folders starting with a dot are skipped',
        );
    }
    for (const skill of loaded.skills) {
        if (skill.disableModelInvocation) {
            logger.warn(
                { path: skill.filePath, name: skill.name },
                'repository skill sets disable-model-invocation: true and is never shown to the model',
            );
        }
    }
    const shown = loaded.skills.filter((skill) => !skill.disableModelInvocation);
    logger.info(
        { count: shown.length, names: shown.map((skill) => skill.name) },
        'repository skills shown to the model',
    );
}
