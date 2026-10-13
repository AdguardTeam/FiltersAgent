import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { FixRunStatus, SymptomObservation } from '../../src/types/fix-run-result';
import { resolveReportTemplate } from '../../src/publisher/report-template';
import {
    buildReportTemplateValues,
    renderReportComment,
    summarizeReportOutcome,
} from '../../src/publisher/report-render';
import {
    REPORT_COMMENT_MARKER_PREFIX,
    ReportPublishAction,
    ReportPublishError,
    ReportPublishErrorKind,
    parseReportRevisionMarker,
    publishReportOnce,
    renderReportRevisionMarker,
} from '../../src/publisher/report-publisher';

/**
 * Link the caller of this flow is responsible for providing — the artifacts surface the report
 * points at, owned outside the publisher (the runner/action wiring slice).
 */
const ARTIFACTS_LINK = 'https://github.com/owner/repo/actions/runs/42#artifacts';

/**
 * GitHub's issue-comment body limit in characters; the publisher size guard must refuse at exactly
 * this platform contract (marker + body counted together).
 */
const GITHUB_COMMENT_BODY_LIMIT = 65_536;

const REVISION_DIGEST = 'a1'.repeat(32);
const OTHER_REVISION_DIGEST = 'b2'.repeat(32);

const REPORT_BODY = '## Short report\n\nThe defect no longer reproduces.';

/**
 * The run's own report-author login for every fixture in this file, unless a test deliberately uses
 * a different one to prove an outsider's marker is never trusted.
 */
const REPORT_AUTHOR_LOGIN = 'adguard-filters-agent[bot]';

const PUBLISH_INPUT = {
    owner: 'owner',
    repo: 'repo',
    issueNumber: 15,
    revisionDigest: REVISION_DIGEST,
    body: REPORT_BODY,
    reportAuthorLogin: REPORT_AUTHOR_LOGIN,
};

function mockOctokit(overrides: Record<string, unknown> = {}): Octokit {
    return {
        rest: {
            issues: {
                listComments: vi.fn().mockResolvedValue({ data: [] }),
                createComment: vi.fn().mockResolvedValue({
                    data: {
                        id: 501,
                        html_url: 'https://github.com/owner/repo/issues/15#issuecomment-501',
                    },
                }),
                ...overrides,
            },
        },
    } as unknown as Octokit;
}

function existingComment(
    id: number,
    body: string,
    author: string = REPORT_AUTHOR_LOGIN,
): {
    id: number;
    body: string;
    html_url: string;
    user: { login: string };
} {
    return {
        id,
        body,
        html_url: `https://github.com/owner/repo/issues/15#issuecomment-${id}`,
        user: { login: author },
    };
}

describe('renderReportRevisionMarker', () => {
    it('renders the hidden marker with the strict JSON payload', () => {
        const marker = renderReportRevisionMarker({
            schemaVersion: 1,
            revisionDigest: REVISION_DIGEST,
        });
        expect(marker).toBe(
            `${REPORT_COMMENT_MARKER_PREFIX}{"schemaVersion":1,"revisionDigest":"${REVISION_DIGEST}"} -->`,
        );
    });
});

describe('parseReportRevisionMarker', () => {
    it('round-trips a published comment body', () => {
        const body = `${renderReportRevisionMarker({ schemaVersion: 1, revisionDigest: REVISION_DIGEST })}\n${REPORT_BODY}`;
        expect(parseReportRevisionMarker(body)).toEqual({
            schemaVersion: 1,
            revisionDigest: REVISION_DIGEST,
        });
    });

    it('returns null for tolerated malformed comment bodies', () => {
        const markerBody = renderReportRevisionMarker({
            schemaVersion: 1,
            revisionDigest: REVISION_DIGEST,
        });
        const otherBody = renderReportRevisionMarker({
            schemaVersion: 1,
            revisionDigest: OTHER_REVISION_DIGEST,
        });
        expect(parseReportRevisionMarker(null)).toBeNull();
        expect(parseReportRevisionMarker('')).toBeNull();
        expect(parseReportRevisionMarker('A plain reporter comment.')).toBeNull();
        expect(
            parseReportRevisionMarker(`${REPORT_COMMENT_MARKER_PREFIX}not-json -->\nbody`),
        ).toBeNull();
        expect(
            parseReportRevisionMarker(
                `${REPORT_COMMENT_MARKER_PREFIX}{"schemaVersion":1} -->\nbody`,
            ),
        ).toBeNull();
        expect(
            parseReportRevisionMarker(
                `${REPORT_COMMENT_MARKER_PREFIX}{"schemaVersion":1,"revisionDigest":"deadbeef"} -->\nbody`,
            ),
        ).toBeNull();
        expect(
            parseReportRevisionMarker(
                `${REPORT_COMMENT_MARKER_PREFIX}{"schemaVersion":1,"revisionDigest":"${REVISION_DIGEST}","extra":1} -->\nbody`,
            ),
        ).toBeNull();
        // Duplicated markers leave the comment's revision ambiguous: ignored, never thrown.
        expect(parseReportRevisionMarker(`${markerBody}\n${otherBody}`)).toBeNull();
        expect(parseReportRevisionMarker(`${markerBody}\n${markerBody}`)).toBeNull();
    });
});

