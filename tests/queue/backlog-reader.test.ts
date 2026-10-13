import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    BacklogIssueReadError,
    BacklogIssueReadErrorCode,
    createGitHubBacklogIssueReader,
    type BacklogIssueSummary,
} from '../../src/queue/backlog-reader';

const mockListForRepo = vi.fn();
const mockGet = vi.fn();
const mockListComments = vi.fn();

vi.mock('@octokit/rest', () => ({
    Octokit: class {
        rest = {
            issues: {
                listForRepo: mockListForRepo,
                get: mockGet,
                listComments: mockListComments,
            },
        };
    },
}));

beforeEach(() => {
    vi.clearAllMocks();
});

const CONFIG = { owner: 'AdguardTeam', repo: 'AdguardFilters', token: 't' };

/**
 * Build Octokit-shaped transport failures like `RequestError` does.
 *
 * @param message - Error message text.
 * @param status - HTTP status riding the rejection.
 * @returns The rejection root.
 */
function transportError(message: string, status: number): Error {
    return Object.assign(new Error(message), { status, response: { data: { message } } });
}

/**
 * Build one valid listed issue item at the given position.
 *
 * @param issueNumber - Stable issue number.
 * @param overrides - Item fields to override.
 * @returns The item.
 */
function listedIssue(
    issueNumber: number,
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        number: issueNumber,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        user: { login: `reporter-${issueNumber}` },
        labels: [{ name: 'T: Ads' }],
        comments: 0,
        ...overrides,
    };
}

/**
 * Build one validated summary as the listing returns it, for the comment read to be driven with.
 *
 * @param issueNumber - Stable issue number.
 * @param commentCount - Comments GitHub listed on the issue.
 * @param reporterAuthor - Reporter login the listing carried.
 * @returns The summary.
 */
function listedSummary(
    issueNumber: number,
    commentCount: number,
    reporterAuthor = `reporter-${issueNumber}`,
): BacklogIssueSummary {
    return {
        issueNumber,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        labels: ['T: Ads'],
        reporterAuthor,
        commentCount,
    };
}

describe('readOpenIssuePage', () => {
    it('lists open issues newest first with the typed listForRepo params and maps items verbatim', async () => {
        mockListForRepo.mockResolvedValue({
            data: [
                listedIssue(11, { labels: [{ name: 'T: Ads' }, 'T: Registries'], comments: 4 }),
                listedIssue(10, { labels: [] }),
            ],
        });

        const reader = createGitHubBacklogIssueReader(CONFIG);
        const page = await reader.readOpenIssuePage(1);

        expect(page.summaries).toEqual([
            {
                issueNumber: 11,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-02T00:00:00.000Z',
                labels: ['T: Ads', 'T: Registries'],
                reporterAuthor: 'reporter-11',
                commentCount: 4,
            },
            {
                issueNumber: 10,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-02T00:00:00.000Z',
                labels: [],
                reporterAuthor: 'reporter-10',
                commentCount: 0,
            },
        ]);
        expect(page.hasMore).toBe(false);
        expect(mockListForRepo).toHaveBeenCalledWith(
            expect.objectContaining({
                owner: 'AdguardTeam',
                repo: 'AdguardFilters',
                state: 'open',
                sort: 'created',
                direction: 'desc',
                per_page: 100,
                page: 1,
            }),
        );
    });

    it('reports hasMore only for a full page and drops pull-request items', async () => {
        const fullPage = Array.from({ length: 100 }, (_, index) => listedIssue(1000 - index));
        fullPage[0] = listedIssue(1000, {
            pull_request: { url: 'https://api.github.com/repos/o/r/pulls/1000' },
        });
        const shortPage = [listedIssue(3), listedIssue(2), listedIssue(1)];
        mockListForRepo
            .mockImplementationOnce(() => Promise.resolve({ data: fullPage }))
            .mockImplementationOnce(() => Promise.resolve({ data: shortPage }));

        const reader = createGitHubBacklogIssueReader(CONFIG);
        const firstPage = await reader.readOpenIssuePage(1);
        const secondPage = await reader.readOpenIssuePage(2);

        expect(mockListForRepo).toHaveBeenCalledTimes(2);
        expect(mockListForRepo).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ page: 1, per_page: 100 }),
        );
        expect(mockListForRepo).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ page: 2, per_page: 100 }),
        );
        expect(firstPage.hasMore).toBe(true);
        expect(firstPage.summaries).toHaveLength(99);
        expect(firstPage.summaries.map((summary) => summary.issueNumber)).not.toContain(1000);
        expect(secondPage.hasMore).toBe(false);
        expect(secondPage.summaries.map((summary) => summary.issueNumber)).toEqual([3, 2, 1]);
    });

    it('fails invalid_response naming the offending item when a summary is malformed', async () => {
        const fakeLogger = { error: vi.fn() };
        mockListForRepo.mockResolvedValue({ data: [listedIssue(5, { created_at: 'yesterday' })] });

        const reader = createGitHubBacklogIssueReader(CONFIG, {
            logger: fakeLogger as never,
        });
        const error = await reader.readOpenIssuePage(1).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(BacklogIssueReadError);
        expect((error as BacklogIssueReadError).code).toBe(
            BacklogIssueReadErrorCode.InvalidResponse,
        );
        expect(fakeLogger.error).toHaveBeenCalledOnce();
        expect((error as BacklogIssueReadError).message).toContain('createdAt');
    });

    it('fails read_failed and logs the underlying cause with its HTTP status before mapping', async () => {
        const fakeLogger = { error: vi.fn() };
        mockListForRepo.mockRejectedValue(transportError('Server error', 503));

        const reader = createGitHubBacklogIssueReader(CONFIG, {
            logger: fakeLogger as never,
        });
        const error = await reader.readOpenIssuePage(1).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(BacklogIssueReadError);
        expect((error as BacklogIssueReadError).code).toBe(BacklogIssueReadErrorCode.ReadFailed);
        expect(fakeLogger.error).toHaveBeenCalledOnce();
        const logPayload = fakeLogger.error.mock.calls[0][0] as Record<string, unknown>;
        expect(logPayload.status).toBe(503);
        expect(logPayload.causeMessage).toContain('Server error');
        expect(logPayload.responseDetail).toContain('Server error');
    });
});

