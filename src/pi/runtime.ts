import { InMemoryCredentialStore, type Api, type Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { LlmConfig } from '../config/config';
import type { ProviderRouting } from '../config/provider-routing';
import { ReasoningEffort } from '../config/reasoning-effort';
import { installHttpTransport } from './http-transport';

/**
 * Pi runtime setup: turn application provider configuration into a ready pi model runtime — the
 * configured OpenAI-compatible gateway registered entirely in code over the OpenAI-completions API,
 * credentials held in an in-memory store, both model handles resolved, compatibility flags
 * applied.
 *
 * One gateway, but TWO provider registrations — one per ROLE — because a pi provider catalog holds
 * one entry per model ID and pi resolves a handle by `getModels(provider).find(m => m.id === id)`
 * (`pi-ai`'s `models.js`). The two roles are registered with deliberately different capabilities:
 * the reasoning entry is `input: ['text']`, the vision entry `input: ['text', 'image']`. Put both
 * in one catalog and a configuration that names the SAME slug for both roles collapses onto
 * whichever entry was registered first — the text-only one — and pi's message transform then strips
 * every image before the request with `(image omitted: model does not support images)`: with
 * `llmModel` and `llmVisionModel` both set to one slug, every `analyze_screenshot` call is answered
 * with "No image was delivered with this request". A provider id per role gives each its own slot,
 * so the two handles stay distinct no matter how the ids compare — one slug serving both roles is a
 * supported configuration, not a collision.
 */

/**
 * Provider id the REASONING role's gateway entry is registered under inside the pi runtime.
 */
export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible';

/**
 * Provider id the VISION role's gateway entry is registered under inside the pi runtime.
 *
 * Same gateway, same credential, same API — a second registration exists only so the vision entry
 * owns its own catalog slot; see the module note for what sharing one slot cost.
 */
export const OPENAI_COMPATIBLE_VISION_PROVIDER_ID = 'openai-compatible-vision';

/**
 * Explicit zero rates registered with every catalog entry.
 *
 * Pi derives `Usage.cost` from these rates and this layer never reads that field: run cost is
 * priced by `usage-collector.ts` from the tracked, digest-pinned rate table, because a cost figure
 * is only comparable across runs when every run priced the same way. Zeroes are what pi is told, so
 * nothing can quietly start reporting a fabricated in-catalog price instead.
 */
const UNPRICED_MODEL_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/**
 * OpenAI-completions compatibility flags for the configured gateway, applied to every registered
 * model.
 *
 * `requiresReasoningContentOnAssistantMessages` replays `reasoning_content` on assistant history:
 * some thinking-mode OpenAI-compatible gateways hard-fail the following request without it. pi's
 * URL auto-detection cannot fire here — the gateway host is not `deepseek.com` — so the flag must
 * be explicit, and it only takes effect on entries registered with `reasoning: true`.
 *
 * `sendSessionAffinityHeaders` with `sessionAffinityFormat: 'openai'` attaches `session_id`,
 * `x-client-request-id`, and `x-session-affinity` headers whenever a caller passes a session id,
 * which is how the gateway routes one session to a warm prompt-cache replica.
 *
 * `supportsDeveloperRole: false` keeps the system prompt under the `system` role. Pi's
 * openai-completions API sends it as `developer` for any entry registered `reasoning: true` unless
 * the flag says otherwise, and its URL auto-detection only turns the role off for hosts it knows
 * (`deepseek.com`, `cerebras.ai`, …) — the gateway host is none of them, so the detected default is
 * `true`. The gateway's upstream pool is not uniform on that role: a replica can answer 400
 * "messages[0].role: unknown variant developer, expected one of system, user, assistant, tool"
 * mid-session after other replicas accepted the same model, system prompt and role, and the run
 * then seals `provider-failure` as a deterministic rejection. `system` is the one spelling every
 * OpenAI-shaped upstream accepts, and the two roles are equivalent to the gateway, so nothing is
 * given up by pinning it.
 */
const OPENAI_COMPATIBLE_COMPAT = {
    requiresReasoningContentOnAssistantMessages: true,
    sendSessionAffinityHeaders: true,
    sessionAffinityFormat: 'openai',
    supportsDeveloperRole: false,
} as const;

/**
 * The compatibility settings one catalog entry carries: the gateway's fixed OpenAI-completions
 * flags, plus the deployment's routing preferences when it configured any.
 *
 * Absent stays absent. Pi puts a `provider` object on the request only for an entry whose compat
 * carries `openRouterRouting`, and a gateway that is not OpenRouter ignores or rejects that field,
 * so an unconfigured deployment must send no `provider` at all — an empty object would be a
 * configured preference on the wire.
 *
 * @param providerRouting - The configured routing document, or `undefined` when none is set.
 * @returns The entry's compat settings.
 */
function gatewayCompat(providerRouting: ProviderRouting | undefined) {
    return {
        ...OPENAI_COMPATIBLE_COMPAT,
        ...(providerRouting === undefined ? {} : { openRouterRouting: providerRouting }),
    };
}

/**
 * The provider registration shape accepted by `ModelRuntime.registerProvider`.
 *
 * Pi-coding-agent's public index does not re-export `ProviderConfigInput`, so the type is lifted
 * from the method signature (the same trick the knowledge-base runtime uses).
 */
type ProviderRegistration = Parameters<ModelRuntime['registerProvider']>[1];

/**
 * One model entry of a provider registration's catalog.
 */
type CatalogEntry = NonNullable<ProviderRegistration['models']>[number];

/**
 * Provider configuration the pi runtime setup consumes: the slice of `CoreConfig.llm` that
 * describes the gateway and the two models registered against it.
 *
 * Taken directly, not re-validated: `loadCoreConfig` already enforced this shape at the environment
 * boundary and `createPiRuntimeFromConfig` hands over exactly that validated value, so a second
 * check here could only ever pass.
 */
export type PiRuntimeConfig = Pick<
    LlmConfig,
    | 'baseUrl'
    | 'apiKey'
    | 'model'
    | 'visionModel'
    | 'contextWindowTokens'
    | 'maxOutputTokens'
    | 'visionMaxOutputTokens'
    | 'providerRouting'
    | 'reasoningEffort'
>;

/**
 * Thrown when a model id does not resolve on this runtime's provider catalog.
 *
 * A lookup failure, not a configuration one — the configuration was validated at the env boundary
 * and this runtime never re-checks it. The message still names the field that carried the id (`-
 * model: ...`), mirroring `ConfigError`, so a broken setup is diagnosable in one read and never
 * surfaces as a bare stack.
 */
export class PiModelLookupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PiModelLookupError';
    }
}

