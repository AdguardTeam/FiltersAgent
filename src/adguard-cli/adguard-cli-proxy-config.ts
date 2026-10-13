/**
 * The proxy's workspace layout: the filenames the proxy reads and writes next to each other, named
 * in one place for both the host that starts it and the readers of its logs.
 */

/**
 * Filename of the agent-authored rule source the proxy always loads last.
 */
export const USER_RULES_FILENAME = 'user.txt';

/**
 * Filename of the generated proxy configuration.
 */
export const CONFIG_FILENAME = 'proxy.yaml';

/**
 * Filename of the proxy's own stdout and stderr, next to its access log in the workspace.
 *
 * The proxy logs every connection, so its output must go where it can never fill up. An unread pipe
 * blocks the proxy on its next write once the pipe buffer is full, and every connection after that
 * times out: six runs of one live pass froze after about 150 requests each. The workspace ships
 * with the run's diagnostics, so this file also keeps the proxy's side of every failure.
 */
export const OUTPUT_LOG_FILENAME = 'proxy-output.log';

/**
 * Filename of the proxy's access log in the workspace: one line per request it processed, carrying
 * the text of the network rule that acted on it.
 */
export const ACCESS_LOG_FILENAME = 'access.log';

/**
 * The host the proxy serves its own scripts from. A page it filters loads the content script from
 * here, and the proxy answers the request itself instead of forwarding it.
 */
export const INJECTIONS_HOST = 'local.adguard.org';

/**
 * Build the workspace filename for one official filter list.
 *
 * @param filterId - Official filter identifier.
 * @returns Stable filter-list filename.
 */
export function filterFilename(filterId: number): string {
    return `filter-${filterId}.txt`;
}
