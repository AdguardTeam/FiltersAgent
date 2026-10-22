import * as v from 'valibot';
import {
    PreparedExtensionSource,
    ExtensionManifestVersion,
} from '../../../src/environment/extension-preparation';
import { PreparedExtensionProvenanceSchema } from '../../../src/environment/environment-proofs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RawIssue } from '../../../src/github/fetch-issue';
import { loadLocalIssueSnapshot, toAgentIssueInput } from '../../../src/local/issue-snapshot';
import type { LocalRunRecord } from '../../../src/local/run-output';
import {
    assessGoldenAgentEnvironment,
    GoldenAgentEnvironmentStatus,
} from '../../../lab/e2e/golden-agent-environment';

const REPORT_URL =
    'https://reports.adguard.com/settings/import.html?' +
    'scheme_version=4&product_type=ext&product_version=5.4.3.99&' +
    'ext.manifest_version=3&regular_filters=2%2C216&stealth.enabled=0';

const CASES_ROOT = join(process.cwd(), 'lab', 'benchmark', 'e2e', 'cases');

/**
 * Build a prompt-safe issue whose body is an AdGuard report.
 *
 * @param body - Issue body.
 * @returns The issue the agent and the assessment read.
 */
function issueWith(body: string): RawIssue {
    return {
        number: 235988,
        url: 'https://github.com/AdguardTeam/AdguardFilters/issues/235988',
        title: 'nettg.pl',
        body,
        state: 'closed',
        labels: [],
        assignee: null,
        comments: [],
    };
}

/**
 * Write a report the way GitHub renders the AdGuard form, separators escaped.
 *
 * @param importUrl - Settings import link of the report.
 * @returns The issue carrying the link under the form's heading.
 */
function reportIssue(importUrl: string): RawIssue {
    return issueWith(`### Issue configuration\n[Import](${importUrl.replaceAll('&', '&amp;')})`);
}

/**
 * Read one tracked case's issue exactly as the run receives it.
 *
 * @param caseName - Tracked case directory.
 * @returns Prompt-safe issue of the case.
 */
function trackedIssue(caseName: string): RawIssue {
    return toAgentIssueInput(
        loadLocalIssueSnapshot(join(CASES_ROOT, caseName, 'issue', 'issue.json')),
    );
}

/**
 * Build a locked result with exact session-bound extension and settings evidence.
 *
 * @returns Comparable local run record.
 */
function lockedRecord(): LocalRunRecord {
    const extension = v.parse(PreparedExtensionProvenanceSchema, {
        source: PreparedExtensionSource.HistoricalBuild,
        extensionPath: '/tmp/cache/extensions/historical/build',
        manifestVersion: ExtensionManifestVersion.Mv3,
        extensionSourceSha256: 'e'.repeat(64),
        historicalBuild: {
            version: '5.4.3.99',
            releaseTag: 'v5.4.3.1',
            releaseSha256: 'a'.repeat(64),
            autobuildTag: 'autobuild-v5.4.3.99',
            autobuildCommit: 'b'.repeat(40),
        },
    });
    return {
        result: {
            issueNumber: 235988,
            domain: 'nettg.pl',
            runStatus: 'analysis_only',
            requestedBrowserMode: 'on',
            effectiveMode: 'browser',
            verificationStatus: 'partial',
            reproductionSettingsStatus: 'applied',
            symptomObservation: 'reproduced',
            fallbackReason: null,
            fallbackDetail: null,
            extensionProvenance: extension,
            settingsEvidence: {
                profileKind: 'report_exact',
                enabledListKeys: ['adguard:2', 'adguard:216'],
                activeRulesetListKeys: ['adguard:2', 'adguard:216'],
                stealthEnabled: false,
                limitsExceeded: false,
            },
            candidatePatch: null,
            artifactPaths: {
                screenshots: [],
                domSnapshot: null,
                har: null,
                trace: null,
            },
            reasoning: 'Locked.',
            repository: 'AdguardTeam/AdguardFilters',
            baseSha: '0e06526e359cfb83f2883f7005aeee3feb56b653',
        },
        provenance: {
            environment: 'historical',
            headless: true,
            extension,
            settingsProfiles: [],
        },
        evidence: {
            summary: 'Locked.',
            userScreenshots: [],
            unfilteredScreenshots: [],
            profileScreenshots: [],
            beforeScreenshots: [],
            afterScreenshots: [],
            beforeFullPageScreenshots: [],
            afterFullPageScreenshots: [],
            rejectedScreenshots: [],
            rejectedPairs: [],
        },
        artifacts: [],
    };
}

/**
 * Retarget a locked record to one tracked case's reporter filter selection.
 *
 * @param filterIds - Exact reporter filter IDs.
 * @returns Updated locked record.
 */
