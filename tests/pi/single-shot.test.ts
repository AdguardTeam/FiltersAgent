import { afterEach, describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { ReasoningEffort } from '../../src/config/reasoning-effort';
import { createSingleShotClient } from '../../src/pi/single-shot';
import { SingleShotResultKind } from '../../src/pi/single-shot-types';
import { MAX_VISION_IMAGE_BYTES } from '../../src/pi/single-shot-input';
import type { Logger } from '../../src/logger/logger';
import {
    HermeticScenario,
    type HermeticProvider,
    ScriptedReplyKind,
    startHermeticProvider,
} from './hermetic-provider';
import {
    REASONING_MODEL,
    TEST_MAX_OUTPUT_TOKENS,
    TEST_VISION_MAX_OUTPUT_TOKENS,
    VISION_MODEL,
    createTestPiRuntime,
    createTestSingleShotClients,
    createTestVisionClient,
} from './test-runtime';

const VerdictSchema = v.object({ verdict: v.string(), count: v.number() });

/**
 * 1x1 transparent PNG, the smallest valid image part for wire assertions.
 */
const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Inactivity bound the stall suites configure as `timeoutMs`. Small enough to keep the suite fast,
 * far above any hermetic gap that is not a deliberate stall.
 */
const STALL_DEADLINE_MS = 300;

/**
 * Gap between the paced deltas of the live-stream suite: comfortably inside `STALL_DEADLINE_MS`, so
 * no single gap can trip the bound.
 */
const SLOW_STREAM_INTERVAL_MS = 100;

/**
 * Paced deltas of the live-stream suite. `SLOW_STREAM_DELTAS * SLOW_STREAM_INTERVAL_MS` puts the
 * response's total length several times past `STALL_DEADLINE_MS`, which a bound measuring total
 * length would kill.
 */
const SLOW_STREAM_DELTAS = 10;

/**
 * Generous upper wall time for a suite whose point is that the call ends on its own bound rather
 * than on vitest's timeout. Nothing is asserted about the exact timing.
 */
const BOUNDED_BY_DEADLINE_MS = 10_000;

let provider: HermeticProvider | undefined;

afterEach(async () => {
    if (!provider) {
        return;
    }
    await provider.close();
    provider = undefined;
});

describe('runStructuredSingleShot', () => {
    it('parses a valid reply into the typed result with per-attempt usage', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [{ kind: ScriptedReplyKind.Text, text: '{"verdict":"present","count":2}' }],
        });
        const client = await createTestVisionClient(provider.baseUrl);

        const result = await client.structured({
            messages: [
                { role: 'system', text: 'Inventory the defect.' },
                {
                    role: 'user',
                    text: 'IMAGE 1: artifact=a1',
                    images: [{ bytes: Buffer.from(PNG_1PX, 'base64') }],
                },
            ],
            schema: VerdictSchema,
        });

        expect(result.kind).toBe(SingleShotResultKind.Parsed);
        if (result.kind !== SingleShotResultKind.Parsed) {
            return;
        }
        expect(result.value).toEqual({ verdict: 'present', count: 2 });
        expect(result.attempts).toBe(1);
        expect(result.usages).toHaveLength(1);
        expect(result.usages[0]!.reported).toBe(true);
        expect(result.usages[0]!.input).toBeGreaterThan(0);
        expect(result.model).toBe(VISION_MODEL);
        const request = provider.requests[0]!;
        expect(request.model).toBe(VISION_MODEL);
        expect(request.temperature).toBe(0);
        expect(JSON.stringify(request.messages[0])).toContain('Inventory the defect.');
        const userParts = JSON.stringify(request.messages.at(-1));
        expect(userParts).toContain('image_url');
        expect(userParts).toContain('data:image/png;base64,');
        const systemWire = JSON.stringify(request.messages.find((m) => m.role === 'system'));
        expect(systemWire).toContain('Return only one valid JSON object');
    });

    it('runs exactly one repair after a malformed reply, then parses', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                { kind: ScriptedReplyKind.Text, text: 'not json at all' },
                {
                    kind: ScriptedReplyKind.Text,
                    text: '```json\n{"verdict":"absent","count":0}\n```',
                },
            ],
        });
        const client = await createTestVisionClient(provider.baseUrl);

        const result = await client.structured({
            messages: [{ role: 'user', text: 'inspect' }],
            schema: VerdictSchema,
        });

        expect(result.kind).toBe(SingleShotResultKind.Parsed);
        expect(provider.requests).toHaveLength(2);
        const repair = provider.requests[1]!;
        const roles = repair.messages.map((m) => m.role);
        expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
        expect(String(repair.messages[2]!.content)).toContain('not json at all');
        expect(String(repair.messages[3]!.content)).toContain(
            'The previous JSON did not match the required schema:',
        );
        if (result.kind !== SingleShotResultKind.Parsed) {
            return;
        }
        expect(result.attempts).toBe(2);
        expect(result.usages).toHaveLength(2);
        expect(result.value).toEqual({ verdict: 'absent', count: 0 });
    });

    it('enforces a schema check at parse while advertising the rest of its pipe', async () => {
        // A predicate has no JSON Schema form: the model sees the pipe's other keywords, the parse
        // enforces the predicate, and the repair prompt names it.
        const CheckedSchema = v.object({
            url: v.pipe(
                v.string(),
                v.url(),
                v.check((url) => url.startsWith('https://allowed.example/'), 'must be allowed'),
            ),
        });
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                { kind: ScriptedReplyKind.Text, text: '{"url":"https://other.example/"}' },
                { kind: ScriptedReplyKind.Text, text: '{"url":"https://allowed.example/a"}' },
            ],
        });
        const client = await createTestVisionClient(provider.baseUrl);

        const result = await client.structured({
            messages: [{ role: 'user', text: 'inspect' }],
            schema: CheckedSchema,
        });

        expect(result).toMatchObject({
            kind: SingleShotResultKind.Parsed,
            value: { url: 'https://allowed.example/a' },
            attempts: 2,
        });
        const advertised = JSON.stringify(
            provider.requests[0]!.messages.find((m) => m.role === 'system'),
        );
        expect(advertised).toContain('uri');
        expect(String(provider.requests[1]!.messages.at(-1)!.content)).toContain(
            'url: must be allowed',
        );
    });

    it('returns a typed invalid-result after persistent malformation, never throwing', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                { kind: ScriptedReplyKind.Text, text: '{"wrong":' },
                { kind: ScriptedReplyKind.Text, text: '{"still":"wrong"}' },
            ],
        });
        const client = await createTestVisionClient(provider.baseUrl);

        const result = await client.structured({
            messages: [{ role: 'user', text: 'inspect' }],
            schema: VerdictSchema,
        });

        expect(result.kind).toBe(SingleShotResultKind.InvalidResult);
        expect(provider.requests).toHaveLength(2);
        if (result.kind !== SingleShotResultKind.InvalidResult) {
            return;
        }
        expect(result.attempts).toBe(2);
        expect(result.detail.length).toBeGreaterThan(0);
    });

    it('honors maxAttempts 1 with no repair request', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [{ kind: ScriptedReplyKind.Text, text: 'nope' }],
        });
        const client = await createTestVisionClient(provider.baseUrl);

        const result = await client.structured({
            messages: [{ role: 'user', text: 'inspect' }],
            schema: VerdictSchema,
            maxAttempts: 1,
        });

        expect(result.kind).toBe(SingleShotResultKind.InvalidResult);
        expect(provider.requests).toHaveLength(1);
    });

    it('maps a provider 401 to a typed provider-failure carrying the provider message', async () => {
        provider = await startHermeticProvider({ scenario: HermeticScenario.AuthError });
        const client = await createTestVisionClient(provider.baseUrl);

        const result = await client.structured({
            messages: [{ role: 'user', text: 'inspect' }],
            schema: VerdictSchema,
        });

        expect(result.kind).toBe(SingleShotResultKind.ProviderFailure);
        if (result.kind !== SingleShotResultKind.ProviderFailure) {
            return;
        }
        expect(result.message).toContain('auth failed');
        // The attempt is accounted for: a call the provider refused is still a provider call, and
        // a result that carried no usage at all let the run's usage summary claim completeness.
        expect(result.usages).toHaveLength(1);
        expect(result.usages[0]).toMatchObject({ reported: false, input: 0, output: 0 });
        expect(result.model).toBe(VISION_MODEL);
    });

    it('retries a bodiless gateway 520 inside one attempt and parses the reply', async () => {
        // The single-shot path does NOT share the agent loop's message-based classification: it
        // passes `maxRetries` into pi-ai's transport retry, which decides on the HTTP STATUS and
        // covers the whole 5xx range — so the Cloudflare 520 that strands a loop turn is already
        // retried here, and the seam the loop needed would be redundant. This pins that, because
        // the day it stops being true a vision call starts dying on one edge blip with no other
        // signal than a typed provider-failure.
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                { kind: ScriptedReplyKind.BareStatus, status: 520 },
                { kind: ScriptedReplyKind.Text, text: '{"verdict":"present","count":1}' },
            ],
        });
        const runtime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
        const client = createSingleShotClient(runtime, runtime.visionModel, { maxRetries: 2 });

        const result = await client.structured({
            messages: [{ role: 'user', text: 'inspect' }],
            schema: VerdictSchema,
        });

        expect(result.kind).toBe(SingleShotResultKind.Parsed);
        if (result.kind !== SingleShotResultKind.Parsed) {
            return;
        }
        expect(result.value).toEqual({ verdict: 'present', count: 1 });
        // One logical attempt: the transport retry sits below the repair loop, so it neither spends
        // a repair attempt nor adds a usage entry.
        expect(result.attempts).toBe(1);
        expect(result.usages).toHaveLength(1);
        expect(provider.requests).toHaveLength(2);
    });

    it('accounts for each mid-stream gateway retry and parses the reply', async () => {
        // A fault after the headers is an error MESSAGE, not a status: pi's transport retry never
        // sees it, and a live run's candidate visual review went "unavailable" on one. The loop's
        // seam classification applies here too, bounded by the same configured retries.
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                {
                    kind: ScriptedReplyKind.StreamFault,
                    message:
                        'Upstream error from Together: Stream error: h2 protocol error: ' +
                        'error reading a body from connection',
                    code: 502,
                },
                { kind: ScriptedReplyKind.FinishReason, reason: 'error' },
                { kind: ScriptedReplyKind.Text, text: '{"verdict":"present","count":1}' },
            ],
        });
        const runtime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
        const client = createSingleShotClient(runtime, runtime.visionModel, { maxRetries: 2 });

        const result = await client.structured({
            messages: [{ role: 'user', text: 'inspect' }],
            schema: VerdictSchema,
        });

        expect(result.kind).toBe(SingleShotResultKind.Parsed);
        if (result.kind !== SingleShotResultKind.Parsed) {
            return;
        }
        expect(result.value).toEqual({ verdict: 'present', count: 1 });
        expect(result.attempts).toBe(3);
        expect(result.usages).toHaveLength(3);
        expect(provider.requests).toHaveLength(3);
    });

    it('does not retry a mid-stream gateway fault when no retries are configured', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                {
                    kind: ScriptedReplyKind.StreamFault,
                    message: 'Upstream error from Together: Stream error: h2 protocol error',
                    code: 502,
                },
                { kind: ScriptedReplyKind.Text, text: '{"verdict":"present","count":1}' },
            ],
        });
        const runtime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
        const client = createSingleShotClient(runtime, runtime.visionModel, { maxRetries: 0 });

        const result = await client.structured({
            messages: [{ role: 'user', text: 'inspect' }],
            schema: VerdictSchema,
        });

        expect(result.kind).toBe(SingleShotResultKind.ProviderFailure);
        expect(provider.requests).toHaveLength(1);
    });

    it('maps a caller abort on a hanging provider to a typed provider-failure', async () => {
        provider = await startHermeticProvider({ scenario: HermeticScenario.Hang });
        const client = await createTestVisionClient(provider.baseUrl);
        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), 250);

        try {
            const result = await client.structured({
                messages: [{ role: 'user', text: 'inspect' }],
                schema: VerdictSchema,
                signal: controller.signal,
            });
            expect(result.kind).toBe(SingleShotResultKind.ProviderFailure);
            if (result.kind !== SingleShotResultKind.ProviderFailure) {
                return;
            }
            expect(result.stopReason).toBe('aborted');
        } finally {
            clearTimeout(abortTimer);
        }
    });

    it('ends a stalled stream as a typed provider failure naming the stall', async () => {
        // The half of `timeoutMs` the OpenAI SDK does not cover: it clears its own timer the
        // moment the headers arrive, so a gateway that answered and then went silent left the call
        // unbounded. One live run sat in such a call for 44 minutes and ran 30 minutes
        // past its wall-clock budget, because the run guard cannot end a call that never returns.
        provider = await startHermeticProvider({ scenario: HermeticScenario.StallAfterHeaders });
        const runtime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
        const client = createSingleShotClient(runtime, runtime.visionModel, {
            timeoutMs: STALL_DEADLINE_MS,
        });
        const started = Date.now();

        const result = await client.structured({
            messages: [{ role: 'user', text: 'inspect' }],
            schema: VerdictSchema,
        });

        expect(result.kind).toBe(SingleShotResultKind.ProviderFailure);
        if (result.kind !== SingleShotResultKind.ProviderFailure) {
            return;
        }
        expect(result.stopReason).toBe('aborted');
        // The failure names the stall, so a post-mortem sees why the call ended.
        expect(result.message).toContain(`${STALL_DEADLINE_MS}ms`);
        // Bounded by the deadline, not by the suite's own timeout.
        expect(Date.now() - started).toBeLessThan(BOUNDED_BY_DEADLINE_MS);
    });

    it('parses a live but slow stream whose total length outlives the deadline', async () => {
        // The bound measures SILENCE, not a response's total length: a reasoning-capable vision
        // model streams its thinking for minutes before it answers, and killing that would trade
        // one stalled call for every slow one.
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                {
                    kind: ScriptedReplyKind.Text,
                    text: '{"verdict":"present","count":3}',
                    pacing: { deltas: SLOW_STREAM_DELTAS, intervalMs: SLOW_STREAM_INTERVAL_MS },
                },
            ],
        });
        const runtime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
        const client = createSingleShotClient(runtime, runtime.visionModel, {
            timeoutMs: STALL_DEADLINE_MS,
        });
        const started = Date.now();

        const result = await client.structured({
            messages: [{ role: 'user', text: 'inspect' }],
            schema: VerdictSchema,
        });

        expect(result.kind).toBe(SingleShotResultKind.Parsed);
        if (result.kind !== SingleShotResultKind.Parsed) {
            return;
        }
        expect(result.value).toEqual({ verdict: 'present', count: 3 });
        // One request: the bound never aborted the call, so there is no repair attempt.
        expect(provider.requests).toHaveLength(1);
        // The whole response outlived the deadline several times over, which is the point.
        expect(Date.now() - started).toBeGreaterThan(STALL_DEADLINE_MS);
    });

    it('ends a live stream that outlives its ceiling as a typed provider failure naming it', async () => {
        // The inactivity bound cannot end a generation that never stops: one live run sat
        // 21 and then 24 minutes in two vision calls that streamed the whole time. The ceiling
        // bounds the call's total length, armed once with the request and never re-armed.
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                {
                    kind: ScriptedReplyKind.Text,
                    text: '{"verdict":"present","count":3}',
                    pacing: { deltas: SLOW_STREAM_DELTAS, intervalMs: SLOW_STREAM_INTERVAL_MS },
                },
            ],
        });
        const runtime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
        const client = createSingleShotClient(runtime, runtime.visionModel, {
            timeoutMs: STALL_DEADLINE_MS,
            ceilingMs: STALL_DEADLINE_MS,
        });
        const started = Date.now();

        const result = await client.structured({
            messages: [{ role: 'user', text: 'inspect' }],
            schema: VerdictSchema,
        });

        expect(result.kind).toBe(SingleShotResultKind.ProviderFailure);
        if (result.kind !== SingleShotResultKind.ProviderFailure) {
            return;
        }
        expect(result.stopReason).toBe('aborted');
        expect(result.message).toContain(`${STALL_DEADLINE_MS}ms ceiling`);
        expect(Date.now() - started).toBeLessThan(BOUNDED_BY_DEADLINE_MS);
    });
});

