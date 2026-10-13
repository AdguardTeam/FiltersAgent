import { describe, expect, it } from 'vitest';
import {
    boundPromptText,
    isLikelyHumanSolutionComment,
    selectPromptSafeReporterComments,
} from '../../src/github/prompt-safety';

describe('isLikelyHumanSolutionComment', () => {
    it.each([
        'Fixed with example.test##.advert',
        'Resolved in commit 8e9ba459a4552df35b3edb1a4e4d8dd240095ce8',
        'Implemented in PR #1234',
        'https://github.com/AdguardTeam/AdguardFilters/pull/1234',
        'example.test##.advert',
        'Added example.test##.advert after reproducing the issue.',
        'Please use `example.test##.advert` for this site.',
        '@@||example.test^$document',
        '<!-- adguard-filters-agent:upstream-mirror {"schemaVersion":1} -->',
        '<!-- adguard-filters-agent:upstream-sync-state {"schemaVersion":1} -->',
    ])('classifies explicit solution material: %s', (body) => {
        expect(isLikelyHumanSolutionComment(body)).toBe(true);
    });

    it.each([
        'The ad is still visible below the header.',
        'This is not fixed with the latest filters.',
        'My browser extension version is 5.4.3.99.',
        'The filter log shows a request to example.test.',
        'I tried example.test##.advert, but it did not help.',
        '@@||example.test^$document does not work; the wall is still visible.',
    ])('preserves ordinary reporter diagnostics: %s', (body) => {
        expect(isLikelyHumanSolutionComment(body)).toBe(false);
    });
});

describe('selectPromptSafeReporterComments', () => {
    it('keeps only non-solution comments from the immutable issue reporter', () => {
        const comments = [
            { author: 'reporter', body: 'The ad is still visible.', createdAt: 'one' },
            { author: 'maintainer', body: 'Please test another browser.', createdAt: 'two' },
            { author: 'reporter', body: 'Fixed with example.test##.advert', createdAt: 'three' },
            {
                author: 'reporter',
                body: '<!-- adguard-filters-agent:human-solution -->\nHuman fix',
                createdAt: 'four',
            },
        ];

        expect(selectPromptSafeReporterComments(comments, 'reporter')).toEqual([comments[0]]);
        expect(comments).toHaveLength(4);
    });

    it('fails closed when the immutable reporter identity is unavailable', () => {
        expect(selectPromptSafeReporterComments([], '')).toEqual([]);
    });

    it('can preserve only a structured intake report from the trusted AdGuard bot', () => {
        const structuredReport = {
            author: 'adguard-bot',
            body: [
                '### Issue URL (Ads)',
                '[https://example.test](https://example.test)',
                '### System configuration',
                'AdGuard product: | AdGuard Browser Extension v5.4.3.99 MV3',
                '### Issue configuration',
                '[Import settings](https://reports.adguard.com/settings/import.html?id=1)',
            ].join('\n'),
            createdAt: 'one',
        };
        const comments = [
            { author: 'reporter', body: 'The gap remains.', createdAt: 'zero' },
            structuredReport,
            { author: 'adguard-bot', body: 'Marked stale.', createdAt: 'two' },
            { ...structuredReport, author: 'maintainer', createdAt: 'three' },
        ];

        expect(
            selectPromptSafeReporterComments(comments, 'reporter', {
                includeStructuredIssueReports: true,
            }),
        ).toEqual([comments[0], structuredReport]);
    });
});

describe('boundPromptText', () => {
    it('bounds body and comments while retaining first/latest context and an upstream link', () => {
        const sourceUrl = 'https://github.com/AdguardTeam/AdguardFilters/issues/235999';
        const comments = Array.from({ length: 8 }, (_, index) => ({
            author: 'reporter',
            body: `comment-${index + 1}:${String(index + 1).repeat(200)}`,
            createdAt: `2026-07-21T10:${String(index).padStart(2, '0')}:00.000Z`,
        }));

        const bounded = boundPromptText(
            {
                body: `required configuration\n${'body'.repeat(200)}`,
                comments,
                sourceUrl,
            },
            {
                maxBodyCharacters: 500,
                maxCommentCount: 4,
                maxCommentCharacters: 300,
                maxTotalCommentCharacters: 800,
                maxRawCharacters: 10_000,
            },
        );

        expect(bounded.body?.length).toBeLessThanOrEqual(500);
        expect(bounded.comments).toHaveLength(4);
        expect(bounded.comments.map((comment) => comment.body)).toEqual([
            expect.stringContaining('comment-1:'),
            expect.stringContaining('comment-2:'),
            expect.stringContaining('comment-7:'),
            expect.stringContaining('comment-8:'),
        ]);
        expect(
            bounded.comments.reduce((total, comment) => total + comment.body.length, 0),
        ).toBeLessThanOrEqual(800);
        expect(
            [bounded.body, ...bounded.comments.map((comment) => comment.body)].join('\n'),
        ).toContain(sourceUrl);
        expect(bounded.omittedCommentCount).toBe(4);
        expect(bounded.truncated).toBe(true);
        expect(comments[0]?.body).toContain(String(1).repeat(200));
    });

    it('leaves ordinary prompt text byte-for-byte unchanged', () => {
        const comments = [{ author: 'reporter', body: 'Still visible.', createdAt: 'one' }];

        expect(
            boundPromptText(
                {
                    body: 'Original report',
                    comments,
                    sourceUrl: 'https://github.com/example/repo/issues/1',
                },
                {
                    maxBodyCharacters: 500,
                    maxCommentCount: 4,
                    maxCommentCharacters: 300,
                    maxTotalCommentCharacters: 800,
                    maxRawCharacters: 10_000,
                },
            ),
        ).toMatchObject({
            body: 'Original report',
            comments,
            omittedCommentCount: 0,
            truncated: false,
        });
    });
});
