import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
    REPORT_COMMENT_MARKER_PREFIX,
    RevisionCommentKind,
    renderReportRevisionMarker,
} from '../../src/publisher/report-publisher';
import {
    BacklogIssueComment,
    BacklogIssueHistory,
    BacklogIssuePage,
    BacklogIssueReadError,
    BacklogIssueReadErrorCode,
    BacklogIssueReader,
    BacklogIssueSummary,
} from '../../src/queue/backlog-reader';
import { BacklogSkipKind, selectBacklogIssues } from '../../src/queue/backlog-selection';
import { applyQueueDefaults, QueueInputsSchema, TrustedRole } from '../../src/queue/queue-inputs';
import type { QueueInputs } from '../../src/queue/queue-inputs';

const CAPTURED_AT = '2026-09-09T12:00:00.000Z';

const HOUR_MS = 60 * 60 * 1_000;

const DAY_MS = 24 * HOUR_MS;

const DIGEST_A = 'a'.repeat(64);

const DIGEST_B = 'b'.repeat(64);

const DIGEST_C = 'c'.repeat(64);

/**
 * Iso timestamp exactly `msBefore` milliseconds before the run's clock capture.
 *
 * @param msBefore - Milliseconds the timestamp predates {@link CAPTURED_AT}.
 * @returns The anchored ISO timestamp.
 */
function iso(msBefore: number): string {
    return new Date(Date.parse(CAPTURED_AT) - msBefore).toISOString();
}

/**
 * Hidden-marker report body like the publisher composes, first line marker, prose beneath.
 *
 * @param digest - The revision digest bound into the marker.
 * @returns The marker-carrying body text.
 */
function reportBody(digest: string): string {
    return `${renderReportRevisionMarker({ schemaVersion: 1, revisionDigest: digest })}\nReport body ${digest.slice(0, 6)}.`;
}

/**
 * Build one mapped comment like the backlog reader's history map delivers.
 *
 * @param author - Comment author login.
 * @param body - Comment text.
 * @param createdAt - Immutable creation timestamp.
 * @param authorAssociation - GitHub author association, or null when absent.
 * @param updatedAt - Last-edited timestamp, defaulting to untouched.
 * @returns The mapped comment.
 */
function commentOf(
    author: string,
    body: string,
    createdAt: string,
    authorAssociation: string | null = null,
    updatedAt: string = createdAt,
): BacklogIssueComment {
    return { author, body, createdAt, updatedAt, authorAssociation };
}

/**
 * The run's own resolved report-author login for every fixture in this file, unless a test
 * deliberately uses a different one to prove an outsider's marker is never trusted.
 */
const REPORT_AUTHOR_LOGIN = 'adguard-filters-agent';

/**
 * Build one published-report comment authored by the agent, association-free.
 *
 * @param digest - The revision digest the report binds.
 * @param createdAt - Publication timestamp.
 * @param author - The comment's author login; defaults to the run's own report-author identity.
 * @returns The report comment.
 */
function reportComment(
    digest: string,
    createdAt: string,
    author: string = REPORT_AUTHOR_LOGIN,
): BacklogIssueComment {
    return commentOf(author, reportBody(digest), createdAt);
}

/**
 * Build one forced-run notice comment authored by the agent: no report, only a note that a run
 * could not investigate the issue.
 *
 * @param digest - The revision digest the notice binds.
 * @param createdAt - Publication timestamp.
 * @returns The notice comment.
 */
function noticeComment(digest: string, createdAt: string): BacklogIssueComment {
    return commentOf(
        REPORT_AUTHOR_LOGIN,
        `${renderReportRevisionMarker({ schemaVersion: 1, revisionDigest: digest }, RevisionCommentKind.Notice)}\nThe agent could not access the reported page.`,
        createdAt,
    );
}

