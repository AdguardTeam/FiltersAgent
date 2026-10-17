import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, vi } from 'vitest';
import type { CoreConfig } from '../../../src/config/config';
import {
    writeLocalRunOutput,
    type LocalRunOutputPaths,
    type LocalRunRecord,
} from '../../../src/local/run-output';
import { GoldenRunSchemaVersion, type GoldenHumanOracle } from '../../../lab/e2e/golden-case';
import type { ExtractedHumanFix } from '../../../lab/e2e/human-commit-oracle';
import type { runGoldenE2ECase, GoldenSeries } from '../../../lab/e2e/golden-runner';
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
 * Create a benchmark series with isolated invented model identities.
 *
 * @param overrides - Series fields to replace for a test.
 * @returns Complete benchmark series configuration.
 */
export function testSeries(overrides: Partial<GoldenSeries> = {}): GoldenSeries {
    return {
        judgeConfig: testCoreConfig({
            llm: {
                apiKey: 'fake-judge-key',
                baseUrl: 'https://example.com/v1',
                model: 'example-judge-model',
                visionModel: 'example-judge-model',
            },
        }),
        judgeCacheRoot: null,
        refreshJudgeCache: false,
        runEnvironment: {
            agent: { commit: 'c'.repeat(40), dirty: true },
            browser: 'cloakbrowser 1.2.3, chromium 123.4',
        },
        ...overrides,
    };
}

export const humanOracle: GoldenHumanOracle = {
    humanFixCommit: '8e9ba459a4552df35b3edb1a4e4d8dd240095ce8',
    issueCreatedAt: '2026-07-14T06:08:12Z',
    fixCommittedAt: '2026-07-14T09:08:12Z',
};

export const humanFix: ExtractedHumanFix = {
    commit: humanOracle.humanFixCommit,
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
                    'Repeated advertising leftovers are visible between article cards.\n\n' +
                    '### Issue configuration\n' +
                    '[Import](https://reports.adguard.com/settings/import.html?' +
                    'product_version=5.4.3.99&ext.manifest_version=3&' +
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
    const extension = {
        source: 'historical_build' as const,
        extensionPath: '/tmp/cache/extensions/prebuilt/v5.5.2.3/unpacked',
        manifestVersion: 3 as const,
        extensionSourceSha256: 'e'.repeat(64),
        historicalBuild: {
            version: '5.4.3.99',
            releaseTag: 'v5.4.3.1',
            autobuildCommit: 'a'.repeat(40),
            autobuildTag: 'autobuild-v5.4.3.99',
            releaseSha256: 'f'.repeat(64),
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
 * Script the post-lock reporter-environment assessment as an exact match.
 *
 * @returns A runner seam member using the locked record's own wrapper extension.
 */
export function matchedAssessment(): NonNullable<
    NonNullable<Parameters<typeof runGoldenE2ECase>[2]>['assessAgentEnvironment']
> {
    return async (record) => ({
        status: 'matched',
        detail: 'Scripted exact reporter-environment match.',
        extension: record.provenance.extension!,
    });
}

/**
 * Script the post-lock reporter-environment assessment as agent equipment mismatch.
 *
 * @returns A runner seam member classifying the locked record as an agent mismatch.
 */
export function mismatchedAssessment(): NonNullable<
    NonNullable<Parameters<typeof runGoldenE2ECase>[2]>['assessAgentEnvironment']
> {
    return async () => ({
        status: 'agent_mismatch',
        detail: 'Scripted reporter-environment mismatch.',
        extension: null,
    });
}

/**
 * Track a separate evaluation directory for cleanup.
 *
 * @param outputDirectory - Agent output directory used as the name prefix.
 * @returns Separate sibling evaluation directory.
 */
export function evaluationDirectoryFor(outputDirectory: string): string {
    const directory = `${outputDirectory}-evaluation`;
    temporaryRoots.push(directory);
    return directory;
}