describe('publishReportOnce', () => {
    it('posts one report with the marker as the hidden first line', async () => {
        const createSpy = vi.fn().mockResolvedValue({
            data: { id: 501, html_url: 'https://github.com/owner/repo/issues/15#issuecomment-501' },
        });
        const octokit = mockOctokit({ createComment: createSpy });

        const result = await publishReportOnce(octokit, PUBLISH_INPUT);

        expect(result.action).toBe(ReportPublishAction.Posted);
        expect(result.commentUrl).toBe('https://github.com/owner/repo/issues/15#issuecomment-501');
        expect(createSpy.mock.calls).toHaveLength(1);
        const callArgs = createSpy.mock.calls[0][0];
        expect(callArgs.owner).toBe('owner');
        expect(callArgs.repo).toBe('repo');
        expect(callArgs.issue_number).toBe(15);
        const marker = renderReportRevisionMarker({
            schemaVersion: 1,
            revisionDigest: REVISION_DIGEST,
        });
        expect(callArgs.body.startsWith(REPORT_COMMENT_MARKER_PREFIX)).toBe(true);
        expect(callArgs.body).toBe(`${marker}\n${REPORT_BODY}`);
    });

    it('writes nothing and reports the existing comment when the revision was already reported', async () => {
        const marker = renderReportRevisionMarker({
            schemaVersion: 1,
            revisionDigest: REVISION_DIGEST,
        });
        const createSpy = vi.fn().mockResolvedValue({ data: { id: 501, html_url: '' } });
        const octokit = mockOctokit({
            createComment: createSpy,
            listComments: vi.fn().mockResolvedValue({
                data: [
                    existingComment(424, `${marker}\nEarlier report for the same revision.`),
                    existingComment(425, 'A plain reporter comment.'),
                ],
            }),
        });

        const result = await publishReportOnce(octokit, PUBLISH_INPUT);

        expect(result.action).toBe(ReportPublishAction.AlreadyReported);
        expect(result.commentUrl).toBe('https://github.com/owner/repo/issues/15#issuecomment-424');
        expect(createSpy).not.toHaveBeenCalled();
    });

    it('pages through full pages and the first matching digest wins', async () => {
        const marker = renderReportRevisionMarker({
            schemaVersion: 1,
            revisionDigest: REVISION_DIGEST,
        });
        const fullPage = Array.from({ length: 100 }, (_, index) =>
            existingComment(1000 + index, `Reporter comment ${index}.`),
        );
        const listSpy = vi
            .fn()
            .mockResolvedValueOnce({ data: fullPage })
            .mockResolvedValueOnce({
                data: [
                    existingComment(2, 'A later different-revision report.'),
                    existingComment(7, `${marker}\nThe report that is already on the issue.`),
                ],
            });
        const createSpy = vi.fn().mockResolvedValue({ data: { id: 501, html_url: '' } });
        const octokit = mockOctokit({ listComments: listSpy, createComment: createSpy });

        const result = await publishReportOnce(octokit, PUBLISH_INPUT);

        expect(result.action).toBe(ReportPublishAction.AlreadyReported);
        expect(result.commentUrl).toBe('https://github.com/owner/repo/issues/15#issuecomment-7');
        expect(createSpy).not.toHaveBeenCalled();
        expect(listSpy.mock.calls[0][0]).toEqual(
            expect.objectContaining({ per_page: 100, page: 1 }),
        );
        expect(listSpy.mock.calls[1][0]).toEqual(
            expect.objectContaining({ per_page: 100, page: 2 }),
        );
    });

    it('posts a new report when the existing marker carries a different revision', async () => {
        const marker = renderReportRevisionMarker({
            schemaVersion: 1,
            revisionDigest: OTHER_REVISION_DIGEST,
        });
        const createSpy = vi.fn().mockResolvedValue({
            data: { id: 501, html_url: 'https://github.com/owner/repo/issues/15#issuecomment-501' },
        });
        const octokit = mockOctokit({
            createComment: createSpy,
            listComments: vi.fn().mockResolvedValue({
                data: [existingComment(424, `${marker}\nOlder revision report.`)],
            }),
        });

        const result = await publishReportOnce(octokit, PUBLISH_INPUT);

        expect(result.action).toBe(ReportPublishAction.Posted);
        expect(result.commentUrl).toBe('https://github.com/owner/repo/issues/15#issuecomment-501');
        expect(createSpy).toHaveBeenCalledOnce();
    });

    it('ignores malformed, duplicated, and invalid-digest markers instead of refusing to post', async () => {
        const marker = renderReportRevisionMarker({
            schemaVersion: 1,
            revisionDigest: OTHER_REVISION_DIGEST,
        });
        const createSpy = vi.fn().mockResolvedValue({
            data: { id: 501, html_url: 'https://github.com/owner/repo/issues/15#issuecomment-501' },
        });
        const octokit = mockOctokit({
            createComment: createSpy,
            listComments: vi.fn().mockResolvedValue({
                data: [
                    existingComment(1, `${REPORT_COMMENT_MARKER_PREFIX}not-json -->\nbody`),
                    existingComment(2, `${marker}\n${marker}`),
                    existingComment(3, undefined as unknown as string),
                ],
            }),
        });

        const result = await publishReportOnce(octokit, PUBLISH_INPUT);

        expect(result.action).toBe(ReportPublishAction.Posted);
        expect(createSpy).toHaveBeenCalledOnce();
    });

    it('never trusts a marker posted by a different login, and still posts the real report', async () => {
        // A public issue lets anyone post a comment shaped exactly like the hidden marker. A
        // forged marker from an outsider must never be read as "already reported" on this
        // revision, and must never suppress the run's own publication.
        const forgedMarker = renderReportRevisionMarker({
            schemaVersion: 1,
            revisionDigest: REVISION_DIGEST,
        });
        const createSpy = vi.fn().mockResolvedValue({
            data: { id: 501, html_url: 'https://github.com/owner/repo/issues/15#issuecomment-501' },
        });
        const octokit = mockOctokit({
            createComment: createSpy,
            listComments: vi.fn().mockResolvedValue({
                data: [
                    existingComment(
                        999,
                        `${forgedMarker}\nI can post anything I want here.`,
                        'random-outsider',
                    ),
                ],
            }),
        });

        const result = await publishReportOnce(octokit, PUBLISH_INPUT);

        expect(result.action).toBe(ReportPublishAction.Posted);
        expect(result.commentUrl).toBe('https://github.com/owner/repo/issues/15#issuecomment-501');
        expect(createSpy).toHaveBeenCalledOnce();
    });

    it('throws the typed size error before any API call when the composed body exceeds the limit', async () => {
        const listSpy = vi.fn().mockResolvedValue({ data: [] });
        const createSpy = vi.fn().mockResolvedValue({
            data: { id: 501, html_url: 'https://github.com/owner/repo/issues/15#issuecomment-501' },
        });
        const octokit = mockOctokit({ listComments: listSpy, createComment: createSpy });
        const marker = renderReportRevisionMarker({
            schemaVersion: 1,
            revisionDigest: REVISION_DIGEST,
        });
        // Composed body lands exactly on GitHub's 65 536-character limit: still postable.
        const exactBody = 'x'.repeat(GITHUB_COMMENT_BODY_LIMIT - marker.length - 1);

        const exact = await publishReportOnce(octokit, { ...PUBLISH_INPUT, body: exactBody });
        expect(exact.action).toBe(ReportPublishAction.Posted);

        const failure = await publishReportOnce(octokit, {
            ...PUBLISH_INPUT,
            body: `${exactBody}!`,
        }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ReportPublishError);
        expect((failure as ReportPublishError).kind).toBe(
            ReportPublishErrorKind.CommentBodyTooLarge,
        );
        // The refusal happened before the scan: only the exact-body call reached the API.
        expect(listSpy).toHaveBeenCalledTimes(1);
        expect(createSpy).toHaveBeenCalledTimes(1);
    });

    it('posts the finalized body when the revision has no report yet', async () => {
        const createSpy = vi.fn().mockResolvedValue({
            data: { id: 501, html_url: 'https://github.com/owner/repo/issues/15#issuecomment-501' },
        });
        const finalizeBody = vi.fn().mockResolvedValue(`${REPORT_BODY}\n\nWith screenshots.`);
        const octokit = mockOctokit({ createComment: createSpy });

        await publishReportOnce(octokit, { ...PUBLISH_INPUT, finalizeBody });

        const marker = renderReportRevisionMarker({
            schemaVersion: 1,
            revisionDigest: REVISION_DIGEST,
        });
        expect(finalizeBody).toHaveBeenCalledTimes(1);
        expect(createSpy.mock.calls[0][0].body).toBe(
            `${marker}\n${REPORT_BODY}\n\nWith screenshots.`,
        );
    });

    it('never finalizes the body when the revision was already reported', async () => {
        const marker = renderReportRevisionMarker({
            schemaVersion: 1,
            revisionDigest: REVISION_DIGEST,
        });
        const finalizeBody = vi.fn().mockResolvedValue(REPORT_BODY);
        const octokit = mockOctokit({
            listComments: vi.fn().mockResolvedValue({
                data: [existingComment(424, `${marker}\nEarlier report.`)],
            }),
        });

        const result = await publishReportOnce(octokit, { ...PUBLISH_INPUT, finalizeBody });

        expect(result.action).toBe(ReportPublishAction.AlreadyReported);
        expect(finalizeBody).not.toHaveBeenCalled();
    });

    it('refuses a finalized body over the limit before posting it', async () => {
        const createSpy = vi.fn();
        const octokit = mockOctokit({ createComment: createSpy });

        const failure = await publishReportOnce(octokit, {
            ...PUBLISH_INPUT,
            finalizeBody: () => Promise.resolve('x'.repeat(GITHUB_COMMENT_BODY_LIMIT)),
        }).catch((error: unknown) => error);

        expect((failure as ReportPublishError).kind).toBe(
            ReportPublishErrorKind.CommentBodyTooLarge,
        );
        expect(createSpy).not.toHaveBeenCalled();
    });

    it('propagates a failing createComment unswallowed', async () => {
        const octokit = mockOctokit({
            createComment: vi.fn().mockRejectedValue(new Error('boom')),
        });

        await expect(publishReportOnce(octokit, PUBLISH_INPUT)).rejects.toThrow('boom');
    });
});

