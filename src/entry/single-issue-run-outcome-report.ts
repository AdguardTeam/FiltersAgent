/**
 * Which sealed outcomes of the default single-issue engine are posted, and the short report of one
 * that never reached a locked `FixRunResult` — a skip, or a failure once the run's revision digest
 * was already computed — rendered for the artifacts.
 *
 * Only a finding a maintainer can act on is posted. A skip, an intake or investigation failure
 * (whose reason is the raw provider or runtime error, not anything about the issue), and a sealed
 * run that could not investigate the report, unless it still proposed a candidate, post nothing:
 * their report lands in the artifacts and the log names the outcome. Without a posted comment such
 * an issue carries no revision marker, so in backlog mode the next backlog run retakes it. Also
 * carries the shared "log the caught error in full before mapping or swallowing it" helper every
 * catch in the default single-issue engine uses.
 */

import type { Logger } from '../logger/logger';
import {
    buildReportTemplateValues,
    renderReportComment,
    type ReportOutcomeSummary,
} from '../publisher/report-render';
import { withReportFooter } from '../publisher/report-footer';
import { resolveReportTemplate } from '../publisher/report-template';
import { FixRunStatus, type FixRunResult } from '../types/fix-run-result';
import type { DefaultSingleIssueRequest } from './single-issue-run-types';

/**
 * The outcome line of a short report that has no locked run result to label it.
 */
export const MinimalOutcome = {
    /**
     * Intake extraction judged the issue not a filter report.
     */
    Skipped: 'Issue skipped',

    /**
     * Intake extraction threw before it reached a verdict.
     */
    IntakeFailed: 'Intake extraction failed',

    /**
     * The investigation threw before it sealed a run result.
     */
    InvestigationFailed: 'The investigation failed',
} as const;

/**
 * MinimalOutcome value.
 */
export type MinimalOutcome = (typeof MinimalOutcome)[keyof typeof MinimalOutcome];

/**
 * Whether a sealed run with each status keeps its report off the issue. Total over `FixRunStatus`,
 * so a new status is a compile error until it is decided here.
 *
 * A silent status is not a finding a maintainer can act on: the run could not investigate the
 * report at all (an unsupported product, a missing capability or browser, a page it could not
 * reach) or broke down around it (cleanup, an unrecoverable failure). Posted, such a report only
 * tells the reporter the agent failed. Every other status says something about the reported defect
 * and is posted.
 */
const SILENT_RUN_STATUSES: Record<FixRunStatus, boolean> = {
    [FixRunStatus.AlreadyFixedCurrent]: false,
    [FixRunStatus.FixedUpstreamPendingExtension]: false,
    [FixRunStatus.FixedInSourcePendingPublication]: false,
    [FixRunStatus.PatchProposed]: false,
    [FixRunStatus.NotReproduced]: false,
    [FixRunStatus.ConfigurationSpecific]: false,
    [FixRunStatus.AnalysisOnly]: false,
    [FixRunStatus.TargetUrlUnavailable]: true,
    [FixRunStatus.UnsupportedProductCase]: true,
    [FixRunStatus.CapabilityLimited]: true,
    [FixRunStatus.BrowserUnavailable]: true,
    [FixRunStatus.CleanupFailed]: true,
    [FixRunStatus.Failed]: true,
};

/**
 * Decide whether a sealed run keeps its report off the issue.
 *
 * A candidate for review outranks a silent status: the run reached the page and proposed a rule it
 * could not verify, which is a finding a maintainer can act on; kept silent, the candidate would
 * stay in the artifacts only.
 *
 * @param runResult - The sealed run's status and its candidate for review, if any.
 * @returns True when the report goes to the artifacts only.
 */
export function isSilentRun(
    runResult: Pick<FixRunResult, 'runStatus' | 'candidateForReview'>,
): boolean {
    return runResult.candidateForReview === undefined && SILENT_RUN_STATUSES[runResult.runStatus];
}

/**
 * The status a sealed run's report is rendered under.
 *
 * A silent-status run is posted only for its candidate for review, so its report reads as the
 * analysis-only candidate it is. Under its own status a rule the run found would sit below a line
 * saying it could not investigate, with no reason beside it.
 *
 * @param runResult - The sealed run's status and its candidate for review, if any.
 * @returns The run's own status, or analysis-only for a silent status carrying a candidate.
 */
export function reportedRunStatus(
    runResult: Pick<FixRunResult, 'runStatus' | 'candidateForReview'>,
): FixRunStatus {
    return runResult.candidateForReview !== undefined && SILENT_RUN_STATUSES[runResult.runStatus]
        ? FixRunStatus.AnalysisOnly
        : runResult.runStatus;
}

/**
 * Log, in one line, an outcome whose report is kept off the issue.
 *
 * @param logger - Diagnostics sink.
 * @param issueNumber - Issue the run processed.
 * @param outcome - Human outcome line, the same the rendered report carries.
 * @param reason - Detail explaining the outcome.
 */
export function logUnpostedOutcome(
    logger: Logger,
    issueNumber: number,
    outcome: string,
    reason: string,
): void {
    logger.info(
        { issueNumber, reason },
        `${outcome}: no comment posted, the report is in the artifacts`,
    );
}

/**
 * Log one caught error in full — message, stack, and cause — before it is mapped to a typed failure
 * or otherwise swallowed, so the underlying detail is never lost to a bare code.
 *
 * @param logger - Diagnostics sink.
 * @param phase - What the run was doing when the error was caught.
 * @param error - The caught error.
 * @param context - Extra structured fields logged beside the error (e.g. the issue number).
 */
export function logCaughtError(
    logger: Logger,
    phase: string,
    error: unknown,
    context: Record<string, unknown> = {},
): void {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ ...context, err }, `${phase} failed`);
}

/**
 * Render the short report of an outcome that has no locked run result and is never posted, and log
 * in one line that it was not.
 *
 * @param request - The per-issue request.
 * @param logger - Diagnostics sink.
 * @param instructionContent - Loaded run instruction content, for the report template.
 * @param filtersCommit - Commit of the filter lists the run prepared, for the report footer.
 * @param outcomeLabel - Human outcome line.
 * @param outcomeReason - Detail explaining the outcome.
 * @returns The rendered Markdown body for the artifacts.
 */
export function renderUnpostedOutcomeReport(
    request: DefaultSingleIssueRequest,
    logger: Logger,
    instructionContent: string | undefined,
    filtersCommit: string,
    outcomeLabel: MinimalOutcome,
    outcomeReason: string,
): string {
    const template = resolveReportTemplate(instructionContent).template;
    const summary: ReportOutcomeSummary = {
        outcome: outcomeLabel,
        outcomeReason,
        versionUpdateHint: '',
        symptom: '',
        rule: '',
        listPlace: '',
        executor: '',
        executorVersion: '',
        policyRationale: '',
        missingInformation: [],
        artifactsLink: request.actionsRunUrl ?? '',
    };
    logUnpostedOutcome(logger, request.issueNumber, outcomeLabel, outcomeReason);
    return withReportFooter(
        renderReportComment(template, buildReportTemplateValues(summary)),
        filtersCommit,
    );
}
