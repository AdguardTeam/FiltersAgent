import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { IssueInputPolicyError, toAgentIssueInput } from '../../../src/local/issue-snapshot';
import {
    captureGithubIssueRevision,
    downloadGithubAttachment,
    exportGithubIssue,
} from '../../../lab/local/github-issue-exporter';
import {
    EXPORTED_REVISION_MAX_ATTACHMENT_COUNT,
    EXPORTED_REVISION_MAX_AGGREGATE_BYTES,
    loadVerifiedExportedIssueRevision,
} from '../../../src/local/issue-revision';

/**
 * Build a fetch-compatible mock that returns deterministic attachment bytes.
 *
 * @returns Fetch mock accepted by the exporter transport seam.
 */
function attachmentFetch(): typeof fetch {
    return vi.fn(async () => {
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
            status: 200,
            headers: { 'content-type': 'image/png' },
        });
    }) as unknown as typeof fetch;
}

/**
 * Create a large payload with valid PNG magic for aggregate-budget tests.
 *
 * @param byteLength - Exact response size.
 * @returns PNG-signature-prefixed bytes.
 */
function pngBytes(byteLength: number): Uint8Array {
    const bytes = new Uint8Array(byteLength);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return bytes;
}

describe('exportGithubIssue', () => {
    it('captures verified live revisions and reports supersession without filesystem staging', async () => {
        const rawIssue = {
            number: 4,
            reporterAuthor: 'reporter',
            updatedAt: '2026-07-23T10:02:00.000Z',
            url: 'https://github.com/example/filters/issues/4',
            title: 'Ad remains',
            body: 'Reporter body',
            state: 'open' as const,
            labels: ['T: Ads'],
            assignee: null,
            comments: [],
        };
        const fetchIssue = vi.fn().mockResolvedValue(rawIssue);

        const verified = await captureGithubIssueRevision(
            { owner: 'Example', repo: 'Filters', token: 'read-token' },
            4,
            { capturedAt: '2026-07-23T10:03:00.000Z' },
            { fetchIssue, fetch: attachmentFetch() },
        );
        const superseded = await captureGithubIssueRevision(
            { owner: 'Example', repo: 'Filters', token: 'read-token' },
            4,
            {
                capturedAt: '2026-07-23T10:03:00.000Z',
                expectedUpdatedAt: '2026-07-23T09:00:00.000Z',
            },
            { fetchIssue, fetch: attachmentFetch() },
        );

        expect(verified).toMatchObject({
            kind: 'verified',
            revision: { inputOrigin: 'live', issueNumber: 4 },
        });
        expect(superseded).toEqual({
            kind: 'superseded',
            summary: {
                issueNumber: 4,
                updatedAt: '2026-07-23T10:02:00.000Z',
                state: 'open',
            },
        });
        expect(fetchIssue).toHaveBeenCalledWith(
            expect.anything(),
            4,
            expect.objectContaining({
                preserveGeneratedComments: true,
                preserveBenchmarkMetadata: true,
                maxRawCommentCount: 1_000,
            }),
        );
    });

    it('exports a revision-aware envelope that reloads offline', async () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'github-v2-issue-export-'));
        const fetchIssue = vi.fn().mockResolvedValue({
            number: 4,
            reporterAuthor: 'reporter',
            updatedAt: '2026-07-23T10:02:00.000Z',
            url: 'https://github.com/example/filters/issues/4',
            title: 'Ad remains',
            body: '![report](https://github.com/user-attachments/assets/report-image)',
            state: 'open',
            labels: ['T: Ads'],
            assignee: null,
            comments: [],
        });

        const exported = await exportGithubIssue(
            { owner: 'Example', repo: 'Filters', token: 'read-token' },
            4,
            {
                outputDir,
                workspaceRoot: '/workspace/adguard-filters-agent',
                outputFormat: 'revision-envelope',
                capturedAt: '2026-07-23T10:03:00.000Z',
            },
            { fetchIssue, fetch: attachmentFetch() },
        );

        const source = JSON.parse(readFileSync(exported.snapshotPath, 'utf8'));
        const verified = loadVerifiedExportedIssueRevision(exported.snapshotPath);
        expect(source).toMatchObject({
            schemaVersion: 2,
            inputOrigin: 'exported',
            repository: 'example/filters',
            issueNumber: 4,
            sourceUpdatedAt: '2026-07-23T10:02:00.000Z',
            capturedAt: '2026-07-23T10:03:00.000Z',
        });
        expect(exported.revision?.revisionDigest).toBe(source.revisionDigest);
        expect(verified.sourceIntegrityDigest).toBe(source.revisionDigest);
    });

    it('preflights the mandatory v2 attachment count before downloading', async () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'github-v2-count-export-'));
        const fetchAttachment = attachmentFetch();
        const body = Array.from(
            { length: EXPORTED_REVISION_MAX_ATTACHMENT_COUNT + 1 },
            (_, index) =>
                `![image-${index}](https://github.com/user-attachments/assets/image-${index})`,
        ).join('\n');
        const fetchIssue = vi.fn().mockResolvedValue({
            number: 4,
            reporterAuthor: 'reporter',
            updatedAt: '2026-07-23T10:02:00.000Z',
            url: 'https://github.com/example/filters/issues/4',
            title: 'Ad remains',
            body,
            state: 'open',
            labels: ['T: Ads'],
            assignee: null,
            comments: [],
        });

        await expect(
            exportGithubIssue(
                { owner: 'example', repo: 'filters', token: 'read-token' },
                4,
                {
                    outputDir,
                    workspaceRoot: '/workspace/adguard-filters-agent',
                    outputFormat: 'revision-envelope',
                    capturedAt: '2026-07-23T10:03:00.000Z',
                },
                { fetchIssue, fetch: fetchAttachment },
            ),
        ).rejects.toThrow(/12/);
        expect(fetchAttachment).not.toHaveBeenCalled();
    });

    it('accepts exactly twelve v2 attachments', async () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'github-v2-exact-count-export-'));
        const body = Array.from(
            { length: EXPORTED_REVISION_MAX_ATTACHMENT_COUNT },
            (_, index) =>
                `![image-${index}](https://github.com/user-attachments/assets/image-${index})`,
        ).join('\n');
        const fetchIssue = vi.fn().mockResolvedValue({
            number: 4,
            reporterAuthor: 'reporter',
            updatedAt: '2026-07-23T10:02:00.000Z',
            url: 'https://github.com/example/filters/issues/4',
            title: 'Ad remains',
            body,
            state: 'open',
            labels: ['T: Ads'],
            assignee: null,
            comments: [],
        });

        const exported = await exportGithubIssue(
            { owner: 'example', repo: 'filters', token: 'read-token' },
            4,
            {
                outputDir,
                workspaceRoot: '/workspace/adguard-filters-agent',
                outputFormat: 'revision-envelope',
                capturedAt: '2026-07-23T10:03:00.000Z',
            },
            { fetchIssue, fetch: attachmentFetch() },
        );

        expect(exported.snapshot.attachments).toHaveLength(EXPORTED_REVISION_MAX_ATTACHMENT_COUNT);
        expect(loadVerifiedExportedIssueRevision(exported.snapshotPath).issueNumber).toBe(4);
    });

    it('enforces the v2 aggregate budget before persisting the crossing response', async () => {
        const body = Array.from(
            { length: 3 },
            (_, index) =>
                `![image-${index}](https://github.com/user-attachments/assets/image-${index})`,
        ).join('\n');
        const fetchIssue = vi.fn().mockResolvedValue({
            number: 4,
            reporterAuthor: 'reporter',
            updatedAt: '2026-07-23T10:02:00.000Z',
            url: 'https://github.com/example/filters/issues/4',
            title: 'Ad remains',
            body,
            state: 'open',
            labels: ['T: Ads'],
            assignee: null,
            comments: [],
        });
        const chunkSize = EXPORTED_REVISION_MAX_AGGREGATE_BYTES / 3;
        const exactOutput = mkdtempSync(join(tmpdir(), 'github-v2-exact-bytes-export-'));
        const exactFetch = vi.fn(
            async () =>
                new Response(pngBytes(chunkSize), {
                    status: 200,
                    headers: { 'content-type': 'image/png' },
                }),
        ) as unknown as typeof fetch;
        const exact = await exportGithubIssue(
            { owner: 'example', repo: 'filters', token: 'read-token' },
            4,
            {
                outputDir: exactOutput,
                workspaceRoot: '/workspace/adguard-filters-agent',
                outputFormat: 'revision-envelope',
                capturedAt: '2026-07-23T10:03:00.000Z',
            },
            { fetchIssue, fetch: exactFetch },
        );
        expect(loadVerifiedExportedIssueRevision(exact.snapshotPath).issueNumber).toBe(4);

        const overflowOutput = mkdtempSync(join(tmpdir(), 'github-v2-over-bytes-export-'));
        let request = 0;
        const overflowFetch = vi.fn(async () => {
            request += 1;
            return new Response(pngBytes(chunkSize + (request === 3 ? 1 : 0)), {
                status: 200,
                headers: { 'content-type': 'image/png' },
            });
        }) as unknown as typeof fetch;
        await expect(
            exportGithubIssue(
                { owner: 'example', repo: 'filters', token: 'read-token' },
                4,
                {
                    outputDir: overflowOutput,
                    workspaceRoot: '/workspace/adguard-filters-agent',
                    outputFormat: 'revision-envelope',
                    capturedAt: '2026-07-23T10:03:00.000Z',
                },
                { fetchIssue, fetch: overflowFetch },
            ),
        ).rejects.toThrow(/too large/i);
        expect(existsSync(join(overflowOutput, 'attachments'))).toBe(false);
    });

    it('fetches the complete issue read-only and exports filtered prompt context', async () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'github-issue-export-'));
        const fetchIssue = vi.fn().mockResolvedValue({
            number: 4,
            reporterAuthor: 'reporter',
            url: 'https://github.com/example/filters/issues/4',
            title: 'Ad remains',
            body: '![report](https://github.com/user-attachments/assets/report-image)',
            state: 'closed',
            labels: ['T: Ads'],
            assignee: null,
            comments: [
                {
                    author: 'reporter',
                    body: 'The ad is under the header.',
                    createdAt: '2026-01-01T00:00:00.000Z',
                },
                {
                    author: 'github-actions[bot]',
                    body: '<!-- adguard-filters-agent:issue-summary -->\nPrior agent answer',
                    createdAt: '2026-01-01T01:00:00.000Z',
                },
                {
                    author: 'maintainer',
                    body: 'Fixed: ![proof](https://github.com/user-attachments/assets/fix-image)',
                    createdAt: '2026-01-02T00:00:00.000Z',
                },
            ],
        });

        const exported = await exportGithubIssue(
            { owner: 'example', repo: 'filters', token: 'read-token' },
            4,
            {
                outputDir,
                workspaceRoot: '/workspace/adguard-filters-agent',
                humanSolutionComments: [
                    {
                        author: 'maintainer',
                        createdAt: '2026-01-02T00:00:00.000Z',
                    },
                ],
            },
            {
                fetchIssue,
                fetch: attachmentFetch(),
            },
        );

        expect(fetchIssue).toHaveBeenCalledWith(
            { owner: 'example', repo: 'filters', token: 'read-token' },
            4,
            {
                preserveGeneratedComments: true,
                preserveBenchmarkMetadata: true,
            },
        );
        expect(exported.snapshot.rawIssue.comments).toHaveLength(3);
        expect(
            toAgentIssueInput(exported.snapshot).comments.map((comment) => comment.author),
        ).toEqual(['reporter']);
        expect(exported.snapshot.attachments.map((attachment) => attachment.promptVisible)).toEqual(
            [true, false],
        );
        expect(exported.snapshot.attachments[0]?.localPath).toMatch(/\.png$/u);
        expect(JSON.parse(readFileSync(exported.snapshotPath, 'utf8'))).toEqual(exported.snapshot);
    });

    it('rejects output inside the workspace before reading GitHub', async () => {
        const fetchIssue = vi.fn();

        await expect(
            exportGithubIssue(
                { owner: 'example', repo: 'filters', token: 'read-token' },
                4,
                {
                    outputDir: '/workspace/adguard-filters-agent/cases/4',
                    workspaceRoot: '/workspace/adguard-filters-agent',
                },
                { fetchIssue, fetch: attachmentFetch() },
            ),
        ).rejects.toThrow(/outside the workspace/i);
        expect(fetchIssue).not.toHaveBeenCalled();
    });

    it('can persist a prompt-safe-only bundle for an isolated analysis job', async () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'github-prompt-safe-export-'));
        const humanFixCommit = '8e9ba459a4552df35b3edb1a4e4d8dd240095ce8';
        const fetchIssue = vi.fn().mockResolvedValue({
            number: 4,
            reporterAuthor: 'reporter',
            url: 'https://github.com/example/filters/issues/4',
            title: 'Ad remains',
            body:
                '![report](https://github.com/user-attachments/assets/report-image)\n' +
                `<!-- adguard-agent-benchmark: {"filtersBaseSha":"${'0'.repeat(40)}",` +
                `"humanFixCommit":"${humanFixCommit}"} -->`,
            state: 'open',
            labels: ['T: Ads'],
            assignee: null,
            comments: [
                {
                    author: 'reporter',
                    body: 'The ad remains.',
                    createdAt: '2026-01-01T00:00:00.000Z',
                },
                {
                    author: 'maintainer',
                    body:
                        '<!-- adguard-filters-agent:human-solution -->\n' +
                        '![proof](https://github.com/user-attachments/assets/fix-image)',
                    createdAt: '2026-01-02T00:00:00.000Z',
                },
                {
                    author: 'reporter',
                    body: 'Fixed with example.test##.human-gold',
                    createdAt: '2026-01-03T00:00:00.000Z',
                },
            ],
        });

        const exported = await exportGithubIssue(
            { owner: 'example', repo: 'filters', token: 'read-token' },
            4,
            {
                outputDir,
                workspaceRoot: '/workspace/adguard-filters-agent',
                promptSafeOnly: true,
            },
            { fetchIssue, fetch: attachmentFetch() },
        );

        const source = readFileSync(exported.snapshotPath, 'utf8');
        expect(source).not.toContain('adguard-agent-benchmark');
        expect(source).not.toContain(humanFixCommit);
        expect(source).not.toContain('human-solution');
        expect(source).not.toContain('human-gold');
        expect(exported.snapshot.rawIssue.comments.map((comment) => comment.author)).toEqual([
            'reporter',
        ]);
        expect(exported.snapshot.attachments).toHaveLength(1);
        expect(exported.snapshot.attachments[0]?.promptVisible).toBe(true);
        expect(existsSync(join(outputDir, 'attachments'))).toBe(true);
        expect(readdirSync(join(outputDir, 'attachments'))).toHaveLength(1);
    });

    it('preserves an allowlisted structured MV3 report through the prompt-safe rebuild', async () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'github-structured-report-export-'));
        const browserExtensionReport = [
            '### Issue URL (Ads)',
            'https://www.reddit.com/r/example',
            '',
            '### System configuration',
            'AdGuard product: | AdGuard Browser Extension v5.4.3.102 MV3',
            '',
            '### Issue configuration',
            '[Import](https://reports.adguard.com/settings/import.html?' +
                'product_type=ext&product_version=5.4.3.102&ext.manifest_version=3)',
        ].join('\n');
        const fetchIssue = vi.fn().mockResolvedValue({
            number: 6,
            reporterAuthor: 'adguard-bot',
            url: 'https://github.com/example/filters/issues/6',
            title: 'www.reddit.com',
            body: [
                '### Issue URL (Annoyance)',
                'https://www.reddit.com/',
                '',
                '### System configuration',
                'AdGuard product: | AdGuard for Android v4.12.3',
            ].join('\n'),
            state: 'open',
            labels: ['T: Ads', 'N: AdGuard Browser Extension'],
            assignee: null,
            comments: [
                {
                    author: 'adguard-bot',
                    body: browserExtensionReport,
                    createdAt: '2026-07-20T08:00:44.000Z',
                },
            ],
        });

        const exported = await exportGithubIssue(
            { owner: 'example', repo: 'filters', token: 'read-token' },
            6,
            {
                outputDir,
                workspaceRoot: '/workspace/adguard-filters-agent',
                promptSafeOnly: true,
                reporterOnlyPrompt: true,
                includeStructuredIssueReports: true,
            },
            { fetchIssue, fetch: attachmentFetch() },
        );

        const input = toAgentIssueInput(exported.snapshot);
        expect(exported.snapshot.reporterComments).toEqual([
            expect.objectContaining({ body: browserExtensionReport }),
        ]);
        expect(input.comments).toEqual([expect.objectContaining({ body: browserExtensionReport })]);
        expect(JSON.stringify(input.comments)).toContain(
            'AdGuard Browser Extension v5.4.3.102 MV3',
        );
    });

    it('fails prompt-safe export when GitHub did not identify the issue author', async () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'github-prompt-safe-no-author-'));
        const fetchIssue = vi.fn().mockResolvedValue({
            number: 4,
            url: 'https://github.com/example/filters/issues/4',
            title: 'Ad remains',
            body: 'Reporter body',
            state: 'open',
            labels: ['T: Ads'],
            assignee: null,
            comments: [],
        });

        await expect(
            exportGithubIssue(
                { owner: 'example', repo: 'filters', token: 'read-token' },
                4,
                {
                    outputDir,
                    workspaceRoot: '/workspace/adguard-filters-agent',
                    promptSafeOnly: true,
                },
                { fetchIssue, fetch: attachmentFetch() },
            ),
        ).rejects.toThrow(/issue author/i);
    });

    it('retains an unmarked reporter solution only in the auditable raw view', async () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'github-raw-reporter-solution-'));
        const fetchIssue = vi.fn().mockResolvedValue({
            number: 4,
            reporterAuthor: 'reporter',
            url: 'https://github.com/example/filters/issues/4',
            title: 'Ad remains',
            body: 'Original report',
            state: 'closed',
            labels: ['T: Ads'],
            assignee: null,
            comments: [
                {
                    author: 'reporter',
                    body: 'The ad remains.',
                    createdAt: '2026-01-01T00:00:00.000Z',
                },
                {
                    author: 'reporter',
                    body: 'Fixed with example.test##.human-gold',
                    createdAt: '2026-01-03T00:00:00.000Z',
                },
            ],
        });

        const exported = await exportGithubIssue(
            { owner: 'example', repo: 'filters', token: 'read-token' },
            4,
            {
                outputDir,
                workspaceRoot: '/workspace/adguard-filters-agent',
            },
            { fetchIssue, fetch: attachmentFetch() },
        );

        expect(JSON.stringify(exported.snapshot.rawIssue.comments)).toContain('human-gold');
        expect(JSON.stringify(toAgentIssueInput(exported.snapshot).comments)).not.toContain(
            'human-gold',
        );
    });

    it('keeps raw history while exposing only structured issue-author follow-up reports', async () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'github-reporter-only-export-'));
        const structuredReport = [
            '### Issue URL (Ads)',
            '[https://example.test](https://example.test)',
            '### Screenshots',
            '![report](https://github.com/user-attachments/assets/follow-up-image)',
            '### System configuration',
            'AdGuard product: | AdGuard Browser Extension v5.4.3.84 MV3',
            'Browser: | Chrome',
            '### Issue configuration',
            '[Import](https://reports.adguard.com/settings/import.html?product_type=ext)',
        ].join('\n');
        const fetchIssue = vi.fn().mockResolvedValue({
            number: 4,
            reporterAuthor: 'adguard-bot',
            url: 'https://github.com/example/filters/issues/4',
            title: 'Ad remains',
            body: 'Original report from another supported product.',
            state: 'closed',
            labels: ['T: Ads', 'N: AdGuard Browser Extension'],
            assignee: null,
            comments: [
                {
                    author: 'adguard-bot',
                    body: structuredReport,
                    createdAt: '2026-01-01T00:00:00.000Z',
                },
                {
                    author: 'maintainer',
                    body: 'Investigation notes without a rule.',
                    createdAt: '2026-01-02T00:00:00.000Z',
                },
            ],
        });

        const exported = await exportGithubIssue(
            { owner: 'example', repo: 'filters', token: 'read-token' },
            4,
            {
                outputDir,
                workspaceRoot: '/workspace/adguard-filters-agent',
                reporterOnlyPrompt: true,
                includeStructuredIssueReports: true,
            },
            { fetchIssue, fetch: attachmentFetch() },
        );

        expect(exported.snapshot.rawIssue.comments).toHaveLength(2);
        expect(toAgentIssueInput(exported.snapshot).comments).toEqual([
            expect.objectContaining({ author: 'adguard-bot', body: structuredReport }),
        ]);
        expect(toAgentIssueInput(exported.snapshot).attachments).toHaveLength(1);
    });
});

