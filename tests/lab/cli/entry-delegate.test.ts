import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CommanderError } from 'commander';
import {
    buildProgram,
    type BacklogParsedCommand,
    type ParsedCommand,
} from '../../../lab/cli/program';
import { CommandName } from '../../../lab/cli/commands';
import {
    createLabBacklogEntryInputs,
    createLabFixEntryDelegate,
} from '../../../lab/cli/entry-delegate';
import { LAB_EXECUTOR_SET } from '../../../lab/cli/executor-set';
import { AdguardCliExecutorName } from '../../../src/adguard-cli/executor-name';
import { BrowserExtensionExecutorName } from '../../../src/environment/executor-name';
import { runMainRuntime } from '../../../lab/cli/main-runtime';
import type { MainRuntimeContext } from '../../../lab/cli/main-secret-boundary';
import type {
    ExportedSnapshotCycleOptions,
    LocalCycleResult,
} from '../../../lab/local/local-cycle';
import type { TargetedLiveIssueCycleOptions } from '../../../lab/local/live-cycle';
import {
    LOCAL_PUBLICATION_PATCH_FILE_NAME,
    LOCAL_PUBLICATION_REPORT_FILE_NAME,
} from '../../../src/local/evidence-publication';
import { BrowserMode } from '../../../src/types/browser-mode';
import { ExtensionEnvironmentKind } from '../../../src/types/extension-environment-kind';
import { EffectiveMode, FixRunStatus, VerificationStatus } from '../../../src/types/fix-run-result';
import type { FixRunResult } from '../../../src/types/fix-run-result';
import { RuleType } from '../../../src/types/rule-proposal';
import { TEST_PROVIDER_ENV } from '../../config/test-core-config';
import { ConfigError } from '../../../src/config/config-error';
import { DefaultSingleIssueFailure } from '../../../src/entry/single-issue-run-types';
import { ENTRY_RESULT_FILE_NAME } from '../../../src/entry/entry-run';

const roots: string[] = [];

/**
 * The publication generation leaf the real cycle binds its run record into: the investigation
 * writes `runs/<publication-id>/` beneath the cycle output's `investigation` root, so the print
 * fixtures script their bind paths at the same real layout shape the writer mints.
 */
const FIXTURE_PUBLICATION_ID = '01890a5d-ac96-774b-bcce-b302099a8057';

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

/**
 * Create one disposable external workspace, cycle output, and issue snapshot for CLI tests.
 *
 * @returns Workspace root, cycle output directory, and snapshot path.
 */
function createPaths() {
    const root = mkdtempSync(join(tmpdir(), 'agent-entry-delegate-'));
    roots.push(root);
    mkdirSync(join(root, 'workspace'));
    mkdirSync(join(root, 'cycle'));
    const issueFile = join(root, 'issue.json');
    return {
        root,
        workspaceRoot: join(root, 'workspace'),
        cycleDir: join(root, 'cycle'),
        issueFile,
    };
}

/**
 * Build one parsed `fix` command fixture.
 *
 * @param options - Snapshot path the command carries, and flag overrides.
 * @returns The parsed command.
 */
function fixCommand(options: {
    issueFile?: string;
    outputDir: string;
    model?: string;
    verbose?: boolean;
    repository?: string;
    keepTemporaryFiles?: boolean;
    executors?: string;
}): ParsedCommand {
    return {
        command: CommandName.Fix,
        issueNumber: 4,
        flags: {
            dryRun: false,
            verbose: options.verbose ?? false,
            browserMode: BrowserMode.Auto,
            environment: ExtensionEnvironmentKind.Current,
            issueFile: options.issueFile,
            outputDir: options.outputDir,
            model: options.model,
            repository: options.repository,
            keepTemporaryFiles: options.keepTemporaryFiles ?? false,
            executors: options.executors,
            noComment: false,
        },
    };
}

/**
 * Build one terminal completed cycle fixture as the fake cycle coordinator returns it.
 *
 * @param investigationResultPath - The bound run-result path.
 * @returns Terminal completed result.
 */
function completedCycleResult(investigationResultPath: string): LocalCycleResult {
    return {
        schemaVersion: 1,
        cycleId: '11111111-1111-4111-8111-111111111111',
        startedAt: '2026-09-09T10:00:00.000Z',
        completedAt: '2026-09-09T10:01:00.000Z',
        selection: { kind: 'exported_snapshot', issueFile: 'fixture-issue.json' },
        status: 'completed',
        revision: null,
        investigationResultPath,
        outcome: null,
        failure: null,
    };
}

