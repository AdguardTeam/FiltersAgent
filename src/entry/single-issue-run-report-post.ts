/**
 * The comment a run of the default single-issue engine posts, and the post itself.
 *
 * A sealed run whose status says something about the reported defect posts its full report, with
 * the before and after screenshots of a verified rule. A run a maintainer forced that could not
 * investigate the report — sealed under a silent status (see `single-issue-run-outcome-report.ts`)
 * or failed during intake or investigation — posts a notice instead: one fixed line and the link to
 * the run, whatever the repository's report template, since the template's static text speaks of a
 * report the notice is not. Both go through the publication guard; a notice dedupes only against
 * another notice, so it never stands for the revision's report.
 */

import { readFileSync } from 'node:fs';
import type { Octokit } from '@octokit/rest';
import { createOctokit } from '../github/fetch-issue';
import { resolveReportAuthorLogin } from '../github/report-author-identity';
import type { Logger } from '../logger/logger';
import { renderReportComment } from '../publisher/report-render';
import { withReportFooter } from '../publisher/report-footer';
import { RevisionCommentKind, type ReportPublishResult } from '../publisher/report-publisher';
import {
    publishedRuleScreenshots,
    renderHostedReportScreenshots,
} from '../publisher/report-screenshots';
import type { ReportTemplateValues } from '../publisher/report-template';
import type { FixRunResult } from '../types/fix-run-result';
import type { RepositorySlug } from '../types/repository-slug';
import { publishGuardedReport } from './single-issue-publication-gate';
import { logCaughtError, type SilentRunNotice } from './single-issue-run-outcome-report';
import type { DefaultSingleIssueRequest } from './single-issue-run-types';

/**
 * The issue and revision a run comments on.
 */
export interface RunCommentTarget {
    /**
     * The per-issue request: the issue, the token, the run link and the guard settings.
     */
    request: DefaultSingleIssueRequest;

    /**
     * Repository the comment goes to.
     */
    slug: RepositorySlug;

    /**
     * Digest of the issue revision the run read.
     */
    revisionDigest: string;

    /**
     * Commit of the filter lists the run prepared, for the comment footer.
     */
    filtersCommit: string;
}

/**
 * One sealed run's comment, ready to post.
 */
export interface SealedRunReport extends RunCommentTarget {
    /**
     * The sealed run result.
     */
    runResult: FixRunResult;

    /**
     * Resolved report template.
     */
    template: string;

    /**
     * Fill values of the full report, before its screenshots get an address.
     */
    values: ReportTemplateValues;

    /**
     * The notice the run posts in place of its report, or null to post the report.
     */
    notice: SilentRunNotice | null;
}

/**
 * Render a full report comment: the report template filled with the run's values, then the footer.
 *
 * @param template - Resolved report template.
 * @param values - Fill values of the report.
 * @param filtersCommit - Commit of the filter lists the run prepared, for the footer.
 * @returns The rendered Markdown body.
 */
export function renderFullReport(
    template: string,
    values: ReportTemplateValues,
    filtersCommit: string,
): string {
    return withReportFooter(renderReportComment(template, values), filtersCommit);
}

/**
 * Render a notice comment: the notice line, the link to the run when it has one, then the footer.
 *
 * @param notice - The notice line.
 * @param runLink - Link to the workflow run, or the empty string when the run has none.
 * @param filtersCommit - Commit of the filter lists the run prepared, for the footer.
 * @returns The rendered Markdown body.
 */
function renderNoticeComment(
    notice: SilentRunNotice,
    runLink: string,
    filtersCommit: string,
): string {
    const line = runLink.length === 0 ? notice : `${notice} Details: [workflow run](${runLink}).`;
    return withReportFooter(line, filtersCommit);
}

/**
 * The GitHub client a run comments through.
 *
 * @param target - The issue the run comments on, with the run's token.
 * @param octokit - An injected client, or undefined to build one from the token.
 * @returns The client.
 */
