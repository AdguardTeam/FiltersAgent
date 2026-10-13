import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../src/logger/logger';
import * as v from 'valibot';
import { registerAdditionalTextModel } from '../../src/pi/runtime';
import { createSingleShotClient } from '../../src/pi/single-shot';
import { meterSingleShotClient } from '../../src/pi/usage-collector';
import { createRunUsageCollector } from '../../src/pi/usage-collector';
import { SingleShotResultKind } from '../../src/pi/single-shot-types';
import { UsageCompleteness } from '../../src/types/usage-status';
import {
    HermeticScenario,
    type HermeticProvider,
    ScriptedReplyKind,
    startHermeticProvider,
} from './hermetic-provider';
import { VISION_MODEL, createTestPiRuntime } from './test-runtime';

const REVIEWER_MODEL = 'reviewer-special';

const VerdictSchema = v.object({ verdict: v.string() });

let provider: HermeticProvider | undefined;

afterEach(async () => {
    if (!provider) {
        return;
    }
    await provider.close();
    provider = undefined;
});

describe('meterSingleShotClient', () => {
    it('prices every attempt of a repaired structured call at the bound model', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                { kind: ScriptedReplyKind.Text, text: 'not json' },
                { kind: ScriptedReplyKind.Text, text: '{"verdict":"ok"}' },
            ],
        });
        const runtime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
        const collector = createRunUsageCollector({
            rates: {
                [VISION_MODEL]: { inputUsdPerMillionTokens: 1.5, outputUsdPerMillionTokens: 9 },
            },
        });
        const client = meterSingleShotClient(
            createSingleShotClient(runtime, runtime.visionModel),
            collector,
        );

        const result = await client.structured({
            messages: [{ role: 'user', text: 'inspect' }],
            schema: VerdictSchema,
        });

        expect(result.kind).toBe('parsed');
        const summary = collector.summary();
        expect(summary.bySource.singleShot).toMatchObject({ requests: 1, completions: 2 });
        expect(summary.repairAttempts).toBe(1);
        // 2 replies × (11·1.5 + 5·9)/1e6.
        expect(summary.costUsd).toBe(0.000123);
        expect(summary.usageCompleteness).toBe('complete');
    });

    it('attributes a text completion to the model its client is bound to', async () => {
        // The reviewer model is registered at run time on top of the two configured ones, and the
        // run's price table is keyed by the id the call actually went to — not by whichever model
        // the run's other clients happen to be bound to.
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [{ kind: ScriptedReplyKind.Text, text: 'a rendered ad banner' }],
        });
        const runtime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
        const reviewerModel = registerAdditionalTextModel(runtime, REVIEWER_MODEL);
        const collector = createRunUsageCollector({
            rates: {
                [REVIEWER_MODEL]: { inputUsdPerMillionTokens: 0.5, outputUsdPerMillionTokens: 1 },
            },
        });
        const client = meterSingleShotClient(
            createSingleShotClient(runtime, reviewerModel),
            collector,
        );

        const result = await client.text({ messages: [{ role: 'user', text: 'describe' }] });

        expect(result.kind).toBe(SingleShotResultKind.Parsed);
        const summary = collector.summary();
        expect(summary.byModel.map((entry) => entry.model)).toEqual([REVIEWER_MODEL]);
        expect(summary.byModel[0]!.costUsd).toBe((11 * 0.5 + 5 * 1) / 1_000_000);
        expect(summary.costUsd).toBe((11 * 0.5 + 5 * 1) / 1_000_000);
        expect(summary.bySource.singleShot.completions).toBe(1);
    });

    it('records a failed structured call as an attempted, unreported completion', async () => {
        // A provider call that failed is still a provider call. Dropping it let a run whose last
        // call failed report COMPLETE usage on the strength of the calls that succeeded.
        provider = await startHermeticProvider({ scenario: HermeticScenario.AuthError });
        const runtime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
        const collector = createRunUsageCollector({ rates: {} });
        const client = meterSingleShotClient(
            createSingleShotClient(runtime, runtime.visionModel),
            collector,
        );

        const result = await client.structured({
            messages: [{ role: 'user', text: 'inspect' }],
            schema: VerdictSchema,
        });

        expect(result.kind).toBe(SingleShotResultKind.ProviderFailure);
        const summary = collector.summary();
        expect(summary.requests).toBe(1);
        expect(summary.completions).toBe(1);
        expect(summary.unreportedCompletions).toBe(1);
        expect(summary.usageCompleteness).toBe(UsageCompleteness.Unreported);
        expect(summary.bySource.singleShot).toMatchObject({ requests: 1, completions: 1 });
    });

    it('keeps a run with one good call and one failed call out of complete usage', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                { kind: ScriptedReplyKind.Text, text: '{"verdict":"ok"}' },
                // 401 is auth-shaped, so pi fails fast instead of retrying into the next reply.
                { kind: ScriptedReplyKind.Error, status: 401, message: 'invalid api key' },
            ],
        });
        const runtime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
        const collector = createRunUsageCollector({ rates: {} });
        const client = meterSingleShotClient(
            createSingleShotClient(runtime, runtime.visionModel),
            collector,
        );

        await client.structured({
            messages: [{ role: 'user', text: 'inspect' }],
            schema: VerdictSchema,
        });
        const failed = await client.text({ messages: [{ role: 'user', text: 'describe' }] });

        expect(failed.kind).toBe(SingleShotResultKind.ProviderFailure);
        const summary = collector.summary();
        expect(summary.usageCompleteness).toBe(UsageCompleteness.Partial);
        expect(summary.unreportedCompletions).toBeGreaterThanOrEqual(1);
    });

    it('never lets a rejected usage report reach the observed call, and logs it', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [{ kind: ScriptedReplyKind.Text, text: '{"verdict":"ok"}' }],
        });
        const runtime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
        const delivered: { reported: boolean }[][] = [];
        const collector = {
            addSingleShot: (report: { completions: { reported: boolean }[] }) => {
                delivered.push(report.completions);
                throw new Error('usage observation exploded');
            },
        } as unknown as ReturnType<typeof createRunUsageCollector>;
        const errors: unknown[][] = [];
        const logger = {
            info: () => undefined,
            warn: () => undefined,
            error: (...args: unknown[]) => {
                errors.push(args);
            },
        } as unknown as Logger;
        const client = meterSingleShotClient(
            createSingleShotClient(runtime, runtime.visionModel),
            collector,
            { logger },
        );

        const result = await client.structured({
            messages: [{ role: 'user', text: 'inspect' }],
            schema: VerdictSchema,
        });

        // The observed call is untouched...
        expect(result.kind).toBe('parsed');
        if (result.kind !== 'parsed') {
            return;
        }
        expect(result.value).toEqual({ verdict: 'ok' });
        // ...and the lost segment is not silent. It is offered exactly once: every sink this
        // decorator is given is a push into the run's collector, so a second, degraded delivery
        // would fail identically.
        expect(delivered).toHaveLength(1);
        expect(errors).toHaveLength(1);
        const [payload] = errors[0]! as [Record<string, unknown>, string];
        expect(payload).toMatchObject({ observer: 'singleShotUsage' });
        expect((payload.err as Error).message).toBe('usage observation exploded');
    });
});
