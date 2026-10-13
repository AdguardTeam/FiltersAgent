import {
    GENERATED_COMMENT_MARKER_PREFIX_VALUES,
    GENERATED_COMMENT_MARKER_VALUES,
} from './generated-comment-markers';
import { StructuredReportHeadingPattern } from './structured-report-template';

/**
 * Minimal comment shape accepted by the shared prompt-safety policy.
 */
export interface PromptSafetyComment {
    /**
     * Immutable GitHub login associated with the comment.
     */
    author: string;

    /**
     * Untrusted comment Markdown.
     */
    body: string;

    /**
     * The comment author's GitHub association with the repository, when known — the same signal
     * backlog selection trusts to recognize a maintainer's revision-changing comment.
     */
    authorAssociation?: string;
}

/**
 * Optional trusted evidence classes accepted beside comments from the immutable reporter.
 */
export interface PromptSafetySelectionOptions {
    /**
     * Preserve complete issue-intake reports posted by AdGuard's trusted automation account.
     */
    includeStructuredIssueReports?: boolean;

    /**
     * GitHub author associations (e.g. `OWNER`, `MEMBER`, `COLLABORATOR`) trusted beside the
     * reporter, compared case-insensitively against each comment's `authorAssociation`. Absent
     * means no association is trusted, matching the historical reporter-only contract.
     */
    trustedRoles?: readonly string[];
}

/**
 * Character and comment limits applied before reporter text reaches an automatic agent run.
 */
export interface PromptTextLimits {
    /**
     * Maximum characters retained from the issue body, including any truncation notice.
     */
    maxBodyCharacters: number;

    /**
     * Maximum reporter comments retained across the beginning and end of the history.
     */
    maxCommentCount: number;

    /**
     * Maximum characters retained from any one reporter comment.
     */
    maxCommentCharacters: number;

    /**
     * Maximum combined characters retained across all reporter comment bodies.
     */
    maxTotalCommentCharacters: number;

    /**
     * Hard pre-truncation text ceiling after which automatic intake rejects the revision.
     */
    maxRawCharacters: number;
}

/**
 * Minimal complete raw comment text counted by the shared hard-limit policy.
 */
export interface RawPromptTextComment {
    /**
     * Complete unfiltered comment body returned by the source adapter.
     */
    body?: string | null;
}

/**
 * Complete unfiltered issue history counted before any prompt-safe projection.
 */
export interface RawPromptTextInput {
    /**
     * Complete unfiltered issue body.
     */
    body?: string | null;

    /**
     * Complete unfiltered comment history.
     */
    comments: readonly RawPromptTextComment[];
}

/**
 * Soft and hard text bounds shared by every automatic issue-ingestion path.
 */
export const AUTOMATIC_UPSTREAM_PROMPT_TEXT_LIMITS: Readonly<PromptTextLimits> = Object.freeze({
    maxBodyCharacters: 24_000,
    maxCommentCount: 12,
    maxCommentCharacters: 8_000,
    maxTotalCommentCharacters: 16_000,
    maxRawCharacters: 256_000,
});

/**
 * Reporter text accepted by the deterministic prompt-boundary helper.
 */
export interface PromptTextInput<TComment extends PromptSafetyComment> {
    /**
     * Marker-free issue body.
     */
    body: string | null;

    /**
     * Already selected prompt-safe reporter comments in chronological order.
     */
    comments: readonly TComment[];

    /**
     * Canonical upstream issue URL linked from every truncation notice.
     */
    sourceUrl: string;
}

/**
 * Bounded reporter text and diagnostics describing the deterministic reduction.
 */
export interface BoundedPromptText<TComment extends PromptSafetyComment> {
    /**
     * Bounded issue body, or null when the original body was null and no notice was needed.
     */
    body: string | null;

    /**
     * Bounded cloned comments selected from the start and end of the reporter history.
     */
    comments: TComment[];

    /**
     * Number of prompt-safe reporter comments omitted by the count limit.
     */
    omittedCommentCount: number;

    /**
     * Pre-truncation characters across the body and prompt-safe comment bodies.
     */
    rawCharacterCount: number;

    /**
     * Whether any body text, comment text, or complete comment was omitted.
     */
    truncated: boolean;
}

/**
 * GitHub accounts allowed to relay a structured user issue submission.
 */
const STRUCTURED_REPORT_AUTHORS = new Set(['adguard-bot', 'adguard-bot[bot]']);

/**
 * Generated or oracle markers that must never cross the model-input boundary.
 *
 * This is the strictest exclusion list in the repository: it covers the complete generated-marker
 * vocabulary, so a marker added to it is withheld from every prompt without a second edit here.
 */
const PROMPT_EXCLUDED_MARKERS: readonly string[] = [
    ...GENERATED_COMMENT_MARKER_PREFIX_VALUES,
    ...GENERATED_COMMENT_MARKER_VALUES,
];

