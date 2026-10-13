import * as v from 'valibot';
import type { Octokit } from '@octokit/rest';
import { createOctokit, GithubReadConfig } from '../github/fetch-issue';
import type { Logger } from '../logger/logger';
import { createLogger } from '../logger/logger';
import { formatIssues } from '../pi/valibot-issues';
import {
    BacklogIssueCommentSchema,
    BacklogIssueSummarySchema,
    mapGithubCommentToEntry,
    mapGithubIssueToSummary,
} from './backlog-response';
import type {
    BacklogIssueComment,
    BacklogIssueHistory,
    BacklogIssueSummary,
    GithubCommentItem,
    GithubIssueItem,
} from './backlog-response';

/**
 * Narrow typed GitHub listing seam for backlog selection.
 *
 * Backlog mode reads which open issues exist and, per visited issue, the trusted history it derives
 * its revision state from — nothing else. This module is backlog mode's whole GitHub surface: a
 * newest-first open-issue listing and a per-issue comment read, mapped at the seam before anything
 * derived touches them. The mapped and schema-validated response vocabulary it admits is
 * `backlog-response.ts`. There is no write endpoint here; publishing stays with the report
 * publisher.
 *
 * Request budget is part of the contract: the listing item answers every issue-level fact the
 * selection reads, so a visited issue costs at most the comment pages it actually has, and a listed
 * issue with no comments costs nothing at all.
 */

/**
 * Mapped response vocabulary the adapter drives, re-exported so selection and the future wiring
 * keep importing this seam's origin unchanged.
 */
export {
    BacklogIssueCommentSchema,
    BacklogIssueHistorySchema,
    BacklogIssueSummarySchema,
} from './backlog-response';

/**
 * BacklogIssueComment, BacklogIssueHistory, and BacklogIssueSummary types.
 */
export type {
    BacklogIssueComment,
    BacklogIssueHistory,
    BacklogIssueSummary,
} from './backlog-response';

/**
 * Maximal GitHub page size, applied to every endpoint request.
 *
 * Why 100: it is GitHub's maximal `per_page`, so a scan walks the least pages and a tail-heavy
 * backlog costs at most one extra short page per restart.
 */
const LIST_PAGE_SIZE = 100;

/**
 * Stable failure classes emitted by the narrow backlog GitHub adapter.
 */
export const BacklogIssueReadErrorCode = {
    /**
     * The transport call itself failed (network, auth, or GitHub API error).
     */
    ReadFailed: 'read_failed',

    /**
     * GitHub answered, but the response did not match the expected shape.
     */
    InvalidResponse: 'invalid_response',
} as const;

/**
 * BacklogIssueReadErrorCode value.
 */
export type BacklogIssueReadErrorCode =
    (typeof BacklogIssueReadErrorCode)[keyof typeof BacklogIssueReadErrorCode];

/**
 * Stable typed failure emitted by the narrow backlog GitHub adapter.
 */
export class BacklogIssueReadError extends Error {
    /**
     * Stable failure class used by the run log.
     */
    readonly code: BacklogIssueReadErrorCode;

    /**
     * Create a typed backlog issue read failure.
     *
     * @param code - Stable failure class.
     * @param message - Bounded diagnostic describing the failure.
     * @param options - Optional original provider or validation error.
     */
    constructor(code: BacklogIssueReadError['code'], message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'BacklogIssueReadError';
        this.code = code;
    }
}

/**
 * Narrowed REST `issues` surface the adapter drives.
 */
type BacklogIssuesTransport = Pick<Octokit['rest']['issues'], 'listForRepo' | 'listComments'>;

/**
 * Injectable dependencies replacing the reader's transport and logger.
 */
export interface BacklogIssueReaderDependencies {
    /**
     * Pino logger receiving every underlying failure before typed mapping; defaults to the
     * application logger.
     */
    logger?: Logger;

    /**
     * REST issues transport used verbatim; omit to use an Octokit authenticated with the token.
     */
    issues?: BacklogIssuesTransport;
}

/**
 * One page of the open-issue listing.
 */
export interface BacklogIssuePage {
    /**
     * Validated summaries of the requested page, in GitHub's newest-first order.
     */
    summaries: readonly BacklogIssueSummary[];

    /**
     * Whether the page was full, so a further page may exist.
     */
    hasMore: boolean;
}

/**
 * The two reads backlog selection may drive — the adapter's whole surface.
 */
