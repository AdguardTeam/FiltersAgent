import type { UpstreamSourceDrift } from '../../src/types/upstream-source-drift';
import type { FiltersCommandRunner } from '../../src/local/filters-preparer';

/**
 * Everything one read-only upstream observation needs.
 */
export interface UpstreamDriftObservationRequest {
    /**
     * Configured filters remote to read refs from.
     */
    remoteUrl: string;

    /**
     * Configured branch or ref whose head is compared against the pin.
     */
    ref: string;

    /**
     * Exact commit this run is bound to for every source operation.
     */
    pinnedCommit: string;

    /**
     * Host clock value the observation is recorded at.
     */
    observedAt: string;

    /**
     * Subprocess adapter used to issue the ref query.
     */
    runner: FiltersCommandRunner;
}

/**
 * Read the commit one `ls-remote` line names, when it names one at all.
 *
 * @param stdout - Captured ref-query output.
 * @returns Lowercased 40-hex commit, or null when the output names none.
 */
export function parseUpstreamCommit(stdout: string): string | null {
    const firstLine = stdout.split(/\r?\n/u).find((line) => line.trim() !== '');
    const firstField = firstLine?.split(/\s+/u)[0] ?? '';
    return /^[0-9a-f]{40}$/iu.test(firstField) ? firstField.toLowerCase() : null;
}

/**
 * Observe where upstream stands now without disturbing the commit this run is bound to.
 *
 * The probe is `git ls-remote`, which reads refs over the wire and writes no object, ref, index, or
 * worktree — so an upstream that moved mid-run can be reported as external drift while every source
 * operation continues against the original pinned commit. An unreachable, slow, or unparsable
 * upstream is `unobserved` rather than a failure: this is a reported fact, never a gate.
 *
 * @param request - Configured remote and ref, the pinned commit, a clock value, and the runner.
 * @returns Finite drift record naming only two commits and a status.
 */
export async function observeUpstreamDrift(
    request: UpstreamDriftObservationRequest,
): Promise<UpstreamSourceDrift> {
    // Both commits are compared and published in one case, so a record this observer emits can
    // never contradict its own status.
    const pinnedCommit = request.pinnedCommit.toLowerCase();
    const unobserved: UpstreamSourceDrift = {
        status: 'unobserved',
        pinnedCommit,
        upstreamCommit: null,
        observedAt: request.observedAt,
    };

    let upstreamCommit: string | null;
    try {
        const result = await request.runner.run({
            executable: 'git',
            args: ['ls-remote', request.remoteUrl, request.ref],
        });
        upstreamCommit = result.exitCode === 0 ? parseUpstreamCommit(result.stdout) : null;
    } catch {
        // An offline operator and a malformed answer are one published fact. The native error
        // belongs in the local transcript, not in a serialized field.
        return unobserved;
    }
    if (upstreamCommit === null) {
        return unobserved;
    }

    return {
        status: upstreamCommit === pinnedCommit ? 'in_sync' : 'upstream_ahead',
        pinnedCommit,
        upstreamCommit,
        observedAt: request.observedAt,
    };
}
