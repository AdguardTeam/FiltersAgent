import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
    isAbsolute,
    join,
    relative,
    resolve as resolveLocalFixRunnerCandidateTargetPath,
} from 'node:path';
import * as v from 'valibot';
import type { BlockerModuleRunDependencies } from '../../src/proxy-blocker/blocker-module-executor';
import type { ExecutorName } from '../../src/environment/executor-name';
import { labExecutorSet } from './blocker-modules';
import type { CoreConfig } from '../../src/config/config';
import { createRunUsageCollector } from '../../src/pi/usage-collector';
import { type RunUsageSummary, type UsageRatesTable } from '../../src/types/usage-summary';
import { extractIntakeFacts } from '../../src/entry/intake-extraction';
import { IntakeExtractionKind, type extractReport } from '../../src/intake/extract-report';
import { createLogger } from '../../src/logger/logger';
import { runFixCore } from '../../src/orchestrator/fix-core';
import { applyRepositoryEdit } from '../../src/repo/repository-edit';
import {
    CurrentRulesResolutionStatus,
    EffectiveMode,
    FixRunResultSchema,
    ReproductionSettingsStatus,
    VerificationStatus,
    type BrowserMode,
    type CandidatePatch,
    type FixRunResult,
} from '../../src/types/fix-run-result';
import {
    AgentRunArtifactsSchema,
    type AgentRunArtifacts,
} from '../../src/types/agent-run-artifacts';
import { redactPayload, sanitizeFailureMessage } from '../../src/tracer/redactor';
import {
    LocalExecutionInfrastructureError,
    LocalInfrastructureFailureCategory,
} from './cycle-outcome';
import { withPreparedFiltersCheckout } from '../../src/local/filters-preparer';
import { runPreparationSubprocess } from '../../src/local/preparation-subprocess';
import { observeUpstreamDrift } from './upstream-drift';
import {
    withPreparedKnowledgeBase,
    guidanceRepositorySlugFromRemote,
} from './knowledge-base-preparer';
import type { PreparedKnowledgeBase } from './knowledge-base-preparer';
import {
    loadRunInstruction,
    refuseLoadedRunInstruction,
    toInstructionProvenance,
} from './instruction-provisioning';
import { fileBackedApplicationRefusalDetail } from '../../src/knowledge/instruction-application';
import { parseRepositorySlugFromGitUrl } from '../../src/types/repository-slug';
import type { VerifiedIssueRevision } from '../../src/local/issue-revision';
import { clearLocalRunOutputDir } from '../../src/local/output-directory';
import {
    publishLocalRun,
    writeLocalPublicationSanitizationFailure,
} from '../../src/local/evidence-publication';
import { LocalPublicationTrustError } from '../../src/local/local-publication-trust';
import { loadLocalRunConfig } from './run-config';
import {
    prepareHistoricalExtensionBuild,
    labExtensionCacheRoot,
} from './historical-extension-build';
import {
    loadHistoricalBuildExtension,
    type PreparedExtension,
} from '../../src/local/prepared-extension';
import { RedirectOriginPolicy } from '../../src/browser/redirect-origin-policy';
import {
    LocalFailureStage,
    INTAKE_SKIPPED_PREFIX,
    FileBackedApplicationRefusalError,
    infrastructureFailureReasonForStage,
} from './local-failure-stage';
import type { LocalRunConfig } from '../../src/local/run-config-types';
import {
    writeLocalRunOutput,
    type LocalRunOutputPaths,
    type LocalRunRecord,
} from '../../src/local/run-output';
import { recordPreflightDiagnostic } from '../../src/local/preflight-diagnostic-log';
import { buildLocalRunRecord, type LocalCoreExecution } from './local-run-record';
import {
    createPrivateEvidenceCollection,
    publishVerifiedLocalResult,
    removePrivateEvidenceCollection,
    type PrivateEvidenceCollection,
} from './local-evidence-publish-step';
import {
    loadLegacyLocalFixInput,
    materializeVerifiedLocalFixInput,
    type LocalFixInputLoader,
} from './local-fix-input';
import { ExtensionEnvironmentKind } from '../../src/types/extension-environment-kind';
import { RepositoryEditKind } from '../../src/types/repository-edit-kind';
import { KnowledgeBaseEnvironmentKind } from '../../src/types/knowledge-base-environment-kind';

/**
 * CLI-independent options for one local browser-first fix run.
 */
export interface RunLocalFixOptions {
    /**
     * Present the historical report as open and unassigned without resolution labels.
     */
    neutralIssueInput?: boolean;

    /**
     * Refuse loaded repository instructions before preparing guidance or running the core.
     */
    refuseRepositoryInstruction?: boolean;

    /**
     * Issue number expected in the local snapshot.
     */
    issueNumber: number;

    /**
     * Integrity-checked local `issue.json` path.
     */
    issueFile: string;

