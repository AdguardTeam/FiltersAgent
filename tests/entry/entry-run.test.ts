import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '../../src/config/config-error';
import { AgentRunMode } from '../../src/entry/entry-inputs';
import { renderReportRevisionMarker } from '../../src/publisher/report-publisher';
import {
    AgentEntryExitCode,
    AgentEntryStatus,
    runFiltersAgentEntry,
} from '../../src/entry/entry-run';
import type {
    DefaultSingleIssueRequest,
    DefaultSingleIssueResult,
    FailedDefaultSingleIssue,
    ProcessedDefaultSingleIssue,
} from '../../src/entry/single-issue-run-types';
import {
    DefaultSingleIssueFailure,
    DefaultSingleIssueResultKind,
} from '../../src/entry/single-issue-run-types';
import type { BacklogIssueReader, BacklogIssueSummary } from '../../src/queue/backlog-reader';
import { BacklogIssueReadError } from '../../src/queue/backlog-reader';
import type { CoreConfig } from '../../src/config/config';
import { testCoreConfig } from '../config/test-core-config';

/**
 * Directories created for the running scenario, removed after each test.
 */
const createdDirs: string[] = [];

/**
 * Create one throwaway directory for the running scenario.
 *
 * @param prefix - Directory name prefix.
 * @returns Absolute path to the created directory.
 */
function scratchDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    createdDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/**
 * Build one stable processed per-issue outcome for the named number.
 *
 * @param issueNumber - Issue the run sealed.
 * @param artifactsDir - Directory the run's artifacts landed in.
 * @returns Complete processed outcome in the no-patch half.
 */
function processedOutcome(issueNumber: number, artifactsDir: string): ProcessedDefaultSingleIssue {
    return {
        kind: DefaultSingleIssueResultKind.Processed,
        issueNumber,
        runResult: {
            issueNumber,
            domain: 'example.com',
            runStatus: 'not_reproduced',
            requestedBrowserMode: 'auto',
            effectiveMode: 'browser',
            verificationStatus: 'not_attempted',
            fallbackReason: null,
            fallbackDetail: null,
            candidatePatch: null,
            artifactPaths: { screenshots: [], domSnapshot: null, har: null, trace: null },
            reasoning: 'The reported symptom was absent.',
            repository: null,
            baseSha: null,
        },
        publication: null,
        artifactsDir,
    };
}

/**
 * Build one failed per-issue outcome for the named number.
 *
 * @param issueNumber - Issue the run was asked to process.
 * @param failureCode - The stable failure stage.
 * @returns The typed failed outcome.
 */
function failedOutcome(
    issueNumber: number,
    failureCode: DefaultSingleIssueFailure,
): FailedDefaultSingleIssue {
    return {
        kind: DefaultSingleIssueResultKind.Failed,
        issueNumber,
        failureCode,
        failureDetail: `fixture failure for issue ${String(issueNumber)}`,
    };
}

/**
 * Build one run-issue seam scripted by call index, recording every request in order.
 *
 * @param script - Outcome per call index.
 * @returns The seam and its recorded requests.
 */
function runIssueSeam(
    script: (
        callIndex: number,
        request: DefaultSingleIssueRequest,
    ) => Promise<DefaultSingleIssueResult>,
): {
    runIssue: (request: DefaultSingleIssueRequest) => Promise<DefaultSingleIssueResult>;
    requests: DefaultSingleIssueRequest[];
} {
    const requests: DefaultSingleIssueRequest[] = [];
    let callIndex = 0;
    return {
        requests,
        runIssue: (request) => {
            requests.push(request);
            const current = callIndex;
            callIndex += 1;
            return script(current, request);
        },
    };
}

/**
 * Build one in-memory backlog reader whose listing can fail programmatically.
 *
 * @param summaries - Open-issue summaries in newest-first order.
 * @param options - Optional listing failure injected at the seam.
 * @returns The reader with spies over its two reads.
 */
function fakeBacklogReader(
    summaries: BacklogIssueSummary[],
    options: { listingError?: BacklogIssueReadError } = {},
): BacklogIssueReader & {
    readOpenIssuePage: ReturnType<typeof vi.fn>;
    readIssueHistory: ReturnType<typeof vi.fn>;
} {
    return {
        readOpenIssuePage: vi.fn(async () => {
            if (options.listingError) {
                throw options.listingError;
            }
            return { summaries, hasMore: false };
        }),
        readIssueHistory: vi.fn(async (summary: BacklogIssueSummary) => ({
            summary,
            comments: [],
        })),
    };
}

