/**
 * The run-owned directory the host keeps its own blocker state in.
 *
 * A file-backed verification declares its target as a relative path (`read: managed-storage-file
 * filters-agent/ublock/user-filters.txt`), and that file is the host's state, not repository
 * content: between phases the host writes the candidate rule into it, reads it back, and a Firefox
 * launch carries its current content into managed storage. Resolving such a target against the
 * run's checkout puts that file inside the repository, where every later walk of the checkout reads
 * the run's own candidate back as repository content — the safety gate's duplicate scan rejects a
 * verified candidate as already present, and the verdict's recomputed hostname baseline drifts away
 * from the hash the apply-time context recorded, so the run loses its candidate. A directory
 * outside the checkout removes the question by construction: no checkout walk can reach it.
 *
 * Anchored at `os.tmpdir()`, like every other private directory a run creates for itself (browser
 * profiles, the Firefox launch home): it is the one writable place the GitHub container action,
 * other CI runners and a desktop run all agree on, and every run already depends on it for its
 * browser profiles.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Prefix of the per-run host-state directory, so a leftover directory in the OS temp root names the
 * agent that made it and the run it belonged to is recognizable in a post-mortem.
 */
const HOST_STATE_DIR_PREFIX = 'adguard-agent-host-state-';

/**
 * One run's host-state directory and the handle that removes it.
 */
export interface RunHostStateRoot {
    /**
     * Absolute path a relative declared verification target resolves against.
     */
    path: string;

    /**
     * Best-effort recursive removal; safe to call more than once and on a directory already gone.
     */
    dispose: () => void;
}

/**
 * Create the host-state directory for one run.
 *
 * @returns The directory path and its disposal handle.
 */
export function createRunHostStateRoot(): RunHostStateRoot {
    const path = mkdtempSync(join(tmpdir(), HOST_STATE_DIR_PREFIX));
    return {
        path,
        dispose: () => rmSync(path, { recursive: true, force: true }),
    };
}
