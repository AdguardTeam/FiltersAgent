import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FixRunStatus, SymptomObservation } from '../../src/types/fix-run-result';
import type { FixRunResult } from '../../src/types/fix-run-result';
import {
    ExtensionManifestVersion,
    PreparedExtensionSource,
} from '../../src/environment/extension-preparation';
import type { RawIssue } from '../../src/github/fetch-issue';
import { AUTOMATIC_UPSTREAM_PROMPT_TEXT_LIMITS } from '../../src/github/prompt-safety';
import { IntakeExtractionKind } from '../../src/intake/extract-report';
import type { Logger } from '../../src/logger/logger';
import {
    DefaultSingleIssueFailure,
    type DefaultSingleIssueDependencies,
} from '../../src/entry/single-issue-run-types';
import type { FixCoreIssueInput, FixCoreOptions } from '../../src/orchestrator/fix-core-inputs';
import type { FiltersCommand } from '../../src/local/filters-preparer';
import {
    REPORT_COMMENT_MARKER_PREFIX,
    parseReportRevisionMarker,
} from '../../src/publisher/report-publisher';
import {
    DEFAULT_INSTRUCTION_PATH,
    type LoadedInstruction,
} from '../../src/knowledge/instruction-loader';
import { GuidanceDocumentOrigin, GuidanceDocumentRole } from '../../src/knowledge/guidance-source';
import { testCoreConfig } from '../config/test-core-config';
import { runDefaultSingleIssue } from '../../src/entry/single-issue-run';
import { fetchedIssueRevisionDigest } from '../../src/entry/single-issue-revision-digest';
import { renderReportRevisionMarker } from '../../src/publisher/report-publisher';
import {
    exportedIssueFixture,
    extractedReportSeam,
    fixtureReport,
    issueCommentOctokit,
    PLATFORM_WRITE_REFUSAL,
    preparedWorkspace,
    processedRunResult,
    rawIssueFixture,
    refusedCommentOctokit,
    removeScratchDirs,
    REPOSITORY_REMOTE_URL_FIXTURE,
    scratchDir,
    scriptedExtractReport,
} from './single-issue-run-fixtures';

/**
 * One counting logger fake: the pino level methods a diagnosis assertion reads, each spied.
 */
interface CountingLoggerFake {
    /**
     * The fake itself, ready to inject as the run's diagnostics logger.
     */
    logger: Logger;

    /**
     * The spy behind every info record.
     */
    info: ReturnType<typeof vi.fn>;

    /**
     * The spy behind every error record.
     */
    error: ReturnType<typeof vi.fn>;

    /**
     * The spy behind every warn record.
     */
    warn: ReturnType<typeof vi.fn>;
}

/**
 * Build the counting logger fake a publication scenario injects so its diagnosis records become
 * assertable.
 *
 * @returns The fake logger and its spied level methods.
 */
function countingLoggerFake(): CountingLoggerFake {
    const info = vi.fn();
    const error = vi.fn();
    const warn = vi.fn();
    const logger = { info, error, warn } as unknown as Logger;
    return { logger, info, error, warn };
}

/**
 * The injectable investigation seam a publication scenario needs, typed over the run's own
 * dependency vocabulary.
 */
type ScriptedInvestigation = NonNullable<DefaultSingleIssueDependencies['investigate']>;

/**
 * Build the investigation seam a publication scenario injects: it emits the committed terminal
 * decision shape through the core side channel and returns the no-patch result extended with the
 * prepared-extension provenance and the claimed symptom observation the publication reads.
 *
 * @param symptomObservation - Symptom observation the returned result claims.
 * @returns The investigation seam.
 */
function provenancedInvestigate(symptomObservation: SymptomObservation): ScriptedInvestigation {
    return async (config, issue, options, coreDependencies) => {
        void config;
        void issue;
        void options;
        coreDependencies.onAgentRunArtifacts?.({
            decision: {
                outcome: 'propose_close',
                reproductionStatus: 'not_reproduced',
                summary: 'The report describes a stale build symptom.',
                reasoning: 'The defect is already gone in the current build.',
                policyDecision: { decision: 'allow_rule_generation', reasons: [] },
                evidenceSummary: 'The reported defect no longer reproduces.',
            },
            observations: [],
        });
        return {
            ...processedRunResult(4),
            extensionProvenance: {
                source: PreparedExtensionSource.PinnedRelease,
                extensionPath: '/run/extension',
                manifestVersion: ExtensionManifestVersion.Mv3,
                extensionSourceSha256: 'c'.repeat(64),
                // A real pinned release's tag, `v`-prefixed and never a bare dotted-numeric
                // version; the version-update hint must never compare against this display value.
                extensionSourceTag: 'v4.6.0',
            },
            // The hint compares against the manifest's own dotted-numeric version instead — the
            // same value `agent-runtime.ts` binds from the prepared extension's manifest.
            environmentSelection: {
                kind: 'extension' as const,
                actual: {
                    kind: 'browser_extension' as const,
                    product: 'AdGuard Extension',
                    browser: 'chrome',
                    productVersion: '4.6.0',
                },
            },
            symptomObservation,
        } as unknown as Awaited<ReturnType<ScriptedInvestigation>>;
    };
}

/**
 * Run one comment-enabled issue whose investigation seals with the named status.
 *
 * @param runStatus - The status the scripted investigation seals with.
 * @param octokit - The issue-comment API the run publishes through.
 * @param artifactsDir - Directory the run writes its artifacts to.
 * @returns How the per-issue run sealed.
 */
async function runSealedWithStatus(
    runStatus: FixRunStatus,
    octokit: Octokit,
    artifactsDir: string,
    extra: Partial<FixRunResult> = {},
): ReturnType<typeof runDefaultSingleIssue> {
    const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
    return await runDefaultSingleIssue(
        {
            config: testCoreConfig(),
            slug: { owner: 'remote-owner', repo: 'remote-list' },
            checkoutPath: workspace.localSourcePath,
            issueNumber: 4,
            token: 'test-token',
            commentsEnabled: true,
            screenshotsBranch: 'filters-agent-screenshots',
            artifactsDir,
        },
        {
            preparationDependencies: workspace.dependencies,
            ...extractedReportSeam(),
            octokit,
            investigate: async () => ({ ...processedRunResult(4), runStatus, ...extra }),
            fetchIssue: async (config, issueNumber) => {
                void config;
                return rawIssueFixture(issueNumber);
            },
        },
    );
}

