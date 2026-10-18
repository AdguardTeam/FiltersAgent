import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BenchmarkCaseStatus } from '../../../lab/e2e/benchmark-outcome';
import { runGoldenE2ECase } from '../../../lab/e2e/golden-runner';
import {
    analysisOnlyRecord,
    caseOptions,
    coreConfig,
    humanOracle,
    lockedRun,
    offline,
    temporaryRoot,
    writeRunSide,
} from './golden-runner-fixtures';

describe('benchmark record output', () => {
    it('writes an unverified rule beside the human fix for the comparison after a series', async () => {
        const root = temporaryRoot('golden-record-');
        const caseDirectory = join(root, 'case');
        const outputDirectory = join(root, 'run');
        const evaluationDirectory = join(root, 'evaluation');
        writeRunSide(caseDirectory);
        const sealed = analysisOnlyRecord();
        sealed.result.candidateForReview = {
            rule: 'nettg.pl##.ad-slot',
            placement: { filePath: 'BaseFilter/sections/foreign.txt' },
            unverifiedReason: 'The visual review found the banner still visible.',
        };
        let clock = 1_000;

        await runGoldenE2ECase(
            coreConfig,
            caseOptions({
                caseName: 'sample',
                caseDirectory,
                outputDirectory,
                evaluationDirectory,
            }),
            offline({
                now: () => (clock += 1_000),
                runLocalFix: lockedRun(outputDirectory, undefined, sealed),
            }),
        );

        const record = JSON.parse(
            readFileSync(join(evaluationDirectory, 'benchmark-record.json'), 'utf8'),
        );
        expect(record).toMatchObject({
            schemaVersion: 2,
            case: 'sample',
            outcome: {
                status: BenchmarkCaseStatus.Proposed,
                failureKind: null,
                candidate: null,
                candidateForReview: sealed.result.candidateForReview,
            },
            human: { fixCommit: humanOracle.humanFixCommit, elapsedMs: 10_800_000 },
        });
        expect(record.timings.totalMs).toBeGreaterThan(0);
        expect(record.timings.evaluationMs).toBeGreaterThan(0);
    });
});
