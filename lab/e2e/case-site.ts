import type { RawIssue } from '../../src/github/fetch-issue';
import { StructuredReportHeadingPattern } from '../../src/github/structured-report-template';

/**
 * The report form's `### Issue URL (<type>)` heading, followed by the reported page as a Markdown
 * link or as bare text on the next non-empty line.
 */
const REPORTED_URL_LINE = new RegExp(
    `${StructuredReportHeadingPattern.IssueUrlStart.source}[^\\n]*\\n+\\s*([^\\n]+)`,
    StructuredReportHeadingPattern.IssueUrlStart.flags,
);

/**
 * The visible text of a Markdown link, which the form fills with the reported URL itself; the link
 * target is an anonymizing redirect.
 */
const MARKDOWN_LINK_TEXT = /^\[([^\]]+)\]/u;

/**
 * A query separator as Markdown-rendered issue text escapes it.
 */
const HTML_ESCAPED_AMPERSAND = /&amp;/giu;

/**
 * How long one request may take until the site's response headers arrive. A live site answers in
 * seconds, even behind a challenge page. The connection itself is cut off earlier, by undici's
 * default 10-second connect timeout.
 */
const SITE_PROBE_TIMEOUT_MS = 20_000;

/**
 * Requests made before a site counts as unreachable: a second attempt absorbs one dropped
 * connection on either side.
 */
const SITE_PROBE_ATTEMPTS = 2;

/**
 * Network causes undici and Node report when no host answered at all: the name does not resolve,
 * nothing listens, no route leads there, or the connection was never accepted in time. Every other
 * failure came after a host answered — a dropped connection, a response undici's parser refuses, a
 * certificate chain Node cannot complete — and the run's browser may still load the page.
 */
const NO_ANSWER_CAUSES: ReadonlySet<string> = new Set([
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Name of the error `fetch` rejects with when `AbortSignal.timeout` fires before any response.
 */
const TIMEOUT_ERROR_NAME = 'TimeoutError';

/**
 * Result of the free reachability check of a case site.
 */
export interface SiteReachability {
    /**
     * Whether a host answered: an HTTP response, or a connection it accepted.
     */
    reachable: boolean;
    /**
     * What came back: `HTTP <status>`, or the network error of the last attempt.
     */
    answer: string;
}

/**
 * Check whether a site answers at all, before a run spends a model on it.
 */
export type SiteProbe = (url: string) => Promise<SiteReachability>;

/**
 * Read the reported page from an AdGuard report, without a model.
 *
 * @param issue - The report of the case.
 * @returns The reported http(s) URL.
 * @throws {Error} When the report has no `Issue URL` section or its value is not an http(s) URL.
 */
export function reportedSiteUrl(issue: RawIssue): string {
    const line = (issue.body ?? '').match(REPORTED_URL_LINE)?.[1]?.trim();
    if (!line) {
        throw new Error('Golden issue has no "Issue URL" section to check the site against.');
    }
    const text = (line.match(MARKDOWN_LINK_TEXT)?.[1] ?? line).replace(HTML_ESCAPED_AMPERSAND, '&');
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        throw new Error(`Golden issue "Issue URL" is not a URL: ${text}`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error(`Golden issue "Issue URL" is not an http(s) URL: ${text}`);
    }
    return url.href;
}

/**
 * Read the network cause code undici keeps under a failed request's `cause`.
 *
 * @param error - Rejection of `fetch`.
 * @returns The cause's code, or undefined without one.
 */
function fetchCauseCode(error: unknown): string | undefined {
    const cause = error instanceof Error ? error.cause : undefined;
    return cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined;
}

/**
 * Describe a failed request with the network cause undici keeps under `cause`.
 *
 * @param error - Rejection of `fetch`.
 * @returns Message and, when present, the cause's code or message.
 */
function describeFetchError(error: unknown): string {
    if (!(error instanceof Error)) {
        return String(error);
    }
    const cause = error.cause;
    if (cause instanceof Error) {
        return `${error.message}: ${fetchCauseCode(error) ?? cause.message}`;
    }
    return error.message;
}

/**
 * Decide whether a failed request means that no host answered.
 *
 * @param error - Rejection of `fetch`.
 * @returns Whether the failure is DNS, an unreachable or silent host, or the overall timeout.
 */
function isNoAnswer(error: unknown): boolean {
    return (
        (error instanceof Error && error.name === TIMEOUT_ERROR_NAME) ||
        NO_ANSWER_CAUSES.has(fetchCauseCode(error) ?? '')
    );
}

/**
 * Ask the site for the reported page with a plain HTTP request; no browser, no model.
 *
 * The first HTTP response counts as reachable, a 3xx, a 403 or a 503 included: a challenge page or
 * a cookie redirect answers with one, and the run's browser may pass it. A redirect is not
 * followed, because a request without a cookie jar can loop where a browser would not. Only a host
 * that never answers — DNS, nothing listening, no route, or a timeout — makes the site unreachable;
 * any other failure means a host answered and is recorded as the answer.
 *
 * @param url - Reported page.
 * @returns Whether a host answered, and what came back.
 */
export async function probeSiteReachability(url: string): Promise<SiteReachability> {
    let answer = '';
    for (let attempt = 0; attempt < SITE_PROBE_ATTEMPTS; attempt += 1) {
        try {
            const response = await fetch(url, {
                redirect: 'manual',
                signal: AbortSignal.timeout(SITE_PROBE_TIMEOUT_MS),
            });
            await response.body?.cancel();
            return { reachable: true, answer: `HTTP ${response.status}` };
        } catch (error) {
            answer = describeFetchError(error);
            if (!isNoAnswer(error)) {
                return { reachable: true, answer };
            }
        }
    }
    return { reachable: false, answer };
}
