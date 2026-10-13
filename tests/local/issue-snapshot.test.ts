import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import {
    LocalIssueSnapshotSchema,
    buildLocalIssueSnapshot,
    captureLocalIssueSnapshot,
    deriveBoundedIssueInput,
    exportLocalIssueSnapshot,
    filterReporterVisibleComments,
    IssueInputPolicyError,
    loadLocalIssueSnapshot,
    toAgentIssueInput,
} from '../../src/local/issue-snapshot';

const rawIssue = {
    number: 4,
    url: 'https://github.com/example/repository/issues/4',
    title: 'Ad remains on example.com',
    body: 'Reporter body',
    state: 'closed' as const,
    labels: ['T: Ads'],
    assignee: null,
    comments: [
        {
            author: 'reporter',
            body: 'The ad is below the header.',
            createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
            author: 'adguard-bot[bot]',
            body: 'Automated triage output',
            createdAt: '2026-01-01T00:01:00.000Z',
        },
        {
            author: 'github-actions[bot]',
            body: '<!-- adguard-filters-agent:issue-summary -->\nPrior agent answer',
            createdAt: '2026-01-01T00:02:00.000Z',
        },
        {
            author: 'maintainer',
            body: 'Fixed with example.com##.advert',
            createdAt: '2026-01-02T00:00:00.000Z',
        },
        {
            author: 'another-user',
            body: 'I can reproduce this too.',
            createdAt: '2026-01-01T00:03:00.000Z',
        },
    ],
};

const attachments = [
    {
        kind: 'issue_screenshot' as const,
        sourceUrl: 'https://user-images.example/screenshot.png',
        localPath: '/tmp/agent-case-4/screenshot.png',
        sha256: 'a'.repeat(64),
    },
];

describe('LocalIssueSnapshotSchema', () => {
    it('keeps the complete raw issue beside filtered reporter-visible data', () => {
        const snapshot = buildLocalIssueSnapshot(rawIssue, attachments, {
            humanSolutionComments: [
                {
                    author: 'maintainer',
                    createdAt: '2026-01-02T00:00:00.000Z',
                },
            ],
        });

        expect(v.parse(LocalIssueSnapshotSchema, snapshot)).toEqual(snapshot);
        expect(snapshot.rawIssue.comments).toHaveLength(5);
        expect(snapshot.reporterComments.map((comment) => comment.author)).toEqual([
            'reporter',
            'another-user',
        ]);
        expect(snapshot.attachments).toEqual([{ ...attachments[0], promptVisible: true }]);
    });

    it('rejects an attachment without a SHA-256 digest', () => {
        const snapshot = buildLocalIssueSnapshot(rawIssue, attachments);

        expect(() =>
            v.parse(LocalIssueSnapshotSchema, {
                ...snapshot,
                attachments: [{ ...attachments[0], sha256: 'not-a-digest' }],
            }),
        ).toThrow();
    });
});

describe('filterReporterVisibleComments', () => {
    it('excludes bots, generated summaries, and explicitly identified human solutions', () => {
        const before = structuredClone(rawIssue.comments);
        const visible = filterReporterVisibleComments(rawIssue.comments, {
            humanSolutionComments: [
                {
                    author: 'maintainer',
                    createdAt: '2026-01-02T00:00:00.000Z',
                },
            ],
        });

        expect(visible.map((comment) => comment.author)).toEqual(['reporter', 'another-user']);
        expect(rawIssue.comments).toEqual(before);
    });

    it('recognizes explicit human-reference markers without text heuristics', () => {
        const visible = filterReporterVisibleComments([
            {
                author: 'maintainer',
                body: '<!-- adguard-filters-agent:human-solution -->\nexample.com##.advert',
                createdAt: '2026-01-03T00:00:00.000Z',
            },
            {
                author: 'maintainer',
                body: 'The phrase human solution is ordinary discussion here.',
                createdAt: '2026-01-03T00:01:00.000Z',
            },
        ]);

        expect(visible).toHaveLength(1);
        expect(visible[0]?.body).toContain('ordinary discussion');
    });

    it('excludes an unmarked solution posted later by the reporter', () => {
        const comments = [
            {
                author: 'reporter',
                body: 'The ad remains after updating filters.',
                createdAt: '2026-01-03T00:00:00.000Z',
            },
            {
                author: 'reporter',
                body: 'Fixed with example.com##.advert',
                createdAt: '2026-01-04T00:00:00.000Z',
            },
            {
                author: 'maintainer',
                body: 'Unrelated advice.',
                createdAt: '2026-01-05T00:00:00.000Z',
            },
        ];

        expect(filterReporterVisibleComments(comments, { reporterAuthorOnly: 'reporter' })).toEqual(
            [comments[0]],
        );
    });

    it('can retain structured follow-up reports from the issue automation account', () => {
        const structuredReport = {
            author: 'adguard-bot',
            body: [
                '### Issue URL (Ads)',
                '[https://example.com](https://example.com)',
                '### System configuration',
                'AdGuard product: | AdGuard Browser Extension v5.4.3.84 MV3',
                'Browser: | Chrome',
                '### Issue configuration',
                '[Import](https://reports.adguard.com/settings/import.html?product_type=ext)',
            ].join('\n'),
            createdAt: '2026-01-03T00:00:00.000Z',
        };
        const staleNotice = {
            author: 'adguard-bot',
            body: 'This issue has been automatically marked as stale.',
            createdAt: '2026-01-04T00:00:00.000Z',
        };

        expect(
            filterReporterVisibleComments([structuredReport, staleNotice], {
                reporterAuthorOnly: 'reporter',
                includeStructuredIssueReports: true,
            }),
        ).toEqual([structuredReport]);
    });
});

