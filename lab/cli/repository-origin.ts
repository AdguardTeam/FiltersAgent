import { spawnSync } from 'node:child_process';
import { REPOSITORY_PATH_VAR } from '../../src/config/repository-identity';

/**
 * Reads the origin URL of the git checkout at the given path. Null-tolerant by contract: a checkout
 * with no origin remote, a non-git directory, or an unavailable `git` executable simply has no
 * origin to read — the repository identity may come from another source, so those cases return
 * `null` and never throw.
 */
export type GitCheckoutOriginReader = (repositoryPath: string) => string | null;

/**
 * Read the origin URL by spawning `git remote get-url origin` in the checkout. The child's stderr
 * is dropped, not leaked: a failed read is a normal, expected outcome of this probe.
 *
 * @param repositoryPath - Absolute path to the checkout.
 * @returns The origin URL, or `null` when the read fails.
 */
export function readGitCheckoutOrigin(repositoryPath: string): string | null {
    const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
        cwd: repositoryPath,
        encoding: 'utf8',
    });
    if (result.error || result.status !== 0) {
        return null;
    }
    const url = result.stdout?.trim();
    return url ? url : null;
}

/**
 * Resolve the checkout-origin URL for one command run: the checkout path comes from the frozen
 * environment, and the git adapter is injectable for tests.
 *
 * @param env - Frozen environment projection.
 * @param reader - The git adapter; production spawns `git remote get-url origin`.
 * @returns The origin URL, or `null` when no checkout path is set or the adapter cannot read one.
 */
export function readCheckoutOriginUrl(
    env: Readonly<Record<string, string | undefined>>,
    reader: GitCheckoutOriginReader = readGitCheckoutOrigin,
): string | null {
    const repositoryPath = env[REPOSITORY_PATH_VAR];
    if (!repositoryPath) {
        return null;
    }
    return reader(repositoryPath);
}
