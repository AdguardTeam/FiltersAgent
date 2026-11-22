import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import type { Logger } from '../../src/logger/logger';
import { AttachmentUploadStep } from '../../src/publisher/report-screenshot-attachments';
import {
    hostReportScreenshots,
    renderHostedReportScreenshots,
    renderReportScreenshots,
    ScreenshotsStorage,
} from '../../src/publisher/report-screenshots';

const BEFORE_URL =
    'https://github.com/user-attachments/assets/11111111-1111-4111-8111-111111111111';
const AFTER_URL = 'https://github.com/user-attachments/assets/22222222-2222-4222-8222-222222222222';
const REPOSITORY_ID = 4_242;

const BRANCH = 'agent-screenshots';

const PAIR = {
    owner: 'owner',
    repo: 'filters',
    issueNumber: 22,
    before: Buffer.from('before-png'),
    after: Buffer.from('after-png'),
};

const INPUT = { ...PAIR, target: { storage: ScreenshotsStorage.Branch, branch: BRANCH } };

const ATTACHMENTS_INPUT = { ...PAIR, target: { storage: ScreenshotsStorage.Attachments } };

function httpError(status: number): Error & { status: number } {
    return Object.assign(new Error(`HTTP ${String(status)}`), { status });
}

function mockGit(overrides: Record<string, unknown> = {}): {
    octokit: Octokit;
    git: Record<string, ReturnType<typeof vi.fn>>;
    repos: { get: ReturnType<typeof vi.fn> };
    request: ReturnType<typeof vi.fn>;
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
    const repos = { get: vi.fn().mockResolvedValue({ data: { id: REPOSITORY_ID } }) };
    const request = vi
        .fn()
        .mockResolvedValueOnce({ data: { url: BEFORE_URL } })
        .mockResolvedValueOnce({ data: { url: AFTER_URL } });
    return {
        octokit: { rest: { git, repos }, request } as unknown as Octokit,
        git,
        repos,
        request,
    };
}