describe('toAgentIssueInput', () => {
    it('does not expose the raw issue comments or filtering metadata to the core agent', () => {
        const snapshot = buildLocalIssueSnapshot(rawIssue, attachments, {
            humanSolutionComments: [
                {
                    author: 'maintainer',
                    createdAt: '2026-01-02T00:00:00.000Z',
                },
            ],
        });
        const input = toAgentIssueInput(snapshot);

        expect(input.comments.map((comment) => comment.author)).toEqual([
            'reporter',
            'another-user',
        ]);
        expect(input.attachments).toEqual([{ ...attachments[0], promptVisible: true }]);
        expect(input).not.toHaveProperty('rawIssue');
        expect(JSON.stringify(input)).not.toContain('example.com##.advert');
    });

    it('preserves benchmark metadata in raw storage but strips it from agent input', () => {
        const filtersBaseSha = '0123456789abcdef0123456789abcdef01234567';
        const humanFixCommit = '89abcdef0123456789abcdef0123456789abcdef';
        const snapshot = buildLocalIssueSnapshot(
            {
                ...rawIssue,
                body:
                    'Reporter body\n' +
                    `<!-- adguard-agent-benchmark: {"filtersBaseSha":"${filtersBaseSha}","humanFixCommit":"${humanFixCommit}"} -->`,
            },
            attachments,
        );

        expect(snapshot.rawIssue.body).toContain(humanFixCommit);
        expect(toAgentIssueInput(snapshot).body).toBe('Reporter body');
    });

    it('preserves upstream mirror provenance in raw storage but strips it from agent input', () => {
        const snapshot = buildLocalIssueSnapshot(
            {
                ...rawIssue,
                body:
                    'Reporter body\n' +
                    '<!-- adguard-filters-agent:upstream-mirror {"schemaVersion":1} -->',
            },
            attachments,
        );

        expect(snapshot.rawIssue.body).toContain('upstream-mirror');
        expect(toAgentIssueInput(snapshot).body).toBe('Reporter body');
    });
});