describe('readIssueHistory', () => {
    it('reads the comments page by page from the listed summary, driving no issue detail request', async () => {
        const firstPage = Array.from({ length: 100 }, (_, index) => ({
            user: { login: 'reporter' },
            body: `update ${index + 1}`,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-03T00:00:00.000Z',
            author_association: index === 0 ? 'OWNER' : 'NONE',
        }));
        const shortPage = [
            {
                user: { login: 'outsider' },
                body: 'The ad is still below the header.',
                created_at: '2026-01-05T00:00:00.000Z',
                updated_at: '2026-01-05T00:00:00.000Z',
                author_association: undefined,
            },
        ];
        mockListComments
            .mockImplementationOnce(() => Promise.resolve({ data: firstPage }))
            .mockImplementationOnce(() => Promise.resolve({ data: shortPage }));

        const summary = listedSummary(7, 101, 'original-reporter');
        const reader = createGitHubBacklogIssueReader(CONFIG);
        const history = await reader.readIssueHistory(summary);

        expect(mockGet).not.toHaveBeenCalled();
        expect(mockListComments).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ issue_number: 7, per_page: 100 }),
        );
        expect(mockListComments).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ issue_number: 7, per_page: 100, page: 2 }),
        );
        expect(history.summary).toEqual(summary);
        expect(history.comments).toHaveLength(101);
        expect(history.comments[0]).toEqual({
            author: 'reporter',
            body: 'update 1',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-03T00:00:00.000Z',
            authorAssociation: 'OWNER',
        });
        expect(history.comments.at(-1)).toEqual({
            author: 'outsider',
            body: 'The ad is still below the header.',
            createdAt: '2026-01-05T00:00:00.000Z',
            updatedAt: '2026-01-05T00:00:00.000Z',
            authorAssociation: null,
        });
    });

    it('spends no request on an issue the listing reported with no comments', async () => {
        const reader = createGitHubBacklogIssueReader(CONFIG);

        const history = await reader.readIssueHistory(listedSummary(4, 0));

        expect(mockGet).not.toHaveBeenCalled();
        expect(mockListComments).not.toHaveBeenCalled();
        expect(history).toEqual({ summary: listedSummary(4, 0), comments: [] });
    });

    it('fails read_failed and logs the underlying cause when the transport fails', async () => {
        const fakeLogger = { error: vi.fn() };
        mockListComments.mockRejectedValue(transportError('Bad credentials', 401));

        const reader = createGitHubBacklogIssueReader(CONFIG, {
            logger: fakeLogger as never,
        });
        const error = await reader
            .readIssueHistory(listedSummary(9, 1))
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(BacklogIssueReadError);
        expect((error as BacklogIssueReadError).code).toBe(BacklogIssueReadErrorCode.ReadFailed);
        const logPayload = fakeLogger.error.mock.calls[0][0] as Record<string, unknown>;
        expect(logPayload.status).toBe(401);
        expect(logPayload.causeMessage).toContain('Bad credentials');
    });
});

describe('createGitHubBacklogIssueReader injectable overrides', () => {
    it('drives the overridden transport with no Octokit construction', async () => {
        const overriddenListForRepo = vi
            .fn()
            .mockResolvedValue({ data: [listedIssue(21, { labels: [] })] });
        const overriddenIssues = {
            listForRepo: overriddenListForRepo,
            get: vi.fn(),
            listComments: vi.fn(),
        } as never;
        const reader = createGitHubBacklogIssueReader(
            { owner: 'o', repo: 'r', token: '' },
            { issues: overriddenIssues },
        );

        const page = await reader.readOpenIssuePage(1);

        expect(page).toEqual({
            summaries: [
                {
                    issueNumber: 21,
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                    labels: [],
                    reporterAuthor: 'reporter-21',
                    commentCount: 0,
                },
            ],
            hasMore: false,
        });
        expect(mockListForRepo).not.toHaveBeenCalled();
        expect(mockGet).not.toHaveBeenCalled();
        expect(mockListComments).not.toHaveBeenCalled();
    });
});