/**
 * Build one terminal failed cycle fixture as the fake cycle coordinator returns it.
 *
 * @param code - Bounded failure code the cycle reports.
 * @param message - Bounded failure message.
 * @returns Terminal failed result.
 */
function failedCycleResult(
    code: 'runtime_failed' | 'invalid_snapshot',
    message: string,
): LocalCycleResult {
    return {
        schemaVersion: 1,
        cycleId: '22222222-2222-4222-8222-222222222222',
        startedAt: '2026-09-09T10:00:00.000Z',
        completedAt: '2026-09-09T10:01:00.000Z',
        selection: { kind: 'exported_snapshot', issueFile: 'fixture-issue.json' },
        status: code === 'runtime_failed' ? 'failed' : 'invalid_snapshot',
        revision: null,
        investigationResultPath: null,
        outcome: null,
        failure: { code, message },
    };
}

/**
 * Build one terminal investigation record fixture.
 *
 * @param issueNumber - Issue the record belongs to.
 * @param withPatch - Whether the record carries a candidate patch.
 * @returns The loose investigation record.
 */
function fixtureRunResult(issueNumber: number, withPatch: boolean): FixRunResult {
    return {
        issueNumber,
        domain: 'example.com',
        runStatus: FixRunStatus.NotReproduced,
        requestedBrowserMode: BrowserMode.Auto,
        effectiveMode: EffectiveMode.Browser,
        verificationStatus: VerificationStatus.NotAttempted,
        fallbackReason: null,
        fallbackDetail: null,
        candidatePatch: withPatch
            ? {
                  rule: '||blocked.example.com^',
                  ruleType: RuleType.Network,
                  filePath: 'filters.txt',
              }
            : null,
        artifactPaths: { screenshots: [], domSnapshot: null, har: null, trace: null },
        reasoning: 'The reported symptom was absent.',
        repository: null,
        baseSha: null,
    };
}

/**
 * Build one main-runtime context capturing the terminal writers and the failure flag.
 *
 * @param workspaceRoot - Fixed workspace root.
 * @param env - Frozen environment projection.
 * @param argv - Invocation arguments after the executable prefix.
 * @returns The context and its capture state.
 */