describe('createSingleShotClient', () => {
    it('runs the text path through the bound model and returns content with usage', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [{ kind: ScriptedReplyKind.Text, text: 'a rendered ad banner' }],
        });
        const client = await createTestVisionClient(provider.baseUrl);

        const result = await client.text({
            messages: [
                { role: 'system', text: 'Describe only visible evidence.' },
                {
                    role: 'user',
                    text: 'describe',
                    images: [{ bytes: Buffer.from(PNG_1PX, 'base64') }],
                },
            ],
        });

        // The text path returns the SAME union as the structured one, with the reply as its value.
        expect(result.kind).toBe(SingleShotResultKind.Parsed);
        if (result.kind !== SingleShotResultKind.Parsed) {
            return;
        }
        expect(result.value).toBe('a rendered ad banner');
        expect(result.usages).toHaveLength(1);
        expect(result.usages[0]!.input).toBeGreaterThan(0);
        expect(result.usages[0]!.model).toBe(VISION_MODEL);
        expect(provider.requests[0]!.model).toBe(VISION_MODEL);
    });

    it('falls back to the client-defaults logger on a text-path failure', async () => {
        provider = await startHermeticProvider({ scenario: HermeticScenario.AuthError });
        const runtime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
        const logs: unknown[][] = [];
        const logger = {
            info: () => undefined,
            warn: (...args: unknown[]) => {
                logs.push(args);
            },
        } as unknown as Logger;
        const client = createSingleShotClient(runtime, runtime.visionModel, { logger });

        const result = await client.text({ messages: [{ role: 'user', text: 'describe' }] });

        expect(result.kind).toBe(SingleShotResultKind.ProviderFailure);
        if (result.kind !== SingleShotResultKind.ProviderFailure) {
            return;
        }
        // Same rule on the text path: the failed attempt carries its (unreported) usage and the
        // model it targeted, so the metered client can record it.
        expect(result.usages).toMatchObject([{ reported: false, input: 0, model: VISION_MODEL }]);
        expect(result.model).toBe(VISION_MODEL);
        expect(logs).toHaveLength(1);
        const [payload, message] = logs[0]! as [Record<string, unknown>, string];
        expect(payload).toMatchObject({ kind: SingleShotResultKind.ProviderFailure });
        expect(message).toContain('single-shot LLM call failed');
    });

    it('sends the configured reasoning effort of the role each client is bound to', async () => {
        // One runtime, one configured level, two clients: the model is the only variable. Both
        // halves matter — without the first the setting would be silently confined to loop
        // sessions, and without the second a vision request would carry a parameter the gateway
        // has no reasoning model to apply it to. The completion cap is asserted per role for the
        // same reason: pi's typed `complete` sends only what the call passes, so the client puts
        // its role's configured cap on the wire itself — without it a single-shot request carried
        // no cap and the provider's own default cut a live vision verdict at `length`.
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                { kind: ScriptedReplyKind.Text, text: '{"verdict":"x","count":1}' },
                { kind: ScriptedReplyKind.Text, text: '{"verdict":"y","count":2}' },
            ],
        });
        const clients = await createTestSingleShotClients(provider.baseUrl, ReasoningEffort.Low);

        await clients.reasoning.structured({
            messages: [{ role: 'user', text: 'inspect' }],
            schema: VerdictSchema,
        });
        await clients.vision.structured({
            messages: [{ role: 'user', text: 'inspect' }],
            schema: VerdictSchema,
        });

        expect(provider.requests[0]!.model).toBe(REASONING_MODEL);
        expect(provider.requests[0]!.reasoningEffort).toBe(ReasoningEffort.Low);
        expect(provider.requests[0]!.maxCompletionTokens).toBe(TEST_MAX_OUTPUT_TOKENS);
        expect(provider.requests[1]!.model).toBe(VISION_MODEL);
        expect(provider.requests[1]!.reasoningEffort).toBeNull();
        expect(provider.requests[1]!.maxCompletionTokens).toBe(TEST_VISION_MAX_OUTPUT_TOKENS);
    });

    it('sends no reasoning parameter when the configured effort is off', async () => {
        // `off` is the pre-migration wire shape a like-for-like benchmark needs, and the only way
        // to reach it is by omitting the field entirely — the provider request option has no `off`
        // member. Asserted on the reasoning model, the one place a level would otherwise appear.
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [{ kind: ScriptedReplyKind.Text, text: '{"verdict":"x","count":1}' }],
        });
        const clients = await createTestSingleShotClients(provider.baseUrl, ReasoningEffort.Off);

        await clients.reasoning.structured({
            messages: [{ role: 'user', text: 'inspect' }],
            schema: VerdictSchema,
        });

        expect(provider.requests[0]!.model).toBe(REASONING_MODEL);
        expect(provider.requests[0]!.reasoningEffort).toBeNull();
    });

    it('refuses an image beyond the vision byte cap before any request', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [{ kind: ScriptedReplyKind.Text, text: '{"verdict":"x","count":1}' }],
        });
        const client = await createTestVisionClient(provider.baseUrl);

        await expect(
            client.structured({
                messages: [
                    {
                        role: 'user',
                        images: [{ bytes: new Uint8Array(MAX_VISION_IMAGE_BYTES + 1) }],
                    },
                ],
                schema: VerdictSchema,
            }),
        ).rejects.toThrow(/byte cap/);
        expect(provider.requests).toHaveLength(0);
    });
});