describe('hostReportScreenshots', () => {
    it('commits both images on top of the branch and links them by that commit', async () => {
        const { octokit, git } = mockGit();

        const hosted = await hostReportScreenshots(octokit, PAIR, BRANCH);

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
                ref: `heads/${BRANCH}`,
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

        await hostReportScreenshots(octokit, PAIR, BRANCH);

        expect(git.createTree.mock.calls[0][0]).not.toHaveProperty('base_tree');
        expect(git.createCommit).toHaveBeenCalledWith(expect.objectContaining({ parents: [] }));
        expect(git.createRef).toHaveBeenCalledWith(
            expect.objectContaining({ ref: `refs/heads/${BRANCH}` }),
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

        await hostReportScreenshots(octokit, PAIR, BRANCH);

        expect(git.createCommit).toHaveBeenLastCalledWith(
            expect.objectContaining({ parents: ['head-2'] }),
        );
        expect(git.updateRef).toHaveBeenCalledTimes(2);
        expect(git.createBlob).toHaveBeenCalledTimes(2);
    });

    it('gives up after repeated lost races', async () => {
        const { octokit } = mockGit({ updateRef: vi.fn().mockRejectedValue(httpError(422)) });

        await expect(hostReportScreenshots(octokit, PAIR, BRANCH)).rejects.toThrow('HTTP 422');
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

    it('commits to the branch and makes no upload request under the branch storage', async () => {
        const { octokit, request } = mockGit();

        const fill = await renderHostedReportScreenshots(octokit, INPUT, {
            warn: vi.fn(),
        } as unknown as Logger);

        expect(fill).toContain(
            'https://github.com/owner/filters/raw/commit-2/issues/22/before.png',
        );
        expect(request).not.toHaveBeenCalled();
    });

    it('links the uploaded attachments and writes nothing to git under the attachments storage', async () => {
        const { octokit, git } = mockGit();

        const fill = await renderHostedReportScreenshots(octokit, ATTACHMENTS_INPUT, {
            warn: vi.fn(),
        } as unknown as Logger);

        expect(fill).toBe(renderReportScreenshots({ beforeUrl: BEFORE_URL, afterUrl: AFTER_URL }));
        for (const method of Object.values(git)) {
            expect(method).not.toHaveBeenCalled();
        }
    });
});

/**
 * One scripted transport failure of the attachments storage.
 */
interface AttachmentFailureCase {
    /**
     * Scenario name the test title carries.
     */
    name: string;

    /**
     * Scripts the transport spies before the hosting call.
     *
     * @param spies - The repository-id and upload spies the client will drive.
     */
    script: (spies: {
        request: ReturnType<typeof vi.fn>;
        repos: { get: ReturnType<typeof vi.fn> };
    }) => void;

    /**
     * Text the warning's `failure` field carries.
     */
    failure: string;

    /**
     * Status the warning carries; absent when the failure has none.
     */
    status?: number;

    /**
     * Whether the warning carries a stack, as it does for an `Error`.
     */
    hasStack: boolean;

    /**
     * The request the warning names as failed.
     */
    step: AttachmentUploadStep;

    /**
     * Whether the warning says what the token needs: only a status that refuses the token does.
     */
    namesToken: boolean;
}

const ATTACHMENT_FAILURE_CASES: readonly AttachmentFailureCase[] = [
    {
        name: 'an upload is refused with 404',
        script: ({ request }) => {
            request
                .mockResolvedValueOnce({ data: { url: BEFORE_URL } })
                .mockRejectedValueOnce(httpError(404));
        },
        failure: 'HTTP 404',
        status: 404,
        hasStack: true,
        step: AttachmentUploadStep.AfterUpload,
        namesToken: true,
    },
    {
        name: 'the second upload fails with 422 after the first succeeded',
        script: ({ request }) => {
            request
                .mockResolvedValueOnce({ data: { url: BEFORE_URL } })
                .mockRejectedValueOnce(httpError(422));
        },
        failure: 'HTTP 422',
        status: 422,
        hasStack: true,
        step: AttachmentUploadStep.AfterUpload,
        namesToken: false,
    },
    {
        name: 'the repository id read fails',
        script: ({ repos }) => {
            repos.get.mockRejectedValue(httpError(500));
        },
        failure: 'HTTP 500',
        status: 500,
        hasStack: true,
        step: AttachmentUploadStep.RepositoryRead,
        namesToken: false,
    },
    {
        name: 'an Error without a status',
        script: ({ request }) => {
            request.mockRejectedValue(new Error('socket hang up'));
        },
        failure: 'socket hang up',
        hasStack: true,
        step: AttachmentUploadStep.BeforeUpload,
        namesToken: false,
    },
    {
        name: 'a thrown string',
        script: ({ request }) => {
            request.mockRejectedValue('upload unavailable');
        },
        failure: 'upload unavailable',
        hasStack: false,
        step: AttachmentUploadStep.BeforeUpload,
        namesToken: false,
    },
    {
        name: 'a thrown null',
        script: ({ request }) => {
            request.mockRejectedValue(null);
        },
        failure: 'null',
        hasStack: false,
        step: AttachmentUploadStep.BeforeUpload,
        namesToken: false,
    },
];

describe('renderHostedReportScreenshots under the attachments storage', () => {
    it.each(ATTACHMENT_FAILURE_CASES)('posts without screenshots when $name', async (testCase) => {
        const { octokit, git, request, repos } = mockGit();
        request.mockReset();
        testCase.script({ request, repos });
        const warn = vi.fn();

        const fill = await renderHostedReportScreenshots(octokit, ATTACHMENTS_INPUT, {
            warn,
        } as unknown as Logger);

        expect(fill).toBe('');
        for (const method of Object.values(git)) {
            expect(method).not.toHaveBeenCalled();
        }
        expect(warn).toHaveBeenCalledTimes(1);
        const [fields, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
        expect(fields).toMatchObject({ issueNumber: 22, failure: testCase.failure });
        expect(fields).not.toHaveProperty('err');
        if (testCase.status === undefined) {
            expect(fields).not.toHaveProperty('status');
        } else {
            expect(fields.status).toBe(testCase.status);
        }
        if (testCase.hasStack) {
            expect(typeof fields.stack).toBe('string');
        } else {
            expect(fields).not.toHaveProperty('stack');
        }
        expect(fields.step).toBe(testCase.step);
        expect(message.includes('GITHUB_USER_TOKEN')).toBe(testCase.namesToken);
        expect(message.includes('githubUserToken')).toBe(testCase.namesToken);
    });
});