/**
 * One newest-first open-issue summary fixture.
 *
 * @param issueNumber - Issue number the summary carries.
 * @returns The validated-shape summary.
 */
function openIssueSummary(issueNumber: number): BacklogIssueSummary {
    return {
        issueNumber,
        createdAt: '2026-09-09T08:00:00.000Z',
        updatedAt: '2026-09-09T09:00:00.000Z',
        labels: [],
        reporterAuthor: 'reporter',
        commentCount: 0,
    };
}

/**
 * One newest-first open-issue summary fixture carrying explicit labels and update time.
 *
 * @param issueNumber - Issue number the summary carries.
 * @param labels - Labels the issue carries.
 * @param updatedAt - Last-updated timestamp; defaults to the same fixed instant every other fixture
 *   in this file uses.
 * @returns The validated-shape summary.
 */
function openIssueSummaryWithLabels(
    issueNumber: number,
    labels: string[],
    updatedAt: string = '2026-09-09T09:00:00.000Z',
): BacklogIssueSummary {
    return {
        issueNumber,
        createdAt: '2026-09-09T08:00:00.000Z',
        updatedAt,
        labels,
        reporterAuthor: 'reporter',
        commentCount: 0,
    };
}

/**
 * Complete single-issue run inputs pointing the artifacts at a scratch directory.
 *
 * @returns Validated-shape single-issue inputs.
 */
function singleIssueInputs(): {
    config: CoreConfig;
    slug: { owner: string; repo: string };
    mode: { kind: typeof AgentRunMode.SingleIssue; issueNumber: number };
    comments: { enabled: false; screenshotsBranch: string };
    artifactsDir: string;
} {
    return {
        config: testCoreConfig(),
        slug: { owner: 'example', repo: 'list' },
        mode: { kind: AgentRunMode.SingleIssue, issueNumber: 4 },
        comments: { enabled: false, screenshotsBranch: 'filters-agent-screenshots' },
        artifactsDir: join(scratchDir('entry-run-single-'), 'out'),
    };
}

/**
 * Complete backlog run inputs pointing the artifacts at a scratch directory.
 *
 * @param limit - Backlog limit the mode carries.
 * @returns Validated-shape backlog inputs.
 */
function backlogInputs(limit: number): {
    config: CoreConfig;
    slug: { owner: string; repo: string };
    mode: { kind: typeof AgentRunMode.Backlog; limit: number };
    comments: { enabled: true; token: string; screenshotsBranch: string };
    artifactsDir: string;
} {
    return {
        config: testCoreConfig(),
        slug: { owner: 'example', repo: 'list' },
        mode: { kind: AgentRunMode.Backlog, limit },
        comments: {
            enabled: true,
            token: 'test-token',
            screenshotsBranch: 'filters-agent-screenshots',
        },
        artifactsDir: join(scratchDir('entry-run-backlog-'), 'out'),
    };
}

/**
 * Read one written `entry-result.json` from an artifacts directory.
 *
 * @param artifactsDir - Directory the entry wrote its result into.
 * @returns The parsed result file.
 */
function readEntryResultFile(artifactsDir: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(artifactsDir, 'entry-result.json'), 'utf8')) as Record<
        string,
        unknown
    >;
}

