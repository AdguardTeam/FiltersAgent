/**
 * The default public per-issue engine: one call that materializes the filters workspace, loads the
 * run instruction inside it, obtains the issue from an exported snapshot or the GitHub fetch seam,
 * investigates through `runFixCore`, and posts one revision-marked report when comments are on. It
 * is the public composition behind `runFiltersAgentEntry`; a host with a richer local cycle plugs
 * it in through the same dispatch seam, so hosting swaps without touching the entry again.
 *
 * Every sealed outcome — a full run, a skip, or a failure once the run's revision digest is known —
 * writes its report artifacts. Only a finding is posted: a skip, a failure, or a run that could not
 * investigate the report posts nothing, and in backlog mode is retaken by the next run (see
 * `single-issue-run-artifacts.ts` and `single-issue-run-outcome-report.ts`).
 */

import { readFileSync } from 'node:fs';
import type { CoreConfig } from '../config/config';
import { createOctokit, fetchIssue, type RawIssue } from '../github/fetch-issue';
import { AUTOMATIC_UPSTREAM_PROMPT_TEXT_LIMITS } from '../github/prompt-safety';
import { resolveReportAuthorLogin } from '../github/report-author-identity';
import type { RepositorySlug } from '../types/repository-slug';
import { extractReport, IntakeExtractionKind } from '../intake/extract-report';
import { IntakeVerdict, type IntakeExtractionPayload } from '../intake/report';
import {
    InstructionLoadError,
    loadInstruction,
    type LoadedInstruction,
} from '../knowledge/instruction-loader';
import { loadDefaultRuleGuidance } from '../knowledge/default-rule-guidance';
import { fileBackedApplicationRefusalDetail } from '../knowledge/instruction-application';
import { GITHUB_HTTP_ORIGIN } from '../local/git-http-auth';
import type { FiltersPreparationConfig } from '../local/run-config-types';
import { loadVerifiedExportedIssueRevision } from '../local/issue-revision';
import {
    FiltersPreparationError,
    defaultDependencies,
    withPreparedFiltersCheckout,
    type FiltersPreparationDependencies,
    type PreparedFiltersCheckout,
} from '../local/filters-preparer';
import { resolveRemoteDefaultRef } from '../local/filters-default-ref';
import { createLogger } from '../logger/logger';
import {
    buildReportTemplateValues,
    renderReportComment,
    summarizeReportOutcome,
} from '../publisher/report-render';
import { withReportFooter } from '../publisher/report-footer';
import {
    publishedRuleScreenshots,
    renderHostedReportScreenshots,
} from '../publisher/report-screenshots';
import { resolveReportTemplate } from '../publisher/report-template';
import { decideVersionUpdate } from '../publisher/report-version-decision';
import { writeRunReportArtifacts } from './single-issue-run-artifacts';
import {
    isSilentRun,
    logCaughtError,
    logUnpostedOutcome,
    MinimalOutcome,
    renderUnpostedOutcomeReport,
    reportedRunStatus,
} from './single-issue-run-outcome-report';
import {
    checkIssueBeforeRun,
    publishGuardedReport,
    type PreRunSkip,
} from './single-issue-publication-gate';
import { fetchedIssueRevisionDigest } from './single-issue-revision-digest';
import { materializedSnapshotIssue } from './single-issue-snapshot-materialization';
import { runFixCore } from '../orchestrator/fix-core';
import {
    type DirectFixCoreIssueInput,
    type FixCoreDependencies,
    type FixCoreIssueInput,
    type FixCoreOptions,
} from '../orchestrator/fix-core-inputs';
import { createRunUsageCollector } from '../pi/usage-collector';
import { extractIntakeFacts, type ExtractedIntakeFacts } from './intake-extraction';
import { KnowledgeBaseEnvironmentKind } from '../types/knowledge-base-environment-kind';
import type { FixRunResult } from '../types/fix-run-result';
import type {
    CollectedAgentArtifacts,
    DefaultSingleIssueDependencies,
    DefaultSingleIssueRequest,
    DefaultSingleIssueResult,
    FailedDefaultSingleIssue,
} from './single-issue-run-types';
import { DefaultSingleIssueFailure, DefaultSingleIssueResultKind } from './single-issue-run-types';

/**
 * Derive the git remote URL a repository identity materializes from.
 *
 * @param slug - The resolved repository identity.
 * @returns The https clone URL, or the empty string when no repository is configured.
 */
