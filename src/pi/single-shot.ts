import { randomUUID } from 'node:crypto';
import { toJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';
import { contentText, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import {
    SingleShotResultKind,
    type SingleShotCallOptions,
    type SingleShotClient,
    type SingleShotClientDefaults,
    type SingleShotResult,
    type SingleShotStructuredOptions,
} from './single-shot-types';
import type { Logger } from '../logger/logger';
import type { PiRuntime } from './runtime';
import { completeOnce } from './single-shot-completion';
import { toPiMessages } from './single-shot-input';
import { toTurnStopReason, TurnStopReason } from './stop-reason';
import { toCompletionUsage, type CompletionUsage } from './usage-reporting';
import { formatIssues } from './valibot-issues';

/**
 * Single-shot LLM calls on the pi runtime: every out-of-loop completion (vision verdicts,
 * inventories, screenshot analysis, reviewer and oracle calls) runs through this module. One
 * structured mechanism — prompt-and-parse with one bounded repair attempt — serves them all, and
 * the free-text path is the same mechanism with no schema. Model/provider behavior never throws
 * here: results are typed unions, terminal failures emit one structured pino warn through the
 * injected logger (pi exposes no retry events, so this line is the only failure diagnostic a run
 * sees), and programmer errors still throw. This module is also the single-shot boundary between
 * pi's vocabulary and the application's own: pi's `Usage` and `StopReason` are mapped here into the
 * shared `CompletionUsage` and `TurnStopReason`, so nothing a consumer of these results touches is
 * a harness type.
 *
 * The contract types live in `single-shot-types.ts` and are imported FROM there by every consumer;
 * this module re-exports none of them, so every symbol has one reachable origin. One bounded
 * provider completion — the pi request mapping and the inactivity deadline over the streamed
 * response — is `single-shot-completion.ts`, which every attempt made here goes through.
 */

/**
 * Maximum schema bytes embedded in one structured system contract.
 *
 * Larger schemas belong in the agent loop's terminal tool, not in an embedded contract.
 */
const MAX_SCHEMA_CHARS = 16_000;

/**
 * Maximum invalid model reply retained on the repair re-prompt.
 *
 * Enough for the model to see its mistake, small enough to keep the repair turn cheap.
 */
const MAX_INVALID_RESPONSE_CHARS = 8_000;

/**
 * Maximum invalid model reply written to the run log.
 *
 * The log is the only place a rejected reply survives, and the repair prompt's tighter bound would
 * cut away exactly the tail that broke the parse. A structured reply is a few kilobytes; this bound
 * only stops a runaway generation from flooding the log.
 */
const MAX_LOGGED_INVALID_RESPONSE_CHARS = 64_000;

/**
 * Maximum validation diagnostic carried by the repair prompt and the typed failure.
 */
const MAX_VALIDATION_DETAIL_CHARS = 1_000;

/**
 * Smallest structured-validation attempt count one logical call may own.
 *
 * Why 1 and not 2: a caller whose own loop owns repair (the validator's final synthesis) re-prompts
 * with context this function does not have, and a repair attempt inside the call would pay for a
 * second completion that the outer loop is about to make redundant. Zero is not a call at all.
 */
const MIN_MAX_ATTEMPTS = 1;

/**
 * Largest structured-validation attempt count one logical call may own.
 *
 * Why 3: the working default is 2 — initial plus one repair — and no caller in the tree passes
 * more; the ceiling exists to stop `maxAttempts` from turning ONE logical single-shot call into an
 * unbounded repair loop, because every attempt past the first is another paid completion and a
 * model that has already seen its own schema error twice is not converging. A caller that genuinely
 * needs more re-prompts from its own loop with context this function does not have.
 */
const MAX_MAX_ATTEMPTS = 3;

/**
 * Maximum Valibot issues quoted in one bounded diagnostic.
 *
 * A reply that misses the schema usually misses it in one or two places; a reply that misses it in
 * more than eight is the wrong shape entirely, and listing the rest tells the model nothing it does
 * not already learn from the first few. The cap also keeps the repair prompt cheap before the
 * character bound has to cut a line mid-word.
 */
const MAX_VALIDATION_DETAIL_ISSUES = 8;

/**
 * Render a bounded validation failure without echoing image data or credentials.
 *
 * @param error - Parsing or schema-validation failure.
 * @returns Safe bounded diagnostic for one repair attempt and the typed failure.
 */
function validationDetail(error: unknown): string {
    if (error instanceof v.ValiError) {
        return formatIssues(error.issues.slice(0, MAX_VALIDATION_DETAIL_ISSUES)).slice(
            0,
            MAX_VALIDATION_DETAIL_CHARS,
        );
    }
    return (error instanceof Error ? error.message : String(error)).slice(
        0,
        MAX_VALIDATION_DETAIL_CHARS,
    );
}

/**
 * Extract one JSON value from a model reply that may include a Markdown fence or prose.
 *
 * @param content - Raw assistant reply.
 * @returns Parsed JSON value.
 */
function parseJsonResponse(content: string): unknown {
    const trimmed = content.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
    if (fenced?.[1]) {
        return JSON.parse(fenced[1]);
    }
    try {
        return JSON.parse(trimmed);
    } catch {
        const object = firstJsonObjectText(trimmed);
        if (object === undefined) {
            throw new Error('response did not contain a JSON object');
        }
        return JSON.parse(object);
    }
}

/**
 * Cut the first complete JSON object out of a reply that carries text before or after it.
 *
 * Braces are counted outside string literals only, so a brace inside a value does not end the
 * object early, and text after the object — prose, a second object — is never pulled into it. A
 * reply that ends inside the object yields what follows its first brace, and the parse names the
 * truncation.
 *
 * @param text - The trimmed reply.
 * @returns The object's text, or `undefined` when the reply has no opening brace.
 */
function firstJsonObjectText(text: string): string | undefined {
    const start = text.indexOf('{');
    if (start < 0) {
        return undefined;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
        const character = text[index];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (character === '\\') {
                escaped = true;
            } else if (character === '"') {
                inString = false;
            }
        } else if (character === '"') {
            inString = true;
        } else if (character === '{') {
            depth += 1;
        } else if (character === '}') {
            depth -= 1;
            if (depth === 0) {
                return text.slice(start, index + 1);
            }
        }
    }
    return text.slice(start);
}

/**
 * Rebuild a replied assistant message for the repair turn: thinking blocks verbatim (thinking
 * gateways match and require them), text bounded so an enormous invalid reply stays cheap.
 *
 * @param message - The assistant message whose reply failed validation.
 * @returns The bounded history entry.
 */
function boundedAssistantReplay(message: AssistantMessage): AssistantMessage {
    return {
        ...message,
        content: [
            ...message.content.filter((block) => block.type === 'thinking'),
            {
                type: 'text',
                text: contentText(message.content).slice(0, MAX_INVALID_RESPONSE_CHARS),
            },
        ],
    };
}

/**
 * How the accepted-reply schema is projected into the JSON Schema the model is shown.
 *
 * A `check` action is a predicate over the parsed value and has no JSON Schema form, so it projects
 * to nothing: the pipe's other keywords stay advertised, the parse enforces the predicate, and the
 * repair prompt names it through its message when a reply fails it. That is how a caller states a
 * rule only it can decide — the intake's "a site URL is copied from the issue" — without a second
 * validation path beside the schema. Every other unconvertible action still throws, as before, so
 * the advertised schema never silently loses a constraint the parse enforces.
 */
const ADVERTISED_SCHEMA_CONVERSION: Parameters<typeof toJsonSchema>[1] = {
    overrideAction: ({ valibotAction, jsonSchema }) =>
        valibotAction.type === 'check' ? jsonSchema : undefined,
};

/**
 * Run one structured single-shot call with bounded repair.
 *
 * @param runtime - The pi runtime to call through.
 * @param model - Bound model handle.
 * @param options - Messages, schema, and call controls.
 * @returns The typed result union.
 */
export async function runStructuredSingleShot<T>(
    runtime: PiRuntime,
    model: Model<Api>,
    options: SingleShotStructuredOptions<T>,
): Promise<SingleShotResult<T>> {
    const schemaJson = JSON.stringify(toJsonSchema(options.schema, ADVERTISED_SCHEMA_CONVERSION));
    if (schemaJson.length > MAX_SCHEMA_CHARS) {
        throw new Error(`Vision JSON Schema exceeds ${MAX_SCHEMA_CHARS} characters`);
    }
    const maxAttempts = options.maxAttempts ?? 2;
    if (
        !Number.isInteger(maxAttempts) ||
        maxAttempts < MIN_MAX_ATTEMPTS ||
        maxAttempts > MAX_MAX_ATTEMPTS
    ) {
        throw new Error(
            `Vision JSON maxAttempts must be an integer from ${MIN_MAX_ATTEMPTS} through ` +
                `${MAX_MAX_ATTEMPTS}`,
        );
    }
    const contract = [
        'Return only one valid JSON object with no Markdown or prose.',
        'It must match this JSON Schema exactly. Do not add fields or replace arrays/objects',
        `with counts or confidence scores. JSON Schema: ${schemaJson}`,
    ].join(' ');
    const converted = await toPiMessages(options.messages);
    const systemPrompt = [contract, converted.systemPrompt].filter(Boolean).join('\n\n');
    // One affinity id per logical call routes the repair request to the replica holding the
    // prefix cache of the first attempt.
    const sessionId = randomUUID();
    let messages = converted.messages;
    const usages: CompletionUsage[] = [];
    let lastFailure = 'unknown validation failure';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const startedAt = Date.now();
        const message = await completeOnce(runtime, model, systemPrompt, messages, {
            ...options,
            sessionId,
        });
        const durationMs = Date.now() - startedAt;
        if (message.stopReason !== TurnStopReason.Stop) {
            // Account for the attempt before returning: a provider call that failed is still a
            // provider call, and dropping it let a run whose last call failed report COMPLETE
            // usage on the strength of the calls that happened to succeed.
            usages.push(toCompletionUsage(model.id, message.usage));
            const failureMessage =
                message.errorMessage ??
                `pi completion ended with stop reason "${message.stopReason}"`;
            options.logger?.warn(
                {
                    kind: SingleShotResultKind.ProviderFailure,
                    stopReason: message.stopReason,
                    message: failureMessage,
                    attempts: attempt,
                    model: model.id,
                    durationMs,
                },
                'single-shot LLM call failed: provider or daemon error',
            );
            return {
                kind: SingleShotResultKind.ProviderFailure,
                stopReason: toTurnStopReason(message.stopReason),
                message: failureMessage,
                usages,
                model: model.id,
            };
        }
        const usage = toCompletionUsage(model.id, message.usage);
        usages.push(usage);
        logSingleShotCompletion(options.logger, model.id, message, durationMs, usage, attempt);
        try {
            return {
                kind: SingleShotResultKind.Parsed,
                value: v.parse(options.schema, parseJsonResponse(contentText(message.content))),
                usages,
                attempts: attempt,
                model: model.id,
            };
        } catch (error) {
            lastFailure = validationDetail(error);
            options.logger?.warn(
                {
                    attempt,
                    model: model.id,
                    detail: lastFailure,
                    reply: contentText(message.content).slice(0, MAX_LOGGED_INVALID_RESPONSE_CHARS),
                },
                'single-shot LLM call: the reply did not match the schema',
            );
            if (attempt === maxAttempts) {
                break;
            }
            messages = [
                ...messages,
                boundedAssistantReplay(message),
                {
                    role: 'user',
                    content:
                        'The previous JSON did not match the required schema: ' +
                        `${lastFailure}. Return a corrected JSON object only.`,
                    timestamp: Date.now(),
                },
            ];
        }
    }
    options.logger?.warn(
        {
            kind: SingleShotResultKind.InvalidResult,
            detail: lastFailure,
            attempts: maxAttempts,
            model: model.id,
        },
        'single-shot LLM call failed: no schema-valid reply after bounded repair attempts',
    );
    return {
        kind: SingleShotResultKind.InvalidResult,
        detail: lastFailure,
        attempts: maxAttempts,
        usages,
        model: model.id,
    };
}

