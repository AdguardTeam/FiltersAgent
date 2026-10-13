/**
 * Configuration→pi wiring: the two mappings from the validated `llm` configuration slice onto pi's
 * factories that every mode, runner and evaluator needs — the runtime handle and the out-of-loop
 * single-shot client, metered when the run collects usage. Keeping them here means a change to the
 * retry derivation or the runtime fields is made once instead of at every call site. The injection
 * seams stay with the callers: a site that accepts an injected runtime or vision client still
 * resolves its own `dependencies.*` first and only calls these helpers for the default. An injected
 * client is then used exactly as given: metering belongs to the client this module builds, and
 * re-wrapping a caller's own metered client would count its completions twice.
 */
import type { Api, Model } from '@earendil-works/pi-ai';
import type { LlmConfig } from '../config/config';
import type { Logger } from '../logger/logger';
import { createPiRuntime, type PiRuntime } from './runtime';
import { createSingleShotClient } from './single-shot';
import type { SingleShotClient } from './single-shot-types';
import { meterSingleShotClient, type RunUsageCollector } from './usage-collector';
import { SINGLE_SHOT_CALL_CEILING_MS } from './single-shot-completion';

/**
 * Diagnostics and metering for one configured single-shot client.
 */
export interface ConfiguredSingleShotOptions {
    /**
     * Diagnostics sink for the client's own failure lines.
     */
    logger: Logger;

    /**
     * Run-scoped usage collector; when present the client is wrapped so every completion's usage is
     * metered into it. Absent → the unmetered client.
     */
    usageCollector?: RunUsageCollector;
}

/**
 * Create the run's pi runtime from the configured provider slice.
 *
 * @param llm - The validated LLM provider configuration.
 * @param modelOverride - Reasoning-model override from `--model`; defaults to the configured model.
 * @returns The ready pi runtime handle.
 */
export async function createPiRuntimeFromConfig(
    llm: LlmConfig,
    modelOverride?: string,
): Promise<PiRuntime> {
    return await createPiRuntime({
        baseUrl: llm.baseUrl,
        apiKey: llm.apiKey,
        model: modelOverride ?? llm.model,
        visionModel: llm.visionModel,
        contextWindowTokens: llm.contextWindowTokens,
        maxOutputTokens: llm.maxOutputTokens,
        visionMaxOutputTokens: llm.visionMaxOutputTokens,
        providerRouting: llm.providerRouting,
        reasoningEffort: llm.reasoningEffort,
    });
}

/**
 * Retries per provider request derived from the configured attempt bound — one derivation for the
 * single-shot clients and the loop sessions alike.
 *
 * The configuration counts total attempts while pi counts retries after the first, hence the −1;
 * the floor keeps a configuration that sets the bound to 1 from asking pi for −1 retries. The bound
 * itself is always present, defaulted once at the env boundary in `loadCoreConfig`, so nothing here
 * substitutes one — passing pi no bound at all would silently mean three.
 *
 * @param llm - The validated LLM provider configuration.
 * @returns The retry count passed to pi.
 */
export function providerMaxRetries(llm: LlmConfig): number {
    return Math.max(0, llm.requestMaxAttempts - 1);
}

/**
 * Create a single-shot client on one model handle with the configured deadline and retry bound,
 * metered when the run collects usage.
 *
 * @param runtime - The run's pi runtime.
 * @param model - The model handle the client calls.
 * @param llm - The validated LLM provider configuration.
 * @param options - Diagnostics sink and the optional usage collector.
 * @returns The configured single-shot client.
 */
export function createConfiguredSingleShotClient(
    runtime: PiRuntime,
    model: Model<Api>,
    llm: LlmConfig,
    options: ConfiguredSingleShotOptions,
): SingleShotClient {
    const client = createSingleShotClient(runtime, model, {
        timeoutMs: llm.requestTimeoutMs,
        // The total-duration ceiling beside the inactivity bound: a generation that never stops
        // streaming is otherwise ended only by the tool deadline around it, half an hour later.
        ceilingMs: SINGLE_SHOT_CALL_CEILING_MS,
        maxRetries: providerMaxRetries(llm),
        // The role's configured completion cap, sent explicitly: pi's typed completion path sends
        // only what the call passes, so without this a single-shot request carries no cap and the
        // provider's own default can cut a reasoning model's vision verdict at `length`.
        maxTokens: model.maxTokens,
        // The single-shot level, one setting for every single-shot call the run makes (the loop
        // sessions carry `llm.reasoningEffort`). It reaches the wire only for a model registered
        // `reasoning: true`, so it is inert on a client bound to the vision model and live on one
        // bound to a reasoning model (the intake extraction, a reviewer); wiring it once here is
        // what keeps those from diverging.
        reasoningEffort: llm.singleShotReasoningEffort,
        logger: options.logger,
    });
    return options.usageCollector === undefined
        ? client
        : meterSingleShotClient(client, options.usageCollector);
}

/**
 * Create the run's vision client: a configured single-shot client bound to the runtime's vision
 * model.
 *
 * @param runtime - The run's pi runtime.
 * @param llm - The validated LLM provider configuration.
 * @param options - Diagnostics sink and the optional usage collector.
 * @returns The configured vision client.
 */
export function createVisionClient(
    runtime: PiRuntime,
    llm: LlmConfig,
    options: ConfiguredSingleShotOptions,
): SingleShotClient {
    return createConfiguredSingleShotClient(runtime, runtime.visionModel, llm, options);
}