/**
 * A configured, app-owned pi runtime: both role providers registered in code, credentials in
 * memory, both model handles resolved.
 */
export interface PiRuntime {
    /**
     * The underlying pi model runtime every agent session and single-shot call is built on.
     */
    modelRuntime: ModelRuntime;

    /**
     * Resolved reasoning-model handle (`PiRuntimeConfig.model`), from the reasoning role's
     * provider: text-only input, the loop completion cap.
     */
    reasoningModel: Model<Api>;

    /**
     * Resolved vision-model handle (`PiRuntimeConfig.visionModel`), from the vision role's
     * provider: image-capable input, the vision completion cap. Distinct from `reasoningModel` even
     * when the two configured ids are identical.
     */
    visionModel: Model<Api>;

    /**
     * The gateway routing preferences this runtime was configured with, or `undefined` when the
     * deployment set none.
     *
     * Kept on the handle because routing is a property of the RUN, not of one registration: a model
     * registered later on this runtime (`registerAdditionalTextModel`) must steer exactly like the
     * two registered at creation, and the handle is the only thing it is given. Without it, a
     * deployment that routes around a faulting upstream would still send the reviewer's requests
     * into it.
     */
    providerRouting?: ProviderRouting;
}

/**
 * Register one extra text-only reasoning model on the REASONING role's provider and resolve it.
 *
 * A caller's model override (a reviewer model, for instance, defaulting to the configured reasoning
 * model) may name a slug outside the two configured models; the pi runtime supports any slug the
 * gateway serves by extending the in-code catalog. Idempotent: an already-registered id resolves
 * without re-registering.
 *
 * The new entry inherits the resolved reasoning model's catalog limits — it stands in for exactly
 * that role — so an override model is bounded by the configured values and no second default for
 * either limit exists anywhere in this layer. It extends the reasoning provider for the same
 * reason: it is a reasoning-role entry, and the vision role's catalog stays untouched.
 *
 * @param runtime - The runtime whose provider catalog is extended.
 * @param modelId - The additional model id served by the gateway.
 * @returns The resolved model handle.
 */
