import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
    UpstreamSourceDriftSchema,
    type UpstreamSourceDrift,
} from '../../../src/types/upstream-source-drift';
import type {
    FiltersCommand,
    FiltersCommandResult,
    FiltersCommandRunner,
} from '../../../src/local/filters-preparer';
import { observeUpstreamDrift } from '../../../lab/local/upstream-drift';

const PINNED_COMMIT = 'a'.repeat(40);
const MOVED_COMMIT = 'e'.repeat(40);
const REMOTE_URL = 'https://example.test/AdguardFilters.git';
const OBSERVED_AT = '2026-07-29T12:00:00.000Z';

/**
 * Build one successful command result.
 *
 * @param stdout - Captured standard output.
 * @returns Completed process result.
 */
function succeeded(stdout: string): FiltersCommandResult {
    return { exitCode: 0, stdout, stderr: '' };
}

/**
 * Observe upstream over a recording runner and prove the record is self-consistent.
 *
 * @param respond - Scripted reply to whatever command the observation runs.
 * @returns Drift record plus every command the observation issued.
 */
async function observe(
    respond: () => Promise<FiltersCommandResult>,
): Promise<{ drift: UpstreamSourceDrift; commands: FiltersCommand[] }> {
    const commands: FiltersCommand[] = [];
    const runner: FiltersCommandRunner = {
        run: async (command) => {
            commands.push(command);
            return respond();
        },
    };

    const drift = await observeUpstreamDrift({
        remoteUrl: REMOTE_URL,
        ref: 'master',
        pinnedCommit: PINNED_COMMIT,
        observedAt: OBSERVED_AT,
        runner,
    });

    expect(v.safeParse(UpstreamSourceDriftSchema, drift).success).toBe(true);
    return { drift, commands };
}

describe('observeUpstreamDrift', () => {
    it('records an upstream that moved past the pin as drift, and touches nothing to do it', async () => {
        const { drift, commands } = await observe(async () =>
            succeeded(`${MOVED_COMMIT}\trefs/heads/master\n`),
        );

        expect(drift).toEqual({
            status: 'upstream_ahead',
            pinnedCommit: PINNED_COMMIT,
            upstreamCommit: MOVED_COMMIT,
            observedAt: OBSERVED_AT,
        });
        // The load-bearing assertion. A fetch, or any command run inside the prepared checkout,
        // would import objects into the very snapshot whose immutability this run guarantees;
        // reading refs over the wire cannot.
        expect(commands).toEqual([
            { executable: 'git', args: ['ls-remote', REMOTE_URL, 'master'] },
        ]);
        expect(commands[0]!.cwd).toBeUndefined();
    });

    it('records an upstream still at the pinned commit as no drift', async () => {
        const { drift } = await observe(async () =>
            succeeded(`${PINNED_COMMIT.toUpperCase()}\trefs/heads/master\n`),
        );

        expect(drift).toEqual({
            status: 'in_sync',
            pinnedCommit: PINNED_COMMIT,
            upstreamCommit: PINNED_COMMIT,
            observedAt: OBSERVED_AT,
        });
    });

    it.each<{ name: string; respond: () => Promise<FiltersCommandResult> }>([
        {
            name: 'an upstream the runner cannot reach',
            respond: async () => {
                throw new Error('getaddrinfo ENOTFOUND example.test');
            },
        },
        {
            name: 'a remote that refuses the query',
            respond: async () => ({
                exitCode: 128,
                stdout: '',
                stderr: 'fatal: could not read Username',
            }),
        },
        {
            name: 'output that names no commit at all',
            respond: async () => succeeded('ref: refs/heads/master\n'),
        },
    ])('reports $name as unobserved rather than failing the run', async ({ respond }) => {
        const { drift } = await observe(respond);

        expect(drift).toEqual({
            status: 'unobserved',
            pinnedCommit: PINNED_COMMIT,
            upstreamCommit: null,
            observedAt: OBSERVED_AT,
        });
    });
});