export interface BacklogIssueReader {
    /**
     * List one page of open issues' summaries, newest first.
     *
     * @param page - 1-based page number to request.
     * @returns The page's validated summaries and whether the page was full.
     * @throws {@link BacklogIssueReadError} When the listing fails or an item is malformed.
     */
    readOpenIssuePage(page: number): Promise<BacklogIssuePage>;

    /**
     * Read one listed issue's ordered comment history beside the summary it was listed with.
     *
     * The summary rides in rather than an issue number because the listing already answered
     * everything the detail endpoint would: an `issues.get` per visited issue only re-fetched the
     * dates, labels, login and comment count the page item carries, and a backlog of a few hundred
     * already-reported issues spent that request on each of them before reaching the first due one.
     * An issue whose listed count is zero costs no request at all.
     *
     * @param summary - The issue's validated summary, as the listing returned it.
     * @returns The validated history derivation input.
     * @throws {@link BacklogIssueReadError} When a comment page read or a response item fails.
     */
    readIssueHistory(summary: BacklogIssueSummary): Promise<BacklogIssueHistory>;
}

/**
 * Response body the transport attaches to a GitHub API rejection.
 */
interface GithubRejectionResponse {
    /**
     * The response payload as answered.
     */
    data?: unknown;
}

/**
 * One GitHub API rejection shaped like `RequestError`, for diagnostics.
 */
interface GithubRejectionError {
    /**
     * HTTP status riding the rejection, when the transport bears one.
     */
    status?: number;

    /**
     * Response detail the transport attached, when it answered at HTTP level.
     */
    response?: GithubRejectionResponse;
}

/**
 * Extract an error's HTTP status, when one rides the rejection.
 *
 * @param error - Unknown GitHub API rejection.
 * @returns The bearing status when numeric, else undefined.
 */
function statusOf(error: unknown): number | undefined {
    const status = (error as GithubRejectionError).status;
    return typeof status === 'number' ? status : undefined;
}

/**
 * Extract an error's HTTP response detail for diagnostics.
 *
 * @param error - Unknown GitHub API rejection.
 * @returns The serialized response body when present, else undefined.
 */
function responseDetailOf(error: unknown): string | undefined {
    const data = (error as GithubRejectionError).response?.data;
    if (data === undefined) {
        return undefined;
    }
    try {
        return JSON.stringify(data);
    } catch {
        return String(data);
    }
}

/**
 * Concrete adapter retaining credentials behind the narrow reader interface.
 */
class GitHubBacklogIssueReader implements BacklogIssueReader {
    /**
     * Read-only repository configuration.
     */
    private readonly config: GithubReadConfig;

    /**
     * Logger receiving every underlying failure before typed mapping.
     */
    private readonly logger: Logger;

    /**
     * REST issues transport used verbatim for both reads.
     */
    private readonly issues: BacklogIssuesTransport;

    /**
     * Create a narrow backlog issue reader.
     *
     * @param config - Read-only GitHub credentials and repository coordinates.
     * @param dependencies - Optional deterministic transport and logger overrides.
     */
    constructor(config: GithubReadConfig, dependencies: BacklogIssueReaderDependencies) {
        this.config = { ...config };
        this.logger = dependencies.logger ?? createLogger();
        this.issues = dependencies.issues ?? createOctokit({ ...config }).rest.issues;
    }

    /**
     * Log one underlying failure at the seam and map it to the typed kind.
     *
     * @param code - Stable failure class to map to after logging.
     * @param phase - What the reader was doing, for the run log.
     * @param error - The caught transport error.
     * @returns The typed error to throw.
     */
    private failRead(
        code: BacklogIssueReadErrorCode,
        phase: string,
        error: unknown,
    ): BacklogIssueReadError {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        this.logger.error(
            {
                phase,
                code,
                status: statusOf(error),
                causeMessage: message,
                responseDetail: responseDetailOf(error),
                stack,
            },
            `Backlog issue read failed while ${phase}.`,
        );
        return new BacklogIssueReadError(
            code,
            `Backlog issue read failed while ${phase}: ${message}`,
            { cause: error },
        );
    }

    /**
     * Log one malformed response item at the seam and map it to the typed kind.
     *
     * @param phase - What the reader was doing, for the run log.
     * @param detail - The serialized offending item.
     * @param cause - The underlying validation error.
     * @returns The typed error to throw.
     */
    private failInvalidResponse(
        phase: string,
        detail: string,
        cause: unknown,
    ): BacklogIssueReadError {
        this.logger.error(
            {
                phase,
                code: BacklogIssueReadErrorCode.InvalidResponse,
                responseDetail: detail,
                cause,
            },
            `Backlog issue response failed while ${phase}.`,
        );
        return new BacklogIssueReadError(
            BacklogIssueReadErrorCode.InvalidResponse,
            `Backlog issue response failed while ${phase}: ${detail}`,
            { cause },
        );
    }

