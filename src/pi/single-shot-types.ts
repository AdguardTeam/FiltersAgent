import type { BaseIssue, BaseSchema } from 'valibot';
import type { ReasoningEffort } from '../config/reasoning-effort';
import type { Logger } from '../logger/logger';
import type { SingleShotMessage } from './single-shot-input';
import type { TurnStopReason } from './stop-reason';
import type { CompletionUsage } from './usage-reporting';

/**
 * Contract types of the single-shot mechanism: result unions, call options, the completion
 * vocabulary, and the consumer-facing client boundary. Type-first concern — the runtime behavior
 * lives in `single-shot.ts`; this split keeps every file inside the repo's ~500-line module rule.
 * This module is the ONE origin of these names: `single-shot.ts` exports the two entry points
 * (`createSingleShotClient`, `runStructuredSingleShot`) and re-exports nothing, so every consumer
 * imports the vocabulary from here and no symbol has two reachable origins.
 *
 * Nothing here is a `@earendil-works/pi-ai` type, on purpose: analyzer, environment and validator
 * code consumes these results, and re-exporting pi's `Usage` and `StopReason` would make a harness
 * type change an application-wide type change. Token usage and stop reasons are app-owned (the
 * shared `CompletionUsage` in `./usage-reporting`, the shared `TurnStopReason` set in
 * `./stop-reason`) and mapped from pi's shapes at the boundary in `single-shot.ts`, which is the
 * only module that sees both.
 *
 * Both call paths return the SAME result union, so a caller writes one handler for "the provider
 * did not answer usably" and the metered client records a text call's usage without a second
 * branch.
 */

/**
 * Terminal kinds of one structured single-shot call.
 */
export const SingleShotResultKind = {
    /**
     * An attempt produced schema-valid JSON.
     */
    Parsed: 'parsed',

    /**
     * Every allowed attempt produced a reply that failed extraction or schema validation.
     */
    InvalidResult: 'invalid-result',

    /**
     * The completion itself ended without a usable reply (provider error, abort, length).
     */
    ProviderFailure: 'provider-failure',
} as const;

/**
 * SingleShotResultKind value.
 */
export type SingleShotResultKind = (typeof SingleShotResultKind)[keyof typeof SingleShotResultKind];

/**
 * A structured call that produced a validated value.
 */
export interface SingleShotParsed<T> {
    /**
     * Discriminator for the parsed variant.
     */
    kind: typeof SingleShotResultKind.Parsed;

    /**
     * Schema-validated output.
     */
    value: T;

    /**
     * Usage of every observed completion attempt, in order, including schema repair and stream
     * retries on both the structured and text paths.
     */
    usages: CompletionUsage[];

    /**
     * Number of completion attempts made.
     */
    attempts: number;

    /**
     * Model id that produced the value.
     */
    model: string;
}

/**
 * A structured call whose replies never validated.
 */
export interface SingleShotInvalidResult {
    /**
     * Discriminator for the invalid-result variant.
     */
    kind: typeof SingleShotResultKind.InvalidResult;

    /**
     * Bounded description of the last extraction/validation failure.
     */
    detail: string;

    /**
     * Number of completion attempts made.
     */
    attempts: number;

    /**
     * Usage of every attempt, in order.
     */
    usages: CompletionUsage[];

    /**
     * Model id that produced the invalid replies.
     */
    model: string;
}

/**
 * A single-shot call the provider never answered usably.
 */
export interface SingleShotProviderFailure {
    /**
     * Discriminator for the provider-failure variant.
     */
    kind: typeof SingleShotResultKind.ProviderFailure;

    /**
     * The stop reason that ended the completion (`error`, `aborted`, `length`, ...).
     */
    stopReason: TurnStopReason;

    /**
     * The provider's own normalized error text when pi surfaced one; otherwise a description of the
     * stop reason.
     */
    message: string;

    /**
     * Usage of every attempt of the call, the failed one included: an attempted provider call is
     * always accounted for, so a failure can never leave the run's usage looking complete.
     */
    usages: CompletionUsage[];

    /**
     * Model id the call targeted.
     */
    model: string;
}

/**
 * Result of one structured single-shot call; never throws for model/provider behavior.
 */
export type SingleShotResult<T> =
    | SingleShotParsed<T>
    | SingleShotInvalidResult
    | SingleShotProviderFailure;

/**
 * Options shared by both single-shot call paths.
 */
export interface SingleShotCallOptions {
    /**
     * Caller-authored messages; system entries merge after the schema contract (structured path) or
     * form the system prompt (text path).
     */
    messages: SingleShotMessage[];

    /**
     * Sampling temperature; defaults to 0.
     */
    temperature?: number;

