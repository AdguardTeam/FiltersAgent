import { matchingNames } from '../github/github-name-list';
import { parseReportRevisionMarker } from '../publisher/report-publisher';
import {
    BacklogIssueComment,
    BacklogIssueHistory,
    BacklogIssueReader,
    BacklogIssueSummary,
} from './backlog-reader';
import { QueueInputs } from './queue-inputs';

/**
 * Per-issue selection derivation for backlog mode.
 *
 * With no state store, an open issue is due for processing when it carries no revision-marked
 * report, or when a trusted revision-change signal follows its latest report — and never while its
 * rolling revision budget is spent. The only inputs are the narrow reader's two reads and the
 * validated queue inputs; the derivation is pure over them, so a repeated call against an unchanged
 * repository returns the same selection. Outcomes carry issue numbers and skip names only — comment
 * bodies and author logins never leave the derivation.
 */

/**
 * Stable skip classes behind the issues one backlog run left untaken.
 *
 * Selection never fails on a skipped candidate; a skip is only a tally entry for the run log.
 */
export const BacklogSkipKind = {
    /**
     * The issue already carries a revision-marked report and no trusted signal reselects it.
     */
    AlreadyReported: 'already_reported',

    /**
     * Enough revision-marked reports lie inside the rolling window before `capturedAt` that the
     * issue's revision budget is spent, even when a trusted signal would otherwise reselect it.
     */
    RevisionBudgetHit: 'revision_budget_hit',

    /**
     * The instruction's selection section (labels, maximum age) narrows the issue out before its
     * history is read.
     */
    NarrowedOut: 'narrowed_out',

    /**
     * The issue carries a label the run excludes; its history is never read.
     */
    ExcludedLabel: 'excluded_label',
} as const;

/**
 * BacklogSkipKind value.
 */
export type BacklogSkipKind = (typeof BacklogSkipKind)[keyof typeof BacklogSkipKind];

/**
 * The visited issues one run skipped before taking them, keyed by why each was left behind.
 */
export type BacklogSkipTally = Record<BacklogSkipKind, number[]>;

/**
 * Outcome of one backlog selection.
 */
export interface BacklogSelectionOutcome {
    /**
     * The issues taken, in the run's newest-first visit order.
     */
    takenIssueNumbers: number[];

    /**
     * The visited issues skipped instead of taken, keyed by skip class.
     */
    skippedIssueNumbers: BacklogSkipTally;
}

/**
 * Per-issue selection verdict: null when the run takes the issue, else the skip class to tally.
 */
type IssueVerdict = BacklogSkipKind | null;

/**
 * Milliseconds in one conversion day for the maximum-age cutoff.
 *
 * Why 24 h: the instruction's `max-age-days` counts plain 24-hour days, so fractional days convert
 * linearly instead of through calendar DST arithmetic.
 */
const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Build a zero skip tally that each skipped visit appends to.
 *
 * @returns A tally with an empty list per skip class.
 */
function emptySkipTally(): BacklogSkipTally {
    return {
        [BacklogSkipKind.AlreadyReported]: [],
        [BacklogSkipKind.RevisionBudgetHit]: [],
        [BacklogSkipKind.NarrowedOut]: [],
        [BacklogSkipKind.ExcludedLabel]: [],
    };
}

/**
 * Decide whether one open-issue summary falls out under the instruction's narrowing, reading no
 * history.
 *
 * Contract: the labels item requires the issue to carry every listed label; the maximum-age item
 * requires the issue to be created no earlier than the cutoff (`capturedAt` minus the age). An
 * omitted narrowing survives everything, and the summary alone decides — the per-issue history is
 * read only after the narrowing passed.
 *
 * @param summary - The open-issue summary as listed.
 * @param narrowing - The instruction's selection narrowing, or undefined when unset.
 * @param capturedAt - The run's clock capture, anchoring the maximum-age cutoff.
 * @returns The summary's skip class, or null when it survived the narrowing.
 */
