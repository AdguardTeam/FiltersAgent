import { describe, expect, it } from 'vitest';
import { extractReport } from '../../src/intake/extract-report';
import { PROVIDER_REJECTION_PREFIX } from '../../src/pi/single-shot';
import { SingleShotResultKind, type SingleShotClient } from '../../src/pi/single-shot-types';
import { TurnStopReason } from '../../src/pi/stop-reason';

describe('extractReport provider failures', () => {
    it('identifies a rejected intake request and preserves its stop reason', async () => {
        const failure = {
            kind: SingleShotResultKind.ProviderFailure,
            stopReason: TurnStopReason.Error,
            message: '400 Unsupported temperature',
            usages: [],
            model: 'example-reasoning-model',
        };
        const client: SingleShotClient = {
            modelId: failure.model,
            structured: async () => failure,
            text: async () => failure,
        };
        const extraction = extractReport(
            {
                number: 42,
                url: 'https://github.com/example-owner/example-repo/issues/42',
                title: 'Ads on example.com',
                body: 'https://example.com',
                state: 'open',
                labels: [],
                assignee: null,
                comments: [],
            },
            { client },
        );

        await expect(extraction).rejects.toThrow(PROVIDER_REJECTION_PREFIX);
        await expect(extraction).rejects.toThrow(TurnStopReason.Error);
        await expect(extraction).rejects.toThrow('400 Unsupported temperature');
    });
});
