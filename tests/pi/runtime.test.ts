import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { ReasoningEffort } from '../../src/config/reasoning-effort';
import { createSingleShotClient } from '../../src/pi/single-shot';
import { SingleShotResultKind } from '../../src/pi/single-shot-types';
import { TurnStopReason } from '../../src/pi/stop-reason';
import {
    createPiRuntime,
    registerAdditionalTextModel,
    OPENAI_COMPATIBLE_PROVIDER_ID,
    type PiRuntime,
} from '../../src/pi/runtime';
import {
    HermeticScenario,
    type HermeticProvider,
    ScriptedReplyKind,
    startHermeticProvider,
} from './hermetic-provider';
import {
    REASONING_MODEL,
    TEST_API_KEY,
    TEST_CONTEXT_WINDOW_TOKENS,
    TEST_MAX_OUTPUT_TOKENS,
    TEST_REASONING_EFFORT,
    TEST_VISION_MAX_OUTPUT_TOKENS,
    VISION_MODEL,
} from './test-runtime';

/**
 * Syntactically valid provider URL with nothing listening: runtime setup performs no network I/O,
 * so handle resolution and config validation never touch it.
 */
const UNREACHABLE_BASE_URL = 'http://127.0.0.1:9/v1';

/**
 * 1x1 transparent PNG: the smallest valid image part a wire assertion can look for.
 */
const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function testConfig(baseUrl: string) {
    return {
        baseUrl,
        apiKey: TEST_API_KEY,
        model: REASONING_MODEL,
        visionModel: VISION_MODEL,
        contextWindowTokens: TEST_CONTEXT_WINDOW_TOKENS,
        maxOutputTokens: TEST_MAX_OUTPUT_TOKENS,
        visionMaxOutputTokens: TEST_VISION_MAX_OUTPUT_TOKENS,
        reasoningEffort: TEST_REASONING_EFFORT,
    };
}

/**
 * Complete one request on the reasoning model whose history holds an earlier assistant turn.
 *
 * @param runtime - The runtime under test.
 */
async function completeAfterPriorTurn(runtime: PiRuntime): Promise<void> {
    const priorTurn: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'earlier answer' }],
        api: 'openai-completions',
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
        model: REASONING_MODEL,
        usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
    };
    await runtime.modelRuntime.complete(runtime.reasoningModel, {
        messages: [
            { role: 'user', content: 'first', timestamp: Date.now() },
            priorTurn,
            { role: 'user', content: 'second', timestamp: Date.now() },
        ],
    });
}

describe('createPiRuntime', () => {
    it('resolves reasoning and vision model handles from a complete configuration', async () => {
        const runtime = await createPiRuntime(testConfig(UNREACHABLE_BASE_URL));

        expect(runtime.reasoningModel.id).toBe(REASONING_MODEL);
        expect(runtime.reasoningModel.reasoning).toBe(true);
        expect(runtime.reasoningModel.input).toEqual(['text']);
        expect(runtime.visionModel.id).toBe(VISION_MODEL);
        expect(runtime.visionModel.reasoning).toBe(false);
        expect(runtime.visionModel.input).toContain('image');
    });

    it('registers the configured catalog limits, per role', async () => {
        // These are not decoration: pi measures its auto-compaction threshold against
        // contextWindow and sends maxTokens as max_completion_tokens on every request. The
        // completion cap is per ROLE because the two roles are bounded by different things — the
        // loop model spends one budget on thinking and on the terminal payload after it, a vision
        // call returns one bounded verdict — so a single shared cap would silently impose one
        // role's measurement on the other.
        const runtime = await createPiRuntime({
            ...testConfig(UNREACHABLE_BASE_URL),
            contextWindowTokens: 262_144,
            maxOutputTokens: 96_000,
            visionMaxOutputTokens: 4_096,
        });

        expect(runtime.reasoningModel.contextWindow).toBe(262_144);
        expect(runtime.reasoningModel.maxTokens).toBe(96_000);
        expect(runtime.visionModel.contextWindow).toBe(262_144);
        expect(runtime.visionModel.maxTokens).toBe(4_096);

        // A reviewer-model override stands in for the reasoning model, so it inherits exactly that
        // entry's configured limits instead of silently taking pi's own.
        const extra = registerAdditionalTextModel(runtime, 'reviewer-model');
        expect(extra.contextWindow).toBe(262_144);
        expect(extra.maxTokens).toBe(96_000);
    });
});

let provider: HermeticProvider | undefined;

afterEach(async () => {
    if (!provider) {
        return;
    }
    await provider.close();
    provider = undefined;
});