function narrowedOutKindOf(
    summary: BacklogIssueSummary,
    narrowing: QueueInputs['narrowing'],
    capturedAt: string,
): IssueVerdict {
    if (narrowing === undefined) {
        return null;
    }
    if (narrowing.labels !== undefined) {
        const carriedLabels = new Set(summary.labels);
        if (!narrowing.labels.every((label) => carriedLabels.has(label))) {
            return BacklogSkipKind.NarrowedOut;
        }
    }
    const maxAgeDays = narrowing.maxAgeDays;
    if (maxAgeDays !== undefined) {
        const oldestAllowedAtMs = Date.parse(capturedAt) - maxAgeDays * MS_PER_DAY;
        if (Date.parse(summary.createdAt) < oldestAllowedAtMs) {
            return BacklogSkipKind.NarrowedOut;
        }
    }
    return null;
}

/**
 * Decide whether one comment could carry a trustworthy revision-marked report.
 *
 * A marker's presence is not enough on a public repository: anyone can post a comment shaped like
 * the hidden marker, so only a comment authored by the run's own resolved identity (see
 * `github/report-author-identity.ts`) may ever count as a report for dedupe or budget purposes.
 *
 * @param comment - One mapped issue comment.
 * @param reportAuthorLogin - The login authoritative for this run's own markers.
 * @returns True when the comment's author is this run's own report-posting identity.
 */
function isOwnReportComment(comment: BacklogIssueComment, reportAuthorLogin: string): boolean {
    return comment.author.trim().toLowerCase() === reportAuthorLogin.trim().toLowerCase();
}

/**
 * Decide whether one comment carries a trusted author.
 *
 * Contract: the issue's reporter is always trusted, and the comment's optional `author_association`
 * is trusted when the uppercased value is in the configured trusted roles. Logins compare
 * case-insensitively; an absent association is simply untrusted, so trust fails closed.
 *
 * @param comment - One mapped issue comment.
 * @param history - The comment's issue history, whose summary carries the reporter login.
 * @param trustedRoles - The configured trusted associations.
 * @returns True when the comment's author is trusted to change the issue revision.
 */
function isTrustedCommentAuthor(
    comment: BacklogIssueComment,
    history: BacklogIssueHistory,
    trustedRoles: QueueInputs['trustedRoles'],
): boolean {
    const authorLogin = comment.author.toLowerCase();
    if (authorLogin.length > 0 && authorLogin === history.summary.reporterAuthor.toLowerCase()) {
        return true;
    }
    const association = (comment.authorAssociation ?? '').toUpperCase();
    return (trustedRoles as readonly string[]).includes(association);
}

/**
 * Derive one visited issue's selection verdict from its full history.
 *
 * Contract: a revision-marked report is a comment authored by `inputs.reportAuthorLogin` whose body
 * parses to exactly one valid marker — a marker on a comment from any other author is never
 * trusted, since anyone can post one on a public issue. An issue with none is never reported and is
 * taken at once. Enough reports inside the rolling window before `capturedAt` (created at or after
 * the window's start) stop the issue outright even when a trusted signal follows them. Else a
 * comment by a trusted author — the reporter or a trusted association — created after the latest
 * report or last edited after it reselects the issue as a new revision. Else an `issue.updated_at`
 * newer than the latest report and than every comment's timestamps — a body edit no comment
 * explains — reselects it too. Anything else stays behind as already reported.
 *
 * @param history - The visited issue's summary, reporter, and ordered comment history.
 * @param inputs - Validated queue inputs carrying the window and budget bounds.
 * @returns The issue's skip class, or null when the run takes it.
 */
