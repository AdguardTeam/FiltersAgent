import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { BenchmarkCaseStatus, BenchmarkFailureKind } from '../../../lab/e2e/benchmark-outcome';
import type { BenchmarkRecord } from '../../../lab/e2e/benchmark-record';
import { GoldenAgentEnvironmentStatus } from '../../../lab/e2e/golden-agent-environment';
import { GoldenRunSchemaVersion } from '../../../lab/e2e/golden-case';
import { runGoldenE2ECase } from '../../../lab/e2e/golden-runner';
import { materializeLocalRunOutputDir } from '../../../src/local/output-directory';
import { writeLocalRunOutput } from '../../../src/local/run-output';
import { InfrastructureFailureReason } from '../../../src/types/infrastructure-failure-reason';
import {
    analysisOnlyRecord,
    caseOptions,
    coreConfig,
    humanFix,
    humanOracle,
    localOutputPaths,
    lockedRun,
    offline,
    temporaryRoot,
    writeRunSide,
} from './golden-runner-fixtures';

/**
 * Read the record the runner wrote for a case.
 *
 * @param evaluationDirectory - Evaluation directory of the case.
 * @returns Persisted benchmark record.
 */
function savedRecord(evaluationDirectory: string): BenchmarkRecord {
    return JSON.parse(
        readFileSync(join(evaluationDirectory, 'benchmark-record.json'), 'utf8'),
    ) as BenchmarkRecord;
}

/**
 * Lay out a case with its oracle and separate run and evaluation directories.
 *
 * @param prefix - Temporary directory name prefix.
 * @returns Case, run and evaluation directories.
 */
function caseLayout(prefix: string): {
    /**
     * Tracked case directory.
     */
    caseDirectory: string;
    /**
     * Agent run directory.
     */
    outputDirectory: string;
    /**
     * Benchmark record directory.
     */
    evaluationDirectory: string;
} {
    const root = temporaryRoot(prefix);
    const caseDirectory = join(root, 'case');
    writeRunSide(caseDirectory);
    writeFileSync(join(caseDirectory, 'oracle.json'), JSON.stringify(humanOracle));
    return {
        caseDirectory,
        outputDirectory: join(root, 'run'),
        evaluationDirectory: join(root, 'evaluation'),
    };
}

