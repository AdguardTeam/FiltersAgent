import {
    createAssistantMessageEventStream,
    type Api,
    type AssistantMessage,
    type AssistantMessageEvent,
    type AssistantMessageEventStream,
    type Context,
    type Model,
    type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { TurnStopReason } from './stop-reason';

/**
 * The silence bound over one streamed model response, applied where every request of the runtime
 * passes: the `streamSimple` a provider registration supplies.
 *
 * `timeoutMs` reaches a provider SDK as its request timeout, and both SDKs clear that timer once
 * the response headers arrive. A response that opened and then stopped producing is bounded by
 * nothing else: a byte-level body timeout cannot see it, because Anthropic keeps sending `ping`
 * events and gateways keep sending SSE comments while the model itself is silent, and pi drops both
 * without emitting an event. So the bound counts pi's own events, which are exactly what the model
 * produced, and covers the half of `timeoutMs` the SDK leaves open — the half pi itself already
 * gives that meaning on its WebSocket transports.
 *
 * A stalled response ends as an ordinary transient failure of that one request: the request is
 * cancelled and the stream ends `error` with a message naming the timeout, which pi's own retry
 * classification treats as transient. The agent loop then retries the turn within its configured
 * bounds and the single-shot client retries the call, instead of the whole run ending on one silent
 * response.
 */

/**
 * One stream implementation of the shape `ModelRuntime.registerProvider` accepts as `streamSimple`.
 */
export type SimpleStreamFunction = (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/**
 * Describe the silence that ended one streamed response.
 *
 * The provider's own text is kept beside it: the cancellation is ours, so pi reports only that the
 * request was aborted, and the bound alone would not say what the transport saw.
 *
 * @param silenceMs - The bound the stream exceeded.
 * @param events - Events the stream produced before it went silent, so a post-mortem can tell a
 *   stream that stalled on its first token from one that stalled mid-reply.
 * @param providerMessage - Pi's own error text for the cancelled request, when it carried one.
 * @returns The single-line failure message. "timed out" is what makes pi classify it transient.
 */
function silenceMessage(
    silenceMs: number,
    events: number,
    providerMessage: string | undefined,
): string {
    const silence =
        `model stream timed out: no streamed event for ${silenceMs}ms ` +
        `(${events} events before the silence)`;
    return providerMessage === undefined ? silence : `${silence}: ${providerMessage}`;
}

/**
 * Bound the silence inside every response a stream implementation produces.
 *
 * The bound is the request's own `timeoutMs`, so one setting keeps meaning one thing on both sides
 * of the headers; a request without it streams unbounded, as before. The timer starts with the
 * first event — the stream opening, which pi emits once the headers arrived — and restarts on every
 * event after it, so it measures the gap since the last sign of life and never the response's total
 * length: a model that streams its reasoning for many minutes is alive.
 *
 * A caller's abort keeps its own meaning: the stream is relayed untouched and ends `aborted`, so
 * neither pi nor the single-shot client retries it.
 *
 * @param stream - The stream implementation to bound, pi's built-in one for the configured API.
 * @returns The bounded implementation, for a provider registration's `streamSimple`.
 */
export function boundStreamSilence(stream: SimpleStreamFunction): SimpleStreamFunction {
    return (model, context, options) => {
        const silenceMs = options?.timeoutMs;
        if (silenceMs === undefined) {
            return stream(model, context, options);
        }
        const callerSignal = options?.signal;
        const silence = new AbortController();
        const signal =
            callerSignal === undefined
                ? silence.signal
                : AbortSignal.any([callerSignal, silence.signal]);
        const source = stream(model, context, { ...options, signal });
        const bounded = createAssistantMessageEventStream();
        void relay(source, bounded, silenceMs, silence, callerSignal);
        return bounded;
    };
}

/**
 * Relay one response's events, cancelling the request once it has been silent for `silenceMs`.
 *
 * @param source - The unbounded response.
 * @param target - The stream handed back to pi.
 * @param silenceMs - The longest gap allowed between two events.
 * @param silence - Cancels the request when the gap is exceeded.
 * @param callerSignal - The caller's own cancellation, which always wins over the silence.
 * @returns Resolves once the response has ended and `target` carries its result.
 */
async function relay(
    source: AssistantMessageEventStream,
    target: AssistantMessageEventStream,
    silenceMs: number,
    silence: AbortController,
    callerSignal: AbortSignal | undefined,
): Promise<void> {
    let events = 0;
    let terminal: AssistantMessageEvent | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
        for await (const event of source) {
            if (event.type === 'done' || event.type === 'error') {
                terminal = event;
                break;
            }
            events += 1;
            clearTimeout(timer);
            timer = setTimeout(() => silence.abort(), silenceMs);
            timer.unref();
            target.push(event);
        }
    } finally {
        clearTimeout(timer);
    }
    const message = await source.result();
    // Only a response the silence actually ended is rewritten: one that finished in the same tick
    // the timer fired keeps its own ending, and a caller's abort stays an abort.
    const stalled =
        silence.signal.aborted && callerSignal?.aborted !== true && terminal?.type === 'error';
    if (!stalled) {
        if (terminal !== undefined) {
            target.push(terminal);
        }
        target.end(message);
        return;
    }
    const failed: AssistantMessage = {
        ...message,
        stopReason: TurnStopReason.Error,
        errorMessage: silenceMessage(silenceMs, events, message.errorMessage),
    };
    target.push({ type: 'error', reason: TurnStopReason.Error, error: failed });
    target.end(failed);
}