afterEach(removeScratchDirs);

/**
 * Run one issue labelled in progress, forced or not, against a fresh workspace.
 *
 * @param force - Whether the run is forced past the in-progress label.
 * @returns The run result and the issue-comment fake it posted through.
 */
async function runOnInProgressIssue(force: boolean) {
    const workspace = preparedWorkspace({
        localSourceAvailable: true,
        withInstruction: false,
    });
    const octokit = issueCommentOctokit();
    vi.mocked(octokit.rest.issues.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { state: 'open', assignees: [], labels: [{ name: 'a: in progress' }] },
    });
    const result = await runDefaultSingleIssue(
        {
            config: testCoreConfig(),
            slug: { owner: 'remote-owner', repo: 'remote-list' },
            checkoutPath: workspace.localSourcePath,
            issueNumber: 4,
            token: 'test-token',
            commentsEnabled: true,
            screenshotsBranch: 'filters-agent-screenshots',
            inProgressLabels: ['A: In progress'],
            force,
            artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
        },
        {
            preparationDependencies: workspace.dependencies,
            ...extractedReportSeam(),
            octokit,
            investigate: async () => processedRunResult(4),
            fetchIssue: async (config, issueNumber) => {
                void config;
                return rawIssueFixture(issueNumber);
            },
        },
    );
    return { result, octokit };
}