function issueVerdictOf(history: BacklogIssueHistory, inputs: QueueInputs): IssueVerdict {
    let latestReportMs: number | null = null;
    let inWindowReportCount = 0;
    let latestCommentMs = 0;
    const windowStartMs = Date.parse(inputs.capturedAt) - inputs.revisionWindowMs;
    for (const comment of history.comments) {
        const commentMs = Math.max(Date.parse(comment.createdAt), Date.parse(comment.updatedAt));
        if (commentMs > latestCommentMs) {
            latestCommentMs = commentMs;
        }
        if (!isOwnReportComment(comment, inputs.reportAuthorLogin)) {
            continue;
        }
        if (parseReportRevisionMarker(comment.body) === null) {
            continue;
        }
        const reportedMs = Date.parse(comment.createdAt);
        if (reportedMs >= windowStartMs) {
            inWindowReportCount += 1;
        }
        if (latestReportMs === null || reportedMs > latestReportMs) {
            latestReportMs = reportedMs;
        }
    }
    if (latestReportMs === null) {
        return null;
    }
    const latestReportedAtMs: number = latestReportMs;
    if (inWindowReportCount >= inputs.maxRevisionsPerWindow) {
        return BacklogSkipKind.RevisionBudgetHit;
    }
    const trustedCommentAfterReport = history.comments.some(
        (comment) =>
            isTrustedCommentAuthor(comment, history, inputs.trustedRoles) &&
            (Date.parse(comment.createdAt) > latestReportedAtMs ||
                Date.parse(comment.updatedAt) > latestReportedAtMs),
    );
    if (trustedCommentAfterReport) {
        return null;
    }
    const updatedAtMs = Date.parse(history.summary.updatedAt);
    if (updatedAtMs > latestReportedAtMs && updatedAtMs > latestCommentMs) {
        return null;
    }
    return BacklogSkipKind.AlreadyReported;
}

/**
 * Select the issues one backlog run processes.
 *
 * Contract: the open-issue listing is requested page by page, starting at page 1, and the run
 * visits the summaries in newest-first order, taking at most `maxIssuesPerRun` issues. The excluded
 * labels and the instruction's narrowing decide on summaries alone before any history read; every
 * surviving summary has its history read and its due-for-processing verdict derived statelessly.
 * The moment the take limit holds, no further page is requested — later issues are left for the
 * next run and appear in neither list. A page is followed by the next only while it reports more.
 *
 * The listed summary is what a history read is asked for, not an issue number: the listing already
 * carries every issue-level fact the derivation reads, so a visited issue never costs a second
 * request for them.
 *
 * @param reader - The backlog module's whole GitHub read surface.
 * @param inputs - Validated queue inputs; applying the defaults is the caller's responsibility.
 * @returns The taken issue numbers newest first, and the skip tally.
 * @throws {@link BacklogIssueReadError} When a page read or a per-issue history read fails.
 */
export async function selectBacklogIssues(
    reader: BacklogIssueReader,
    inputs: QueueInputs,
): Promise<BacklogSelectionOutcome> {
    const taken: number[] = [];
    const skipped = emptySkipTally();
    for (let page = 1; taken.length < inputs.maxIssuesPerRun; page += 1) {
        const { summaries, hasMore } = await reader.readOpenIssuePage(page);
        for (const summary of summaries) {
            if (taken.length >= inputs.maxIssuesPerRun) {
                break;
            }
            if (matchingNames(summary.labels, inputs.excludedLabels).length > 0) {
                skipped[BacklogSkipKind.ExcludedLabel].push(summary.issueNumber);
                continue;
            }
            const narrowedOut = narrowedOutKindOf(summary, inputs.narrowing, inputs.capturedAt);
            if (narrowedOut !== null) {
                skipped[narrowedOut].push(summary.issueNumber);
                continue;
            }
            const verdict = issueVerdictOf(await reader.readIssueHistory(summary), inputs);
            if (verdict === null) {
                taken.push(summary.issueNumber);
                continue;
            }
            skipped[verdict].push(summary.issueNumber);
        }
        if (!hasMore) {
            break;
        }
    }
    return { takenIssueNumbers: taken, skippedIssueNumbers: skipped };
}
