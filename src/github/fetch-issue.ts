import * as v from 'valibot';
import { Octokit } from '@octokit/rest';
import { stripBenchmarkIssueMarker } from './benchmark-issue-marker';
import { GeneratedCommentMarker } from './generated-comment-markers';
import {
    assertRawPromptTextWithinLimit,
    selectPromptSafeReporterComments,
    type PromptTextLimits,
} from './prompt-safety';
import { stripAgentControlMarkers } from './agent-control-markers';
import { matchingNames } from './github-name-list';
import { IssueState, ISSUE_STATE_VALUES } from '../types/issue-state';
import { DEFAULT_TRUSTED_ROLES, type TrustedRole } from '../queue/queue-inputs';

/**
 * Explicit generated or human-reference markers excluded from model-visible comments.
 *
 * The issue-summary marker is deliberately absent: a summary comment is always bot-authored, so the
 * author check in {@link isPromptSafeIssueComment} already withholds it, and the shared
 * prompt-safety policy applies the complete marker vocabulary afterwards.
 */
const PROMPT_EXCLUDED_COMMENT_MARKERS = [
    GeneratedCommentMarker.AgentSummary,
    GeneratedCommentMarker.HumanSolution,
    GeneratedCommentMarker.HumanReference,
] as const;

/**
 * Automation logins recognized in every repository although they carry neither GitHub's `Bot` type
 * nor the `[bot]` suffix: GitHub Actions' own identity, which the action itself can post as, in the
 * spelling without the suffix. A repository's reporting bots come from the `reportBots` input.
 */
const BUILT_IN_BOT_LOGINS: readonly string[] = ['github-actions'];

/**
 * Minimal GitHub comment identity needed to enforce the prompt-visibility policy.
 */
interface GithubIssueCommentIdentity {
    /**
     * Comment body returned by GitHub.
     */
    body?: string | null;

    /**
     * Comment author returned by GitHub.
     */
    user?: {
        /**
         * Stable GitHub login.
         */
        login?: string | null;

        /**
         * GitHub account classification.
         */
        type?: string | null;
    } | null;

    /**
     * Immutable creation timestamp returned by GitHub.
     */
    created_at?: string | null;

    /**
     * The comment author's GitHub association with the repository, returned by GitHub.
     */
    author_association?: string | null;
}

/**
 * Determine whether one GitHub comment is safe to expose to the model.
 *
 * All bot-authored comments are excluded, even when they do not contain a known generated marker.
 * Explicit agent and human-reference markers are also excluded regardless of author. The shared
 * reporter-only policy subsequently excludes every generated marker and likely human solution.
 *
 * @param comment - GitHub comment identity and body.
 * @param reportBots - The repository's reporting-bot logins, treated as automation.
 * @returns True when the comment may enter the agent prompt.
 */
function isPromptSafeIssueComment(
    comment: GithubIssueCommentIdentity,
    reportBots: readonly string[],
): boolean {
    const body = comment.body ?? '';
    return (
        !isGithubBotAccount(comment.user ?? {}, reportBots) &&
        !PROMPT_EXCLUDED_COMMENT_MARKERS.some((marker) => body.includes(marker))
    );
}

/**
 * Login and account type of one GitHub account, as GitHub reports them.
 */
export interface GithubAccountIdentity {
    /**
     * Stable GitHub login.
     */
    login?: string | null;

    /**
     * GitHub account classification (`User`, `Bot`).
     */
    type?: string | null;
}

/**
 * Recognize an automation account: GitHub's `Bot` type, the conventional `[bot]` suffix, a built-in
 * automation login, or one of the repository's reporting bots, which can post as ordinary users and
 * even carry a maintainer's association.
 *
 * @param account - Login and account type as GitHub reports them.
 * @param reportBots - The repository's reporting-bot logins; empty when it names none.
 * @returns True when the account is automation rather than a person.
 */
export function isGithubBotAccount(
    account: GithubAccountIdentity,
    reportBots: readonly string[],
): boolean {
    const login = (account.login ?? '').trim();
    return (
        (account.type ?? '').toLowerCase() === 'bot' ||
        login.toLowerCase().endsWith('[bot]') ||
        matchingNames([login], [...BUILT_IN_BOT_LOGINS, ...reportBots]).length > 0
    );
}

