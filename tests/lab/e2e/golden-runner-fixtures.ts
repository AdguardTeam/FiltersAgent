import * as v from 'valibot';
import {
    PreparedExtensionSource,
    ExtensionManifestVersion,
} from '../../../src/environment/extension-preparation';
import { PreparedExtensionProvenanceSchema } from '../../../src/environment/environment-proofs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, expect, vi } from 'vitest';
import type { CoreConfig } from '../../../src/config/config';
import {
    writeLocalRunOutput,
    type LocalRunOutputPaths,
    type LocalRunRecord,
} from '../../../src/local/run-output';
import { GoldenRunSchemaVersion, type GoldenHumanOracle } from '../../../lab/e2e/golden-case';
import type { ExtractedHumanFix } from '../../../lab/e2e/human-commit-oracle';
import type {
    GoldenE2ERunnerDependencies,
    RunGoldenE2ECaseOptions,
} from '../../../lab/e2e/golden-runner';
import { testCoreConfig } from '../../config/test-core-config';

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

/**
 * Allocate a test-owned system temporary directory removed after each test.
 *
 * @param prefix - Name prefix for the temporary root.
 * @returns Absolute path of the temporary directory.
 */
export function temporaryRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    temporaryRoots.push(root);
    return root;
}

export const coreConfig: CoreConfig = testCoreConfig({
    llm: {
        apiKey: 'fake-agent-key',
        baseUrl: 'https://example.com/v1',
        model: 'example-agent-model',
        visionModel: 'example-agent-model',
    },
});

/**
 * Build the case options every runner test shares, with invented series provenance.
 *
 * @param paths - Case and output directories and the case name.
 * @returns Complete case options.
 */
export function caseOptions(
    paths: Pick<
        RunGoldenE2ECaseOptions,
        'caseName' | 'caseDirectory' | 'outputDirectory' | 'evaluationDirectory'
    > &
        Partial<RunGoldenE2ECaseOptions>,
): RunGoldenE2ECaseOptions {
    return {
        runEnvironment: {
            agent: { commit: 'c'.repeat(40), dirty: true },
            browser: 'cloakbrowser 1.2.3, chromium 123.4',
        },
        knowledgeBaseSha: 'b'.repeat(40),
        oracle: humanOracle,
        ...paths,
    };
}

export const humanOracle: GoldenHumanOracle = {
    humanFixCommit: '8e9ba459a4552df35b3edb1a4e4d8dd240095ce8',
    issueCreatedAt: '2026-07-14T06:08:12Z',
    fixCommittedAt: '2026-07-14T09:08:12Z',
};

export const humanFix: ExtractedHumanFix = {
    firstParent: '8e73dd6c67cb432e1d93bfb79326fd88b16fdbe5',
    candidates: [
        {
            rule: 'nettg.pl##.banner',
            syntaxKind: 'element_hiding',
            filePath: 'BaseFilter/sections/foreign.txt',
            repositoryEdit: 'extend_domains',
            sourceRule: 'nettg.pl,morizon.pl##.banner',
        },
    ],
    removedRules: [],
};

/**
 * Write the public run-side portion of a temporary golden case.
 *
 * @param caseDirectory - Case directory to populate.
 */
