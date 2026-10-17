import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Report } from '../../../src/intake/report';
import type { LocalRunRecord } from '../../../src/local/run-output';
import {
    assessGoldenAgentEnvironment,
    extractGoldenReporterEnvironment,
} from '../../../lab/e2e/golden-agent-environment';

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

const REPORT_URL =
    'https://reports.adguard.com/settings/import.html?' +
    'scheme_version=4&product_type=ext&product_version=5.4.3.99&' +
    'ext.manifest_version=3&regular_filters=2%2C216&stealth.enabled=0';

/**
 * Build an extracted scripted report whose settings import carries exact filter IDs.
 *
 * @param importUrl - The import URL the scripted extraction reports.
 * @returns A model-filled report for the extractor seam.
 */
function reportWithImport(importUrl: string): Report {
    return {
        siteUrls: ['https://www.nettg.pl/'],
        problemType: 'ads',
        screenshots: [],
        environment: { product: 'AdGuard Browser Extension v5.4.3.99 MV3' },
        enabledLists: [],
        settingsImportUrl: importUrl,
        userRules: [],
        reproductionSteps: [],
    };
}

/**
 * The extraction seam scripted with the tracked corpus import URLs.
 *
 * @param importUrl - Import URL the seam returns for every issue.
 * @returns The dependencies carrying the scripted seam.
 */
function dependencies(importUrl: string) {
    return {
        readReporterEnvironment: () =>
            extractGoldenReporterEnvironment(writeIssue('Reporter environment'), async () =>
                reportWithImport(importUrl),
            ),
    };
}

/**
 * Persist one portable reporter issue containing exact extension settings.
 *
 * @param body - Issue body used by the snapshot the seam is called with.
 * @returns Absolute snapshot path.
 */
function writeIssue(body: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'golden-agent-environment-'));
    temporaryRoots.push(directory);
    const issueFile = join(directory, 'issue.json');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        issueFile,
        JSON.stringify({
            schemaVersion: 1,
            rawIssue: {
                number: 235988,
                url: 'https://github.com/AdguardTeam/AdguardFilters/issues/235988',
                title: 'nettg.pl',
                body,
                state: 'closed',
                labels: ['T: Ads'],
                assignee: null,
                comments: [],
            },
            reporterComments: [],
            attachments: [],
        }),
        'utf8',
    );
    return issueFile;
}

/**
 * Build a locked result with exact session-bound extension and settings evidence.
 *
 * @returns Comparable local run record.
 */
