import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandName } from '../../../lab/cli/commands';
import { type ExportParsedCommand, type ParsedCommand } from '../../../lab/cli/program';
import {
    runExportedSnapshotFixCommand,
    runExportIssueCommand,
    runTargetedLiveIssueFixCommand,
} from '../../../lab/cli/local-cycle-commands';
import { exportGithubIssue } from '../../../lab/local/github-issue-exporter';
import { copyVerifiedIssueInput } from '../../../src/local/issue-revision';
import { LLM_PRICING_FILE_VAR, loadUsagePricing } from '../../../lab/pricing/usage-pricing';
import { TEST_PROVIDER_ENV, testCoreConfig } from '../../config/test-core-config';
import type {
    ExportedSnapshotCycleOptions,
    LocalCycleDependencies,
    LocalCycleResult,
} from '../../../lab/local/local-cycle';
import type {
    LiveCycleDependencies,
    TargetedLiveIssueCycleOptions,
} from '../../../lab/local/live-cycle';

const roots: string[] = [];

/**
 * The documented example price file, which names invented models and rates.
 */
const EXAMPLE_PRICING_FILE = 'docs/examples/pricing.example.json';

/**
 * Create one disposable external workspace for CLI adapter tests.
 *
 * @returns Workspace, bundle, and cycle paths.
 */
function createPaths() {
    const root = mkdtempSync(join(tmpdir(), 'agent-cycle-command-'));
    roots.push(root);
    mkdirSync(join(root, 'workspace'));
    return {
        root,
        workspaceRoot: join(root, 'workspace'),
        bundleDir: join(root, 'bundle'),
        cycleDir: join(root, 'cycle'),
    };
}

/**
 * Build one terminal pre-handler cycle result for command-adapter assertions.
 *
 * @param cycleId - Deterministic cycle identity.
 * @param selection - Exact source selected by the command adapter.
 * @returns Terminal result with no attempted investigation.
 */
function terminalCycleResult(
    cycleId: string,
    selection: LocalCycleResult['selection'],
): LocalCycleResult {
    return {
        schemaVersion: 1 as const,
        cycleId,
        startedAt: '2026-07-23T10:00:00.000Z',
        completedAt: '2026-07-23T10:01:00.000Z',
        selection,
        status: 'live_intake_failed' as const,
        revision: null,
        investigationResultPath: null,
        outcome: null,
        failure: { code: 'live_intake_failed' as const, message: 'fixture' },
    };
}

/**
 * Build parsed export command input.
 *
 * @param outputDir - External bundle output.
 * @returns Parsed export command.
 */
function exportCommand(outputDir: string): ExportParsedCommand {
    return {
        issueNumber: 4,
        outputDir,
        humanSolutionComments: [],
        additionalBotAuthors: [],
        promptSafeOnly: false,
    };
}

/**
 * Build parsed offline fix command input.
 *
 * @param issueFile - Exported v2 envelope path.
 * @param outputDir - Local cycle output root.
 * @returns Parsed fix command.
 */
