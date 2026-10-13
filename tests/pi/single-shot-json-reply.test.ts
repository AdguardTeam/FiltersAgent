import { afterEach, describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { createSingleShotClient } from '../../src/pi/single-shot';
import { SingleShotResultKind } from '../../src/pi/single-shot-types';
import type { Logger } from '../../src/logger/logger';
import {
    HermeticScenario,
    type HermeticProvider,
    ScriptedReplyKind,
    startHermeticProvider,
} from './hermetic-provider';
import { createTestPiRuntime, createTestVisionClient } from './test-runtime';

const VerdictSchema = v.object({ verdict: v.string(), count: v.number() });

let provider: HermeticProvider | undefined;

afterEach(async () => {
    await provider?.close();
    provider = undefined;
});

/**
 * Run one structured call whose first reply is the given text.
 *
 * @param text - The model reply the provider serves.
 * @returns The call's result and the number of requests the provider saw.
 */
async function structuredReply(text: string) {
    provider = await startHermeticProvider({
        scenario: HermeticScenario.Scripted,
        script: [{ kind: ScriptedReplyKind.Text, text }],
    });
    const client = await createTestVisionClient(provider.baseUrl);
    const result = await client.structured({
        messages: [{ role: 'user', text: 'inspect' }],
        schema: VerdictSchema,
    });
    return { result, requests: provider.requests.length };
}

describe('structured reply parsing', () => {
    it('takes the first object when the reply carries text with braces after it', async () => {
        const { result, requests } = await structuredReply(
            '{"verdict":"present","count":1}\n\nAlternative: {"verdict":"absent","count":0}',
        );

        expect(result).toMatchObject({
            kind: SingleShotResultKind.Parsed,
            value: { verdict: 'present', count: 1 },
        });
        expect(requests).toBe(1);
    });

    it('keeps braces and escaped quotes inside string values', async () => {
        const { result } = await structuredReply(
            'Here it is: {"verdict":"a } and \\" {","count":2} done }',
        );

        expect(result).toMatchObject({
            kind: SingleShotResultKind.Parsed,
            value: { verdict: 'a } and " {', count: 2 },
        });
    });

    it('logs the rejected reply so a failed call can be diagnosed from the run', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [{ kind: ScriptedReplyKind.Text, text: '{"wrong":"shape"} trailing' }],
        });
        const runtime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
        const warnings: unknown[] = [];
        const logger = {
            info: () => undefined,
            warn: (payload: unknown) => {
                warnings.push(payload);
            },
        } as unknown as Logger;
        const client = createSingleShotClient(runtime, runtime.visionModel, { logger });

        const result = await client.structured({
            messages: [{ role: 'user', text: 'inspect' }],
            schema: VerdictSchema,
            maxAttempts: 1,
        });

        expect(result.kind).toBe(SingleShotResultKind.InvalidResult);
        expect(warnings).toContainEqual(
            expect.objectContaining({ reply: '{"wrong":"shape"} trailing' }),
        );
    });
});
