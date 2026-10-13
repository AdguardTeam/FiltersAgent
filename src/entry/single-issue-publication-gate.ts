/**
 * The two checks that keep a per-issue run from posting a report nobody needs.
 *
 * Before the run pays for intake and investigation: an issue with a label the run excludes, a
 * report for this issue revision already posted, or an issue the publication guard silences
 * (closed, a fix referenced, a maintainer on it), ends the run as a skip. Right before posting: the
 * guard runs again, since a maintainer can act during the run, an excluded label included. Both
 * read only GitHub; neither writes. A forced run — one a maintainer triggered — passes both checks
 * on an issue a maintainer is on (a comment, an assignee, an in-progress label), and only on that.
 */

import type { Octokit } from '@octokit/rest';
import { createOctokit } from '../github/fetch-issue';
import { readIssuePublicationFacts } from '../github/issue-publication-facts';
import { resolveReportAuthorLogin } from '../github/report-author-identity';
import type { Logger } from '../logger/logger';
import {
    decideForcedPublication,
    decidePublication,
    exclusionSignals,
    type PublicationDecision,
    type PublicationGuardPolicy,
} from '../publisher/publication-guard';
import {
    findRevisionReport,
    publishReportOnce,
    type ReportPublishInput,
    type ReportPublishResult,
} from '../publisher/report-publisher';
import { TRUSTED_ROLE_VALUES, type TrustedRole } from '../queue/queue-inputs';
import type { RepositorySlug } from '../types/repository-slug';

/**
 * The run's own settings the guard measures an issue against.
 */
export interface PublicationGuardSettings {
    /**
     * The run's trusted roles, or undefined for the default set.
     */
    trustedRoles?: readonly TrustedRole[] | undefined;

    /**
     * Labels the run never reports on, or undefined when it excludes none.
     */
    excludedLabels?: readonly string[] | undefined;

    /**
     * Labels a maintainer applies when they pick an issue up, or undefined when the repository uses
     * none.
     */
    inProgressLabels?: readonly string[] | undefined;

    /**
     * Logins of the repository's reporting bots, whose comments are not a maintainer's, or
     * undefined when it names none.
     */
    reportBots?: readonly string[] | undefined;

    /**
     * Whether a maintainer triggered the run, so a maintainer on the issue does not silence it.
     */
    force?: boolean | undefined;
}

/**
 * Build the guard policy for the repository the run reports to.
 *
 * The repository's own maintainers are the run's trusted roles. In-progress labels and reporting
 * bots differ from one repository to the next, so only the ones the run was configured with count;
 * none is assumed. The run's own reports never count as a maintainer's comment, even when they post
 * from a maintainer's token.
 *
 * @param slug - Repository the run reports to.
 * @param settings - The run's trusted roles, label sets and reporting bots.
 * @param reportAuthorLogin - The GitHub login the run's reports post as.
 * @returns The guard policy.
 */
export function publicationGuardPolicy(
    slug: RepositorySlug,
    settings: PublicationGuardSettings,
    reportAuthorLogin: string,
): PublicationGuardPolicy {
    return {
        repository: `${slug.owner}/${slug.repo}`,
        trustedRoles: settings.trustedRoles ?? TRUSTED_ROLE_VALUES,
        inProgressLabels: settings.inProgressLabels ?? [],
        excludedLabels: settings.excludedLabels ?? [],
        ignoredAuthors: [reportAuthorLogin],
        reportBots: settings.reportBots ?? [],
    };
}

/**
 * Read the issue and decide whether the guard silences a report on it.
 *
 * @param client - Authenticated GitHub API client.
 * @param slug - Repository the run reports to.
 * @param issueNumber - Issue the run reports on.
 * @param policy - Guard policy for the repository.
 * @param force - Whether a maintainer triggered the run.
 * @param logger - Run logger; the maintainer signals a forced run overrides are logged.
 * @returns The decision with its reason, or null when nothing stands in the way.
 */
async function readSilence(
    client: Octokit,
    slug: RepositorySlug,
    issueNumber: number,
    policy: PublicationGuardPolicy,
    force: boolean,
    logger: Logger,
): Promise<PublicationDecision | null> {
    const facts = await readIssuePublicationFacts(client, {
        owner: slug.owner,
        repo: slug.repo,
        issueNumber,
    });
    if (!force) {
        const decision = decidePublication(facts, policy);
        return decision.reason === null ? null : decision;
    }
    const { decision, overridden } = decideForcedPublication(facts, policy);
    if (overridden.length > 0) {
        logger.info(
            { issueNumber, signals: overridden },
            'force overrides a maintainer already on the issue',
        );
    }
    return decision.reason === null ? null : decision;
}