function deriveRemoteUrl(slug: RepositorySlug | null): string {
    return slug === null ? '' : `${GITHUB_HTTP_ORIGIN}${slug.owner}/${slug.repo}.git`;
}

/**
 * Build the investigation configuration a prepared workspace runs under.
 *
 * @param config - The validated run configuration.
 * @param filtersPath - Root of the prepared filters checkout.
 * @returns The configuration pinned to the prepared checkout, extension manifest version unset.
 */
function pinnedConfiguration(config: CoreConfig, filtersPath: string): CoreConfig {
    return {
        ...config,
        headless: true,
        repositoryPath: filtersPath,
        adguardExtensionManifestVersion: undefined,
    };
}

/**
 * Brand one opaque failure result.
 *
 * @param issueNumber - Issue the run was asked to process.
 * @param failureCode - The stable failure stage.
 * @param failureDetail - The underlying detail.
 * @returns The typed failed result.
 */
function failedResult(
    issueNumber: number,
    failureCode: DefaultSingleIssueFailure,
    failureDetail: string,
): FailedDefaultSingleIssue {
    return { kind: DefaultSingleIssueResultKind.Failed, issueNumber, failureCode, failureDetail };
}

/**
 * Dependencies a production run defaults to: the real intake extractor, forwarded into the shared
 * composition module. The seam is the one required dependency — no in-engine fallback — so a
 * hermetic fixture that omits it is a compile error instead of a real provider call.
 */
const PRODUCTION_SINGLE_ISSUE_DEPENDENCIES: DefaultSingleIssueDependencies = {
    extractReport,
};

/**
 * Attach the explicitly resolved GitHub token to every preparation command, without mutating the
 * process environment.
 *
 * The container action holds the run's token only as an action input (`INPUT_GITHUBTOKEN`), never
 * as a `GITHUB_TOKEN` environment variable, so the preparer's subprocesses would run git
 * anonymously inside the container. The wrapper carries the token on the command itself; the
 * subprocess builder derives the host-scoped credential from it for git alone.
 *
 * @param token - The request's resolved GitHub token, or `undefined` when the run holds none.
 * @param dependencies - The caller-supplied preparation seams, or `undefined` for the defaults.
 * @returns The dependencies whose runner attaches the token, or the input unchanged when no token
 *   is present so the CLI and no-token paths stay byte-identical.
 */
function withGitCredentialToken(
    token: string | undefined,
    dependencies: FiltersPreparationDependencies | undefined,
): FiltersPreparationDependencies | undefined {
    if (token === undefined) {
        return dependencies;
    }
    const base = dependencies ?? defaultDependencies;
    return {
        ...base,
        commandRunner: {
            run: (command) => base.commandRunner.run({ ...command, gitCredentialToken: token }),
        },
    };
}

/**
 * Run one issue through the default public engine.
 *
 * The filters ref is resolved from the remote's own HEAD before preparation, so a repository whose
 * default branch is not `master` materializes the right revision; a resolution failure ends the run
 * named as a workspace failure.
 *
 * @param request - The issue, its workspace source, and the posting policy.
 * @param dependencies - Injectable seams; production passes nothing and gets the real intake
 *   extractor through the shared module.
 * @returns How the per-issue run sealed.
 */
export async function runDefaultSingleIssue(
    request: DefaultSingleIssueRequest,
    dependencies: DefaultSingleIssueDependencies = PRODUCTION_SINGLE_ISSUE_DEPENDENCIES,
): Promise<DefaultSingleIssueResult> {
    const remoteUrl = deriveRemoteUrl(request.slug);
    if (remoteUrl.length === 0) {
        // A repositoryless snapshot run still needs the lists; there is no repository to materialize
        // the instruction or the list files from, so the run names what it lacks instead of cloning.
        return failedResult(
            request.issueNumber,
            DefaultSingleIssueFailure.WorkspaceUnavailable,
            'Run repository is not configured: point REPOSITORY_PATH at a git checkout with a parseable origin remote, or name a repository for the lists to be read from.',
        );
    }

    const logger = dependencies.logger ?? createLogger({ verbose: false });
    const preparationDependencies = withGitCredentialToken(
        request.token,
        dependencies.preparationDependencies,
    );
    let currentRef: string;
    try {
        currentRef = await resolveRemoteDefaultRef(
            remoteUrl,
            preparationDependencies?.commandRunner,
        );
    } catch (error) {
        logCaughtError(logger, 'filters default ref resolution', error, { remoteUrl });
        return failedResult(
            request.issueNumber,
            DefaultSingleIssueFailure.WorkspaceUnavailable,
            (error as Error).message,
        );
    }

    const filters: FiltersPreparationConfig = {
        environment: { kind: KnowledgeBaseEnvironmentKind.Current },
        ...(request.checkoutPath !== undefined ? { localSourcePath: request.checkoutPath } : {}),
        remoteUrl,
        currentRef,
        keepTemporaryFiles: false,
    };

    try {
        return await withPreparedFiltersCheckout(
            filters,
            (prepared) => runInsideWorkspace(request, prepared, dependencies),
            preparationDependencies,
        );
    } catch (error) {
        if (error instanceof FiltersPreparationError) {
            logCaughtError(logger, 'filters workspace preparation', error);
            return failedResult(
                request.issueNumber,
                DefaultSingleIssueFailure.WorkspaceUnavailable,
                error.message,
            );
        }
        throw error;
    }
}

