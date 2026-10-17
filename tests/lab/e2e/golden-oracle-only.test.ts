import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoldenE2EExitCode } from '../../../lab/e2e/golden-exit-code';
import { materializeLocalRunOutputDir } from '../../../src/local/output-directory';
import type { Report } from '../../../src/intake/report';
import { GoldenOracleProbeStatus } from '../../../lab/e2e/golden-comparator';
import {
    formatGoldenOracleOnlyLine,
    runGoldenOracleSuite,
} from '../../../lab/e2e/golden-oracle-only';
import type { GoldenJudgeSeries } from '../../../lab/e2e/golden-runner';
import { testCoreConfig } from '../../config/test-core-config';

const roots: string[] = [];
const build = { version: '5.4.3.99', releaseTag: 'v5.4.3.1', autobuildCommit: 'a'.repeat(40) };
const humanFix = {
    commit: 'b'.repeat(40),
    firstParent: 'c'.repeat(40),
    candidates: [
        {
            rule: 'example.com##.banner',
            sourceRule: 'example.com##.banner',
            syntaxKind: 'element_hiding' as const,
            filePath: 'BaseFilter/sections/specific.txt',
            repositoryEdit: 'insert' as const,
        },
    ],
};
const report: Report = {
    siteUrls: ['https://example.com/'],
    problemType: 'ads',
    screenshots: [],
    environment: { product: 'AdGuard Browser Extension' },
    enabledLists: [],
    settingsImportUrl:
        'https://reports.adguard.com/settings/import.html?' +
        'product_version=5.4.3.99&ext.manifest_version=3&regular_filters=2&stealth.enabled=0',
    userRules: [],
    reproductionSteps: [],
};

function fixture(caseNames: string[]) {
    const root = mkdtempSync(join(tmpdir(), 'oracle-only-'));
    roots.push(root);
    for (const caseName of caseNames) {
        const directory = join(root, 'cases', caseName);
        mkdirSync(join(directory, 'issue'), { recursive: true });
        writeFileSync(
            join(directory, 'run.json'),
            JSON.stringify({
                schemaVersion: 3,
                issueNumber: 1,
                issueFile: 'issue/issue.json',
                filtersBaseSha: 'c'.repeat(40),
                extensionBuild: build,
            }),
        );
        writeFileSync(
            join(directory, 'oracle.json'),
            JSON.stringify({
                humanFixCommit: humanFix.commit,
                issueCreatedAt: '2026-07-14T06:08:12Z',
                fixCommittedAt: '2026-07-14T09:08:12Z',
            }),
        );
        writeFileSync(
            join(directory, 'issue', 'issue.json'),
            JSON.stringify({
                schemaVersion: 1,
                rawIssue: {
                    number: 1,
                    url: 'https://github.com/example-owner/example-repo/issues/1',
                    title: 'example.com',
                    body: 'Banner',
                    state: 'closed',
                    labels: [],
                    assignee: null,
                    comments: [],
                },
                reporterComments: [],
                attachments: [],
            }),
        );
    }
    const series: GoldenJudgeSeries = {
        judgeConfig: testCoreConfig({ llm: { model: 'example-judge-model' } }),
        judgeCacheRoot: join(root, 'cache'),
        refreshJudgeCache: false,
    };
    return { caseNames, casesRoot: join(root, 'cases'), oracleRoot: join(root, 'oracle'), series };
}