/**
 * Log one completed single-shot call with its wall time and token counts.
 *
 * A single-shot call has no turn in the trace: a run can spend 22 minutes inside the intake
 * extraction with nothing logged in between, and that silence is indistinguishable from a hang
 * until the call returns. Wall time beside the token counts is what tells a trickling stream from a
 * long answer.
 *
 * @param logger - Diagnostics sink; nothing is logged without one.
 * @param modelId - Model the call was bound to.
 * @param message - The completed assistant message.
 * @param durationMs - Wall time from the request start to the completed message.
 * @param usage - The call's token accounting.
 * @param attempt - One-based attempt index within the single-shot call.
 */
function logSingleShotCompletion(
    logger: Logger | undefined,
    modelId: string,
    message: AssistantMessage,
    durationMs: number,
    usage: CompletionUsage,
    attempt: number,
): void {
    logger?.info(
        {
            model: modelId,
            stopReason: message.stopReason,
            durationMs,
            attempt,
            inputTokens: usage.input,
            outputTokens: usage.output,
            reasoningTokens: usage.reasoningTokens,
        },
        'single-shot LLM call completed',
    );
}

/**
 * Bind one model handle into the consumer-facing single-shot client.
 *
 * @param runtime - The pi runtime the handle belongs to.
 * @param model - Bound model handle (typically `PiRuntime.visionModel`).
 * @param defaults - Call defaults mapped from `CoreConfig.llm` at the wiring sites.
 * @returns The two-method consumer boundary.
 */
