/**
 * Run-token resolution: the one place the environment's two GitHub token variables are read.
 *
 * A run takes exactly one token. Which of the two variables holds it decides nothing about what the
 * token can do, only where the report's screenshots are hosted: the variable a run's token came
 * from is its {@link RunTokenSource}, and every reader of the token — the loaders, the entry's
 * comment policy, the git credential, the diagnostic redactor — goes through this module instead of
 * spelling a variable name. Setting both variables is a problem for the caller to report, never a
 * silent choice.
 */

import { optionalEnvValue } from './repository-identity';

/**
 * Environment variable carrying the GitHub API token every GitHub-reading seam authenticates with,
 * report comments included. The one place this name is spelled; the action's `githubToken` input
 * binding imports it instead of respelling it.
 */
export const GITHUB_TOKEN_VAR = 'GITHUB_TOKEN';

/**
 * Environment variable carrying a user account's GitHub token. The action's `githubUserToken` input
 * lands here; a run whose token came from it hosts the report's screenshots as attachments instead
 * of committing them to a branch.
 */
export const GITHUB_USER_TOKEN_VAR = 'GITHUB_USER_TOKEN';

/**
 * Which of the two token variables a run's token came from.
 */
export const RunTokenSource = {
    /**
     * The token came from {@link GITHUB_TOKEN_VAR}, the workflow token or any other token a
     * workflow passes there.
     */
    GithubToken: 'github_token',

    /**
     * The token came from {@link GITHUB_USER_TOKEN_VAR}, a user account's token.
     */
    GithubUserToken: 'github_user_token',
} as const;

/**
 * RunTokenSource value.
 */
export type RunTokenSource = (typeof RunTokenSource)[keyof typeof RunTokenSource];

/**
 * A run with one token: the trimmed value and the variable it came from.
 */
interface ResolvedRunToken {
    /**
     * The run's trimmed token.
     */
    token: string;

    /**
     * The variable the token came from.
     */
    source: RunTokenSource;

    /**
     * Never set beside a token.
     */
    problem?: undefined;
}

/**
 * A run whose two token variables both hold a value: it has no token to run under.
 */
interface RunTokenConflict {
    /**
     * Never set beside the problem.
     */
    token?: undefined;

    /**
     * Never set beside the problem.
     */
    source?: undefined;

    /**
     * The problem naming both variables; the caller reports it in its own configuration error.
     */
    problem: string;
}

/**
 * A run with no token variable set.
 */
interface NoRunToken {
    /**
     * Never set: no variable holds a value.
     */
    token?: undefined;

    /**
     * Never set: no variable holds a value.
     */
    source?: undefined;

    /**
     * Never set: a missing token is the caller's to judge, not a conflict.
     */
    problem?: undefined;
}

/**
 * One run-token resolution: the token with the variable it came from, the problem that keeps a run
 * from having one, or neither. A token never comes without its source, and never beside a problem.
 */
export type RunTokenResolution = ResolvedRunToken | RunTokenConflict | NoRunToken;

/**
 * Render the rule every reader of the token states: one of the two variables, never both. True with
 * no token at all and with two, so it never contradicts a conflict line beside it.
 */
export const RUN_TOKEN_RULE_MESSAGE = `set exactly one of ${GITHUB_TOKEN_VAR} and ${GITHUB_USER_TOKEN_VAR}`;

/**
 * Render the conflict message fired when both token variables hold a value.
 *
 * @returns The message naming both variables and the action inputs they come from, and what each
 *   one buys a run.
 */
function nameBothTokensMessage(): string {
    return (
        `${GITHUB_TOKEN_VAR} and ${GITHUB_USER_TOKEN_VAR} are both set (the action's githubToken and ` +
        `githubUserToken inputs; a ${GITHUB_TOKEN_VAR} exported in the workflow's env: counts as ` +
        `the first): a run takes exactly one token. Keep ${GITHUB_USER_TOKEN_VAR} to attach the ` +
        `report's screenshots to the comment, or ${GITHUB_TOKEN_VAR} to commit them to the ` +
        'screenshots branch.'
    );
}

/**
 * Resolve the run's token and the variable it came from. Pure over the environment; blank and
 * whitespace-only values count as unset.
 *
 * @param env - Environment source supplied by the caller.
 * @returns The token with its source, or the both-set problem, or neither.
 */
export function resolveRunToken(
    env: Readonly<Record<string, string | undefined>>,
): RunTokenResolution {
    const githubToken = optionalEnvValue(env[GITHUB_TOKEN_VAR]);
    const githubUserToken = optionalEnvValue(env[GITHUB_USER_TOKEN_VAR]);
    if (githubToken !== undefined && githubUserToken !== undefined) {
        return { problem: nameBothTokensMessage() };
    }
    if (githubUserToken !== undefined) {
        return { token: githubUserToken, source: RunTokenSource.GithubUserToken };
    }
    if (githubToken !== undefined) {
        return { token: githubToken, source: RunTokenSource.GithubToken };
    }
    return {};
}

/**
 * List every token value an environment holds, in the order {@link GITHUB_TOKEN_VAR},
 * {@link GITHUB_USER_TOKEN_VAR}.
 *
 * Exists for redaction alone: a conflicting environment still holds two secrets while
 * {@link resolveRunToken} answers with none, so the resolver's token cannot name everything that
 * must be masked. Blank values are not secrets and are skipped.
 *
 * @param env - Environment source supplied by the caller.
 * @returns The trimmed token values, empty when neither variable holds one.
 */
export function runTokenValues(env: Readonly<Record<string, string | undefined>>): string[] {
    return [env[GITHUB_TOKEN_VAR], env[GITHUB_USER_TOKEN_VAR]].flatMap((value) => {
        const trimmed = optionalEnvValue(value);
        return trimmed === undefined ? [] : [trimmed];
    });
}
