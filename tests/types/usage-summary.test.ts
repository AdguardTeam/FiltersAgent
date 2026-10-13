import { describe, expect, it } from 'vitest';
import { createRunUsageCollector } from '../../src/pi/usage-collector';
import {
    USAGE_SUMMARY_VERSION_VALUES,
    UsageSummaryVersion,
    readPersistedUsageSummary,
    readRunUsageSummary,
} from '../../src/types/usage-summary';
import { UnsupportedArtifactVersionError } from '../../src/types/versioned-document';

/**
 * A usage summary as the pre-migration build persisted one: the retired version tag over
 * attempt-shaped, cache-inclusive counters that nothing reads any more.
 */
const LEDGER_ERA_USAGE_SUMMARY = {
    schemaVersion: UsageSummaryVersion.Ledger,
    requests: 2,
    attempts: 3,
    inputTokens: 1500,
    cachedInputTokens: 200,
    outputTokens: 300,
    totalTokens: 1800,
    estimatedCostUsd: 0.0123,
};

describe('readPersistedUsageSummary', () => {
    it('reads each persisted usage-summary shape under its own version', () => {
        const ledger = readPersistedUsageSummary(LEDGER_ERA_USAGE_SUMMARY);
        const run = readPersistedUsageSummary(
            JSON.parse(JSON.stringify(createRunUsageCollector({}).summary())),
        );

        // A pre-migration summary is recognized, not interpreted: nothing left reads its retired
        // counters, so the reader answers with the era and stops there.
        expect(ledger).toEqual({ version: UsageSummaryVersion.Ledger });
        expect(run).toMatchObject({
            version: UsageSummaryVersion.Run,
            run: { bySource: { loop: { completions: 0 } } },
        });
    });

    it('refuses a version it cannot interpret, by number, instead of guessing a shape', () => {
        const newerVersion = Math.max(...USAGE_SUMMARY_VERSION_VALUES) + 1;

        expect(() =>
            readPersistedUsageSummary({ schemaVersion: newerVersion, requests: 1 }),
        ).toThrow(UnsupportedArtifactVersionError);
        expect(() =>
            readPersistedUsageSummary({ schemaVersion: newerVersion, requests: 1 }),
        ).toThrow(new RegExp(String(newerVersion), 'u'));
        expect(() => readPersistedUsageSummary({ requests: 1 })).toThrow(
            UnsupportedArtifactVersionError,
        );
    });

    it('refuses to hand a pi-shaped consumer the retired ledger aggregate', () => {
        const summary = createRunUsageCollector({}).summary();

        expect(() => readRunUsageSummary(LEDGER_ERA_USAGE_SUMMARY)).toThrow(
            UnsupportedArtifactVersionError,
        );
        expect(() => readRunUsageSummary(LEDGER_ERA_USAGE_SUMMARY)).toThrow(
            new RegExp(`schemaVersion ${UsageSummaryVersion.Ledger}\\b`, 'u'),
        );
        expect(readRunUsageSummary(JSON.parse(JSON.stringify(summary)))).toEqual(summary);
    });
});