function commentClient(target: RunCommentTarget, octokit: Octokit | undefined): Octokit {
    return (
        octokit ??
        createOctokit({
            owner: target.slug.owner,
            repo: target.slug.repo,
            token: target.request.token ?? '',
        })
    );
}

/**
 * Post a notice unless the guard silences it now.
 *
 * @param target - The issue and revision the notice is about.
 * @param notice - The notice line.
 * @param client - Authenticated GitHub API client.
 * @param logger - Run logger.
 * @returns The publication, or null when the guard kept the notice silent.
 */
async function postNotice(
    target: RunCommentTarget,
    notice: SilentRunNotice,
    client: Octokit,
    logger: Logger,
): Promise<ReportPublishResult | null> {
    const { request, slug } = target;
    return await publishGuardedReport(
        client,
        {
            owner: slug.owner,
            repo: slug.repo,
            issueNumber: request.issueNumber,
            revisionDigest: target.revisionDigest,
            reportAuthorLogin: await resolveReportAuthorLogin(client, logger),
            kind: RevisionCommentKind.Notice,
            body: renderNoticeComment(notice, request.actionsRunUrl ?? '', target.filtersCommit),
        },
        request,
        logger,
    );
}

/**
 * Post a sealed run's comment unless the guard silences it now: its notice when it carries one,
 * else its full report.
 *
 * @param report - The sealed run's comment.
 * @param octokit - An injected GitHub client, or undefined to build one from the run's token.
 * @param logger - Run logger.
 * @returns The publication, or null when the guard kept the comment silent.
 */
export async function postSealedRunReport(
    report: SealedRunReport,
    octokit: Octokit | undefined,
    logger: Logger,
): Promise<ReportPublishResult | null> {
    const client = commentClient(report, octokit);
    if (report.notice !== null) {
        return await postNotice(report, report.notice, client, logger);
    }
    const { request, slug, runResult, template, values, filtersCommit } = report;
    const screenshots = publishedRuleScreenshots(runResult);
    return await publishGuardedReport(
        client,
        {
            owner: slug.owner,
            repo: slug.repo,
            issueNumber: request.issueNumber,
            revisionDigest: report.revisionDigest,
            reportAuthorLogin: await resolveReportAuthorLogin(client, logger),
            body: renderFullReport(template, values, filtersCommit),
            ...(screenshots === undefined
                ? {}
                : {
                      finalizeBody: async () =>
                          renderFullReport(
                              template,
                              {
                                  ...values,
                                  screenshots: await renderHostedReportScreenshots(
                                      client,
                                      {
                                          owner: slug.owner,
                                          repo: slug.repo,
                                          issueNumber: request.issueNumber,
                                          branch: request.screenshotsBranch,
                                          before: readFileSync(screenshots.before),
                                          after: readFileSync(screenshots.after),
                                      },
                                      logger,
                                  ),
                              },
                              filtersCommit,
                          ),
                  }),
        },
        request,
        logger,
    );
}

/**
 * Post the notice of a forced run that failed during intake or investigation, and log what came of
 * it: the failed result the run returns has no publication to carry it. The failure is what the run
 * returns, so a notice that cannot be posted is logged and dropped instead of replacing it.
 *
 * @param target - The issue and revision the run read.
 * @param notice - The notice line.
 * @param octokit - An injected GitHub client, or undefined to build one from the run's token.
 * @param logger - Run logger.
 */
export async function postFailureNotice(
    target: RunCommentTarget,
    notice: SilentRunNotice,
    octokit: Octokit | undefined,
    logger: Logger,
): Promise<void> {
    try {
        const publication = await postNotice(
            target,
            notice,
            commentClient(target, octokit),
            logger,
        );
        if (publication !== null) {
            logger.info(
                {
                    issueNumber: target.request.issueNumber,
                    action: publication.action,
                    commentUrl: publication.commentUrl,
                },
                'the notice of a forced run that failed reached the issue',
            );
        }
    } catch (error) {
        logCaughtError(logger, 'notice publication', error, {
            issueNumber: target.request.issueNumber,
        });
    }
}
