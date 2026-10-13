/**
 * The private directory one run of a blocker module works in: below the operating-system temp
 * directory, readable only by this user, and apart from every checkout and output the run already
 * holds, so nothing the blocker or the browser writes there lands in a published artifact on its
 * own. The one exception is explicit: when the issue ends, the module's `.log` files are copied,
 * redacted, into the issue's artifacts (`blocker-module-run-issue.ts`).
 */
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

/**
 * Prefix of every private workspace.
 */
const PRIVATE_WORKSPACE_PREFIX = 'filters-agent-blocker-';

/**
 * Determine whether candidate is a strict descendant of root.
 *
 * @param root - Canonical containment root.
 * @param candidate - Canonical candidate path.
 * @returns Whether candidate remains strictly below root.
 */
function isStrictPathDescendant(root: string, candidate: string): boolean {
    const child = relative(root, candidate);
    return (
        child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !child.startsWith(sep)
    );
}

/**
 * Reserve one mode-0700 private workspace below the canonical operating-system temp directory.
 *
 * @param forbiddenRoots - Existing repository, output, and publication roots to keep separate.
 * @returns Canonical fresh private workspace.
 */
export function reservePrivateWorkspace(forbiddenRoots: readonly string[]): string {
    const canonicalTemporaryRoot = realpathSync(tmpdir());
    const root = realpathSync(mkdtempSync(join(canonicalTemporaryRoot, PRIVATE_WORKSPACE_PREFIX)));
    try {
        chmodSync(root, 0o700);
        if (!isStrictPathDescendant(canonicalTemporaryRoot, root)) {
            throw new Error('The private workspace escaped the operating-system temp directory.');
        }
        for (const forbidden of forbiddenRoots) {
            const canonicalForbidden = realpathSync(forbidden);
            if (root === canonicalForbidden || isStrictPathDescendant(canonicalForbidden, root)) {
                throw new Error('The private workspace overlaps a repository or output root.');
            }
        }
        return root;
    } catch (error) {
        rmSync(root, { recursive: true, force: true });
        throw error;
    }
}