function lockedRecord(): LocalRunRecord {
    const extension = {
        source: 'historical_build' as const,
        extensionPath: '/tmp/cache/extensions/historical/build',
        manifestVersion: 3 as const,
        extensionSourceSha256: 'e'.repeat(64),
        historicalBuild: {
            version: '5.4.3.99',
            releaseTag: 'v5.4.3.1',
            releaseSha256: 'a'.repeat(64),
            autobuildTag: 'autobuild-v5.4.3.99',
            autobuildCommit: 'b'.repeat(40),
        },
    };
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
 * Retarget a locked record to one tracked case's reporter build and filter selection.
 *
 * @param filterIds - Exact reporter filter IDs.
 * @param version - Reporter extension version.
 * @param commit - Exact autobuild commit for the reporter version.
 * @returns Updated locked record.
 */
function trackedCaseRecord(filterIds: number[], version: string, commit: string): LocalRunRecord {
    const record = lockedRecord();
    Object.assign(record.result.extensionProvenance!.historicalBuild!, {
        version,
        autobuildTag: `autobuild-v${version}`,
        autobuildCommit: commit,
    });
    const listKeys = filterIds.map((filterId) => `adguard:${filterId}`);
    record.result.settingsEvidence!.enabledListKeys = [...listKeys];
    record.result.settingsEvidence!.activeRulesetListKeys = [...listKeys];
    return record;
}

// The import URLs live in the corresponding tracked corpora under lab/benchmark/e2e/cases; the
// seam scripts them because reading them is the intake extraction's job now.
const TRACKED_CASE_IMPORTS = {
    'nettg-pl-235988': {
        version: '5.4.3.99',
        commit: '856783eb784fc5f1cb9bc39e156e94ee1ede210b',
        filterIds: [2, 3, 4, 17, 18, 19, 20, 21, 22, 208, 216, 217, 238, 255, 256, 257, 259],
        importUrl:
            'https://reports.adguard.com/settings/import.html?' +
            'scheme_version=4&product_type=ext&product_version=5.4.3.99&system_version=&' +
            'ext.manifest_version=3&browser=chrome&' +
            'regular_filters=2%2C3%2C4%2C17%2C18%2C19%2C20%2C21%2C22%2C208%2C216%2C217%2C238%2C255%2C256%2C257%2C259&' +
            'filters_last_update=2026-07-16T08%3A00%3A48Z&stealth.enabled=0',
    },
    'wpoznaniu-pl-235403': {
        version: '5.4.3.91',
        commit: 'abc2ca544734957f5d58d8125f53eaef21d4d989',
        filterIds: [2, 3, 4, 17, 18, 19, 20, 21, 22, 208, 216, 217, 238, 255, 256, 257, 259],
        importUrl:
            'https://reports.adguard.com/settings/import.html?' +
            'scheme_version=4&product_type=ext&product_version=5.4.3.91&system_version=&' +
            'ext.manifest_version=3&browser=chrome&' +
            'regular_filters=2%2C3%2C4%2C17%2C18%2C19%2C20%2C21%2C22%2C208%2C216%2C217%2C238%2C255%2C256%2C257%2C259&' +
            'filters_last_update=2026-07-08T08%3A00%3A44Z&stealth.enabled=0',
    },
    'sochi-camera-234715': {
        version: '5.4.3.83',
        commit: 'ac94c3d327ac366f3cd04d78955560bb8e916a78',
        filterIds: [1, 2, 10],
        importUrl:
            'https://reports.adguard.com/settings/import.html?' +
            'scheme_version=4&product_type=ext&product_version=5.4.3.83&' +
            'system_version=Windows+10&ext.manifest_version=3&browser=chrome&' +
            'regular_filters=1%2C2%2C10&stealth.enabled=0',
    },
} as const;

describe('assessGoldenAgentEnvironment', () => {
    it('accepts exact reporter extension, filter IDs, active rulesets, and stealth evidence', async () => {
        expect(
            await assessGoldenAgentEnvironment(lockedRecord(), dependencies(REPORT_URL)),
        ).toMatchObject({
            status: 'matched',
            extension: { manifestVersion: 3 },
        });
    });

    it('reads the reporter settings from an HTML-escaped link the extraction copied verbatim', async () => {
        // GitHub issue bodies carry the import link with `&amp;` separators, and a judge model
        // may return it exactly as written.
        const escapedUrl = REPORT_URL.replaceAll('&', '&amp;');
        const issueFile = writeIssue(`### System configuration\n[Import](${escapedUrl})`);

        expect(
            await assessGoldenAgentEnvironment(lockedRecord(), {
                readReporterEnvironment: () =>
                    extractGoldenReporterEnvironment(issueFile, async () =>
                        reportWithImport(escapedUrl),
                    ),
            }),
        ).toMatchObject({ status: 'matched' });
    });

    it.each(Object.entries(TRACKED_CASE_IMPORTS))(
        'matches exact reporter filter selection recorded for tracked case %s',
        async (_caseName, tracked) => {
            const record = trackedCaseRecord(
                [...tracked.filterIds],
                tracked.version,
                tracked.commit,
            );

            expect(
                await assessGoldenAgentEnvironment(record, dependencies(tracked.importUrl)),
            ).toMatchObject({ status: 'matched' });
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
    ] as const)(
        'classifies %s as an agent mismatch rather than infrastructure',
        async (_name, mutate, detailPattern) => {
            const record = lockedRecord();
            mutate(record);

            const assessment = await assessGoldenAgentEnvironment(record, dependencies(REPORT_URL));

            expect(assessment).toMatchObject({ status: 'agent_mismatch' });
            expect(assessment.detail).toMatch(detailPattern);
        },
    );

    it("treats a build version different from the reporter's as case infrastructure failure", async () => {
        const record = lockedRecord();
        record.result.extensionProvenance!.historicalBuild!.version = '5.4.3.98';

        const assessment = await assessGoldenAgentEnvironment(record, dependencies(REPORT_URL));

        expect(assessment.status).toBe('infrastructure_failure');
        expect(assessment.detail).toContain('5.4.3.98');
        expect(assessment.detail).toContain('5.4.3.99');
    });

    it.each(['missing provenance', 'pinned release', 'missing build identity'])(
        'treats a locked run without a historical build as case infrastructure failure: %s',
        async (scenario) => {
            const record = lockedRecord();
            if (scenario === 'missing provenance') {
                delete record.result.extensionProvenance;
                record.provenance.extension = null;
            } else if (scenario === 'pinned release') {
                record.result.extensionProvenance!.source = 'pinned_release';
                delete record.result.extensionProvenance!.historicalBuild;
            } else {
                delete record.result.extensionProvenance!.historicalBuild;
            }

            const assessment = await assessGoldenAgentEnvironment(record, dependencies(REPORT_URL));

            expect(assessment).toMatchObject({
                status: 'infrastructure_failure',
                detail: expect.stringMatching(/historical.*build/i),
            });
        },
    );

    it('treats an issue whose extraction carried no import as case infrastructure failure', async () => {
        const issueFile = writeIssue('AdGuard product: | AdGuard Browser Extension v5.4.3.99 MV3');

        expect(
            await assessGoldenAgentEnvironment(lockedRecord(), {
                readReporterEnvironment: () =>
                    extractGoldenReporterEnvironment(issueFile, async () => ({
                        siteUrls: ['https://www.nettg.pl/'],
                        problemType: 'ads',
                        screenshots: [],
                        environment: { product: 'AdGuard Browser Extension v5.4.3.99 MV3' },
                        enabledLists: [],
                        userRules: [],
                        reproductionSteps: [],
                    })),
            }),
        ).toMatchObject({
            status: 'infrastructure_failure',
            detail: expect.stringMatching(/exact.*settings import/i),
        });
    });

    it('rejects disagreement between result-bound and wrapper extension provenance', async () => {
        const record = lockedRecord();
        // The two views may share the serialized object; a full replacement makes the wrapper
        // view diverge from the result-bound one instead of mutating both in place.
        record.provenance.extension = {
            ...record.provenance.extension!,
            extensionSourceSha256: 'a'.repeat(64),
        };

        expect(await assessGoldenAgentEnvironment(record, dependencies(REPORT_URL))).toMatchObject({
            status: 'infrastructure_failure',
            detail: expect.stringMatching(/provenance disagree/i),
        });
    });
});