/**
 * The minimal GitHub credentials needed to read an issue.
 */
export interface GithubReadConfig {
    /**
     * Repository owner (e.g. "list-owner").
     */
    owner: string;

    /**
     * Repository name (e.g. "list-repo").
     */
    repo: string;

    /**
     * A GitHub PAT with read access to issues.
     */
    token: string;
}

/**
 * Read policy for one GitHub issue fetch.
 */
export interface FetchIssueOptions {
    /**
     * Preserve the complete comment history for an auditable raw export.
     *
     * This includes bot comments and explicit generated or human-reference markers that are
     * excluded from the default prompt-safe view.
     */
    preserveGeneratedComments?: boolean;

    /**
     * Preserve hidden historical benchmark metadata for an auditable raw export.
     */
    preserveBenchmarkMetadata?: boolean;

    /**
     * Optional hard raw-text ceiling that enables bounded page-by-page comment collection.
     */
    promptTextLimits?: PromptTextLimits;

    /**
     * Maximum complete raw comments accepted by bounded live collection.
     */
    maxRawCommentCount?: number;

    /**
     * Trusted-association set counted beside the reporter's own comments; defaults to
     * `DEFAULT_TRUSTED_ROLES`. The caller's resolved backlog policy travels here so a stricter
     * override (e.g. `OWNER` alone) excludes the same associations from the fetched comments, the
     * extraction prompt, and the revision digest computed over them.
     */
    trustedRoles?: readonly TrustedRole[] | undefined;

    /**
     * Logins of the repository's reporting bots (the `reportBots` input): their comments are
     * withheld from the prompt like any automation's, even on an issue such a bot filed.
     */
    reportBots?: readonly string[] | undefined;
}

/**
 * A single issue comment, stripped of Octokit-specific shape.
 */
export interface RawComment {
    /**
     * The comment author's login.
     */
    author: string;

    /**
     * The comment body text.
     */
    body: string;

    /**
     * ISO timestamp of when the comment was created.
     */
    createdAt: string;

    /**
     * The comment author's GitHub association with the repository (e.g. `OWNER`, `MEMBER`,
     * `COLLABORATOR`, `NONE`), when the platform reported one — the same signal backlog selection
     * trusts to recognize a maintainer's revision-changing comment.
     */
    authorAssociation?: string;
}

/**
 * The raw, prompt-safe representation of a fetched GitHub issue.
 *
 * Decouples Octokit response types from the intake consumers — the model extraction and the session
 * tooling — so every consumer can be tested against saved fixture bodies without any HTTP mocking.
 */
export const RawIssueSchema = v.object({
    number: v.pipe(v.number(), v.integer(), v.minValue(1)),
    reporterAuthor: v.optional(v.string()),
    updatedAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
    url: v.pipe(v.string(), v.url()),
    title: v.string(),
    body: v.union([v.string(), v.null()]),
    state: v.picklist(ISSUE_STATE_VALUES),
    labels: v.array(v.string()),
    assignee: v.union([v.string(), v.null()]),
    comments: v.array(
        v.object({
            author: v.string(),
            body: v.string(),
            createdAt: v.string(),
            authorAssociation: v.optional(v.string()),
        }),
    ),
});

export type RawIssue = v.InferOutput<typeof RawIssueSchema>;

/**
 * Create an authenticated Octokit instance.
 *
 * @param config - GitHub read credentials.
 * @returns An Octokit instance authenticated with the configured token.
 */
export function createOctokit(config: GithubReadConfig): Octokit {
    return config.token.trim() ? new Octokit({ auth: config.token }) : new Octokit();
}

/**
 * Fetch a single issue (read-only) and map it to a validated `RawIssue`.
 *
 * Performs NO writes: only `issues.get` and `issues.listComments`.
 *
 * @param config - GitHub read credentials.
 * @param issueNumber - The issue number to fetch.
 * @param options - Optional raw-history preservation policy.
 * @returns The validated raw issue.
 */