    /**
     * Validate one issue item at the seam, logging and naming it when malformed.
     *
     * @param item - GitHub issue item as listed.
     * @param phase - What the reader was doing, for the run log.
     * @returns The validated summary.
     */
    private parseSummary(item: GithubIssueItem, phase: string): BacklogIssueSummary {
        const result = v.safeParse(BacklogIssueSummarySchema, mapGithubIssueToSummary(item));
        if (!result.success) {
            throw this.failInvalidResponse(phase, formatIssues(result.issues), item);
        }
        return result.output;
    }

    /**
     * Validate one comment item at the seam, logging and naming it when malformed.
     *
     * @param item - GitHub comment item as listed.
     * @param phase - What the reader was doing, for the run log.
     * @returns The validated comment.
     */
    private parseComment(item: GithubCommentItem, phase: string): BacklogIssueComment {
        const result = v.safeParse(BacklogIssueCommentSchema, mapGithubCommentToEntry(item));
        if (!result.success) {
            throw this.failInvalidResponse(phase, formatIssues(result.issues), item);
        }
        return result.output;
    }

    /**
     * List one page of open issues' summaries, newest first.
     *
     * @param page - 1-based page number to request.
     * @returns The page's validated summaries and whether the page was full.
     */
    async readOpenIssuePage(page: number): Promise<BacklogIssuePage> {
        const phase = `listing open issue page ${page}`;
        let items: readonly GithubIssueItem[];
        try {
            const response = await this.issues.listForRepo({
                owner: this.config.owner,
                repo: this.config.repo,
                state: 'open',
                sort: 'created',
                direction: 'desc',
                per_page: LIST_PAGE_SIZE,
                page,
            });
            items = response.data;
        } catch (error) {
            throw this.failRead(BacklogIssueReadErrorCode.ReadFailed, phase, error);
        }
        const summaries: BacklogIssueSummary[] = [];
        for (const item of items) {
            if ('pull_request' in item) {
                continue;
            }
            summaries.push(this.parseSummary(item, phase));
        }
        return { summaries, hasMore: items.length === LIST_PAGE_SIZE };
    }

    /**
     * Read one listed issue's ordered comment history beside the summary it was listed with.
     *
     * @param summary - The issue's validated summary, as the listing returned it.
     * @returns The validated history derivation input.
     */
    async readIssueHistory(summary: BacklogIssueSummary): Promise<BacklogIssueHistory> {
        const issueNumber = summary.issueNumber;
        // An issue GitHub listed with no comments has no history to page through, and asking for
        // its empty first page is a wasted request against the 1,000/hour `github.token` budget —
        // the budget a backlog run exhausts on its untaken, already-reported majority.
        if (summary.commentCount === 0) {
            return { summary, comments: [] };
        }
        const comments: BacklogIssueComment[] = [];
        for (let page = 1; ; page += 1) {
            const phase = `reading issue ${issueNumber} comments page ${page}`;
            let items: readonly GithubCommentItem[];
            try {
                const response = await this.issues.listComments({
                    owner: this.config.owner,
                    repo: this.config.repo,
                    issue_number: issueNumber,
                    per_page: LIST_PAGE_SIZE,
                    page,
                });
                items = response.data;
            } catch (error) {
                throw this.failRead(BacklogIssueReadErrorCode.ReadFailed, phase, error);
            }
            for (const item of items) {
                comments.push(this.parseComment(item, phase));
            }
            if (items.length < LIST_PAGE_SIZE) {
                break;
            }
        }
        return { summary, comments };
    }
}

/**
 * Create a narrow backlog issue reader with no GitHub mutation surface.
 *
 * @param config - Read-only GitHub credentials and repository coordinates.
 * @param dependencies - Optional deterministic transport and logger overrides.
 * @returns Reader exposing only the open-issue listing and the per-issue history read.
 */
export function createGitHubBacklogIssueReader(
    config: GithubReadConfig,
    dependencies: BacklogIssueReaderDependencies = {},
): BacklogIssueReader {
    return new GitHubBacklogIssueReader(config, dependencies);
}
