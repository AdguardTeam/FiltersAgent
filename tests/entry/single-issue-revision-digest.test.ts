import { describe, expect, it } from 'vitest';
import { fetchedIssueRevisionDigest } from '../../src/entry/single-issue-revision-digest';
import type { RawIssue } from '../../src/github/fetch-issue';

/**
 * Build one minimal validated raw issue fixture.
 *
 * @param overrides - Fields this scenario overrides.
 * @returns The fixture issue.
 */
function rawIssue(overrides: Partial<RawIssue> = {}): RawIssue {
    return {
        number: 4,
        reporterAuthor: 'reporter',
        updatedAt: '2026-09-09T10:00:00.000Z',
        url: 'https://github.com/owner/list/issues/4',
        title: 'Ad banner stays visible',
        body: 'The ad is not blocked on example.com.',
        state: 'open',
        labels: [],
        assignee: null,
        comments: [
            {
                author: 'reporter',
                body: 'Still visible after update.',
                createdAt: '2026-09-09T09:00:00.000Z',
            },
        ],
        ...overrides,
    };
}

const SLUG = { owner: 'owner', repo: 'list' };

describe('fetchedIssueRevisionDigest', () => {
    it('stays stable when only updatedAt changes — GitHub bumps it on every new comment, our own report included', () => {
        const before = fetchedIssueRevisionDigest(
            rawIssue({ updatedAt: '2026-09-09T10:00:00.000Z' }),
            SLUG,
        );
        const afterOwnReportPosted = fetchedIssueRevisionDigest(
            rawIssue({ updatedAt: '2026-09-09T10:05:00.000Z' }),
            SLUG,
        );

        expect(afterOwnReportPosted).toBe(before);
    });

    it('changes when the title, body, or kept comments change', () => {
        const base = rawIssue();
        const baseDigest = fetchedIssueRevisionDigest(base, SLUG);

        expect(fetchedIssueRevisionDigest(rawIssue({ title: 'Different title' }), SLUG)).not.toBe(
            baseDigest,
        );
        expect(fetchedIssueRevisionDigest(rawIssue({ body: 'Different body.' }), SLUG)).not.toBe(
            baseDigest,
        );
        expect(
            fetchedIssueRevisionDigest(
                rawIssue({
                    comments: [
                        ...base.comments,
                        {
                            author: 'reporter',
                            body: 'One more update.',
                            createdAt: '2026-09-09T11:00:00.000Z',
                        },
                    ],
                }),
                SLUG,
            ),
        ).not.toBe(baseDigest);
    });

    it('is a lowercase 64-hex digest', () => {
        expect(fetchedIssueRevisionDigest(rawIssue(), SLUG)).toMatch(/^[0-9a-f]{64}$/u);
    });
});
