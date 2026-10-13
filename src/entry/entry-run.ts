/**
 * The entry dispatch: mode resolution, the backlog loop, and the run's exit contract. It re-asserts
 * the validated input shape, then delegates every work seam — the per-issue engine defaults to the
 * public composition of `single-issue-run.ts`, the backlog reader to the GitHub backlog reader, the
 * persisted result file to `entry-result.ts` — so every host it dispatches for, a CLI and the
 * container action alike, shares this one dispatch untouched.
 */

import { join } from 'node:path';
import * as v from 'valibot';
import { ConfigError } from '../config/config-error';
import { AgentRunInputsSchema, AgentRunMode, type AgentRunInputs } from './entry-inputs';
import { writeEntryResultFile } from './entry-result';
import {
    DefaultSingleIssueFailure,
    DefaultSingleIssueResultKind,
    type DefaultSingleIssueRequest,
    type DefaultSingleIssueResult,
} from './single-issue-run-types';
import { runDefaultSingleIssue } from './single-issue-run';
import { perIssueRequest } from './per-issue-request';
import type { BacklogIssueReader } from '../queue/backlog-reader';
import { createGitHubBacklogIssueReader } from '../queue/backlog-reader';
import type { BacklogSelectionOutcome } from '../queue/backlog-selection';
import { selectBacklogIssues } from '../queue/backlog-selection';
import {
    applyQueueDefaults,
    DEFAULT_BACKLOG_WALL_CLOCK_BUDGET_MS,
    QueueInputsSchema,
    type TrustedRole,
} from '../queue/queue-inputs';
import { resolveLocalRunOutputDir } from '../local/output-directory';
import { FixRunStatus } from '../types/fix-run-result';
import { ExtensionEnvironmentKind } from '../types/extension-environment-kind';
import { formatIssues } from '../pi/valibot-issues';
import { createOctokit, type GithubReadConfig } from '../github/fetch-issue';
import { resolveReportAuthorLogin } from '../github/report-author-identity';
import { createLogger } from '../logger/logger';
import { resolveBacklogNarrowing } from './backlog-narrowing';
import { canStartAnotherBacklogIssue } from './backlog-wall-clock-budget';
import { AGENTIC_INVESTIGATION_BUDGET_MS } from '../orchestrator/fix-core-context';

/**
 * How the whole entry run sealed.
 */
export const AgentEntryStatus = {
    /**
     * Every taken issue processed.
     */
    Success: 'success',

    /**
     * Backlog only: some per-issue failures were recorded as data, and no prerequisite failed.
     */
    PartialFailure: 'partial_failure',

    /**
     * A single-issue run failed, or a backlog prerequisite (reader, workspace) failed.
     */
    Failed: 'failed',
} as const;

/**
 * AgentEntryStatus value.
 */
export type AgentEntryStatus = (typeof AgentEntryStatus)[keyof typeof AgentEntryStatus];

/**
 * Process exit codes the entry's result carries.
 */
export const AgentEntryExitCode = {
    /**
     * The run completed; a partially failed backlog is data, not an error.
     */
    Success: 0,

    /**
     * A run failure: a single-issue failure of any stage, or a backlog prerequisite failure.
     */
    RunFailed: 1,
} as const;

/**
 * AgentEntryExitCode value.
 */
export type AgentEntryExitCode = (typeof AgentEntryExitCode)[keyof typeof AgentEntryExitCode];

/**
 * Re-anchored from `entry-result.ts`, which owns the result-file name; exporting it from the
 * dispatch keeps the entry's public import surface unchanged by the projection split.
 */
export { ENTRY_RESULT_FILE_NAME } from './entry-result';

/**
 * Injectable seams of the entry; production passes nothing and gets the public per-issue
 * composition and the GitHub backlog reader.
 */
export interface AgentEntryDependencies {
    /**
     * Per-issue engine seam; production composes `single-issue-run.ts`.
     */
    runIssue?: (request: DefaultSingleIssueRequest) => Promise<DefaultSingleIssueResult>;

    /**
     * Backlog selection reader seam; production reads through the token-configured GitHub reader.
     */
    backlogIssueReader?: BacklogIssueReader;

    /**
     * Absolute workspace root anchoring the default single-issue artifacts directory; defaults to
     * the current directory, matching the CLI's documented `--output-dir` default.
     */
    workspaceRoot?: string;