export function registerAdditionalTextModel(runtime: PiRuntime, modelId: string): Model<Api> {
    const existing = runtime.modelRuntime.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, modelId);
    if (existing) {
        return existing;
    }
    const registration = runtime.modelRuntime.getRegisteredProviderConfig(
        OPENAI_COMPATIBLE_PROVIDER_ID,
    );
    if (!registration) {
        throw new PiModelLookupError(
            `Invalid pi runtime configuration:\n  - model: provider ${OPENAI_COMPATIBLE_PROVIDER_ID} ` +
                'is not registered on this runtime',
        );
    }
    runtime.modelRuntime.registerProvider(OPENAI_COMPATIBLE_PROVIDER_ID, {
        ...registration,
        models: [
            ...(registration.models ?? []),
            {
                id: modelId,
                name: modelId,
                reasoning: runtime.reasoningModel.reasoning,
                input: ['text'],
                cost: { ...UNPRICED_MODEL_COST },
                contextWindow: runtime.reasoningModel.contextWindow,
                maxTokens: runtime.reasoningModel.maxTokens,
                compat: gatewayCompat(runtime.providerRouting),
            },
        ],
    });
    return resolveModel(runtime.modelRuntime, OPENAI_COMPATIBLE_PROVIDER_ID, modelId, 'model');
}

/**
 * The catalog fields both role entries carry identically: unpriced cost, the configured context
 * window, and the gateway compat flags.
 *
 * `contextWindow` is not decoration — pi measures its auto-compaction threshold (`contextWindow −
 * reserveTokens`) against it on every request — and it is one number for the gateway, not per role,
 * so it is shared here. It is required configuration, defaulted once in `config.ts`. The compat
 * settings are shared for the same reason: routing is the gateway's, so both roles steer alike and
 * every loop turn and single-shot call of the run carries the same preference.
 *
 * @param config - Validated provider configuration.
 * @returns The shared slice of a catalog entry.
 */
function sharedCatalogFields(config: PiRuntimeConfig) {
    return {
        cost: { ...UNPRICED_MODEL_COST },
        contextWindow: config.contextWindowTokens,
        compat: gatewayCompat(config.providerRouting),
    };
}

/**
 * Whether the configured reasoning model is registered as one that reasons.
 *
 * @param config - Validated provider configuration.
 * @returns `false` when the deployment set its reasoning effort to `off`.
 */
function reasons(config: PiRuntimeConfig): boolean {
    return config.reasoningEffort !== ReasoningEffort.Off;
}

/**
 * Build the catalog entry for the configured REASONING model.
 *
 * `maxTokens` is sent as `max_completion_tokens`, clamped to what is left of the window, and the
 * completion cap is per ROLE because the two roles are bounded by different things: the loop model
 * spends the same budget on thinking and on the terminal payload that follows it, while a vision
 * call returns one bounded JSON verdict. `input: ['text']` is what the loop model is asked for.
 *
 * `reasoning` follows the configured effort: an entry registered `reasoning: true` puts a level on
 * the wire and replays `reasoning_content` on its history (the DeepSeek-style compat flags), and a
 * model that does not reason may refuse both, so `off` registers it as a plain model.
 *
 * @param config - Validated provider configuration.
 * @returns The reasoning entry with its configured completion cap.
 */
function reasoningCatalogEntry(config: PiRuntimeConfig): CatalogEntry {
    return {
        ...sharedCatalogFields(config),
        id: config.model,
        name: config.model,
        reasoning: reasons(config),
        input: ['text'],
        maxTokens: config.maxOutputTokens,
    };
}