    /**
     * Current or exact historical environment.
     */
    environment: ExtensionEnvironmentKind;

    /**
     * Absolute directory for the report and all runtime artifacts.
     */
    outputDir: string;

    /**
     * Historical case configuration or optional current overrides.
     */
    runConfig?: string;

    /**
     * Explicit debug retention for the temporary disposable checkouts.
     */
    keepTemporaryFiles: boolean;

    /**
     * Browser-first execution policy (`auto` or `on`) enforced by the agentic core.
     */
    browserMode: BrowserMode;

    /**
     * Stop the run right after the environment selection is accepted.
     */
    routingCheck?: boolean;

    /**
     * Optional reasoning model override.
     */
    model?: string;

    /**
     * Whether verbose operational logging is enabled.
     */
    verbose: boolean;

    /**
     * Optional frozen model pricing used when the provider omits billed cost.
     */
    pricingSnapshot?: UsageRatesTable;

    /**
     * Trusted campaign-wide KnowledgeBase commit used instead of resolving moving master.
     */
    knowledgeBaseSha?: string;

    /**
     * The blocker modules this run's locked selections start, keyed by executor name; the run locks
     * the browser extension and every module listed here.
     */
    executorDependencies?: Readonly<Record<ExecutorName, BlockerModuleRunDependencies>>;
}

/**
 * CLI-independent options for a fix run whose issue revision is already verified in memory.
 */
export interface RunVerifiedLocalFixOptions {
    /**
     * Refuse loaded repository instructions before preparing guidance or running the core.
     */
    refuseRepositoryInstruction?: boolean;

    /**
     * Issue number expected in the verified revision.
     */
    issueNumber: number;

    /**
     * Current or exact historical environment.
     */
    environment: ExtensionEnvironmentKind;

    /**
     * Absolute directory for the report and all runtime artifacts.
     */
    outputDir: string;

    /**
     * Historical case configuration or optional current overrides.
     */
    runConfig?: string;

    /**
     * Explicit debug retention for the temporary disposable checkouts.
     */
    keepTemporaryFiles: boolean;

    /**
     * Browser-first execution policy enforced by the agentic core.
     */
    browserMode: BrowserMode;

    /**
     * Stop the run right after the environment selection is accepted.
     */
    routingCheck?: boolean;

    /**
     * Optional reasoning model override.
     */
    model?: string;

    /**
     * Whether verbose operational logging is enabled.
     */
    verbose: boolean;

    /**
     * Cancellation signal raised when an automatic queue lease is lost.
     */
    signal?: AbortSignal;

    /**
     * Optional frozen model pricing used when the provider omits billed cost.
     */
    pricingSnapshot?: UsageRatesTable;

    /**
     * Trusted campaign-wide KnowledgeBase commit used instead of resolving moving master.
     */
    knowledgeBaseSha?: string;

    /**
     * The blocker modules this run's locked selections start, keyed by executor name; built by the
     * caller from the modules `--blocker-module` plugs in.
     */
    executorDependencies?: Readonly<Record<ExecutorName, BlockerModuleRunDependencies>>;

    /**
     * Validated executor set this run locks, already checked against the registered names by the
     * entry resolver; absent locks the browser extension and every module in
     * `executorDependencies`.
     */
    executors?: readonly string[];

    /**
     * The repository's own lint command line, run over each candidate in the local filters source
     * (the clone when there is none); absent runs no lint.
     */
    lintCommand?: string;
}

/**
 * Apply an optional trusted campaign documentation pin to a resolved local environment.
 *
 * @param config - Fully resolved local source configuration.
 * @param knowledgeBaseSha - Optional full campaign-wide KnowledgeBase commit.
 * @returns Configuration with an exact documentation revision when supplied.
 */
function withPinnedKnowledgeBase<T extends LocalRunConfig>(
    config: T,
    knowledgeBaseSha: string | undefined,
): T {
    if (knowledgeBaseSha === undefined) {
        return config;
    }
    const normalized = knowledgeBaseSha.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/u.test(normalized)) {
        throw new Error('Campaign KnowledgeBase SHA must be a full 40-character commit.');
    }
    return {
        ...config,
        knowledgeBase: {
            ...config.knowledgeBase,
            environment: { kind: KnowledgeBaseEnvironmentKind.Pinned, commit: normalized },
        },
    };
}

/**
 * Injectable local lifecycle seams used by unit tests.
 */
export interface LocalFixRunnerDependencies {
    /**
     * Prepare the reporter extension without reaching release or git transports in tests.
     */
    prepareHistoricalExtensionBuild?: typeof prepareHistoricalExtensionBuild;

    /**
     * Temporary AdguardFilters checkout lifecycle.
     */
    withPreparedFiltersCheckout?: typeof withPreparedFiltersCheckout;