    /**
     * Resolve the GitHub login authoritative for this backlog run's own report markers; production
     * resolves it once through the configured token's `GET /user` (or the Actions bot identity when
     * that call is refused). Selection trusts no marker from any other author.
     */
    resolveReportAuthorLogin?: (config: GithubReadConfig) => Promise<string>;

    /**
     * The backlog loop's clock, sampled once per taken issue against its wall-clock budget;
     * production reads the real clock.
     */
    now?: () => number;
}

/**
 * Production report-author identity resolution: build an Octokit client for the backlog's own token
 * and resolve its login once.
 *
 * @param config - Read-only GitHub credentials the backlog run reads through.
 * @returns The login authoritative for this run's own markers.
 */
function defaultResolveReportAuthorLogin(config: GithubReadConfig): Promise<string> {
    return resolveReportAuthorLogin(createOctokit(config), createLogger({ verbose: false }));
}

/**
 * The typed seal of one entry run, also persisted as `entry-result.json`.
 */
export interface AgentEntryResult {
    /**
     * Process exit code the face applies; zero also covers a partially failed backlog.
     */
    exitCode: AgentEntryExitCode;

    /**
     * How the run sealed.
     */
    status: AgentEntryStatus;

    /**
     * Artifacts directory the run owned: explicit, or resolved for a single issue.
     */
    artifactsDir: string;

    /**
     * Per-issue outcomes in run order; empty when selection failed before any issue ran.
     */
    perIssue: readonly DefaultSingleIssueResult[];

    /**
     * Taken backlog issues the loop's wall-clock budget left unstarted, newest-first as selected;
     * always empty for a single-issue run. A later run takes them again through the normal
     * selection — none of them ever ran, so none carries a marker yet.
     */
    remainingIssueNumbers: readonly number[];
}

/**
 * Re-assert the validated input shape before any seam is touched, so a structurally wrong call
 * fails at the boundary with named problems instead of surfacing as a partial-seam failure.
 *
 * @param inputs - The caller-supplied run inputs.
 * @throws {ConfigError} One combined error naming every schema problem.
 */
function assertValidatedInputs(inputs: AgentRunInputs): void {
    const parsed = v.safeParse(AgentRunInputsSchema, inputs);
    if (!parsed.success) {
        throw new ConfigError(
            `Agent run inputs failed validation:\n${formatIssues(parsed.issues)}`,
        );
    }
}

/**
 * Validated backlog inputs the dispatch depends on: the explicit artifacts directory and the
 * repository identity the reader reads through.
 */
type BacklogRunInputs = AgentRunInputs & {
    /**
     * Explicit artifacts directory every per-issue folder resolves beneath.
     */
    artifactsDir: string;

    /**
     * Resolved repository identity the backlog reader reads through.
     */
    slug: NonNullable<AgentRunInputs['slug']>;
};

/**
 * Re-assert the run-shape facts a backlog dispatch depends on: the explicit artifacts directory
 * (per-issue folders resolve beneath it at run time) and the repository identity the GitHub reader
 * reads through. The resolver cannot check the folder presence for backlog runs.
 *
 * @param inputs - Validated run inputs narrowed by the caller to backlog mode.
 * @throws {ConfigError} Naming the missing prerequisite.
 */
function assertBacklogRunShape(inputs: AgentRunInputs): asserts inputs is BacklogRunInputs {
    const problems: string[] = [];
    if (inputs.artifactsDir === undefined) {
        problems.push(
            'A backlog run requires an explicit artifacts directory: pass --output-dir <path>, since every per-issue artifact folder resolves beneath it.',
        );
    }
    if (inputs.slug === null) {
        problems.push(
            'A backlog run reads the open queue through GitHub: a repository identity is required (--repository, GITHUB_REPOSITORY, or the checkout origin).',
        );
    }
    if (problems.length > 0) {
        throw new ConfigError(problems.join('\n'));
    }
}

/**
 * Resolve the run's artifacts directory: the explicit one, or the CLI-contract default under the
 * workspace tmp tree for a single issue.
 *
 * @param inputs - Validated run inputs.
 * @param issueNumber - Issue the run processes.
 * @param dependencies - Injectable seams carrying the workspace anchor.
 * @returns The absolute artifacts directory for this run.
 */
function resolveRunArtifactsDir(
    inputs: AgentRunInputs,
    issueNumber: number,
    dependencies: AgentEntryDependencies,
): string {
    if (inputs.artifactsDir !== undefined) {
        return inputs.artifactsDir;
    }
    const workspaceRoot = dependencies.workspaceRoot ?? process.cwd();
    return resolveLocalRunOutputDir(workspaceRoot, issueNumber, ExtensionEnvironmentKind.Current);
}