export function createSingleShotClient(
    runtime: PiRuntime,
    model: Model<Api>,
    defaults: SingleShotClientDefaults = {},
): SingleShotClient {
    return {
        modelId: model.id,
        structured: <T>(options: SingleShotStructuredOptions<T>) =>
            runStructuredSingleShot(runtime, model, {
                timeoutMs: defaults.timeoutMs,
                ceilingMs: defaults.ceilingMs,
                maxRetries: defaults.maxRetries,
                maxTokens: defaults.maxTokens,
                reasoningEffort: defaults.reasoningEffort,
                logger: defaults.logger,
                ...options,
            }),
        text: async (options: SingleShotCallOptions): Promise<SingleShotResult<string>> => {
            const converted = await toPiMessages(options.messages);
            const startedAt = Date.now();
            const message = await completeOnce(
                runtime,
                model,
                converted.systemPrompt,
                converted.messages,
                {
                    timeoutMs: defaults.timeoutMs,
                    ceilingMs: defaults.ceilingMs,
                    maxRetries: defaults.maxRetries,
                    maxTokens: defaults.maxTokens,
                    reasoningEffort: defaults.reasoningEffort,
                    ...options,
                },
            );
            const durationMs = Date.now() - startedAt;
            const usages = [toCompletionUsage(model.id, message.usage)];
            if (message.stopReason === TurnStopReason.Stop) {
                logSingleShotCompletion(
                    options.logger ?? defaults.logger,
                    model.id,
                    message,
                    durationMs,
                    usages[0]!,
                    1,
                );
                return {
                    kind: SingleShotResultKind.Parsed,
                    value: contentText(message.content),
                    usages,
                    attempts: 1,
                    model: model.id,
                };
            }
            const failureMessage =
                message.errorMessage ??
                `pi completion ended with stop reason "${message.stopReason}"`;
            const failureLogger = options.logger ?? defaults.logger;
            failureLogger?.warn(
                {
                    kind: SingleShotResultKind.ProviderFailure,
                    stopReason: message.stopReason,
                    message: failureMessage,
                    attempts: 1,
                    model: model.id,
                    durationMs,
                },
                'single-shot LLM call failed: provider or daemon error',
            );
            return {
                kind: SingleShotResultKind.ProviderFailure,
                stopReason: toTurnStopReason(message.stopReason),
                message: failureMessage,
                // The attempt is reported like a successful one so the metered client can record
                // it; without this a failed text call left no trace in the run's usage at all.
                usages,
                model: model.id,
            };
        },
    };
}
