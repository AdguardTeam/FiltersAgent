import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CoreConfig } from '../../../src/config/config';
import { materializeLocalRunOutputDir } from '../../../src/local/output-directory';
import {
    writeLocalRunOutput,
    type LocalRunOutputPaths,
    type LocalRunRecord,
} from '../../../src/local/run-output';
import type { GoldenHumanOracle } from '../../../lab/e2e/golden-case';
import type { ExtractedHumanFix } from '../../../lab/e2e/human-commit-oracle';
import { runGoldenE2ECase } from '../../../lab/e2e/golden-runner';
import { listGoldenCaseNames, runGoldenE2ESuite } from '../../../lab/e2e/golden-suite';
import { createRunUsageCollector } from '../../../src/pi/usage-collector';
import { describeRunCost, RunCostStatus } from '../../../lab/pricing/run-cost';
import { LLM_PRICING_FILE_VAR, loadUsagePricing } from '../../../lab/pricing/usage-pricing';
import { testCoreConfig } from '../../config/test-core-config';

const coreConfig: CoreConfig = testCoreConfig({
    llm: { apiKey: 'local-key', visionModel: 'gemini-3.5-flash' },
});

const humanOracle: GoldenHumanOracle = {
    humanFixCommit: '8e9ba459a4552df35b3edb1a4e4d8dd240095ce8',
};

const humanFix: ExtractedHumanFix = {
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
function writeRunSide(caseDirectory: string): void {
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
            schemaVersion: 2,
            issueNumber: 235988,
            issueFile: 'issue/issue.json',
            filtersBaseSha: '0e06526e359cfb83f2883f7005aeee3feb56b653',
        }),
        'utf8',
    );
}

/**
 * Build a schema-valid comparable record without a candidate.
 *
 * @returns Locked local run record.
 */