/**
 * Run the single-issue mode: one per-issue request, one recorded outcome, non-zero on any failure
 * stage (the run's whole purpose failed with it).
 *
 * @param inputs - Validated single-issue inputs.
 * @param dependencies - Injectable seams.
 * @returns The typed seal of the run.
 */
async function runSingleIssueEntry(
    inputs: AgentRunInputs,
    dependencies: AgentEntryDependencies,
): Promise<AgentEntryResult> {
    const runIssue = dependencies.runIssue ?? runDefaultSingleIssue;
    const issueNumber = inputs.mode.kind === AgentRunMode.SingleIssue ? inputs.mode.issueNumber : 0;
    const artifactsDir = resolveRunArtifactsDir(inputs, issueNumber, dependencies);
    const outcome = await runIssue(perIssueRequest(inputs, issueNumber, artifactsDir));
    // A skip is a successful outcome: intake extraction correctly decided the issue is not a
    // filter report, so the run exits zero exactly like a fully processed one. A processed outcome
    // whose locked runResult itself sealed failed (for example environment_unavailable after a
    // failed extension download or preparation command) is not success either: the report and
    // artifacts still land (single-issue-run.ts writes them, posting nothing), but the job that
    // ran nothing useful must not go green.
    const succeeded =
        (outcome.kind === DefaultSingleIssueResultKind.Processed &&
            outcome.runResult.runStatus !== FixRunStatus.Failed) ||
        outcome.kind === DefaultSingleIssueResultKind.Skipped;
    const result: AgentEntryResult = {
        exitCode: succeeded ? AgentEntryExitCode.Success : AgentEntryExitCode.RunFailed,
        status: succeeded ? AgentEntryStatus.Success : AgentEntryStatus.Failed,
        artifactsDir,
        perIssue: [outcome],
        remainingIssueNumbers: [],
    };
    writeEntryResultFile(artifactsDir, result, {
        runMode: AgentRunMode.SingleIssue,
        capturedAt: null,
        skippedIssues: null,
        prerequisiteFailureDetail: null,
    });
    return result;
}

/**
 * Run the backlog mode: select through the reader seam, then run every taken issue sequentially.
 * One issue's failure is recorded and the loop continues; only a failed prerequisite — the
 * selection reader, or a per-issue workspace — makes the exit non-zero.
 *
 * @param inputs - Validated backlog inputs with an explicit artifacts directory and identity.
 * @param dependencies - Injectable seams.
 * @returns The typed seal of the run.
 */
