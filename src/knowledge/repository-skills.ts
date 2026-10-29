import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPOSITORY_AGENT_DIRECTORY } from './repository-agent-directory';

/**
 * Checkout-relative directory holding the repository's skills.
 *
 * Beside the default instruction and fixed: it is part of the repository's content, like
 * `AGENTS.md`, so an action input or a CLI option never points the run somewhere else.
 */
export const REPOSITORY_SKILLS_PATH = `${REPOSITORY_AGENT_DIRECTORY}/.agents/skills`;

/**
 * Resolve the repository's skills directory from a prepared checkout.
 *
 * The directory is passed to a session only when it exists: pi logs a diagnostic for a missing
 * skill path, and a repository without skills must produce no warning at all. A file where the
 * directory should be counts as absent for the same reason.
 *
 * @param checkoutRoot - Absolute root of the prepared checkout.
 * @returns The absolute skills directory, or undefined when the checkout has none.
 */
export function resolveRepositorySkillsDir(checkoutRoot: string): string | undefined {
    const skillsDir = resolve(checkoutRoot, REPOSITORY_SKILLS_PATH);
    const stats = statSync(skillsDir, { throwIfNoEntry: false });
    return stats?.isDirectory() === true ? skillsDir : undefined;
}
