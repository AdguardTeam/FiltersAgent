import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchIssue } from '../../src/github/fetch-issue';
import { AUTOMATIC_UPSTREAM_PROMPT_TEXT_LIMITS } from '../../src/github/prompt-safety';

const mockGet = vi.fn();
const mockListComments = vi.fn();
const mockPaginate = vi.fn();

vi.mock('@octokit/rest', () => ({
    Octokit: class {
        paginate = mockPaginate;

        rest = {
            issues: {
                get: mockGet,
                listComments: mockListComments,
            },
        };
    },
}));

describe('fetchIssue', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockPaginate.mockImplementation(async (method, parameters) => {
            const response = await method(parameters);
            return response.data ?? [];
        });
    });

    it('calls issues.get and listComments with owner/repo/issue_number', async () => {
        mockGet.mockResolvedValue({
            data: {
                number: 42,
                title: 'Missed ad',
                html_url: 'https://github.com/AdguardTeam/AdguardFilters/issues/42',
                body: '### Issue URL (Ads)\n[https://x.example](r)\n',
                state: 'open',
                updated_at: '2026-07-23T10:02:00.000Z',
                user: { login: 'original-reporter' },
                labels: [{ name: 'T: Ads' }],
                assignee: { login: 'dev1' },
            },
        });
        mockListComments.mockResolvedValue({ data: [] });

        const raw = await fetchIssue(
            { owner: 'AdguardTeam', repo: 'AdguardFilters', token: 't' },
            42,
        );

        expect(mockGet).toHaveBeenCalledWith({
            owner: 'AdguardTeam',
            repo: 'AdguardFilters',
            issue_number: 42,
        });
        expect(mockListComments).toHaveBeenCalledWith({
            owner: 'AdguardTeam',
            repo: 'AdguardFilters',
            issue_number: 42,
            per_page: 100,
        });
        expect(mockPaginate).toHaveBeenCalledWith(mockListComments, {
            owner: 'AdguardTeam',
            repo: 'AdguardFilters',
            issue_number: 42,
            per_page: 100,
        });
        expect(raw.number).toBe(42);
        expect(raw.reporterAuthor).toBe('original-reporter');
        expect(raw.url).toBe('https://github.com/AdguardTeam/AdguardFilters/issues/42');
        expect(raw.labels).toEqual(['T: Ads']);
        expect(raw.assignee).toBe('dev1');
        expect(raw.updatedAt).toBe('2026-07-23T10:02:00.000Z');
        expect(raw.body).toContain('Issue URL (Ads)');
    });

    it('loads every issue-comment page before applying prompt filtering', async () => {
        mockGet.mockResolvedValue({
            data: {
                number: 43,
                title: 'Many reporter updates',
                html_url: 'https://github.com/AdguardTeam/AdguardFilters/issues/43',
                body: '',
                state: 'open',
                user: { login: 'reporter' },
                labels: [],
                assignee: null,
            },
        });
        mockPaginate.mockResolvedValue(
            Array.from({ length: 31 }, (_, index) => ({
                user: { login: 'reporter', type: 'User' },
                body: `Reporter update ${index + 1}`,
                created_at: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
            })),
        );

        const raw = await fetchIssue(
            { owner: 'AdguardTeam', repo: 'AdguardFilters', token: 't' },
            43,
        );

        expect(raw.comments).toHaveLength(31);
        expect(raw.comments.at(-1)?.body).toBe('Reporter update 31');
        expect(mockPaginate).toHaveBeenCalledOnce();
    });

    it('maps comments to { author, body, createdAt }', async () => {
        mockGet.mockResolvedValue({
            data: {
                number: 7,
                title: 't',
                html_url: 'https://github.com/AdguardTeam/AdguardFilters/issues/7',
                body: '',
                state: 'open',
                user: { login: 'alice' },
                labels: [],
                assignee: null,
            },
        });
        mockListComments.mockResolvedValue({
            data: [
                {
                    user: { login: 'alice' },
                    body: 'hi',
                    created_at: '2026-01-01T00:00:00Z',
                },
            ],
        });

        const raw = await fetchIssue({ owner: 'o', repo: 'r', token: 't' }, 7);

        expect(raw.comments).toEqual([
            { author: 'alice', body: 'hi', createdAt: '2026-01-01T00:00:00Z' },
        ]);
    });

    it('exposes only non-solution comments from the immutable issue reporter', async () => {
        mockGet.mockResolvedValue({
            data: {
                number: 10,
                title: 't',
                html_url: 'https://github.com/o/r/issues/10',
                body: 'Original report remains prompt-visible.',
                state: 'open',
                user: { login: 'reporter' },
                labels: [],
                assignee: null,
            },
        });
        mockListComments.mockResolvedValue({
            data: [
                {
                    user: { login: 'reporter', type: 'User' },
                    body: 'The ad is still visible below the header.',
                    created_at: '2026-01-01T00:00:00Z',
                },
                {
                    user: { login: 'maintainer', type: 'User' },
                    body: 'Try disabling another filter.',
                    created_at: '2026-01-02T00:00:00Z',
                },
                {
                    user: { login: 'reporter', type: 'User' },
                    body: 'Fixed with example.test##.human-gold',
                    created_at: '2026-01-03T00:00:00Z',
                },
            ],
        });

        const promptSafe = await fetchIssue({ owner: 'o', repo: 'r', token: 't' }, 10);
        const raw = await fetchIssue({ owner: 'o', repo: 'r', token: 't' }, 10, {
            preserveGeneratedComments: true,
        });

        expect(promptSafe.body).toContain('Original report');
        expect(promptSafe.comments).toEqual([
            {
                author: 'reporter',
                body: 'The ad is still visible below the header.',
                createdAt: '2026-01-01T00:00:00Z',
            },
        ]);
        expect(raw.comments).toHaveLength(3);
        expect(JSON.stringify(raw.comments)).toContain('human-gold');
    });

    it('admits a trusted-association comment beside the reporter, the same set backlog selection trusts', async () => {
        mockGet.mockResolvedValue({
            data: {
                number: 11,
                title: 't',
                html_url: 'https://github.com/o/r/issues/11',
                body: 'Original report remains prompt-visible.',
                state: 'open',
                user: { login: 'reporter' },
                labels: [],
                assignee: null,
            },
        });
        mockListComments.mockResolvedValue({
            data: [
                {
                    user: { login: 'reporter', type: 'User' },
                    body: 'The ad is still visible below the header.',
                    created_at: '2026-01-01T00:00:00Z',
                    author_association: 'NONE',
                },
                {
                    user: { login: 'maintainer', type: 'User' },
                    body: 'Only reproduces on /page2, per our triage.',
                    created_at: '2026-01-02T00:00:00Z',
                    author_association: 'MEMBER',
                },
                {
                    user: { login: 'drive-by-user', type: 'User' },
                    body: 'Same problem here.',
                    created_at: '2026-01-03T00:00:00Z',
                    author_association: 'NONE',
                },
            ],
        });

        const raw = await fetchIssue({ owner: 'o', repo: 'r', token: 't' }, 11);

        expect(raw.comments.map((comment) => comment.author)).toEqual(['reporter', 'maintainer']);
        expect(raw.comments[1]?.body).toBe('Only reproduces on /page2, per our triage.');
    });

    it('honors a caller-supplied trustedRoles override, excluding an association outside it', async () => {
        mockGet.mockResolvedValue({
            data: {
                number: 12,
                title: 't',
                html_url: 'https://github.com/o/r/issues/12',
                body: 'Original report remains prompt-visible.',
                state: 'open',
                user: { login: 'reporter' },
                labels: [],
                assignee: null,
            },
        });
        mockListComments.mockResolvedValue({
            data: [
                {
                    user: { login: 'reporter', type: 'User' },
                    body: 'The ad is still visible below the header.',
                    created_at: '2026-01-01T00:00:00Z',
                    author_association: 'NONE',
                },
                {
                    user: { login: 'a-collaborator', type: 'User' },
                    body: 'Only reproduces on /page2, per our triage.',
                    created_at: '2026-01-02T00:00:00Z',
                    author_association: 'COLLABORATOR',
                },
            ],
        });

        // With the default policy, a COLLABORATOR comment is admitted (mirrors the MEMBER case
        // above). With a caller-resolved policy naming OWNER alone, the same comment must be
        // excluded — the whole point of threading the resolved policy through instead of the
        // hardcoded default.
        const withDefaultPolicy = await fetchIssue({ owner: 'o', repo: 'r', token: 't' }, 12);
        const withOwnerOnlyPolicy = await fetchIssue({ owner: 'o', repo: 'r', token: 't' }, 12, {
            trustedRoles: ['OWNER'],
        });

        expect(withDefaultPolicy.comments.map((comment) => comment.author)).toEqual([
            'reporter',
            'a-collaborator',
        ]);
        expect(withOwnerOnlyPolicy.comments.map((comment) => comment.author)).toEqual(['reporter']);
    });

    it('excludes generated issue summaries from the agent input', async () => {
        mockGet.mockResolvedValue({
            data: {
                number: 8,
                title: 't',
                html_url: 'https://github.com/o/r/issues/8',
                body: '',
                state: 'open',
                user: { login: 'alice' },
                labels: [],
                assignee: null,
            },
        });
        mockListComments.mockResolvedValue({
            data: [
                {
                    user: { login: 'github-actions[bot]', type: 'Bot' },
                    body: '<!-- adguard-filters-agent:issue-summary -->\nGold comparison: exact',
                    created_at: '2026-01-02T00:00:00Z',
                },
                {
                    user: { login: 'alice' },
                    body: 'Independent reporter context',
                    created_at: '2026-01-01T00:00:00Z',
                },
            ],
        });

        const raw = await fetchIssue({ owner: 'o', repo: 'r', token: 't' }, 8);

        expect(raw.comments).toEqual([
            {
                author: 'alice',
                body: 'Independent reporter context',
                createdAt: '2026-01-01T00:00:00Z',
            },
        ]);
    });

    it('preserves generated summaries when exporting an auditable raw snapshot', async () => {
        mockGet.mockResolvedValue({
            data: {
                number: 8,
                title: 't',
                html_url: 'https://github.com/o/r/issues/8',
                body: '',
                state: 'open',
                user: { login: 'reporter' },
                labels: [],
                assignee: null,
            },
        });
        mockListComments.mockResolvedValue({
            data: [
                {
                    user: { login: 'github-actions[bot]', type: 'Bot' },
                    body: '<!-- adguard-filters-agent:issue-summary -->\nPrior agent output',
                    created_at: '2026-01-02T00:00:00Z',
                },
            ],
        });

        const raw = await fetchIssue({ owner: 'o', repo: 'r', token: 't' }, 8, {
            preserveGeneratedComments: true,
        });

        expect(raw.comments).toEqual([
            {
                author: 'github-actions[bot]',
                body: '<!-- adguard-filters-agent:issue-summary -->\nPrior agent output',
                createdAt: '2026-01-02T00:00:00Z',
            },
        ]);
    });

    it('withholds bot and marked human-reference comments without changing raw export', async () => {
        mockGet.mockResolvedValue({
            data: {
                number: 8,
                title: 't',
                html_url: 'https://github.com/o/r/issues/8',
                body: '',
                state: 'open',
                user: { login: 'reporter' },
                labels: [],
                assignee: null,
            },
        });
        mockListComments.mockResolvedValue({
            data: [
                {
                    user: { login: 'triage-automation', type: 'Bot' },
                    body: 'Automated triage output without an agent-summary marker.',
                    created_at: '2026-01-01T00:00:00Z',
                },
                {
                    user: { login: 'maintainer', type: 'User' },
                    body:
                        '<!-- adguard-filters-agent:human-solution -->\n' +
                        'example.test##.human-fix',
                    created_at: '2026-01-02T00:00:00Z',
                },
                {
                    user: { login: 'reviewer', type: 'User' },
                    body:
                        '<!-- adguard-filters-agent:human-reference -->\n' +
                        'Human commit: deadbeef',
                    created_at: '2026-01-03T00:00:00Z',
                },
                {
                    user: { login: 'reporter', type: 'User' },
                    body: 'The ad remains below the header.',
                    created_at: '2026-01-04T00:00:00Z',
                },
            ],
        });

        const promptSafe = await fetchIssue({ owner: 'o', repo: 'r', token: 't' }, 8);
        const raw = await fetchIssue({ owner: 'o', repo: 'r', token: 't' }, 8, {
            preserveGeneratedComments: true,
        });

        expect(promptSafe.comments).toEqual([
            {
                author: 'reporter',
                body: 'The ad remains below the header.',
                createdAt: '2026-01-04T00:00:00Z',
            },
        ]);
        expect(raw.comments).toHaveLength(4);
        expect(raw.comments[0]?.author).toBe('triage-automation');
        expect(JSON.stringify(raw.comments)).toContain('example.test##.human-fix');
        expect(JSON.stringify(raw.comments)).toContain('Human commit: deadbeef');
    });

    it('withholds the comments of a configured report bot even on an issue it filed', async () => {
        mockGet.mockResolvedValue({
            data: {
                number: 9,
                title: 't',
                html_url: 'https://github.com/o/r/issues/9',
                body: 'Relayed report',
                state: 'open',
                user: { login: 'reporting-bot', type: 'User' },
                labels: [],
                assignee: null,
            },
        });
        mockListComments.mockResolvedValue({
            data: [
                {
                    user: { login: 'Reporting-Bot', type: 'User' },
                    body: 'This issue has been automatically marked as stale.',
                    created_at: '2026-01-01T00:00:00Z',
                    author_association: 'MEMBER',
                },
            ],
        });

        const unconfigured = await fetchIssue({ owner: 'o', repo: 'r', token: 't' }, 9);
        const configured = await fetchIssue({ owner: 'o', repo: 'r', token: 't' }, 9, {
            reportBots: ['reporting-bot'],
        });

        expect(unconfigured.comments).toHaveLength(1);
        expect(configured.comments).toEqual([]);
    });

    it('withholds a generated-summary marker even when reporter prose quotes it', async () => {
        mockGet.mockResolvedValue({
            data: {
                number: 8,
                title: 't',
                html_url: 'https://github.com/o/r/issues/8',
                body: '',
                state: 'open',
                user: { login: 'alice' },
                labels: [],
                assignee: null,
            },
        });
        mockListComments.mockResolvedValue({
            data: [
                {
                    user: { login: 'alice', type: 'User' },
                    body:
                        'The previous report contained ' +
                        '<!-- adguard-filters-agent:issue-summary --> in its text.',
                    created_at: '2026-01-01T00:00:00Z',
                },
            ],
        });

        const raw = await fetchIssue({ owner: 'o', repo: 'r', token: 't' }, 8);

        expect(raw.comments).toEqual([]);
    });

    it('strips benchmark metadata from normal agent input', async () => {
        const filtersBaseSha = '0123456789abcdef0123456789abcdef01234567';
        const humanFixCommit = '89abcdef0123456789abcdef0123456789abcdef';
        mockGet.mockResolvedValue({
            data: {
                number: 9,
                title: 't',
                html_url: 'https://github.com/o/r/issues/9',
                body:
                    'Reporter body\n' +
                    `<!-- adguard-agent-benchmark: {"filtersBaseSha":"${filtersBaseSha}","humanFixCommit":"${humanFixCommit}"} -->\n` +
                    '<!-- adguard-filters-agent:upstream-mirror {"schemaVersion":1} -->',
                state: 'open',
                labels: [],
                assignee: null,
            },
        });
        mockListComments.mockResolvedValue({ data: [] });

        const promptSafe = await fetchIssue({ owner: 'o', repo: 'r', token: 't' }, 9);
        const raw = await fetchIssue({ owner: 'o', repo: 'r', token: 't' }, 9, {
            preserveBenchmarkMetadata: true,
        });

        expect(promptSafe.body).toBe('Reporter body');
        expect(raw.body).toContain(filtersBaseSha);
        expect(raw.body).toContain(humanFixCommit);
        expect(raw.body).toContain('upstream-mirror');
    });

    it('rejects pull requests returned by the issues endpoint', async () => {
        mockGet.mockResolvedValue({
            data: {
                number: 2,
                title: 'Draft benchmark result',
                html_url: 'https://github.com/o/r/pull/2',
                body: 'Post-run human comparison',
                state: 'open',
                labels: [],
                assignee: null,
                pull_request: { url: 'https://api.github.com/repos/o/r/pulls/2' },
            },
        });

        await expect(fetchIssue({ owner: 'o', repo: 'r', token: 't' }, 2)).rejects.toThrow(
            'refers to a pull request',
        );
        expect(mockListComments).not.toHaveBeenCalled();
    });

    it('throws a clear error when issues.get fails', async () => {
        mockGet.mockRejectedValue(new Error('404 Not Found'));

        await expect(fetchIssue({ owner: 'o', repo: 'r', token: 't' }, 999)).rejects.toThrow(
            /fetch issue 999/,
        );
    });

    it('stops bounded live comment collection on the page crossing the raw limits', async () => {
        mockGet.mockResolvedValue({
            data: {
                number: 55,
                title: 'Bounded live issue',
                html_url: 'https://github.com/o/r/issues/55',
                body: 'body',
                state: 'open',
                updated_at: '2026-07-23T10:02:00.000Z',
                user: { login: 'reporter' },
                labels: [],
                assignee: null,
            },
        });
        mockListComments
            .mockResolvedValueOnce({
                data: Array.from({ length: 100 }, (_, index) => ({
                    user: { login: 'reporter', type: 'User' },
                    body: 'a'.repeat(2_000),
                    created_at: `2026-01-01T00:${String(index % 60).padStart(2, '0')}:00Z`,
                })),
            })
            .mockResolvedValueOnce({
                data: Array.from({ length: 100 }, (_, index) => ({
                    user: { login: 'reporter', type: 'User' },
                    body: 'b'.repeat(1_000),
                    created_at: `2026-01-02T00:${String(index % 60).padStart(2, '0')}:00Z`,
                })),
            });

        await expect(
            fetchIssue({ owner: 'o', repo: 'r', token: 'secret' }, 55, {
                preserveGeneratedComments: true,
                preserveBenchmarkMetadata: true,
                promptTextLimits: AUTOMATIC_UPSTREAM_PROMPT_TEXT_LIMITS,
                maxRawCommentCount: 1_000,
            }),
        ).rejects.toThrow(/256000|raw prompt/i);
        expect(mockListComments).toHaveBeenCalledTimes(2);
        expect(mockPaginate).not.toHaveBeenCalled();
    });
});
