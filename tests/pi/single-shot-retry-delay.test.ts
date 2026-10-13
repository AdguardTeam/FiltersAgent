import { afterEach, describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { createSingleShotClient } from '../../src/pi/single-shot';
import { SingleShotResultKind } from '../../src/pi/single-shot-types';
import {
    HermeticScenario,
    type HermeticProvider,
    ScriptedReplyKind,
    startHermeticProvider,
} from './hermetic-provider';
import { createTestPiRuntime } from './test-runtime';

const VerdictSchema = v.object({ verdict: v.string(), count: v.number() });

/**
 * The pause the live gateway asked for with its 524: above pi's own 60-second cap, so pi refuses
 * the request at once and only the single-shot layer can wait it out.
 */
const GATEWAY_RETRY_AFTER_SECONDS = 120;

let provider: HermeticProvider | undefined;

afterEach(async () => {
    vi.useRealTimers();
    await provider?.close();
    provider = undefined;
});

describe('provider-requested retry delay', () => {
    it('waits out a pause above pi’s cap and retries the call', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                {
                    kind: ScriptedReplyKind.BareStatus,
                    status: 524,
                    retryAfterSeconds: GATEWAY_RETRY_AFTER_SECONDS,
                },
                { kind: ScriptedReplyKind.Text, text: '{"verdict":"present","count":1}' },
            ],
        });
        const runtime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
        const client = createSingleShotClient(runtime, runtime.visionModel, { maxRetries: 2 });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        const pending = client.structured({
            messages: [{ role: 'user', text: 'inspect' }],
            schema: VerdictSchema,
        });
        await vi.waitFor(() => expect(provider?.requests).toHaveLength(1));
        // Short of the requested pause nothing is sent again.
        await vi.advanceTimersByTimeAsync(GATEWAY_RETRY_AFTER_SECONDS * 1_000 - 1_000);
        expect(provider.requests).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1_000);
        vi.useRealTimers();
        const result = await pending;

        expect(result.kind).toBe(SingleShotResultKind.Parsed);
        expect(provider.requests).toHaveLength(2);
    });

    it('fails the call when the provider asks for a pause longer than the run waits', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                { kind: ScriptedReplyKind.BareStatus, status: 524, retryAfterSeconds: 3_600 },
                { kind: ScriptedReplyKind.Text, text: '{"verdict":"present","count":1}' },
            ],
        });
        const runtime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
        const client = createSingleShotClient(runtime, runtime.visionModel, { maxRetries: 2 });

        const result = await client.structured({
            messages: [{ role: 'user', text: 'inspect' }],
            schema: VerdictSchema,
        });

        expect(result.kind).toBe(SingleShotResultKind.ProviderFailure);
        expect(provider.requests).toHaveLength(1);
    });
});
