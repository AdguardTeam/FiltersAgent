import {
    collectBenchmarkRecord,
    readBenchmarkHumanRules,
    writeBenchmarkRecord,
    type BenchmarkRecord,
    type BenchmarkRunEnvironment,
    type CheckedSite,
} from './benchmark-record';
import {
    BenchmarkCaseStatus,
    benchmarkFailureKind,
    classifyAgentOutcome,
    type AgentOutcome,
} from './benchmark-outcome';
import { probeSiteReachability, reportedSiteUrl, type SiteProbe } from './case-site';
import { pinnedReport } from './pinned-report';
import { BrowserMode } from '../../src/types/browser-mode';
import { realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
    canonicalProspectiveDirectory,
    goldenDirectoriesOverlap,
} from './golden-output-directories';
import type { CoreConfig } from '../../src/config/config';
import { createLogger, type Logger } from '../../src/logger/logger';
import { ExtensionEnvironmentKind } from '../../src/types/extension-environment-kind';
import type { UsageRatesTable } from '../../src/types/usage-summary';
import { runLocalFix } from '../local/local-fix-runner';
import { labFilterCacheDir } from '../local/blocker-modules';
import {
    blockerModuleRunDependencies,
    type EnabledBlockerModule,
} from '../../src/proxy-blocker/blocker-module-run-issue';
import { reservePrivateWorkspace } from '../../src/proxy-blocker/private-workspace';
import {
    clearLocalRunOutputDir,
    materializeLocalRunOutputDir,
} from '../../src/local/output-directory';
import { loadLocalIssueSnapshot, toAgentIssueInput } from '../../src/local/issue-snapshot';
import { verifyLocalRunManifest } from '../../src/local/run-manifest';
import { readLocalRunOutput, type LocalRunRecord } from '../../src/local/run-output';
import { loadGoldenRunCase, type GoldenHumanOracle, type LoadedGoldenRunCase } from './golden-case';
import {
    assessGoldenAgentEnvironment,
    type GoldenAgentEnvironmentAssessment,
} from './golden-agent-environment';
import type { ExtractedHumanFix } from './human-commit-oracle';
import { extractHumanCommitFix } from './human-commit-reader';

/**
 * Caller-selected paths and identity for one manual golden case.
 */
export interface RunGoldenE2ECaseOptions {
    /**
     * Source and browser provenance captured once for the series.
     */
    runEnvironment: BenchmarkRunEnvironment;
    /**
     * Immutable KnowledgeBase commit shared by every agent run in the suite.
     */
    knowledgeBaseSha: string;
    /**
     * Stable case directory name used in diagnostics.
     */
    caseName: string;
    /**
     * Directory containing run.json, oracle.json, and issue bundle.
     */
    caseDirectory: string;
    /**
     * The case's closed oracle, which the suite reads before the first case. Nothing from it
     * reaches the agent; its human fix commit is read only after the agent's run seals.
     */
    oracle: GoldenHumanOracle;
    /**
     * Ignored local directory receiving only canonical fix-agent artifacts.
     */
    outputDirectory: string;
    /**
     * Separate ignored directory receiving the benchmark record.
     */
    evaluationDirectory: string;
    /**
     * Whether the underlying local agent should emit verbose operational logs.
     */
    verbose?: boolean;
    /**
     * The user's price table the run is priced from; absent, the run computes no cost.
     */
    pricingSnapshot?: UsageRatesTable;
    /**
     * The blocker modules the case plugs in; absent plugs in none.
     */
    blockerModules?: readonly EnabledBlockerModule[];
}

/**
 * Injectable lifecycle seams used by golden runner unit tests.
 */
export interface GoldenE2ERunnerDependencies {
    /**
     * Standard GitHub-independent local fix lifecycle.
     */
    runLocalFix?: typeof runLocalFix;
    /**
     * Free reachability check of the case site before the agent starts.
     */
    probeSite?: SiteProbe;
    /**
     * Read-only first-parent human commit extraction.
     */
    extractHumanFix?: (humanFixCommit: string) => Promise<ExtractedHumanFix>;
    /**
     * Wall-clock source for case stages.
     */
    now?: () => number;
    /**
     * Destination of the stack of an unexpected case failure.
     */
    logger?: Logger;
}