describe('runGoldenE2ECase', () => {
    it('does not start the agent on a case whose site did not answer', async () => {
        const layout = caseLayout('golden-runner-offline-site-');
        const runLocalFix = vi.fn();
        const probeSite = vi.fn(async () => ({
            reachable: false,
            answer: 'fetch failed: ENOTFOUND',
        }));

        const record = await runGoldenE2ECase(
            coreConfig,
            caseOptions({ caseName: 'offline-site', ...layout }),
            offline({ runLocalFix, probeSite }),
        );

        expect(probeSite).toHaveBeenCalledExactlyOnceWith('https://nettg.pl/');
        expect(runLocalFix).not.toHaveBeenCalled();
        expect(record.outcome).toMatchObject({
            status: BenchmarkCaseStatus.SiteUnreachable,
            failureKind: null,
            detail: expect.stringMatching(/nettg\.pl.*ENOTFOUND/u),
            reporterEnvironment: null,
            candidate: null,
            candidateForReview: null,
        });
        expect(record.site).toEqual({
            url: 'https://nettg.pl/',
            reachable: false,
            answer: 'fetch failed: ENOTFOUND',
        });
        expect(record.usage).toMatchObject({ costUsd: null, requests: null });
        expect(record.human.rules).toEqual(humanFix.candidates);
        expect(savedRecord(layout.evaluationDirectory)).toEqual(record);
    });

    it('scores a case by the agent result and records the human rule beside it', async () => {
        const layout = caseLayout('golden-runner-scored-');

        const record = await runGoldenE2ECase(
            coreConfig,
            caseOptions({ caseName: 'scored', ...layout }),
            offline({ runLocalFix: lockedRun(layout.outputDirectory) }),
        );

        expect(record.outcome).toMatchObject({
            status: BenchmarkCaseStatus.Reproduced,
            failureKind: null,
            detail: null,
            reporterEnvironment: { status: GoldenAgentEnvironmentStatus.Matched },
            candidate: null,
        });
        expect(record.site).toEqual({
            url: 'https://nettg.pl/',
            reachable: true,
            answer: 'HTTP 200',
        });
        expect(record.human).toMatchObject({
            fixCommit: humanOracle.humanFixCommit,
            firstParent: humanFix.firstParent,
            rules: humanFix.candidates,
            rulesError: null,
            elapsedMs: 10_800_000,
        });
    });

    it('keeps the agent outcome when its verified session used other filters than the reporter', async () => {
        const layout = caseLayout('golden-runner-environment-');
        const sealed = analysisOnlyRecord();
        sealed.result.settingsEvidence!.enabledListKeys = ['adguard:2'];

        const record = await runGoldenE2ECase(
            coreConfig,
            caseOptions({ caseName: 'environment-mismatch', ...layout }),
            offline({ runLocalFix: lockedRun(layout.outputDirectory, undefined, sealed) }),
        );

        expect(record.outcome).toMatchObject({
            status: BenchmarkCaseStatus.Reproduced,
            reporterEnvironment: {
                status: GoldenAgentEnvironmentStatus.AgentMismatch,
                detail: expect.stringMatching(/enabled filter ids/i),
            },
        });
    });

    it('records a human commit that could not be read without failing the case', async () => {
        const layout = caseLayout('golden-runner-human-read-');

        const record = await runGoldenE2ECase(
            coreConfig,
            caseOptions({ caseName: 'human-read', ...layout }),
            offline({
                runLocalFix: lockedRun(layout.outputDirectory),
                extractHumanFix: async () => {
                    throw new Error('git fetch failed with exit code 128: network unreachable');
                },
            }),
        );

        expect(record.outcome.status).toBe(BenchmarkCaseStatus.Reproduced);
        expect(record.human).toMatchObject({
            firstParent: null,
            rules: null,
            removedRules: null,
            rulesError: expect.stringMatching(/network unreachable/u),
        });
    });

    it('fails a case whose report names no page to check before the run', async () => {
        const layout = caseLayout('golden-runner-no-url-');
        const issuePath = join(layout.caseDirectory, 'issue', 'issue.json');
        const issue = JSON.parse(readFileSync(issuePath, 'utf8')) as {
            rawIssue: { body: string };
        };
        issue.rawIssue.body = issue.rawIssue.body.replace('### Issue URL (Ads)', '### Page');
        writeFileSync(issuePath, JSON.stringify(issue), 'utf8');
        const runLocalFix = vi.fn();

        const record = await runGoldenE2ECase(
            coreConfig,
            caseOptions({ caseName: 'no-url', ...layout }),
            offline({ runLocalFix }),
        );

        expect(runLocalFix).not.toHaveBeenCalled();
        expect(record.outcome).toMatchObject({
            status: BenchmarkCaseStatus.InfrastructureFailure,
            detail: expect.stringMatching(/Issue URL/u),
        });
    });

    it('keeps the sealed failure detail when preparation stopped before the filters checkout', async () => {
        const layout = caseLayout('golden-pre-checkout-failure-');
        const sealed = analysisOnlyRecord();
        sealed.result.filtersBaseSha = null;
        sealed.result.infrastructureFailureReason =
            InfrastructureFailureReason.EnvironmentUnavailable;
        sealed.result.reasoning = 'Reporter extension download failed before filters checkout.';

        const record = await runGoldenE2ECase(
            coreConfig,
            caseOptions({ caseName: 'sample', ...layout }),
            offline({ runLocalFix: lockedRun(layout.outputDirectory, undefined, sealed) }),
        );

        expect(record.outcome).toMatchObject({
            status: BenchmarkCaseStatus.InfrastructureFailure,
            failureKind: BenchmarkFailureKind.Transient,
            detail: sealed.result.reasoning,
        });
    });

    it('classifies a legacy case as infrastructure failure without running the agent', async () => {
        const layout = caseLayout('golden-runner-legacy-');
        const runPath = join(layout.caseDirectory, 'run.json');
        const run = JSON.parse(readFileSync(runPath, 'utf8'));
        delete run.extensionBuild;
        run.schemaVersion = GoldenRunSchemaVersion.Legacy;
        writeFileSync(runPath, JSON.stringify(run));
        const runLocalFix = vi.fn();

        const record = await runGoldenE2ECase(
            coreConfig,
            caseOptions({ caseName: 'legacy-case', ...layout }),
            offline({ runLocalFix }),
        );

        expect(record.outcome).toMatchObject({
            status: BenchmarkCaseStatus.InfrastructureFailure,
            detail: expect.stringMatching(/benchmark:case:check/),
        });
        expect(runLocalFix).not.toHaveBeenCalled();
    });

    it('does not clear a caller directory that lacks the ownership marker', async () => {
        const layout = caseLayout('golden-runner-unowned-');
        mkdirSync(layout.outputDirectory);
        writeFileSync(join(layout.outputDirectory, 'keep.txt'), 'keep', 'utf8');

        await expect(
            runGoldenE2ECase(
                coreConfig,
                caseOptions({ caseName: 'unowned-output', ...layout }),
                offline(),
            ),
        ).rejects.toThrow(/not owned|nonempty/i);
        expect(readFileSync(join(layout.outputDirectory, 'keep.txt'), 'utf8')).toBe('keep');
    });

    it('clears stale evaluation evidence before starting a case', async () => {
        const layout = caseLayout('golden-runner-clean-');
        const staleDirectory = join(layout.evaluationDirectory, 'oracle');
        const staleRecordPath = join(layout.evaluationDirectory, 'benchmark-record.json');
        mkdirSync(layout.evaluationDirectory);
        materializeLocalRunOutputDir(layout.evaluationDirectory, process.cwd());
        mkdirSync(staleDirectory);
        writeFileSync(join(staleDirectory, 'stale.json'), '{}', 'utf8');
        writeFileSync(staleRecordPath, '{"stale":true}', 'utf8');

        await runGoldenE2ECase(
            coreConfig,
            caseOptions({ caseName: 'clean-output', ...layout }),
            offline({
                runLocalFix: vi.fn(async () => {
                    expect(existsSync(staleDirectory)).toBe(false);
                    expect(existsSync(staleRecordPath)).toBe(false);
                    const resultPath = join(layout.outputDirectory, 'result.json');
                    writeFileSync(resultPath, '{"invalid":true}', 'utf8');
                    return localOutputPaths(layout.outputDirectory, resultPath);
                }),
            }),
        );

        expect(existsSync(staleDirectory)).toBe(false);
        expect(savedRecord(layout.evaluationDirectory).outcome.status).toBe(
            BenchmarkCaseStatus.InfrastructureFailure,
        );
    });

    it('clears all prior owned run output before validating the next case input', async () => {
        const layout = caseLayout('golden-runner-invalid-input-');
        const artifactsDirectory = join(layout.outputDirectory, 'artifacts');
        mkdirSync(layout.outputDirectory);
        materializeLocalRunOutputDir(layout.outputDirectory, process.cwd());
        mkdirSync(artifactsDirectory);
        writeFileSync(join(layout.caseDirectory, 'run.json'), '{"invalid":true}', 'utf8');
        const staleNames = [
            'agent-report.md',
            'agent-decision.json',
            'agent-observations.json',
            'agent-run-manifest.json',
            'run-result.json',
            'report.md',
            'result.json',
            'candidate.patch',
        ];
        for (const name of staleNames) {
            writeFileSync(join(layout.outputDirectory, name), 'stale', 'utf8');
        }
        writeFileSync(join(artifactsDirectory, 'stale.json'), '{}', 'utf8');
        const runLocalFix = vi.fn();

        const record = await runGoldenE2ECase(
            coreConfig,
            caseOptions({ caseName: 'invalid-input', ...layout }),
            offline({ runLocalFix }),
        );

        expect(record.outcome.status).toBe(BenchmarkCaseStatus.InfrastructureFailure);
        expect(runLocalFix).not.toHaveBeenCalled();
        for (const name of staleNames) {
            expect(existsSync(join(layout.outputDirectory, name))).toBe(false);
        }
        expect(existsSync(artifactsDirectory)).toBe(false);
    });

    it('records an unreadable run result as infrastructure failure and logs its stack', async () => {
        const layout = caseLayout('golden-runner-invalid-');
        const lines: string[] = [];
        const logger = pino({}, { write: (line: string) => lines.push(line) });

        const record = await runGoldenE2ECase(
            coreConfig,
            caseOptions({ caseName: 'invalid-result', ...layout }),
            offline({
                logger,
                runLocalFix: vi.fn(async () => {
                    const resultPath = join(layout.outputDirectory, 'run-result.json');
                    writeFileSync(resultPath, '{"not":"a local run record"}', 'utf8');
                    return localOutputPaths(layout.outputDirectory, resultPath);
                }),
            }),
        );

        expect(record.outcome).toMatchObject({
            status: BenchmarkCaseStatus.InfrastructureFailure,
            failureKind: BenchmarkFailureKind.Transient,
            reporterEnvironment: null,
        });
        expect(record.human).toMatchObject({ elapsedMs: 10_800_000, rules: humanFix.candidates });
        const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(logged).toEqual([
            expect.objectContaining({
                caseName: 'invalid-result',
                err: expect.objectContaining({ stack: expect.stringMatching(/\n\s+at /u) }),
            }),
        ]);
    });

    it('refuses a locked result from a different case', async () => {
        const layout = caseLayout('golden-runner-wrong-case-');
        const sealed = analysisOnlyRecord();
        sealed.result.issueNumber = 999;

        const record = await runGoldenE2ECase(
            coreConfig,
            caseOptions({ caseName: 'wrong-case', ...layout }),
            offline({ runLocalFix: lockedRun(layout.outputDirectory, undefined, sealed) }),
        );

        expect(record.outcome).toMatchObject({
            status: BenchmarkCaseStatus.InfrastructureFailure,
            detail: expect.stringMatching(/issue.*selected golden case/i),
        });
    });

    it('reads the human fix only after the agent run seals', async () => {
        const layout = caseLayout('golden-runner-order-');
        const events: string[] = [];

        await runGoldenE2ECase(
            coreConfig,
            caseOptions({ caseName: 'ordered', ...layout }),
            offline({
                probeSite: async () => {
                    events.push('site');
                    return { reachable: true, answer: 'HTTP 200' };
                },
                runLocalFix: lockedRun(layout.outputDirectory, events),
                extractHumanFix: async (commit) => {
                    events.push('diff');
                    expect(commit).toBe(humanOracle.humanFixCommit);
                    return humanFix;
                },
            }),
        );

        expect(events).toEqual(['site', 'run', 'diff']);
        expect(existsSync(join(layout.outputDirectory, 'benchmark-record.json'))).toBe(false);
    });

    it('reads the canonical run result instead of a path returned by an injected runner', async () => {
        const layout = caseLayout('golden-runner-returned-path-');
        const foreignResultPath = join(layout.caseDirectory, '..', 'foreign-result.json');
        writeFileSync(foreignResultPath, '{"untrusted":true}', 'utf8');

        const record = await runGoldenE2ECase(
            coreConfig,
            caseOptions({ caseName: 'returned-path', ...layout }),
            offline({
                runLocalFix: vi.fn(async (_config, options) => {
                    const paths = writeLocalRunOutput(analysisOnlyRecord(), {
                        outputDir: options.outputDir,
                        workspaceRoot: process.cwd(),
                    });
                    return { ...paths, runResultPath: foreignResultPath };
                }),
            }),
        );

        expect(record.outcome.status).toBe(BenchmarkCaseStatus.Reproduced);
    });

    it('atomically replaces a benchmark record symlink without changing its target', async () => {
        const layout = caseLayout('golden-runner-record-symlink-');
        const sentinelPath = join(layout.caseDirectory, '..', 'sentinel.json');
        writeFileSync(sentinelPath, '{"sentinel":true}\n', 'utf8');
        const recordPath = () =>
            join(realpathSync(layout.evaluationDirectory), 'benchmark-record.json');

        const record = await runGoldenE2ECase(
            coreConfig,
            caseOptions({ caseName: 'safe-record', ...layout }),
            offline({
                runLocalFix: vi.fn(async (config, options) => {
                    symlinkSync(sentinelPath, recordPath());
                    return lockedRun(layout.outputDirectory)(config, options);
                }),
            }),
        );

        expect(readFileSync(sentinelPath, 'utf8')).toBe('{"sentinel":true}\n');
        expect(lstatSync(recordPath()).isSymbolicLink()).toBe(false);
        expect(JSON.parse(readFileSync(recordPath(), 'utf8'))).toEqual(record);
    });

    it('rejects output aliases to a tracked case before cleaning either directory', async () => {
        const layout = caseLayout('golden-runner-case-alias-');
        const outputLink = join(layout.caseDirectory, '..', 'run-link');
        writeFileSync(join(layout.caseDirectory, 'sentinel.txt'), 'tracked', 'utf8');
        symlinkSync(layout.caseDirectory, outputLink, 'dir');

        await expect(
            runGoldenE2ECase(
                coreConfig,
                caseOptions({ caseName: 'case-alias', ...layout, outputDirectory: outputLink }),
                offline(),
            ),
        ).rejects.toThrow(/mutually separate/u);
        expect(readFileSync(join(layout.caseDirectory, 'sentinel.txt'), 'utf8')).toBe('tracked');
    });

    it('rejects agent and evaluator directories that resolve to the same location', async () => {
        const layout = caseLayout('golden-runner-output-alias-');
        const evaluationLink = join(layout.caseDirectory, '..', 'evaluation-link');
        mkdirSync(layout.outputDirectory);
        writeFileSync(join(layout.outputDirectory, 'sentinel.txt'), 'run', 'utf8');
        symlinkSync(layout.outputDirectory, evaluationLink, 'dir');

        await expect(
            runGoldenE2ECase(
                coreConfig,
                caseOptions({
                    caseName: 'output-alias',
                    ...layout,
                    evaluationDirectory: evaluationLink,
                }),
                offline(),
            ),
        ).rejects.toThrow(/mutually separate/u);
        expect(readFileSync(join(layout.outputDirectory, 'sentinel.txt'), 'utf8')).toBe('run');
    });
});
