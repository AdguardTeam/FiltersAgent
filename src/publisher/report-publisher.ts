/**
 * Revision-marked report posting of the Publisher.
 *
 * One short report comment per issue carries a hidden revision marker on its first line: the marker
 * binds the comment to one immutable issue revision digest, so a repeated run on the same revision
 * reports `already_reported` without a write while a new revision posts a new report. Existing
 * comments count for dedupe only when their body parses to exactly one valid marker — a malformed,
 * duplicated, or invalid-digest marker is ignored for dedupe and can never block posting or throw.
 *
 * This module performs platform writes only; the comment content itself is rendered by
 * `report-render.ts`, so untrusted model-authored text never reaches a marker position.
 *
 * A marker only counts when it was authored by the run's own identity (see
 * `github/report-author-identity.ts`): on a public repository, anyone can post a comment shaped
 * like the hidden marker, and without an author check that forged comment would be trusted exactly
 * like a real prior report.
 */

import * as v from 'valibot';
import type { Octokit } from '@octokit/rest';

/**
 * Prefix of the hidden revision marker opening every report comment.
 *
 * The reserved `adguard-filters-agent:<name>` marker namespace is covered by
 * `AGENT_CONTROL_MARKER_PATTERN` (`src/github/agent-control-markers.ts`), which stamps all such
 * markers out of untrusted upstream Markdown before it reaches the repository — so a reporter can
 * never forge one, and this marker needs no registry entry of its own.
 */
export const REPORT_COMMENT_MARKER_PREFIX = '<!-- adguard-filters-agent:report ';

/**
 * Shape of one issue revision digest: 64 hexadecimal characters, canonicalized to lowercase like
 * the digest stored on `VerifiedIssueRevision` (`src/local/issue-revision.ts`).
 */
const REVISION_DIGEST_PATTERN = /^[0-9a-f]{64}$/iu;

/**
 * Hidden revision marker payload, parsed exactly: an unknown key turns the marker into untrusted
 * text, so only comments this module (or a byte-compatible predecessor) wrote can dedupe a run.
 */
export const ReportRevisionMarkerSchema = v.strictObject({
    /**
     * The marker contract version, fixed while this vocabulary lives.
     */
    schemaVersion: v.literal(1),

    /**
     * The immutable digest of the issue revision the carrying comment reports.
     */
    revisionDigest: v.pipe(v.string(), v.regex(REVISION_DIGEST_PATTERN)),
});

/**
 * Parsed revision marker of one report comment.
 */
export type ReportRevisionMarker = v.InferOutput<typeof ReportRevisionMarkerSchema>;

/**
 * Scans one comment body for hidden revision markers: any whitespace-tolerant open, the strict JSON
 * payload, and the hidden-comment close. Cloned before every match pass so match state is never
 * shared between calls.
 */
const REPORT_REVISION_MARKER_PATTERN = /<!--\s*adguard-filters-agent:report\s+([\s\S]*?)-->/giu;

/**
 * How much of an oversized composed comment body is left unsaid: the exact GitHub platform limit,
 * refused without margin — a smaller cap silently drops reportable evidence, a larger one turns
 * into a failed API write.
 */
const MAX_COMMENT_BODY_CHARACTERS = 65_536;

/**
 * Comments per page of an existing-comment scan, one page at a time so an unbounded issue never
 * loads boundedly; 100 is GitHub's maximum page size.
 */
const COMMENT_PAGE_SIZE = 100;

/**
 * Outcome of the report publication.
 */
export const ReportPublishAction = {
    /**
     * A new report comment was created.
     */
    Posted: 'posted',

    /**
     * A report for the same revision already exists; nothing was written.
     */
    AlreadyReported: 'already_reported',
} as const;

/**
 * ReportPublishAction value.
 */
export type ReportPublishAction = (typeof ReportPublishAction)[keyof typeof ReportPublishAction];

/**
 * The failure kinds of the report publication contract.
 */
export const ReportPublishErrorKind = {
    /**
     * The composed marker-plus-body exceeds GitHub's comment-body limit.
     */
    CommentBodyTooLarge: 'comment-body-too-large',
} as const;

/**
 * ReportPublishErrorKind value.
 */
export type ReportPublishErrorKind =
    (typeof ReportPublishErrorKind)[keyof typeof ReportPublishErrorKind];

