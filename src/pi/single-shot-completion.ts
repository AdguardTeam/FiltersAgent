import type { Api, AssistantMessage, Message, Model } from '@earendil-works/pi-ai';
import { ReasoningEffort, type ActiveReasoningEffort } from '../config/reasoning-effort';
import type { SingleShotCallOptions } from './single-shot-types';
import type { PiRuntime } from './runtime';
import { TurnStopReason } from './stop-reason';
import { isTransientGatewayFailure } from './transient-gateway-retry';

/**
 * One bounded provider completion for the single-shot mechanism: the pi request mapping (sampling,
 * reasoning effort, caps, retries, cache affinity) and the INACTIVITY bound over the streamed
 * response. `single-shot.ts` owns the structured repair loop and the consumer-facing client and
 * calls exactly this for every attempt it makes.
 *
 * Split out of `single-shot.ts` because the stall bound is a second responsibility with its own
 * vocabulary — the stream, its events and the abort composed from two sources — and because both
 * modules stay inside the repo's ~500-line rule that way.
 *
 * Why an inactivity bound at all: `timeoutMs` reaches the OpenAI SDK as its `timeout`, and the SDK
 * clears that timer in a `finally` the moment the response resolves — that is, when the HEADERS
 * arrive. Nothing below bounds the streamed body for openai-completions, so a gateway that opens a
 * stream and then stops producing leaves a single-shot call unbounded: an
 * `inspect_full_page_capture` call can sit silent for 44 minutes until the gateway's OWN idle
 * timeout ends the stalled stream with `Upstream idle timeout exceeded`, and the run's 60-minute
 * wall-clock guard cannot take effect until then. The agent loop already bounds exactly this half
 * in `run-guards.ts`, armed on the assistant `message_start` and re-armed on every
 * `message_update`; this is the same bound for the out-of-loop calls, arming on the stream's first
 * event and re-arming on each one after it.
 */

/**
 * Sampling temperature applied when a call passes none.
 *
 * Structured paths (vision, reviewer, oracle) need deterministic output, and an unset temperature
 * would let the gateway default decide — 0 keeps every call deterministic.
 */
const DEFAULT_TEMPERATURE = 0;

/**
 * Base delay before a transient-failure retry of one single-shot call; multiplied by the retry
 * ordinal, so the second retry waits twice as long.
 */
const TRANSIENT_RETRY_DELAY_MS = 1_000;

/**
 * Longest provider-requested pause one single-shot call waits out before its retry.
 *
 * Pi's transport retry refuses a `retry-after` above its own 60-second cap and fails the request at
 * once, naming the delay, so the caller can decide. A gateway behind Cloudflare answered three
 * intake calls in a row with 524 and a 120-second `retry-after`; each run ended without a report
 * although the provider had only asked for a pause. Five minutes covers such a pause and stays well
 * inside a run's wall-clock budget; a provider asking for longer is down, and the call fails.
 */
const MAX_PROVIDER_REQUESTED_RETRY_DELAY_MS = 5 * 60_000;

/**
 * Pi's message for a request it refused because the provider asked for a longer pause than its cap;
 * the capture is the requested delay in whole seconds.
 */
const PROVIDER_REQUESTED_DELAY_PATTERN = /^Server requested (\d+)s retry delay\b/u;

/**
 * Hard bound on one single-shot call's total duration, streamed progress or not.
 *
 * The inactivity bound measures silence, deliberately: a reasoning model that streams its thinking
 * for minutes is alive. It therefore cannot end a generation that never stops: two vision calls
 * that keep streaming for 21 and then 24 minutes — cut only by the 30-minute apply_rule deadline
 * and by the provider itself — eat most of a 60-minute investigation. Verified reviews of such a
 * page finish in one to five minutes; a call still going at ten is a runaway, not a slow answer,
 * and the run is better off with a named failure and its remaining budget.
 */
export const SINGLE_SHOT_CALL_CEILING_MS = 10 * 60_000;

/**
 * Map the configured reasoning effort onto the provider request field, or onto nothing.
 *
 * The pi boundary in one place. Single-shot calls go through the API-typed streaming path, so the
 * field pi reads is `reasoningEffort` — `reasoning` is the `streamSimple`-only spelling that pi
 * clamps before forwarding under this same name, and passing it here would be silently dropped.
 * That path applies no clamping and has no `off` member: "off" is expressed by omitting the field,
 * which for a model with no `thinkingLevelMap` (ours) is what makes pi send no `reasoning_effort`
 * at all. The remaining literals are pi's own, so no lookup table stands between the configuration
 * and the wire.
 *
 * @param effort - The configured effort, or undefined when neither the call nor the client set one.
 * @returns The request fields to spread, empty for `off` and for an unset effort.
 */
function reasoningEffortRequestFields(effort: ReasoningEffort | undefined): {
    /**
     * The level pi puts on the wire as `reasoning_effort`; absent means no reasoning parameter.
     */
    reasoningEffort?: ActiveReasoningEffort;
} {
    return effort === undefined || effort === ReasoningEffort.Off
        ? {}
        : { reasoningEffort: effort };
}

