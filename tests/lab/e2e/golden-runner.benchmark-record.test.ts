import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { GoldenE2EResult } from '../../../lab/e2e/golden-comparator';
import * as goldenComparator from '../../../lab/e2e/golden-comparator';
import { runGoldenE2ECase } from '../../../lab/e2e/golden-runner';

import {
    temporaryRoot,
    coreConfig,
    testSeries,
    humanOracle,
    humanFix,
    writeRunSide,
    lockedRun,
    matchedAssessment,
} from './golden-runner-fixtures';

describe('benchmark record output', () => {
    it.each(['missing', 'malformed'])(
        'propagates a %s closed oracle after an agent failure',
        async (scenario) => {
            const root = temporaryRoot('golden-broken-oracle-');
            const caseDirectory = join(root, 'case');
            writeRunSide(caseDirectory);
            if (scenario === 'malformed') {
                writeFileSync(join(caseDirectory, 'oracle.json'), '{');
            }

            await expect(
                runGoldenE2ECase(
                    coreConfig,
                    {
                        series: testSeries(),
                        knowledgeBaseSha: 'b'.repeat(40),
                        caseName: 'sample',
                        caseDirectory,
                        outputDirectory: join(root, 'run'),
                        evaluationDirectory: join(root, 'evaluation'),
                    },
                    {
                        runLocalFix: vi.fn(async () => {
                            throw new Error('Local preparation failed.');
                        }),
                    },
                ),
            ).rejects.toThrow();
            expect(existsSync(join(root, 'evaluation', 'benchmark-record.json'))).toBe(false);
        },
    );

    it.each([
        ['pass', 'verified', 5],
        ['agent_regression', 'verified', 1],
        ['environment_drift', 'not_verified', 1],
        ['infrastructure_failure', 'not_checked', 0],
    ] as const)('writes a benchmark record for %s', async (status, verdict, level) => {
        const root = temporaryRoot('golden-record-');
        const caseDirectory = join(root, 'case');
        const outputDirectory = join(root, 'run');
        const evaluationDirectory = join(root, 'evaluation');
        writeRunSide(caseDirectory);
        const classified = {
            status,
            exitCode: status === 'pass' ? 0 : status === 'environment_drift' ? 2 : 1,
            detail: 'Scripted classification.',
            actualRule: null,
            expectedRule: null,
            humanFixCommit: humanOracle.humanFixCommit,
            humanFixFirstParent: humanFix.firstParent,
            humanCandidate: null,
        } as GoldenE2EResult;
        const classify = vi
            .spyOn(goldenComparator, 'classifyGoldenResult')
            .mockResolvedValue(classified);
        let clock = 1_000;
        try {
            await runGoldenE2ECase(
                coreConfig,
                {
                    series: testSeries(),
                    knowledgeBaseSha: 'b'.repeat(40),
                    caseName: 'sample',
                    caseDirectory,
                    outputDirectory,
                    evaluationDirectory,
                },
                {
                    now: () => (clock += 1_000),
                    runLocalFix:
                        status === 'infrastructure_failure'
                            ? vi.fn(async () => {
                                  throw new Error('Local preparation failed.');
                              })
                            : lockedRun(outputDirectory),
                    assessAgentEnvironment: matchedAssessment(),
                    loadHumanOracle: () => humanOracle,
                    extractHumanFix: async () => humanFix,
                    createJudgeProbe: () => async () => ({
                        status: verdict === 'not_verified' ? 'not_verified' : 'verified',
                        detail: 'Scripted human judgement.',
                    }),
                },
            );
            const record = JSON.parse(
                readFileSync(join(evaluationDirectory, 'benchmark-record.json'), 'utf8'),
            );
            expect(record).toMatchObject({
                case: 'sample',
                human: { elapsedMs: 10_800_000 },
                outcome: {
                    status,
                    level,
                    humanFixVerdict: verdict,
                    verdictFromCache: false,
                    failureKind: status === 'infrastructure_failure' ? 'transient' : null,
                },
            });
            expect(record.timings.totalMs).toBeGreaterThan(0);
            expect(record.timings.evaluationMs).toBeGreaterThan(0);
        } finally {
            classify.mockRestore();
        }
    });
});
