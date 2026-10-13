import * as v from 'valibot';

/**
 * Mapped response vocabulary for the backlog GitHub seam.
 *
 * Backlog selection consumes only this shape: open-issue summaries, per-issue comment entries, and
 * the composite history derivation input. Raw GitHub REST items are mapped here at the seam — label
 * objects beside plain names, missing logins and bodies to empties, absent author associations to
 * null — before schema validation admits them. How the reads travel and how failures map to typed
 * errors live with the transport adapter in `backlog-reader.ts`; nothing here handles transport.
 */

/**
 * Label object form GitHub returns beside the plain-name form.
 */
export interface GithubLabelObject {
    /**
     * Label name, when the label carries one.
     */
    name?: string | null;
}

/**
 * Stable GitHub login carrier shared by issue and comment authors.
 */
export interface GithubLoginCarrier {
    /**
     * Stable GitHub login.
     */
    login?: string | null;
}

/**
 * Minimal GitHub REST issue item the listing and history maps consume.
 */
export interface GithubIssueItem {
    /**
     * Stable GitHub issue number.
     */
    number: number;

    /**
     * Immutable creation timestamp.
     */
    created_at: string;

    /**
     * Last-update timestamp; a body edit by a trusted role moves it without any event source.
     */
    updated_at: string;

    /**
     * Author of the issue; its login is the reporter.
     */
    user?: GithubLoginCarrier | null;

    /**
     * Labels; entries arrive either as label objects or plain names depending on the media type.
     */
    labels?: ReadonlyArray<GithubLabelObject | string> | null;

    /**
     * How many comments the issue carries; GitHub returns it on every listed item, so the listing
     * alone decides whether a comment read is worth a request.
     */
    comments: number;

    /**
     * Present exactly on pull-request items, which the issues endpoint also returns.
     */
    pull_request?: unknown;
}

/**
 * Minimal GitHub REST comment item the history map consumes.
 */
export interface GithubCommentItem {
    /**
     * Comment author; its login is the comment's author.
     */
    user?: GithubLoginCarrier | null;

    /**
     * Comment text.
     */
    body?: string | null;

    /**
     * Immutable creation timestamp.
     */
    created_at: string;

    /**
     * Last-edited timestamp.
     */
    updated_at: string;

    /**
     * Author association; unknown logins arrive as NONE and are simply untrusted.
     */
    author_association?: string | null;
}

/**
 * Valibot schema for one open issue as backlog selection consumes it.
 */
export const BacklogIssueSummarySchema = v.strictObject({
    issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
    createdAt: v.pipe(v.string(), v.isoTimestamp()),
    updatedAt: v.pipe(v.string(), v.isoTimestamp()),
    labels: v.array(v.string()),
    reporterAuthor: v.string(),
    commentCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

/**
 * One open issue summary returned by the newest-first listing.
 *
 * It carries everything the selection derivation reads about the issue itself — dates, labels, the
 * reporter login and the comment count — so a visited issue costs no second request for the same
 * facts.
 */
export type BacklogIssueSummary = v.InferOutput<typeof BacklogIssueSummarySchema>;

/**
 * Valibot schema for one issue comment as the trusted-history derivation consumes it.
 */
export const BacklogIssueCommentSchema = v.strictObject({
    author: v.string(),
    body: v.string(),
    createdAt: v.pipe(v.string(), v.isoTimestamp()),
    updatedAt: v.pipe(v.string(), v.isoTimestamp()),
    authorAssociation: v.nullable(v.string()),
});

/**
 * One issue comment mapped at the seam; every body rides in full, derivation decides visibility.
 */
export type BacklogIssueComment = v.InferOutput<typeof BacklogIssueCommentSchema>;

/**
 * Valibot schema for one issue's trusted-history derivation input.
 */
export const BacklogIssueHistorySchema = v.strictObject({
    summary: BacklogIssueSummarySchema,
    comments: v.array(BacklogIssueCommentSchema),
});

/**
 * One issue's listed summary — the reporter login included — and its ordered comment history.
 */
export type BacklogIssueHistory = v.InferOutput<typeof BacklogIssueHistorySchema>;

/**
 * Map one GitHub issue item into a raw summary pre-validation.
 *
 * @param item - GitHub issue item as listed.
 * @returns The raw summary fields.
 */
export function mapGithubIssueToSummary(item: GithubIssueItem): BacklogIssueSummary {
    return {
        issueNumber: item.number,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        labels: (item.labels ?? [])
            .map((label) => (typeof label === 'string' ? label : label.name))
            .filter((name): name is string => Boolean(name)),
        reporterAuthor: item.user?.login ?? '',
        commentCount: item.comments,
    };
}

/**
 * Map one GitHub comment item into a raw history entry pre-validation.
 *
 * @param item - GitHub comment item as listed.
 * @returns The raw comment fields; a missing association arrives as null.
 */
export function mapGithubCommentToEntry(item: GithubCommentItem): BacklogIssueComment {
    return {
        author: item.user?.login ?? '',
        body: item.body ?? '',
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        authorAssociation: item.author_association ?? null,
    };
}