describe('downloadGithubAttachment', () => {
    it('sends the read token to GitHub hosts and never to a third-party host', async () => {
        const fetch = attachmentFetch();

        await downloadGithubAttachment(
            'https://github.com/user-attachments/assets/private-image',
            'read-token',
            fetch,
        );
        // A reporter may paste a screenshot from any image host, so the download is allowed —
        // but that host must never receive the token.
        await downloadGithubAttachment('https://images.example/public.png', 'read-token', fetch);

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch).toHaveBeenNthCalledWith(
            1,
            'https://github.com/user-attachments/assets/private-image',
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer read-token' }),
                redirect: 'manual',
            }),
        );
        const [, thirdPartyOptions] = (
            fetch as unknown as {
                mock: { calls: [string, RequestInit][] };
            }
        ).mock.calls[1]!;
        expect(
            (thirdPartyOptions as { headers: Record<string, string> }).headers,
        ).not.toHaveProperty('Authorization');
    });

    it('refuses a reporter URL that points inside the host network', async () => {
        const fetch = attachmentFetch();

        for (const url of [
            'https://127.0.0.1/shot.png',
            'https://10.0.0.5/shot.png',
            'https://192.168.1.4/shot.png',
            'https://169.254.169.254/latest/meta-data',
            'https://localhost/shot.png',
            'http://images.example/shot.png',
            'https://user:pass@images.example/shot.png',
        ]) {
            await expect(downloadGithubAttachment(url, 'read-token', fetch)).rejects.toThrow(
                /plain HTTPS on a public host/i,
            );
        }
        expect(fetch).not.toHaveBeenCalled();
    });

    it('allows the exact AdGuard issue-screenshot CDN without forwarding the GitHub token', async () => {
        const fetch = attachmentFetch();

        await downloadGithubAttachment(
            'https://cdn.adguardcdn.com/sitereports/reporter.png',
            'read-token',
            fetch,
        );

        expect(fetch).toHaveBeenCalledWith(
            'https://cdn.adguardcdn.com/sitereports/reporter.png',
            expect.objectContaining({
                headers: { Accept: 'application/octet-stream' },
                redirect: 'manual',
            }),
        );
    });

    it('downloads public GitHub issue attachments without an unrelated repository token', async () => {
        const fetch = attachmentFetch();

        await downloadGithubAttachment(
            'https://github.com/user-attachments/assets/public-image',
            '',
            fetch,
        );

        expect(fetch).toHaveBeenCalledWith(
            'https://github.com/user-attachments/assets/public-image',
            expect.objectContaining({
                headers: { Accept: 'application/octet-stream' },
            }),
        );
    });

    it('fails clearly when an attachment cannot be downloaded', async () => {
        const fetch = vi.fn(
            async () =>
                new Response('missing', {
                    status: 404,
                    headers: { 'content-type': 'image/png' },
                }),
        ) as unknown as typeof globalThis.fetch;

        const missing = downloadGithubAttachment(
            'https://github.com/user-attachments/assets/missing.png',
            'read-token',
            fetch,
        );
        await expect(missing).rejects.toThrow(/404/);
        await expect(missing).rejects.toBeInstanceOf(IssueInputPolicyError);
    });

    it('does not classify transient attachment-server failures as reporter policy errors', async () => {
        const fetch = vi.fn(
            async () =>
                new Response('temporary failure', {
                    status: 503,
                    headers: { 'content-type': 'image/png' },
                }),
        ) as unknown as typeof globalThis.fetch;

        const error = await downloadGithubAttachment(
            'https://github.com/user-attachments/assets/retry.png',
            'read-token',
            fetch,
        ).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(IssueInputPolicyError);
        expect((error as Error).message).toMatch(/503/u);
    });

    it('revalidates redirects and refuses one aimed inside the host network', async () => {
        const fetch = vi.fn(
            async () =>
                new Response(null, {
                    status: 302,
                    headers: { location: 'https://169.254.169.254/latest/meta-data' },
                }),
        ) as unknown as typeof globalThis.fetch;

        await expect(
            downloadGithubAttachment(
                'https://github.com/user-attachments/assets/redirected.png',
                'read-token',
                fetch,
            ),
        ).rejects.toThrow(/plain HTTPS on a public host/i);
        expect(fetch).toHaveBeenCalledOnce();
    });

    it('never includes a signed redirect query in retained diagnostics', async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 302,
                    headers: {
                        location:
                            'https://private-user-images.githubusercontent.com/image.png?' +
                            'jwt=short-lived-secret',
                    },
                }),
            )
            .mockResolvedValueOnce(
                new Response('failed', {
                    status: 500,
                    headers: { 'content-type': 'image/png' },
                }),
            ) as unknown as typeof globalThis.fetch;

        const error = await downloadGithubAttachment(
            'https://github.com/user-attachments/assets/redirected.png',
            'read-token',
            fetch,
        ).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
            'private-user-images.githubusercontent.com/image.png',
        );
        expect((error as Error).message).not.toContain('jwt=');
        expect((error as Error).message).not.toContain('short-lived-secret');
    });

    it('rejects non-image responses and bodies over the attachment limit', async () => {
        const nonImageFetch = vi.fn(
            async () =>
                new Response('not an image', {
                    status: 200,
                    headers: { 'content-type': 'text/html' },
                }),
        ) as unknown as typeof globalThis.fetch;
        await expect(
            downloadGithubAttachment(
                'https://github.com/user-attachments/assets/not-image',
                'read-token',
                nonImageFetch,
            ),
        ).rejects.toThrow(/content type/i);

        const tooLargeFetch = vi.fn(
            async () =>
                new Response('small body', {
                    status: 200,
                    headers: {
                        'content-length': String(21 * 1024 * 1024),
                        'content-type': 'image/png',
                    },
                }),
        ) as unknown as typeof globalThis.fetch;
        await expect(
            downloadGithubAttachment(
                'https://github.com/user-attachments/assets/too-large.png',
                'read-token',
                tooLargeFetch,
            ),
        ).rejects.toThrow(/too large/i);
    });
});