async function runBacklogEntry(
    inputs: BacklogRunInputs,
    dependencies: AgentEntryDependencies,
): Promise<AgentEntryResult> {
    const runIssue = dependencies.runIssue ?? runDefaultSingleIssue;
    const artifactsDir = inputs.artifactsDir;
    const capturedAt = new Date().toISOString();
    const runMode = AgentRunMode.Backlog;

    /**
     * Seal an unrecoverable backlog prerequisite failure: nothing ran, so every issue is left for
     * the next run.
     *
     * @param detail - The underlying failure detail.
     * @returns The typed seal, already persisted.
     */
    function sealPrerequisiteFailure(detail: string): AgentEntryResult {
        const result: AgentEntryResult = {
            exitCode: AgentEntryExitCode.RunFailed,
            status: AgentEntryStatus.Failed,
            artifactsDir,
            perIssue: [],
            remainingIssueNumbers: [],
        };
        writeEntryResultFile(artifactsDir, result, {
            runMode,
            capturedAt,
            skippedIssues: null,
            prerequisiteFailureDetail: detail,
        });
        return result;
    }

    const githubConfig: GithubReadConfig = {
        owner: inputs.slug.owner,
        repo: inputs.slug.repo,
        token: inputs.comments.token ?? '',
    };
    let narrowing;
    try {
        narrowing = await resolveBacklogNarrowing(
            inputs.checkoutPath ?? dependencies.workspaceRoot ?? process.cwd(),
            inputs.instructionPath,
        );
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return sealPrerequisiteFailure(`Backlog instruction load failed: ${detail}`);
    }

    let selection: BacklogSelectionOutcome;
    try {
        const reader =
            dependencies.backlogIssueReader ?? createGitHubBacklogIssueReader(githubConfig);
        const reportAuthorLogin = await (
            dependencies.resolveReportAuthorLogin ?? defaultResolveReportAuthorLogin
        )(githubConfig);
        selection = await selectBacklogIssues(
            reader,
            v.parse(
                QueueInputsSchema,
                applyQueueDefaults({
                    maxIssuesPerRun:
                        inputs.mode.kind === AgentRunMode.Backlog ? inputs.mode.limit : undefined,
                    capturedAt,
                    reportAuthorLogin,
                    narrowing,
                    excludedLabels: inputs.excludedLabels,
                    // Already validated as a member of TRUSTED_ROLE_VALUES by the single
                    // remaining AgentRunInputsSchema parse in assertValidatedInputs, above every
                    // seam this dispatch reaches; AgentRunInputs itself types queue.trustedRoles
                    // as plain strings (see entry-inputs.ts's plain-type rationale).
                    trustedRoles: inputs.queue?.trustedRoles as TrustedRole[] | undefined,
                    maxRevisionsPerWindow: inputs.queue?.maxRevisionsPerWindow,
                    revisionWindowMs: inputs.queue?.revisionWindowMs,
                }),
            ),
        );
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return sealPrerequisiteFailure(`Backlog selection failed: ${detail}`);
    }

    const now = dependencies.now ?? Date.now;
    const wallClockBudgetMs =
        inputs.queue?.backlogWallClockBudgetMs ?? DEFAULT_BACKLOG_WALL_CLOCK_BUDGET_MS;
    const perIssueBudgetMs =
        inputs.config.agentInvestigationBudgetMs ?? AGENTIC_INVESTIGATION_BUDGET_MS;
    const loopStartedAtMs = now();
    const perIssue: DefaultSingleIssueResult[] = [];
    const remainingIssueNumbers: number[] = [];
    for (const issueNumber of selection.takenIssueNumbers) {
        if (
            !canStartAnotherBacklogIssue({
                budgetMs: wallClockBudgetMs,
                perIssueBudgetMs,
                elapsedMs: now() - loopStartedAtMs,
            })
        ) {
            // The remaining wall-clock budget can no longer fit one more issue's own investigation
            // budget: left untaken here, this issue is selected again — and still marker-free — on
            // the next run.
            remainingIssueNumbers.push(issueNumber);
            continue;
        }
        perIssue.push(
            await runIssue(
                perIssueRequest(
                    inputs,
                    issueNumber,
                    join(artifactsDir, `issue-${String(issueNumber)}`),
                ),
            ),
        );
    }
    const workspaceFailed = perIssue.some(
        (outcome) =>
            outcome.kind === DefaultSingleIssueResultKind.Failed &&
            outcome.failureCode === DefaultSingleIssueFailure.WorkspaceUnavailable,
    );
    const anyFailed = perIssue.some(
        (outcome) => outcome.kind === DefaultSingleIssueResultKind.Failed,
    );
    const result: AgentEntryResult = {
        exitCode: workspaceFailed ? AgentEntryExitCode.RunFailed : AgentEntryExitCode.Success,
        status: workspaceFailed
            ? AgentEntryStatus.Failed
            : anyFailed
              ? AgentEntryStatus.PartialFailure
              : AgentEntryStatus.Success,
        artifactsDir,
        perIssue,
        remainingIssueNumbers,
    };
    writeEntryResultFile(artifactsDir, result, {
        runMode,
        capturedAt,
        skippedIssues: selection.skippedIssueNumbers,
        prerequisiteFailureDetail: workspaceFailed
            ? 'A backlog per-issue workspace prerequisite failed; the remaining issues still ran.'
            : null,
    });
    return result;
}

/**
 * Dispatch one validated entry run: re-assert the input shape (never touching a seam before it
 * holds), then turn the mode into a single-issue request or the bounded backlog loop, and persist
 * `entry-result.json` into the run's artifacts directory.
 *
 * @param inputs - Validated run inputs from `resolveAgentRunInputs`.
 * @param dependencies - Injectable seams; production passes nothing.
 * @returns The typed seal of the run.
 * @throws {ConfigError} Inputs that fail re-validation, or a backlog run missing its explicit
 *   artifacts directory or repository identity — before any seam runs.
 */
export function runFiltersAgentEntry(
    inputs: AgentRunInputs,
    dependencies: AgentEntryDependencies = {},
): Promise<AgentEntryResult> {
    assertValidatedInputs(inputs);
    if (inputs.mode.kind === AgentRunMode.Backlog) {
        assertBacklogRunShape(inputs);
        return runBacklogEntry(inputs, dependencies);
    }
    return runSingleIssueEntry(inputs, dependencies);
}