/**
 * Describe the ceiling that ended one streamed completion, for the typed failure and its log line.
 *
 * @param ceilingMs - The total-duration bound the call outlived.
 * @param streamedEvents - Events the stream had delivered before the abort.
 * @param providerMessage - Pi's own error text for the aborted request, when it carried one.
 * @returns The single-line failure message naming the ceiling.
 */
function ceilingMessage(
    ceilingMs: number,
    streamedEvents: number,
    providerMessage: string | undefined,
): string {
    const ceiling =
        `single-shot stream outlived its ${ceilingMs}ms ceiling while still streaming ` +
        `(${streamedEvents} streamed events)`;
    return providerMessage === undefined ? ceiling : `${ceiling}: ${providerMessage}`;
}

/**
 * Describe the stall that ended one streamed completion, for the typed failure and its log line.
 *
 * The provider's own text is kept beside it: the abort is ours, so pi reports only "Request was
 * aborted", and a failure whose whole diagnosis is a bare code is what this codebase forbids.
 *
 * @param stallBoundMs - The inactivity bound the stream exceeded.
 * @param streamedEvents - Progress events the stream produced before it went silent, so a
 *   post-mortem can tell a stream that stalled on its first token from one that stalled mid-reply.
 * @param providerMessage - Pi's own error text for the aborted request, when it carried one.
 * @returns The single-line failure message naming the stall.
 */
function stallMessage(
    stallBoundMs: number,
    streamedEvents: number,
    providerMessage: string | undefined,
): string {
    const stall =
        `single-shot stream made no streamed progress for ${stallBoundMs}ms ` +
        `(${streamedEvents} streamed events before the stall)`;
    return providerMessage === undefined ? stall : `${stall}: ${providerMessage}`;
}

/**
 * Options one bounded completion takes beyond the messages it sends.
 */
export type SingleShotCompletionOptions = Omit<SingleShotCallOptions, 'messages'> & {
    /**
     * One affinity id per logical call, routing cache reads within it.
     */
    sessionId?: string;
};

/**
 * Run one completion through the pi runtime and return the raw assistant message.
 *
 * The response is bounded in two halves, both from `options.timeoutMs`: up to the headers by the
 * SDK's own `timeout`, and from there to the end of the assistant message by the inactivity
 * deadline armed here. The deadline aborts the request, which pi resolves into an `aborted`
 * assistant message; the returned message then names the stall so the caller's existing
 * provider-failure path reports and logs it without a second failure shape. A caller abort still
 * wins: its message is returned exactly as pi produced it.
 *
 * @param runtime - The pi runtime the model handle belongs to.
 * @param model - Model handle to call.
 * @param systemPrompt - Optional system prompt.
 * @param messages - Pi message list.
 * @param options - Call controls, including the cache-routing session id.
 * @returns The raw assistant message (pi resolves provider failures instead of throwing). A
 *   transient gateway failure mid-stream — the same set the agent loop's seam retries
 *   (`isTransientGatewayFailure`) — is retried here up to `options.maxRetries` times with a short
 *   growing delay: pi's own transport retry (`maxRetries` on the request) decides on the HTTP
 *   status of the request phase alone, so a fault after the headers surfaces as an error message it
 *   never retries, and one such fault would leave a candidate visual review "unavailable". A
 *   request pi refused because the provider asked for a pause above pi's own cap is retried the
 *   same way after that pause, up to `MAX_PROVIDER_REQUESTED_RETRY_DELAY_MS`. A caller abort and
 *   every deterministic failure return at once.
 */
export async function completeOnce(
    runtime: PiRuntime,
    model: Model<Api>,
    systemPrompt: string | undefined,
    messages: Message[],
    options: SingleShotCompletionOptions,
): Promise<AssistantMessage> {
    const maxRetries = options.maxRetries ?? 0;
    for (let retry = 0; ; retry += 1) {
        const message = await completeUnretried(runtime, model, systemPrompt, messages, options);
        if (retry >= maxRetries || options.signal?.aborted === true) {
            return message;
        }
        const requestedDelayMs = providerRequestedRetryDelayMs(message);
        let delayMs: number;
        if (requestedDelayMs !== undefined) {
            if (requestedDelayMs > MAX_PROVIDER_REQUESTED_RETRY_DELAY_MS) {
                return message;
            }
            options.logger?.warn(
                {
                    message: message.errorMessage,
                    requestedDelayMs,
                    retry: retry + 1,
                    maxRetries,
                    model: model.id,
                },
                'single-shot LLM call: the provider asked for a pause; waiting it out, then retrying',
            );
            delayMs = requestedDelayMs;
        } else if (isTransientGatewayFailure(message)) {
            options.logger?.warn(
                { message: message.errorMessage, retry: retry + 1, maxRetries, model: model.id },
                'single-shot LLM call met a transient gateway failure mid-stream; retrying',
            );
            delayMs = TRANSIENT_RETRY_DELAY_MS * (retry + 1);
        } else {
            return message;
        }
        if (!(await sleepUnlessAborted(delayMs, options.signal))) {
            return message;
        }
    }
}