describe('pi runtime against the hermetic provider', () => {
    it('drives a completion round-trip: streamed text, usage, Bearer auth', async () => {
        provider = await startHermeticProvider({ scenario: HermeticScenario.Text, text: 'pong' });
        const runtime = await createPiRuntime(testConfig(provider.baseUrl));

        const result = await createSingleShotClient(runtime, runtime.reasoningModel).text({
            messages: [{ role: 'user', text: 'ping' }],
        });

        expect(result.kind).toBe(SingleShotResultKind.Parsed);
        if (result.kind !== SingleShotResultKind.Parsed) {
            return;
        }
        expect(result.value).toBe('pong');
        expect(result.usages[0]!.input).toBeGreaterThan(0);
        expect(result.usages[0]!.output).toBeGreaterThan(0);
        expect(provider.requests).toHaveLength(1);
        const request = provider.requests[0]!;
        expect(request.headers.authorization).toBe(`Bearer ${TEST_API_KEY}`);
        expect(request.model).toBe(REASONING_MODEL);
        expect(request.stream).toBe(true);
    });

    it('attaches session-affinity headers when a session id is passed', async () => {
        provider = await startHermeticProvider({ scenario: HermeticScenario.Text });
        const runtime = await createPiRuntime(testConfig(provider.baseUrl));

        await runtime.modelRuntime.complete(
            runtime.reasoningModel,
            { messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }] },
            { sessionId: 'pi-session-1' },
        );

        const headers = provider.requests[0]!.headers;
        expect(headers['session_id']).toBe('pi-session-1');
        expect(headers['x-client-request-id']).toBe('pi-session-1');
        expect(headers['x-session-affinity']).toBe('pi-session-1');
    });

    it('replays an empty reasoning_content on assistant history (DeepSeek-style compat)', async () => {
        provider = await startHermeticProvider({ scenario: HermeticScenario.Text });
        const runtime = await createPiRuntime(testConfig(provider.baseUrl));

        await completeAfterPriorTurn(runtime);

        const assistant = provider.requests[0]!.messages.find((m) => m.role === 'assistant');
        expect(assistant).toHaveProperty('reasoning_content', '');
    });

    it('registers a model whose reasoning effort is off as one that does not reason', async () => {
        // A model that does not reason may refuse both the level and the replayed
        // `reasoning_content`, so `off` registers it as a plain model: neither reaches the wire.
        provider = await startHermeticProvider({ scenario: HermeticScenario.Text });
        const runtime = await createPiRuntime({
            ...testConfig(provider.baseUrl),
            visionModel: REASONING_MODEL,
            reasoningEffort: ReasoningEffort.Off,
        });

        expect(runtime.reasoningModel.reasoning).toBe(false);
        expect(runtime.visionModel.reasoning).toBe(false);

        await completeAfterPriorTurn(runtime);
        await createSingleShotClient(runtime, runtime.reasoningModel, {
            reasoningEffort: ReasoningEffort.High,
        }).text({ messages: [{ role: 'user', text: 'ping' }] });

        const assistant = provider.requests[0]!.messages.find((m) => m.role === 'assistant');
        expect(assistant).not.toHaveProperty('reasoning_content');
        expect(provider.requests[1]!.reasoningEffort).toBeNull();
    });

    it('serves a scripted tool call the real runtime assembles', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.ToolCall,
            toolName: 'lookup_issue',
            toolArguments: '{"number":7}',
        });
        const runtime = await createPiRuntime(testConfig(provider.baseUrl));

        const message = await runtime.modelRuntime.complete(runtime.reasoningModel, {
            messages: [{ role: 'user', content: 'look it up', timestamp: Date.now() }],
        });

        expect(message.stopReason).toBe('toolUse');
        const toolCall = message.content.find((block) => block.type === 'toolCall');
        expect(toolCall).toBeDefined();
        if (toolCall?.type !== 'toolCall') {
            return;
        }
        expect(toolCall.name).toBe('lookup_issue');
        expect(toolCall.arguments).toEqual({ number: 7 });
    });

    it('surfaces a scripted 401 as a typed failure carrying the provider message', async () => {
        provider = await startHermeticProvider({ scenario: HermeticScenario.AuthError });
        const runtime = await createPiRuntime(testConfig(provider.baseUrl));

        const result = await createSingleShotClient(runtime, runtime.reasoningModel).text({
            messages: [{ role: 'user', text: 'ping' }],
        });

        expect(result.kind).toBe(SingleShotResultKind.ProviderFailure);
        if (result.kind !== SingleShotResultKind.ProviderFailure) {
            return;
        }
        expect(result.message).toContain('auth failed');
    });

    it('a hanging provider ends as a typed failure once the caller aborts', async () => {
        provider = await startHermeticProvider({ scenario: HermeticScenario.Hang });
        const runtime = await createPiRuntime(testConfig(provider.baseUrl));
        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), 250);

        try {
            const result = await createSingleShotClient(runtime, runtime.reasoningModel).text({
                messages: [{ role: 'user', text: 'ping' }],
                signal: controller.signal,
            });
            expect(result.kind).toBe(SingleShotResultKind.ProviderFailure);
            if (result.kind !== SingleShotResultKind.ProviderFailure) {
                return;
            }
            expect(result.stopReason).toBe(TurnStopReason.Aborted);
        } finally {
            clearTimeout(abortTimer);
        }
    });

    it('keeps the vision role image-capable when both roles name one model id', async () => {
        // A live run configured llmModel and llmVisionModel to the same slug and every
        // analyze_screenshot answered "No image was delivered with this request": one catalog slot
        // per model ID meant the vision handle resolved to the text-only entry, and pi's transform
        // replaced the image with a placeholder. The contract is the role, not the id — a slug may
        // serve both.
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Text,
            text: 'looks broken',
        });
        const runtime = await createPiRuntime({
            ...testConfig(provider.baseUrl),
            model: REASONING_MODEL,
            visionModel: REASONING_MODEL,
        });

        expect(runtime.visionModel.input).toContain('image');
        expect(runtime.visionModel.maxTokens).toBe(TEST_VISION_MAX_OUTPUT_TOKENS);
        // The one slug is a reasoning model, so the vision role can carry a reasoning level too.
        expect(runtime.visionModel.reasoning).toBe(true);
        expect(runtime.reasoningModel.input).toEqual(['text']);
        expect(runtime.reasoningModel.maxTokens).toBe(TEST_MAX_OUTPUT_TOKENS);

        // End to end: the image part survives onto the wire instead of being downgraded, and the
        // single-shot reasoning level reaches a vision call bound to the shared slug — registered
        // without reasoning support, the call carried no level and the gateway's default let a
        // live run's vision verdicts think for minutes per call.
        await createSingleShotClient(runtime, runtime.visionModel, {
            reasoningEffort: ReasoningEffort.Low,
        }).text({
            messages: [
                {
                    role: 'user',
                    text: 'what is wrong here',
                    images: [{ bytes: Buffer.from(PNG_1PX, 'base64') }],
                },
            ],
        });

        const userWire = JSON.stringify(provider.requests[0]!.messages.at(-1));
        expect(userWire).toContain('data:image/png;base64,');
        expect(userWire).not.toContain('image omitted');
        expect(provider.requests[0]!.reasoningEffort).toBe(ReasoningEffort.Low);
    });

    it('steers every request with the configured gateway routing, and sends none without it', async () => {
        // OpenRouter routes one model slug across a dozen upstream providers, and a faulting one
        // ("Upstream error from Together: Stream error: h2 protocol error") ended four live runs
        // that the retry bound could not absorb. The routing document is how a deployment routes
        // around it, so it has to reach EVERY request the run makes — a loop turn, a vision
        // single shot, and a reviewer model registered later on the same runtime. The other half
        // of the contract is just as load-bearing: routing is one gateway's feature, and a
        // deployment that configured none must send no `provider` field at all, because another
        // gateway rejects the unknown field and fails the run.
        provider = await startHermeticProvider({ scenario: HermeticScenario.Text });
        const routing = { ignore: ['Together'], allow_fallbacks: true };
        const routed = await createPiRuntime({
            ...testConfig(provider.baseUrl),
            providerRouting: routing,
        });

        await routed.modelRuntime.complete(routed.reasoningModel, {
            messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
        });
        await createSingleShotClient(routed, routed.visionModel).text({
            messages: [{ role: 'user', text: 'what is wrong here' }],
        });
        await routed.modelRuntime.complete(registerAdditionalTextModel(routed, 'reviewer-routed'), {
            messages: [{ role: 'user', content: 'review', timestamp: Date.now() }],
        });

        expect(provider.requests.map((request) => request.provider)).toEqual([
            routing,
            routing,
            routing,
        ]);

        const unrouted = await createPiRuntime(testConfig(provider.baseUrl));
        await unrouted.modelRuntime.complete(unrouted.reasoningModel, {
            messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
        });

        expect(provider.requests.at(-1)!.provider).toBeNull();
    });

    it('registers an additional text model for per-deployment reviewer overrides', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [{ kind: ScriptedReplyKind.Text, text: '{"verdict":"x","count":1}' }],
        });
        const runtime = await createPiRuntime(testConfig(provider.baseUrl));
        const handle = registerAdditionalTextModel(runtime, 'reviewer-special');

        const message = await runtime.modelRuntime.complete(handle, {
            messages: [{ role: 'user', content: 'review', timestamp: Date.now() }],
        });

        expect(message.stopReason).toBe('stop');
        expect(provider.requests.at(-1)!.model).toBe('reviewer-special');
        // Idempotent: an already-registered id returns the existing handle.
        expect(registerAdditionalTextModel(runtime, 'reviewer-special').id).toBe(
            'reviewer-special',
        );
    });
});
