/**
 * The logical paths a session shows the model in place of the run's real directories.
 *
 * Whatever the session puts in its system prompt goes to the gateway on every request of every run,
 * so a per-run path there (an operator or CI directory, a fresh temporary checkout) would both leak
 * the host layout and change the cached prefix per run. These constants name the stable paths the
 * prompt carries instead, and the two mappings translate between a skill's real location and the
 * one the model sees. A leaf module, so the runner, the skills wiring and the confined read tool
 * share one spelling.
 */
import path from 'node:path';
import { isPathAtOrBelow } from '../types/path-containment';

/**
 * The logical working directory every session is rooted at, for pi's benefit only.
 *
 * Pi's agent-session constructor appends `\nCurrent working directory: <cwd>` to the system prompt
 * unconditionally, so whatever is passed here goes to the gateway on every request of every run.
 * The run's real artifacts directory must therefore never be it: it is an absolute operator or CI
 * path (`/…/collections/<uuid>/raw/artifacts`), which would both leak the host layout into the
 * prompt and change the cached prefix per run — a batch of fifty runs would share no prefix at all,
 * defeating the warm-replica cache reuse the session-affinity headers exist for. Together with
 * {@link SESSION_SKILLS_ROOT} for the skills block, this constant keeps the prefix byte-identical
 * for every run with the same prompt and the same skills. Nothing is read from or written under it:
 * session and settings managers are in memory, and pi only checks whether its default resource
 * folders exist there before the disabled discoveries drop them. The tools that do touch the
 * filesystem take the real directory from their own wiring.
 */
export const SESSION_LOGICAL_CWD = '/agent';

/**
 * The logical directory the session lists repository skills under.
 *
 * Pi lists each skill with its absolute `SKILL.md` path, and the skills directory sits in the run's
 * own checkout, a fresh temporary directory per run; listed as is, every run with skills would send
 * a different system prompt and miss the prompt cache on its first request. The session therefore
 * lists every skill at the same relative path under this root, and the confined read tool maps a
 * path under it back to the real directory. Below {@link SESSION_LOGICAL_CWD}, so it reads as part
 * of the workspace the CWD line names; nothing exists there on the host.
 */
export const SESSION_SKILLS_ROOT = path.posix.join(SESSION_LOGICAL_CWD, 'skills');

/**
 * Move a path from one root to another, keeping its place relative to the first.
 *
 * Lexical: neither side is resolved through symlinks, so a skill folder that is a symlink keeps the
 * path it has inside the directory.
 *
 * @param fromRoot - The root the path is expected under.
 * @param toRoot - The root it moves to.
 * @param target - The path to move.
 * @returns The moved path, or the target unchanged when it is not at or below `fromRoot`.
 */
function reRoot(fromRoot: string, toRoot: string, target: string): string {
    if (!isPathAtOrBelow(fromRoot, target)) {
        return target;
    }
    return path.join(toRoot, path.relative(fromRoot, target));
}

/**
 * The location the model sees for a path pi loaded from the skills directory.
 *
 * A path outside the directory stays as it is. Pi 0.84.1 builds every skill path by joining onto
 * the directory it was given, so none is outside; if one ever were, it would be listed under its
 * real path, and the read tool would still judge it by where it really points.
 *
 * @param skillsDir - The real skills directory pi was given.
 * @param realPath - A skill's `SKILL.md` or folder as pi reported it.
 * @returns The same relative path under {@link SESSION_SKILLS_ROOT}.
 */
export function toLogicalSkillsPath(skillsDir: string, realPath: string): string {
    return reRoot(skillsDir, SESSION_SKILLS_ROOT, realPath);
}

/**
 * The real path behind a path the model asked to read.
 *
 * A path at or below {@link SESSION_SKILLS_ROOT} maps to the same relative path in the real
 * directory; any other path is returned unchanged, so a real path inside the directory still reads
 * and everything else meets the read tool's confinement as it is.
 *
 * @param skillsDir - The real skills directory.
 * @param requestedPath - The absolute path pi's read tool resolved the call to.
 * @returns The path to read on the host.
 */
export function toRealSkillsPath(skillsDir: string, requestedPath: string): string {
    return reRoot(SESSION_SKILLS_ROOT, skillsDir, requestedPath);
}
