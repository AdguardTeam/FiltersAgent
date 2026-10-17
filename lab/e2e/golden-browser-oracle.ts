import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBrowserToolHandlers } from '../../src/browser/browser-tools';
import { BrowserSession } from '../../src/browser/browser-session';
import { CloakBrowserEngine } from '../../src/browser/cloakbrowser-engine';
import { RedirectOriginPolicy } from '../../src/browser/redirect-origin-policy';
import {
    extractBrowserNetworkErrorCode,
    sanitizeNavigationTarget,
} from '../../src/browser/navigation-failure';
import { buildCandidateVisualBrowserFacts } from './candidate-visual-browser-facts';
import { profileFallbacks } from './repro-profile';
import type { CoreConfig } from '../../src/config/config';
import { createLogger } from '../../src/logger/logger';
import { createPiRuntimeFromConfig, createVisionClient } from '../../src/pi/llm-wiring';
import { extractIntakeReport } from '../../src/intake/extract-issue-facts';
import { IntakeExtractionKind } from '../../src/intake/extract-report';
import { reportToIssueFacts } from '../../src/intake/report-facts';
import { createRuntimeTraceRecorder } from '../../src/tracer/runtime-recorder';
import { RunMode, TraceEventType } from '../../src/types/trace';
import type { TraceRecorder } from '../../src/tracer/trace-recorder';
import {
    CandidateVisualVerdict,
    type CandidateVisualReview,
} from '../../src/types/candidate-visual-review';
import type { IssueFacts } from '../../src/types/issue-facts';
import type { ReproProfile } from '../../src/types/repro-profile';
import { ExtensionManifestVersion } from '../../src/environment/extension-preparation';
import { withPreparedFiltersCheckout } from '../../src/local/filters-preparer';
import { loadLocalIssueSnapshot, toAgentIssueInput } from '../../src/local/issue-snapshot';
import type { FiltersPreparationConfig } from '../../src/local/run-config-types';
import { resolveCandidateVisualEvidence } from '../../src/validator/candidate-evidence-resolver';
import { reviewCandidateVisually } from '../../src/validator/candidate-visual-verifier';
import { runValidation } from '../../src/validator/phase-orchestrator';
import { createTrustedValidationContext } from '../../src/validator/trusted-validation-context';
import type { GoldenOracleProbeResult } from './golden-comparator';
import type { GoldenOracleContext, GoldenCaseOracleProbe } from './golden-runner';
import { ExtensionEnvironmentKind } from '../../src/types/extension-environment-kind';
import {
    labExtensionCacheRoot,
    prepareHistoricalExtensionBuild,
} from '../local/historical-extension-build';
import {
    analyzeGoldenReporterScreenshots,
    buildGoldenReporterDefect,
} from './golden-reporter-defect';

const DEFAULT_FILTERS_REMOTE = 'https://github.com/AdguardTeam/AdguardFilters.git';

/**
 * Bounded semantic result returned by the independent human-candidate validation lifecycle.
 */
export interface GoldenHumanCandidateReview {
    /**
     * Vision model's final candidate verdict.
     */
    verdict: CandidateVisualReview['verdict'];

    /**
     * Whether before and after tiles covered the complete page.
     */
    coverageComplete: boolean;

    /**
     * Number of reporter-symptom instances seen before applying the human candidate.
     */
    beforeInstanceCount: number;

    /**
     * Number of matching instances left after applying the human candidate.
     */
    remainingInstanceCount: number;

    /**
     * Bounded vision rationale persisted for diagnostics.
     */
    rationale: string;
}

/**
 * Run the independent reporter-build browser lifecycle for one human commit candidate.
 */
export type GoldenHumanCandidateValidator = (
    coreConfig: CoreConfig,
    context: GoldenOracleContext,
) => Promise<GoldenHumanCandidateReview>;

/**
 * Injectable production-oracle seams used by focused classification tests.
 */
export interface GoldenBrowserOracleDependencies {
    /**
     * Full reporter-build extension/filter browser and vision validation lifecycle.
     */
    validateHumanCandidate?: GoldenHumanCandidateValidator;
}

/**
 * Reporter target could not be reached after the browser itself launched successfully.
 */
export class GoldenTargetSiteUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GoldenTargetSiteUnavailableError';
    }
}

/**
 * Bounded retry budget shared across fresh oracle sessions and their navigation handlers.
 */
export const GOLDEN_ORACLE_RETRY_POLICY = {
    profileAttempts: 3,
    openPageRetriesPerProfile: 1,
} as const;

