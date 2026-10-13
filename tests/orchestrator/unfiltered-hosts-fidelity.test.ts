import { describe, expect, it, vi } from 'vitest';
import {
    AppliedRulesReadKind,
    recordingUnfilteredHosts,
    type AppliedRulesLog,
    type AppliedRulesReport,
} from '../../src/environment/applied-rules';
import type { Logger } from '../../src/logger/logger';
import { recordUnfilteredHostsFidelity } from '../../src/orchestrator/filter-fidelity-records';
import {
    cliDecision,
    host,
    readyExecutorPreparation,
} from '../environment/environment-selection-fixtures';

/**
 * A log that answers one report naming the given unfiltered hosts.
 *
 * @param unfilteredHosts - The hosts the report names.
 * @returns The log.
 */
function logReporting(unfilteredHosts: AppliedRulesReport['unfilteredHosts']): AppliedRulesLog {
    return {
        read: async () => ({
            kind: AppliedRulesReadKind.Report,
            report: {
                engine: 'AdGuard CLI',
                covers: 'everything',
                events: [],
                lists: [],
                trackingProtection: [],
                notReported: [],
                unfilteredHosts,
            },
        }),
    };
}

describe('unfiltered hosts in the report', () => {
    it('records the hosts a read names as a content-not-filtered limitation', async () => {
        // A learning.ua report: the CLI tunnelled the site, and the report showed the cosmetic
        // candidate as applied and not working.
        const environmentHost = host();
        environmentHost.select(cliDecision);
        environmentHost.attachExecutorPreparation(readyExecutorPreparation());
        const log = recordingUnfilteredHosts(
            logReporting([
                { host: 'learning.ua', reason: "server doesn't have valid certificate" },
            ]),
            (hosts) =>
                recordUnfilteredHostsFidelity(environmentHost, hosts, {
                    warn: vi.fn(),
                } as unknown as Logger),
        )!;

        await log.read('https://learning.ua/tutors');

        expect(environmentHost.snapshot()?.fidelityLimitations).toContainEqual({
            code: 'content_not_filtered',
            detail: expect.stringContaining("learning.ua (server doesn't have valid certificate)"),
        });
    });

    it('records nothing when the engine read every host', async () => {
        const environmentHost = host();
        environmentHost.select(cliDecision);
        environmentHost.attachExecutorPreparation(readyExecutorPreparation());
        const log = recordingUnfilteredHosts(logReporting([]), (hosts) =>
            recordUnfilteredHostsFidelity(environmentHost, hosts, {
                warn: vi.fn(),
            } as unknown as Logger),
        )!;

        await log.read('https://example.test/');

        expect(
            environmentHost
                .snapshot()
                ?.fidelityLimitations.some((limit) => limit.code === 'content_not_filtered'),
        ).toBe(false);
    });
});