/**
 * Build one fixture issue history, newest-first page order supplied by the fake reader.
 *
 * @param issueNumber - Stable fixture issue number.
 * @param options - Creation/update ages relative to the clock capture, labels, reporter, comments.
 * @returns The fixture history.
 */
function openIssue(
    issueNumber: number,
    options: {
        createdAgoMs?: number;
        updatedAgoMs?: number;
        labels?: string[];
        reporter?: string;
        comments?: BacklogIssueComment[];
    } = {},
): BacklogIssueHistory {
    const createdAgoMs = options.createdAgoMs ?? 5 * DAY_MS;
    const comments = options.comments ?? [];
    return {
        summary: {
            issueNumber,
            createdAt: iso(createdAgoMs),
            updatedAt: iso(options.updatedAgoMs ?? createdAgoMs),
            labels: options.labels ?? [],
            reporterAuthor: options.reporter ?? `reporter-${issueNumber}`,
            commentCount: comments.length,
        },
        comments,
    };
}

/**
 * Validated queue inputs over the lab's defaults, overrideable per test.
 *
 * @param overrides - Inputs the test pins.
 * @returns The defaulted, validated queue inputs.
 */
function queueInputs(overrides: Partial<QueueInputs> = {}): QueueInputs {
    return v.parse(
        QueueInputsSchema,
        applyQueueDefaults({
            capturedAt: CAPTURED_AT,
            reportAuthorLogin: REPORT_AUTHOR_LOGIN,
            ...overrides,
        }),
    );
}

/**
 * Issues per page the fake reader serves by default; every fixture suite but the page-count one
 * fits inside a single page.
 */
const FAKE_PAGE_SIZE = 100;

/**
 * In-memory fake of the backlog reader's two-read surface; insertion order is the newest-first page
 * order, and published reports mutate the fixture the way a real run's writes would.
 */
class FakeBacklogIssueReader implements BacklogIssueReader {
    /**
     * Fixture issues keyed by number; insertion order is the reader's newest-first page order.
     */
    private readonly issues = new Map<number, BacklogIssueHistory>();

    /**
     * Issue numbers handed to `readIssueHistory`, in call order.
     */
    readonly historyReads: number[] = [];

    /**
     * 1-based page numbers handed to `readOpenIssuePage`, in call order.
     */
    readonly pageReads: number[] = [];

    /**
     * Issues delivered per page.
     */
    private readonly pageSize: number;

    /**
     * Create one fixture reader.
     *
     * @param pageSize - Issues delivered per page; the default fits the small suites in one page.
     */
    constructor(pageSize: number = FAKE_PAGE_SIZE) {
        this.pageSize = pageSize;
    }

    /**
     * Register one fixture issue into the page order.
     *
     * @param history - The fixture history.
     */
    addIssue(history: BacklogIssueHistory): void {
        this.issues.set(history.summary.issueNumber, history);
    }

    /**
     * Simulate the run publishing one report comment on a fixture issue.
     *
     * @param issueNumber - The fixture issue the run reported.
     * @param comment - The revision-marked report comment.
     */
    publishReport(issueNumber: number, comment: BacklogIssueComment): void {
        const history = this.issues.get(issueNumber);
        if (history !== undefined) {
            history.comments.push(comment);
        }
    }

    /**
     * Deliver one page of fixture summaries in insertion (newest-first) order, tracking the read
     * for page-count assertions.
     *
     * @param page - 1-based page number.
     * @returns The page's summaries and whether the page was full.
     */
    async readOpenIssuePage(page: number): Promise<BacklogIssuePage> {
        this.pageReads.push(page);
        // GitHub's listing counts the comments the issue has right now, so the fixture recomputes
        // it rather than carrying a count a published report could leave stale.
        const summaries = [...this.issues.values()].map((history) => ({
            ...history.summary,
            commentCount: history.comments.length,
        }));
        const start = (page - 1) * this.pageSize;
        const pageSummaries = summaries.slice(start, start + this.pageSize);
        return { summaries: pageSummaries, hasMore: pageSummaries.length === this.pageSize };
    }