function analysisOnlyRecord(): LocalRunRecord {
    const extension = {
        source: 'pinned_release' as const,
        extensionPath: '/tmp/cache/extensions/prebuilt/v5.5.2.3/unpacked',
        manifestVersion: 3 as const,
        extensionSourceSha256: 'e'.repeat(64),
        extensionSourceTag: 'v5.5.2.3',
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
 * @returns Local run mock.
 */
function lockedRun(
    outputDirectory: string,
    events?: string[],
    record: LocalRunRecord = analysisOnlyRecord(),
) {
    return vi.fn(async (_config, options) => {
        events?.push('run');
        expect(options).not.toHaveProperty('humanFixCommit');
        expect(options).not.toHaveProperty('oracle');
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
function localOutputPaths(outputDirectory: string, resultPath: string): LocalRunOutputPaths {
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
function matchedAssessment(): NonNullable<
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
function mismatchedAssessment(): NonNullable<
    NonNullable<Parameters<typeof runGoldenE2ECase>[2]>['assessAgentEnvironment']
> {
    return async () => ({
        status: 'agent_mismatch',
        detail: 'Scripted reporter-environment mismatch.',
        extension: null,
    });
}

function evaluationDirectoryFor(outputDirectory: string): string {
    return `${outputDirectory}-evaluation`;
}

describe('runGoldenE2ECase', () => {
    it('does not clear a caller directory that lacks the ownership marker', async () => {
        const root = mkdtempSync(join(tmpdir(), 'golden-runner-unowned-'));
        const caseDirectory = join(root, 'case');
        const outputDirectory = join(root, 'run');
        const evaluationDirectory = join(root, 'evaluation');
        mkdirSync(caseDirectory);
        mkdirSync(outputDirectory);
        writeRunSide(caseDirectory);
        writeFileSync(join(outputDirectory, 'keep.txt'), 'keep', 'utf8');

        await expect(
            runGoldenE2ECase(coreConfig, {
                caseName: 'unowned-output',
                caseDirectory,
                outputDirectory,
                evaluationDirectory,
            }),
        ).rejects.toThrow(/not owned|nonempty/i);
        expect(readFileSync(join(outputDirectory, 'keep.txt'), 'utf8')).toBe('keep');
    });

    it('clears stale comparator evidence before starting a case', async () => {
        const caseDirectory = mkdtempSync(join(tmpdir(), 'golden-runner-clean-'));
        const outputDirectory = mkdtempSync(join(tmpdir(), 'golden-output-clean-'));
        const evaluationDirectory = evaluationDirectoryFor(outputDirectory);
        const staleOracleDirectory = join(evaluationDirectory, 'oracle');
        const staleClassificationPath = join(evaluationDirectory, 'e2e-result.json');
        writeRunSide(caseDirectory);
        mkdirSync(evaluationDirectory);
        materializeLocalRunOutputDir(evaluationDirectory, process.cwd());
        mkdirSync(staleOracleDirectory);
        writeFileSync(join(staleOracleDirectory, 'stale.json'), '{}', 'utf8');
        writeFileSync(staleClassificationPath, '{"status":"pass"}', 'utf8');

        await runGoldenE2ECase(
            coreConfig,
            {
                caseName: 'clean-output',
                caseDirectory,
                outputDirectory,
                evaluationDirectory,
            },
            {
                runLocalFix: vi.fn(async () => {
                    expect(existsSync(staleOracleDirectory)).toBe(false);
                    expect(existsSync(staleClassificationPath)).toBe(false);
                    const resultPath = join(outputDirectory, 'result.json');
                    writeFileSync(resultPath, '{"invalid":true}', 'utf8');
                    return localOutputPaths(outputDirectory, resultPath);
                }),
            },
        );

        expect(existsSync(staleOracleDirectory)).toBe(false);
        expect(JSON.parse(readFileSync(staleClassificationPath, 'utf8'))).toMatchObject({
            status: 'infrastructure_failure',
            exitCode: 3,
        });
    });

    it('starts a plugged-in module in the case run from a private workspace it removes after', async () => {
        const caseDirectory = mkdtempSync(join(tmpdir(), 'golden-runner-module-'));
        const outputDirectory = mkdtempSync(join(tmpdir(), 'golden-output-module-'));
        writeRunSide(caseDirectory);
        const startBlocker = vi.fn();
        let moduleWorkspace = '';

        await runGoldenE2ECase(
            coreConfig,
            {
                caseName: 'plugged-module',
                caseDirectory,
                outputDirectory,
                evaluationDirectory: evaluationDirectoryFor(outputDirectory),
                blockerModules: [{ executor: 'demo_proxy', startBlocker }],
            },
            {
                runLocalFix: vi.fn(async (_config, options) => {
                    const module = options.executorDependencies?.['demo_proxy'];
                    expect(module?.startBlocker).toBe(startBlocker);
                    moduleWorkspace = module?.workspaceDir ?? '';
                    expect(moduleWorkspace.startsWith(realpathSync(tmpdir()))).toBe(true);
                    const resultPath = join(outputDirectory, 'result.json');
                    writeFileSync(resultPath, '{"invalid":true}', 'utf8');
                    return localOutputPaths(outputDirectory, resultPath);
                }),
            },
        );

        expect(moduleWorkspace).not.toBe('');
        expect(existsSync(join(moduleWorkspace, '..'))).toBe(false);
    });

    it('clears all prior owned run output before validating the next case input', async () => {
        const caseDirectory = mkdtempSync(join(tmpdir(), 'golden-runner-invalid-input-'));
        const outputDirectory = mkdtempSync(join(tmpdir(), 'golden-output-invalid-input-'));
        const evaluationDirectory = evaluationDirectoryFor(outputDirectory);
        const artifactsDirectory = join(outputDirectory, 'artifacts');
        materializeLocalRunOutputDir(outputDirectory, process.cwd());
        mkdirSync(artifactsDirectory);
        writeFileSync(join(caseDirectory, 'run.json'), '{"invalid":true}', 'utf8');
        for (const name of [
            'agent-report.md',
            'agent-decision.json',
            'agent-observations.json',
            'agent-run-manifest.json',
            'run-result.json',
            'report.md',
            'result.json',
            'candidate.patch',
        ]) {
            writeFileSync(join(outputDirectory, name), 'stale', 'utf8');
        }
        writeFileSync(join(artifactsDirectory, 'stale.json'), '{}', 'utf8');
        const runLocalFix = vi.fn();

        const result = await runGoldenE2ECase(
            coreConfig,
            { caseName: 'invalid-input', caseDirectory, outputDirectory, evaluationDirectory },
            { runLocalFix },
        );

        expect(result).toMatchObject({ status: 'infrastructure_failure', exitCode: 3 });
        expect(runLocalFix).not.toHaveBeenCalled();
        expect(existsSync(join(outputDirectory, 'agent-report.md'))).toBe(false);
        expect(existsSync(join(outputDirectory, 'agent-decision.json'))).toBe(false);
        expect(existsSync(join(outputDirectory, 'agent-observations.json'))).toBe(false);
        expect(existsSync(join(outputDirectory, 'agent-run-manifest.json'))).toBe(false);
        expect(existsSync(join(outputDirectory, 'run-result.json'))).toBe(false);
        expect(existsSync(join(outputDirectory, 'report.md'))).toBe(false);
        expect(existsSync(join(outputDirectory, 'result.json'))).toBe(false);
        expect(existsSync(join(outputDirectory, 'candidate.patch'))).toBe(false);
        expect(existsSync(artifactsDirectory)).toBe(false);
    });

    it('never loads oracle.json when the locked result fails schema validation', async () => {
        const caseDirectory = mkdtempSync(join(tmpdir(), 'golden-runner-invalid-'));
        const outputDirectory = mkdtempSync(join(tmpdir(), 'golden-output-invalid-'));
        const evaluationDirectory = evaluationDirectoryFor(outputDirectory);
        writeRunSide(caseDirectory);
        const loadHumanOracle = vi.fn(() => humanOracle);
        const extractHumanFix = vi.fn(async () => humanFix);

        const result = await runGoldenE2ECase(
            coreConfig,
            { caseName: 'invalid-result', caseDirectory, outputDirectory, evaluationDirectory },
            {
                runLocalFix: vi.fn(async () => {
                    const resultPath = join(outputDirectory, 'run-result.json');
                    writeFileSync(resultPath, '{"not":"a local run record"}', 'utf8');
                    return localOutputPaths(outputDirectory, resultPath);
                }),
                loadHumanOracle,
                extractHumanFix,
            },
        );

        expect(result).toMatchObject({ status: 'infrastructure_failure', exitCode: 3 });
        expect(loadHumanOracle).not.toHaveBeenCalled();
        expect(extractHumanFix).not.toHaveBeenCalled();
    });

    it('never opens the oracle for a locked result from a different case', async () => {
        const caseDirectory = mkdtempSync(join(tmpdir(), 'golden-runner-wrong-case-'));
        const outputDirectory = mkdtempSync(join(tmpdir(), 'golden-output-wrong-case-'));
        const evaluationDirectory = evaluationDirectoryFor(outputDirectory);
        writeRunSide(caseDirectory);
        const record = analysisOnlyRecord();
        record.result.issueNumber = 999;
        const loadHumanOracle = vi.fn(() => humanOracle);

        const result = await runGoldenE2ECase(
            coreConfig,
            { caseName: 'wrong-case', caseDirectory, outputDirectory, evaluationDirectory },
            {
                runLocalFix: lockedRun(outputDirectory, undefined, record),
                loadHumanOracle,
            },
        );

        expect(result).toMatchObject({
            status: 'infrastructure_failure',
            exitCode: 3,
            detail: expect.stringMatching(/issue.*selected golden case/i),
        });
        expect(loadHumanOracle).not.toHaveBeenCalled();
    });

    it('loads and extracts the human fix only after run-result.json is locked and validated', async () => {
        const caseDirectory = mkdtempSync(join(tmpdir(), 'golden-runner-order-'));
        const outputDirectory = mkdtempSync(join(tmpdir(), 'golden-output-order-'));
        const evaluationDirectory = evaluationDirectoryFor(outputDirectory);
        writeRunSide(caseDirectory);
        const events: string[] = [];
        const loadHumanOracle = vi.fn(() => {
            events.push('oracle');
            return humanOracle;
        });
        const extractHumanFix = vi.fn(async (commit: string) => {
            events.push('diff');
            expect(commit).toBe(humanOracle.humanFixCommit);
            return humanFix;
        });

        const result = await runGoldenE2ECase(
            coreConfig,
            { caseName: 'ordered', caseDirectory, outputDirectory, evaluationDirectory },
            {
                runLocalFix: lockedRun(outputDirectory, events),
                assessAgentEnvironment: matchedAssessment(),
                loadHumanOracle,
                extractHumanFix,
                probeHumanCandidate: async (context) => {
                    expect(context).not.toHaveProperty('humanFixCommit');
                    expect(context).not.toHaveProperty('record');
                    expect(context.candidate.rule).toBe('nettg.pl##.banner');
                    expect(context.outputDirectory).toBe(realpathSync(evaluationDirectory));
                    return { status: 'verified', detail: 'Human rule independently verified.' };
                },
            },
        );

        expect(events).toEqual(['run', 'oracle', 'diff']);
        expect(result).toMatchObject({ status: 'agent_regression', exitCode: 1 });
        expect(
            JSON.parse(readFileSync(join(evaluationDirectory, 'e2e-result.json'), 'utf8')),
        ).toEqual(result);
        expect(existsSync(join(outputDirectory, 'e2e-result.json'))).toBe(false);
    });

    it('rejects a coherently replaced locked run after oracle evaluation', async () => {
        const caseDirectory = mkdtempSync(join(tmpdir(), 'golden-runner-replaced-run-'));
        const outputDirectory = mkdtempSync(join(tmpdir(), 'golden-output-replaced-run-'));
        const evaluationDirectory = evaluationDirectoryFor(outputDirectory);
        writeRunSide(caseDirectory);

        const result = await runGoldenE2ECase(
            coreConfig,
            { caseName: 'replaced-run', caseDirectory, outputDirectory, evaluationDirectory },
            {
                runLocalFix: lockedRun(outputDirectory),
                assessAgentEnvironment: matchedAssessment(),
                loadHumanOracle: () => humanOracle,
                extractHumanFix: async () => humanFix,
                probeHumanCandidate: async () => {
                    const replacement = analysisOnlyRecord();
                    replacement.result.reasoning = 'A coherently replaced result.';
                    writeLocalRunOutput(replacement, {
                        outputDir: outputDirectory,
                        workspaceRoot: process.cwd(),
                    });
                    return { status: 'verified', detail: 'Human rule independently verified.' };
                },
            },
        );

        expect(result).toMatchObject({
            status: 'infrastructure_failure',
            exitCode: 3,
            detail: expect.stringMatching(/changed.*oracle evaluation/i),
        });
    });

    it('reads the canonical run result instead of a path returned by an injected runner', async () => {
        const root = mkdtempSync(join(tmpdir(), 'golden-runner-returned-path-'));
        const caseDirectory = join(root, 'case');
        const outputDirectory = join(root, 'run');
        const evaluationDirectory = join(root, 'evaluation');
        const foreignResultPath = join(root, 'foreign-result.json');
        mkdirSync(caseDirectory);
        writeRunSide(caseDirectory);
        writeFileSync(foreignResultPath, '{"untrusted":true}', 'utf8');

        const result = await runGoldenE2ECase(
            coreConfig,
            { caseName: 'returned-path', caseDirectory, outputDirectory, evaluationDirectory },
            {
                runLocalFix: vi.fn(async (_config, options) => {
                    const paths = writeLocalRunOutput(analysisOnlyRecord(), {
                        outputDir: options.outputDir,
                        workspaceRoot: process.cwd(),
                    });
                    return { ...paths, runResultPath: foreignResultPath };
                }),
                assessAgentEnvironment: matchedAssessment(),
                loadHumanOracle: () => humanOracle,
                extractHumanFix: async () => humanFix,
                probeHumanCandidate: async () => ({
                    status: 'verified',
                    detail: 'Human rule independently verified.',
                }),
            },
        );

        expect(result).toMatchObject({ status: 'agent_regression', exitCode: 1 });
    });

    it('atomically replaces an evaluator result symlink without changing its target', async () => {
        const root = mkdtempSync(join(tmpdir(), 'golden-runner-result-symlink-'));
        const caseDirectory = join(root, 'case');
        const outputDirectory = join(root, 'run');
        const evaluationDirectory = join(root, 'evaluation');
        const sentinelPath = join(root, 'sentinel.json');
        mkdirSync(caseDirectory);
        writeRunSide(caseDirectory);
        writeFileSync(sentinelPath, '{"sentinel":true}\n', 'utf8');

        const result = await runGoldenE2ECase(
            coreConfig,
            { caseName: 'safe-result', caseDirectory, outputDirectory, evaluationDirectory },
            {
                runLocalFix: lockedRun(outputDirectory),
                assessAgentEnvironment: matchedAssessment(),
                loadHumanOracle: () => humanOracle,
                extractHumanFix: async () => humanFix,
                probeHumanCandidate: async () => {
                    symlinkSync(
                        sentinelPath,
                        join(realpathSync(evaluationDirectory), 'e2e-result.json'),
                    );
                    return { status: 'verified', detail: 'Human rule independently verified.' };
                },
            },
        );

        const resultPath = join(realpathSync(evaluationDirectory), 'e2e-result.json');
        expect(result.status).toBe('agent_regression');
        expect(readFileSync(sentinelPath, 'utf8')).toBe('{"sentinel":true}\n');
        expect(lstatSync(resultPath).isSymbolicLink()).toBe(false);
        expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toEqual(result);
    });

    it('rejects output aliases to a tracked case before cleaning either directory', async () => {
        const root = mkdtempSync(join(tmpdir(), 'golden-runner-case-alias-'));
        const caseDirectory = join(root, 'case');
        const outputLink = join(root, 'run-link');
        const evaluationDirectory = join(root, 'evaluation');
        mkdirSync(caseDirectory);
        writeRunSide(caseDirectory);
        writeFileSync(join(caseDirectory, 'sentinel.txt'), 'tracked', 'utf8');
        symlinkSync(caseDirectory, outputLink, 'dir');

        await expect(
            runGoldenE2ECase(coreConfig, {
                caseName: 'case-alias',
                caseDirectory,
                outputDirectory: outputLink,
                evaluationDirectory,
            }),
        ).rejects.toThrow(/mutually separate/u);
        expect(readFileSync(join(caseDirectory, 'sentinel.txt'), 'utf8')).toBe('tracked');
    });

    it('rejects agent and evaluator directories that resolve to the same location', async () => {
        const root = mkdtempSync(join(tmpdir(), 'golden-runner-output-alias-'));
        const caseDirectory = join(root, 'case');
        const outputDirectory = join(root, 'run');
        const evaluationLink = join(root, 'evaluation-link');
        mkdirSync(caseDirectory);
        mkdirSync(outputDirectory);
        writeRunSide(caseDirectory);
        writeFileSync(join(outputDirectory, 'sentinel.txt'), 'run', 'utf8');
        symlinkSync(outputDirectory, evaluationLink, 'dir');

        await expect(
            runGoldenE2ECase(coreConfig, {
                caseName: 'output-alias',
                caseDirectory,
                outputDirectory,
                evaluationDirectory: evaluationLink,
            }),
        ).rejects.toThrow(/mutually separate/u);
        expect(readFileSync(join(outputDirectory, 'sentinel.txt'), 'utf8')).toBe('run');
    });

    it('classifies missing reporter-session evidence as regression without running the oracle browser', async () => {
        const caseDirectory = mkdtempSync(join(tmpdir(), 'golden-runner-environment-'));
        const outputDirectory = mkdtempSync(join(tmpdir(), 'golden-output-environment-'));
        const evaluationDirectory = evaluationDirectoryFor(outputDirectory);
        writeRunSide(caseDirectory);
        const issuePath = join(caseDirectory, 'issue', 'issue.json');
        const issue = JSON.parse(readFileSync(issuePath, 'utf8')) as {
            rawIssue: { body: string };
        };
        issue.rawIssue.body =
            '### Issue configuration\n' +
            '[Import](https://reports.adguard.com/settings/import.html?' +
            'product_version=5.4.3.99&ext.manifest_version=3&' +
            'regular_filters=2%2C216&stealth.enabled=0)';
        writeFileSync(issuePath, JSON.stringify(issue), 'utf8');
        const probeHumanCandidate = vi.fn();
        const extractHumanFix = vi.fn(async () => humanFix);

        const result = await runGoldenE2ECase(
            coreConfig,
            {
                caseName: 'environment-mismatch',
                caseDirectory,
                outputDirectory,
                evaluationDirectory,
            },
            {
                runLocalFix: lockedRun(
                    outputDirectory,
                    undefined,
                    (() => {
                        const record = analysisOnlyRecord();
                        delete record.result.extensionProvenance;
                        delete record.result.settingsEvidence;
                        record.provenance.extension = null;
                        return record;
                    })(),
                ),
                assessAgentEnvironment: mismatchedAssessment(),
                loadHumanOracle: () => humanOracle,
                extractHumanFix,
                probeHumanCandidate,
            },
        );

        expect(result).toMatchObject({
            status: 'agent_regression',
            exitCode: 1,
            detail: expect.stringMatching(/reporter environment mismatch/i),
        });
        expect(extractHumanFix).not.toHaveBeenCalled();
        expect(probeHumanCandidate).not.toHaveBeenCalled();
    });

    it('uses the oracle to classify target navigation exhaustion as infrastructure', async () => {
        const caseDirectory = mkdtempSync(join(tmpdir(), 'golden-runner-browser-failure-'));
        const outputDirectory = mkdtempSync(join(tmpdir(), 'golden-output-browser-failure-'));
        const evaluationDirectory = evaluationDirectoryFor(outputDirectory);
        writeRunSide(caseDirectory);
        const record = analysisOnlyRecord();
        record.result.effectiveMode = 'reasoning';
        record.result.verificationStatus = 'unavailable';
        record.result.symptomObservation = 'indeterminate';
        record.result.reasoning = 'Every live navigation timed out before browser evidence.';
        const extractHumanFix = vi.fn(async () => humanFix);
        const probeHumanCandidate = vi.fn(async () => ({
            status: 'infrastructure_failure' as const,
            detail: 'The target site remained unreachable after three independent sessions.',
        }));

        const result = await runGoldenE2ECase(
            coreConfig,
            { caseName: 'browser-failure', caseDirectory, outputDirectory, evaluationDirectory },
            {
                runLocalFix: lockedRun(outputDirectory, undefined, record),
                assessAgentEnvironment: matchedAssessment(),
                loadHumanOracle: () => humanOracle,
                extractHumanFix,
                probeHumanCandidate,
            },
        );

        expect(result).toMatchObject({
            status: 'infrastructure_failure',
            exitCode: 3,
            detail: expect.stringMatching(/target site remained unreachable/i),
        });
        expect(extractHumanFix).toHaveBeenCalledOnce();
        expect(probeHumanCandidate).toHaveBeenCalledOnce();
    });
});

describe('listGoldenCaseNames', () => {
    it('discovers run-side cases in stable order without requiring oracle.json', () => {
        const casesRoot = mkdtempSync(join(tmpdir(), 'golden-cases-'));
        for (const name of ['z-case', 'a-case']) {
            const caseDirectory = join(casesRoot, name);
            mkdirSync(caseDirectory);
            writeRunSide(caseDirectory);
        }
        mkdirSync(join(casesRoot, 'not-a-case'));

        expect(listGoldenCaseNames(casesRoot)).toEqual(['a-case', 'z-case']);
    });
});

describe('runGoldenE2ESuite', () => {
    it('runs selected cases sequentially and preserves exit-code severity 0/1/2/3', async () => {
        const casesRoot = mkdtempSync(join(tmpdir(), 'golden-suite-cases-'));
        const outputRoot = mkdtempSync(join(tmpdir(), 'golden-suite-output-'));
        const evaluationRoot = mkdtempSync(join(tmpdir(), 'golden-suite-evaluation-'));
        for (const name of ['regression', 'drift']) {
            const caseDirectory = join(casesRoot, name);
            mkdirSync(caseDirectory);
            writeRunSide(caseDirectory);
        }
        let active = 0;
        let maxActive = 0;
        const runLocalFix = vi.fn(async (_config, options) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await Promise.resolve();
            const paths = writeLocalRunOutput(analysisOnlyRecord(), {
                outputDir: options.outputDir,
                workspaceRoot: process.cwd(),
            });
            active -= 1;
            return paths;
        });

        const suite = await runGoldenE2ESuite(
            coreConfig,
            {
                caseNames: ['regression', 'drift'],
                casesRoot,
                outputRoot,
                evaluationRoot,
            },
            {
                runLocalFix,
                assessAgentEnvironment: matchedAssessment(),
                loadHumanOracle: () => humanOracle,
                extractHumanFix: async () => humanFix,
                probeHumanCandidate: async ({ caseName }) =>
                    caseName === 'regression'
                        ? { status: 'verified', detail: 'Human rule still works.' }
                        : { status: 'not_verified', detail: 'Historical site drifted.' },
            },
        );

        expect(maxActive).toBe(1);
        expect(suite.results.map((entry) => entry.result.status)).toEqual([
            'agent_regression',
            'environment_drift',
        ]);
        expect(suite.exitCode).toBe(2);
        expect(existsSync(join(outputRoot, 'regression', 'e2e-result.json'))).toBe(false);
        expect(existsSync(join(evaluationRoot, 'regression', 'e2e-result.json'))).toBe(true);
    });

    it.each([
        ['without a price file', undefined, RunCostStatus.NoPricingFile],
        ['with the example price file', 'docs/examples/pricing.example.json', RunCostStatus.Priced],
    ])('reports each case cost %s', async (_label, pricingFile, expectedStatus) => {
        // The benchmark runs with any provider: without a price file the run still completes and
        // its cost line says the cost was not computed; with one, the case is priced from it.
        const casesRoot = mkdtempSync(join(tmpdir(), 'golden-suite-cost-cases-'));
        const outputRoot = mkdtempSync(join(tmpdir(), 'golden-suite-cost-output-'));
        const evaluationRoot = mkdtempSync(join(tmpdir(), 'golden-suite-cost-evaluation-'));
        mkdirSync(join(casesRoot, 'priced'));
        writeRunSide(join(casesRoot, 'priced'));
        const pricedConfig = testCoreConfig({ llm: { model: 'example-reasoning-model' } });
        const pricingSnapshot =
            loadUsagePricing({ [LLM_PRICING_FILE_VAR]: pricingFile }, process.cwd()) ?? undefined;
        // Meters one completion the way the real runner does: a collector built from the rates
        // the suite handed to the run.
        const runLocalFix = vi.fn(async (config: CoreConfig, options) => {
            const collector = createRunUsageCollector({ rates: options.pricingSnapshot });
            collector.addSession({
                completions: [
                    {
                        model: config.llm.model,
                        reported: true,
                        input: 100_000,
                        output: 10_000,
                        cacheRead: 0,
                        cacheWrite: 0,
                        reasoningTokens: 0,
                    },
                ],
                durationMs: 1000,
            });
            return writeLocalRunOutput(analysisOnlyRecord(), {
                outputDir: options.outputDir,
                workspaceRoot: process.cwd(),
                llmUsage: collector.summary(),
            });
        });

        const suite = await runGoldenE2ESuite(
            pricedConfig,
            { caseNames: ['priced'], casesRoot, outputRoot, evaluationRoot, pricingSnapshot },
            {
                runLocalFix,
                assessAgentEnvironment: matchedAssessment(),
                loadHumanOracle: () => humanOracle,
                extractHumanFix: async () => humanFix,
                probeHumanCandidate: async () => ({ status: 'verified', detail: 'Works.' }),
            },
        );

        const cost = suite.results[0]!.cost;
        expect(cost.status).toBe(expectedStatus);
        if (expectedStatus === RunCostStatus.Priced) {
            expect(cost.usd).toBeGreaterThan(0);
        } else {
            expect(cost.usd).toBeNull();
            expect(describeRunCost(cost)).toContain(LLM_PRICING_FILE_VAR);
        }
    });
});