describe('runDefaultSingleIssue', () => {
    it('investigates a checkout-sourced issue with the threaded options and posts no comment when publishing is disabled', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: true });
        const octokit = issueCommentOctokit();
        const artifactsDir = join(scratchDir('single-issue-artifacts-'), 'out');
        const investigated: {
            issueNumber: number;
            artifactsDir: string;
            model?: string;
            instructionPath?: string;
        }[] = [];
        const fetched: { owner: string; repo: string; token: string; issueNumber: number }[] = [];

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                token: 'test-token',
                commentsEnabled: false,
                screenshotsBranch: 'filters-agent-screenshots',
                model: 'deepseek-v4-flash',
                executors: ['browser-extension', 'adguard-desktop'],
                artifactsDir,
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                octokit,
                investigate: (config, issue, options) => {
                    const issueNumber = 'rawIssue' in issue ? issue.rawIssue.number : issue.number;
                    investigated.push({
                        issueNumber,
                        artifactsDir: options.artifactsDir,
                        model: options.model,
                        instructionPath: options.instruction?.path,
                    });
                    expect(config.headless).toBe(true);
                    expect(issue).toMatchObject({ title: 'Ad banner stays visible' });
                    return Promise.resolve(processedRunResult(4));
                },
                fetchIssue: (config, issueNumber) => {
                    fetched.push({
                        owner: config.owner,
                        repo: config.repo,
                        token: config.token,
                        issueNumber,
                    });
                    return Promise.resolve(rawIssueFixture(issueNumber));
                },
            },
        );

        expect(investigated).toHaveLength(1);
        expect(investigated[0]).toEqual({
            issueNumber: 4,
            artifactsDir,
            model: 'deepseek-v4-flash',
            instructionPath: expect.stringContaining('AGENTS.md'),
        });
        expect(fetched).toEqual([
            { owner: 'remote-owner', repo: 'remote-list', token: 'test-token', issueNumber: 4 },
        ]);
        expect(
            vi.mocked(octokit.rest.issues.listComments as unknown as ReturnType<typeof vi.fn>),
        ).not.toHaveBeenCalled();
        expect(
            vi.mocked(octokit.rest.issues.createComment as unknown as ReturnType<typeof vi.fn>),
        ).not.toHaveBeenCalled();
        expect(result.kind).toBe('processed');
        // Comments disabled must not skip writing the report artifacts: the action's noComment
        // description promises the report still lands in the artifacts directory.
        const reportJson = JSON.parse(
            readFileSync(join(artifactsDir, 'report.json'), 'utf8'),
        ) as Record<string, unknown>;
        expect(reportJson).toMatchObject({ verdict: 'filter-report' });
        const renderedReport = readFileSync(join(artifactsDir, 'report-comment.md'), 'utf8');
        expect(renderedReport.length).toBeGreaterThan(0);
        expect(renderedReport).not.toContain(REPORT_COMMENT_MARKER_PREFIX);
        // This fixture's `investigate` seam never calls `onAgentRunArtifacts`, so there is no
        // decision to persist — `agent-run-artifacts.json` is conditionally written and correctly
        // absent here; the version-update-hint tests below exercise the case where it exists.
        expect(
            JSON.parse(readFileSync(join(artifactsDir, 'run-result.json'), 'utf8')) as unknown,
        ).toMatchObject({ issueNumber: 4 });
        expect(
            JSON.parse(readFileSync(join(artifactsDir, 'artifacts-manifest.json'), 'utf8')),
        ).toBeInstanceOf(Array);
    });

    it('threads the configured investigation budget onto the core options and bounds fetchIssue with the shared upstream prompt limits', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        let capturedMaxDurationMs: number | undefined;
        let capturedPromptTextLimits: unknown;

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig({ agentInvestigationBudgetMs: 1_800_000 }),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                commentsEnabled: false,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                investigate: (config, issue, options) => {
                    void config;
                    void issue;
                    capturedMaxDurationMs = options.maxDurationMs;
                    return Promise.resolve(processedRunResult(4));
                },
                fetchIssue: (config, issueNumber, options) => {
                    void config;
                    capturedPromptTextLimits = options?.promptTextLimits;
                    return Promise.resolve(rawIssueFixture(issueNumber));
                },
            },
        );

        expect(result.kind).toBe('processed');
        expect(capturedMaxDurationMs).toBe(1_800_000);
        expect(capturedPromptTextLimits).toBe(AUTOMATIC_UPSTREAM_PROMPT_TEXT_LIMITS);
    });

    it('posts one revision-marked report from the snapshot digest under the slug identity when a token enables comments', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const exported = exportedIssueFixture(4);
        const octokit = issueCommentOctokit();
        const fetched: number[] = [];
        const artifactsDir = join(scratchDir('single-issue-artifacts-'), 'out');
        const actionsRunUrl = 'https://github.com/source-owner/source-list/actions/runs/987654321';

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'source-owner', repo: 'source-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                issueSnapshotPath: exported.issueFile,
                token: 'test-token',
                commentsEnabled: true,
                screenshotsBranch: 'filters-agent-screenshots',
                actionsRunUrl,
                artifactsDir,
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                octokit,
                investigate: (config, issue, options, coreDependencies) => {
                    void config;
                    void options;
                    void issue;
                    coreDependencies.onAgentRunArtifacts?.({
                        decision: {
                            outcome: 'propose_close',
                            reproductionStatus: 'not_reproduced',
                            summary: 'The report describes a stale build symptom.',
                            reasoning: 'The defect is already gone in the current build.',
                            policyDecision: { decision: 'allow_rule_generation', reasons: [] },
                            evidenceSummary: 'The reported defect no longer reproduces.',
                        },
                        observations: [],
                    });
                    return Promise.resolve(processedRunResult(4));
                },
                fetchIssue: (config, issueNumber) => {
                    fetched.push(issueNumber);
                    void config;
                    return Promise.resolve(rawIssueFixture(issueNumber));
                },
            },
        );

        expect(fetched).toEqual([]);
        expect(result.kind).toBe('processed');
        const created = vi.mocked(
            octokit.rest.issues.createComment as unknown as ReturnType<typeof vi.fn>,
        );
        const listed = vi.mocked(
            octokit.rest.issues.listComments as unknown as ReturnType<typeof vi.fn>,
        );
        expect(listed.mock.calls[0][0]).toMatchObject({
            owner: 'source-owner',
            repo: 'source-list',
            issue_number: 4,
        });
        expect(created).toHaveBeenCalledTimes(1);
        const posted = created.mock.calls[0][0].body as string;
        expect(posted.startsWith(REPORT_COMMENT_MARKER_PREFIX)).toBe(true);
        expect(parseReportRevisionMarker(posted)).toEqual({
            schemaVersion: 1,
            revisionDigest: exported.revision.revisionDigest,
        });
        expect(posted).toContain(actionsRunUrl);
        expect(posted).not.toContain(artifactsDir);
        expect(
            posted
                .trimEnd()
                .endsWith(
                    'Posted by a filters agent; a maintainer reviews before anything is merged.</sub>',
                ),
        ).toBe(true);
        expect(result.kind === 'processed' && result.publication).toMatchObject({
            action: 'posted',
            commentUrl: 'https://github.com/remote-owner/remote-list/issues/4#issuecomment-501',
        });
    });

    it('materializes a repositoryless run through the derived remote URL without a local source', async () => {
        const workspace = preparedWorkspace({
            localSourceAvailable: false,
            withInstruction: false,
        });
        const cloneCommands: FiltersCommand[] = [];

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                issueNumber: 4,
                commentsEnabled: false,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                investigate: async () => processedRunResult(4),
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        for (const command of workspace.commands) {
            if (command.executable === 'git' && command.args[0] === 'clone') {
                cloneCommands.push(command);
            }
        }
        expect(cloneCommands).toHaveLength(1);
        expect(cloneCommands[0]?.args).not.toContain('--shared');
        expect(cloneCommands[0]?.args).toContain(REPOSITORY_REMOTE_URL_FIXTURE);
        expect(result.kind).toBe('processed');
    });

    it('resolves the filters default branch from the remote HEAD and fetches it through the same runner', async () => {
        const workspace = preparedWorkspace({
            localSourceAvailable: false,
            withInstruction: false,
        });

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                issueNumber: 4,
                commentsEnabled: false,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                investigate: async () => processedRunResult(4),
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        expect(result.kind).toBe('processed');
        // The one injected runner answers both the resolution and the preparer's fetch, standing in
        // for the production adapter that attaches the derived git credential to git commands.
        expect(workspace.commands[0]).toEqual({
            executable: 'git',
            args: ['ls-remote', '--symref', REPOSITORY_REMOTE_URL_FIXTURE, 'HEAD'],
        });
        const fetchCommands = workspace.commands.filter((command) => command.args[0] === 'fetch');
        expect(fetchCommands).toHaveLength(1);
        expect(fetchCommands[0]?.args).toEqual([
            'fetch',
            '--depth',
            '1',
            '--no-tags',
            REPOSITORY_REMOTE_URL_FIXTURE,
            'main',
        ]);
        expect(workspace.commands.some((command) => command.args.includes('master'))).toBe(false);
    });

    it('threads the request token onto every git command the preparation runner issues', async () => {
        const workspace = preparedWorkspace({
            localSourceAvailable: false,
            withInstruction: false,
        });

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                issueNumber: 4,
                token: 'test-token',
                commentsEnabled: false,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                investigate: async () => processedRunResult(4),
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        expect(result.kind).toBe('processed');
        expect(workspace.commands.length).toBeGreaterThan(0);
        expect(
            workspace.commands.every((command) => command.gitCredentialToken === 'test-token'),
        ).toBe(true);
    });

    it('leaves the preparation git commands untouched when the request carries no token', async () => {
        const workspace = preparedWorkspace({
            localSourceAvailable: false,
            withInstruction: false,
        });

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                issueNumber: 4,
                commentsEnabled: false,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                investigate: async () => processedRunResult(4),
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        expect(result.kind).toBe('processed');
        expect(workspace.commands.length).toBeGreaterThan(0);
        expect(workspace.commands.every((command) => !('gitCredentialToken' in command))).toBe(
            true,
        );
    });

    it('fails named workspace_unavailable with the git output and logs the remote URL when the remote HEAD cannot be resolved', async () => {
        const stderrFixture = 'fatal: could not read from remote repository';
        const workspace = preparedWorkspace({
            localSourceAvailable: false,
            withInstruction: false,
            lsRemoteFailure: { exitCode: 128, stderr: stderrFixture },
        });
        const fakeLogger = countingLoggerFake();
        const investigate = vi.fn(
            async (
                _config: unknown,
                _issue: unknown,
                _options: unknown,
                _coreDependencies: unknown,
            ) => processedRunResult(4),
        );

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                issueNumber: 4,
                commentsEnabled: false,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                logger: fakeLogger.logger,
                investigate: async (config, issue, options, coreDependencies) =>
                    await investigate(config, issue, options, coreDependencies),
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        expect(result.kind).toBe('failed');
        expect(result.kind === 'failed' && result.failureCode).toBe(
            DefaultSingleIssueFailure.WorkspaceUnavailable,
        );
        expect(result.kind === 'failed' && result.failureDetail).toContain(stderrFixture);
        expect(investigate).not.toHaveBeenCalled();
        expect(fakeLogger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                err: expect.any(Error),
                remoteUrl: REPOSITORY_REMOTE_URL_FIXTURE,
            }),
            expect.any(String),
        );
    });

    it('loads the instruction and its linked list document from the materialized workspace of a run without a checkout path', async () => {
        const workspace = preparedWorkspace({
            localSourceAvailable: false,
            withInstruction: false,
        });
        const listDocumentTarget = 'docs/base-rules.md';
        const listDocumentContent = '## Repository list guidance\nRules live under src/base/.';
        const instructionContent = [
            '# Workspace instruction',
            'Investigate the reported defect in this checkout.',
            `[AdGuard syntax guide](${listDocumentTarget})`,
            '',
        ].join('\n');
        mkdirSync(join(workspace.checkoutRoot, 'docs'), { recursive: true });
        writeFileSync(
            join(workspace.checkoutRoot, listDocumentTarget),
            listDocumentContent,
            'utf8',
        );
        mkdirSync(join(workspace.checkoutRoot, dirname(DEFAULT_INSTRUCTION_PATH)), {
            recursive: true,
        });
        writeFileSync(
            join(workspace.checkoutRoot, DEFAULT_INSTRUCTION_PATH),
            instructionContent,
            'utf8',
        );
        const investigated: (LoadedInstruction | undefined)[] = [];

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                issueNumber: 4,
                token: 'test-token',
                commentsEnabled: false,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                investigate: async (config, issue, options) => {
                    void config;
                    void issue;
                    investigated.push(options.instruction);
                    return processedRunResult(4);
                },
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        expect(result.kind).toBe('processed');
        expect(investigated).toHaveLength(1);
        expect(investigated[0]).toBeDefined();
        expect(investigated[0]?.path).toBe(DEFAULT_INSTRUCTION_PATH);
        expect(investigated[0]?.content).toBe(instructionContent);
        expect(investigated[0]?.documents).toHaveLength(1);
        expect(investigated[0]?.documents[0]).toMatchObject({
            role: GuidanceDocumentRole.Syntax,
            origin: GuidanceDocumentOrigin.CheckoutFile,
            url: listDocumentTarget,
            content: listDocumentContent,
        });
    });

    it('fails named when the explicit instruction path is missing, before the investigation runs', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: true });
        const missingPath = 'tmp/never-present/AGENTS.md';
        const investigate = vi.fn(
            async (
                _config: unknown,
                _issue: unknown,
                _options: unknown,
                _coreDependencies: unknown,
            ) => processedRunResult(4),
        );
        const fetchNamedIssue = vi.fn(async (config: unknown, issueNumber: number) => {
            void config;
            return rawIssueFixture(issueNumber);
        });

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                instructionPath: missingPath,
                commentsEnabled: false,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                investigate: async (config, issue, options, coreDependencies) =>
                    await investigate(config, issue, options, coreDependencies),
                fetchIssue: async (config, issueNumber) =>
                    await fetchNamedIssue(config, issueNumber),
            },
        );

        expect(result.kind).toBe('failed');
        expect(result.kind === 'failed' && result.failureCode).toBe(
            DefaultSingleIssueFailure.InstructionUnavailable,
        );
        expect(result.kind === 'failed' && result.failureDetail).toContain('AGENTS.md');
        expect(investigate).not.toHaveBeenCalled();
        expect(fetchNamedIssue).not.toHaveBeenCalled();
    });

    it('runs default mode with no instruction when the checkout carries none and no override is supplied', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const capturedInstructionPaths: (string | undefined)[] = [];

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                commentsEnabled: false,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                investigate: async (config, issue, options) => {
                    void config;
                    void issue;
                    capturedInstructionPaths.push(options.instruction?.path);
                    return processedRunResult(4);
                },
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        expect(capturedInstructionPaths).toEqual([undefined]);
        expect(result.kind).toBe('processed');
    });

    it('hands the investigation the extracted report facts on the fetch path', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const bareIssues: RawIssue[] = [];
        const investigatedIssues: FixCoreIssueInput[] = [];
        const investigatedOptions: FixCoreOptions[] = [];

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                commentsEnabled: false,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                investigate: async (config, issue, options) => {
                    void config;
                    investigatedIssues.push(issue);
                    investigatedOptions.push(options);
                    return processedRunResult(4);
                },
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    const bare = rawIssueFixture(issueNumber);
                    bareIssues.push(bare);
                    return bare;
                },
            },
        );

        expect(result.kind).toBe('processed');
        expect(investigatedIssues).toHaveLength(1);
        expect(investigatedIssues[0]).not.toBe(bareIssues[0]);
        expect(investigatedIssues[0]?.facts?.reportedSiteUrls).toEqual([
            'https://example.com/watch?v=1',
        ]);
        // Without an instruction the investigation gets the default guidance loader; it is called
        // only once the investigation starts, so a skipped issue never downloads it.
        expect(investigatedOptions[0]?.instruction).toBeUndefined();
        expect(investigatedOptions[0]?.loadDefaultRuleGuidance).toBeTypeOf('function');
    });

    it('hands the investigation the extracted report facts on the snapshot path', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const exported = exportedIssueFixture(4);
        const investigatedIssues: FixCoreIssueInput[] = [];

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'source-owner', repo: 'source-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                issueSnapshotPath: exported.issueFile,
                commentsEnabled: false,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                investigate: async (config, issue, options) => {
                    void config;
                    void options;
                    investigatedIssues.push(issue);
                    return processedRunResult(4);
                },
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        expect(result.kind).toBe('processed');
        expect(investigatedIssues).toHaveLength(1);
        expect('facts' in (investigatedIssues[0] ?? {})).toBe(true);
        expect(investigatedIssues[0]?.facts?.reportedSiteUrls).toEqual([
            'https://example.com/watch?v=1',
        ]);
    });

    it('seals the run skipped without posting, even with comments enabled, when intake extraction skips the issue', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const octokit = issueCommentOctokit();
        const investigate = vi.fn(
            async (
                _config: unknown,
                _issue: unknown,
                _options: unknown,
                _coreDependencies: unknown,
            ) => processedRunResult(4),
        );
        const artifactsDir = join(scratchDir('single-issue-artifacts-'), 'out');

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                token: 'test-token',
                commentsEnabled: true,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir,
            },
            {
                preparationDependencies: workspace.dependencies,
                octokit,
                extractReport: scriptedExtractReport({
                    kind: IntakeExtractionKind.Skipped,
                    reason: 'No filtering defect detected',
                }),
                investigate: async (config, issue, options, coreDependencies) =>
                    await investigate(config, issue, options, coreDependencies),
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        // A skip is a successful outcome, not a failure: the caller exits zero.
        expect(result.kind).toBe('skipped');
        expect(result.kind === 'skipped' && result.reason).toBe('No filtering defect detected');
        expect(result.kind === 'skipped' && result.publication).toBeNull();
        expect(investigate).not.toHaveBeenCalled();
        // A skip is not a finding the issue needs: the reason stays in the artifacts only.
        expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
        const reportJson = JSON.parse(
            readFileSync(join(artifactsDir, 'report.json'), 'utf8'),
        ) as Record<string, unknown>;
        expect(reportJson).toMatchObject({
            verdict: 'not-a-filter-report',
            reason: 'No filtering defect detected',
        });
    });

    it('refuses a file-backed verification instruction before the issue is fetched or extracted', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const instructionContent = [
            '## Rule application',
            '',
            'Apply exactly these steps, invent none:',
            '',
            '1. Append the candidate rule to the maintained file.',
            '',
            '## State verification',
            '',
            'The host reads the blocker state back itself:',
            '',
            'read: user-rules-file filters-agent/ubol/custom-filters.txt',
        ].join('\n');
        mkdirSync(join(workspace.checkoutRoot, dirname(DEFAULT_INSTRUCTION_PATH)), {
            recursive: true,
        });
        writeFileSync(
            join(workspace.checkoutRoot, DEFAULT_INSTRUCTION_PATH),
            instructionContent,
            'utf8',
        );
        const fetchIssueSpy = vi.fn(async (config: unknown, issueNumber: number) => {
            void config;
            return rawIssueFixture(issueNumber);
        });
        const extractReportSpy = vi.fn(async () => {
            throw new Error('extraction must never be reached for a file-backed instruction');
        });

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                commentsEnabled: false,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
            },
            {
                preparationDependencies: workspace.dependencies,
                extractReport: extractReportSpy,
                fetchIssue: fetchIssueSpy,
            },
        );

        expect(result.kind).toBe('failed');
        expect(result.kind === 'failed' && result.failureCode).toBe(
            DefaultSingleIssueFailure.FileBackedApplicationUnsupported,
        );
        expect(result.kind === 'failed' && result.failureDetail).toContain('user-rules-file');
        expect(fetchIssueSpy).not.toHaveBeenCalled();
        expect(extractReportSpy).not.toHaveBeenCalled();
    });

    it('fails named issue_unavailable when the intake extraction seam throws', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const investigate = vi.fn(
            async (
                _config: unknown,
                _issue: unknown,
                _options: unknown,
                _coreDependencies: unknown,
            ) => processedRunResult(4),
        );

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                commentsEnabled: false,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
            },
            {
                preparationDependencies: workspace.dependencies,
                extractReport: vi.fn(async () => {
                    throw new Error('provider unreachable');
                }),
                investigate: async (config, issue, options, coreDependencies) =>
                    await investigate(config, issue, options, coreDependencies),
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        expect(result.kind).toBe('failed');
        expect(result.kind === 'failed' && result.failureCode).toBe(
            DefaultSingleIssueFailure.IssueUnavailable,
        );
        expect(result.kind === 'failed' && result.failureDetail).toContain('provider unreachable');
        expect(investigate).not.toHaveBeenCalled();
    });

    it('posts no comment for an extraction failure, even with comments enabled, and keeps its report in the artifacts', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const octokit = issueCommentOctokit();
        const artifactsDir = join(scratchDir('single-issue-artifacts-'), 'out');

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                token: 'test-token',
                commentsEnabled: true,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir,
            },
            {
                preparationDependencies: workspace.dependencies,
                octokit,
                extractReport: vi.fn(async () => {
                    throw new Error('provider unreachable');
                }),
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        expect(result.kind).toBe('failed');
        // The provider's raw error is no finding the issue's reporter can act on: it stays in the
        // run's own records, and the issue gets no comment.
        expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
        const renderedReport = readFileSync(join(artifactsDir, 'report-comment.md'), 'utf8');
        expect(renderedReport).toContain('Intake extraction failed');
    });

    it('posts no comment for an investigation failure, even with comments enabled, and keeps its report in the artifacts', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const octokit = issueCommentOctokit();
        const artifactsDir = join(scratchDir('single-issue-artifacts-'), 'out');

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                token: 'test-token',
                commentsEnabled: true,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir,
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                octokit,
                investigate: async () => {
                    throw new Error('agent session crashed');
                },
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        expect(result.kind === 'failed' && result.failureCode).toBe(
            DefaultSingleIssueFailure.InvestigationFailed,
        );
        expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
        const renderedReport = readFileSync(join(artifactsDir, 'report-comment.md'), 'utf8');
        expect(renderedReport).toContain('The investigation failed');
    });

    it('posts the report of a sealed finding that carries no verified change', async () => {
        const octokit = issueCommentOctokit();
        const artifactsDir = join(scratchDir('single-issue-artifacts-'), 'out');

        const result = await runSealedWithStatus(FixRunStatus.AnalysisOnly, octokit, artifactsDir);

        expect(result.kind === 'processed' && result.publication).toMatchObject({
            action: 'posted',
        });
        expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    });

    it('posts a downgraded candidate for review without the verified screenshots of a rule it does not publish', async () => {
        // A polytranslator.com run: the safety gate downgraded a verified draft, and the
        // comment showed "Without and with the rule" with no rule and no reason beside it.
        const artifactsDir = join(scratchDir('single-issue-artifacts-'), 'out');
        const shotsDir = scratchDir('single-issue-shots-');
        const shot = (name: string): string => {
            const path = join(shotsDir, `${name}.png`);
            writeFileSync(path, name);
            return path;
        };
        const candidateForReview = {
            rule: "example.com#%#//scriptlet('set-constant', 'nitroAds.abp', 'true')",
            placement: { filePath: 'BaseFilter/sections/antiadblock.txt' },
            unverifiedReason: 'Candidate rule already exists in the checkout.',
        };
        const issueOctokit = issueCommentOctokit();
        const octokit = {
            ...issueOctokit,
            rest: {
                ...issueOctokit.rest,
                git: {
                    getRef: vi
                        .fn()
                        .mockRejectedValue(Object.assign(new Error('no'), { status: 404 })),
                    createBlob: vi.fn().mockResolvedValue({ data: { sha: 'b'.repeat(40) } }),
                    createTree: vi.fn().mockResolvedValue({ data: { sha: 't'.repeat(40) } }),
                    createCommit: vi.fn().mockResolvedValue({ data: { sha: 'c'.repeat(40) } }),
                    createRef: vi.fn().mockResolvedValue({ data: {} }),
                },
            },
        } as unknown as Octokit;
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                token: 'test-token',
                commentsEnabled: true,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir,
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                octokit,
                investigate: async () => ({
                    ...processedRunResult(4),
                    runStatus: FixRunStatus.AnalysisOnly,
                    candidateForReview,
                    artifactPaths: {
                        screenshots: [],
                        domSnapshot: null,
                        har: null,
                        trace: null,
                        verifiedCandidateScreenshots: {
                            before: shot('before'),
                            after: shot('after'),
                            beforeFullPage: shot('before-full'),
                            afterFullPage: shot('after-full'),
                        },
                    },
                }),
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        expect(result.kind === 'processed' && result.publication).toMatchObject({
            action: 'posted',
        });
        const posted = vi.mocked(octokit.rest.issues.createComment).mock.calls[0]?.[0]?.body;
        expect(posted).toContain(candidateForReview.rule);
        expect(posted).toContain(candidateForReview.unverifiedReason);
        expect(posted).not.toContain('Without and with the rule');
    });

    it.each([
        [FixRunStatus.UnsupportedProductCase, 'Unsupported reported product case'],
        [FixRunStatus.TargetUrlUnavailable, 'The reported target URL was unreachable'],
    ])(
        'posts no comment for a sealed %s outcome that could not investigate, and keeps its report in the artifacts',
        async (runStatus, outcomeLine) => {
            const octokit = issueCommentOctokit();
            const artifactsDir = join(scratchDir('single-issue-artifacts-'), 'out');

            const result = await runSealedWithStatus(runStatus, octokit, artifactsDir);

            // Sealed, not failed: the run did its job and the caller exits zero, only silently.
            expect(result.kind).toBe('processed');
            expect(result.kind === 'processed' && result.publication).toBeNull();
            expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
            const renderedReport = readFileSync(join(artifactsDir, 'report-comment.md'), 'utf8');
            expect(renderedReport).toContain(outcomeLine);
        },
    );

    it('posts a capability-limited run that still proposed a candidate for review', async () => {
        // The environment could not verify the candidate, the run sealed capability-limited, and
        // the candidate must still reach the reader, not only the artifacts.
        const octokit = issueCommentOctokit();
        const artifactsDir = join(scratchDir('single-issue-artifacts-'), 'out');
        const candidateForReview = {
            rule: 'example.com##aside[class^="CookieAcceptation"]',
            placement: { filePath: 'AnnoyancesFilter/Cookies/sections/cookies_specific.txt' },
            unverifiedReason: 'apply_rule could not run the before/after experiment.',
        };

        const result = await runSealedWithStatus(
            FixRunStatus.CapabilityLimited,
            octokit,
            artifactsDir,
            { candidateForReview },
        );

        expect(result.kind === 'processed' && result.publication).toMatchObject({
            action: 'posted',
        });
        const posted = vi.mocked(octokit.rest.issues.createComment).mock.calls[0]?.[0]?.body;
        expect(posted).toContain(candidateForReview.rule);
        // Not under the status line of a run that could not investigate: it reads as the
        // analysis-only candidate it is.
        expect(posted).toContain('Analysis-only findings, no verified change');
        expect(posted).not.toContain('Missing environment capability limited the run');
    });

    it('renders the version-update hint for an older reported version with a not-reproduced symptom', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const octokit = issueCommentOctokit();
        const fakeLogger = countingLoggerFake();
        const artifactsDir = join(scratchDir('single-issue-artifacts-'), 'out');

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                token: 'test-token',
                commentsEnabled: true,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir,
            },
            {
                preparationDependencies: workspace.dependencies,
                extractReport: scriptedExtractReport({
                    kind: IntakeExtractionKind.Report,
                    report: fixtureReport('4.1.2'),
                }),
                logger: fakeLogger.logger,
                octokit,
                investigate: provenancedInvestigate(SymptomObservation.NotReproduced),
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        expect(result.kind).toBe('processed');
        const created = vi.mocked(
            octokit.rest.issues.createComment as unknown as ReturnType<typeof vi.fn>,
        );
        expect(created).toHaveBeenCalledTimes(1);
        const posted = created.mock.calls[0][0].body as string;
        // The reported version reaches the comment only through the hint render, so it is the
        // distinguishing marker; the extension version pins the hint's second version, and doubles
        // as the always-rendered executor version.
        expect(posted).toContain('4.1.2');
        expect(posted).toContain('4.6.0');
        // A decision exists on this path (the fixture calls onAgentRunArtifacts), so the full
        // artifact set — the decision file included — lands beside the report.
        expect(
            JSON.parse(readFileSync(join(artifactsDir, 'agent-run-artifacts.json'), 'utf8')),
        ).toMatchObject({ decision: { outcome: 'propose_close' } });
    });

    it('logs one diagnosis record for an unparseable reported version and no hint', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const octokit = issueCommentOctokit();
        const fakeLogger = countingLoggerFake();

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                token: 'test-token',
                commentsEnabled: true,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
            },
            {
                preparationDependencies: workspace.dependencies,
                extractReport: scriptedExtractReport({
                    kind: IntakeExtractionKind.Report,
                    report: fixtureReport('nightly'),
                }),
                logger: fakeLogger.logger,
                octokit,
                investigate: provenancedInvestigate(SymptomObservation.NotReproduced),
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        expect(result.kind).toBe('processed');
        const created = vi.mocked(
            octokit.rest.issues.createComment as unknown as ReturnType<typeof vi.fn>,
        );
        expect(created).toHaveBeenCalledTimes(1);
        const posted = created.mock.calls[0][0].body as string;
        // Wording-independent hint distinction: an unparseable version leaves the comment without
        // the hint, so the reported version renders nowhere in the posted body.
        expect(posted).not.toContain('nightly');
        expect(fakeLogger.info).toHaveBeenCalledTimes(1);
        expect(fakeLogger.info.mock.calls[0][0]).toMatchObject({ reportedVersion: 'nightly' });
    });

    it('logs one diagnosis record for a reproduced symptom and no hint', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const octokit = issueCommentOctokit();
        const fakeLogger = countingLoggerFake();

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                token: 'test-token',
                commentsEnabled: true,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
            },
            {
                preparationDependencies: workspace.dependencies,
                extractReport: scriptedExtractReport({
                    kind: IntakeExtractionKind.Report,
                    report: fixtureReport('4.1.2'),
                }),
                logger: fakeLogger.logger,
                octokit,
                investigate: provenancedInvestigate(SymptomObservation.Reproduced),
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        expect(result.kind).toBe('processed');
        const created = vi.mocked(
            octokit.rest.issues.createComment as unknown as ReturnType<typeof vi.fn>,
        );
        expect(created).toHaveBeenCalledTimes(1);
        const posted = created.mock.calls[0][0].body as string;
        // Wording-independent hint distinction: the reproduced symptom drops the hint, so the
        // reported version renders nowhere in the posted body.
        expect(posted).not.toContain('4.1.2');
        expect(fakeLogger.info).toHaveBeenCalledTimes(1);
    });

    it('seals the run failed with the platform message when the report comment write is refused', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const octokit = refusedCommentOctokit();
        const artifactsDir = join(scratchDir('single-issue-artifacts-'), 'out');

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                token: 'test-token',
                commentsEnabled: true,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir,
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                octokit,
                investigate: async () => processedRunResult(4),
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        const created = vi.mocked(
            octokit.rest.issues.createComment as unknown as ReturnType<typeof vi.fn>,
        );
        expect(created).toHaveBeenCalledTimes(1);
        expect(result.kind).toBe('failed');
        expect(result.kind === 'failed' && result.failureCode).toBe(
            DefaultSingleIssueFailure.PublicationFailed,
        );
        expect(result.kind === 'failed' && result.failureDetail).toContain(PLATFORM_WRITE_REFUSAL);
    });

    it('skips the run before intake when a report for this revision is already posted', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const slug = { owner: 'remote-owner', repo: 'remote-list' };
        const octokit = issueCommentOctokit();
        const marker = renderReportRevisionMarker({
            schemaVersion: 1,
            revisionDigest: fetchedIssueRevisionDigest(rawIssueFixture(4), slug),
        });
        vi.mocked(
            octokit.rest.issues.listComments as unknown as ReturnType<typeof vi.fn>,
        ).mockResolvedValue({
            data: [
                {
                    id: 77,
                    body: `${marker}\nEarlier report.`,
                    html_url:
                        'https://github.com/remote-owner/remote-list/issues/4#issuecomment-77',
                    user: { login: 'agent-bot' },
                },
            ],
        });
        const seam = extractedReportSeam();
        const investigate = vi.fn();

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug,
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                token: 'test-token',
                commentsEnabled: true,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
            },
            {
                preparationDependencies: workspace.dependencies,
                ...seam,
                octokit,
                investigate,
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        expect(result.kind).toBe('skipped');
        expect(result.kind === 'skipped' && result.publication).toMatchObject({
            action: 'already_reported',
            commentId: 77,
        });
        expect(seam.extractReport).not.toHaveBeenCalled();
        expect(investigate).not.toHaveBeenCalled();
        expect(
            octokit.rest.issues.createComment as unknown as ReturnType<typeof vi.fn>,
        ).not.toHaveBeenCalled();
    });

    it('skips the run before intake when a maintainer already commented on the issue', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const octokit = issueCommentOctokit();
        vi.mocked(octokit.paginate as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
            {
                event: 'commented',
                id: 9,
                created_at: '2026-10-05T10:00:00Z',
                user: { login: 'maintainer', type: 'User' },
                author_association: 'MEMBER',
            },
        ]);
        const seam = extractedReportSeam();

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                token: 'test-token',
                commentsEnabled: true,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
            },
            {
                preparationDependencies: workspace.dependencies,
                ...seam,
                octokit,
                investigate: vi.fn(),
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        expect(result.kind).toBe('skipped');
        expect(result.kind === 'skipped' && result.reason).toContain('comment 9 by maintainer');
        expect(result.kind === 'skipped' && result.publication).toBeNull();
        expect(seam.extractReport).not.toHaveBeenCalled();
    });

    it('keeps the report silent when the issue was closed while the run worked', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const octokit = issueCommentOctokit();
        vi.mocked(octokit.rest.issues.get as unknown as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce({ data: { state: 'open', assignees: [], labels: [] } })
            .mockResolvedValueOnce({
                data: {
                    state: 'closed',
                    state_reason: 'completed',
                    closed_at: '2026-10-05T11:00:00Z',
                    closed_by: { login: 'maintainer' },
                    assignees: [],
                    labels: [],
                },
            });

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                token: 'test-token',
                commentsEnabled: true,
                screenshotsBranch: 'filters-agent-screenshots',
                artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                octokit,
                investigate: async () => processedRunResult(4),
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        expect(result.kind).toBe('processed');
        expect(result.kind === 'processed' && result.publication).toBeNull();
        expect(
            octokit.rest.issues.createComment as unknown as ReturnType<typeof vi.fn>,
        ).not.toHaveBeenCalled();
    });

    it('skips an issue with an excluded label before intake, even with comments disabled', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const seam = extractedReportSeam();
        const investigate = vi.fn();

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                commentsEnabled: false,
                screenshotsBranch: 'filters-agent-screenshots',
                excludedLabels: ['NSFW'],
                artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
            },
            {
                preparationDependencies: workspace.dependencies,
                ...seam,
                investigate,
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return { ...rawIssueFixture(issueNumber), labels: ['T: Ads', 'nsfw'] };
                },
            },
        );

        expect(result.kind).toBe('skipped');
        expect(result.kind === 'skipped' && result.reason).toContain('"nsfw"');
        expect(result.kind === 'skipped' && result.publication).toBeNull();
        expect(seam.extractReport).not.toHaveBeenCalled();
        expect(investigate).not.toHaveBeenCalled();
    });

    it('keeps the report silent when an excluded label was added while the run worked', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const octokit = issueCommentOctokit();
        vi.mocked(octokit.rest.issues.get as unknown as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce({ data: { state: 'open', assignees: [], labels: [] } })
            .mockResolvedValueOnce({
                data: { state: 'open', assignees: [], labels: [{ name: 'NSFW' }] },
            });

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                token: 'test-token',
                commentsEnabled: true,
                screenshotsBranch: 'filters-agent-screenshots',
                excludedLabels: ['NSFW'],
                artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                octokit,
                investigate: async () => processedRunResult(4),
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        expect(result.kind).toBe('processed');
        expect(result.kind === 'processed' && result.publication).toBeNull();
        expect(
            octokit.rest.issues.createComment as unknown as ReturnType<typeof vi.fn>,
        ).not.toHaveBeenCalled();
    });

    it('runs and posts a forced report on an issue a maintainer is assigned to and commented on', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const octokit = issueCommentOctokit();
        vi.mocked(octokit.rest.issues.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
            {
                data: { state: 'open', assignees: [{ login: 'maintainer' }], labels: [] },
            },
        );
        vi.mocked(octokit.paginate as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
            {
                event: 'commented',
                id: 9,
                created_at: '2026-10-05T10:00:00Z',
                user: { login: 'maintainer', type: 'User' },
                author_association: 'MEMBER',
            },
        ]);

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                token: 'test-token',
                commentsEnabled: true,
                screenshotsBranch: 'filters-agent-screenshots',
                force: true,
                artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                octokit,
                investigate: async () => processedRunResult(4),
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        expect(result.kind).toBe('processed');
        expect(result.kind === 'processed' && result.publication).toMatchObject({
            commentId: 501,
        });
        expect(
            octokit.rest.issues.createComment as unknown as ReturnType<typeof vi.fn>,
        ).toHaveBeenCalledTimes(1);
    });

    it('keeps a forced report silent when the issue was closed while the run worked', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const octokit = issueCommentOctokit();
        vi.mocked(octokit.rest.issues.get as unknown as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce({
                data: { state: 'open', assignees: [{ login: 'maintainer' }], labels: [] },
            })
            .mockResolvedValueOnce({
                data: {
                    state: 'closed',
                    state_reason: 'completed',
                    closed_at: '2026-10-05T11:00:00Z',
                    closed_by: { login: 'maintainer' },
                    assignees: [{ login: 'maintainer' }],
                    labels: [],
                },
            });

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                token: 'test-token',
                commentsEnabled: true,
                screenshotsBranch: 'filters-agent-screenshots',
                force: true,
                artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                octokit,
                investigate: async () => processedRunResult(4),
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        expect(result.kind).toBe('processed');
        expect(result.kind === 'processed' && result.publication).toBeNull();
        expect(
            octokit.rest.issues.createComment as unknown as ReturnType<typeof vi.fn>,
        ).not.toHaveBeenCalled();
    });

    it('skips an issue labelled in progress before intake, unless the run is forced', async () => {
        const unforced = await runOnInProgressIssue(false);
        const forced = await runOnInProgressIssue(true);

        expect(unforced.result.kind).toBe('skipped');
        expect(unforced.result.kind === 'skipped' && unforced.result.reason).toContain(
            'labelled "a: in progress"',
        );
        expect(forced.result.kind).toBe('processed');
        expect(
            forced.octokit.rest.issues.createComment as unknown as ReturnType<typeof vi.fn>,
        ).toHaveBeenCalledTimes(1);
    });

    it('reports on an issue a configured report bot commented on as MEMBER, withholding its comments from the fetch', async () => {
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const octokit = issueCommentOctokit();
        vi.mocked(octokit.paginate as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
            {
                event: 'commented',
                id: 9,
                created_at: '2026-10-05T10:00:00Z',
                user: { login: 'reporting-bot', type: 'User' },
                author_association: 'MEMBER',
            },
        ]);
        const fetchIssue = vi.fn(async (_config: unknown, issueNumber: number) =>
            rawIssueFixture(issueNumber),
        );

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                token: 'test-token',
                commentsEnabled: true,
                screenshotsBranch: 'filters-agent-screenshots',
                reportBots: ['reporting-bot'],
                artifactsDir: join(scratchDir('single-issue-artifacts-'), 'out'),
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                octokit,
                investigate: async () => processedRunResult(4),
                fetchIssue,
            },
        );

        expect(result.kind).toBe('processed');
        expect(
            octokit.rest.issues.createComment as unknown as ReturnType<typeof vi.fn>,
        ).toHaveBeenCalledTimes(1);
        expect(fetchIssue).toHaveBeenCalledWith(
            expect.anything(),
            4,
            expect.objectContaining({ reportBots: ['reporting-bot'] }),
        );
    });
});