export function writeRunSide(caseDirectory: string): void {
    mkdirSync(join(caseDirectory, 'issue'), { recursive: true });
    writeFileSync(
        join(caseDirectory, 'issue', 'issue.json'),
        JSON.stringify({
            schemaVersion: 1,
            rawIssue: {
                number: 235988,
                url: 'https://github.com/AdguardTeam/AdguardFilters/issues/235988',
                title: 'nettg.pl',
                body:
                    '### Issue URL (Ads)\n' +
                    '[https://nettg.pl/](https://adguardteam.github.io/AnonymousRedirect/' +
                    'redirect.html?url=https%3A%2F%2Fnettg.pl%2F)\n\n' +
                    '### Comment\n' +
                    'Repeated advertising leftovers are visible between article cards.\n\n' +
                    '### Issue configuration\n' +
                    '[Import](https://reports.adguard.com/settings/import.html?' +
                    'scheme_version=4&product_type=ext&product_version=5.4.3.99&' +
                    'ext.manifest_version=3&browser=chrome&' +
                    'regular_filters=2%2C216&stealth.enabled=0)',
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
    writeFileSync(
        join(caseDirectory, 'run.json'),
        JSON.stringify({
            schemaVersion: GoldenRunSchemaVersion.Current,
            issueNumber: 235988,
            issueFile: 'issue/issue.json',
            filtersBaseSha: '0e06526e359cfb83f2883f7005aeee3feb56b653',
            extensionBuild: {
                version: '5.4.3.99',
                releaseTag: 'v5.4.3.1',
                autobuildCommit: 'a'.repeat(40),
            },
        }),
        'utf8',
    );
}

/**
 * Build a schema-valid comparable record without a candidate.
 *
 * @returns Locked local run record.
 */
export function analysisOnlyRecord(): LocalRunRecord {
    const extension = v.parse(PreparedExtensionProvenanceSchema, {
        source: PreparedExtensionSource.HistoricalBuild,
        extensionPath: '/tmp/cache/extensions/prebuilt/v5.5.2.3/unpacked',
        manifestVersion: ExtensionManifestVersion.Mv3,
        extensionSourceSha256: 'e'.repeat(64),
        historicalBuild: {
            version: '5.4.3.99',
            releaseTag: 'v5.4.3.1',
            autobuildCommit: 'a'.repeat(40),
            autobuildTag: 'autobuild-v5.4.3.99',
            releaseSha256: 'f'.repeat(64),
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
            // An analysis-only result always carries an indeterminate observation; the reported
            // ads show in the prepared session instead.
            symptomObservation: 'indeterminate',
            browserSessions: [
                {
                    sessionId: 'prepared-session',
                    targetUrl: 'https://nettg.pl/',
                    extensionMode: 'prepared',
                    profile: {
                        viewport: 'desktop',
                        locale: 'pl-PL',
                        timezone: 'Europe/Warsaw',
                        userAgentProfile: 'chromium-desktop',
                        consentStrategy: 'untouched',
                    },
                    navigationVerified: true,
                    fullVisionVerified: true,
                    captures: [
                        {
                            visionVerified: true,
                            viewportArtifactId: 'prepared-viewport',
                            viewport: '/tmp/prepared-viewport.png',
                            fullPageOverviewArtifactId: 'prepared-full-page',
                            fullPageOverview: '/tmp/prepared-full-page.png',
                            tileArtifactIds: ['prepared-tile'],
                            tiles: ['/tmp/prepared-tile.png'],
                            coverageComplete: true,
                            reporterSymptomPresence: 'present',
                        },
                    ],
                },
            ],
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
                screenshots: [
                    '/tmp/prepared-viewport.png',
                    '/tmp/prepared-full-page.png',
                    '/tmp/prepared-tile.png',
                ],
                domSnapshot: null,
                har: null,
                trace: null,
            },
            reasoning: 'No candidate passed.',
            repository: 'AdguardTeam/AdguardFilters',
            baseSha: '0e06526e359cfb83f2883f7005aeee3feb56b653',
            filtersRepository: 'AdguardTeam/AdguardFilters',
            filtersBaseSha: '0e06526e359cfb83f2883f7005aeee3feb56b653',
        },
        provenance: {
            environment: 'historical',
            headless: true,
            extension,
            settingsProfiles: [],
        },
        evidence: {
            summary: 'No candidate passed.',
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
 * Create a local-run seam that persists one schema-valid locked result.
 *
 * @param outputDirectory - Destination supplied to the golden runner.
 * @param events - Optional lifecycle event recorder.
 * @param record - Sealed record persisted by the test lifecycle.
 * @returns Local run mock.
 */
export function lockedRun(
    outputDirectory: string,
    events?: string[],
    record: LocalRunRecord = analysisOnlyRecord(),
) {
    return vi.fn(async (_config, options) => {
        events?.push('run');
        expect(options).not.toHaveProperty('humanFixCommit');
        expect(options).not.toHaveProperty('oracle');
        expect(options).toMatchObject({
            neutralIssueInput: true,
            refuseRepositoryInstruction: true,
        });
        return writeLocalRunOutput(record, {
            outputDir: outputDirectory,
            workspaceRoot: process.cwd(),
        });
    });
}

/**
 * Build canonical output paths for one deliberately malformed mocked local run.
 *
 * @param outputDirectory - Mocked local run directory.
 * @param resultPath - Canonical result path populated by the test.
 * @returns Complete local output-path contract.
 */
export function localOutputPaths(outputDirectory: string, resultPath: string): LocalRunOutputPaths {
    return {
        agentReportPath: join(outputDirectory, 'agent-report.md'),
        agentDecisionPath: null,
        agentObservationsPath: join(outputDirectory, 'agent-observations.json'),
        runResultPath: resultPath,
        manifestPath: join(outputDirectory, 'agent-run-manifest.json'),
        candidatePatchPath: null,
    };
}

/**
 * Keep every networked seam of the runner offline and quiet: the site answers, the human commit
 * comes from the fixtures, and a failed case logs nowhere.
 *
 * @param overrides - Seams a test replaces.
 * @returns Runner dependencies that never reach a site or a git remote.
 */
export function offline(overrides: GoldenE2ERunnerDependencies = {}): GoldenE2ERunnerDependencies {
    return {
        probeSite: async () => ({ reachable: true, answer: 'HTTP 200' }),
        extractHumanFix: async () => humanFix,
        logger: pino({ level: 'silent' }),
        ...overrides,
    };
}
