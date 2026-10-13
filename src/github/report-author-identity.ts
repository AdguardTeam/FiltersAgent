/**
 * Report-author identity resolution.
 *
 * A revision marker (see `publisher/report-publisher.ts`) only proves a run's own dedupe state when
 * it is known to have been authored by the run's own GitHub identity. On a public repository anyone
 * can post a comment shaped like our hidden marker; without an author check that comment would be
 * trusted exactly like our own. This module resolves, once per run, the login that is authoritative
 * for markers: `GET /user` names a personal-access-token identity, while the `GITHUB_TOKEN` Actions
 * token cannot call that endpoint at all and always posts as the fixed `github-actions[bot]`
 * identity — so a refusal there is expected, not a failure to escalate.
 */

import type { Octokit } from '@octokit/rest';
import type { Logger } from '../logger/logger';

/**
 * Fixed login GitHub Actions' `GITHUB_TOKEN` always posts comments as. `GET /user` refuses this
 * token ("Resource not accessible by integration"), so the refusal itself is how this identity is
 * recognized rather than read back from the API.
 */
export const GITHUB_ACTIONS_BOT_LOGIN = 'github-actions[bot]';

/**
 * HTTP status GitHub answers `GET /user` with for the Actions `GITHUB_TOKEN` ("Resource not
 * accessible by integration").
 */
const INTEGRATION_TOKEN_REFUSAL_STATUS = 403;

/**
 * The part of an Octokit request failure this module reads.
 */
interface HttpFailure {
    /**
     * HTTP status of the failed request; absent when the failure never reached a response.
     */
    status?: unknown;
}

/**
 * Resolve the GitHub login authoritative for this run's own report markers.
 *
 * Tried once per run: a personal-access token resolves its login through `GET /user`; the Actions
 * `GITHUB_TOKEN` refuses that call with 403, and only that refusal means the fixed Actions bot
 * identity — it is logged in full before the bot login is returned. Any other failure (a network
 * error, a revoked token, a rate limit) is logged and rethrown: guessing the identity there would
 * make the run miss its own earlier reports and post a duplicate.
 *
 * @param octokit - Authenticated GitHub API client for the run's own token.
 * @param logger - Diagnostics sink for the refusal and for any other failure.
 * @returns The login markers must carry to be trusted for this run.
 * @throws The original error when `GET /user` fails for any reason other than the 403 refusal.
 */
export async function resolveReportAuthorLogin(octokit: Octokit, logger?: Logger): Promise<string> {
    try {
        const { data } = await octokit.rest.users.getAuthenticated();
        return data.login;
    } catch (error) {
        const status = (error as HttpFailure).status;
        if (status === INTEGRATION_TOKEN_REFUSAL_STATUS) {
            logger?.info(
                { err: error },
                'GET /user refused with 403 while resolving the report-author identity; the token ' +
                    `is the Actions GITHUB_TOKEN, which posts as ${GITHUB_ACTIONS_BOT_LOGIN}.`,
            );
            return GITHUB_ACTIONS_BOT_LOGIN;
        }
        logger?.error(
            { err: error, status },
            'GET /user failed while resolving the report-author identity; refusing to guess it.',
        );
        throw error;
    }
}