/**
 * A report publication refused before a write, classified so the caller maps it onto the failed run
 * without classifying exception strings.
 */
export class ReportPublishError extends Error {
    /**
     * Which publication contract clause was violated.
     */
    readonly kind: ReportPublishErrorKind;

    constructor(kind: ReportPublishErrorKind, message: string) {
        super(message);
        this.name = 'ReportPublishError';
        this.kind = kind;
    }
}

/**
 * Target issue and content of one revision-marked report publication.
 */
export interface ReportPublishInput {
    /**
     * Repository owner.
     */
    owner: string;

    /**
     * Repository name.
     */
    repo: string;

    /**
     * Issue that receives the report comment.
     */
    issueNumber: number;

    /**
     * Digest of the issue revision the run produced — the dedupe identity.
     */
    revisionDigest: string;

    /**
     * Markdown report body without the hidden marker; the marker is composed by the publisher.
     */
    body: string;

    /**
     * The GitHub login authoritative for this run's own markers (see
     * `github/report-author-identity.ts`); an existing comment only counts as a prior report when
     * it was posted by this exact login.
     */
    reportAuthorLogin: string;

    /**
     * Produces the body actually posted, called only once no comment reports the revision; absent
     * means `body` posts as is. It is the hook for content with a side effect of its own, such as
     * hosted screenshots, so a run that reports nothing new writes nothing anywhere.
     */
    finalizeBody?: () => Promise<string>;
}

/**
 * Result of one report publication.
 */
export interface ReportPublishResult {
    /**
     * Whether a new comment was written or an existing one was reused.
     */
    action: ReportPublishAction;

    /**
     * Browser URL of the comment carrying the report.
     */
    commentUrl: string;

    /**
     * Numeric comment identity, when the platform returned one.
     */
    commentId?: number;
}

/**
 * Render the hidden revision marker stored as the first line of a report comment.
 *
 * The digest is canonicalized to lowercase before validation so the rendered marker always matches
 * the canonical digest identity of the revision that produced it.
 *
 * @param marker - Revision identity to bind into the marker.
 * @returns The hidden canonical marker.
 */
export function renderReportRevisionMarker(marker: ReportRevisionMarker): string {
    const canonical = v.parse(ReportRevisionMarkerSchema, {
        schemaVersion: 1,
        revisionDigest: marker.revisionDigest.toLowerCase(),
    });
    return `${REPORT_COMMENT_MARKER_PREFIX}${JSON.stringify(canonical)} -->`;
}

/**
 * Extract the strict payload of one unique revision marker from a comment body.
 *
 * Contract: a body counts for dedupe only when its body carries exactly one marker that parses and
 * validates against `ReportRevisionMarkerSchema`. A body with no marker, with several (ambiguity is
 * never resolved), or whose single marker is malformed or outside the schema yields null. Tolerance
 * is the contract here, not an error path being swallowed: foreign comments share the issue thread
 * by design, so absent authoritative state is the expected steady behavior and is never logged.
 *
 * @param body - Existing comment body as returned by the platform, or undefined when it carried
 *   none.
 * @returns The parsed marker with a canonical lowercase digest, or null when the body is not an
 *   authoritative revision report.
 */
export function parseReportRevisionMarker(
    body: string | null | undefined,
): ReportRevisionMarker | null {
    if (body === null || body === undefined) {
        return null;
    }
    const matches = [
        ...body.matchAll(
            new RegExp(REPORT_REVISION_MARKER_PATTERN.source, REPORT_REVISION_MARKER_PATTERN.flags),
        ),
    ];
    if (matches.length !== 1) {
        return null;
    }
    const payload = matches[0]?.[1]?.trim();
    if (payload === undefined || payload.length === 0) {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(payload);
    } catch {
        return null;
    }
    const validated = v.safeParse(ReportRevisionMarkerSchema, parsed);
    if (!validated.success) {
        return null;
    }
    return {
        ...validated.output,
        revisionDigest: validated.output.revisionDigest.toLowerCase(),
    };
}

/**
 * Check whether one existing comment was authored by the run's own report-author identity.
 *
 * @param author - The comment's author login, as the platform returned it (nullable/absent).
 * @param reportAuthorLogin - The login authoritative for this run's own markers.
 * @returns True when the comment could carry a trustworthy marker.
 */
function isOwnReportComment(author: string | null | undefined, reportAuthorLogin: string): boolean {
    return (author ?? '').trim().toLowerCase() === reportAuthorLogin.trim().toLowerCase();
}

