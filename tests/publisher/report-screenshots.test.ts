import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import type { Logger } from '../../src/logger/logger';
import {
    hostReportScreenshots,
    renderHostedReportScreenshots,
    renderReportScreenshots,
} from '../../src/publisher/report-screenshots';

const INPUT = {
    owner: 'owner',
    repo: 'filters',
    issueNumber: 22,
    branch: 'agent-screenshots',
    before: Buffer.from('before-png'),
    after: Buffer.from('after-png'),
};

function httpError(status: number): Error & { status: number } {
    return Object.assign(new Error(`HTTP ${String(status)}`), { status });
}

function mockGit(overrides: Record<string, unknown> = {}): {
    octokit: Octokit;
    git: Record<string, ReturnType<typeof vi.fn>>;
} {
    const git = {
        createBlob: vi
            .fn()
            .mockResolvedValueOnce({ data: { sha: 'blob-before' } })
            .mockResolvedValueOnce({ data: { sha: 'blob-after' } }),
        getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'head-1' } } }),
        getCommit: vi.fn().mockResolvedValue({ data: { tree: { sha: 'tree-1' } } }),
        createTree: vi.fn().mockResolvedValue({ data: { sha: 'tree-2' } }),
        createCommit: vi.fn().mockResolvedValue({ data: { sha: 'commit-2' } }),
        createRef: vi.fn().mockResolvedValue({ data: {} }),
        updateRef: vi.fn().mockResolvedValue({ data: {} }),
        ...overrides,
    };
    return { octokit: { rest: { git } } as unknown as Octokit, git };
}

describe('hostReportScreenshots', () => {
    it('commits both images on top of the branch and links them by that commit', async () => {
        const { octokit, git } = mockGit();

        const hosted = await hostReportScreenshots(octokit, INPUT);

        expect(git.createTree).toHaveBeenCalledWith(
            expect.objectContaining({
                base_tree: 'tree-1',
                tree: [
                    expect.objectContaining({ path: 'issues/22/before.png', sha: 'blob-before' }),
                    expect.objectContaining({ path: 'issues/22/after.png', sha: 'blob-after' }),
                ],
            }),
        );
        expect(git.createCommit).toHaveBeenCalledWith(
            expect.objectContaining({ tree: 'tree-2', parents: ['head-1'] }),
        );
        // A `#22` in the message would put the commit on the issue's timeline.
        expect(git.createCommit.mock.calls[0]![0].message).not.toContain('#');
        expect(git.updateRef).toHaveBeenCalledWith(
            expect.objectContaining({
                ref: `heads/${INPUT.branch}`,
                sha: 'commit-2',
                force: false,
            }),
        );
        expect(hosted).toEqual({
            beforeUrl: 'https://github.com/owner/filters/raw/commit-2/issues/22/before.png',
            afterUrl: 'https://github.com/owner/filters/raw/commit-2/issues/22/after.png',
        });
    });

    it('creates the branch as a history of its own on the first upload', async () => {
        const { octokit, git } = mockGit({ getRef: vi.fn().mockRejectedValue(httpError(404)) });

        await hostReportScreenshots(octokit, INPUT);

        expect(git.createTree.mock.calls[0][0]).not.toHaveProperty('base_tree');
        expect(git.createCommit).toHaveBeenCalledWith(expect.objectContaining({ parents: [] }));
        expect(git.createRef).toHaveBeenCalledWith(
            expect.objectContaining({ ref: `refs/heads/${INPUT.branch}` }),
        );
        expect(git.updateRef).not.toHaveBeenCalled();
    });

    it('rebuilds the commit on the new head when a parallel run moved the branch', async () => {
        const { octokit, git } = mockGit({
            getRef: vi
                .fn()
                .mockResolvedValueOnce({ data: { object: { sha: 'head-1' } } })
                .mockResolvedValueOnce({ data: { object: { sha: 'head-2' } } }),
            updateRef: vi.fn().mockRejectedValueOnce(httpError(422)).mockResolvedValue({}),
        });

        await hostReportScreenshots(octokit, INPUT);

        expect(git.createCommit).toHaveBeenLastCalledWith(
            expect.objectContaining({ parents: ['head-2'] }),
        );
        expect(git.updateRef).toHaveBeenCalledTimes(2);
        expect(git.createBlob).toHaveBeenCalledTimes(2);
    });

    it('gives up after repeated lost races', async () => {
        const { octokit } = mockGit({ updateRef: vi.fn().mockRejectedValue(httpError(422)) });

        await expect(hostReportScreenshots(octokit, INPUT)).rejects.toThrow('HTTP 422');
    });
});

describe('renderHostedReportScreenshots', () => {
    it('renders the hosted pair as a collapsed side-by-side table', async () => {
        const { octokit } = mockGit();
        const logger = { warn: vi.fn() } as unknown as Logger;

        const fill = await renderHostedReportScreenshots(octokit, INPUT, logger);

        expect(fill).toBe(
            renderReportScreenshots({
                beforeUrl: 'https://github.com/owner/filters/raw/commit-2/issues/22/before.png',
                afterUrl: 'https://github.com/owner/filters/raw/commit-2/issues/22/after.png',
            }),
        );
        expect(fill).toContain('<details>');
        expect(fill).toContain('alt="Page without the rule"');
    });

    it('leaves the fill empty and names the permission when the token cannot write', async () => {
        const { octokit } = mockGit({ createBlob: vi.fn().mockRejectedValue(httpError(403)) });
        const warn = vi.fn();

        const fill = await renderHostedReportScreenshots(octokit, INPUT, {
            warn,
        } as unknown as Logger);

        expect(fill).toBe('');
        expect(warn.mock.calls[0][1]).toContain('contents: write');
    });

    it('propagates any other failure', async () => {
        const { octokit } = mockGit({ createBlob: vi.fn().mockRejectedValue(httpError(500)) });

        await expect(
            renderHostedReportScreenshots(octokit, INPUT, {
                warn: vi.fn(),
            } as unknown as Logger),
        ).rejects.toThrow('HTTP 500');
    });
});