function fixCommand(issueFile: string, outputDir: string): ParsedCommand {
    return {
        command: CommandName.Fix,
        issueNumber: 4,
        flags: {
            dryRun: false,
            verbose: false,
            browserMode: 'auto',
            environment: 'current',
            issueFile,
            outputDir,
            keepTemporaryFiles: false,
            noComment: false,
        },
    };
}

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('local cycle command adapter', () => {
    it('maps a targeted live command to the production live-cycle boundary', async () => {
        const paths = createPaths();
        const targeted = fixCommand('', paths.cycleDir);
        delete targeted.flags.issueFile;
        const targetedCoordinator = vi.fn(async (options) => ({
            schemaVersion: 1 as const,
            cycleId: '11111111-1111-4111-8111-111111111111',
            startedAt: '2026-07-23T10:00:00.000Z',
            completedAt: '2026-07-23T10:01:00.000Z',
            selection: { kind: 'live_issue' as const, issueNumber: options.issueNumber },
            status: 'live_intake_failed' as const,
            revision: null,
            investigationResultPath: null,
            outcome: null,
            failure: { code: 'live_intake_failed' as const, message: 'fixture' },
        }));
        const dependencies = {
            loadGithubReadConfig: () => ({ owner: 'o', repo: 'r', token: 'read-token' }),
            runTargetedLiveIssueCycle: targetedCoordinator,
        };

        await runTargetedLiveIssueFixCommand(
            targeted,
            { env: {}, workspaceRoot: paths.workspaceRoot },
            dependencies,
        );

        expect(targetedCoordinator).toHaveBeenCalledWith(
            expect.objectContaining({
                issueNumber: 4,
                github: expect.objectContaining({ token: 'read-token' }),
            }),
            expect.objectContaining({ loadLocalCoreConfig: expect.any(Function) }),
        );
    });

    it('maps production export to v2 and hands the same revision to an offline fix', async () => {
        const paths = createPaths();
        const fetchIssue = vi.fn().mockResolvedValue({
            number: 4,
            reporterAuthor: 'reporter',
            updatedAt: '2026-07-23T10:02:00.000Z',
            url: 'https://github.com/AdguardTeam/AdguardFilters/issues/4',
            title: 'Captured title',
            body: 'https://example.test',
            state: 'open',
            labels: ['T: Ads'],
            assignee: null,
            comments: [],
        });
        const exportOperation = vi.fn(
            async (...args: Parameters<typeof exportGithubIssue>) =>
                await exportGithubIssue(args[0], args[1], args[2], {
                    fetchIssue,
                    fetch: vi.fn() as unknown as typeof fetch,
                }),
        );
        const exported = await runExportIssueCommand(
            exportCommand(paths.bundleDir),
            {
                env: {
                    GITHUB_TOKEN: 'read-token',
                    GITHUB_REPOSITORY: 'export-owner/export-repo',
                },
                workspaceRoot: paths.workspaceRoot,
                now: () => '2026-07-23T10:03:00.000Z',
            },
            { exportGithubIssue: exportOperation },
        );
        const source = JSON.parse(readFileSync(exported.snapshotPath, 'utf8'));
        let capturedDigest: string | null = null;
        let capturedTitle: string | null = null;

        const execution = await runExportedSnapshotFixCommand(
            fixCommand(exported.snapshotPath, paths.cycleDir),
            {
                env: { ...TEST_PROVIDER_ENV },
                workspaceRoot: paths.workspaceRoot,
            },
            {
                cycleDependencies: {
                    createCycleId: () => '11111111-1111-4111-8111-111111111111',
                    now: () => '2026-07-23T10:04:00.000Z',
                    runLocalFixFromRevision: async (_config, revision, options) => {
                        capturedDigest = revision.sourceIntegrityDigest;
                        capturedTitle = copyVerifiedIssueInput(revision).title;
                        const runResultPath = join(options.outputDir, 'run-result.json');
                        writeFileSync(
                            runResultPath,
                            JSON.stringify({ result: { runStatus: 'analysis_only' } }),
                        );
                        return {
                            agentReportPath: join(options.outputDir, 'agent-report.md'),
                            agentDecisionPath: null,
                            agentObservationsPath: join(
                                options.outputDir,
                                'agent-observations.json',
                            ),
                            runResultPath,
                            manifestPath: '',
                            candidatePatchPath: null,
                        };
                    },
                },
            },
        );

        expect(source.schemaVersion).toBe(2);
        expect(exportOperation.mock.calls[0]?.[2]).toMatchObject({
            outputFormat: 'revision-envelope',
            capturedAt: '2026-07-23T10:03:00.000Z',
        });
        expect(exportOperation.mock.calls[0]?.[2]).not.toHaveProperty('maxAttachmentCount');
        expect(exportOperation.mock.calls[0]?.[2]).not.toHaveProperty('maxTotalAttachmentBytes');
        expect(capturedDigest).toBe(source.revisionDigest);
        expect(capturedTitle).toBe('Captured title');
        expect(execution.result.status).toBe('completed');
        expect(fetchIssue).toHaveBeenCalledOnce();
    });

    it('loads local provider config lazily after revision validation', async () => {
        const paths = createPaths();
        const issueFile = join(paths.root, 'issue.json');
        writeFileSync(issueFile, JSON.stringify({ invalid: true }));
        const loadLocalCoreConfig = vi.fn(() => {
            throw new Error('must not run');
        });

        const execution = await runExportedSnapshotFixCommand(
            fixCommand(issueFile, paths.cycleDir),
            { env: {}, workspaceRoot: paths.workspaceRoot },
            { loadLocalCoreConfig },
        );

        expect(execution.result.status).toBe('invalid_snapshot');
        expect(loadLocalCoreConfig).not.toHaveBeenCalled();
    });

    it('passes one frozen environment through every adapter', async () => {
        const paths = createPaths();
        const env = Object.freeze({
            GITHUB_TOKEN: 'read-token',
            LLM_API_KEY: 'provider-token',
        });
        const context = {
            env,
            workspaceRoot: paths.workspaceRoot,
        };
        const loadGithubReadConfig = vi.fn((received) => {
            expect(received).toBe(env);
            return { owner: 'o', repo: 'r', token: 'read-token' };
        });
        const loadLocalCoreConfig = vi.fn((received) => {
            expect(received).toBe(env);
            return testCoreConfig({
                llm: { apiKey: 'provider-token', model: 'model', visionModel: 'vision-model' },
            });
        });
        const exportedCoordinator = vi.fn(
            async (
                _options: ExportedSnapshotCycleOptions,
                _dependencies?: LocalCycleDependencies,
            ) =>
                terminalCycleResult('11111111-1111-4111-8111-111111111111', {
                    kind: 'exported_snapshot',
                    issueFile: join(paths.root, 'issue.json'),
                }),
        );
        const targetedCoordinator = vi.fn(
            async (
                _options: TargetedLiveIssueCycleOptions,
                _dependencies?: LiveCycleDependencies,
            ) =>
                terminalCycleResult('22222222-2222-4222-8222-222222222222', {
                    kind: 'live_issue',
                    issueNumber: 4,
                }),
        );
        const issueFile = join(paths.root, 'issue.json');
        writeFileSync(issueFile, '{}');
        const targeted = fixCommand('', paths.cycleDir);
        delete targeted.flags.issueFile;

        await runExportIssueCommand(exportCommand(paths.bundleDir), context, {
            loadGithubReadConfig,
            exportGithubIssue: vi.fn(async () => ({
                snapshotPath: join(paths.bundleDir, 'issue.json'),
                snapshot: { attachments: [] },
            })) as never,
        });
        await runExportedSnapshotFixCommand(fixCommand(issueFile, paths.cycleDir), context, {
            loadLocalCoreConfig,
            runExportedSnapshotCycle: exportedCoordinator,
        });
        await runTargetedLiveIssueFixCommand(targeted, context, {
            loadGithubReadConfig,
            loadLocalCoreConfig,
            runTargetedLiveIssueCycle: targetedCoordinator,
        });

        expect(loadGithubReadConfig).toHaveBeenCalledTimes(2);
        expect(loadLocalCoreConfig).not.toHaveBeenCalled();
        for (const coordinator of [exportedCoordinator, targetedCoordinator]) {
            const call = coordinator.mock.calls[0];
            expect(call?.[0]).toMatchObject({});
            expect(call?.[1]).toMatchObject({
                loadLocalCoreConfig: expect.any(Function),
            });
            call?.[1]?.loadLocalCoreConfig?.();
        }
        expect(loadLocalCoreConfig).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['from the price file LLM_PRICING_FILE names', EXAMPLE_PRICING_FILE],
        ['without a cost when no price file is named', undefined],
    ])('prices an exported-snapshot fix run %s', async (_label, pricingFile) => {
        // Contract: a fix run prices its usage from the user's price file, and without one it
        // still runs, unpriced.
        const paths = createPaths();
        const issueFile = join(paths.root, 'issue.json');
        const runExportedSnapshotCycle = vi.fn(async (_options: ExportedSnapshotCycleOptions) =>
            terminalCycleResult('11111111-1111-4111-8111-111111111111', {
                kind: 'exported_snapshot',
                issueFile,
            }),
        );
        const env = { [LLM_PRICING_FILE_VAR]: pricingFile };

        await runExportedSnapshotFixCommand(
            fixCommand(issueFile, paths.cycleDir),
            { env, workspaceRoot: process.cwd() },
            { runExportedSnapshotCycle },
        );

        expect(runExportedSnapshotCycle.mock.calls[0]?.[0].pricingSnapshot).toEqual(
            loadUsagePricing(env, process.cwd()) ?? undefined,
        );
    });

    it('prices a targeted live fix run from the price file LLM_PRICING_FILE names', async () => {
        const paths = createPaths();
        const targeted = fixCommand('', paths.cycleDir);
        delete targeted.flags.issueFile;
        const targetedCoordinator = vi.fn(async (_options: TargetedLiveIssueCycleOptions) =>
            terminalCycleResult('22222222-2222-4222-8222-222222222222', {
                kind: 'live_issue',
                issueNumber: 4,
            }),
        );

        await runTargetedLiveIssueFixCommand(
            targeted,
            { env: { [LLM_PRICING_FILE_VAR]: EXAMPLE_PRICING_FILE }, workspaceRoot: process.cwd() },
            {
                loadGithubReadConfig: () => ({ owner: 'o', repo: 'r', token: 'read-token' }),
                runTargetedLiveIssueCycle: targetedCoordinator,
            },
        );

        expect(targetedCoordinator.mock.calls[0]?.[0]).toMatchObject({
            pricingSnapshot: expect.objectContaining({
                'example-reasoning-model': expect.any(Object),
            }),
        });
    });

    it('threads the --repository flag into the GitHub read loader seam', async () => {
        const paths = createPaths();
        const targeted = fixCommand('', paths.cycleDir);
        delete targeted.flags.issueFile;
        targeted.flags.repository = 'fork-owner/list-repo';
        const loadGithubReadConfig = vi.fn(() => ({ owner: 'o', repo: 'r', token: 't' }));

        await runTargetedLiveIssueFixCommand(
            targeted,
            { env: { GITHUB_TOKEN: 'read-token' }, workspaceRoot: paths.workspaceRoot },
            {
                loadGithubReadConfig,
                runTargetedLiveIssueCycle: vi.fn(async (options: TargetedLiveIssueCycleOptions) =>
                    terminalCycleResult('11111111-1111-4111-8111-111111111111', {
                        kind: 'live_issue',
                        issueNumber: options.issueNumber,
                    }),
                ),
            },
        );

        // The identity sources travel with the load: the flag directly, the checkout origin
        // resolved by the seam's git adapter on REPOSITORY_PATH (null-tolerant; absent here).
        expect(loadGithubReadConfig).toHaveBeenCalledWith(
            { GITHUB_TOKEN: 'read-token' },
            {
                flag: 'fork-owner/list-repo',
                checkoutOriginUrl: null,
            },
        );
    });

    it('supplies the repository identity from a fork-origin checkout when the env names none', async () => {
        const paths = createPaths();
        const checkout = join(paths.root, 'checkout');
        mkdirSync(checkout);
        execFileSync('git', ['init', '--quiet', checkout]);
        execFileSync('git', [
            '-C',
            checkout,
            'remote',
            'add',
            'origin',
            'https://github.com/fork-owner/list-repo.git',
        ]);
        const exportOperation = vi.fn(async (..._args: Parameters<typeof exportGithubIssue>) => ({
            snapshotPath: join(paths.bundleDir, 'issue.json'),
            snapshot: { attachments: [] },
        }));

        // The production loader and the production git adapter run: the slug comes from the
        // checkout's origin remote, so no environment variable and no network are involved.
        await runExportIssueCommand(
            exportCommand(paths.bundleDir),
            {
                env: { GITHUB_TOKEN: 'read-token', REPOSITORY_PATH: checkout },
                workspaceRoot: paths.workspaceRoot,
            },
            { exportGithubIssue: exportOperation as never },
        );

        expect(exportOperation.mock.calls[0]?.[0]).toEqual({
            owner: 'fork-owner',
            repo: 'list-repo',
            token: 'read-token',
        });
    });

    it('prefers the --repository flag over the checkout origin slug', async () => {
        const paths = createPaths();
        const checkout = join(paths.root, 'checkout');
        mkdirSync(checkout);
        execFileSync('git', ['init', '--quiet', checkout]);
        execFileSync('git', [
            '-C',
            checkout,
            'remote',
            'add',
            'origin',
            'https://github.com/fork-owner/list-repo.git',
        ]);
        const loadGithubReadConfig = vi.fn(() => ({ owner: 'o', repo: 'r', token: 't' }));
        const exportOperation = vi.fn(async () => ({
            snapshotPath: join(paths.bundleDir, 'issue.json'),
            snapshot: { attachments: [] },
        }));

        await runExportIssueCommand(
            { ...exportCommand(paths.bundleDir), repository: 'flag-owner/flag-repo' },
            {
                env: { GITHUB_TOKEN: 'read-token', REPOSITORY_PATH: checkout },
                workspaceRoot: paths.workspaceRoot,
            },
            { exportGithubIssue: exportOperation as never, loadGithubReadConfig },
        );

        expect(loadGithubReadConfig).toHaveBeenCalledWith(
            expect.objectContaining({ GITHUB_TOKEN: 'read-token' }),
            {
                flag: 'flag-owner/flag-repo',
                checkoutOriginUrl: 'https://github.com/fork-owner/list-repo.git',
            },
        );
    });
});