/**
 * Build the catalog entry for the configured VISION model.
 *
 * `input: ['text', 'image']` is the whole reason this entry needs a catalog slot of its own: pi's
 * message transform reads it per resolved handle and replaces every image part with a placeholder
 * when it does not carry `'image'` — see the module note.
 *
 * `reasoning` follows the slug: pi puts a reasoning level on the wire only for an entry registered
 * `reasoning: true`, and the only vision model this runtime can vouch for as a reasoning model is
 * the reasoning model itself. When both roles name one slug the vision entry is registered with
 * reasoning support so `llm.singleShotReasoningEffort` reaches its calls: registered without it,
 * vision verdicts carry no level at all and the gateway's own default can let the model spend 6.8k
 * of 7k output tokens on thinking per call, four minutes each, until `apply_rule` hits its
 * deadline. A distinct vision slug (a model this runtime knows nothing about) stays `reasoning:
 * false`, so no level is sent to a model that may refuse the parameter, and so does a shared slug
 * whose reasoning the deployment turned off.
 *
 * @param config - Validated provider configuration.
 * @returns The vision entry with its configured completion cap.
 */
function visionCatalogEntry(config: PiRuntimeConfig): CatalogEntry {
    return {
        ...sharedCatalogFields(config),
        id: config.visionModel,
        name: config.visionModel,
        reasoning: config.visionModel === config.model && reasons(config),
        input: ['text', 'image'],
        maxTokens: config.visionMaxOutputTokens,
    };
}

/**
 * Resolve one registered model handle, or fail naming the configuration field that selected it.
 *
 * @param modelRuntime - The runtime the provider was registered on.
 * @param providerId - Provider id whose catalog holds the entry — the role decides it, so a slug
 *   serving both roles resolves to the right capabilities on each.
 * @param modelId - Model id to resolve.
 * @param field - Configuration field that carried the id.
 * @returns The resolved model handle.
 */
function resolveModel(
    modelRuntime: ModelRuntime,
    providerId: string,
    modelId: string,
    field: string,
): Model<Api> {
    const model = modelRuntime.getModel(providerId, modelId);
    if (!model) {
        throw new PiModelLookupError(
            `Invalid pi runtime configuration:\n  - ${field}: model is not registered ` +
                `with the ${providerId} provider`,
        );
    }
    return model;
}

/**
 * Turn validated provider configuration into a ready pi model runtime.
 *
 * `modelsPath: null` plus the `InMemoryCredentialStore` guarantee nothing is read from or written
 * to any home-directory pi configuration, and `ModelRuntime.create` performs no network access (its
 * model-network flag defaults off), so setup is safe to run anywhere.
 *
 * The one gateway is registered TWICE — same `baseUrl`, same API, same compat flags, same
 * credential — so each role owns its own catalog slot and a configuration naming one slug for both
 * roles still resolves an image-capable vision handle; see the module note for why that matters. Pi
 * keys everything it does off `model.provider` — credential lookup included — which is why
 * `setRuntimeApiKey` runs for both ids.
 *
 * @param config - Provider fields (typically `CoreConfig.llm`).
 * @returns The runtime with both model handles resolved.
 */
export async function createPiRuntime(config: PiRuntimeConfig): Promise<PiRuntime> {
    // Before any request: every mode reaches the network only through a runtime created here.
    installHttpTransport();
    const modelRuntime = await ModelRuntime.create({
        modelsPath: null,
        credentials: new InMemoryCredentialStore(),
    });
    const gateway = { baseUrl: config.baseUrl, api: 'openai-completions' } as const;
    modelRuntime.registerProvider(OPENAI_COMPATIBLE_PROVIDER_ID, {
        ...gateway,
        name: 'OpenAI-compatible',
        models: [reasoningCatalogEntry(config)],
    });
    modelRuntime.registerProvider(OPENAI_COMPATIBLE_VISION_PROVIDER_ID, {
        ...gateway,
        name: 'OpenAI-compatible (vision)',
        models: [visionCatalogEntry(config)],
    });
    await modelRuntime.setRuntimeApiKey(OPENAI_COMPATIBLE_PROVIDER_ID, config.apiKey);
    await modelRuntime.setRuntimeApiKey(OPENAI_COMPATIBLE_VISION_PROVIDER_ID, config.apiKey);
    return {
        modelRuntime,
        providerRouting: config.providerRouting,
        reasoningModel: resolveModel(
            modelRuntime,
            OPENAI_COMPATIBLE_PROVIDER_ID,
            config.model,
            'model',
        ),
        visionModel: resolveModel(
            modelRuntime,
            OPENAI_COMPATIBLE_VISION_PROVIDER_ID,
            config.visionModel,
            'visionModel',
        ),
    };
}