/**
 * Explicit AdGuard cosmetic-rule operators that identify solution material in a comment line.
 */
const COSMETIC_RULE_PATTERN =
    /(?:^|\s)(?:[-*]\s+|`{1,3})?(?:[^\s#`,]+(?:,[^\s#`,]+)*)?(?:##|#@#|#\$#|#\$@#|#\?#|#@\?#|#%#|#@%#)\s*\S+/iu;

/**
 * Explicit AdGuard network-rule syntax that identifies solution material in a comment line.
 */
const NETWORK_RULE_PATTERN = /(?:^|\s)(?:[-*]\s+|`{1,3})?(?:@@)?\|\|[^\s|]+(?:\^|\$\S*)/iu;

/**
 * GitHub commit references that can disclose a historical human solution.
 */
const COMMIT_REFERENCE_PATTERN =
    /(?:github\.com\/[^\s/]+\/[^\s/]+\/commit\/[0-9a-f]{7,40}\b|\bcommit(?:ted)?(?:\s+in)?\s*[:#]?\s*[0-9a-f]{7,40}\b)/iu;

/**
 * Pull-request references that can disclose a historical human solution.
 */
const PULL_REQUEST_REFERENCE_PATTERN =
    /(?:github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+\b|\b(?:pr|pull\s+request)\s*#?\d+\b)/iu;

/**
 * Positive solution phrases narrow enough not to match a reporter saying a problem is not fixed.
 */
const FIXED_WITH_PATTERN = /\b(?:fixed|resolved|solved|implemented)\s+(?:with|by|in|via|using)\b/iu;

/**
 * Explicit language showing that a reporter-provided rule is negative diagnostic evidence.
 */
const FAILED_RULE_DIAGNOSTIC_PATTERN =
    /\b(?:did\s+not\s+help|does\s+not\s+(?:help|work)|do\s+not\s+(?:help|work)|didn't\s+(?:help|work)|doesn't\s+(?:help|work)|not\s+working|rule\s+failed|still\s+(?:visible|present|shown|blocked)|(?:wall|banner|ad|advert|problem|issue)\s+(?:still\s+)?remains)\b/iu;

/**
 * Validate one integer character/count limit.
 *
 * @param value - Candidate limit.
 * @param name - Stable property name used in diagnostics.
 * @returns The validated positive safe integer.
 */
function positiveLimit(value: number, name: keyof PromptTextLimits): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive safe integer.`);
    }
    return value;
}

/**
 * Enforce the shared hard character limit against complete unfiltered issue history.
 *
 * @param input - Complete raw body and comments before prompt-safe selection.
 * @param limits - Shared prompt limits containing the hard raw ceiling.
 * @returns Complete UTF-16 character count when it is within the hard limit.
 */
export function assertRawPromptTextWithinLimit(
    input: RawPromptTextInput,
    limits: PromptTextLimits,
): number {
    const maxRawCharacters = positiveLimit(limits.maxRawCharacters, 'maxRawCharacters');
    const rawCharacterCount =
        (input.body?.length ?? 0) +
        input.comments.reduce((total, comment) => total + (comment.body?.length ?? 0), 0);
    if (rawCharacterCount > maxRawCharacters) {
        throw new Error(
            `Raw prompt text contains ${rawCharacterCount} characters; automatic intake allows ` +
                `at most ${maxRawCharacters}.`,
        );
    }
    return rawCharacterCount;
}

/**
 * Normalize an upstream URL before embedding it in inert Markdown.
 *
 * @param sourceUrl - Canonical issue URL supplied by the trusted GitHub adapter.
 * @returns HTTPS URL without credentials or a fragment.
 */
function safeSourceUrl(sourceUrl: string): string {
    const url = new URL(sourceUrl);
    if (
        url.protocol !== 'https:' ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.port.length > 0
    ) {
        throw new Error('Prompt truncation sourceUrl must be a credential-free HTTPS URL.');
    }
    url.hash = '';
    return url.href.replaceAll(')', '%29');
}

/**
 * Render a stable explanation that points maintainers and the model to the complete report.
 *
 * @param action - Description of the information removed by the automatic bound.
 * @param sourceUrl - Normalized upstream issue URL.
 * @returns Markdown blockquote suitable for a body or comment.
 */
function truncationNotice(action: string, sourceUrl: string): string {
    return (
        `> Automatic intake ${action} to keep this agent run bounded. ` +
        `[Open the complete upstream issue](${sourceUrl}).`
    );
}

/**
 * Keep the beginning and end of one text section around an explicit truncation notice.
 *
 * @param text - Original prompt-safe Markdown.
 * @param maxCharacters - Maximum resulting UTF-16 character count.
 * @param notice - Complete upstream-link notice inserted between retained excerpts.
 * @returns Original text when already bounded, otherwise a head/tail excerpt with the notice.
 */
