import { mkdirSync, readFileSync } from 'node:fs';

import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GoldenE2EExitCode } from '../../../lab/e2e/golden-exit-code';
import type { CoreConfig } from '../../../src/config/config';

import { runGoldenE2ECase } from '../../../lab/e2e/golden-runner';
import { runGoldenOracleSuite } from '../../../lab/e2e/golden-oracle-only';

import {
    temporaryRoot,
    coreConfig,
    testSeries,
    humanOracle,
    humanFix,
    writeRunSide,
    lockedRun,
    matchedAssessment,
    evaluationDirectoryFor,
} from './golden-runner-fixtures';

describe('golden runner judge integration', () => {
    it('fills the judge cache that a later model run reuses', async () => {
        const root = temporaryRoot('golden-oracle-cache-');
        const caseName = 'example-case';
        const caseDirectory = join(root, 'cases', caseName);
        writeRunSide(caseDirectory);
        const series = testSeries({ judgeCacheRoot: join(root, 'cache') });
        const oracleProbe = vi.fn(async () => ({ status: 'verified' as const, detail: 'Works.' }));
        const oracle = await runGoldenOracleSuite(
            {
                caseNames: [caseName],
                casesRoot: join(root, 'cases'),
                oracleRoot: join(root, 'oracle'),
                series,
            },
            {
                loadHumanOracle: () => humanOracle,
                extractHumanFix: async () => humanFix,
                bindJudgeExtractReport: () => async () => ({
                    siteUrls: ['https://example.com/'],
                    problemType: 'ads',
                    screenshots: [],
                    environment: {},
                    enabledLists: [],
                    userRules: [],
                    reproductionSteps: [],
                    settingsImportUrl:
                        'https://reports.adguard.com/settings/import.html?' +
                        'product_version=5.4.3.99&ext.manifest_version=3&regular_filters=2&stealth.enabled=0',
                }),
                createJudgeProbe: () => oracleProbe,
            },
        );
        expect(oracle.exitCode).toBe(GoldenE2EExitCode.Pass);
        expect(oracleProbe).toHaveBeenCalledOnce();
        const modelProbe = vi.fn();
        const outputDirectory = join(root, 'run');
        const result = await runGoldenE2ECase(
            coreConfig,
            {
                series,
                knowledgeBaseSha: 'b'.repeat(40),
                caseName,
                caseDirectory,
                outputDirectory,
                evaluationDirectory: join(root, 'evaluation'),
            },
            {
                runLocalFix: lockedRun(outputDirectory),
                assessAgentEnvironment: matchedAssessment(),
                loadHumanOracle: () => humanOracle,
                extractHumanFix: async () => humanFix,
                createJudgeProbe: () => modelProbe,
            },
        );
        expect(modelProbe).not.toHaveBeenCalled();
        expect(result.status).toBe('agent_regression');
        expect(
            JSON.parse(readFileSync(join(root, 'evaluation', 'benchmark-record.json'), 'utf8')),
        ).toMatchObject({ outcome: { humanFixVerdict: 'verified', verdictFromCache: true } });
    });

    it('reuses the judge verdict across model runs', async () => {
        const root = temporaryRoot('golden-cache-runs-');
        const caseDirectory = join(root, 'case');
        mkdirSync(caseDirectory);
        writeRunSide(caseDirectory);
        const probe = vi.fn(async () => ({ status: 'verified' as const, detail: 'Works.' }));
        const statuses = [];
        for (const repeat of ['one', 'two']) {
            const outputDirectory = join(root, repeat);
            const result = await runGoldenE2ECase(
                {
                    ...coreConfig,
                    llm: { ...coreConfig.llm, model: `example-${repeat}-agent-model` },
                },
                {
                    series: testSeries({ judgeCacheRoot: join(root, 'cache') }),
                    knowledgeBaseSha: 'b'.repeat(40),
                    caseName: 'example-case',
                    caseDirectory,
                    outputDirectory,
                    evaluationDirectory: join(root, `evaluation-${repeat}`),
                },
                {
                    runLocalFix: lockedRun(outputDirectory),
                    assessAgentEnvironment: matchedAssessment(),
                    loadHumanOracle: () => humanOracle,
                    extractHumanFix: async () => humanFix,
                    createJudgeProbe: () => probe,
                },
            );
            statuses.push(result.status);
        }
        expect(probe).toHaveBeenCalledOnce();
        expect(statuses).toEqual(['agent_regression', 'agent_regression']);
    });

    it('binds reporter-environment extraction to the judge model', async () => {
        const caseDirectory = temporaryRoot('golden-runner-judge-extract-');
        const outputDirectory = temporaryRoot('golden-output-judge-extract-');
        writeRunSide(caseDirectory);
        const series = testSeries();
        const extractReport = vi.fn(async () => null);
        const bindJudgeExtractReport = vi.fn((_llm: CoreConfig['llm']) => extractReport);

        const result = await runGoldenE2ECase(
            coreConfig,
            {
                series,
                knowledgeBaseSha: 'b'.repeat(40),
                caseName: 'judge-extraction',
                caseDirectory,
                outputDirectory,
                evaluationDirectory: evaluationDirectoryFor(outputDirectory),
            },
            {
                runLocalFix: lockedRun(outputDirectory),
                bindJudgeExtractReport,
                loadHumanOracle: () => humanOracle,
            },
        );

        expect(bindJudgeExtractReport).toHaveBeenCalledWith(series.judgeConfig.llm);
        expect(bindJudgeExtractReport.mock.calls[0]![0].model).toBe('example-judge-model');
        expect(extractReport).toHaveBeenCalledOnce();
        expect(result.status).toBe('infrastructure_failure');
    });

    it('builds the human-fix probe from the judge configuration', async () => {
        const caseDirectory = temporaryRoot('golden-runner-judge-probe-');
        const outputDirectory = temporaryRoot('golden-output-judge-probe-');
        writeRunSide(caseDirectory);
        const series = testSeries();
        const probe = vi.fn(async () => ({ status: 'verified' as const, detail: 'Works.' }));
        const createJudgeProbe = vi.fn(() => probe);

        const result = await runGoldenE2ECase(
            coreConfig,
            {
                series,
                knowledgeBaseSha: 'b'.repeat(40),
                caseName: 'judge-probe',
                caseDirectory,
                outputDirectory,
                evaluationDirectory: evaluationDirectoryFor(outputDirectory),
            },
            {
                runLocalFix: lockedRun(outputDirectory),
                assessAgentEnvironment: matchedAssessment(),
                loadHumanOracle: () => humanOracle,
                extractHumanFix: async () => humanFix,
                createJudgeProbe,
            },
        );

        expect(createJudgeProbe).toHaveBeenCalledWith(series.judgeConfig);
        expect(probe).toHaveBeenCalledOnce();
        expect(result.status).toBe('agent_regression');
    });
});
