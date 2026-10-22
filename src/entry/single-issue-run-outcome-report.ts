/**
 * Which sealed outcomes of the default single-issue engine are posted, the notice a forced run
 * posts in place of a report it keeps off the issue, and the short report of one that never reached
 * a locked `FixRunResult` — a skip, or a failure once the run's revision digest was already
 * computed — rendered for the artifacts.
 *
 * Only a finding a maintainer can act on is posted. A skip, an intake or investigation failure
 * (whose reason is the raw provider or runtime error, not anything about the issue), and a sealed
 * run that could not investigate the report, unless it still proposed a candidate, post nothing:
 * their report lands in the artifacts and the log names the outcome. Without a posted report such
 * an issue carries no report marker, so in backlog mode the next backlog run retakes it. A run a
 * maintainer forced posts a one-line notice instead of nothing after an intake or investigation
 * failure and a sealed run that could not investigate; a skip stays silent. The notice carries a
 * marker of its own, which no report lookup reads, so a retry and the backlog still take the issue.
 * Also carries the shared "log the caught error in full before mapping or swallowing it" helper
 * every catch in the default single-issue engine uses.
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
 * The one line a forced run posts in place of a report it keeps off the issue.
 *
 * A maintainer who triggered the run waits for its answer, and no comment reads as a run that never
 * started. The line says only whether the reported page could not be accessed or the report could
 * not be processed: the reason behind it — an HTTP status, a browser, provider or cleanup failure —
 * says nothing about the reported defect and stays in the artifacts the notice links to.
 */
export const SilentRunNotice = {
    /**
     * The run could not reach the reported page.
     */
    NoAccess: 'The agent could not access the reported page.',

    /**
     * The run could not investigate the report for any other reason.
     */
    NotProcessed: 'The agent could not process this report.',
} as const;

/**
 * SilentRunNotice value.
 */
export type SilentRunNotice = (typeof SilentRunNotice)[keyof typeof SilentRunNotice];

/**
 * Which sealed statuses keep their report off the issue, each with the notice a forced run posts
 * instead, and null for a status whose report is posted. Total over `FixRunStatus`, so a new status
 * is a compile error until it is decided here.
 *
 * A silent status is not a finding a maintainer can act on: the run could not investigate the
 * report at all (an unsupported product, a missing capability or browser, a page it could not
 * reach) or broke down around it (cleanup, an unrecoverable failure). Posted, such a report only
 * tells the reporter the agent failed. Every other status says something about the reported defect
 * and is posted.
 */
const SILENT_RUN_NOTICES: Record<FixRunStatus, SilentRunNotice | null> = {
    [FixRunStatus.AlreadyFixedCurrent]: null,
    [FixRunStatus.FixedUpstreamPendingExtension]: null,
    [FixRunStatus.FixedInSourcePendingPublication]: null,
    [FixRunStatus.PatchProposed]: null,
    [FixRunStatus.NotReproduced]: null,
    [FixRunStatus.ConfigurationSpecific]: null,
    [FixRunStatus.AnalysisOnly]: null,
    [FixRunStatus.TargetUrlUnavailable]: SilentRunNotice.NoAccess,
    [FixRunStatus.UnsupportedProductCase]: SilentRunNotice.NotProcessed,
    [FixRunStatus.CapabilityLimited]: SilentRunNotice.NotProcessed,
    [FixRunStatus.BrowserUnavailable]: SilentRunNotice.NotProcessed,
    [FixRunStatus.CleanupFailed]: SilentRunNotice.NotProcessed,
    [FixRunStatus.Failed]: SilentRunNotice.NotProcessed,
};

/**
 * The notice a forced run posts in place of a sealed run's report, when the run keeps its report
 * off the issue.
 *
 * A candidate for review outranks a silent status: the run reached the page and proposed a rule it
 * could not verify, which is a finding a maintainer can act on; kept silent, the candidate would
 * stay in the artifacts only.
 *
 * @param runResult - The sealed run's status and its candidate for review, if any.
 * @returns The notice when the report goes to the artifacts only, or null when it is posted.
 */
export function silentRunNotice(
    runResult: Pick<FixRunResult, 'runStatus' | 'candidateForReview'>,
): SilentRunNotice | null {
    return runResult.candidateForReview === undefined
        ? SILENT_RUN_NOTICES[runResult.runStatus]
        : null;
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
    return runResult.candidateForReview !== undefined &&
        SILENT_RUN_NOTICES[runResult.runStatus] !== null
        ? FixRunStatus.AnalysisOnly
        : runResult.runStatus;
}

/**
 * The notice a run posts in place of a report it keeps off the issue: only a run a maintainer
 * forced posts one, and only when it posts comments at all.
 *
 * @param request - The per-issue request.
 * @param notice - The notice the outcome calls for, or null when its report is posted as is.
 * @returns The notice to post, or null when nothing goes to the issue in the report's place.
 */
export function forcedRunNotice(
    request: DefaultSingleIssueRequest,
    notice: SilentRunNotice | null,
): SilentRunNotice | null {
    return request.force === true && request.commentsEnabled && request.slug !== null
        ? notice
        : null;
}

/**
 * Log, in one line, an outcome whose report is kept off the issue, with its reason: the notice a
 * forced run posts instead says nothing of it.
 *
 * @param logger - Diagnostics sink.
 * @param issueNumber - Issue the run processed.
 * @param outcome - Human outcome line, the same the rendered report carries.
 * @param reason - Detail explaining the outcome.
 * @param notice - The notice the run posts in the report's place, or null when it posts nothing.
 */
export function logUnpostedOutcome(
    logger: Logger,
    issueNumber: number,
    outcome: string,
    reason: string,
    notice: SilentRunNotice | null,
): void {
    if (notice === null) {
        logger.info(
            { issueNumber, reason },
            `${outcome}: no comment posted, the report is in the artifacts`,
        );
        return;
    }
    logger.info(
        { issueNumber, reason, notice },
        `${outcome}: a short notice goes to the issue, the report is in the artifacts`,
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
 * @param notice - The notice the run posts in the report's place, or null when it posts nothing.
 * @returns The rendered Markdown body for the artifacts.
 */
export function renderUnpostedOutcomeReport(
    request: DefaultSingleIssueRequest,
    logger: Logger,
    instructionContent: string | undefined,
    filtersCommit: string,
    outcomeLabel: MinimalOutcome,
    outcomeReason: string,
    notice: SilentRunNotice | null,
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
    logUnpostedOutcome(logger, request.issueNumber, outcomeLabel, outcomeReason, notice);
    return withReportFooter(
        renderReportComment(template, buildReportTemplateValues(summary)),
        filtersCommit,
    );
}
