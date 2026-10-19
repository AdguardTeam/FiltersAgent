/**
 * The run-log line every refused or failed `open_page` answer leaves.
 *
 * The answer reaches only the caller; without this line a run log cannot say which navigation a
 * site refused or why the runner did.
 */
import type { Logger } from 'pino';
import type { BrowserFallbackReason } from '../types/browser-fallback-reason';

/**
 * The facts of a refused or failed `open_page` answer the run log keeps.
 */
export interface NavigationFailureLogFacts {
    /**
     * What went wrong, as answered to the caller.
     */
    error: string;

    /**
     * HTTP status of the main document, when one arrived.
     */
    statusCode?: number;

    /**
     * Classified reason the navigation could not be used.
     */
    fallbackReason?: BrowserFallbackReason;
}

/**
 * Longest navigation error a run-log line carries; a browser error can embed a whole call log.
 */
const NAVIGATION_FAILURE_LOG_ERROR_CHARS = 500;

/**
 * Bind a logger to one `open_page` call so each failure it answers is logged on the way out.
 *
 * @param logger - Run logger.
 * @param targetUrl - The URL the call was asked to open.
 * @param frameNavigations - Main-frame URLs the navigation passed through, filled as it runs.
 * @returns A function that logs a failure and returns it unchanged.
 */
export function navigationFailureLogger(
    logger: Logger,
    targetUrl: unknown,
    frameNavigations: readonly string[],
): <Failure extends NavigationFailureLogFacts>(failure: Failure) => Failure {
    return (failure) => {
        logger.warn(
            {
                targetUrl,
                statusCode: failure.statusCode,
                fallbackReason: failure.fallbackReason,
                frameNavigations,
                error: failure.error.slice(0, NAVIGATION_FAILURE_LOG_ERROR_CHARS),
            },
            'open_page navigation failed',
        );
        return failure;
    };
}