function truncatePromptSection(text: string, maxCharacters: number, notice: string): string {
    if (text.length <= maxCharacters) {
        return text;
    }
    const separator = `\n\n${notice}\n\n`;
    const excerptCharacters = maxCharacters - separator.length;
    if (excerptCharacters < 2) {
        throw new Error('Prompt text limits are too small to retain the truncation source link.');
    }
    const headCharacters = Math.ceil(excerptCharacters * 0.6);
    const tailCharacters = excerptCharacters - headCharacters;
    const head = text.slice(0, headCharacters).trimEnd();
    const tail = text.slice(text.length - tailCharacters).trimStart();
    return `${head}${separator}${tail}`.slice(0, maxCharacters);
}

/**
 * Retain a stable window containing both initial configuration and latest reporter updates.
 *
 * @param comments - Prompt-safe comments in chronological order.
 * @param maxCommentCount - Maximum comments retained.
 * @returns Cloned references selected from the beginning and end without duplicates.
 */
function selectBoundedCommentWindow<TComment extends PromptSafetyComment>(
    comments: readonly TComment[],
    maxCommentCount: number,
): TComment[] {
    if (comments.length <= maxCommentCount) {
        return [...comments];
    }
    const firstCount = Math.ceil(maxCommentCount / 2);
    const lastCount = maxCommentCount - firstCount;
    return [
        ...comments.slice(0, firstCount),
        ...(lastCount === 0 ? [] : comments.slice(-lastCount)),
    ];
}

/**
 * Bound already prompt-safe reporter text without mutating its comments.
 *
 * Small inputs are returned byte-for-byte unchanged. Large inputs retain issue configuration plus
 * both early and latest reporter context. Every omission is explicit and links to the complete
 * upstream report. Image discovery must happen from the unbounded safe source before this helper is
 * applied, so omitted Markdown never hides a reporter screenshot from the agent.
 *
 * @param input - Marker-free body, selected safe comments, and canonical source URL.
 * @param limits - Deterministic automatic intake limits.
 * @returns Bounded cloned text and truncation diagnostics.
 */
export function boundPromptText<TComment extends PromptSafetyComment>(
    input: PromptTextInput<TComment>,
    limits: PromptTextLimits,
): BoundedPromptText<TComment> {
    const maxBodyCharacters = positiveLimit(limits.maxBodyCharacters, 'maxBodyCharacters');
    const maxCommentCount = positiveLimit(limits.maxCommentCount, 'maxCommentCount');
    const maxCommentCharacters = positiveLimit(limits.maxCommentCharacters, 'maxCommentCharacters');
    const maxTotalCommentCharacters = positiveLimit(
        limits.maxTotalCommentCharacters,
        'maxTotalCommentCharacters',
    );
    positiveLimit(limits.maxRawCharacters, 'maxRawCharacters');
    const sourceUrl = safeSourceUrl(input.sourceUrl);
    const selectedComments = selectBoundedCommentWindow(input.comments, maxCommentCount);
    const omittedCommentCount = input.comments.length - selectedComments.length;
    const rawCharacterCount =
        (input.body?.length ?? 0) +
        input.comments.reduce((total, comment) => total + comment.body.length, 0);

    const omissionNotice =
        omittedCommentCount > 0
            ? truncationNotice(
                  `omitted ${omittedCommentCount} reporter ` +
                      `${omittedCommentCount === 1 ? 'comment' : 'comments'}`,
                  sourceUrl,
              )
            : null;
    const bodyWithNotice =
        omissionNotice === null
            ? input.body
            : input.body
              ? `${input.body}\n\n${omissionNotice}`
              : omissionNotice;
    const bodyNotice = truncationNotice('truncated the issue body', sourceUrl);
    const body =
        bodyWithNotice === null
            ? null
            : truncatePromptSection(bodyWithNotice, maxBodyCharacters, bodyNotice);

    let remainingCommentCharacters = maxTotalCommentCharacters;
    let commentTextTruncated = false;
    const comments = selectedComments.map((comment, index) => {
        const remainingComments = selectedComments.length - index;
        const fairShare = Math.floor(remainingCommentCharacters / remainingComments);
        const commentLimit = Math.min(maxCommentCharacters, fairShare);
        const notice = truncationNotice('truncated this reporter comment', sourceUrl);
        const boundedBody = truncatePromptSection(comment.body, commentLimit, notice);
        remainingCommentCharacters -= boundedBody.length;
        if (boundedBody !== comment.body) {
            commentTextTruncated = true;
        }
        return { ...comment, body: boundedBody };
    });
    return {
        body,
        comments,
        omittedCommentCount,
        rawCharacterCount,
        truncated:
            omittedCommentCount > 0 ||
            commentTextTruncated ||
            bodyWithNotice !== input.body ||
            body !== input.body,
    };
}

