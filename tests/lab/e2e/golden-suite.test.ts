import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GoldenE2EExitCode } from '../../../lab/e2e/golden-exit-code';
import type { CoreConfig } from '../../../src/config/config';

import { writeLocalRunOutput, type LocalRunRecord } from '../../../src/local/run-output';

import type { GoldenE2EResult } from '../../../lab/e2e/golden-comparator';

import {
    goldenOutputLayout,
    listGoldenCaseNames,
    runGoldenE2ESuite,
} from '../../../lab/e2e/golden-suite';
import { createRunUsageCollector } from '../../../src/pi/usage-collector';
import { describeRunCost, RunCostStatus } from '../../../lab/pricing/run-cost';
import { LLM_PRICING_FILE_VAR, loadUsagePricing } from '../../../lab/pricing/usage-pricing';
import { testCoreConfig } from '../../config/test-core-config';

import {
    temporaryRoot,
    coreConfig,
    testSeries,
    humanOracle,
    humanFix,
    writeRunSide,
    analysisOnlyRecord,
    matchedAssessment,
} from './golden-runner-fixtures';

describe('listGoldenCaseNames', () => {
    it('discovers run-side cases in stable order without requiring oracle.json', () => {
        const casesRoot = temporaryRoot('golden-cases-');
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
    it.each([
        ['resolves KnowledgeBase once and hands every case the same commit', false],
        ['takes the flag commit without resolving', true],
    ])('%s', async (_name, explicitPin) => {
        const root = temporaryRoot('golden-suite-kb-pin-');
        const casesRoot = join(root, 'cases');
        for (const caseName of ['first', 'second']) {
            writeRunSide(join(casesRoot, caseName));
        }
        const sha = 'c'.repeat(40);
        const resolveKnowledgeBaseSha = vi.fn(async () => sha);
        const onKnowledgeBaseResolved = vi.fn();
        const runLocalFix = vi.fn(async (_config, options) =>
            writeLocalRunOutput(analysisOnlyRecord(), {
                outputDir: options.outputDir,
                workspaceRoot: process.cwd(),
            }),
        );
        await runGoldenE2ESuite(
            coreConfig,
            {
                series: testSeries(),
                caseNames: ['first', 'second'],
                casesRoot,
                outputRoot: join(root, 'runs'),
                evaluationRoot: join(root, 'evaluations'),
                knowledgeBaseSha: explicitPin ? sha : undefined,
                onKnowledgeBaseResolved,
            },
            {
                resolveKnowledgeBaseSha,
                runLocalFix,
                assessAgentEnvironment: matchedAssessment(),
                loadHumanOracle: () => humanOracle,
                extractHumanFix: async () => humanFix,
                createJudgeProbe: () => async () => ({ status: 'verified', detail: 'Works.' }),
            },
        );
        expect(resolveKnowledgeBaseSha).toHaveBeenCalledTimes(explicitPin ? 0 : 1);
        expect(onKnowledgeBaseResolved).toHaveBeenCalledExactlyOnceWith(sha);
        expect(runLocalFix).toHaveBeenCalledTimes(2);
        for (const [, options] of runLocalFix.mock.calls) {
            expect(options.knowledgeBaseSha).toBe(sha);
        }
    });

    it('lays out runs and evaluations under the output root', () => {
        const workspaceRoot = temporaryRoot('golden-layout-');
        expect(goldenOutputLayout(workspaceRoot, 'tmp/comparison')).toEqual({
            outputRoot: join(workspaceRoot, 'tmp/comparison/runs'),
            evaluationRoot: join(workspaceRoot, 'tmp/comparison/evaluations'),
            refuseExisting: true,
        });
        const externalRoot = resolve(tmpdir(), 'external-comparison');
        expect(goldenOutputLayout(workspaceRoot, externalRoot)).toEqual({
            outputRoot: join(externalRoot, 'runs'),
            evaluationRoot: join(externalRoot, 'evaluations'),
            refuseExisting: true,
        });
        expect(goldenOutputLayout(workspaceRoot, null)).toEqual({
            outputRoot: join(workspaceRoot, 'tmp/e2e-runs'),
            evaluationRoot: join(workspaceRoot, 'tmp/e2e-evaluations'),
            refuseExisting: false,
        });
    });

    it.each(['runs', 'evaluations'])(
        'refuses an output root that already holds a case directory before any case runs (%s)',
        async (directory) => {
            const root = temporaryRoot('golden-suite-collision-');
            const existingDirectory = join(root, directory, 'second');
            mkdirSync(existingDirectory, { recursive: true });
            const sentinelPath = join(existingDirectory, 'preserved.txt');
            writeFileSync(sentinelPath, 'previous output');
            const runLocalFix = vi.fn();

            await expect(
                runGoldenE2ESuite(
                    coreConfig,
                    {
                        series: testSeries(),
                        knowledgeBaseSha: 'b'.repeat(40),
                        caseNames: ['first', 'second'],
                        casesRoot: join(root, 'cases'),
                        outputRoot: join(root, 'runs'),
                        evaluationRoot: join(root, 'evaluations'),
                        refuseExistingCaseDirectories: true,
                    },
                    { runLocalFix },
                ),
            ).rejects.toThrow(existingDirectory);
            expect(runLocalFix).not.toHaveBeenCalled();
            expect(readFileSync(sentinelPath, 'utf8')).toBe('previous output');
            expect(existsSync(join(root, 'runs', 'first'))).toBe(false);
            expect(existsSync(join(root, 'evaluations', 'first'))).toBe(false);
        },
    );

    it('keeps two output roots apart', async () => {
        const root = temporaryRoot('golden-suite-independent-');
        const casesRoot = join(root, 'cases');
        const caseName = 'sample';
        writeRunSide(join(casesRoot, caseName));
        const runLocalFix = vi.fn(async (_config, options) =>
            writeLocalRunOutput(analysisOnlyRecord(), {
                outputDir: options.outputDir,
                workspaceRoot: process.cwd(),
            }),
        );
        const dependencies = {
            runLocalFix,
            assessAgentEnvironment: matchedAssessment(),
            loadHumanOracle: () => humanOracle,
            extractHumanFix: async () => humanFix,
            createJudgeProbe: () => async () => ({ status: 'verified' as const, detail: 'Works.' }),
        };
        const outputRoots = [join(root, 'first'), join(root, 'second')];
        for (const outputRoot of outputRoots) {
            const layout = goldenOutputLayout(root, outputRoot);
            const suite = await runGoldenE2ESuite(
                coreConfig,
                {
                    series: testSeries(),
                    knowledgeBaseSha: 'b'.repeat(40),
                    caseNames: [caseName],
                    casesRoot,
                    outputRoot: layout.outputRoot,
                    evaluationRoot: layout.evaluationRoot,
                    refuseExistingCaseDirectories: layout.refuseExisting,
                },
                dependencies,
            );
            expect(suite.results[0]!.result.status).toBe('agent_regression');
        }
        expect(runLocalFix).toHaveBeenCalledTimes(2);
        for (const outputRoot of outputRoots) {
            expect(
                JSON.parse(
                    readFileSync(join(outputRoot, 'runs', caseName, 'run-result.json'), 'utf8'),
                ) as LocalRunRecord,
            ).toMatchObject({ result: { runStatus: 'analysis_only' } });
            expect(
                JSON.parse(
                    readFileSync(
                        join(outputRoot, 'evaluations', caseName, 'e2e-result.json'),
                        'utf8',
                    ),
                ) as GoldenE2EResult,
            ).toMatchObject({ status: 'agent_regression' });
        }
    });

    it('runs selected cases sequentially and preserves exit-code severity 0/1/2/3', async () => {
        const casesRoot = temporaryRoot('golden-suite-cases-');
        const outputRoot = temporaryRoot('golden-suite-output-');
        const evaluationRoot = temporaryRoot('golden-suite-evaluation-');
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
                series: testSeries(),
                knowledgeBaseSha: 'b'.repeat(40),
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
                createJudgeProbe:
                    () =>
                    async ({ caseName }) =>
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
        expect(suite.exitCode).toBe(GoldenE2EExitCode.EnvironmentDrift);
        expect(existsSync(join(outputRoot, 'regression', 'e2e-result.json'))).toBe(false);
        expect(existsSync(join(evaluationRoot, 'regression', 'e2e-result.json'))).toBe(true);
    });

    it.each([
        ['without a price file', undefined, RunCostStatus.NoPricingFile],
        ['with the example price file', 'docs/examples/pricing.example.json', RunCostStatus.Priced],
    ])('reports each case cost %s', async (_label, pricingFile, expectedStatus) => {
        // The benchmark runs with any provider: without a price file the run still completes and
        // its cost line says the cost was not computed; with one, the case is priced from it.
        const casesRoot = temporaryRoot('golden-suite-cost-cases-');
        const outputRoot = temporaryRoot('golden-suite-cost-output-');
        const evaluationRoot = temporaryRoot('golden-suite-cost-evaluation-');
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
            {
                series: testSeries(),
                knowledgeBaseSha: 'b'.repeat(40),
                caseNames: ['priced'],
                casesRoot,
                outputRoot,
                evaluationRoot,
                pricingSnapshot,
            },
            {
                runLocalFix,
                assessAgentEnvironment: matchedAssessment(),
                loadHumanOracle: () => humanOracle,
                extractHumanFix: async () => humanFix,
                createJudgeProbe: () => async () => ({ status: 'verified', detail: 'Works.' }),
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