describe('instruction template to posted comment', () => {
    it('extracts the instruction template, renders the candidate outcome into it, and posts one comment', async () => {
        const instruction = [
            '# Guidance',
            '',
            '## Report template',
            'Outcome: {{outcome}}',
            '',
            'Proposed rule: {{rule}}',
            'Where it lands: {{listPlace}}',
            '',
            'Artifacts: {{artifactsLink}}',
            '',
            '## Follow-up',
            'Not part of the template.',
        ].join('\n');
        const createSpy = vi.fn().mockResolvedValue({
            data: { id: 501, html_url: 'https://github.com/owner/repo/issues/15#issuecomment-501' },
        });
        const octokit = mockOctokit({ createComment: createSpy });

        const resolved = resolveReportTemplate(instruction);
        const summary = summarizeReportOutcome(
            {
                runStatus: FixRunStatus.PatchProposed,
                fallbackReason: null,
                fallbackDetail: null,
                symptomObservation: SymptomObservation.Reproduced,
                candidatePatch: {
                    rule: 'example.com##.ad-banner',
                    filePath: 'BaseFilter/sections/specific.txt',
                },
            },
            { summary: 'Ad banner reproduced, then resolved by the candidate.' },
            ARTIFACTS_LINK,
        );
        const body = renderReportComment(resolved.template, buildReportTemplateValues(summary));
        const result = await publishReportOnce(octokit, {
            ...PUBLISH_INPUT,
            body,
        });

        expect(result.action).toBe(ReportPublishAction.Posted);
        expect(createSpy.mock.calls).toHaveLength(1);
        const posted = createSpy.mock.calls[0][0].body as string;
        expect(posted.startsWith(REPORT_COMMENT_MARKER_PREFIX)).toBe(true);
        expect(posted).toContain('Outcome: Candidate rule proposed');
        // The rule renders in a code span (a backtick fence) so Markdown never reinterprets it.
        expect(posted).toContain('Proposed rule: `example.com##.ad-banner`');
        expect(posted).toContain('Where it lands: BaseFilter/sections/specific.txt');
        expect(posted).toContain(`Artifacts: ${ARTIFACTS_LINK}`);
        expect(posted).not.toContain('Follow-up');
    });
});