/**
 * Determine whether a comment contains conservative, explicit evidence of a human solution.
 *
 * The classifier intentionally operates only on comments, never the original issue body. It
 * recognizes concrete rules and references rather than broad words such as `filter` or `fixed`,
 * preserving ordinary diagnostics and negative statements from the reporter.
 *
 * @param body - Untrusted GitHub comment Markdown.
 * @returns True when the comment must be withheld as potential historical solution material.
 */
export function isLikelyHumanSolutionComment(body: string): boolean {
    const normalized = body.replace(/\r\n?/gu, '\n');
    const lower = normalized.toLowerCase();
    const hasExcludedMarker = PROMPT_EXCLUDED_MARKERS.some((marker) => lower.includes(marker));
    if (hasExcludedMarker) {
        return true;
    }

    const withoutMarkdownHeadings = normalized.replace(/^\s{0,3}#{1,6}\s+.*$/gmu, '');
    const withoutNegativeFixedPhrases = withoutMarkdownHeadings.replace(
        /\b(?:not|isn't|isnt|wasn't|wasnt|hasn't|hasnt|never)\s+(?:(?:yet|been)\s+)?(?:fixed|resolved|solved|implemented)\b/giu,
        'problem-remains',
    );
    const hasRule =
        COSMETIC_RULE_PATTERN.test(withoutMarkdownHeadings) ||
        NETWORK_RULE_PATTERN.test(withoutMarkdownHeadings);
    const hasPositiveSolutionReference =
        COMMIT_REFERENCE_PATTERN.test(withoutMarkdownHeadings) ||
        PULL_REQUEST_REFERENCE_PATTERN.test(withoutMarkdownHeadings) ||
        FIXED_WITH_PATTERN.test(withoutNegativeFixedPhrases);
    if (
        hasRule &&
        !hasPositiveSolutionReference &&
        FAILED_RULE_DIAGNOSTIC_PATTERN.test(withoutMarkdownHeadings)
    ) {
        return false;
    }
    return hasRule || hasPositiveSolutionReference;
}

/**
 * Detect a complete user issue submission relayed by AdGuard's trusted intake bot.
 *
 * @param comment - Comment author and Markdown to classify.
 * @returns Whether the comment is trusted structured reporter evidence.
 */
export function isTrustedStructuredIssueReport(comment: PromptSafetyComment): boolean {
    if (!STRUCTURED_REPORT_AUTHORS.has(comment.author.trim().toLowerCase())) {
        return false;
    }
    return (
        StructuredReportHeadingPattern.IssueUrlStart.test(comment.body) &&
        StructuredReportHeadingPattern.SystemConfiguration.test(comment.body) &&
        StructuredReportHeadingPattern.IssueConfiguration.test(comment.body)
    );
}

/**
 * Check whether one comment's GitHub association is in the trusted-roles set.
 *
 * @param comment - The comment under test.
 * @param trustedRoles - Trusted associations, or undefined to trust none.
 * @returns True when the comment's association is present and trusted, compared
 * case-insensitively.
 */
function hasTrustedAssociation(
    comment: PromptSafetyComment,
    trustedRoles: readonly string[] | undefined,
): boolean {
    if (trustedRoles === undefined || comment.authorAssociation === undefined) {
        return false;
    }
    const association = comment.authorAssociation.trim().toUpperCase();
    return trustedRoles.some((role) => role.toUpperCase() === association);
}

/**
 * Select comments safe for the model using the immutable issue reporter, and any author trusted by
 * `options.trustedRoles`, as the only authors.
 *
 * An unavailable reporter identity fails closed. The original array and objects are not mutated.
 *
 * @param comments - Complete or partially filtered issue comment history.
 * @param reporterAuthor - Immutable login returned on the GitHub issue itself.
 * @param options - Optional trusted evidence classes and associations accepted beside reporter
 *   comments.
 * @returns Cloned reporter (and trusted-role) comments without generated markers or likely human
 *   solutions.
 */
export function selectPromptSafeReporterComments<T extends PromptSafetyComment>(
    comments: readonly T[],
    reporterAuthor: string,
    options: PromptSafetySelectionOptions = {},
): T[] {
    const reporter = reporterAuthor.trim().toLowerCase();
    if (!reporter) {
        return [];
    }
    return comments
        .filter(
            (comment) =>
                comment.author.trim().toLowerCase() === reporter ||
                hasTrustedAssociation(comment, options.trustedRoles) ||
                (options.includeStructuredIssueReports === true &&
                    isTrustedStructuredIssueReport(comment)),
        )
        .filter((comment) => !isLikelyHumanSolutionComment(comment.body))
        .map((comment) => ({ ...comment }));
}
