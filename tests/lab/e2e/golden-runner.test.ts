import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GoldenE2EExitCode } from '../../../lab/e2e/golden-exit-code';
import { materializeLocalRunOutputDir } from '../../../src/local/output-directory';
import { writeLocalRunOutput } from '../../../src/local/run-output';
import { InfrastructureFailureReason } from '../../../src/types/infrastructure-failure-reason';
import { GoldenE2EStatus, GoldenOracleProbeStatus } from '../../../lab/e2e/golden-comparator';
import { GoldenRunSchemaVersion } from '../../../lab/e2e/golden-case';
import { runGoldenE2ECase } from '../../../lab/e2e/golden-runner';
import {
    temporaryRoot,
    coreConfig,
    testSeries,
    humanOracle,
    humanFix,
    writeRunSide,
    analysisOnlyRecord,
    lockedRun,
    localOutputPaths,
    matchedAssessment,
    mismatchedAssessment,
    evaluationDirectoryFor,
} from './golden-runner-fixtures';

describe('runGoldenE2ECase', () => {
    it('keeps the sealed failure detail when preparation stopped before the filters checkout', async () => {
        const root = temporaryRoot('golden-pre-checkout-failure-');
        const caseDirectory = join(root, 'case');
        const outputDirectory = join(root, 'run');
        const evaluationDirectory = join(root, 'evaluation');
        writeRunSide(caseDirectory);
        const record = analysisOnlyRecord();
        record.result.filtersBaseSha = null;
        record.result.infrastructureFailureReason =
            InfrastructureFailureReason.EnvironmentUnavailable;
        record.result.reasoning = 'Reporter extension download failed before filters checkout.';

        const result = await runGoldenE2ECase(
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
                runLocalFix: lockedRun(outputDirectory, undefined, record),
                loadHumanOracle: () => humanOracle,
                assessAgentEnvironment: matchedAssessment(),
            },
        );

        expect(result.status).toBe(GoldenE2EStatus.InfrastructureFailure);
        expect(
            JSON.parse(readFileSync(join(evaluationDirectory, 'e2e-result.json'), 'utf8')),
        ).toMatchObject({ detail: record.result.reasoning });
    });

    it('classifies a v2 case as infrastructure failure without running the agent', async () => {
        const root = temporaryRoot('golden-runner-v2-');
        const caseDirectory = join(root, 'case');
        mkdirSync(caseDirectory);
        writeRunSide(caseDirectory);
        writeFileSync(join(caseDirectory, 'oracle.json'), JSON.stringify(humanOracle));
        const run = JSON.parse(readFileSync(join(caseDirectory, 'run.json'), 'utf8'));
        delete run.extensionBuild;
        run.schemaVersion = GoldenRunSchemaVersion.Legacy;
        writeFileSync(join(caseDirectory, 'run.json'), JSON.stringify(run));
        const runLocalFix = vi.fn();

        const result = await runGoldenE2ECase(
            coreConfig,
            {
                series: testSeries(),
                knowledgeBaseSha: 'b'.repeat(40),
                caseName: 'legacy-case',
                caseDirectory,
                outputDirectory: join(root, 'run'),
                evaluationDirectory: join(root, 'evaluation'),
            },
            { runLocalFix },
        );

        expect(result).toMatchObject({
            status: GoldenE2EStatus.InfrastructureFailure,
            exitCode: GoldenE2EExitCode.InfrastructureFailure,
            detail: expect.stringMatching(/benchmark:case:check/),
        });
        expect(runLocalFix).not.toHaveBeenCalled();
    });

    it('does not clear a caller directory that lacks the ownership marker', async () => {
        const root = temporaryRoot('golden-runner-unowned-');
        const caseDirectory = join(root, 'case');
        const outputDirectory = join(root, 'run');
        const evaluationDirectory = join(root, 'evaluation');
        mkdirSync(caseDirectory);
        mkdirSync(outputDirectory);
        writeRunSide(caseDirectory);
        writeFileSync(join(outputDirectory, 'keep.txt'), 'keep', 'utf8');

        await expect(
            runGoldenE2ECase(coreConfig, {
                series: testSeries(),
                knowledgeBaseSha: 'b'.repeat(40),
                caseName: 'unowned-output',
                caseDirectory,
                outputDirectory,
                evaluationDirectory,
            }),
        ).rejects.toThrow(/not owned|nonempty/i);
        expect(readFileSync(join(outputDirectory, 'keep.txt'), 'utf8')).toBe('keep');
    });

    it('clears stale comparator evidence before starting a case', async () => {
        const caseDirectory = temporaryRoot('golden-runner-clean-');
        const outputDirectory = temporaryRoot('golden-output-clean-');
        const evaluationDirectory = evaluationDirectoryFor(outputDirectory);
        const staleOracleDirectory = join(evaluationDirectory, 'oracle');
        const staleClassificationPath = join(evaluationDirectory, 'e2e-result.json');
        writeRunSide(caseDirectory);
        writeFileSync(join(caseDirectory, 'oracle.json'), JSON.stringify(humanOracle));
        mkdirSync(evaluationDirectory);
        materializeLocalRunOutputDir(evaluationDirectory, process.cwd());
        mkdirSync(staleOracleDirectory);
        writeFileSync(join(staleOracleDirectory, 'stale.json'), '{}', 'utf8');
        writeFileSync(staleClassificationPath, '{"status":"pass"}', 'utf8');

        await runGoldenE2ECase(
            coreConfig,
            {
                series: testSeries(),
                knowledgeBaseSha: 'b'.repeat(40),
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
            status: GoldenE2EStatus.InfrastructureFailure,
            exitCode: GoldenE2EExitCode.InfrastructureFailure,
        });
    });

    it('starts a plugged-in module in the case run from a private workspace it removes after', async () => {
        const caseDirectory = temporaryRoot('golden-runner-module-');
        const outputDirectory = temporaryRoot('golden-output-module-');
        writeRunSide(caseDirectory);
        writeFileSync(join(caseDirectory, 'oracle.json'), JSON.stringify(humanOracle));
        const startBlocker = vi.fn();
        let moduleWorkspace = '';

        await runGoldenE2ECase(
            coreConfig,
            {
                series: testSeries(),
                knowledgeBaseSha: 'b'.repeat(40),
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
        const caseDirectory = temporaryRoot('golden-runner-invalid-input-');
        const outputDirectory = temporaryRoot('golden-output-invalid-input-');
        const evaluationDirectory = evaluationDirectoryFor(outputDirectory);
        const artifactsDirectory = join(outputDirectory, 'artifacts');
        materializeLocalRunOutputDir(outputDirectory, process.cwd());
        mkdirSync(artifactsDirectory);
        writeFileSync(join(caseDirectory, 'run.json'), '{"invalid":true}', 'utf8');
        writeFileSync(join(caseDirectory, 'oracle.json'), JSON.stringify(humanOracle));
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
            {
                series: testSeries(),
                knowledgeBaseSha: 'b'.repeat(40),
                caseName: 'invalid-input',
                caseDirectory,
                outputDirectory,
                evaluationDirectory,
            },
            { runLocalFix },
        );

        expect(result).toMatchObject({
            status: GoldenE2EStatus.InfrastructureFailure,
            exitCode: GoldenE2EExitCode.InfrastructureFailure,
        });
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

    it('reads only human timing metadata after locked-result validation fails', async () => {
        const caseDirectory = temporaryRoot('golden-runner-invalid-');
        const outputDirectory = temporaryRoot('golden-output-invalid-');
        const evaluationDirectory = evaluationDirectoryFor(outputDirectory);
        writeRunSide(caseDirectory);
        const loadHumanOracle = vi.fn(() => humanOracle);
        const extractHumanFix = vi.fn(async () => humanFix);

        const result = await runGoldenE2ECase(
            coreConfig,
            {
                series: testSeries(),
                knowledgeBaseSha: 'b'.repeat(40),
                caseName: 'invalid-result',
                caseDirectory,
                outputDirectory,
                evaluationDirectory,
            },
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

        expect(result).toMatchObject({
            status: GoldenE2EStatus.InfrastructureFailure,
            exitCode: GoldenE2EExitCode.InfrastructureFailure,
        });
        expect(loadHumanOracle).toHaveBeenCalledExactlyOnceWith(realpathSync(caseDirectory));
        expect(extractHumanFix).not.toHaveBeenCalled();
        expect(
            JSON.parse(readFileSync(join(evaluationDirectory, 'benchmark-record.json'), 'utf8')),
        ).toMatchObject({
            human: { elapsedMs: 10_800_000 },
            outcome: { level: 0, humanFixVerdict: 'not_checked' },
        });
    });

    it('does not evaluate the human fix for a locked result from a different case', async () => {
        const caseDirectory = temporaryRoot('golden-runner-wrong-case-');
        const outputDirectory = temporaryRoot('golden-output-wrong-case-');
        const evaluationDirectory = evaluationDirectoryFor(outputDirectory);
        writeRunSide(caseDirectory);
        const record = analysisOnlyRecord();
        record.result.issueNumber = 999;
        const loadHumanOracle = vi.fn(() => humanOracle);
        const extractHumanFix = vi.fn();

        const result = await runGoldenE2ECase(
            coreConfig,
            {
                series: testSeries(),
                knowledgeBaseSha: 'b'.repeat(40),
                caseName: 'wrong-case',
                caseDirectory,
                outputDirectory,
                evaluationDirectory,
            },
            {
                runLocalFix: lockedRun(outputDirectory, undefined, record),
                loadHumanOracle,
                extractHumanFix,
            },
        );

        expect(result).toMatchObject({
            status: GoldenE2EStatus.InfrastructureFailure,
            exitCode: GoldenE2EExitCode.InfrastructureFailure,
            detail: expect.stringMatching(/issue.*selected golden case/i),
        });
        expect(loadHumanOracle).toHaveBeenCalledExactlyOnceWith(realpathSync(caseDirectory));
        expect(extractHumanFix).not.toHaveBeenCalled();
    });

    it('loads and extracts the human fix only after run-result.json is locked and validated', async () => {
        const caseDirectory = temporaryRoot('golden-runner-order-');
        const outputDirectory = temporaryRoot('golden-output-order-');
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
            {
                series: testSeries(),
                knowledgeBaseSha: 'b'.repeat(40),
                caseName: 'ordered',
                caseDirectory,
                outputDirectory,
                evaluationDirectory,
            },
            {
                runLocalFix: lockedRun(outputDirectory, events),
                assessAgentEnvironment: matchedAssessment(),
                loadHumanOracle,
                extractHumanFix,
                createJudgeProbe: () => async (context) => {
                    expect(context).not.toHaveProperty('humanFixCommit');
                    expect(context).not.toHaveProperty('record');
                    expect(context.candidate.rule).toBe('nettg.pl##.banner');
                    expect(context.outputDirectory).toBe(realpathSync(evaluationDirectory));
                    return { status: 'verified', detail: 'Human rule independently verified.' };
                },
            },
        );

        expect(events).toEqual(['run', 'oracle', 'diff']);
        expect(result).toMatchObject({
            status: GoldenE2EStatus.AgentRegression,
            exitCode: GoldenE2EExitCode.AgentRegression,
        });
        expect(
            JSON.parse(readFileSync(join(evaluationDirectory, 'e2e-result.json'), 'utf8')),
        ).toEqual(result);
        expect(existsSync(join(outputDirectory, 'e2e-result.json'))).toBe(false);
    });

    it('rejects a coherently replaced locked run after oracle evaluation', async () => {
        const caseDirectory = temporaryRoot('golden-runner-replaced-run-');
        const outputDirectory = temporaryRoot('golden-output-replaced-run-');
        const evaluationDirectory = evaluationDirectoryFor(outputDirectory);
        writeRunSide(caseDirectory);

        const result = await runGoldenE2ECase(
            coreConfig,
            {
                series: testSeries(),
                knowledgeBaseSha: 'b'.repeat(40),
                caseName: 'replaced-run',
                caseDirectory,
                outputDirectory,
                evaluationDirectory,
            },
            {
                runLocalFix: lockedRun(outputDirectory),
                assessAgentEnvironment: matchedAssessment(),
                loadHumanOracle: () => humanOracle,
                extractHumanFix: async () => humanFix,
                createJudgeProbe: () => async () => {
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
            status: GoldenE2EStatus.InfrastructureFailure,
            exitCode: GoldenE2EExitCode.InfrastructureFailure,
            detail: expect.stringMatching(/changed.*oracle evaluation/i),
        });
    });

    it('reads the canonical run result instead of a path returned by an injected runner', async () => {
        const root = temporaryRoot('golden-runner-returned-path-');
        const caseDirectory = join(root, 'case');
        const outputDirectory = join(root, 'run');
        const evaluationDirectory = join(root, 'evaluation');
        const foreignResultPath = join(root, 'foreign-result.json');
        mkdirSync(caseDirectory);
        writeRunSide(caseDirectory);
        writeFileSync(foreignResultPath, '{"untrusted":true}', 'utf8');

        const result = await runGoldenE2ECase(
            coreConfig,
            {
                series: testSeries(),
                knowledgeBaseSha: 'b'.repeat(40),
                caseName: 'returned-path',
                caseDirectory,
                outputDirectory,
                evaluationDirectory,
            },
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
                createJudgeProbe: () => async () => ({
                    status: 'verified',
                    detail: 'Human rule independently verified.',
                }),
            },
        );

        expect(result).toMatchObject({
            status: GoldenE2EStatus.AgentRegression,
            exitCode: GoldenE2EExitCode.AgentRegression,
        });
    });

    it('atomically replaces an evaluator result symlink without changing its target', async () => {
        const root = temporaryRoot('golden-runner-result-symlink-');
        const caseDirectory = join(root, 'case');
        const outputDirectory = join(root, 'run');
        const evaluationDirectory = join(root, 'evaluation');
        const sentinelPath = join(root, 'sentinel.json');
        mkdirSync(caseDirectory);
        writeRunSide(caseDirectory);
        writeFileSync(sentinelPath, '{"sentinel":true}\n', 'utf8');

        const result = await runGoldenE2ECase(
            coreConfig,
            {
                series: testSeries(),
                knowledgeBaseSha: 'b'.repeat(40),
                caseName: 'safe-result',
                caseDirectory,
                outputDirectory,
                evaluationDirectory,
            },
            {
                runLocalFix: lockedRun(outputDirectory),
                assessAgentEnvironment: matchedAssessment(),
                loadHumanOracle: () => humanOracle,
                extractHumanFix: async () => humanFix,
                createJudgeProbe: () => async () => {
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
        const root = temporaryRoot('golden-runner-case-alias-');
        const caseDirectory = join(root, 'case');
        const outputLink = join(root, 'run-link');
        const evaluationDirectory = join(root, 'evaluation');
        mkdirSync(caseDirectory);
        writeRunSide(caseDirectory);
        writeFileSync(join(caseDirectory, 'sentinel.txt'), 'tracked', 'utf8');
        symlinkSync(caseDirectory, outputLink, 'dir');

        await expect(
            runGoldenE2ECase(coreConfig, {
                series: testSeries(),
                knowledgeBaseSha: 'b'.repeat(40),
                caseName: 'case-alias',
                caseDirectory,
                outputDirectory: outputLink,
                evaluationDirectory,
            }),
        ).rejects.toThrow(/mutually separate/u);
        expect(readFileSync(join(caseDirectory, 'sentinel.txt'), 'utf8')).toBe('tracked');
    });

    it('rejects agent and evaluator directories that resolve to the same location', async () => {
        const root = temporaryRoot('golden-runner-output-alias-');
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
                series: testSeries(),
                knowledgeBaseSha: 'b'.repeat(40),
                caseName: 'output-alias',
                caseDirectory,
                outputDirectory,
                evaluationDirectory: evaluationLink,
            }),
        ).rejects.toThrow(/mutually separate/u);
        expect(readFileSync(join(outputDirectory, 'sentinel.txt'), 'utf8')).toBe('run');
    });

    it('classifies missing reporter-session evidence as regression without running the oracle browser', async () => {
        const caseDirectory = temporaryRoot('golden-runner-environment-');
        const outputDirectory = temporaryRoot('golden-output-environment-');
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
                series: testSeries(),
                knowledgeBaseSha: 'b'.repeat(40),
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
                createJudgeProbe: () => probeHumanCandidate,
            },
        );

        expect(result).toMatchObject({
            status: 'agent_regression',
            exitCode: GoldenE2EExitCode.AgentRegression,
            detail: expect.stringMatching(/reporter environment mismatch/i),
        });
        expect(extractHumanFix).not.toHaveBeenCalled();
        expect(probeHumanCandidate).not.toHaveBeenCalled();
    });

    it('uses the oracle to classify target navigation exhaustion as infrastructure', async () => {
        const caseDirectory = temporaryRoot('golden-runner-browser-failure-');
        const outputDirectory = temporaryRoot('golden-output-browser-failure-');
        const evaluationDirectory = evaluationDirectoryFor(outputDirectory);
        writeRunSide(caseDirectory);
        const record = analysisOnlyRecord();
        record.result.effectiveMode = 'reasoning';
        record.result.verificationStatus = 'unavailable';
        record.result.symptomObservation = 'indeterminate';
        record.result.reasoning = 'Every live navigation timed out before browser evidence.';
        const extractHumanFix = vi.fn(async () => humanFix);
        const probeHumanCandidate = vi.fn(async () => ({
            status: GoldenOracleProbeStatus.InfrastructureFailure,
            detail: 'The target site remained unreachable after three independent sessions.',
        }));

        const result = await runGoldenE2ECase(
            coreConfig,
            {
                series: testSeries(),
                knowledgeBaseSha: 'b'.repeat(40),
                caseName: 'browser-failure',
                caseDirectory,
                outputDirectory,
                evaluationDirectory,
            },
            {
                runLocalFix: lockedRun(outputDirectory, undefined, record),
                assessAgentEnvironment: matchedAssessment(),
                loadHumanOracle: () => humanOracle,
                extractHumanFix,
                createJudgeProbe: () => probeHumanCandidate,
            },
        );

        expect(result).toMatchObject({
            status: GoldenE2EStatus.InfrastructureFailure,
            exitCode: GoldenE2EExitCode.InfrastructureFailure,
            detail: expect.stringMatching(/target site remained unreachable/i),
        });
        expect(extractHumanFix).toHaveBeenCalledOnce();
        expect(probeHumanCandidate).toHaveBeenCalledOnce();
    });
});