    /**
     * Temporary pinned/current KnowledgeBase preparation lifecycle.
     */
    withPreparedKnowledgeBase?: typeof withPreparedKnowledgeBase;

    /**
     * Read-only observation of where upstream stands relative to the pinned commit.
     */
    observeUpstreamDrift?: typeof observeUpstreamDrift;

    /**
     * GitHub-independent investigation core.
     */
    runFixCore?: typeof runFixCore;

    /**
     * Intake extraction seam: the production extraction builds its own single-shot client from the
     * core configuration; tests inject a scripted or stubbed extraction so no suite reaches the
     * provider network.
     */
    extractReport?: typeof extractReport;

    /**
     * Append-only local evidence and review publisher.
     */
    publishLocalRun?: typeof publishLocalRun;

    /**
     * UUID source for private raw collection ownership.
     */
    createCollectionId?: () => string;
}

/**
 * Resolve the owner/repo slug of the run's configured filters remote for a failed record.
 *
 * A failure at or before configuration loading has no trustworthy remote at all, and the record
 * stays honest by leaving the repository unset instead of naming any pinned vendor default.
 *
 * @param filtersRemoteUrl - Configured filters remote captured once the run config loaded.
 * @returns The owner/repo slug, or null when the run configuration never loaded or the remote does
 *   not name an owner/repo pair.
 */
function configuredFiltersRepository(filtersRemoteUrl: string | null): string | null {
    if (!filtersRemoteUrl) {
        return null;
    }
    const slug = parseRepositorySlugFromGitUrl(filtersRemoteUrl);
    return slug ? `${slug.owner}/${slug.repo}` : null;
}

/**
 * Resolve a candidate target file inside the exact disposable filters checkout.
 *
 * @param checkoutPath - Prepared AdguardFilters checkout root.
 * @param filePath - Candidate repository-relative path.
 * @returns Canonical target path contained by the checkout.
 */
function resolveCandidateTarget(checkoutPath: string, filePath: string): string {
    const root = resolveLocalFixRunnerCandidateTargetPath(checkoutPath);
    const target = resolveLocalFixRunnerCandidateTargetPath(root, filePath);
    const relativePath = relative(root, target);
    if (
        relativePath === '' ||
        relativePath === '..' ||
        relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
        isAbsolute(relativePath)
    ) {
        throw new Error(`Candidate file escapes the filters checkout: ${filePath}`);
    }
    return target;
}

/**
 * Render an exact runner-derived repository edit as a valid unified patch with bounded context.
 *
 * @param checkoutPath - Exact filters checkout used by the agent.
 * @param candidate - Locked candidate patch.
 * @returns Unified diff that inserts the candidate or extends an existing domain list.
 */