/**
 * Render a bounded target-availability explanation after every oracle profile failed navigation.
 *
 * @param reportedUrl - Reporter-owned target URL selected before the human oracle starts.
 * @param rawError - Last browser failure, used only to extract a Chromium network code.
 * @param attemptedProfiles - Number of fresh browser profiles that attempted navigation.
 * @param plannedProfiles - Total bounded browser profiles planned for the oracle.
 * @returns Concise diagnostic without URL query data or Playwright call-log noise.
 */
export function formatGoldenTargetSiteUnavailable(
    reportedUrl: string,
    rawError: unknown,
    attemptedProfiles: number,
    plannedProfiles: number,
): string {
    const networkErrorCode = extractBrowserNetworkErrorCode(rawError);
    return (
        `Golden oracle could not reach ${sanitizeNavigationTarget(reportedUrl)} from this runner ` +
        `(${networkErrorCode ?? 'network connection failed'} in ${attemptedProfiles}/` +
        `${plannedProfiles} browser profiles).`
    );
}

/**
 * Resolve the exact parent rule required by a closed-oracle replacement candidate.
 *
 * @param candidate - Human diff candidate selected after the agent result was locked.
 * @returns Removed first-parent rule for replacement validation, or undefined for additive edits.
 */
export function resolveGoldenOracleReplacedRule(
    candidate: GoldenOracleContext['candidate'],
): string | undefined {
    if (candidate.repositoryEdit === 'replace') {
        if (!candidate.replacedRule?.trim()) {
            throw new Error('Golden replacement candidate is missing its first-parent rule.');
        }
        return candidate.replacedRule;
    }
    if (candidate.replacedRule !== undefined) {
        throw new Error('Golden additive candidate unexpectedly contains a replaced parent rule.');
    }
    return undefined;
}

/**
 * Select a bounded prefix of reproduction profiles for the independent oracle.
 *
 * `open_page` already performs the navigation attempt inside each fresh session. Capping the outer
 * profile sequence prevents the historical 12 profiles × 3 inner retries multiplication while
 * retaining three independent technical attempts.
 *
 * @param facts - Reporter facts used to derive profile variants.
 * @returns At most three profiles in normal fallback priority order.
 */
export function boundedGoldenOracleProfiles(facts: IssueFacts): ReproProfile[] {
    const profiles: ReproProfile[] = [];
    for (const profile of profileFallbacks(facts)) {
        profiles.push(profile);
        if (profiles.length >= GOLDEN_ORACLE_RETRY_POLICY.profileAttempts) {
            break;
        }
    }
    return profiles;
}

/**
 * Persist one independent oracle attempt trace beside its browser artifacts.
 *
 * @param recorder - Per-attempt redacting trace recorder.
 * @param artifactsDir - Attempt-specific artifact directory.
 * @param outcome - Stable attempt outcome.
 */