/**
 * Run the workspace-bound half of a per-issue run: instruction, issue, investigation, posting.
 *
 * @param request - The per-issue request.
 * @param prepared - The disposable exact filters checkout.
 * @param dependencies - Injectable seams.
 * @returns How the per-issue run sealed.
 */
async function runInsideWorkspace(
    request: DefaultSingleIssueRequest,
    prepared: PreparedFiltersCheckout,
    dependencies: DefaultSingleIssueDependencies,
): Promise<DefaultSingleIssueResult> {
    const logger = dependencies.logger ?? createLogger({ verbose: false });
    let instruction: LoadedInstruction | null;
    try {
        instruction = await loadInstruction({
            checkoutRoot: prepared.checkoutPath,
            instructionPath: request.instructionPath,
        });
    } catch (error) {
        if (!(error instanceof InstructionLoadError)) {
            throw error;
        }
        logCaughtError(logger, 'instruction load', error);
        return failedResult(
            request.issueNumber,
            DefaultSingleIssueFailure.InstructionUnavailable,
            error.message,
        );
    }

    // The one file-backed gate: checked at the earliest point this face holds the loaded
    // instruction, before the issue is fetched or intake extraction pays for a model call. Every
    // issue this face runs — a single issue or one backlog issue — passes through here, so no
    // shipped file-backed example burns a paid extraction before the guaranteed refusal.
    if (instruction !== null) {
        const fileBackedRefusalDetail = fileBackedApplicationRefusalDetail(instruction.content);
        if (fileBackedRefusalDetail !== undefined) {
            logger.warn(
                { issueNumber: request.issueNumber, instructionPath: instruction.path },
                'run instruction declares an unsupported file-backed verification method; refusing before the issue is fetched or extracted',
            );
            return failedResult(
                request.issueNumber,
                DefaultSingleIssueFailure.FileBackedApplicationUnsupported,
                fileBackedRefusalDetail,
            );
        }
    }

    // A GitHub fetch is only reachable when the run repository is configured, which the caller
    // proved before the workspace was materialized.
    const slug = request.slug!;
    // Facts are not extracted yet at this point in the run; the container holds the raw issue
    // alone until intake extraction below produces the facts that complete a FixCoreIssueInput.
    let issue: Omit<DirectFixCoreIssueInput, 'facts'>;
    let rawIssue: RawIssue;
    let revisionDigest: string;
    try {
        if (request.issueSnapshotPath !== undefined) {
            const revision = (dependencies.loadIssueRevision ?? loadVerifiedExportedIssueRevision)(
                request.issueSnapshotPath,
            );
            const materialized = materializedSnapshotIssue(revision, request.artifactsDir);
            issue = materialized;
            rawIssue = materialized;
            revisionDigest = revision.revisionDigest;
        } else {
            const fetched = await (dependencies.fetchIssue ?? fetchIssue)(
                { owner: slug.owner, repo: slug.repo, token: request.token ?? '' },
                request.issueNumber,
                {
                    promptTextLimits: AUTOMATIC_UPSTREAM_PROMPT_TEXT_LIMITS,
                    trustedRoles: request.trustedRoles,
                    reportBots: request.reportBots,
                },
            );
            issue = fetched;
            rawIssue = fetched;
            revisionDigest = fetchedIssueRevisionDigest(fetched, slug);
        }
    } catch (error) {
        logCaughtError(logger, 'issue acquisition', error, { issueNumber: request.issueNumber });
        return failedResult(
            request.issueNumber,
            DefaultSingleIssueFailure.IssueUnavailable,
            (error as Error).message,
        );
    }

    // Checked before intake extraction, the run's first paid call: an issue with an excluded label,
    // a revision that already carries its report, or an issue the guard silences has nothing to do.
    let skip: PreRunSkip | null;
    try {
        skip = await checkIssueBeforeRun(
            {
                slug,
                issueNumber: request.issueNumber,
                revisionDigest,
                issueLabels: rawIssue.labels,
                commentsEnabled: request.commentsEnabled,
                token: request.token,
                settings: request,
            },
            dependencies.octokit,
            logger,
        );
    } catch (error) {
        logCaughtError(logger, 'pre-run issue check', error, { issueNumber: request.issueNumber });
        return failedResult(
            request.issueNumber,
            DefaultSingleIssueFailure.IssueUnavailable,
            (error as Error).message,
        );
    }
    if (skip !== null) {
        return {
            kind: DefaultSingleIssueResultKind.Skipped,
            issueNumber: request.issueNumber,
            reason: skip.reason,
            publication: skip.publication,
            artifactsDir: request.artifactsDir,
        };
    }

    const usageCollector = createRunUsageCollector();
    let intake: ExtractedIntakeFacts;
    try {
        intake = await extractIntakeFacts(rawIssue, {
            llm: request.config.llm,
            ...(request.model !== undefined ? { model: request.model } : {}),
            logger,
            extractReport: dependencies.extractReport,
            usageCollector,
            ...(request.trustedRoles !== undefined ? { trustedRoles: request.trustedRoles } : {}),
        });
    } catch (error) {
        logCaughtError(logger, 'intake extraction', error, { issueNumber: request.issueNumber });
        // Never posted: the reason is the provider's raw error, nothing the issue needs. The
        // rendered body is the run's human-readable record of the failure, so it still lands in
        // the artifacts directory.
        const body = renderUnpostedOutcomeReport(
            request,
            logger,
            instruction?.content,
            prepared.provenance.commit,
            MinimalOutcome.IntakeFailed,
            (error as Error).message,
        );
        writeRunReportArtifacts(request.artifactsDir, body);
        return failedResult(
            request.issueNumber,
            DefaultSingleIssueFailure.IssueUnavailable,
            (error as Error).message,
        );
    }
    if (intake.kind === IntakeExtractionKind.Skipped) {
        // Never posted: the issue needs no comment saying the run passed it by, and on a busy
        // repository such comments are most of what the action would write. The reason stays in
        // the log and the artifacts; without a marker, a backlog run rereads the issue.
        const body = renderUnpostedOutcomeReport(
            request,
            logger,
            instruction?.content,
            prepared.provenance.commit,
            MinimalOutcome.Skipped,
            intake.reason,
        );
        writeRunReportArtifacts(request.artifactsDir, body, {
            verdict: IntakeVerdict.NotAFilterReport,
            reason: intake.reason,
        });
        return {
            kind: DefaultSingleIssueResultKind.Skipped,
            issueNumber: request.issueNumber,
            reason: intake.reason,
            publication: null,
            artifactsDir: request.artifactsDir,
        };
    }

    // Investigation artifacts arrive through the core side channel; a holder keeps the writes
    // visible to the reads that follow, since a closure-assigned variable narrows at its read site.
    const agentArtifacts: CollectedAgentArtifacts = { artifacts: null };
    const coreDependencies: FixCoreDependencies = {
        onAgentRunArtifacts: (artifacts) => {
            agentArtifacts.artifacts = artifacts;
        },
        usageCollector,
    };
    const options: FixCoreOptions = {
        artifactsDir: request.artifactsDir,
        model: request.model,
        instruction: instruction ?? undefined,
        ...(instruction === null ? { loadDefaultRuleGuidance } : {}),
        // The lint runs in the checkout the workflow gave the run, not the disposable clone: only
        // there did the workflow install the repository's own dependencies, the linter among them.
        ...(request.lintCommand === undefined
            ? {}
            : {
                  repositoryLint: {
                      command: request.lintCommand,
                      checkoutRoot: request.checkoutPath ?? prepared.checkoutPath,
                  },
              }),
        agentRuntime: { executors: request.executors },
        ...(request.config.agentInvestigationBudgetMs !== undefined
            ? { maxDurationMs: request.config.agentInvestigationBudgetMs }
            : {}),
    };
    const investigatedIssue: FixCoreIssueInput = { ...issue, facts: intake.facts };
    const reportPayload: IntakeExtractionPayload = {
        verdict: IntakeVerdict.FilterReport,
        report: intake.report,
    };
    let runResult: FixRunResult;
    try {
        runResult = await (dependencies.investigate ?? runFixCore)(
            pinnedConfiguration(request.config, prepared.filtersPath),
            investigatedIssue,
            options,
            coreDependencies,
        );
    } catch (error) {
        logCaughtError(logger, 'investigation', error, { issueNumber: request.issueNumber });
        const body = renderUnpostedOutcomeReport(
            request,
            logger,
            instruction?.content,
            prepared.provenance.commit,
            MinimalOutcome.InvestigationFailed,
            (error as Error).message,
        );
        writeRunReportArtifacts(request.artifactsDir, body, reportPayload);
        return failedResult(
            request.issueNumber,
            DefaultSingleIssueFailure.InvestigationFailed,
            (error as Error).message,
        );
    }

    const template = resolveReportTemplate(instruction?.content).template;
    const reportedVersion = intake.report.environment.version;
    const summary = summarizeReportOutcome(
        { ...runResult, runStatus: reportedRunStatus(runResult) },
        {
            summary: agentArtifacts.artifacts?.decision?.summary,
            // A run the host ended itself (a sealed session) has no model decision; its result
            // still carries the reasoning the host kept, which the rationale shows instead.
            reasoning: agentArtifacts.artifacts?.decision?.reasoning ?? runResult.reasoning,
        },
        request.actionsRunUrl ?? '',
        reportedVersion,
    );
    if (
        reportedVersion !== undefined &&
        reportedVersion.length > 0 &&
        summary.versionUpdateHint.length === 0
    ) {
        logger.info(
            {
                reportedVersion,
                symptomObservation: runResult.symptomObservation ?? null,
                decision: decideVersionUpdate({
                    reportedVersion,
                    currentExecutorVersion:
                        runResult.environmentSelection?.actual?.productVersion ?? undefined,
                    symptomObservation: runResult.symptomObservation,
                }),
            },
            'version update hint stayed empty',
        );
    }
    const values = buildReportTemplateValues(summary);
    const filtersCommit = prepared.provenance.commit;
    const body = withReportFooter(renderReportComment(template, values), filtersCommit);
    writeRunReportArtifacts(request.artifactsDir, body, reportPayload, {
        runResult,
        artifacts: agentArtifacts.artifacts,
        usageSummary: usageCollector.summary(),
    });

    const silent = isSilentRun(runResult);
    if (silent) {
        logUnpostedOutcome(logger, request.issueNumber, summary.outcome, summary.outcomeReason);
    }
    if (!request.commentsEnabled || request.slug === null || silent) {
        return {
            kind: DefaultSingleIssueResultKind.Processed,
            issueNumber: request.issueNumber,
            runResult,
            publication: null,
            artifactsDir: request.artifactsDir,
        };
    }

    try {
        const client =
            dependencies.octokit ??
            createOctokit({
                owner: slug.owner,
                repo: slug.repo,
                token: request.token ?? '',
            });
        const reportAuthorLogin = await resolveReportAuthorLogin(client, logger);
        const screenshots = publishedRuleScreenshots(runResult);
        const publication = await publishGuardedReport(
            client,
            {
                owner: slug.owner,
                repo: slug.repo,
                issueNumber: request.issueNumber,
                revisionDigest,
                reportAuthorLogin,
                body,
                ...(screenshots === undefined
                    ? {}
                    : {
                          finalizeBody: async () =>
                              withReportFooter(
                                  renderReportComment(template, {
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
                                  }),
                                  filtersCommit,
                              ),
                      }),
            },
            request,
            logger,
        );
        return {
            kind: DefaultSingleIssueResultKind.Processed,
            issueNumber: request.issueNumber,
            runResult,
            publication,
            artifactsDir: request.artifactsDir,
        };
    } catch (error) {
        logCaughtError(logger, 'report publication', error, { issueNumber: request.issueNumber });
        return failedResult(
            request.issueNumber,
            DefaultSingleIssueFailure.PublicationFailed,
            (error as Error).message,
        );
    }
}
