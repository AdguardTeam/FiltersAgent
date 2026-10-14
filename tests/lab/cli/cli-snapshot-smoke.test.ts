import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLocalRunOutput } from '../../../src/local/run-output';
import { parseLocalPublicationManifest } from '../../../src/local/local-publication-manifest';
import { runMainRuntime } from '../../../lab/cli/main-runtime';
import type { MainRuntimeContext } from '../../../lab/cli/main-secret-boundary';
import { runExportedSnapshotCycle } from '../../../lab/local/local-cycle';
import {
    createSnapshotSmokeFixture,
    disposeSnapshotSmokeFixtures,
    normalizeFileNameSet,
    normalizeRunOwnedValues,
    oracleCycleOptions,
    publishedGenerationPath,
    publishedReportDocument,
    relativeFileSet,
} from './snapshot-smoke-fixture';
import {
    disposeHermeticRunSeams,
    hermeticVerifiedHandler,
    latestHermeticBaseUrl,
    SMOKE_MODULE_EXECUTOR,
    smokeCoreConfig,
    writeSmokeBlockerModule,
} from './hermetic-run-seams';
import { loadLabBlockerModules } from '../../../lab/local/blocker-modules';
import { createLogger } from '../../../src/logger/logger';
import { enableBlockerModules } from '../../../src/proxy-blocker/blocker-module-loader';
import { TEST_PROVIDER_ENV } from '../../config/test-core-config';

afterEach(async () => {
    await disposeHermeticRunSeams();
    await disposeSnapshotSmokeFixtures();
});

/**
 * Read and parse one cycle's terminal record from its output directory.
 *
 * @param outputDir - Cycle output root.
 * @returns The parsed terminal record.
 */
function readSmokeCycleResult<T = unknown>(outputDir: string): T {
    return JSON.parse(readFileSync(join(outputDir, 'cycle-result.json'), 'utf8')) as T;
}

/**
 * Build one main-runtime context capturing the terminal writers and the failure flag.
 *
 * @param workspaceRoot - Fixed workspace root.
 * @param env - Frozen environment projection.
 * @param argv - Invocation arguments after the executable prefix.
 * @returns The context and its capture state.
 */
function smokeRuntimeContext(
    workspaceRoot: string,
    env: Record<string, string | undefined>,
    argv: string[],
): {
    context: MainRuntimeContext;
    state: { stdout: string; stderr: string; failed: boolean };
} {
    const lines = { out: [] as string[], err: [] as string[] };
    const state = {
        get stdout(): string {
            return lines.out.join('');
        },
        get stderr(): string {
            return lines.err.join('');
        },
        failed: false,
    };
    const context: MainRuntimeContext = {
        env: Object.freeze({ ...env }),
        argv: ['node', 'agent', ...argv],
        workspaceRoot,
        signal: new AbortController().signal,
        stdout: { write: (value) => lines.out.push(String(value)) },
        stderr: { write: (value) => lines.err.push(String(value)) },
        setFailureExitCode: () => {
            state.failed = true;
        },
    };
    return { context, state };
}