/**
 * Directories and the lifecycle one case's agent run uses.
 */
interface CaseAgentRunContext {
    /**
     * Workspace the run's repository roots belong to.
     */
    workspaceRoot: string;
    /**
     * Agent artifact directory.
     */
    outputDirectory: string;
    /**
     * Benchmark record directory, kept apart from the blocker modules' files.
     */
    evaluationDirectory: string;
    /**
     * Standard GitHub-independent local fix lifecycle.
     */
    execute: typeof runLocalFix;
}

/**
 * Run the agent on one case whose site answered, with the case's blocker modules plugged in.
 *
 * @param coreConfig - GitHub-independent LLM and headless browser configuration.
 * @param options - Case options.
 * @param loaded - Loaded case pins and paths.
 * @param context - Directories and the lifecycle to run.
 * @returns Nothing once the run has sealed its output.
 */
async function runCaseAgent(
    coreConfig: CoreConfig,
    options: RunGoldenE2ECaseOptions,
    loaded: LoadedGoldenRunCase,
    context: CaseAgentRunContext,
): Promise<void> {
    const { workspaceRoot, outputDirectory, evaluationDirectory } = context;
    const blockerModules = options.blockerModules ?? [];
    // The modules keep their files outside every repository and output root, and only for this
    // case's run.
    const modulesWorkspace =
        blockerModules.length > 0
            ? reservePrivateWorkspace([workspaceRoot, outputDirectory, evaluationDirectory])
            : null;
    try {
        await context.execute(coreConfig, {
            issueNumber: loaded.config.issueNumber,
            knowledgeBaseSha: options.knowledgeBaseSha,
            issueFile: loaded.issueFile,
            neutralIssueInput: true,
            refuseRepositoryInstruction: true,
            environment: ExtensionEnvironmentKind.Historical,
            outputDir: outputDirectory,
            runConfig: loaded.runConfigPath,
            keepTemporaryFiles: false,
            browserMode: BrowserMode.On,
            verbose: options.verbose ?? false,
            pricingSnapshot: options.pricingSnapshot,
            ...(modulesWorkspace === null
                ? {}
                : {
                      executorDependencies: blockerModuleRunDependencies(
                          blockerModules,
                          modulesWorkspace,
                          labFilterCacheDir(workspaceRoot),
                      ),
                  }),
        });
    } finally {
        if (modulesWorkspace !== null) {
            rmSync(modulesWorkspace, { recursive: true, force: true });
        }
    }
}

/**
 * Run one historical case: check its site, run the agent through the standard local lifecycle, read
 * the outcome from the agent's own result, and record the human fix beside it.
 *
 * @param coreConfig - GitHub-independent LLM and headless browser configuration.
 * @param options - Case and ignored output paths.
 * @param dependencies - Optional lifecycle seams.
 * @returns The persisted benchmark record.
 */