    /**
     * Deliver one fixture issue's history for the summary it was listed with, tracking the read for
     * visit-count assertions.
     *
     * @param summary - The listed summary of the fixture issue.
     * @returns The fixture history.
     */
    async readIssueHistory(summary: BacklogIssueSummary): Promise<BacklogIssueHistory> {
        const history = this.issues.get(summary.issueNumber);
        if (history === undefined) {
            throw new BacklogIssueReadError(
                BacklogIssueReadErrorCode.ReadFailed,
                `Fixture issue ${summary.issueNumber} is missing.`,
            );
        }
        this.historyReads.push(summary.issueNumber);
        return { ...history, summary };
    }
}

describe('selectBacklogIssues', () => {
    it('takes never-reported issues newest first as listed', async () => {
        const reader = new FakeBacklogIssueReader();
        reader.addIssue(openIssue(105));
        reader.addIssue(openIssue(104));
        reader.addIssue(openIssue(103));
        reader.addIssue(openIssue(102));
        reader.addIssue(openIssue(101));

        const outcome = await selectBacklogIssues(reader, queueInputs());

        expect(outcome.takenIssueNumbers).toEqual([105, 104, 103, 102, 101]);
        expect(outcome.skippedIssueNumbers).toEqual({
            [BacklogSkipKind.AlreadyReported]: [],
            [BacklogSkipKind.RevisionBudgetHit]: [],
            [BacklogSkipKind.NarrowedOut]: [],
            [BacklogSkipKind.ExcludedLabel]: [],
        });
    });

    it('continues with the next unprocessed pair across runs', async () => {
        const reader = new FakeBacklogIssueReader();
        for (const issueNumber of [106, 105, 104, 103, 102, 101]) {
            reader.addIssue(openIssue(issueNumber));
        }
        const inputs = queueInputs({ maxIssuesPerRun: 2 });

        const firstRun = await selectBacklogIssues(reader, inputs);
        expect(firstRun.takenIssueNumbers).toEqual([106, 105]);

        // The first run published its reports: the fixture reader gains revision markers on the
        // first pair. Against an unchanged reader the selector, stateless, would return the same
        // pair again.
        reader.publishReport(106, reportComment(DIGEST_A, iso(2 * HOUR_MS)));
        reader.publishReport(105, reportComment(DIGEST_B, iso(3 * HOUR_MS)));
        const readsBefore = reader.historyReads.length;

        const secondRun = await selectBacklogIssues(reader, inputs);

        expect(secondRun.takenIssueNumbers).toEqual([104, 103]);
        expect(secondRun.skippedIssueNumbers).toEqual({
            [BacklogSkipKind.AlreadyReported]: [106, 105],
            [BacklogSkipKind.RevisionBudgetHit]: [],
            [BacklogSkipKind.NarrowedOut]: [],
            [BacklogSkipKind.ExcludedLabel]: [],
        });
        // Page iteration stops once the limit holds: the skipped pair is re-derived, the taken
        // pair is visited once, and the unvisited tail is read no further.
        expect(reader.historyReads.slice(readsBefore)).toEqual([106, 105, 104, 103]);
    });

    it('stops reading pages the moment the take limit fills', async () => {
        const reader = new FakeBacklogIssueReader(3);
        for (const issueNumber of [106, 105, 104, 103, 102, 101]) {
            reader.addIssue(openIssue(issueNumber));
        }

        const outcome = await selectBacklogIssues(reader, queueInputs({ maxIssuesPerRun: 2 }));

        // Page 1 carried three selectable issues; the second take filled the limit, so page 2 was
        // never requested even though page 1 reported more.
        expect(outcome.takenIssueNumbers).toEqual([106, 105]);
        expect(reader.pageReads).toEqual([1]);
    });

    it('counts exactly one valid revision marker as the published report', async () => {
        const reader = new FakeBacklogIssueReader();
        reader.addIssue(
            openIssue(301, {
                updatedAgoMs: 2 * DAY_MS,
                comments: [reportComment(DIGEST_A, iso(2 * DAY_MS))],
            }),
        );
        reader.addIssue(
            openIssue(302, {
                updatedAgoMs: DAY_MS,
                comments: [
                    commentOf(
                        'bystander',
                        `${renderReportRevisionMarker({ schemaVersion: 1, revisionDigest: DIGEST_A })}\nmid\n${renderReportRevisionMarker({ schemaVersion: 1, revisionDigest: DIGEST_B })}`,
                        iso(DAY_MS),
                    ),
                ],
            }),
        );
        reader.addIssue(
            openIssue(303, {
                updatedAgoMs: HOUR_MS,
                comments: [
                    commentOf(
                        'bystander',
                        // A marker-shaped span whose digest violates the schema parses to no
                        // marker at all.
                        `${REPORT_COMMENT_MARKER_PREFIX}${JSON.stringify({ schemaVersion: 1, revisionDigest: 'z'.repeat(64) })} -->`,
                        iso(HOUR_MS),
                    ),
                ],
            }),
        );

        const outcome = await selectBacklogIssues(reader, queueInputs());

        expect(outcome.takenIssueNumbers).toEqual([302, 303]);
        expect(outcome.skippedIssueNumbers[BacklogSkipKind.AlreadyReported]).toEqual([301]);
    });

    it('takes an issue whose only own comment is a forced run notice', async () => {
        // The notice says a run could not investigate the issue: it is no report of it, so the
        // backlog retakes the issue.
        const reader = new FakeBacklogIssueReader();
        reader.addIssue(
            openIssue(901, {
                updatedAgoMs: 2 * DAY_MS,
                comments: [noticeComment(DIGEST_A, iso(2 * DAY_MS))],
            }),
        );

        const outcome = await selectBacklogIssues(reader, queueInputs());

        expect(outcome.takenIssueNumbers).toEqual([901]);
    });

    it('retakes an issue edited after its report even when a forced run notice came after the edit', async () => {
        // The notice moves the issue's update time to its own: counted as a comment, it would
        // explain away the edit before it and leave the new text unreported.
        const reader = new FakeBacklogIssueReader();
        reader.addIssue(
            openIssue(902, {
                updatedAgoMs: DAY_MS,
                comments: [
                    reportComment(DIGEST_A, iso(3 * DAY_MS)),
                    noticeComment(DIGEST_B, iso(DAY_MS)),
                ],
            }),
        );

        const outcome = await selectBacklogIssues(reader, queueInputs());

        expect(outcome.takenIssueNumbers).toEqual([902]);
    });

    it('never trusts a marker posted by a different login, and never suppresses the take', async () => {
        // A public repository lets anyone post a comment shaped exactly like the hidden marker.
        // Such a forged marker must neither make the issue already-reported nor count toward the
        // revision budget, and it must never be able to reselect anything either.
        const reader = new FakeBacklogIssueReader();
        reader.addIssue(
            openIssue(801, {
                updatedAgoMs: 2 * DAY_MS,
                comments: [reportComment(DIGEST_A, iso(2 * DAY_MS), 'random-outsider')],
            }),
        );

        const outcome = await selectBacklogIssues(reader, queueInputs());

        expect(outcome.takenIssueNumbers).toEqual([801]);
        expect(outcome.skippedIssueNumbers[BacklogSkipKind.AlreadyReported]).toEqual([]);
    });

    it('reselects on trusted revision-change signals after the report', async () => {
        const reportAgo = 2 * DAY_MS;
        const reader = new FakeBacklogIssueReader();
        reader.addIssue(
            openIssue(401, {
                updatedAgoMs: DAY_MS,
                comments: [
                    reportComment(DIGEST_A, iso(reportAgo)),
                    commentOf('reporter-401', 'Changed the reproduction steps.', iso(DAY_MS)),
                ],
            }),
        );
        reader.addIssue(
            openIssue(402, {
                updatedAgoMs: DAY_MS,
                comments: [
                    reportComment(DIGEST_B, iso(reportAgo)),
                    commentOf(
                        'maintainer',
                        'The reporter gave a second URL.',
                        iso(DAY_MS),
                        TrustedRole.Owner,
                    ),
                ],
            }),
        );
        reader.addIssue(
            openIssue(403, {
                updatedAgoMs: DAY_MS,
                comments: [
                    reportComment(DIGEST_C, iso(reportAgo)),
                    commentOf(
                        'editor-admin',
                        'The ad sits below the fold.',
                        iso(3 * DAY_MS),
                        TrustedRole.Member,
                        iso(DAY_MS),
                    ),
                ],
            }),
        );
        reader.addIssue(
            openIssue(404, {
                updatedAgoMs: DAY_MS / 2,
                comments: [reportComment(DIGEST_A, iso(reportAgo))],
            }),
        );
        reader.addIssue(
            openIssue(405, {
                updatedAgoMs: reportAgo,
                comments: [
                    reportComment(DIGEST_B, iso(reportAgo)),
                    commentOf(
                        'older-maintainer',
                        'Duplicate of #402.',
                        iso(3 * DAY_MS),
                        TrustedRole.Collaborator,
                    ),
                ],
            }),
        );

        const outcome = await selectBacklogIssues(reader, queueInputs());

        expect(outcome.takenIssueNumbers).toEqual([401, 402, 403, 404]);
        expect(outcome.skippedIssueNumbers[BacklogSkipKind.AlreadyReported]).toEqual([405]);
    });

    it('stops at the rolling revision budget inside the window', async () => {
        const reader = new FakeBacklogIssueReader();
        reader.addIssue(
            openIssue(501, {
                updatedAgoMs: HOUR_MS,
                comments: [
                    reportComment(DIGEST_A, iso(3 * HOUR_MS)),
                    reportComment(DIGEST_B, iso(2 * HOUR_MS)),
                    reportComment(DIGEST_C, iso(HOUR_MS)),
                    commentOf(
                        'maintainer',
                        'Fresh steps below.',
                        iso(30 * 60_000),
                        TrustedRole.Member,
                    ),
                ],
            }),
        );
        reader.addIssue(
            openIssue(502, {
                updatedAgoMs: HOUR_MS,
                comments: [
                    reportComment(DIGEST_B, iso(25 * HOUR_MS)),
                    reportComment(DIGEST_C, iso(2 * HOUR_MS)),
                    reportComment(DIGEST_A, iso(HOUR_MS)),
                    commentOf('maintainer', 'One more run.', iso(30 * 60_000), TrustedRole.Member),
                ],
            }),
        );

        const outcome = await selectBacklogIssues(reader, queueInputs());

        expect(outcome.takenIssueNumbers).toEqual([502]);
        expect(outcome.skippedIssueNumbers[BacklogSkipKind.RevisionBudgetHit]).toEqual([501]);
        expect(outcome.skippedIssueNumbers[BacklogSkipKind.AlreadyReported]).toEqual([]);
    });

    it('ignores an outsider comment for the revision and never carries its text', async () => {
        const reader = new FakeBacklogIssueReader();
        reader.addIssue(
            openIssue(601, {
                updatedAgoMs: DAY_MS,
                comments: [
                    reportComment(DIGEST_A, iso(2 * DAY_MS)),
                    commentOf('drive-by-user', 'OUTSIDER-STILL-BROKEN-FOR-ME', iso(DAY_MS), 'NONE'),
                ],
            }),
        );

        const outcome = await selectBacklogIssues(reader, queueInputs());

        expect(outcome.takenIssueNumbers).toEqual([]);
        expect(outcome.skippedIssueNumbers[BacklogSkipKind.AlreadyReported]).toEqual([601]);
        const serializedOutcome = JSON.stringify(outcome);
        expect(serializedOutcome).not.toContain('OUTSIDER-STILL-BROKEN-FOR-ME');
        expect(serializedOutcome).not.toContain('drive-by-user');
    });

    it('takes a trusted reselect through later outsider comments and never carries their text', async () => {
        const reader = new FakeBacklogIssueReader();
        reader.addIssue(
            openIssue(701, {
                comments: [
                    reportComment(DIGEST_A, iso(2 * DAY_MS)),
                    commentOf('reporter-701', 'Tightened the reproduction steps.', iso(DAY_MS)),
                    commentOf(
                        'passerby-user',
                        'OUTSIDER-AFTER-RESELECT-TEXT',
                        iso(2 * HOUR_MS),
                        'NONE',
                    ),
                ],
            }),
        );

        const outcome = await selectBacklogIssues(reader, queueInputs());

        expect(outcome.takenIssueNumbers).toEqual([701]);
        const serializedOutcome = JSON.stringify(outcome);
        expect(serializedOutcome).not.toContain('OUTSIDER-AFTER-RESELECT-TEXT');
        expect(serializedOutcome).not.toContain('passerby-user');
    });

    it('narrows the selection by the labels and the maximum age', async () => {
        const wantedLabels = ['T: Ads', 'T: Registries'];
        const reader = new FakeBacklogIssueReader();
        reader.addIssue(openIssue(204, { labels: ['T: Ads'], createdAgoMs: 10 * DAY_MS }));
        reader.addIssue(openIssue(203, { labels: [...wantedLabels], createdAgoMs: 10 * DAY_MS }));
        reader.addIssue(openIssue(202, { labels: [...wantedLabels], createdAgoMs: 45 * DAY_MS }));
        reader.addIssue(
            openIssue(201, {
                labels: [...wantedLabels],
                createdAgoMs: 10 * DAY_MS,
                updatedAgoMs: 2 * DAY_MS,
                comments: [reportComment(DIGEST_A, iso(2 * DAY_MS))],
            }),
        );

        const outcome = await selectBacklogIssues(
            reader,
            queueInputs({ narrowing: { labels: [...wantedLabels], maxAgeDays: 30 } }),
        );

        expect(outcome.takenIssueNumbers).toEqual([203]);
        expect(outcome.skippedIssueNumbers[BacklogSkipKind.NarrowedOut]).toEqual([204, 202]);
        expect(outcome.skippedIssueNumbers[BacklogSkipKind.AlreadyReported]).toEqual([201]);
        expect(outcome.skippedIssueNumbers[BacklogSkipKind.RevisionBudgetHit]).toEqual([]);
        // Narrowing applies to summaries alone: the narrowed-out issues are read no further, while
        // the surviving summaries each need their history to decide.
        expect(reader.historyReads).toEqual([203, 201]);
        expect(reader.historyReads).not.toContain(204);
        expect(reader.historyReads).not.toContain(202);
    });

    it('skips an issue carrying an excluded label before reading its history', async () => {
        const reader = new FakeBacklogIssueReader();
        reader.addIssue(openIssue(303, { labels: ['NSFW', 'T: Ads'] }));
        reader.addIssue(openIssue(302, { labels: ['T: Ads'] }));
        reader.addIssue(openIssue(301, { labels: ['nsfw'] }));

        const outcome = await selectBacklogIssues(
            reader,
            queueInputs({ maxIssuesPerRun: 1, excludedLabels: ['NSFW'] }),
        );

        // The excluded issue takes no slot: the one-issue limit still reaches the next issue.
        expect(outcome.takenIssueNumbers).toEqual([302]);
        expect(outcome.skippedIssueNumbers[BacklogSkipKind.ExcludedLabel]).toEqual([303]);
        expect(reader.historyReads).toEqual([302]);
    });
});