function runtimeContext(
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

describe('createLabFixEntryDelegate', () => {
    it('maps fix --issue-file to snapshot inputs from the explicit provider environment', () => {
        const paths = createPaths();

        const delegate = createLabFixEntryDelegate(
            fixCommand({ issueFile: paths.issueFile, outputDir: paths.cycleDir }),
            { env: { ...TEST_PROVIDER_ENV }, workspaceRoot: paths.workspaceRoot },
        );

        expect(delegate.inputs.mode).toEqual({ kind: 'single_issue', issueNumber: 4 });
        expect(delegate.inputs.issueSnapshotPath).toBe(paths.issueFile);
        expect(delegate.inputs.artifactsDir).toBe(paths.cycleDir);
        expect(delegate.inputs.slug).toBeNull();
        expect(delegate.inputs.comments).toEqual({
            enabled: false,
            screenshotsBranch: 'filters-agent-screenshots',
        });
        expect(delegate.inputs.config.llm).toMatchObject({
            baseUrl: TEST_PROVIDER_ENV.LLM_BASE_URL,
            apiKey: TEST_PROVIDER_ENV.LLM_API_KEY,
            model: TEST_PROVIDER_ENV.LLM_MODEL,
            visionModel: TEST_PROVIDER_ENV.LLM_VISION_MODEL,
            visionMaxOutputTokens: Number(TEST_PROVIDER_ENV.LLM_VISION_MAX_OUTPUT_TOKENS),
        });
    });

    it('refuses an API key alone, naming every provider variable still missing', () => {
        // No provider is built in: a key without its endpoint, models and limits is an incomplete
        // configuration, not a shortcut to somebody's default.
        const paths = createPaths();

        const delegate = () =>
            createLabFixEntryDelegate(
                fixCommand({ issueFile: paths.issueFile, outputDir: paths.cycleDir }),
                {
                    env: { LLM_API_KEY: TEST_PROVIDER_ENV.LLM_API_KEY },
                    workspaceRoot: paths.workspaceRoot,
                },
            );

        expect(delegate).toThrow(ConfigError);
        for (const name of Object.keys(TEST_PROVIDER_ENV).filter((key) => key !== 'LLM_API_KEY')) {
            expect(delegate).toThrow(new RegExp(name, 'u'));
        }
    });

    it('maps a live fix to token-backed inputs carrying the repository and output identity', () => {
        const paths = createPaths();

        const delegate = createLabFixEntryDelegate(
            fixCommand({
                outputDir: paths.cycleDir,
                model: 'deepseek-v4-flash',
                repository: 'fork-owner/list',
            }),
            {
                env: { ...TEST_PROVIDER_ENV, GITHUB_TOKEN: 'read-token' },
                workspaceRoot: paths.workspaceRoot,
            },
        );

        expect(delegate.inputs.mode).toEqual({ kind: 'single_issue', issueNumber: 4 });
        expect(delegate.inputs.slug).toEqual({ owner: 'fork-owner', repo: 'list' });
        expect(delegate.inputs.issueSnapshotPath).toBeUndefined();
        expect(delegate.inputs.comments).toEqual({
            enabled: true,
            token: 'read-token',
            screenshotsBranch: 'filters-agent-screenshots',
        });
        expect(delegate.inputs.model).toBe('deepseek-v4-flash');
        expect(delegate.inputs.artifactsDir).toBe(paths.cycleDir);
    });

    it('locks the declared lab executor set into the entry inputs when --executors is absent', () => {
        const paths = createPaths();

        const delegate = createLabFixEntryDelegate(
            fixCommand({ issueFile: paths.issueFile, outputDir: paths.cycleDir }),
            { env: { ...TEST_PROVIDER_ENV }, workspaceRoot: paths.workspaceRoot },
        );

        expect(delegate.inputs.executors).toEqual([...LAB_EXECUTOR_SET]);
    });

    it('lets a parsed --executors flag win over the declared lab set', () => {
        const paths = createPaths();

        const delegate = createLabFixEntryDelegate(
            fixCommand({
                issueFile: paths.issueFile,
                outputDir: paths.cycleDir,
                executors: BrowserExtensionExecutorName,
            }),
            { env: { ...TEST_PROVIDER_ENV }, workspaceRoot: paths.workspaceRoot },
        );

        expect(delegate.inputs.executors).toEqual([BrowserExtensionExecutorName]);
    });

    it('threads a parsed --executors flag into the snapshot cycle the delegate actually runs', async () => {
        // `delegate.inputs.executors` alone does not prove the flag reaches the
        // investigation — the lab cycle used to always lock LAB_EXECUTOR_SET regardless. This
        // exercises the same boundary labCycleRunIssue drives the real cycle through.
        const paths = createPaths();
        const runExportedSnapshotCycle = vi.fn(async (_options: ExportedSnapshotCycleOptions) =>
            completedCycleResult(join(paths.cycleDir, 'investigation', 'run-result.json')),
        );
        const delegate = createLabFixEntryDelegate(
            fixCommand({
                issueFile: paths.issueFile,
                outputDir: paths.cycleDir,
                executors: BrowserExtensionExecutorName,
            }),
            { env: { ...TEST_PROVIDER_ENV }, workspaceRoot: paths.workspaceRoot },
            {
                cycleCommands: { runExportedSnapshotCycle },
                readInvestigationResult: () => fixtureRunResult(4, false),
            },
        );

        await delegate.dependencies.runIssue?.({
            config: delegate.inputs.config,
            slug: { owner: 'example', repo: 'list' },
            issueNumber: 4,
            issueSnapshotPath: paths.issueFile,
            token: undefined,
            commentsEnabled: false,
            screenshotsBranch: 'filters-agent-screenshots',
            artifactsDir: paths.cycleDir,
        });

        expect(runExportedSnapshotCycle.mock.calls[0]?.[0]).toMatchObject({
            executors: [BrowserExtensionExecutorName],
        });
    });

    it('locks the declared lab executor set in the snapshot cycle when --executors is absent', async () => {
        const paths = createPaths();
        const runExportedSnapshotCycle = vi.fn(async (_options: ExportedSnapshotCycleOptions) =>
            completedCycleResult(join(paths.cycleDir, 'investigation', 'run-result.json')),
        );
        const delegate = createLabFixEntryDelegate(
            fixCommand({ issueFile: paths.issueFile, outputDir: paths.cycleDir }),
            { env: { ...TEST_PROVIDER_ENV }, workspaceRoot: paths.workspaceRoot },
            {
                cycleCommands: { runExportedSnapshotCycle },
                readInvestigationResult: () => fixtureRunResult(4, false),
            },
        );

        await delegate.dependencies.runIssue?.({
            config: delegate.inputs.config,
            slug: { owner: 'example', repo: 'list' },
            issueNumber: 4,
            issueSnapshotPath: paths.issueFile,
            token: undefined,
            commentsEnabled: false,
            screenshotsBranch: 'filters-agent-screenshots',
            artifactsDir: paths.cycleDir,
        });

        expect(runExportedSnapshotCycle.mock.calls[0]?.[0]).toMatchObject({
            executors: [...LAB_EXECUTOR_SET],
        });
    });

    it('adapts a completed snapshot cycle into a processed outcome owning the investigation directory', async () => {
        const paths = createPaths();
        const investigationResultPath = join(paths.cycleDir, 'investigation', 'run-result.json');
        const runExportedSnapshotCycle = vi.fn(async (_options: ExportedSnapshotCycleOptions) =>
            completedCycleResult(investigationResultPath),
        );
        const readInvestigationResult = vi.fn(() => fixtureRunResult(4, false));
        const delegate = createLabFixEntryDelegate(
            fixCommand({ issueFile: paths.issueFile, outputDir: paths.cycleDir }),
            { env: { ...TEST_PROVIDER_ENV }, workspaceRoot: paths.workspaceRoot },
            {
                cycleCommands: { runExportedSnapshotCycle },
                readInvestigationResult,
            },
        );

        const outcome = await delegate.dependencies.runIssue?.({
            config: delegate.inputs.config,
            slug: { owner: 'example', repo: 'list' },
            issueNumber: 4,
            issueSnapshotPath: paths.issueFile,
            token: undefined,
            commentsEnabled: false,
            screenshotsBranch: 'filters-agent-screenshots',
            artifactsDir: paths.cycleDir,
        });

        expect(runExportedSnapshotCycle.mock.calls[0]?.[0]).toMatchObject({
            issueNumber: 4,
            issueFile: paths.issueFile,
            outputDir: paths.cycleDir,
            environment: 'current',
        });
        expect(readInvestigationResult).toHaveBeenCalledWith(investigationResultPath);
        expect(outcome).toMatchObject({
            kind: 'processed',
            issueNumber: 4,
            publication: null,
            artifactsDir: dirname(investigationResultPath),
        });
    });

    it('adapts cycle failures into named per-issue outcomes', async () => {
        const paths = createPaths();
        for (const [fixture, failureCode] of [
            [
                failedCycleResult('runtime_failed', 'fixture runtime failure'),
                DefaultSingleIssueFailure.InvestigationFailed,
            ],
            [
                failedCycleResult('invalid_snapshot', 'fixture snapshot problem'),
                DefaultSingleIssueFailure.IssueUnavailable,
            ],
        ] as const) {
            const delegate = createLabFixEntryDelegate(
                fixCommand({ issueFile: paths.issueFile, outputDir: paths.cycleDir }),
                { env: { ...TEST_PROVIDER_ENV }, workspaceRoot: paths.workspaceRoot },
                {
                    cycleCommands: {
                        runExportedSnapshotCycle: vi.fn(async () => fixture),
                    },
                },
            );

            const outcome = await delegate.dependencies.runIssue?.({
                config: delegate.inputs.config,
                slug: { owner: 'example', repo: 'list' },
                issueNumber: 4,
                issueSnapshotPath: paths.issueFile,
                token: undefined,
                commentsEnabled: false,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir: paths.cycleDir,
            });

            expect(outcome).toMatchObject({
                kind: 'failed',
                issueNumber: 4,
                failureCode,
                failureDetail: fixture.failure?.message,
            });
        }
    });

    it('threads temporary-file retention into the snapshot cycle', async () => {
        const paths = createPaths();
        const runExportedSnapshotCycle = vi.fn(async (_options: ExportedSnapshotCycleOptions) =>
            completedCycleResult(join(paths.cycleDir, 'investigation', 'run-result.json')),
        );
        const delegate = createLabFixEntryDelegate(
            fixCommand({
                issueFile: paths.issueFile,
                outputDir: paths.cycleDir,
                keepTemporaryFiles: true,
                verbose: true,
                model: 'deepseek-v4-flash',
            }),
            { env: { ...TEST_PROVIDER_ENV }, workspaceRoot: paths.workspaceRoot },
            {
                cycleCommands: { runExportedSnapshotCycle },
                readInvestigationResult: () => fixtureRunResult(4, false),
            },
        );

        await delegate.dependencies.runIssue?.({
            config: delegate.inputs.config,
            slug: { owner: 'example', repo: 'list' },
            issueNumber: 4,
            issueSnapshotPath: paths.issueFile,
            token: undefined,
            commentsEnabled: false,
            screenshotsBranch: 'filters-agent-screenshots',
            artifactsDir: paths.cycleDir,
        });

        expect(runExportedSnapshotCycle.mock.calls[0]?.[0]).toMatchObject({
            keepTemporaryFiles: true,
            verbose: true,
            model: 'deepseek-v4-flash',
        });
    });

    it('wraps the targeted live cycle through the read-config loader', async () => {
        const paths = createPaths();
        const runTargetedLiveIssueCycle = vi.fn(async (_options: TargetedLiveIssueCycleOptions) =>
            completedCycleResult(join(paths.cycleDir, 'investigation', 'run-result.json')),
        );
        const loadGithubReadConfig = vi.fn(() => ({
            owner: 'fork-owner',
            repo: 'list',
            token: 'read-token',
        }));
        const delegate = createLabFixEntryDelegate(
            fixCommand({
                outputDir: paths.cycleDir,
                keepTemporaryFiles: true,
                repository: 'fork-owner/list',
            }),
            {
                env: { ...TEST_PROVIDER_ENV, GITHUB_TOKEN: 'read-token' },
                workspaceRoot: paths.workspaceRoot,
            },
            {
                cycleCommands: { runTargetedLiveIssueCycle, loadGithubReadConfig },
                readInvestigationResult: () => fixtureRunResult(4, false),
            },
        );

        const outcome = await delegate.dependencies.runIssue?.({
            config: delegate.inputs.config,
            slug: { owner: 'fork-owner', repo: 'list' },
            issueNumber: 4,
            token: 'read-token',
            commentsEnabled: false,
            screenshotsBranch: 'filters-agent-screenshots',
            artifactsDir: paths.cycleDir,
        });

        expect(loadGithubReadConfig).toHaveBeenCalledWith(
            expect.objectContaining({
                GITHUB_TOKEN: 'read-token',
                LLM_API_KEY: TEST_PROVIDER_ENV.LLM_API_KEY,
            }),
            { flag: 'fork-owner/list', checkoutOriginUrl: null },
        );
        expect(runTargetedLiveIssueCycle.mock.calls[0]?.[0]).toMatchObject({
            issueNumber: 4,
            outputDir: paths.cycleDir,
            github: { owner: 'fork-owner', repo: 'list', token: 'read-token' },
            keepTemporaryFiles: true,
        });
        expect(outcome).toMatchObject({ kind: 'processed', issueNumber: 4 });
    });
});

describe('createLabBacklogEntryInputs', () => {
    it('maps the backlog command to backlog mode with the token-configured comment policy', () => {
        const paths = createPaths();

        const inputs = createLabBacklogEntryInputs(
            {
                command: CommandName.Backlog,
                flags: {
                    limit: 3,
                    repository: 'fork-owner/list',
                    outputDir: paths.cycleDir,
                    model: 'deepseek-v4-flash',
                    verbose: true,
                    noComment: false,
                },
            },
            {
                env: { ...TEST_PROVIDER_ENV, GITHUB_TOKEN: 'read-token' },
                workspaceRoot: paths.workspaceRoot,
            },
        );

        expect(inputs.mode).toEqual({ kind: 'backlog', limit: 3 });
        expect(inputs.slug).toEqual({ owner: 'fork-owner', repo: 'list' });
        expect(inputs.comments).toEqual({
            enabled: true,
            token: 'read-token',
            screenshotsBranch: 'filters-agent-screenshots',
        });
        expect(inputs.artifactsDir).toBe(paths.cycleDir);
        expect(inputs.model).toBe('deepseek-v4-flash');
        expect(inputs.executors).toEqual([...LAB_EXECUTOR_SET]);
    });

    it('lets a parsed backlog --no-comment flag disable comments even with a token configured', () => {
        // Before this mapping existed, comments turned on whenever GITHUB_TOKEN was set
        // with no CLI way to disable them, so a backlog run against a real checkout had no way to
        // avoid posting agent reports there.
        const paths = createPaths();

        const inputs = createLabBacklogEntryInputs(
            {
                command: CommandName.Backlog,
                flags: {
                    limit: 3,
                    repository: 'fork-owner/list',
                    outputDir: paths.cycleDir,
                    model: 'deepseek-v4-flash',
                    verbose: true,
                    noComment: true,
                },
            },
            {
                env: { ...TEST_PROVIDER_ENV, GITHUB_TOKEN: 'read-token' },
                workspaceRoot: paths.workspaceRoot,
            },
        );

        expect(inputs.comments).toEqual({
            enabled: false,
            token: 'read-token',
            screenshotsBranch: 'filters-agent-screenshots',
        });
    });

    it('lets a parsed backlog --executors flag win over the declared lab set', () => {
        const paths = createPaths();

        const inputs = createLabBacklogEntryInputs(
            {
                command: CommandName.Backlog,
                flags: {
                    limit: 3,
                    repository: 'fork-owner/list',
                    outputDir: paths.cycleDir,
                    model: 'deepseek-v4-flash',
                    verbose: true,
                    executors: AdguardCliExecutorName,
                    noComment: false,
                },
            },
            {
                env: { ...TEST_PROVIDER_ENV, GITHUB_TOKEN: 'read-token' },
                workspaceRoot: paths.workspaceRoot,
            },
        );

        expect(inputs.executors).toEqual([AdguardCliExecutorName]);
    });
});

describe('lab delegation through the main runtime', () => {
    it('runs fix through the entry and prints the entry lines', async () => {
        const paths = createPaths();
        const investigationResultPath = join(
            paths.cycleDir,
            'investigation',
            'runs',
            FIXTURE_PUBLICATION_ID,
            'run-result.json',
        );
        const runExportedSnapshotCycle = vi.fn(async (_options: ExportedSnapshotCycleOptions) =>
            completedCycleResult(investigationResultPath),
        );
        const { context, state } = runtimeContext(paths.workspaceRoot, { ...TEST_PROVIDER_ENV }, [
            'fix',
            'issue',
            '4',
            '--issue-file',
            paths.issueFile,
            '--output-dir',
            paths.cycleDir,
        ]);

        await runMainRuntime(context, {
            entryDelegate: {
                cycleCommands: { runExportedSnapshotCycle },
                readInvestigationResult: () => fixtureRunResult(4, false),
            },
        });

        expect(state.stdout).toContain(
            `Entry result written to: ${join(paths.cycleDir, ENTRY_RESULT_FILE_NAME)}`,
        );
        expect(state.stdout).toContain(
            `Agent report written to: ${join(
                dirname(investigationResultPath),
                LOCAL_PUBLICATION_REPORT_FILE_NAME,
            )}`,
        );
        expect(state.stdout).not.toContain('Candidate patch written to:');
        expect(state.failed).toBe(false);
        expect(
            JSON.parse(readFileSync(join(paths.cycleDir, ENTRY_RESULT_FILE_NAME), 'utf8')),
        ).toMatchObject({
            status: 'success',
            runMode: 'single_issue',
            perIssue: [{ issueNumber: 4, kind: 'processed', publicationAction: null }],
        });
    });

    it('prints the candidate patch line when the result carries a patch', async () => {
        const paths = createPaths();
        const investigationResultPath = join(
            paths.cycleDir,
            'investigation',
            'runs',
            FIXTURE_PUBLICATION_ID,
            'run-result.json',
        );
        const { context, state } = runtimeContext(paths.workspaceRoot, { ...TEST_PROVIDER_ENV }, [
            'fix',
            'issue',
            '4',
            '--issue-file',
            paths.issueFile,
            '--output-dir',
            paths.cycleDir,
        ]);

        await runMainRuntime(context, {
            entryDelegate: {
                cycleCommands: {
                    runExportedSnapshotCycle: vi.fn(async () =>
                        completedCycleResult(investigationResultPath),
                    ),
                },
                readInvestigationResult: () => fixtureRunResult(4, true),
            },
        });

        expect(state.stdout).toContain(
            `Candidate patch written to: ${join(
                dirname(investigationResultPath),
                LOCAL_PUBLICATION_PATCH_FILE_NAME,
            )}`,
        );
    });

    it('surfaces the shared combined error through stderr with a failure exit', async () => {
        const paths = createPaths();
        const { context, state } = runtimeContext(paths.workspaceRoot, { ...TEST_PROVIDER_ENV }, [
            'backlog',
            '--repository',
            'fork-owner/list',
            '--output-dir',
            paths.cycleDir,
            '--limit',
            '2',
        ]);

        await runMainRuntime(context);

        expect(state.stderr).toContain('GITHUB_TOKEN');
        expect(state.failed).toBe(true);
    });

    it('keeps a zero exit when the cycle seals with a failed outcome', async () => {
        // A caller that retries on a non-zero `fix` exit would start a second attempt, which
        // clears the first attempt's output directory (cycle-result.json included) before anyone
        // reads it. The outcome lives in cycle-result.json's own `status` field instead, so a
        // sealed cycle — completed or not — must leave the process exit at zero; only a crash that
        // never reaches a sealed cycle result may fail the exit (see the next test).
        const paths = createPaths();
        const { context, state } = runtimeContext(paths.workspaceRoot, { ...TEST_PROVIDER_ENV }, [
            'fix',
            'issue',
            '4',
            '--issue-file',
            paths.issueFile,
            '--output-dir',
            paths.cycleDir,
        ]);

        await runMainRuntime(context, {
            entryDelegate: {
                cycleCommands: {
                    runExportedSnapshotCycle: vi.fn(async () =>
                        failedCycleResult('runtime_failed', 'fixture runtime failure'),
                    ),
                },
            },
        });

        expect(state.stdout).toContain('failed at investigation_failed: fixture runtime failure');
        expect(state.failed).toBe(false);
    });

    it('sets the failure exit when the cycle never seals (an unsealed crash)', async () => {
        // An uncaught rejection out of the cycle coordinator means no cycle-result.json was ever
        // written for this attempt; a retry (a fresh attempt with a cleared output directory) is
        // exactly the right response, so this is the one case that must still fail the process
        // exit.
        const paths = createPaths();
        const { context, state } = runtimeContext(paths.workspaceRoot, { ...TEST_PROVIDER_ENV }, [
            'fix',
            'issue',
            '4',
            '--issue-file',
            paths.issueFile,
            '--output-dir',
            paths.cycleDir,
        ]);

        await runMainRuntime(context, {
            entryDelegate: {
                cycleCommands: {
                    runExportedSnapshotCycle: vi.fn(async () => {
                        throw new Error('simulated whole-process crash');
                    }),
                },
            },
        });

        expect(state.stderr).toContain('simulated whole-process crash');
        expect(state.failed).toBe(true);
    });
});

/**
 * Parse one backlog invocation through its dedicated callback.
 *
 * @param argv - Raw arguments beginning at the backlog command.
 * @returns Backlog callback spy and optional Commander parsing error.
 */
function runBacklog(argv: string[]) {
    const onBacklogCommand = vi.fn();
    const program = buildProgram(
        vi.fn(),
        { exitOverride: true, suppressOutput: true },
        undefined,
        undefined,
        onBacklogCommand,
    );
    let error: CommanderError | undefined;
    try {
        program.parse(argv, { from: 'user' });
    } catch (caught) {
        error = caught as CommanderError;
    }
    return { onBacklogCommand, error };
}

describe('backlog command parsing', () => {
    it('parses limit, repository, output, model, and verbose controls', () => {
        const { onBacklogCommand, error } = runBacklog([
            'backlog',
            '--limit',
            '3',
            '--repository',
            'fork-owner/list',
            '--output-dir',
            '/tmp/backlog-run',
            '--model',
            'deepseek-v4-flash',
            '--verbose',
        ]);

        expect(error).toBeUndefined();
        const parsed: BacklogParsedCommand = onBacklogCommand.mock.calls[0][0];
        expect(parsed).toEqual({
            command: 'backlog',
            flags: {
                limit: 3,
                repository: 'fork-owner/list',
                outputDir: '/tmp/backlog-run',
                model: 'deepseek-v4-flash',
                verbose: true,
                noComment: false,
            },
        });
    });

    it('rejects a non-positive limit at parse time', () => {
        const { onBacklogCommand, error } = runBacklog(['backlog', '--limit', '0']);

        expect(error?.code).toBe('agent.invalidLimit');
        expect(onBacklogCommand).not.toHaveBeenCalled();
    });
});