describe('local issue snapshot files', () => {
    it('captures immutable bytes in memory before persisting an equivalent bundle', async () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'local-issue-capture-'));
        const issue = {
            ...rawIssue,
            reporterAuthor: 'reporter',
            body: 'Body ![one](https://images.example/one.png)',
            comments: [
                {
                    author: 'reporter',
                    body: 'Comment <img src="https://images.example/two.jpg">',
                    createdAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        };
        const downloadAttachment = vi.fn(async (url: string) => Buffer.from(`bytes:${url}`));

        const captured = await captureLocalIssueSnapshot(issue, {
            reporterAuthorOnly: 'reporter',
            downloadAttachment,
            maxAttachmentCount: 12,
            maxTotalAttachmentBytes: 48 * 1024 * 1024,
        });
        const originalFirstByte = captured.attachmentBytes[0]!.bytes[0];
        const downloaded = await downloadAttachment.mock.results[0]!.value;
        downloaded[0] = 0;
        const exported = await exportLocalIssueSnapshot(issue, {
            outputDir,
            reporterAuthorOnly: 'reporter',
            downloadAttachment: async (url) => Buffer.from(`bytes:${url}`),
            maxAttachmentCount: 12,
            maxTotalAttachmentBytes: 48 * 1024 * 1024,
        });

        expect(captured.snapshot).toEqual(exported.snapshot);
        expect(captured.attachmentBytes.map((record) => record.attachment)).toEqual(
            captured.snapshot.attachments,
        );
        expect(captured.attachmentBytes[0]!.bytes[0]).toBe(originalFirstByte);
        expect(
            captured.attachmentBytes.map((record) => Buffer.from(record.bytes).toString('utf8')),
        ).toEqual(['bytes:https://images.example/one.png', 'bytes:https://images.example/two.jpg']);
    });

    it('rejects a thirteenth attachment before downloading and an oversized payload before capture', async () => {
        const twelveImages = Array.from(
            { length: 12 },
            (_, index) => `![${index}](https://images.example/${index}.png)`,
        ).join('\n');
        const downloadAttachment = vi.fn(async () => Buffer.from('1234'));

        await expect(
            captureLocalIssueSnapshot(
                { ...rawIssue, body: twelveImages },
                {
                    downloadAttachment,
                    maxAttachmentCount: 12,
                    maxTotalAttachmentBytes: 48,
                },
            ),
        ).resolves.toMatchObject({ snapshot: { attachments: expect.any(Array) } });
        expect(downloadAttachment).toHaveBeenCalledTimes(12);

        downloadAttachment.mockClear();
        await expect(
            captureLocalIssueSnapshot(
                {
                    ...rawIssue,
                    body: `${twelveImages}\n![12](https://images.example/12.png)`,
                },
                {
                    downloadAttachment,
                    maxAttachmentCount: 12,
                    maxTotalAttachmentBytes: 48,
                },
            ),
        ).rejects.toBeInstanceOf(IssueInputPolicyError);
        expect(downloadAttachment).not.toHaveBeenCalled();

        const oversized = vi.fn(async () => Buffer.from('12345'));
        await expect(
            captureLocalIssueSnapshot(
                { ...rawIssue, body: '![one](https://images.example/one.png)' },
                {
                    downloadAttachment: oversized,
                    maxAttachmentCount: 12,
                    maxTotalAttachmentBytes: 4,
                },
            ),
        ).rejects.toBeInstanceOf(IssueInputPolicyError);
    });

    it('bounds the agent projection while preserving full serialized reporter text', () => {
        const snapshot = buildLocalIssueSnapshot(
            {
                ...rawIssue,
                reporterAuthor: 'reporter',
                body: 'b'.repeat(30_000),
                comments: Array.from({ length: 15 }, (_, index) => ({
                    author: 'reporter',
                    body: `${index}:` + 'c'.repeat(9_000),
                    createdAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
                })),
            },
            [],
            { reporterAuthorOnly: 'reporter' },
        );

        const bounded = deriveBoundedIssueInput(snapshot);

        expect(snapshot.rawIssue.body).toHaveLength(30_000);
        expect(snapshot.reporterComments).toHaveLength(15);
        expect(bounded.body!.length).toBeLessThanOrEqual(24_000);
        expect(bounded.comments).toHaveLength(12);
        expect(bounded.comments.every((comment) => comment.body.length <= 8_000)).toBe(true);
        expect(
            bounded.comments.reduce((sum, comment) => sum + comment.body.length, 0),
        ).toBeLessThanOrEqual(16_000);
    });

    it('downloads bare and reference-style GitHub user attachments', async () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'local-issue-reference-images-'));
        const exported = await exportLocalIssueSnapshot(
            {
                ...rawIssue,
                body: [
                    'Reference screenshot: ![target ad][target-ad]',
                    '[target-ad]: <https://github.com/user-attachments/assets/reference-image>',
                    'Bare screenshot:',
                    'https://github.com/user-attachments/assets/bare-image',
                    'Ordinary bare link must not be treated as an image:',
                    'https://example.com/article',
                ].join('\n'),
                comments: [],
            },
            {
                outputDir,
                downloadAttachment: async (url) => Buffer.from(`bytes:${url}`),
            },
        );

        expect(exported.snapshot.attachments.map((attachment) => attachment.sourceUrl)).toEqual([
            'https://github.com/user-attachments/assets/reference-image',
            'https://github.com/user-attachments/assets/bare-image',
        ]);
    });

    it('downloads screenshot-labelled Markdown links without collecting ordinary links', async () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'local-issue-linked-screenshot-'));
        const screenshotUrl = 'https://cdn.adguardcdn.com/sitereports/reporter-evidence.jpg?nc=1';
        const screenshotBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
        const downloadAttachment = vi.fn(async () => screenshotBytes);
        const exported = await exportLocalIssueSnapshot(
            {
                ...rawIssue,
                body: [
                    '### Screenshots',
                    `[Screenshot 1](${screenshotUrl})`,
                    '[Screenshot guide](https://example.com/guide.jpg)',
                    '[Release image](https://cdn.adguardcdn.com/sitereports/release.jpg)',
                    '[Screenshot 2](https://example.com/article)',
                ].join('\n'),
                comments: [],
            },
            { outputDir, downloadAttachment },
        );

        expect(downloadAttachment).toHaveBeenCalledOnce();
        // The downloader also receives the remaining byte budget; only the URL matters here.
        const [requestedUrl] = downloadAttachment.mock.calls[0] as unknown as readonly string[];
        expect(requestedUrl).toBe(screenshotUrl);
        expect(exported.snapshot.attachments).toEqual([
            expect.objectContaining({
                kind: 'issue_screenshot',
                sourceUrl: screenshotUrl,
                localPath: expect.stringMatching(/^attachments\/01-[0-9a-f]{16}\.jpg$/u),
                promptVisible: true,
                source: 'body',
            }),
        ]);
        expect(
            toAgentIssueInput(loadLocalIssueSnapshot(exported.snapshotPath)).attachments,
        ).toEqual([
            expect.objectContaining({
                sourceUrl: screenshotUrl,
                sha256: exported.snapshot.attachments[0]?.sha256,
            }),
        ]);
    });

    it('downloads a screenshot the AdGuard report front-end stores itself', async () => {
        // Upstream AdguardFilters #241594 linked its screenshot from the report front-end's own
        // store rather than the CDN; a namespace check that knew only the CDN dropped it.
        const outputDir = mkdtempSync(join(tmpdir(), 'local-issue-frontend-screenshot-'));
        const screenshotUrl =
            'https://reports.adguard.info/stcdn/sitereports/6yeg1t9dl64ogokwocso880wgoowk0w.png?nc=1';
        const downloadAttachment = vi.fn(async () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
        const exported = await exportLocalIssueSnapshot(
            {
                ...rawIssue,
                body: ['### Screenshots', `![Screenshot 1](${screenshotUrl})`].join('\n'),
                comments: [],
            },
            { outputDir, downloadAttachment },
        );

        expect(downloadAttachment).toHaveBeenCalledOnce();
        expect(exported.snapshot.attachments).toEqual([
            expect.objectContaining({ kind: 'issue_screenshot', sourceUrl: screenshotUrl }),
        ]);
    });

    it('downloads every user image, records its digest, and reloads the snapshot', async () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'local-issue-export-'));
        const issueWithImages = {
            ...rawIssue,
            body: `${rawIssue.body}\n![issue](https://images.example/issue.png)`,
            comments: [
                rawIssue.comments[0]!,
                {
                    author: 'reporter',
                    body: 'A second view: <img src="https://images.example/comment.jpg">',
                    createdAt: '2026-01-01T00:04:00.000Z',
                },
            ],
        };

        const exported = await exportLocalIssueSnapshot(issueWithImages, {
            outputDir,
            downloadAttachment: async (url) => Buffer.from(`bytes:${url}`),
        });
        const loaded = loadLocalIssueSnapshot(exported.snapshotPath);

        expect(loaded.attachments).toHaveLength(2);
        expect(loaded.attachments.every((attachment) => attachment.sha256.length === 64)).toBe(
            true,
        );
        expect(
            loaded.attachments.map((attachment) => readFileSync(attachment.localPath, 'utf8')),
        ).toEqual([
            'bytes:https://images.example/issue.png',
            'bytes:https://images.example/comment.jpg',
        ]);

        const persisted = JSON.parse(readFileSync(exported.snapshotPath, 'utf8')) as {
            attachments: Array<{ localPath: string }>;
        };
        expect(persisted.attachments.map((attachment) => attachment.localPath)).toEqual([
            expect.stringMatching(/^attachments\//),
            expect.stringMatching(/^attachments\//),
        ]);
        expect(
            loaded.attachments.every((attachment) => attachment.localPath.startsWith(outputDir)),
        ).toBe(true);
    });

    it('rejects automatic-intake image counts and aggregate bytes before unbounded storage', async () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'agent-issue-limits-'));
        const issueWithTwoImages = {
            ...rawIssue,
            body: [
                '![one](https://github.com/user-attachments/assets/one)',
                '![two](https://github.com/user-attachments/assets/two)',
            ].join('\n'),
        };
        const downloadAttachment = vi.fn(async () => Buffer.from('1234'));

        await expect(
            exportLocalIssueSnapshot(issueWithTwoImages, {
                outputDir,
                downloadAttachment,
                maxAttachmentCount: 1,
                maxTotalAttachmentBytes: 20,
            }),
        ).rejects.toBeInstanceOf(IssueInputPolicyError);
        expect(downloadAttachment).not.toHaveBeenCalled();

        await expect(
            exportLocalIssueSnapshot(issueWithTwoImages, {
                outputDir,
                downloadAttachment,
                maxAttachmentCount: 2,
                maxTotalAttachmentBytes: 7,
            }),
        ).rejects.toBeInstanceOf(IssueInputPolicyError);
        expect(downloadAttachment).toHaveBeenCalledTimes(2);
    });

    it('loads portable relative attachment paths from the issue bundle directory', () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'local-issue-portable-'));
        const attachmentsDir = join(outputDir, 'attachments');
        mkdirSync(attachmentsDir, { recursive: true });
        const attachmentBytes = Buffer.from('portable screenshot');
        const attachmentPath = join(attachmentsDir, 'screenshot.png');
        writeFileSync(attachmentPath, attachmentBytes);
        const snapshot = buildLocalIssueSnapshot(rawIssue, [
            {
                kind: 'issue_screenshot',
                sourceUrl: 'https://images.example/portable.png',
                localPath: 'attachments/screenshot.png',
                sha256: '62af60bcb427793ccb09903cf0f2fe01f38713c721e7c562a80fe9cb22054c29',
            },
        ]);
        const snapshotPath = join(outputDir, 'issue.json');
        writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

        const loaded = loadLocalIssueSnapshot(snapshotPath);

        expect(loaded.attachments[0]?.localPath).toBe(attachmentPath);
    });

    it('rejects a relative attachment path that escapes the issue bundle', () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'local-issue-path-escape-'));
        const snapshot = buildLocalIssueSnapshot(rawIssue, [
            {
                kind: 'issue_screenshot',
                sourceUrl: 'https://images.example/escape.png',
                localPath: '../outside.png',
                sha256: 'a'.repeat(64),
            },
        ]);
        const snapshotPath = join(outputDir, 'issue.json');
        writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

        expect(() => loadLocalIssueSnapshot(snapshotPath)).toThrow(/escapes/i);
    });

    it('rejects a persisted attachment whose bytes no longer match its SHA-256', async () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'local-issue-tamper-'));
        const exported = await exportLocalIssueSnapshot(
            {
                ...rawIssue,
                body: '![issue](https://images.example/issue.png)',
                comments: [],
            },
            {
                outputDir,
                downloadAttachment: async () => Buffer.from('original'),
            },
        );
        const loaded = loadLocalIssueSnapshot(exported.snapshotPath);
        writeFileSync(loaded.attachments[0]!.localPath, 'tampered');

        expect(() => loadLocalIssueSnapshot(exported.snapshotPath)).toThrow(/SHA-256/i);
    });

    it('retains solution images in raw storage but excludes them from the agent input', async () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'local-issue-solution-image-'));
        const exported = await exportLocalIssueSnapshot(
            {
                ...rawIssue,
                body: '![report](https://images.example/report.png)',
                comments: [
                    {
                        author: 'maintainer',
                        body: 'Fixed: ![solution](https://images.example/solution.png)',
                        createdAt: '2026-01-02T00:00:00.000Z',
                    },
                ],
            },
            {
                outputDir,
                humanSolutionComments: [
                    {
                        author: 'maintainer',
                        createdAt: '2026-01-02T00:00:00.000Z',
                    },
                ],
                downloadAttachment: async (url) => Buffer.from(`bytes:${url}`),
            },
        );

        expect(exported.snapshot.attachments).toHaveLength(2);
        expect(exported.snapshot.attachments.map((attachment) => attachment.promptVisible)).toEqual(
            [true, false],
        );
        expect(toAgentIssueInput(exported.snapshot).attachments).toHaveLength(1);
        expect(toAgentIssueInput(exported.snapshot).attachments[0]?.sourceUrl).toContain('report');
    });
});