/**
 * The issue and revision a report lookup searches for.
 */
export type RevisionReportTarget = Pick<
    ReportPublishInput,
    'owner' | 'repo' | 'issueNumber' | 'revisionDigest' | 'reportAuthorLogin'
>;

/**
 * Find the comment that already reports one issue revision.
 *
 * Existing comments are scanned one set-per-page at a time (`per_page: 100`); the first comment
 * authored by `target.reportAuthorLogin` whose parsed marker digest equals the revision is the
 * prior report and ends the scan — a marker on a comment from any other author is never trusted,
 * since anyone can post one on a public issue.
 *
 * @param octokit - Authenticated GitHub API client.
 * @param target - Issue, revision digest and the run's own report-author login.
 * @returns The prior report as an `already_reported` result, or null when none reports the
 *   revision.
 */
export async function findRevisionReport(
    octokit: Octokit,
    target: RevisionReportTarget,
): Promise<ReportPublishResult | null> {
    const revisionDigest = target.revisionDigest.toLowerCase();
    let page = 1;
    while (true) {
        const response = await octokit.rest.issues.listComments({
            owner: target.owner,
            repo: target.repo,
            issue_number: target.issueNumber,
            per_page: COMMENT_PAGE_SIZE,
            page,
        });
        for (const comment of response.data) {
            if (!isOwnReportComment(comment.user?.login, target.reportAuthorLogin)) {
                continue;
            }
            const marker = parseReportRevisionMarker(comment.body ?? null);
            if (marker !== null && marker.revisionDigest === revisionDigest) {
                return {
                    action: ReportPublishAction.AlreadyReported,
                    commentUrl: comment.html_url,
                    commentId: comment.id,
                };
            }
        }
        if (response.data.length < COMMENT_PAGE_SIZE) {
            return null;
        }
        page += 1;
    }
}

/**
 * Compose the posted comment body: the hidden marker on the first line, the report beneath.
 *
 * @param revisionDigest - Canonical lowercase digest of the reported issue revision.
 * @param body - Markdown report body without the marker.
 * @returns The marker-plus-body comment text.
 * @throws ReportPublishError When the composed body exceeds GitHub's comment limit.
 */
function composeMarkedBody(revisionDigest: string, body: string): string {
    const marked = `${renderReportRevisionMarker({ schemaVersion: 1, revisionDigest })}\n${body}`;
    if (marked.length > MAX_COMMENT_BODY_CHARACTERS) {
        throw new ReportPublishError(
            ReportPublishErrorKind.CommentBodyTooLarge,
            `Report comment body is ${marked.length} characters; GitHub comments allow at most ` +
                `${MAX_COMMENT_BODY_CHARACTERS}`,
        );
    }
    return marked;
}

/**
 * Publish the run's report once per issue revision.
 *
 * The composed body (marker on the first line, Markdown report beneath) is size-guarded against
 * GitHub's comment limit before any API call. A prior report of the same revision (see
 * `findRevisionReport`) is returned as is; only when no comment reports the revision is a new
 * comment posted, with the body `finalizeBody` returns when the caller gave one; the size guard
 * checks both bodies. Platform failures propagate unswallowed — classifying them as infrastructure
 * failures for the run is the caller's contract.
 *
 * @param octokit - Authenticated GitHub API client.
 * @param input - Target issue, revision digest, Markdown report body, and the run's own
 *   report-author login.
 * @returns The publication action and the comment identity for both outcomes.
 */
export async function publishReportOnce(
    octokit: Octokit,
    input: ReportPublishInput,
): Promise<ReportPublishResult> {
    const revisionDigest = input.revisionDigest.toLowerCase();
    composeMarkedBody(revisionDigest, input.body);

    const reported = await findRevisionReport(octokit, { ...input, revisionDigest });
    if (reported !== null) {
        return reported;
    }

    const finalBody = input.finalizeBody === undefined ? input.body : await input.finalizeBody();
    const created = await octokit.rest.issues.createComment({
        owner: input.owner,
        repo: input.repo,
        issue_number: input.issueNumber,
        body: composeMarkedBody(revisionDigest, finalBody),
    });
    return {
        action: ReportPublishAction.Posted,
        commentUrl: created.data.html_url,
        commentId: created.data.id,
    };
}