export function renderLocalCandidatePatch(checkoutPath: string, candidate: CandidatePatch): string {
    if (/\r|\n/.test(candidate.rule)) {
        throw new Error('Local candidate patch must contain exactly one filter rule.');
    }
    const targetPath = resolveCandidateTarget(checkoutPath, candidate.filePath);
    const content = readFileSync(targetPath, 'utf8');
    const normalizedContent = content.replace(/\r\n?/g, '\n');
    const lines = normalizedContent.endsWith('\n')
        ? normalizedContent.slice(0, -1).split('\n')
        : normalizedContent.split('\n');
    const repositoryEdit = candidate.repositoryEdit ?? {
        kind: RepositoryEditKind.Insert,
        ...(candidate.insertionPoint === undefined
            ? {}
            : { insertionPoint: candidate.insertionPoint }),
    };
    applyRepositoryEdit(content, candidate.rule, repositoryEdit);
    if (repositoryEdit.kind !== RepositoryEditKind.Insert) {
        const sourceIndex = repositoryEdit.line - 1;
        const contextStart = Math.max(0, sourceIndex - 3);
        const contextEnd = Math.min(lines.length, sourceIndex + 4);
        const beforeContext = lines.slice(contextStart, sourceIndex);
        const afterContext = lines.slice(sourceIndex + 1, contextEnd);
        const oldCount = beforeContext.length + 1 + afterContext.length;
        const newCount =
            repositoryEdit.kind === RepositoryEditKind.Remove ? oldCount - 1 : oldCount;
        const start = contextStart + 1;
        const replacement =
            repositoryEdit.kind === RepositoryEditKind.Remove
                ? []
                : [`+${repositoryEdit.replacementRule}`];
        return [
            `diff --git a/${candidate.filePath} b/${candidate.filePath}`,
            `--- a/${candidate.filePath}`,
            `+++ b/${candidate.filePath}`,
            `@@ -${start},${oldCount} +${start},${newCount} @@`,
            ...beforeContext.map((line) => ` ${line}`),
            `-${repositoryEdit.originalRule}`,
            ...replacement,
            ...afterContext.map((line) => ` ${line}`),
        ].join('\n');
    }
    const insertionPoint = repositoryEdit.insertionPoint ?? lines.length;
    if (insertionPoint < 0 || insertionPoint > lines.length) {
        throw new Error(`Candidate insertion point ${insertionPoint} is outside the target file.`);
    }
    const contextStart = Math.max(0, insertionPoint - 3);
    const contextEnd = Math.min(lines.length, insertionPoint + 3);
    const beforeContext = lines.slice(contextStart, insertionPoint);
    const afterContext = lines.slice(insertionPoint, contextEnd);
    const oldCount = beforeContext.length + afterContext.length;
    const newCount = oldCount + 1;
    const oldStart = oldCount === 0 ? 0 : contextStart + 1;
    const newStart = contextStart + 1;
    return [
        `diff --git a/${candidate.filePath} b/${candidate.filePath}`,
        `--- a/${candidate.filePath}`,
        `+++ b/${candidate.filePath}`,
        `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
        ...beforeContext.map((line) => ` ${line}`),
        `+${candidate.rule}`,
        ...afterContext.map((line) => ` ${line}`),
    ].join('\n');
}

/**
 * Validate the caller-owned output root and clear the dedicated prior run directory.
 *
 * @param outputDir - Absolute local run output directory.
 * @param workspaceRoot - Repository root used to constrain project-local output to `tmp/`.
 * @returns Canonical empty directory reserved for this run's artifacts.
 */
function prepareOutputArtifacts(outputDir: string, workspaceRoot: string): string {
    return clearLocalRunOutputDir(outputDir, workspaceRoot, ['runs', 'collections']);
}

/**
 * Remove configured host secrets from a core result before local rendering or persistence.
 *
 * @param result - Core-owned terminal result that may contain a provider diagnostic.
 * @param secrets - Exact host-only values that must not enter local artifacts.
 * @returns Defensive result with nested strings redacted.
 */
function redactFixRunResult(result: FixRunResult, secrets: readonly string[]): FixRunResult {
    // Session identifiers are runner-owned correlation ids, and the result's invariants bind
    // candidate evidence to exactly one of them. Blanking every id to the same placeholder makes
    // distinct sessions indistinguishable and fails that binding on any multi-session run, so
    // they are pseudonymized: the raw value still never survives.
    const redacted = redactPayload(result, secrets, {
        pseudonymizeKeys: ['sessionId'],
    });
    const parsed = v.safeParse(FixRunResultSchema, redacted);
    if (!parsed.success) {
        // The core already validated this exact result, so a rejection here means redaction
        // changed a compared value; keep the issues and the first divergent path diagnosable.
        recordPreflightDiagnostic('run', {
            note: 'redacted_result_schema_rejected',
            issues: parsed.issues.map((issue) => issue.message).slice(0, 8),
            divergentPaths: findDivergentPaths(result, redacted).slice(0, 12),
        });
    }
    return v.parse(FixRunResultSchema, redacted);
}

/**
 * List dot paths whose values differ between the original and redacted projections.
 *
 * @param before - Core-validated result.
 * @param after - Redacted projection of the same result.
 * @param prefix - Dot path accumulated by the recursion.
 * @returns Bounded list of divergent value paths.
 */
function findDivergentPaths(before: unknown, after: unknown, prefix = ''): string[] {
    if (JSON.stringify(before) === JSON.stringify(after)) {
        return [];
    }
    if (
        typeof before !== 'object' ||
        typeof after !== 'object' ||
        before === null ||
        after === null
    ) {
        return [prefix || '(root)'];
    }
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const paths: string[] = [];
    for (const key of keys) {
        paths.push(
            ...findDivergentPaths(
                (before as Record<string, unknown>)[key],
                (after as Record<string, unknown>)[key],
                prefix ? `${prefix}.${key}` : key,
            ),
        );
        if (paths.length >= 12) {
            break;
        }
    }
    return paths;
}

/**
 * Remove configured host secrets from model-owned artifacts before local persistence.
 *
 * @param artifacts - Terminal decision and delivered observations captured by the core.
 * @param secrets - Exact host-only values that must not enter local artifacts.
 * @returns Schema-valid defensive artifacts with nested strings redacted.
 */
function redactAgentRunArtifacts(
    artifacts: AgentRunArtifacts,
    secrets: readonly string[],
): AgentRunArtifacts {
    return v.parse(AgentRunArtifactsSchema, redactPayload(artifacts, secrets));
}

/**
 * Build a canonical failed record without writing it to either output model.
 *
 * @param options - Local run identity and output directory.
 * @param domain - Parsed reported domain when available.
 * @param stage - Lifecycle stage that raised the error.
 * @param error - Input, preparation, core, or output error.
 * @param filtersBaseSha - Prepared AdguardFilters commit, when environment setup reached it.
 * @param filtersRepository - Owner/repo slug of the run's configured filters remote, or null when
 *   the run configuration never loaded.
 * @param secrets - Exact host-only values to remove from the record.
 * @returns Canonical failed local run record with no candidate.
 */
function buildLocalFailureRecord(
    options: RunVerifiedLocalFixOptions,
    domain: string,
    stage: LocalFailureStage,
    error: unknown,
    filtersBaseSha: string | null,
    filtersRepository: string | null,
    secrets: readonly string[] = [],
): LocalRunRecord {
    const message = sanitizeFailureMessage(error, secrets, 1_000);
    let stageSummary = 'Local output generation failed';
    if (stage === LocalFailureStage.Input) {
        stageSummary = 'Local input validation failed';
    } else if (stage === LocalFailureStage.Environment) {
        stageSummary = 'Local environment preparation failed';
    } else if (stage === LocalFailureStage.Core) {
        stageSummary = 'Local core execution failed';
    }
    const infrastructureFailureReason = infrastructureFailureReasonForStage(stage, error);
    const result: FixRunResult = {
        issueNumber: options.issueNumber,
        domain,
        runStatus: 'failed',
        requestedBrowserMode: options.browserMode,
        effectiveMode: EffectiveMode.Browser,
        verificationStatus: VerificationStatus.Unavailable,
        reproductionSettingsStatus: ReproductionSettingsStatus.ParsedNotApplied,
        reproductionSettingsDetail: `${stageSummary}.`,
        symptomObservation: 'not_attempted',
        currentRulesResolutionStatus: CurrentRulesResolutionStatus.NotAttempted,
        fallbackReason: null,
        fallbackDetail: message,
        ...(infrastructureFailureReason ? { infrastructureFailureReason } : {}),
        candidatePatch: null,
        artifactPaths: {
            screenshots: [],
            domSnapshot: null,
            har: null,
            trace: null,
            settingsProof: null,
            browserLog: null,
        },
        reasoning: `${stageSummary}: ${message}`,
        repository: null,
        baseSha: null,
        filtersRepository,
        filtersBaseSha,
    };
    return {
        result,
        provenance: {
            environment: options.environment,
            headless: true,
            extension: null,
            settingsProfiles: [],
        },
        evidence: {
            summary: result.reasoning,
            userScreenshots: [],
            unfilteredScreenshots: [],
            profileScreenshots: [],
            beforeScreenshots: [],
            afterScreenshots: [],
            beforeFullPageScreenshots: [],
            afterFullPageScreenshots: [],
            rejectedScreenshots: [],
            rejectedPairs: [],
        },
        artifacts: [],
    };
}

/**
 * Write a legacy local failed result when a pre-result lifecycle stage cannot complete.
 *
 * @param options - Local run identity and output directory.
 * @param domain - Parsed reported domain when available.
 * @param stage - Lifecycle stage that raised the error.
 * @param error - Input, preparation, core, or output error.
 * @param filtersBaseSha - Prepared AdguardFilters commit, when environment setup reached it.
 * @param filtersRepository - Owner/repo slug of the run's configured filters remote, or null when
 *   the run configuration never loaded.
 * @param agentRunArtifacts - Model decision and delivered observations captured before failure.
 * @param llmUsage - Provider usage summary captured before the failure.
 * @param secrets - Exact host-only values to remove before rendering or persistence.
 * @returns Persisted report/result paths with no candidate.
 */
function writeLocalFailure(
    options: RunVerifiedLocalFixOptions,
    domain: string,
    stage: LocalFailureStage,
    error: unknown,
    filtersBaseSha: string | null,
    filtersRepository: string | null,
    agentRunArtifacts: AgentRunArtifacts,
    llmUsage: RunUsageSummary,
    secrets: readonly string[] = [],
): LocalRunOutputPaths {
    return writeLocalRunOutput(
        buildLocalFailureRecord(
            options,
            domain,
            stage,
            error,
            filtersBaseSha,
            filtersRepository,
            secrets,
        ),
        {
            outputDir: options.outputDir,
            workspaceRoot: process.cwd(),
            agentRunArtifacts: redactAgentRunArtifacts(agentRunArtifacts, secrets),
            llmUsage,
        },
    );
}

/**
 * Execute the common local investigation after selecting one trusted input loader.
 *
 * @param coreConfig - Generic LLM runtime configuration.
 * @param options - Local case, environment, and output options.
 * @param loadInput - Legacy or verified-revision input boundary.
 * @param revision - Opaque verified revision, or null for the legacy output adapter.
 * @param dependencies - Optional lifecycle and core seams for tests.
 * @returns Paths to the persisted agent-first report and locked result.
 */
async function runLocalFixWithInput(
    coreConfig: CoreConfig,
    options: RunVerifiedLocalFixOptions,
    loadInput: LocalFixInputLoader,
    revision: VerifiedIssueRevision | null,
    dependencies: LocalFixRunnerDependencies = {},
): Promise<LocalRunOutputPaths> {
    const outputDir = prepareOutputArtifacts(options.outputDir, process.cwd());
    let collection: PrivateEvidenceCollection | null = null;
    if (revision) {
        collection = createPrivateEvidenceCollection(
            outputDir,
            dependencies.createCollectionId ?? randomUUID,
        );
    }
    const workOutputDir = collection?.workDir ?? outputDir;
    let paths: LocalRunOutputPaths;
    let domain = 'unknown';
    let failureStage: LocalFailureStage = LocalFailureStage.Input;
    let filtersBaseSha: string | null = null;
    let agentRunArtifacts: AgentRunArtifacts = {
        decision: null,
        observations: [],
    };

    /**
     * Configured filters remote captured immediately after the run configuration loads, so any
     * failure record raised after that point still names the run's own filters repository. A
     * configuration loading failure leaves it unset and the record keeps every earlier fact.
     */
    let filtersRemoteUrl: string | null = null;
    const usageCollector = createRunUsageCollector({ rates: options.pricingSnapshot });
    try {
        if (options.signal?.aborted) {
            throw new LocalExecutionInfrastructureError(
                LocalInfrastructureFailureCategory.Interrupted,
                'The automatic queue lease was lost before investigation started.',
            );
        }
        const input = loadInput(workOutputDir);
        const issue = input.issue;
        const logger = createLogger({ verbose: options.verbose });
        const runConfig = withPinnedKnowledgeBase(
            loadLocalRunConfig(options.environment, options.runConfig, options.keepTemporaryFiles),
            options.knowledgeBaseSha,
        );
        filtersRemoteUrl = runConfig.filters.remoteUrl;
        failureStage = LocalFailureStage.Environment;
        let preparedExtension: PreparedExtension | undefined;
        if (runConfig.extensionBuild) {
            try {
                const build = await (
                    dependencies.prepareHistoricalExtensionBuild ?? prepareHistoricalExtensionBuild
                )({
                    build: runConfig.extensionBuild,
                    cacheRoot: labExtensionCacheRoot(process.cwd()),
                    logger,
                });
                preparedExtension = await loadHistoricalBuildExtension(
                    build.extensionDir,
                    build.provenance,
                );
            } catch (error) {
                logger.error({ err: error }, 'Historical reporter extension preparation failed');
                throw new LocalExecutionInfrastructureError(
                    LocalInfrastructureFailureCategory.Environment,
                    error instanceof Error ? error.message : String(error),
                    { cause: error },
                );
            }
        }
        failureStage = LocalFailureStage.Input;
        const intake = await extractIntakeFacts(issue, {
            llm: coreConfig.llm,
            ...(options.model !== undefined ? { model: options.model } : {}),
            logger,
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
            extractReport: dependencies.extractReport,
            usageCollector,
        });
        if (intake.kind === IntakeExtractionKind.Skipped) {
            logger.info(
                { issueNumber: issue.number, reason: intake.reason },
                'issue skipped: not a filter report',
            );
            throw new LocalExecutionInfrastructureError(
                LocalInfrastructureFailureCategory.InvestigationInput,
                `${INTAKE_SKIPPED_PREFIX} Issue #${issue.number}: ${intake.reason}`,
            );
        }
        const facts = intake.facts;
        if (facts.reportedSiteUrls[0]) {
            domain = new URL(facts.reportedSiteUrls[0]).hostname;
        }
        const prepareFilters =
            dependencies.withPreparedFiltersCheckout ?? withPreparedFiltersCheckout;
        const prepareKnowledgeBase =
            dependencies.withPreparedKnowledgeBase ?? withPreparedKnowledgeBase;
        const executeCore = dependencies.runFixCore ?? runFixCore;

        failureStage = LocalFailureStage.Environment;
        paths = await prepareFilters(runConfig.filters, async (preparedFilters) => {
            filtersBaseSha = preparedFilters.provenance.commit;
            const preparedCoreConfig: CoreConfig = {
                ...coreConfig,
                headless: true,
                repositoryPath: preparedFilters.filtersPath,
                adguardExtensionManifestVersion: undefined,
            };
            // The instruction is run input, not environment: a failed explicit load is an input
            // failure naming the path, and a successful one reclassifies back to environment for
            // whatever provisioning follows.
            failureStage = LocalFailureStage.Input;
            const instruction = await loadRunInstruction(
                preparedFilters.checkoutPath,
                runConfig.instructionPath,
                logger,
            );
            if (options.refuseRepositoryInstruction) {
                refuseLoadedRunInstruction(instruction, logger);
            }
            // The same gate the public entry applies: a file-backed verification method can never
            // be honoured yet, so the run refuses here, before the core's paid investigation.
            const fileBackedRefusal = instruction
                ? fileBackedApplicationRefusalDetail(instruction.content)
                : undefined;
            if (fileBackedRefusal !== undefined) {
                logger.warn(
                    { instructionPath: instruction?.path, detail: fileBackedRefusal },
                    'run instruction declares an unsupported file-backed verification method; refusing before the investigation',
                );
                throw new FileBackedApplicationRefusalError(fileBackedRefusal);
            }
            failureStage = LocalFailureStage.Environment;
            // Skip, not disable: the built-in KnowledgeBase provisioning belongs to runs whose
            // instruction did not replace it with its own linked documents.
            const runKnowledgeBase = <T>(
                callback: (preparedKnowledgeBase: PreparedKnowledgeBase | null) => Promise<T>,
            ): Promise<T> =>
                instruction
                    ? callback(null)
                    : prepareKnowledgeBase(runConfig.knowledgeBase, preparedFilters, callback);
            return await runKnowledgeBase(async (preparedKnowledgeBase) => {
                failureStage = LocalFailureStage.Core;
                let unsafeResult: FixRunResult;
                try {
                    unsafeResult = await executeCore(
                        preparedCoreConfig,
                        { ...issue, facts },
                        {
                            ...(preparedExtension
                                ? {
                                      preparedExtension,
                                      redirectOriginPolicy: RedirectOriginPolicy.KeepRelatedHosts,
                                  }
                                : {}),
                            artifactsDir: join(workOutputDir, 'artifacts'),
                            browserMode: options.browserMode,
                            routingCheck: options.routingCheck,
                            maxDurationMs: preparedCoreConfig.agentInvestigationBudgetMs,
                            model: options.model,
                            verbose: options.verbose,
                            signal: options.signal,
                            filtersRepository: guidanceRepositorySlugFromRemote(
                                runConfig.filters.remoteUrl,
                                'Filters',
                            ),
                            filtersBaseSha: preparedFilters.provenance.commit,
                            knowledgeGuidanceSource: preparedKnowledgeBase?.guidanceSource,
                            ...(instruction ? { instruction } : {}),
                            // The local filters source is where an operator installed the
                            // repository's linter; the disposable clone has no dependencies.
                            ...(options.lintCommand === undefined
                                ? {}
                                : {
                                      repositoryLint: {
                                          command: options.lintCommand,
                                          checkoutRoot:
                                              runConfig.filters.localSourcePath ??
                                              preparedFilters.checkoutPath,
                                      },
                                  }),
                            agentRuntime: {
                                // A parsed `--executors` wins; absent, the lab locks the
                                // browser extension and the modules this run plugs in instead
                                // of the implicitly registered set.
                                executors:
                                    options.executors ??
                                    labExecutorSet(Object.keys(options.executorDependencies ?? {})),
                                // This run threads its own modules into the activation context
                                // instead of module state, so a locked module selection
                                // activates against exactly this run's module, never a
                                // concurrently running one's.
                                executorDependencies: { ...options.executorDependencies },
                            },
                        },
                        {
                            onAgentRunArtifacts: (artifacts) => {
                                agentRunArtifacts = redactAgentRunArtifacts(artifacts, [
                                    coreConfig.llm.apiKey,
                                ]);
                            },
                            usageCollector,
                        },
                    );
                    if (options.signal?.aborted) {
                        throw new LocalExecutionInfrastructureError(
                            LocalInfrastructureFailureCategory.Interrupted,
                            'The automatic queue lease was lost during investigation.',
                        );
                    }
                } catch (error) {
                    if (!revision || !collection) {
                        throw error;
                    }
                    const failureRecord = buildLocalFailureRecord(
                        { ...options, outputDir },
                        domain,
                        LocalFailureStage.Core,
                        error,
                        preparedFilters.provenance.commit,
                        configuredFiltersRepository(filtersRemoteUrl),
                        [coreConfig.llm.apiKey],
                    );
                    return publishVerifiedLocalResult(
                        revision,
                        failureRecord,
                        preparedFilters,
                        collection,
                        outputDir,
                        agentRunArtifacts,
                        usageCollector.summary(),
                        [coreConfig.llm.apiKey],
                        dependencies.publishLocalRun ?? publishLocalRun,
                    );
                }
                failureStage = LocalFailureStage.Output;
                // Observed only after the investigation is over, so no source operation this
                // run performed could have seen it: the pin stays exactly what preparation
                // selected, and a newer upstream is reported as external drift, not applied.
                // A historical run is deliberately pinned to a past commit, so upstream having
                // moved is not news; and a result that does not itself record the pinned commit
                // has no binding for a drift record to be drift from.
                const pinnedCommit = preparedFilters.provenance.commit;
                const observable =
                    runConfig.filters.environment.kind === ExtensionEnvironmentKind.Current &&
                    unsafeResult.filtersBaseSha?.toLowerCase() === pinnedCommit.toLowerCase();
                const sourceDrift = observable
                    ? await (dependencies.observeUpstreamDrift ?? observeUpstreamDrift)({
                          remoteUrl: runConfig.filters.remoteUrl,
                          ref: runConfig.filters.currentRef,
                          pinnedCommit,
                          observedAt: new Date().toISOString(),
                          runner: { run: runPreparationSubprocess },
                      })
                    : null;
                const result = redactFixRunResult({ ...unsafeResult, sourceDrift }, [
                    coreConfig.llm.apiKey,
                ]);
                const executions: LocalCoreExecution[] = [
                    { name: 'agentic', settingsProfile: null, result },
                ];
                const record = buildLocalRunRecord(
                    options.environment,
                    preparedFilters,
                    preparedKnowledgeBase,
                    executions,
                    input.issueScreenshots,
                    result,
                    instruction ? toInstructionProvenance(instruction, executions) : undefined,
                );
                if (revision && collection) {
                    return publishVerifiedLocalResult(
                        revision,
                        record,
                        preparedFilters,
                        collection,
                        outputDir,
                        agentRunArtifacts,
                        usageCollector.summary(),
                        [coreConfig.llm.apiKey],
                        dependencies.publishLocalRun ?? publishLocalRun,
                    );
                }
                let candidatePatchText: string | undefined;
                if (result.candidatePatch) {
                    candidatePatchText = renderLocalCandidatePatch(
                        preparedFilters.filtersPath,
                        result.candidatePatch,
                    );
                }
                return writeLocalRunOutput(record, {
                    outputDir,
                    workspaceRoot: process.cwd(),
                    candidatePatchText,
                    agentRunArtifacts,
                    llmUsage: usageCollector.summary(),
                });
            });
        });
    } catch (error) {
        if (revision) {
            const redactionFailure =
                error instanceof LocalPublicationTrustError &&
                (error.code === 'redaction_failed' || error.code === 'residual_secret');
            if (redactionFailure && collection) {
                removePrivateEvidenceCollection(collection);
                const code =
                    error instanceof LocalPublicationTrustError && error.code === 'residual_secret'
                        ? 'residual_secret'
                        : 'redaction_failed';
                writeLocalPublicationSanitizationFailure(outputDir, code);
                if (!(error instanceof LocalPublicationTrustError)) {
                    throw new LocalPublicationTrustError(code);
                }
            }
            throw error;
        }
        return writeLocalFailure(
            { ...options, outputDir },
            domain,
            failureStage,
            error,
            filtersBaseSha,
            configuredFiltersRepository(filtersRemoteUrl),
            agentRunArtifacts,
            usageCollector.summary(),
            [coreConfig.llm.apiKey],
        );
    }

    return paths;
}