export async function fetchIssue(
    config: GithubReadConfig,
    issueNumber: number,
    options: FetchIssueOptions = {},
): Promise<RawIssue> {
    const octokit = createOctokit(config);

    let issueData;
    try {
        const res = await octokit.rest.issues.get({
            owner: config.owner,
            repo: config.repo,
            issue_number: issueNumber,
        });
        issueData = res.data;
    } catch (err) {
        throw new Error(`Failed to fetch issue ${issueNumber}: ${(err as Error).message}`, {
            cause: err,
        });
    }

    if ('pull_request' in issueData) {
        throw new Error(`Issue number ${issueNumber} refers to a pull request, not an issue`);
    }

    let comments: GithubIssueCommentIdentity[];
    if (options.promptTextLimits) {
        const maxRawCommentCount = options.maxRawCommentCount ?? 1_000;
        if (!Number.isSafeInteger(maxRawCommentCount) || maxRawCommentCount < 1) {
            throw new Error('maxRawCommentCount must be a positive safe integer.');
        }
        comments = [];
        assertRawPromptTextWithinLimit(
            { body: issueData.body, comments },
            options.promptTextLimits,
        );
        for (let page = 1; ; page += 1) {
            const response = await octokit.rest.issues.listComments({
                owner: config.owner,
                repo: config.repo,
                issue_number: issueNumber,
                per_page: 100,
                page,
            });
            const nextComments = response.data;
            const nextCount = comments.length + nextComments.length;
            if (nextCount > maxRawCommentCount) {
                throw new Error(
                    `Raw issue history exceeds the ${maxRawCommentCount}-comment limit.`,
                );
            }
            assertRawPromptTextWithinLimit(
                { body: issueData.body, comments: [...comments, ...nextComments] },
                options.promptTextLimits,
            );
            comments.push(...nextComments);
            if (nextComments.length < 100) {
                break;
            }
        }
    } else {
        comments = await octokit.paginate(octokit.rest.issues.listComments, {
            owner: config.owner,
            repo: config.repo,
            issue_number: issueNumber,
            per_page: 100,
        });
    }

    const reporterAuthor = issueData.user?.login ?? '';
    const mappedComments = comments.map((comment) => ({
        author: comment.user?.login ?? '',
        body: comment.body ?? '',
        createdAt: comment.created_at ?? '',
        authorAssociation: comment.author_association ?? undefined,
    }));
    const visibleComments = options.preserveGeneratedComments
        ? mappedComments
        : selectPromptSafeReporterComments(
              comments
                  .filter((comment) => isPromptSafeIssueComment(comment, options.reportBots ?? []))
                  .map((comment) => ({
                      author: comment.user?.login ?? '',
                      body: comment.body ?? '',
                      createdAt: comment.created_at ?? '',
                      authorAssociation: comment.author_association ?? undefined,
                  })),
              reporterAuthor,
              // The caller's own resolved trust policy, when threaded, so this fetch counts exactly
              // the associations backlog selection counts as a new revision; DEFAULT_TRUSTED_ROLES
              // otherwise, for every caller that has none to thread.
              { trustedRoles: options.trustedRoles ?? DEFAULT_TRUSTED_ROLES },
          );
    const raw = {
        number: issueData.number,
        reporterAuthor,
        updatedAt: issueData.updated_at ?? undefined,
        url: issueData.html_url,
        title: issueData.title,
        body: options.preserveBenchmarkMetadata
            ? (issueData.body ?? null)
            : stripAgentControlMarkers(stripBenchmarkIssueMarker(issueData.body ?? null)),
        state: issueData.state === 'closed' ? IssueState.Closed : IssueState.Open,
        labels: (issueData.labels ?? [])
            .map((l) => (typeof l === 'string' ? l : l.name))
            .filter((n): n is string => Boolean(n)),
        assignee: issueData.assignee?.login ?? null,
        comments: visibleComments,
    };

    const result = v.safeParse(RawIssueSchema, raw);
    if (!result.success) {
        throw new Error(`Fetched issue ${issueNumber} did not match RawIssue schema`);
    }
    return result.output;
}