export async function runGoldenE2ECase(
    coreConfig: CoreConfig,
    options: RunGoldenE2ECaseOptions,
    dependencies: GoldenE2ERunnerDependencies = {},
): Promise<BenchmarkRecord> {
    const now = dependencies.now ?? Date.now;
    const workspaceRoot = process.cwd();
    const startedAt = now();
    let siteCheckedAt = startedAt;
    let runReturnedAt = startedAt;
    let record: LocalRunRecord | null = null;
    let loaded: LoadedGoldenRunCase | null = null;
    let reporterEnvironment: GoldenAgentEnvironmentAssessment | null = null;
    let site: CheckedSite | null = null;
    const caseDirectory = realpathSync(resolve(options.caseDirectory));
    const prospectiveOutput = canonicalProspectiveDirectory(options.outputDirectory);
    const prospectiveEvaluation = canonicalProspectiveDirectory(options.evaluationDirectory);
    if (
        goldenDirectoriesOverlap(prospectiveOutput, prospectiveEvaluation) ||
        goldenDirectoriesOverlap(prospectiveOutput, caseDirectory) ||
        goldenDirectoriesOverlap(prospectiveEvaluation, caseDirectory)
    ) {
        throw new Error(
            'Golden agent, evaluator, and tracked case directories must be mutually separate.',
        );
    }
    const outputDirectory = materializeLocalRunOutputDir(
        resolve(options.outputDirectory),
        workspaceRoot,
    );
    const evaluationDirectory = materializeLocalRunOutputDir(
        resolve(options.evaluationDirectory),
        workspaceRoot,
    );
    if (
        goldenDirectoriesOverlap(outputDirectory, evaluationDirectory) ||
        goldenDirectoriesOverlap(outputDirectory, caseDirectory) ||
        goldenDirectoriesOverlap(evaluationDirectory, caseDirectory)
    ) {
        throw new Error(
            'Golden agent, evaluator, and tracked case directories must be mutually separate.',
        );
    }
    clearLocalRunOutputDir(outputDirectory, workspaceRoot);
    clearLocalRunOutputDir(evaluationDirectory, workspaceRoot);
    let outcome: AgentOutcome;
    try {
        loaded = loadGoldenRunCase(caseDirectory);
        const report = pinnedReport(
            toAgentIssueInput(loadLocalIssueSnapshot(loaded.issueFile)),
            loaded.config.extensionBuild.version,
        );
        const url = reportedSiteUrl(report);
        site = { url, ...(await (dependencies.probeSite ?? probeSiteReachability)(url)) };
        siteCheckedAt = now();
        if (site.reachable) {
            try {
                await runCaseAgent(coreConfig, options, loaded, {
                    workspaceRoot,
                    outputDirectory,
                    evaluationDirectory,
                    execute: dependencies.runLocalFix ?? runLocalFix,
                });
            } finally {
                runReturnedAt = now();
            }
            verifyLocalRunManifest(outputDirectory);
            record = readLocalRunOutput(join(outputDirectory, 'run-result.json'));
            if (record.result.issueNumber !== loaded.config.issueNumber) {
                throw new Error('Locked run issue does not match the selected golden case.');
            }
            // A null base means the run failed before checkout; classify its own sealed failure.
            if (
                record.result.filtersBaseSha !== null &&
                record.result.filtersBaseSha !== loaded.config.filtersBaseSha
            ) {
                throw new Error('Locked run filters base does not match the selected golden case.');
            }
            reporterEnvironment = assessGoldenAgentEnvironment(record, report);
            outcome = classifyAgentOutcome(record.result);
        } else {
            runReturnedAt = siteCheckedAt;
            outcome = {
                status: BenchmarkCaseStatus.SiteUnreachable,
                failureKind: null,
                detail: `${site.url} did not answer: ${site.answer}`,
            };
        }
    } catch (error) {
        // The record keeps the message; the stack goes to the log, so a crash stays diagnosable.
        (dependencies.logger ?? createLogger()).error(
            { err: error, caseName: options.caseName },
            'Golden case ended as an infrastructure failure.',
        );
        outcome = {
            status: BenchmarkCaseStatus.InfrastructureFailure,
            failureKind: benchmarkFailureKind(record?.result ?? null),
            detail: error instanceof Error ? error.message : String(error),
        };
    }
    const humanRules = await readBenchmarkHumanRules(
        options.oracle.humanFixCommit,
        dependencies.extractHumanFix ?? extractHumanCommitFix,
    );
    const benchmarkRecord = collectBenchmarkRecord({
        ...options,
        startedAt,
        siteCheckedAt,
        runReturnedAt,
        evaluatedAt: now(),
        outputDirectory,
        record,
        outcome,
        reporterEnvironment,
        run: loaded?.config ?? null,
        llm: coreConfig.llm,
        site,
        humanRules,
    });
    writeBenchmarkRecord(evaluationDirectory, benchmarkRecord);
    return benchmarkRecord;
}
