import { describe, expect, it, vi } from 'vitest';
import { createOctokit } from '../../../src/github/fetch-issue';
import {
    inspectHistoricalCaseMetadata,
    resolveAutobuildTagCommit,
} from '../../../lab/e2e/historical-case-metadata';

const HUMAN_COMMIT = 'f'.repeat(40);
const FILTERS_BASE_SHA = '203b5312920118056616596bc62a19318f57d6d3';
const HUMAN_CANONICAL_RULE = 'money.pl##.money-ecommerce-container';
const HUMAN_SOURCE_RULE = 'bankier.pl,money.pl##.money-ecommerce-container';
const HUMAN_QUOTED_CANONICAL_RULE = 'money.pl##div[data-slot="ad"]';
const HUMAN_QUOTED_SOURCE_RULE = 'bankier.pl,money.pl##div[data-slot="ad"]';

const HUMAN_RULE_CANDIDATES = [
    {
        canonicalRule: HUMAN_CANONICAL_RULE,
        sourceRule: HUMAN_SOURCE_RULE,
    },
    {
        canonicalRule: HUMAN_QUOTED_CANONICAL_RULE,
        sourceRule: HUMAN_QUOTED_SOURCE_RULE,
    },
];

describe('inspectHistoricalCaseMetadata', () => {
    it('returns the issue creation and fix committer dates', async () => {
        const getIssue = vi.fn().mockResolvedValue({
            data: { created_at: '2026-07-14T06:08:12Z' },
        });
        const listCommits = vi.fn().mockResolvedValue({
            data: [{ sha: FILTERS_BASE_SHA }],
        });
        const getCommit = vi.fn().mockResolvedValue({
            data: {
                sha: HUMAN_COMMIT,
                commit: {
                    message: 'Fix #235679 money.pl',
                    committer: { date: '2026-07-14T09:08:12Z' },
                    author: { date: '2026-07-14T08:08:12Z' },
                },
                parents: [{ sha: 'a'.repeat(40) }],
                files: [
                    {
                        filename: 'BaseFilter/sections/foreign.txt',
                        patch:
                            '@@ -1 +1 @@\n' +
                            '-bankier.pl##.money-ecommerce-container\n' +
                            `-${HUMAN_QUOTED_SOURCE_RULE.replace('bankier.pl,money.pl', 'bankier.pl')}\n` +
                            `+${HUMAN_SOURCE_RULE}\n` +
                            `+${HUMAN_QUOTED_SOURCE_RULE}`,
                    },
                ],
            },
        });
        const getRef = vi.fn().mockResolvedValue({
            data: { object: { type: 'commit', sha: 'b'.repeat(40) } },
        });
        const createClient = vi.fn(
            () =>
                ({
                    rest: {
                        issues: { get: getIssue },
                        repos: { listCommits, getCommit },
                        git: { getRef },
                    },
                }) as unknown as ReturnType<typeof createOctokit>,
        );

        await expect(
            inspectHistoricalCaseMetadata(
                { owner: 'ignored', repo: 'ignored', token: 'read-token' },
                {
                    issueNumber: 235679,
                    humanFixCommit: HUMAN_COMMIT,
                    extensionTag: 'autobuild-v5.4.3.96',
                },
                { createClient },
            ),
        ).resolves.toEqual({
            issueCreatedAt: '2026-07-14T06:08:12Z',
            fixCommittedAt: '2026-07-14T09:08:12Z',
            filtersBaseSha: FILTERS_BASE_SHA,
            extensionTagCommit: 'b'.repeat(40),
            humanChangedFiles: ['BaseFilter/sections/foreign.txt'],
            humanRuleCandidates: HUMAN_RULE_CANDIDATES,
            humanRuleLines: {
                added: [HUMAN_SOURCE_RULE, HUMAN_QUOTED_SOURCE_RULE],
                removed: [
                    'bankier.pl##.money-ecommerce-container',
                    HUMAN_QUOTED_SOURCE_RULE.replace('bankier.pl,money.pl', 'bankier.pl'),
                ],
            },
        });
        expect(listCommits).toHaveBeenCalledWith({
            owner: 'AdguardTeam',
            repo: 'AdguardFilters',
            sha: 'master',
            until: '2026-07-14T06:08:12Z',
            per_page: 1,
        });
        expect(getRef).toHaveBeenCalledWith({
            owner: 'AdguardTeam',
            repo: 'AdguardBrowserExtension',
            ref: 'tags/autobuild-v5.4.3.96',
        });
    });

    it('fails when the human fix commit has no committer date', async () => {
        const createClient = vi.fn(
            () =>
                ({
                    rest: {
                        issues: {
                            get: vi.fn().mockResolvedValue({
                                data: { created_at: '2026-07-14T06:08:12Z' },
                            }),
                        },
                        repos: {
                            listCommits: vi
                                .fn()
                                .mockResolvedValue({ data: [{ sha: FILTERS_BASE_SHA }] }),
                            getCommit: vi.fn().mockResolvedValue({
                                data: {
                                    sha: HUMAN_COMMIT,
                                    commit: { message: 'Fix #235679 example.com', committer: null },
                                    parents: [{ sha: 'a'.repeat(40) }],
                                    files: [
                                        {
                                            filename: 'BaseFilter/sections/foreign.txt',
                                            patch: '@@ -0,0 +1 @@\n+example.com##.ad',
                                        },
                                    ],
                                },
                            }),
                        },
                        git: {
                            getRef: vi.fn().mockResolvedValue({
                                data: { object: { type: 'commit', sha: 'b'.repeat(40) } },
                            }),
                        },
                    },
                }) as unknown as ReturnType<typeof createOctokit>,
        );

        await expect(
            inspectHistoricalCaseMetadata(
                { owner: 'ignored', repo: 'ignored', token: 'read-token' },
                {
                    issueNumber: 235679,
                    humanFixCommit: HUMAN_COMMIT,
                    extensionTag: 'autobuild-v5.4.3.96',
                },
                { createClient },
            ),
        ).rejects.toThrow(/committer date/iu);
    });

    it('fails closed when no pre-issue master commit can be resolved', async () => {
        const createClient = vi.fn(
            () =>
                ({
                    rest: {
                        issues: {
                            get: vi.fn().mockResolvedValue({
                                data: { created_at: '2026-07-14T06:08:12Z' },
                            }),
                        },
                        repos: {
                            listCommits: vi.fn().mockResolvedValue({ data: [] }),
                            getCommit: vi.fn().mockResolvedValue({
                                data: {
                                    sha: HUMAN_COMMIT,
                                    commit: {
                                        message: 'Fix #235679 money.pl',
                                        committer: { date: '2026-07-14T09:08:12Z' },
                                        author: { date: '2026-07-14T08:08:12Z' },
                                    },
                                    parents: [{ sha: 'a'.repeat(40) }],
                                    files: [
                                        {
                                            filename: 'BaseFilter/sections/foreign.txt',
                                            patch:
                                                '@@ -1 +1 @@\n' +
                                                '-bankier.pl##.money-ecommerce-container\n' +
                                                `-${HUMAN_QUOTED_SOURCE_RULE.replace('bankier.pl,money.pl', 'bankier.pl')}\n` +
                                                `+${HUMAN_SOURCE_RULE}\n` +
                                                `+${HUMAN_QUOTED_SOURCE_RULE}`,
                                        },
                                    ],
                                },
                            }),
                        },
                        git: {
                            getRef: vi.fn().mockResolvedValue({
                                data: { object: { type: 'commit', sha: 'b'.repeat(40) } },
                            }),
                        },
                    },
                }) as unknown as ReturnType<typeof createOctokit>,
        );

        await expect(
            inspectHistoricalCaseMetadata(
                { owner: 'ignored', repo: 'ignored', token: 'read-token' },
                {
                    issueNumber: 235679,
                    humanFixCommit: HUMAN_COMMIT,
                    extensionTag: 'autobuild-v5.4.3.96',
                },
                { createClient },
            ),
        ).rejects.toThrow(/before 2026-07-14/i);
    });

    it('fails closed when GitHub omits a text-file patch needed for answer isolation', async () => {
        const createClient = vi.fn(
            () =>
                ({
                    rest: {
                        issues: {
                            get: vi.fn().mockResolvedValue({
                                data: { created_at: '2026-07-14T06:08:12Z' },
                            }),
                        },
                        repos: {
                            listCommits: vi.fn().mockResolvedValue({
                                data: [{ sha: FILTERS_BASE_SHA }],
                            }),
                            getCommit: vi.fn().mockResolvedValue({
                                data: {
                                    sha: HUMAN_COMMIT,
                                    commit: {
                                        message: 'Fix #235679 money.pl',
                                        committer: { date: '2026-07-14T09:08:12Z' },
                                        author: { date: '2026-07-14T08:08:12Z' },
                                    },
                                    parents: [{ sha: 'a'.repeat(40) }],
                                    files: [{ filename: 'BaseFilter/sections/foreign.txt' }],
                                },
                            }),
                        },
                        git: {
                            getRef: vi.fn().mockResolvedValue({
                                data: { object: { type: 'commit', sha: 'b'.repeat(40) } },
                            }),
                        },
                    },
                }) as unknown as ReturnType<typeof createOctokit>,
        );

        await expect(
            inspectHistoricalCaseMetadata(
                { owner: 'ignored', repo: 'ignored', token: 'read-token' },
                {
                    issueNumber: 235679,
                    humanFixCommit: HUMAN_COMMIT,
                    extensionTag: 'autobuild-v5.4.3.96',
                },
                { createClient },
            ),
        ).rejects.toThrow(/omitted.*patch/iu);
    });
});

describe('resolveAutobuildTagCommit', () => {
    it.each([
        ['tag', 'b'.repeat(40)],
        ['commit', 'short'],
    ])('refuses an autobuild reference with object type %s and sha %s', async (type, sha) => {
        const octokit = {
            rest: {
                git: {
                    getRef: vi.fn().mockResolvedValue({
                        data: { object: { type, sha } },
                    }),
                },
            },
        } as unknown as ReturnType<typeof createOctokit>;
        await expect(resolveAutobuildTagCommit(octokit, 'autobuild-v5.4.3.96')).rejects.toThrow(
            /commit/iu,
        );
    });
});
