/**
 * The report-comment policy and the token problems of one run's input resolution.
 *
 * A run takes one token, and that token decides both whether comments are posted and where the
 * report's screenshots are hosted. This module owns every configuration problem about the token —
 * both variables set, a named screenshots branch beside a user account's token, no token for a run
 * that reads GitHub — so the entry's resolver only collects what it answers. It is pure over `(env,
 * sources)`, like the resolver itself.
 */

import { optionalEnvValue } from '../config/repository-identity';
import {
    GITHUB_TOKEN_VAR,
    GITHUB_USER_TOKEN_VAR,
    resolveRunToken,
    RunTokenSource,
} from '../config/run-token';
import {
    DEFAULT_REPORT_SCREENSHOTS_BRANCH,
    ScreenshotsStorage,
} from '../publisher/report-screenshots';
import type { AgentRunCommentPolicy } from './entry-inputs';

/**
 * What the caller knows about the run before the comment policy is resolved.
 */
export interface CommentPolicySources {
    /**
     * Whether publishing is disabled for the run.
     */
    noComment: boolean;

    /**
     * Branch named for the screenshots, before any default is applied; absent or blank means none.
     */
    screenshotsBranch: string | undefined;

    /**
     * What reads through GitHub, when anything does; absent when the run reads nothing.
     */
    githubReadReason: string | undefined;
}

/**
 * One comment-policy resolution: the policy and the problems to fold into the run's failure.
 */
export interface CommentPolicyResolution {
    /**
     * The comment policy the run carries.
     */
    comments: AgentRunCommentPolicy;

    /**
     * The token problems, in report order; empty when the policy is usable.
     */
    problems: string[];
}

/**
 * Render the message fired when a GitHub seam has to read but no token is configured.
 *
 * Names both token variables every face genuinely reads (the action's `githubToken` and
 * `githubUserToken` inputs land there too) rather than the CLI's `--no-comment` flag: turning
 * comments off does not lift the read requirement.
 *
 * @param reason - What reads through GitHub.
 * @returns The message naming the variables and how the token is shared with report comments.
 */
function nameMissingReadTokenMessage(reason: string): string {
    return (
        `${GITHUB_TOKEN_VAR} or ${GITHUB_USER_TOKEN_VAR} is required: ${reason}. Set exactly one of ` +
        "them (the action's githubToken or githubUserToken input); the same token enables report " +
        'comments unless comments are disabled for the run.'
    );
}

/**
 * Render the message fired when a screenshots branch is named beside a user account's token.
 *
 * @param branch - The branch the request named.
 * @returns The message telling the maintainer how to get each storage.
 */
function nameScreenshotsBranchWithUserTokenMessage(branch: string): string {
    return (
        `screenshotsBranch names '${branch}' while the token came from ${GITHUB_USER_TOKEN_VAR} ` +
        "(the action's githubUserToken input), which attaches the screenshots to the report " +
        'comment: remove screenshotsBranch to attach them, or pass the token as ' +
        `${GITHUB_TOKEN_VAR} (githubToken) to commit them to that branch.`
    );
}

/**
 * Derive the report-comment policy and the token problems for one run.
 *
 * A token alone enables comments; `noComment` turns publishing off without demanding a token; a
 * token with `noComment` keeps posting off and is accepted, since the token still travels for
 * GitHub reads. The storage follows the token's variable: a user account's token attaches the
 * screenshots to the comment, any other token commits them to the branch. Each cause reports one
 * problem at most: with both variables set the missing-token problem is not added, and the branch
 * problem cannot arise because no source was resolved.
 *
 * @param env - Environment source supplied by the caller.
 * @param sources - What the caller knows about the run.
 * @returns The comment policy and the problems, in report order.
 */
export function resolveCommentPolicy(
    env: Readonly<Record<string, string | undefined>>,
    sources: CommentPolicySources,
): CommentPolicyResolution {
    const runToken = resolveRunToken(env);
    const namedBranch = optionalEnvValue(sources.screenshotsBranch);
    const problems: string[] = [];
    if (runToken.problem !== undefined) {
        problems.push(runToken.problem);
    }
    if (runToken.source === RunTokenSource.GithubUserToken && namedBranch !== undefined) {
        problems.push(nameScreenshotsBranchWithUserTokenMessage(namedBranch));
    }
    if (
        sources.githubReadReason !== undefined &&
        runToken.token === undefined &&
        runToken.problem === undefined
    ) {
        problems.push(nameMissingReadTokenMessage(sources.githubReadReason));
    }
    const token = runToken.token;
    return {
        comments: {
            enabled: !sources.noComment && token !== undefined,
            ...(token !== undefined ? { token } : {}),
            screenshots:
                runToken.source === RunTokenSource.GithubUserToken
                    ? { storage: ScreenshotsStorage.Attachments }
                    : {
                          storage: ScreenshotsStorage.Branch,
                          branch: namedBranch ?? DEFAULT_REPORT_SCREENSHOTS_BRANCH,
                      },
        },
        problems,
    };
}