/**
 * Why a run stops before it pays for anything.
 */
export interface PreRunSkip {
    /**
     * Human reason for the skip.
     */
    reason: string;

    /**
     * The prior report when one already covers this revision, otherwise null.
     */
    publication: ReportPublishResult | null;
}

/**
 * Inputs of the pre-run check.
 */
export interface PreRunCheckInput {
    /**
     * Repository the run reports to.
     */
    slug: RepositorySlug;

    /**
     * Issue the run reports on.
     */
    issueNumber: number;

    /**
     * Digest of the issue revision the run would report.
     */
    revisionDigest: string;

    /**
     * Labels the issue carried when the run read it.
     */
    issueLabels: readonly string[];

    /**
     * Whether the run posts reports; a run that posts none has no report to dedupe or silence.
     */
    commentsEnabled: boolean;

    /**
     * GitHub token the guard reads through.
     */
    token: string | undefined;

    /**
     * The run's trusted roles, label sets, reporting bots and force.
     */
    settings: PublicationGuardSettings;
}

/**
 * Decide whether a run should stop before intake extraction.
 *
 * The excluded labels are read from the issue the run already holds, so they stop the run even when
 * it posts nothing: the point is never to open the reported page, not only to stay silent.
 *
 * @param input - Issue, revision, the run's comment policy and guard settings.
 * @param octokit - GitHub API client, or undefined to build one from the token.
 * @param logger - Run logger; the guard's signals are logged when it silences.
 * @returns The skip, or null when the run should go on.
 */
export async function checkIssueBeforeRun(
    input: PreRunCheckInput,
    octokit: Octokit | undefined,
    logger: Logger,
): Promise<PreRunSkip | null> {
    const excluded = exclusionSignals(input.issueLabels, input.settings.excludedLabels ?? []);
    if (excluded.length > 0) {
        logger.info(
            { issueNumber: input.issueNumber, signals: excluded },
            'an excluded label skips the run',
        );
        return { reason: `The issue needs no report: ${excluded.join('; ')}.`, publication: null };
    }
    if (!input.commentsEnabled) {
        return null;
    }
    const client =
        octokit ??
        createOctokit({ owner: input.slug.owner, repo: input.slug.repo, token: input.token ?? '' });
    const reportAuthorLogin = await resolveReportAuthorLogin(client, logger);
    const reported = await findRevisionReport(client, {
        owner: input.slug.owner,
        repo: input.slug.repo,
        issueNumber: input.issueNumber,
        revisionDigest: input.revisionDigest,
        reportAuthorLogin,
    });
    if (reported !== null) {
        return {
            reason: 'A report for this issue revision is already posted.',
            publication: reported,
        };
    }
    const policy = publicationGuardPolicy(input.slug, input.settings, reportAuthorLogin);
    const silence = await readSilence(
        client,
        input.slug,
        input.issueNumber,
        policy,
        input.settings.force === true,
        logger,
    );
    if (silence !== null) {
        logger.info(
            { issueNumber: input.issueNumber, reason: silence.reason, signals: silence.signals },
            'the publication guard skips the run',
        );
        return {
            reason: `The issue needs no report: ${silence.signals.join('; ')}.`,
            publication: null,
        };
    }
    return null;
}

/**
 * Post the report unless the guard silences it now.
 *
 * @param client - Authenticated GitHub API client.
 * @param input - The report publication.
 * @param settings - The run's trusted roles, label sets, reporting bots and force.
 * @param logger - Run logger; the guard's signals are logged when it silences.
 * @returns The publication, or null when the guard kept the report silent.
 */
export async function publishGuardedReport(
    client: Octokit,
    input: ReportPublishInput,
    settings: PublicationGuardSettings,
    logger: Logger,
): Promise<ReportPublishResult | null> {
    const slug = { owner: input.owner, repo: input.repo };
    const policy = publicationGuardPolicy(slug, settings, input.reportAuthorLogin);
    const silence = await readSilence(
        client,
        slug,
        input.issueNumber,
        policy,
        settings.force === true,
        logger,
    );
    if (silence !== null) {
        logger.info(
            { issueNumber: input.issueNumber, reason: silence.reason, signals: silence.signals },
            'the publication guard keeps the report silent',
        );
        return null;
    }
    return publishReportOnce(client, input);
}