describe('CLI smoke on an exported issue snapshot', () => {
    it('leaves the same artifacts as the directly driven cycle and never comments without a token', async () => {
        const fixture = createSnapshotSmokeFixture();
        const manifestPath = writeSmokeBlockerModule(join(fixture.workspaceRoot, 'smoke-module'));
        const entryHandler = await hermeticVerifiedHandler(fixture.checkoutPath);
        const entryCoreConfig = smokeCoreConfig(latestHermeticBaseUrl());
        const { context, state } = smokeRuntimeContext(
            fixture.workspaceRoot,
            // The explicit provider environment resolves the entry inputs; no token exists, so the
            // comment was never available to attempt. PATH lets the module process find node.
            { ...TEST_PROVIDER_ENV, PATH: process.env.PATH },
            [
                'fix',
                'issue',
                '4',
                '--issue-file',
                fixture.issueFile,
                '--output-dir',
                fixture.entryOutputDir,
                // The scripted run selects the module's executor, which only a plugged-in module
                // makes selectable.
                '--blocker-module',
                manifestPath,
            ],
        );

        await runMainRuntime(context, {
            entryDelegate: {
                cycleCommands: {
                    loadLocalCoreConfig: () => entryCoreConfig,
                    cycleDependencies: entryHandler,
                },
            },
        });

        // The face sealed successfully and reported the entry result artifact; the environment
        // carried no token, so the recorded publication action is null: no comment was attempted.
        expect(state.failed).toBe(false);
        expect(state.stdout).toContain(
            `Entry result written to: ${join(fixture.entryOutputDir, 'entry-result.json')}`,
        );
        const entryResultFile = JSON.parse(
            readFileSync(join(fixture.entryOutputDir, 'entry-result.json'), 'utf8'),
        ) as { status: string; perIssue: Array<Record<string, unknown>> };
        expect(entryResultFile.status).toBe('success');
        expect(entryResultFile.perIssue).toEqual([
            expect.objectContaining({ issueNumber: 4, kind: 'processed', publicationAction: null }),
        ]);

        const entryCycle = readSmokeCycleResult<{
            status: string;
            investigationResultPath: string | null;
            revision: unknown;
            outcome: unknown;
            selection: unknown;
        }>(fixture.entryOutputDir);
        expect(entryCycle.status).toBe('completed');
        expect(entryCycle.investigationResultPath).toBeTypeOf('string');

        const oracleHandler = await hermeticVerifiedHandler(fixture.checkoutPath);
        const oracleCoreConfig = smokeCoreConfig(latestHermeticBaseUrl());
        const moduleEnvironment = { PATH: process.env.PATH };
        const oracleModules = loadLabBlockerModules(
            [manifestPath],
            fixture.workspaceRoot,
            moduleEnvironment,
        );
        const oracle = await runExportedSnapshotCycle(
            {
                ...oracleCycleOptions(fixture),
                blockerModules: enableBlockerModules(
                    [SMOKE_MODULE_EXECUTOR],
                    oracleModules,
                    moduleEnvironment,
                    createLogger(),
                ),
            },
            {
                loadLocalCoreConfig: () => oracleCoreConfig,
                runLocalFixFromRevision: oracleHandler.runLocalFixFromRevision,
            },
        );

        // The unchanged cycle seam is the oracle: the entry-driven terminal record binds the same
        // fixture revision, the same product outcome, and a written investigation.
        expect(oracle.status).toBe('completed');
        expect(oracle.investigationResultPath).toBeTypeOf('string');
        expect(oracle.revision).toEqual(entryCycle.revision);
        expect(oracle.outcome).toEqual(entryCycle.outcome);
        expect(oracle.selection).toEqual(entryCycle.selection);

        // The published generations carry the same document sets, the same report, and the same
        // locked investigation records; the run-result's bound artifact paths agree once each
        // run's own output root is normalized away.
        const entryGeneration = publishedGenerationPath(
            join(fixture.entryOutputDir, 'investigation', 'runs'),
        );
        const oracleGeneration = publishedGenerationPath(
            join(fixture.oracleOutputDir, 'investigation', 'runs'),
        );
        const entryFiles = relativeFileSet(entryGeneration);
        const oracleFiles = relativeFileSet(oracleGeneration);
        expect(normalizeFileNameSet(entryFiles)).toEqual(normalizeFileNameSet(oracleFiles));
        expect(entryFiles).toContain('report.md');
        expect(entryFiles).toContain('run-result.json');

        // The printed report line names the exact document the real generation carries: the walk
        // directory comes from the cycle's own bound run-record path, and the document name comes
        // from the published tree, so a writer rename cannot drift from the printed line.
        expect(state.stdout).toContain(
            `Agent report written to: ${join(
                dirname(entryCycle.investigationResultPath!),
                publishedReportDocument(entryGeneration),
            )}`,
        );

        const entryReport = readLocalRunOutput(entryCycle.investigationResultPath!);
        const oracleReport = readLocalRunOutput(oracle.investigationResultPath!);
        expect(entryReport.result.runStatus).toBe(oracleReport.result.runStatus);
        expect(
            normalizeRunOwnedValues(entryReport.result.artifactPaths, fixture.entryOutputDir),
        ).toEqual(
            normalizeRunOwnedValues(oracleReport.result.artifactPaths, fixture.oracleOutputDir),
        );
        // Neither result carried a candidate patch, so neither generation publishes one; the set
        // equality above is the carrier of the contract when a patch does travel.
        expect(entryReport.result.candidatePatch).toBeNull();
        expect(oracleReport.result.candidatePatch).toBeNull();
        expect(entryFiles.some((name) => name.endsWith('candidate.patch'))).toBe(false);
        expect(oracleFiles.some((name) => name.endsWith('candidate.patch'))).toBe(false);

        // The published manifests bind the same fixture identity on both sides.
        const entryManifest = parseLocalPublicationManifest(
            JSON.parse(readFileSync(join(entryGeneration, 'manifest.json'), 'utf8')),
        );
        const oracleManifest = parseLocalPublicationManifest(
            JSON.parse(readFileSync(join(oracleGeneration, 'manifest.json'), 'utf8')),
        );
        expect(entryManifest.issue.issueNumber).toBe(oracleManifest.issue.issueNumber);
        expect(entryManifest.issue.revisionDigest).toBe(oracleManifest.issue.revisionDigest);
        expect(existsSync(join(entryGeneration, 'report.md'))).toBe(true);
        expect(existsSync(join(oracleGeneration, 'report.md'))).toBe(true);
    });
});