function persistOracleTrace(recorder: TraceRecorder, artifactsDir: string, outcome: string): void {
    const trace = recorder.end(outcome);
    writeFileSync(join(artifactsDir, 'trace.json'), `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
}

/**
 * Convert the full trusted visual review into the bounded post-run oracle result.
 *
 * @param review - Vision review bound to runner-owned before/after artifacts.
 * @returns Bounded fields needed for regression/drift classification.
 */
function summarizeReview(review: CandidateVisualReview): GoldenHumanCandidateReview {
    return {
        verdict: review.verdict,
        coverageComplete: review.coverageComplete,
        beforeInstanceCount: review.beforeInstances.length,
        remainingInstanceCount: review.remainingInstances.length,
        rationale: review.rationale,
    };
}

/**
 * Run one browser/vision attempt under an exact prepared extension and filters checkout.
 *
 * @param coreConfig - Headless browser and vision-provider configuration.
 * @param context - Post-run golden case context.
 * @param extensionPath - Prepared unpacked Chrome MV3 extension.
 * @param manifestVersion - Verified extension manifest generation.
 * @param filtersPath - Prepared historical AdguardFilters checkout.
 * @returns First complete candidate visual review.
 */
async function validatePreparedHumanCandidate(
    coreConfig: CoreConfig,
    context: GoldenOracleContext,
    extensionPath: string,
    manifestVersion: ExtensionManifestVersion,
    filtersPath: string,
): Promise<GoldenHumanCandidateReview> {
    const snapshot = loadLocalIssueSnapshot(context.issueFile);
    const issue = toAgentIssueInput(snapshot);
    // The reported site URL and the settings profile come from the intake extraction's mapped
    // facts, never from a deterministic re-parse of the issue body.
    const extraction = await extractIntakeReport(issue, { llm: coreConfig.llm });
    if (extraction.kind === IntakeExtractionKind.Skipped) {
        throw new Error(
            `Golden oracle requires a filter report; the intake extraction skipped the issue: ` +
                `${extraction.reason}`,
        );
    }
    const facts = reportToIssueFacts(
        { number: issue.number, url: issue.url, labels: issue.labels },
        extraction.report,
    );
    const reportedUrl = facts.reportedSiteUrls[0];
    if (!reportedUrl) {
        throw new Error('Golden oracle requires one reported site URL.');
    }
    const trustedValidationContext = createTrustedValidationContext(reportedUrl, filtersPath);
    const replacedRule = resolveGoldenOracleReplacedRule(context.candidate);
    const piRuntime = await createPiRuntimeFromConfig(coreConfig.llm);
    const vision = createVisionClient(piRuntime, coreConfig.llm, { logger: createLogger() });
    const oracleCandidateHash = createHash('sha256')
        .update(`${context.candidate.filePath}\0${context.candidate.rule}\0${replacedRule ?? ''}`)
        .digest('hex')
        .slice(0, 12);
    const oracleRoot = join(context.outputDirectory, 'oracle', `candidate-${oracleCandidateHash}`);
    rmSync(oracleRoot, { recursive: true, force: true });
    mkdirSync(oracleRoot, { recursive: true });
    const reporterScreenshotObservations = await analyzeGoldenReporterScreenshots(snapshot, vision);
    const reporterDefect = buildGoldenReporterDefect(snapshot, reporterScreenshotObservations);
    writeFileSync(
        join(oracleRoot, 'reporter-screenshot-observations.json'),
        `${JSON.stringify(reporterScreenshotObservations, null, 2)}\n`,
        'utf8',
    );
    let lastTargetSiteError: GoldenTargetSiteUnavailableError | undefined;
    let lastInfrastructureError: unknown;
    let attemptNumber = 0;

    const reproductionProfiles = boundedGoldenOracleProfiles(facts);
    for (const reproductionProfile of reproductionProfiles) {
        attemptNumber += 1;
        const artifactsDir = join(oracleRoot, `attempt-${attemptNumber}`);
        mkdirSync(artifactsDir, { recursive: true });
        const recorder = createRuntimeTraceRecorder({
            runId: randomUUID(),
            issueNumber: context.run.issueNumber,
            mode: RunMode.Fix,
        });
        let session: BrowserSession | undefined;
        let outcome = 'infrastructure_failure';
        try {
            session = await BrowserSession.create({
                engine: new CloakBrowserEngine(),
                logger: createLogger(),
                reproProfile: reproductionProfile,
                artifactsDir,
                headless: true,
                noSandbox: coreConfig.noSandbox,
                // A plain unpacked-extension launch. The oracle's sessions
                // boot the extension's own defaults; no settings profile is applied host-side.
                adguardExtensionPath: extensionPath,
                adguardExtensionManifestVersion: manifestVersion,
            });
            const handlers = createBrowserToolHandlers({
                session,
                recorder,
                artifactsDir,
                allowedOrigin: reportedUrl,
                redirectOriginPolicy: RedirectOriginPolicy.KeepRelatedHosts,
                openPageRetries: GOLDEN_ORACLE_RETRY_POLICY.openPageRetriesPerProfile,
                consentStrategy: reproductionProfile.consentStrategy,
            });
            const factual = await runValidation({
                handlers,
                page: session.getPage(),
                artifactsDir,
                recorder,
                url: reportedUrl,
                candidateRule: context.candidate.rule,
                existingRules: [...trustedValidationContext.existingRules],
                replacedRule,
                trustedValidationContext,
            });
            const phaseError = factual.phaseA.error ?? factual.phaseB.error ?? factual.phaseC.error;
            if (phaseError) {
                throw new GoldenTargetSiteUnavailableError(phaseError);
            }
            const candidateHash = createHash('sha256')
                .update(context.candidate.rule)
                .digest('hex')
                .slice(0, 12);
            const evidence = resolveCandidateVisualEvidence({
                artifactsDir,
                recorder,
                validationArtifactId: `validation-${candidateHash}`,
            });
            const visual = await reviewCandidateVisually({
                candidateRule: context.candidate.rule,
                validationArtifactId: `validation-${candidateHash}`,
                evidence: {
                    beforeViewport: evidence.beforeViewport,
                    afterViewport: evidence.afterViewport,
                    beforeFullPage: evidence.beforeFullPage,
                    afterFullPage: evidence.afterFullPage,
                    beforeTiles: evidence.beforeTiles,
                    afterTiles: evidence.afterTiles,
                    beforeCoverageComplete: evidence.beforeCoverageComplete,
                    afterCoverageComplete: evidence.afterCoverageComplete,
                },
                reporterSymptom: reporterDefect,
                reportedPageUrl: reportedUrl,
                browserFacts: JSON.stringify(buildCandidateVisualBrowserFacts(factual)),
                artifactsDir,
                vision,
                recorder,
            });
            outcome = visual.review.verdict;
            return summarizeReview(visual.review);
        } catch (error) {
            if (error instanceof GoldenTargetSiteUnavailableError) {
                lastTargetSiteError = error;
            } else {
                lastInfrastructureError = error;
            }
            recorder.record(TraceEventType.Error, {
                phase: 'golden_oracle',
                error: (error as Error).message,
            });
        } finally {
            if (session) {
                await session.close();
            }
            persistOracleTrace(recorder, artifactsDir, outcome);
        }
    }
    if (lastInfrastructureError instanceof Error) {
        throw lastInfrastructureError;
    }
    if (lastTargetSiteError) {
        throw new GoldenTargetSiteUnavailableError(
            formatGoldenTargetSiteUnavailable(
                reportedUrl,
                lastTargetSiteError.message,
                attemptNumber,
                reproductionProfiles.length,
            ),
        );
    }
    throw new Error('Golden oracle exhausted every browser profile.');
}

/**
 * Rebuild the historical filter checkout configuration from the locked public case.
 *
 * @param context - Post-run context that excludes the human commit identity.
 * @returns Exact filter checkout configuration for an independent browser and vision probe.
 */
export function buildOracleFiltersConfig(context: GoldenOracleContext): FiltersPreparationConfig {
    return {
        environment: {
            kind: ExtensionEnvironmentKind.Historical,
            baseSha: context.run.filtersBaseSha,
        },
        remoteUrl: DEFAULT_FILTERS_REMOTE,
        currentRef: 'master',
        keepTemporaryFiles: false,
    };
}

/**
 * Rebuild the reporter extension and validate a human candidate without invoking an agent loop.
 *
 * @param coreConfig - GitHub-independent browser and vision configuration.
 * @param context - Closed post-run oracle context.
 * @returns Bound vision review summary for classification.
 */
export async function validateHumanCandidateInHistoricalBuild(
    coreConfig: CoreConfig,
    context: GoldenOracleContext,
): Promise<GoldenHumanCandidateReview> {
    const build = context.extensionBuild;
    return withPreparedFiltersCheckout(
        buildOracleFiltersConfig(context),
        async (preparedFilters) => {
            const release = await prepareHistoricalExtensionBuild({
                build: {
                    version: build.version,
                    releaseTag: build.releaseTag,
                    autobuildCommit: build.autobuildCommit,
                },
                cacheRoot: labExtensionCacheRoot(process.cwd()),
                logger: createLogger(),
            });
            if (
                context.expectedReleaseSha256 !== null &&
                release.provenance.releaseSha256 !== context.expectedReleaseSha256
            ) {
                throw new Error(
                    `Golden reporter build release digest changed: locked ${context.expectedReleaseSha256}, ` +
                        `prepared ${release.provenance.releaseSha256}.`,
                );
            }
            if (release.manifestVersion !== ExtensionManifestVersion.Mv3) {
                throw new Error(
                    'Local browser runs currently support only Chromium with an MV3 extension; ' +
                        `the reporter build declares manifest_version=${release.manifestVersion}.`,
                );
            }
            return validatePreparedHumanCandidate(
                coreConfig,
                context,
                release.extensionDir,
                release.manifestVersion,
                preparedFilters.filtersPath,
            );
        },
    );
}

/**
 * Build the production post-run probe that distinguishes agent regression from environment drift.
 *
 * @param coreConfig - GitHub-independent browser and vision configuration.
 * @param dependencies - Optional real-validator seam for focused tests.
 * @returns Probe suitable for {@link runGoldenE2ECase}.
 */
export function createGoldenBrowserOracleProbe(
    coreConfig: CoreConfig,
    dependencies: GoldenBrowserOracleDependencies = {},
): GoldenCaseOracleProbe {
    const validateHumanCandidate =
        dependencies.validateHumanCandidate ?? validateHumanCandidateInHistoricalBuild;
    return async (context): Promise<GoldenOracleProbeResult> => {
        try {
            const review = await validateHumanCandidate(coreConfig, context);
            if (review.verdict === CandidateVisualVerdict.Verified) {
                return { status: 'verified', detail: review.rationale };
            }
            if (
                review.verdict === CandidateVisualVerdict.Rejected ||
                (review.coverageComplete && review.beforeInstanceCount === 0)
            ) {
                return { status: 'not_verified', detail: review.rationale };
            }
            return {
                status: 'infrastructure_failure',
                detail: `Human-candidate vision was inconclusive: ${review.rationale}`,
            };
        } catch (error) {
            if (error instanceof GoldenTargetSiteUnavailableError) {
                return {
                    status: 'infrastructure_failure',
                    detail: error.message,
                };
            }
            return {
                status: 'infrastructure_failure',
                detail: error instanceof Error ? error.message : String(error),
            };
        }
    };
}