function dependencies(
    status: (typeof GoldenOracleProbeStatus)[keyof typeof GoldenOracleProbeStatus],
) {
    return {
        bindJudgeExtractReport: vi.fn(() => async () => report),
        extractHumanFix: vi.fn(async () => humanFix),
        createJudgeProbe: vi.fn(() => vi.fn(async () => ({ status, detail: 'Probe detail.' }))),
    };
}

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('runGoldenOracleSuite', () => {
    it('reports alive, drift and failure with exit codes 0, 2 and 3', async () => {
        const options = fixture(['alive-case', 'drift-case', 'failed-case']);
        const expected = [
            [GoldenOracleProbeStatus.Verified, 0, 'alive (example.com##.banner)'],
            [
                GoldenOracleProbeStatus.NotVerified,
                2,
                'environment_drift (No human commit candidate still fixes the reporter-visible ' +
                    'defect: Probe detail.)',
            ],
            [
                GoldenOracleProbeStatus.InfrastructureFailure,
                3,
                'infrastructure_failure (Probe detail.)',
            ],
        ] as const;
        const entries = [];
        for (const [index, [status, exitCode, line]] of expected.entries()) {
            const caseName = options.caseNames[index]!;
            const result = await runGoldenOracleSuite(
                { ...options, caseNames: [caseName] },
                dependencies(status),
            );
            expect(result.exitCode).toBe(exitCode);
            const entry = result.results[0]!.result;
            expect(formatGoldenOracleOnlyLine(caseName, entry)).toBe(`${caseName}: ${line}`);
            entries.push(result.results[0]!);
        }
        const probe = vi.fn(async (context) => ({
            status:
                context.caseName === 'alive-case'
                    ? GoldenOracleProbeStatus.Verified
                    : context.caseName === 'drift-case'
                      ? GoldenOracleProbeStatus.NotVerified
                      : GoldenOracleProbeStatus.InfrastructureFailure,
            detail: 'Probe detail.',
        }));
        const suite = await runGoldenOracleSuite(
            { ...options, series: { ...options.series, refreshJudgeCache: true } },
            {
                ...dependencies(GoldenOracleProbeStatus.Verified),
                createJudgeProbe: () => probe,
            },
        );
        expect(suite.results).toEqual(entries);
        expect(suite.exitCode).toBe(GoldenE2EExitCode.InfrastructureFailure);
    });

    it.each([GoldenOracleProbeStatus.Verified, GoldenOracleProbeStatus.NotVerified])(
        'marks cached %s verdicts and preserves evidence until a live probe starts',
        async (status) => {
            const options = fixture(['example-case']);
            const directory = join(options.oracleRoot, 'example-case');
            materializeLocalRunOutputDir(directory, process.cwd());
            writeFileSync(join(directory, 'stale.txt'), 'stale evidence');
            const evidence = join(directory, 'oracle', 'evidence.txt');
            let staleEvidencePresentDuringProbe: boolean | undefined;
            const probe = vi.fn(async () => {
                staleEvidencePresentDuringProbe = existsSync(join(directory, 'stale.txt'));
                mkdirSync(join(directory, 'oracle'), { recursive: true });
                writeFileSync(evidence, 'live evidence');
                return { status, detail: 'The live probe rationale.' };
            });
            const seams = { ...dependencies(status), createJudgeProbe: () => probe };
            const live = await runGoldenOracleSuite(options, seams);
            expect(staleEvidencePresentDuringProbe).toBe(false);
            expect(live.results[0]!.result.fromCache).toBe(false);
            const cached = await runGoldenOracleSuite(options, seams);
            expect(cached.results[0]!.result.fromCache).toBe(true);
            expect(probe).toHaveBeenCalledOnce();
            expect(readFileSync(evidence, 'utf8')).toBe('live evidence');
            const line = formatGoldenOracleOnlyLine('example-case', cached.results[0]!.result);
            expect(line).toBe(
                `${formatGoldenOracleOnlyLine('example-case', live.results[0]!.result)} (cached)`,
            );
            if (status === GoldenOracleProbeStatus.NotVerified) {
                expect(line).toContain('The live probe rationale.');
            }
        },
    );

    it('probes with the run.json extension build and no locked digest', async () => {
        const options = fixture(['example-case']);
        const probe = vi.fn(async () => ({
            status: GoldenOracleProbeStatus.Verified,
            detail: 'Works.',
        }));
        await runGoldenOracleSuite(options, {
            ...dependencies(GoldenOracleProbeStatus.Verified),
            createJudgeProbe: () => probe,
        });
        expect(probe).toHaveBeenCalledWith(
            expect.objectContaining({ extensionBuild: build, expectedReleaseSha256: null }),
        );
    });

    it('reports an exception without preventing later cases', async () => {
        const options = fixture(['failed-case', 'alive-case']);
        const seams = dependencies(GoldenOracleProbeStatus.Verified);
        seams.extractHumanFix.mockRejectedValueOnce(new Error('Cannot read human commit.'));
        const suite = await runGoldenOracleSuite(options, seams);
        expect(suite.exitCode).toBe(GoldenE2EExitCode.InfrastructureFailure);
        expect(suite.results[0]!.result.detail).toBe('Cannot read human commit.');
        expect(suite.results[1]!.result.status).toBe('alive');
    });
});