/**
 * Prepare disposable sources from a legacy snapshot file and write local-only output.
 *
 * This compatibility adapter validates the version-one snapshot before delegating to the same
 * execution body used by verified revision input.
 *
 * @param coreConfig - Generic LLM runtime configuration.
 * @param options - Legacy issue-file, environment, and output options.
 * @param dependencies - Optional lifecycle and core seams for tests.
 * @returns Paths to the persisted agent-first report and locked result.
 */
export async function runLocalFix(
    coreConfig: CoreConfig,
    options: RunLocalFixOptions,
    dependencies: LocalFixRunnerDependencies = {},
): Promise<LocalRunOutputPaths> {
    return await runLocalFixWithInput(
        coreConfig,
        options,
        () => loadLegacyLocalFixInput(options),
        null,
        dependencies,
    );
}

/**
 * Prepare disposable sources from an opaque verified revision and write local-only output.
 *
 * The source envelope and original attachment paths are absent from this interface. Captured bytes
 * are materialized exclusively beneath the owned output before entering the common execution body.
 *
 * @param coreConfig - Generic LLM runtime configuration.
 * @param revision - Opaque in-memory revision returned by the integrity verifier.
 * @param options - Environment and nested investigation output options.
 * @param dependencies - Optional lifecycle and core seams for tests.
 * @returns Paths to the persisted agent-first report and locked result.
 */
export async function runLocalFixFromRevision(
    coreConfig: CoreConfig,
    revision: VerifiedIssueRevision,
    options: RunVerifiedLocalFixOptions,
    dependencies: LocalFixRunnerDependencies = {},
): Promise<LocalRunOutputPaths> {
    if (revision.issueNumber !== options.issueNumber) {
        throw new Error(
            `Verified issue revision is #${revision.issueNumber}, expected #${options.issueNumber}.`,
        );
    }
    return await runLocalFixWithInput(
        coreConfig,
        options,
        (outputDir) => materializeVerifiedLocalFixInput(revision, outputDir),
        revision,
        dependencies,
    );
}