describe('runFiltersAgentEntry', () => {
    it('short-circuits invalid inputs before any seam is touched', async () => {
        const seam = runIssueSeam(async (_index, request) =>
            processedOutcome(request.issueNumber, request.artifactsDir),
        );
        const reader = fakeBacklogReader([]);

        const missingArtifactsRun = (): unknown =>
            runFiltersAgentEntry(
                {
                    config: testCoreConfig(),
                    slug: { owner: 'example', repo: 'list' },
                    mode: { kind: AgentRunMode.Backlog, limit: 2 },
                    comments: { enabled: false, screenshotsBranch: 'filters-agent-screenshots' },
                } as never,
                { runIssue: seam.runIssue, backlogIssueReader: reader },
            );
        expect(missingArtifactsRun).toThrow(ConfigError);
        expect(missingArtifactsRun).toThrow('--output-dir');

        const structurallyInvalidRun = (): unknown =>
            runFiltersAgentEntry(
                { config: testCoreConfig(), slug: { owner: 'example', repo: 'list' } } as never,
                { runIssue: seam.runIssue, backlogIssueReader: reader },
            );
        expect(structurallyInvalidRun).toThrow(ConfigError);

        expect(seam.requests).toHaveLength(0);
        expect(reader.readOpenIssuePage).not.toHaveBeenCalled();
        expect(reader.readIssueHistory).not.toHaveBeenCalled();
    });

    it('runs a single issue through the per-issue seam with every threaded option', async () => {
        const seam = runIssueSeam(async (_index, request) =>
            processedOutcome(request.issueNumber, request.artifactsDir),
        );
        const inputs = {
            ...singleIssueInputs(),
            mode: { kind: AgentRunMode.SingleIssue, issueNumber: 4, force: true },
            checkoutPath: '/tmp/forks/list',
            comments: {
                enabled: true,
                token: 'test-token',
                screenshotsBranch: 'filters-agent-screenshots',
            },
            model: 'deepseek-v4-flash',
            executors: ['browser-extension', 'adguard-desktop'],
            instructionPath: 'tmp/instructions/run.md',
            excludedLabels: ['NSFW'],
            inProgressLabels: ['A: In progress'],
            reportBots: ['adguard-bot'],
        };

        const result = await runFiltersAgentEntry(inputs, { runIssue: seam.runIssue });

        expect(seam.requests).toHaveLength(1);
        expect(seam.requests[0]).toEqual({
            config: inputs.config,
            slug: { owner: 'example', repo: 'list' },
            checkoutPath: '/tmp/forks/list',
            issueNumber: 4,
            token: 'test-token',
            commentsEnabled: true,
            screenshotsBranch: 'filters-agent-screenshots',
            model: 'deepseek-v4-flash',
            executors: ['browser-extension', 'adguard-desktop'],
            instructionPath: 'tmp/instructions/run.md',
            excludedLabels: ['NSFW'],
            inProgressLabels: ['A: In progress'],
            reportBots: ['adguard-bot'],
            force: true,
            artifactsDir: inputs.artifactsDir,
        });
        expect(result.exitCode).toBe(AgentEntryExitCode.Success);
        expect(result.status).toBe(AgentEntryStatus.Success);
        expect(result.artifactsDir).toBe(inputs.artifactsDir);
        expect(result.perIssue).toHaveLength(1);
        expect(result.perIssue[0]?.kind).toBe('processed');
    });

    it('resolves the default single-issue artifacts dir under the workspace tmp tree', async () => {
        const workspaceRoot = scratchDir('entry-run-workspace-');
        const seam = runIssueSeam(async (_index, request) =>
            processedOutcome(request.issueNumber, request.artifactsDir),
        );
        const inputs = { ...singleIssueInputs() };
        delete (inputs as { artifactsDir?: string }).artifactsDir;

        const result = await runFiltersAgentEntry(inputs, {
            runIssue: seam.runIssue,
            workspaceRoot,
        });

        expect(seam.requests[0]?.artifactsDir).toBe(
            join(workspaceRoot, 'tmp', 'adguard-agent-runs', 'issue-4-current'),
        );
        expect(result.artifactsDir).toBe(
            join(workspaceRoot, 'tmp', 'adguard-agent-runs', 'issue-4-current'),
        );
        expect(readEntryResultFile(seam.requests[0]!.artifactsDir)).toMatchObject({
            status: 'success',
            exitCode: 0,
            runMode: 'single_issue',
            skippedIssues: null,
        });
    });

    it('records a single-issue investigation failure and exits non-zero', async () => {
        const seam = runIssueSeam(async (_index, request) =>
            failedOutcome(request.issueNumber, DefaultSingleIssueFailure.InvestigationFailed),
        );
        const inputs = singleIssueInputs();

        const result = await runFiltersAgentEntry(inputs, { runIssue: seam.runIssue });

        expect(result.exitCode).toBe(AgentEntryExitCode.RunFailed);
        expect(result.status).toBe(AgentEntryStatus.Failed);
        expect(result.perIssue[0]?.kind).toBe('failed');
        expect(readEntryResultFile(inputs.artifactsDir)).toMatchObject({
            status: 'failed',
            exitCode: 1,
            runMode: 'single_issue',
            perIssue: [{ issueNumber: 4, kind: 'failed', failureCode: 'investigation_failed' }],
        });
    });

    it('fails the job for a sealed-failed processed outcome, e.g. environment_unavailable after a failed preparation', async () => {
        const inputs = singleIssueInputs();
        const base = processedOutcome(inputs.mode.issueNumber, inputs.artifactsDir);
        const sealedFailure: ProcessedDefaultSingleIssue = {
            ...base,
            runResult: {
                ...base.runResult,
                runStatus: 'failed',
                infrastructureFailureReason: 'environment_unavailable',
            },
        };
        const seam = runIssueSeam(async () => sealedFailure);

        const result = await runFiltersAgentEntry(inputs, { runIssue: seam.runIssue });

        expect(result.exitCode).toBe(AgentEntryExitCode.RunFailed);
        expect(result.status).toBe(AgentEntryStatus.Failed);
        // The outcome kind itself stays 'processed': the report and artifacts still landed exactly
        // as a successful run's do, only the exit status must not go green.
        expect(result.perIssue[0]?.kind).toBe('processed');
        expect(readEntryResultFile(inputs.artifactsDir)).toMatchObject({
            status: 'failed',
            exitCode: 1,
            runMode: 'single_issue',
        });
    });

    it('takes backlog issues newest-first and stops at the limit', async () => {
        const seam = runIssueSeam(async (_index, request) =>
            processedOutcome(request.issueNumber, request.artifactsDir),
        );
        const reader = fakeBacklogReader([
            openIssueSummary(7),
            openIssueSummary(5),
            openIssueSummary(3),
        ]);
        const inputs = backlogInputs(2);

        const result = await runFiltersAgentEntry(inputs, {
            runIssue: seam.runIssue,
            backlogIssueReader: reader,
            resolveReportAuthorLogin: async () => 'test-agent-login',
        });

        expect(seam.requests.map((request) => request.issueNumber)).toEqual([7, 5]);
        expect(seam.requests[0]).toMatchObject({
            slug: { owner: 'example', repo: 'list' },
            commentsEnabled: true,
            screenshotsBranch: 'filters-agent-screenshots',
            token: 'test-token',
            artifactsDir: join(inputs.artifactsDir, 'issue-7'),
        });
        expect(result.exitCode).toBe(AgentEntryExitCode.Success);
        expect(result.status).toBe(AgentEntryStatus.Success);
        expect(result.artifactsDir).toBe(inputs.artifactsDir);
        expect(readEntryResultFile(inputs.artifactsDir)).toMatchObject({
            status: 'success',
            runMode: 'backlog',
            perIssue: [
                { issueNumber: 7, kind: 'processed' },
                { issueNumber: 5, kind: 'processed' },
            ],
        });
    });

    it('leaves backlog issues with an excluded label untaken and records them as skipped', async () => {
        const seam = runIssueSeam(async (_index, request) =>
            processedOutcome(request.issueNumber, request.artifactsDir),
        );
        const reader = fakeBacklogReader([
            openIssueSummaryWithLabels(7, ['NSFW']),
            openIssueSummary(5),
        ]);
        const inputs = { ...backlogInputs(1), excludedLabels: ['NSFW'] };

        await runFiltersAgentEntry(inputs, {
            runIssue: seam.runIssue,
            backlogIssueReader: reader,
            resolveReportAuthorLogin: async () => 'test-agent-login',
        });

        expect(seam.requests.map((request) => request.issueNumber)).toEqual([5]);
        expect(seam.requests[0]).toMatchObject({ excludedLabels: ['NSFW'] });
        expect(readEntryResultFile(inputs.artifactsDir)).toMatchObject({
            skippedIssues: { excluded_label: [7] },
        });
    });

    it('records a failing backlog issue as data and continues the loop', async () => {
        const seam = runIssueSeam(async (index, request) =>
            index === 0
                ? failedOutcome(request.issueNumber, DefaultSingleIssueFailure.IssueUnavailable)
                : processedOutcome(request.issueNumber, request.artifactsDir),
        );
        const reader = fakeBacklogReader([openIssueSummary(7), openIssueSummary(5)]);
        const inputs = backlogInputs(5);

        const result = await runFiltersAgentEntry(inputs, {
            runIssue: seam.runIssue,
            backlogIssueReader: reader,
            resolveReportAuthorLogin: async () => 'test-agent-login',
        });

        expect(seam.requests.map((request) => request.issueNumber)).toEqual([7, 5]);
        expect(result.exitCode).toBe(AgentEntryExitCode.Success);
        expect(result.status).toBe(AgentEntryStatus.PartialFailure);
        expect(result.perIssue.map((outcome) => outcome.kind)).toEqual(['failed', 'processed']);
        expect(readEntryResultFile(inputs.artifactsDir)).toMatchObject({
            status: 'partial_failure',
            exitCode: 0,
            perIssue: [
                { issueNumber: 7, kind: 'failed', failureCode: 'issue_unavailable' },
                { issueNumber: 5, kind: 'processed' },
            ],
        });
    });

    it('exits non-zero only for a backlog reader prerequisite failure', async () => {
        const seam = runIssueSeam(async (_index, request) =>
            processedOutcome(request.issueNumber, request.artifactsDir),
        );
        const reader = fakeBacklogReader([openIssueSummary(7)], {
            listingError: new BacklogIssueReadError('read_failed', 'listing failed: fixture'),
        });
        const inputs = backlogInputs(2);

        const result = await runFiltersAgentEntry(inputs, {
            runIssue: seam.runIssue,
            backlogIssueReader: reader,
            resolveReportAuthorLogin: async () => 'test-agent-login',
        });

        expect(seam.requests).toHaveLength(0);
        expect(result.exitCode).toBe(AgentEntryExitCode.RunFailed);
        expect(result.status).toBe(AgentEntryStatus.Failed);
        expect(result.perIssue).toHaveLength(0);
        expect(readEntryResultFile(inputs.artifactsDir)).toMatchObject({
            status: 'failed',
            exitCode: 1,
            runMode: 'backlog',
            perIssue: [],
            skippedIssues: null,
        });
    });

    it('treats a per-issue workspace prerequisite failure as an error while still recording every issue', async () => {
        const seam = runIssueSeam(async (index, request) =>
            index === 0
                ? failedOutcome(request.issueNumber, DefaultSingleIssueFailure.WorkspaceUnavailable)
                : processedOutcome(request.issueNumber, request.artifactsDir),
        );
        const reader = fakeBacklogReader([openIssueSummary(7), openIssueSummary(5)]);
        const inputs = backlogInputs(5);

        const result = await runFiltersAgentEntry(inputs, {
            runIssue: seam.runIssue,
            backlogIssueReader: reader,
            resolveReportAuthorLogin: async () => 'test-agent-login',
        });

        expect(seam.requests.map((request) => request.issueNumber)).toEqual([7, 5]);
        expect(result.exitCode).toBe(AgentEntryExitCode.RunFailed);
        expect(result.status).toBe(AgentEntryStatus.Failed);
        expect(result.perIssue).toHaveLength(2);
        expect(readEntryResultFile(inputs.artifactsDir)).toMatchObject({
            status: 'failed',
            perIssue: [
                { issueNumber: 7, kind: 'failed', failureCode: 'workspace_unavailable' },
                { issueNumber: 5, kind: 'processed' },
            ],
        });
    });

    it("narrows a backlog run through the instruction's ## Issue selection section", async () => {
        const workspaceRoot = scratchDir('entry-run-narrowing-');
        mkdirSync(join(workspaceRoot, '.github', 'filters-agent'), { recursive: true });
        writeFileSync(
            join(workspaceRoot, '.github', 'filters-agent', 'AGENTS.md'),
            ['# Guidance', '', '## Issue selection', '- labels: T: Ads', ''].join('\n'),
            'utf8',
        );
        const seam = runIssueSeam(async (_index, request) =>
            processedOutcome(request.issueNumber, request.artifactsDir),
        );
        const reader: BacklogIssueReader = {
            readOpenIssuePage: async () => ({
                summaries: [
                    openIssueSummaryWithLabels(7, ['T: Ads']),
                    openIssueSummaryWithLabels(5, []),
                ],
                hasMore: false,
            }),
            readIssueHistory: async (summary) => ({ summary, comments: [] }),
        };

        const result = await runFiltersAgentEntry(backlogInputs(5), {
            runIssue: seam.runIssue,
            backlogIssueReader: reader,
            resolveReportAuthorLogin: async () => 'test-agent-login',
            workspaceRoot,
        });

        // Only the labeled issue survives the instruction's narrowing; the unlabeled one is never
        // even taken, so it costs no paid run.
        expect(seam.requests.map((request) => request.issueNumber)).toEqual([7]);
        expect(result.status).toBe(AgentEntryStatus.Success);
    });

    it('applies an explicit trustedRoles override, so an untrusted-by-override comment stops reselecting the issue', async () => {
        const reportedAt = '2026-09-09T08:00:00.000Z';
        const memberCommentAt = '2026-09-09T09:00:00.000Z';
        const marker = renderReportRevisionMarker({
            schemaVersion: 1,
            revisionDigest: 'a'.repeat(64),
        });
        const buildReader = (): BacklogIssueReader => ({
            readOpenIssuePage: async () => ({
                summaries: [openIssueSummaryWithLabels(9, [], memberCommentAt)],
                hasMore: false,
            }),
            readIssueHistory: async () => ({
                summary: openIssueSummaryWithLabels(9, [], memberCommentAt),
                comments: [
                    {
                        author: 'test-agent-login',
                        body: `${marker}\nReport body.`,
                        createdAt: reportedAt,
                        updatedAt: reportedAt,
                        authorAssociation: null,
                    },
                    {
                        author: 'maintainer',
                        body: 'Only reproduces on /page2, per our triage.',
                        createdAt: memberCommentAt,
                        updatedAt: memberCommentAt,
                        authorAssociation: 'MEMBER',
                    },
                ],
            }),
        });

        const defaultSeam = runIssueSeam(async (_index, request) =>
            processedOutcome(request.issueNumber, request.artifactsDir),
        );
        const defaultResult = await runFiltersAgentEntry(backlogInputs(5), {
            runIssue: defaultSeam.runIssue,
            backlogIssueReader: buildReader(),
            resolveReportAuthorLogin: async () => 'test-agent-login',
        });
        // By default OWNER/MEMBER/COLLABORATOR are all trusted, so the maintainer's clarification
        // reselects the issue as a new revision.
        expect(defaultResult.perIssue.map((outcome) => outcome.issueNumber)).toEqual([9]);

        const overrideSeam = runIssueSeam(async (_index, request) =>
            processedOutcome(request.issueNumber, request.artifactsDir),
        );
        const overrideResult = await runFiltersAgentEntry(
            { ...backlogInputs(5), queue: { trustedRoles: ['OWNER'] } },
            {
                runIssue: overrideSeam.runIssue,
                backlogIssueReader: buildReader(),
                resolveReportAuthorLogin: async () => 'test-agent-login',
            },
        );
        // Narrowed to OWNER only, the same MEMBER comment no longer reselects the issue.
        expect(overrideResult.perIssue).toHaveLength(0);
    });

    it('stops the backlog loop once the wall-clock budget cannot fit another issue, and records what is left', async () => {
        const seam = runIssueSeam(async (_index, request) =>
            processedOutcome(request.issueNumber, request.artifactsDir),
        );
        const reader = fakeBacklogReader([
            openIssueSummary(9),
            openIssueSummary(7),
            openIssueSummary(5),
        ]);
        const inputs = {
            ...backlogInputs(5),
            config: testCoreConfig({ agentInvestigationBudgetMs: 60 }),
            queue: { backlogWallClockBudgetMs: 100 },
        };
        // Sampled once for the loop start, then once per taken issue before it is allowed to start:
        // the first issue starts at zero elapsed time, and by the second the clock has advanced
        // past what a 60ms-budgeted issue could still fit inside a 100ms loop budget.
        const clockValues = [0, 0, 1_000, 1_000];
        let callIndex = 0;
        const now = (): number => clockValues[Math.min(callIndex++, clockValues.length - 1)]!;

        const result = await runFiltersAgentEntry(inputs, {
            runIssue: seam.runIssue,
            backlogIssueReader: reader,
            resolveReportAuthorLogin: async () => 'test-agent-login',
            now,
        });

        expect(seam.requests.map((request) => request.issueNumber)).toEqual([9]);
        expect(result.remainingIssueNumbers).toEqual([7, 5]);
        expect(result.status).toBe(AgentEntryStatus.Success);
        expect(readEntryResultFile(inputs.artifactsDir)).toMatchObject({
            remainingIssueNumbers: [7, 5],
        });
    });
});
