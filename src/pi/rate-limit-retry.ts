import { isRetryableAssistantError, type AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { Logger } from '../logger/logger';
import { TurnStopReason } from './stop-reason';

/**
 * How long a retry waits after the provider refused a request for its rate limit: one policy for
 * the agent loop and the single-shot calls alike.
 *
 * Both retry paths otherwise wait seconds — the loop's backoff starts at pi's 2 s, a single-shot
 * call's at 1 s — and a rate limit does not clear in seconds. Two series runs sharing one Anthropic
 * organization were answered 429 `rate_limit_error` ("Number of concurrent requests across all
 * models has exceeded your organization's limit"); the loop retried after 2 and 4 seconds, met the
 * same limit each time and sealed `provider-failure`.
 *
 * The provider's own `retry-after` does not reach either path as a value: pi drops the response
 * headers when it composes the failed turn's message. Pi's transport retry reads the header while
 * it still has it — the single-shot calls run through that retry first, the loop leaves it off —
 * and it refuses a pause above its 60-second cap with a message `single-shot-completion.ts` waits
 * out. What is left here is the refusal that came without a usable pause.
 */

/**
 * Leading HTTP status of a rate-limit refusal in either supported API's error text: the Anthropic
 * SDK composes "429 <body>", the OpenAI SDK "429 <body>" or "429 status code (no body)".
 */
const RATE_LIMIT_STATUS_PATTERN = /^\s*429\b/u;

/**
 * Wait before the first retry of a rate-limited request; each further retry doubles it, which is
 * the shape of pi's own loop backoff.
 *
 * A minute because provider limits are counted per minute — requests and tokens per minute — so the
 * first retry already lands in a fresh window. A concurrency limit clears sooner, when the requests
 * in flight finish, and a minute covers that too. `LLM_REQUEST_MAX_ATTEMPTS` caps the retries at
 * two, so one completion waits three minutes at most: well inside a run's budget, and inside the
 * ten-minute deadline of a vision tool call for that one completion. A tool call that runs many
 * completions under the call limiter, such as `inspect_full_page_capture`, can still pass its
 * deadline when the limit refuses wave after wave.
 */
const RATE_LIMIT_RETRY_BASE_DELAY_MS = 60_000;

/**
 * Decide whether a failed completion is a provider rate-limit refusal worth waiting out.
 *
 * Only what pi already retries: a 429 that names quota or billing exhaustion stays terminal, as pi
 * decides, because waiting does not refill a budget.
 *
 * @param message - The failed completion's assistant message.
 * @returns True for a retryable rate-limit refusal.
 */
export function isProviderRateLimit(message: AssistantMessage): boolean {
    return (
        message.stopReason === TurnStopReason.Error &&
        RATE_LIMIT_STATUS_PATTERN.test(message.errorMessage ?? '') &&
        isRetryableAssistantError(message)
    );
}

/**
 * The wait before one retry of a rate-limited request.
 *
 * @param retryOrdinal - Which retry this is, counting from 1.
 * @returns The wait in milliseconds.
 */
export function rateLimitRetryDelayMs(retryOrdinal: number): number {
    return RATE_LIMIT_RETRY_BASE_DELAY_MS * 2 ** (retryOrdinal - 1);
}

/**
 * The pinned-vendor slice of pi's `AgentSession` this seam wraps.
 *
 * Both members are `private` in pi's `.d.ts`, reachable only through a cast; naming them keeps the
 * wrapper checked against what pi calls and reads (`dist/core/agent-session.js`, from
 * `_handlePostAgentRun`).
 */
interface RetryPreparingSession {
    /**
     * Pi's backoff before a loop retry: it counts the attempt, refuses past `maxRetries`, and
     * sleeps `baseDelayMs * 2^(attempt - 1)` on a timer `abort()` cancels.
     */
    _prepareRetry(message: AssistantMessage): Promise<boolean>;

    /**
     * Retries pi has already made for the failing turn; `_prepareRetry` increments it first.
     */
    _retryAttempt: number;
}

/**
 * Make one built session wait out a provider rate limit before its next loop retry.
 *
 * A pinned-vendor seam against `@earendil-works/pi-coding-agent@0.84.1`: pi's retry settings carry
 * one backoff for every failure, with no hook per failure. For a rate-limited turn the wrapped
 * `_prepareRetry` hands pi a base delay of {@link rateLimitRetryDelayMs}, so pi's own doubling
 * gives the same schedule a single-shot call waits. Everything else stays pi's: the attempt bound,
 * the retry events, and the sleep the run guards cancel through `abort()` — a wall-clock budget
 * that expires mid-wait still ends the run on time.
 *
 * Pi reads the retry settings synchronously, before the first `await` of `_prepareRetry`, so the
 * override is in place for exactly that read and gone before the sleep starts.
 *
 * @param session - The session `createAgentSession` returned.
 * @param logger - Application logger; a rate-limited turn that pi retries is logged with its wait,
 *   because the minute it waits is otherwise an unexplained gap in the run log.
 */
export function extendRateLimitBackoff(session: AgentSession, logger: Logger): void {
    const settings = session.settingsManager;
    const configuredRetry = settings.getRetrySettings.bind(settings);
    let rateLimited = false;
    settings.getRetrySettings = () => {
        const retry = configuredRetry();
        return rateLimited ? { ...retry, baseDelayMs: rateLimitRetryDelayMs(1) } : retry;
    };
    const vendor = session as unknown as RetryPreparingSession;
    // The leading underscore is pi's own spelling of the member; the seam replaces that method.
    /* oxlint-disable no-underscore-dangle */
    const piPrepare = vendor._prepareRetry.bind(vendor);
    vendor._prepareRetry = (message: AssistantMessage): Promise<boolean> => {
        rateLimited = isProviderRateLimit(message);
        const retry = configuredRetry();
        // Pi calls this on the exhausted attempt too and gives up there without sleeping, so only
        // a retry it will make is announced.
        if (rateLimited && retry.enabled && vendor._retryAttempt < retry.maxRetries) {
            const retryOrdinal = vendor._retryAttempt + 1;
            logger.warn(
                {
                    message: message.errorMessage,
                    delayMs: rateLimitRetryDelayMs(retryOrdinal),
                    retry: retryOrdinal,
                    maxRetries: retry.maxRetries,
                },
                'the provider rate-limited a loop request; waiting out the window, then retrying',
            );
        }
        try {
            return piPrepare(message);
        } finally {
            rateLimited = false;
        }
    };
    /* oxlint-enable no-underscore-dangle */
}