/**
 * Read the pause a provider asked for from a request pi refused because the pause exceeded pi's own
 * cap.
 *
 * @param message - The assistant message a completion returned.
 * @returns The requested pause in milliseconds, or `undefined` when the message is not that
 *   refusal.
 */
function providerRequestedRetryDelayMs(message: AssistantMessage): number | undefined {
    if (message.stopReason !== TurnStopReason.Error) {
        return undefined;
    }
    const seconds = message.errorMessage?.match(PROVIDER_REQUESTED_DELAY_PATTERN)?.[1];
    return seconds === undefined ? undefined : Number(seconds) * 1_000;
}

/**
 * Wait before a retry, ending early when the caller aborts.
 *
 * @param delayMs - How long to wait.
 * @param signal - The caller's abort signal, if any.
 * @returns `true` when the full delay passed, `false` when the caller aborted.
 */
async function sleepUnlessAborted(
    delayMs: number,
    signal: AbortSignal | undefined,
): Promise<boolean> {
    if (signal?.aborted === true) {
        return false;
    }
    return new Promise<boolean>((resolve) => {
        const onAbort = (): void => {
            clearTimeout(timer);
            resolve(false);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve(true);
        }, delayMs);
        timer.unref();
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * One streamed completion with the inactivity bound, no retry: what {@link completeOnce} repeats.
 *
 * @param runtime - The pi runtime the call goes through.
 * @param model - Bound model handle.
 * @param systemPrompt - Optional system prompt.
 * @param messages - Pi message list.
 * @param options - Call controls, including the cache-routing session id.
 * @returns The raw assistant message (pi resolves provider failures instead of throwing).
 */
async function completeUnretried(
    runtime: PiRuntime,
    model: Model<Api>,
    systemPrompt: string | undefined,
    messages: Message[],
    options: SingleShotCompletionOptions,
): Promise<AssistantMessage> {
    const stallBoundMs = options.timeoutMs;
    const ceilingMs = options.ceilingMs;
    // Composed before the request: the signals have to be in the options pi builds the request
    // from.
    const stallController = new AbortController();
    const ceilingController = new AbortController();
    const sources = [
        ...(options.signal === undefined ? [] : [options.signal]),
        ...(stallBoundMs === undefined ? [] : [stallController.signal]),
        ...(ceilingMs === undefined ? [] : [ceilingController.signal]),
    ];
    const signal = sources.length === 0 ? undefined : AbortSignal.any(sources);
    const stream = runtime.modelRuntime.stream(
        model,
        { ...(systemPrompt !== undefined ? { systemPrompt } : {}), messages },
        {
            temperature: options.temperature ?? DEFAULT_TEMPERATURE,
            ...reasoningEffortRequestFields(options.reasoningEffort),
            ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
            ...(stallBoundMs !== undefined ? { timeoutMs: stallBoundMs } : {}),
            ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
            ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
            ...(signal !== undefined ? { signal } : {}),
        },
    );
    let stalled = false;
    let exceededCeiling = false;
    let streamedEvents = 0;
    let stallTimer: NodeJS.Timeout | undefined;
    const armStallTimer = (): void => {
        if (stallBoundMs === undefined) {
            return;
        }
        if (stallTimer !== undefined) {
            clearTimeout(stallTimer);
        }
        stallTimer = setTimeout(() => {
            stalled = true;
            stallController.abort();
        }, stallBoundMs);
        stallTimer.unref();
    };
    // The ceiling is armed once, with the request, and never re-armed: it bounds the whole call,
    // which is exactly what the re-armed inactivity bound below cannot do.
    const ceilingTimer =
        ceilingMs === undefined
            ? undefined
            : setTimeout(() => {
                  exceededCeiling = true;
                  ceilingController.abort();
              }, ceilingMs);
    ceilingTimer?.unref();
    try {
        armStallTimer();
        // Every event is a sign of life — a text or thinking delta, a tool-call delta, the stream's
        // own start — so the deadline measures the gap since the last one and never the response's
        // total length: a model that streams its reasoning for many minutes is alive. The terminal
        // `done`/`error` event is the ending rather than progress, so only the events ahead of it
        // are counted for the diagnostics.
        for await (const event of stream) {
            if (event.type !== 'done' && event.type !== 'error') {
                streamedEvents += 1;
            }
            armStallTimer();
        }
    } finally {
        if (stallTimer !== undefined) {
            clearTimeout(stallTimer);
        }
        if (ceilingTimer !== undefined) {
            clearTimeout(ceilingTimer);
        }
    }
    const message = await stream.result();
    if (options.signal?.aborted === true) {
        return message;
    }
    if (exceededCeiling && ceilingMs !== undefined) {
        return {
            ...message,
            errorMessage: ceilingMessage(ceilingMs, streamedEvents, message.errorMessage),
        };
    }
    if (stalled && stallBoundMs !== undefined) {
        return {
            ...message,
            errorMessage: stallMessage(stallBoundMs, streamedEvents, message.errorMessage),
        };
    }
    return message;
}