function trackedCaseRecord(filterIds: number[]): LocalRunRecord {
    const record = lockedRecord();
    const listKeys = filterIds.map((filterId) => `adguard:${filterId}`);
    record.result.settingsEvidence!.enabledListKeys = [...listKeys];
    record.result.settingsEvidence!.activeRulesetListKeys = [...listKeys];
    return record;
}

// The filter selections each tracked case's report carries in its settings import link.
const TRACKED_CASE_SETTINGS = {
    'nettg-pl-235988': {
        filterIds: [2, 3, 4, 17, 18, 19, 20, 21, 22, 208, 216, 217, 238, 255, 256, 257, 259],
    },
    'wpoznaniu-pl-235403': {
        filterIds: [2, 3, 4, 17, 18, 19, 20, 21, 22, 208, 216, 217, 238, 255, 256, 257, 259],
    },
    'r10-net-238417': {
        filterIds: [2, 10, 13],
    },
} as const;

describe('assessGoldenAgentEnvironment', () => {
    it('accepts exact reporter extension, filter IDs, active rulesets, and stealth evidence', () => {
        expect(assessGoldenAgentEnvironment(lockedRecord(), reportIssue(REPORT_URL))).toMatchObject(
            { status: GoldenAgentEnvironmentStatus.Matched },
        );
    });

    it.each(Object.entries(TRACKED_CASE_SETTINGS))(
        'reads the reporter settings of tracked case %s from its report without a model',
        (caseName, tracked) => {
            const record = trackedCaseRecord([...tracked.filterIds]);

            expect(assessGoldenAgentEnvironment(record, trackedIssue(caseName))).toMatchObject({
                status: GoldenAgentEnvironmentStatus.Matched,
            });
        },
    );

    it.each([
        [
            'wrong manifest generation',
            (record: LocalRunRecord) => {
                record.result.extensionProvenance!.manifestVersion = 2;
                record.provenance.extension!.manifestVersion = 2;
            },
            /manifest_version/i,
        ],
        [
            'missing settings',
            (record: LocalRunRecord) => {
                delete record.result.settingsEvidence;
            },
            /settings evidence/i,
        ],
        [
            'wrong filters',
            (record: LocalRunRecord) => {
                record.result.settingsEvidence!.enabledListKeys = ['adguard:2'];
            },
            /enabled filter ids/i,
        ],
        [
            'inactive ruleset',
            (record: LocalRunRecord) => {
                record.result.settingsEvidence!.activeRulesetListKeys = ['adguard:2'];
            },
            /active ruleset filter ids/i,
        ],
        [
            'unobserved ruleset',
            (record: LocalRunRecord) => {
                record.result.settingsEvidence!.activeRulesetListKeys = null;
            },
            /not observed/i,
        ],
        [
            'wrong stealth',
            (record: LocalRunRecord) => {
                record.result.settingsEvidence!.stealthEnabled = true;
            },
            /stealth/i,
        ],
    ] as const)('classifies %s as an agent mismatch', (_name, mutate, detailPattern) => {
        const record = lockedRecord();
        mutate(record);

        const assessment = assessGoldenAgentEnvironment(record, reportIssue(REPORT_URL));

        expect(assessment).toMatchObject({ status: GoldenAgentEnvironmentStatus.AgentMismatch });
        expect(assessment.detail).toMatch(detailPattern);
    });

    it('leaves a run that stopped before it prepared the reporter build uncompared', () => {
        const record = lockedRecord();
        delete record.result.extensionProvenance;
        record.provenance.extension = null;

        expect(assessGoldenAgentEnvironment(record, reportIssue(REPORT_URL))).toMatchObject({
            status: GoldenAgentEnvironmentStatus.Unavailable,
            detail: expect.stringMatching(/stopped before it prepared the reporter build/i),
        });
    });

    it.each([
        [
            'no import link',
            'AdGuard product: | AdGuard Browser Extension v5.4.3.99 MV3',
            /no exact/i,
        ],
        [
            'an import link on an untrusted host',
            `[Import](${REPORT_URL.replace('reports.adguard.com', 'reports.example.org')})`,
            /no exact/i,
        ],
        [
            // launch_browser applies the link with the same parser, so the agent could not have
            // run in an environment this link describes.
            'an import link the agent would refuse to apply',
            `[Import](${REPORT_URL.replace('stealth.enabled=0', 'stealth.enabled=true')})`,
            /stealth\.enabled/i,
        ],
        [
            'two different import links',
            `[Import](${REPORT_URL})\n[Import](${REPORT_URL.replace('stealth.enabled=0', 'stealth.enabled=1')})`,
            /2 different/i,
        ],
    ])('leaves a report with %s uncompared', (_name, body, detailPattern) => {
        expect(assessGoldenAgentEnvironment(lockedRecord(), issueWith(body))).toMatchObject({
            status: GoldenAgentEnvironmentStatus.Unavailable,
            detail: expect.stringMatching(detailPattern),
        });
    });
});