    /**
     * Optional output-token cap for the configured API. Pi uses the registered model's maxTokens
     * when neither the call nor the client overrides it, clamped to remaining context. Thinking and
     * the answer share this cap.
     */
    maxTokens?: number;

    /**
     * Per-request deadline in milliseconds (mapped from `llm.requestTimeoutMs`), enforced in the
     * two halves neither of which covers a whole request alone:
     *
     * - Up to the response headers through the selected OpenAI or Anthropic SDK's request timeout.
     *   This does not guarantee an inactivity bound over its streamed response.
     * - From there to the end of the assistant message as an INACTIVITY deadline over the streamed
     *   response, armed on the stream's first event and re-armed on every event after it
     *   (`single-shot-completion.ts`). It bounds the GAP between events, never the response's total
     *   length, so a model that streams its reasoning for many minutes is alive; a stream that
     *   opened and stopped producing is aborted and returns a provider-failure naming the stall.
     */
    timeoutMs?: number;

    /**
     * Hard bound on this call's total duration in milliseconds, streamed progress or not. The
     * inactivity deadline above measures silence and so cannot end a generation that never stops
     * producing; this one can. A call that outlives it is aborted and returns a provider-failure
     * naming the ceiling.
     */
    ceilingMs?: number;

    /**
     * SDK-level transport retries per request, derived once from the configured attempt bound by
     * `providerMaxRetries` in `./llm-wiring` (`llm.requestMaxAttempts - 1`).
     */
    maxRetries?: number;

    /**
     * Reasoning effort for this call, overriding the bound client's default. Active effort applies
     * to entries registered reasoning: true, including shared-model vision. On Anthropic, off sends
     * disabled thinking for those entries, which some models reject. Other entries omit thinking
     * and leave the model's own default in effect.
     */
    reasoningEffort?: ReasoningEffort;

    /**
     * Caller cancellation; an aborted request ends as a provider-failure with `aborted`.
     */
    signal?: AbortSignal;

    /**
     * Diagnostics sink for one structured warn on each terminal failure.
     */
    logger?: Logger;
}

/**
 * Options for one structured single-shot call.
 */
export interface SingleShotStructuredOptions<T> extends SingleShotCallOptions {
    /**
     * Valibot schema that owns the accepted reply fields.
     */
    schema: BaseSchema<unknown, T, BaseIssue<unknown>>;

    /**
     * Schema-validation attempts owned by this call, 1..3; default 2 (initial + one repair).
     */
    maxAttempts?: number;
}

/**
 * The consumer-facing single-shot boundary: one bound model, two call paths, no pi types.
 */
export interface SingleShotClient {
    /**
     * The bound model id (consumers persist/return it as they did the configured slug).
     */
    readonly modelId: string;

    /**
     * Run one schema-validated structured call with bounded repair.
     *
     * @param options - Messages, schema, and call controls.
     * @returns The typed result union; model/provider misbehavior never throws.
     */
    structured<T>(options: SingleShotStructuredOptions<T>): Promise<SingleShotResult<T>>;

    /**
     * Run one free-text completion (for instance, screenshot descriptions).
     *
     * @param options - Messages and call controls.
     * @returns The shared result union with the reply as its value; `invalid-result` cannot occur
     *   on this path, which validates nothing.
     */
    text(options: SingleShotCallOptions): Promise<SingleShotResult<string>>;
}

/**
 * Defaults applied to every call of one bound client.
 */
export interface SingleShotClientDefaults {
    /**
     * Completion cap for the configured API, used unless a call passes its own. When neither
     * supplies a cap, streamSimple uses the registered model's maxTokens. Pi clamps the cap to the
     * remaining context window; thinking and the final answer share that output budget.
     */
    maxTokens?: number;

    /**
     * Per-request deadline in milliseconds applied to every call of this client unless a call
     * passes its own. Both halves of the bound — the SDK's header timeout and the inactivity
     * deadline over the streamed body — come from this one value; see
     * {@link SingleShotCallOptions.timeoutMs}.
     */
    timeoutMs?: number;

    /**
     * Total-duration ceiling in milliseconds applied to every call of this client unless a call
     * passes its own; see {@link SingleShotCallOptions.ceilingMs}.
     */
    ceilingMs?: number;

    /**
     * SDK-level transport retries per request.
     */
    maxRetries?: number;

    /**
     * Reasoning effort applied to every call of this client, mapped from
     * `llm.singleShotReasoningEffort` by `createConfiguredSingleShotClient`; a call may override
     * it.
     */
    reasoningEffort?: ReasoningEffort;

    /**
     * Diagnostics sink used when the call options carry none.
     */
    logger?: Logger;
}
