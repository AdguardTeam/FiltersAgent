import { isContextOverflow, type AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { Logger } from '../logger/logger';
import { TurnStopReason } from './stop-reason';

/**
 * The gaps this seam closes in pi's in-run retry classification: transient failures of the gateway
 * path that pi does not recognize as transient, and therefore never retries.
 *
 * Pi classifies a failed turn from the composed error MESSAGE against a fixed list of substrings
 * (`RETRYABLE_PROVIDER_ERROR_PATTERN` in `pi-ai`'s `dist/utils/retry.js`), so wording it did not
 * enumerate is simply not transient to it — and none of the `retry` settings pi exposes (`enabled`,
 * `maxRetries`, `baseDelayMs`, `provider.timeoutMs`) carries a predicate, a pattern, or a status
 * list. There is no supported hook; extending the decision means reaching into the session object
 * pi hands back.
 *
 * Three shapes are covered, each of which otherwise loses a whole run to one hiccup: a Cloudflare
 * origin status ahead of the message, a transport-level stream fault the gateway relays from its
 * upstream as prose, and an in-band `finish_reason: error`. The patterns below carry their own
 * reasoning.
 *
 * `extendTransientGatewayRetry` is that reach, kept to one wrapped method in one module so the
 * whole vendor coupling is visible in one place when the pin moves.
 */

/**
 * Leading HTTP status of a Cloudflare origin-side failure, as pi-ai composes a provider error for
 * the `openai-completions` API this runtime registers.
 *
 * The gateway this runtime talks to sits behind Cloudflare, and Cloudflare answers an origin-side
 * fault with its own 52x/530 range rather than the origin's status.
 *
 * Why this set — 520 through 527, plus 530: pi-ai's own `RETRYABLE_PROVIDER_ERROR_PATTERN`
 * (`dist/utils/retry.js` of the pinned 0.84.1) enumerates transient HTTP statuses one literal at a
 * time — `429`, `500`, `502`, `503`, `504`, `524` — and stops there. Cloudflare's origin-side range
 * is 520-527 and 530, of which only 524 (a gateway timeout) made pi's list. A loop request answered
 * `520 status code (no body)` gives pi a message it does not recognize, so it ends the turn in
 * error and the run seals `provider-failure` after that single attempt — one whole run spent on one
 * edge hiccup that a status-based retry treats as an ordinary 5xx. 524 is kept in the range
 * deliberately: the set means "Cloudflare answered for the origin", and pi already retrying one
 * member of it is not a reason to spell the range with a hole.
 *
 * Why anchored at the start: that is where the status lands. For this API pi-ai's
 * `formatProviderError` composes `"<status>: <body>"` with NO provider prefix (the same structural
 * fact `isDeterministicProviderMessage` reads in `run-sealing.ts`), and when the response carries
 * no body at all the OpenAI SDK's own message is `"<status> status code (no body)"`. Anchoring is
 * what keeps a token count, an id or a byte size quoted inside a body from being read as a gateway
 * status.
 */
const TRANSIENT_GATEWAY_STATUS_PATTERN = /^\s*(?:52[0-7]|530)\b/u;

/**
 * Wording of a transport-level stream fault an OpenAI-compatible gateway relays from its upstream,
 * anywhere in the composed message.
 *
 * Why this shape at all — a loop turn can be answered with `Upstream error from Together: Stream
 * error: h2 protocol error: error reading a body from connection`. There is no HTTP status in it:
 * the gateway accepted the request, answered 200, and then faulted mid-stream, so the OpenAI SDK
 * composes the message from the in-stream error chunk alone and the status-based pattern above
 * cannot see it. None of pi's substrings match it either — its nearest entries are
 * `connection.?error`, `connection.?lost` and `terminated`, and this text spells the connection
 * failure the other way round. Pi ends the turn in error, the run seals `provider-failure` after
 * that single attempt, and the investigation so far goes with it.
 *
 * Why these three phrases and nothing wider:
 *
 * - `stream error` — the gateway's own label for "the upstream stream broke", the part that is
 *   independent of which upstream and which protocol failed.
 * - `h2 protocol error` — HTTP/2 framing between gateway and upstream, a hop this run does not
 *   control and cannot influence by changing the request.
 * - `error reading a body from connection` — the body-read failure itself, the phrase pi's
 *   `connection.?error` just misses.
 *
 * Every one of them names a hop that broke while carrying a request the gateway had already
 * accepted, which is the definition of worth retrying: the same request sent again reaches a
 * different replica. None of them can be produced by the content of a request, so no deterministic
 * rejection is swept in — that is the whole reason the pattern enumerates phrases instead of
 * matching a bare `stream` or `protocol`. Word-bounded and unanchored: the prose arrives behind a
 * gateway prefix (`Upstream error from <vendor>:`) that no pattern should have to predict, and the
 * bounds keep a phrase from matching inside a longer word.
 */
const UPSTREAM_STREAM_FAULT_PATTERN =
    /\b(?:stream error|h2 protocol error|error reading a body from connection)\b/iu;

/**
 * The in-band upstream failure: a completion whose final chunk carries `finish_reason: "error"`.
 *
 * Pi's `mapStopReason` (`dist/api/openai-completions.js` of the pinned 0.84.1) turns any finish
 * reason it does not know into an error turn whose message is exactly `Provider finish_reason:
 * <reason>`. A gateway that routes to several upstreams answers with the bare reason `error` when
 * the chosen upstream fails while generating, and without this pattern the run seals
 * `provider-failure` after that single attempt. The same request sent again reaches another
 * replica, which is what makes it worth retrying.
 *
 * Anchored to the whole message and to the bare reason on purpose: `content_filter` is a
 * deterministic verdict on the request's content and must stay terminal, and `network_error` is
 * already in pi's own retry list (`network.?error`). Only the reason that names nothing at all is
 * ours to classify.
 */
const UPSTREAM_FINISH_REASON_ERROR_PATTERN = /^Provider finish_reason: error$/u;

/**
 * The pinned-vendor slice of pi's `AgentSession` this seam replaces.
 *
 * `_isRetryableError` is `private` in pi's `.d.ts`, so it is reachable only through a cast; naming
 * the one member here — instead of casting to `any` or to the whole session — keeps the wrapper
 * type-checked against the exact signature pi calls (`dist/core/agent-session.js`, from
 * `_willRetryAfterAgentEnd` and `_handlePostAgentRun`) and makes a signature change at the next
 * version bump a compile error rather than a silent no-op.
 */
interface RetryDecidingSession {
    /**
     * Pi's own decision on whether a failed turn's assistant message may be retried.
     */
    _isRetryableError(message: AssistantMessage): boolean;
}

/**
 * Decide whether a failed turn is a transient gateway-path failure pi does not recognize.
 *
 * Deliberately narrow, and the guards are shared by all three patterns: only a turn that actually
 * ended in a provider error with a message, only a message whose LEADING status is in the
 * Cloudflare origin range, that names one of the enumerated upstream stream faults, or that is the
 * bare in-band `finish_reason: error`, and never a context overflow — pi's rule that an overflow is
 * handled by compaction rather than by retry is the one part of its decision this seam must not
 * override, so it is re-asserted here instead of being assumed unreachable. `isContextOverflow` is
 * called without a context window on purpose: its two window-dependent cases (a silently accepted
 * overflow, a zero-output `length` stop) require a non-error stop reason, which the first guard has
 * already excluded.
 *
 * Exported for the single-shot path: a vision or extraction call meets the same gateway faults
 * mid-stream, and pi's transport retry there decides on the HTTP status of the request phase alone
 * — a fault after the headers surfaces as an error message it never retries, so one stream fault on
 * a candidate's visual review would leave the review "unavailable".
 *
 * @param message - The failed turn's assistant message, as pi hands it to its own predicate.
 * @returns True when the turn should be retried despite pi classifying it as terminal.
 */
export function isTransientGatewayFailure(message: AssistantMessage): boolean {
    if (message.stopReason !== TurnStopReason.Error) {
        return false;
    }
    const errorMessage = message.errorMessage;
    if (errorMessage === undefined || errorMessage === '') {
        return false;
    }
    if (isContextOverflow(message)) {
        return false;
    }
    return (
        TRANSIENT_GATEWAY_STATUS_PATTERN.test(errorMessage) ||
        UPSTREAM_STREAM_FAULT_PATTERN.test(errorMessage) ||
        UPSTREAM_FINISH_REASON_ERROR_PATTERN.test(errorMessage)
    );
}

/**
 * Extend one built session's retry decision with the transient gateway failures pi does not know.
 *
 * This is a pinned-vendor seam against `@earendil-works/pi-coding-agent@0.84.1`: pi's retry
 * settings expose no predicate or pattern hook (see the module note), so the created session's own
 * `_isRetryableError` is wrapped — pi's answer OR ours, never instead of pi's. Both of pi's call
 * sites read the method off `this`, so an own property on the instance is enough and nothing else
 * about the session changes; the configured `maxRetries` still bounds how many times the extended
 * decision can fire, so a gateway that is down rather than blipping still seals `provider-failure`,
 * just after the retries the run paid for.
 *
 * @param session - The session `createAgentSession` returned.
 * @param logger - Application logger; every extension of pi's decision is logged, because a retry
 *   that pi itself would not have made must be visible in the run that made it. Pi consults the
 *   decision from both of its call sites for one failed turn, so the line can appear twice per turn
 *   — it records a classification, not an attempt, and the turn's own `provider turn failed` line
 *   beside it is the attempt.
 */
export function extendTransientGatewayRetry(session: AgentSession, logger: Logger): void {
    const vendor = session as unknown as RetryDecidingSession;
    // The leading underscore is pi's own spelling of the member, not a convention this codebase
    // adopts: the whole point of the seam is to replace THAT method, so the name cannot be chosen.
    /* oxlint-disable no-underscore-dangle */
    const piDecision = vendor._isRetryableError.bind(vendor);
    vendor._isRetryableError = (message: AssistantMessage): boolean => {
        if (piDecision(message)) {
            return true;
        }
        if (!isTransientGatewayFailure(message)) {
            return false;
        }
        logger.warn(
            { message: message.errorMessage },
            'classified a transient gateway failure retryable that pi would have failed fast on',
        );
        return true;
    };
    /* oxlint-enable no-underscore-dangle */
}
