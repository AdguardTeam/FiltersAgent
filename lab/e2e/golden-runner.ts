import {
    collectBenchmarkRecord,
    writeBenchmarkRecord,
    type BenchmarkRunEnvironment,
    type CollectBenchmarkRecordInput,
} from './benchmark-record';
import { writeAtomicJson } from '../atomic-json';
import {
    benchmarkCachedJudgement,
    judgeReporterEnvironment,
    judgeHumanFix,
    replayHumanFixJudgement,
    type GoldenJudgeCaseContext,
    HumanFixVerdict,
} from './golden-judge';
import { BrowserMode } from '../../src/types/browser-mode';
import { realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
    canonicalProspectiveDirectory,
    goldenDirectoriesOverlap,
} from './golden-output-directories';
import type { ExtensionBuildPin } from '../local/run-config';
import { oracleExtensionBuild } from './golden-oracle-extension';
import { GoldenE2EExitCode } from './golden-exit-code';
import type { CoreConfig, LlmConfig } from '../../src/config/config';
import type { RawIssue } from '../../src/github/fetch-issue';
import type { Report } from '../../src/intake/report';
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
import { verifyLocalRunManifest } from '../../src/local/run-manifest';
import { readLocalRunOutput, type LocalRunRecord } from '../../src/local/run-output';
import {
    loadGoldenHumanOracle,
    loadGoldenRunCase,
    type GoldenE2ERun,
    type GoldenHumanOracle,
} from './golden-case';
import {
    GoldenAgentEnvironmentStatus,
    assessGoldenAgentEnvironment,
    type GoldenAgentEnvironmentAssessment,
} from './golden-agent-environment';
import { bindExtractReport } from '../../src/intake/extract-issue-facts';
import { type ExtractedHumanFix, type HumanFixCandidate } from './human-commit-oracle';
import { extractHumanCommitFix } from './human-commit-reader';
import {
    GoldenE2EStatus,
    classifyGoldenPreOracleResult,
    classifyGoldenResult,
    unavailableGoldenOracleProbe,
    type GoldenE2EResult,
    type GoldenOracleProbeResult,
} from './golden-comparator';

/**
 * Configuration shared by every case in one golden benchmark invocation.
 */
export interface GoldenSeries {
    /**
     * Source and browser provenance captured once before ordinary model runs.
     */
    runEnvironment: BenchmarkRunEnvironment;
    /**
     * Independent judge provider and browser configuration used for evaluation.
     */
    judgeConfig: CoreConfig;
    /**
     * Shared independent judge cache directory; null disables persistence.
     */
    judgeCacheRoot: string | null;
    /**
     * Recompute both judge records when their evaluation is needed.
     */
    refreshJudgeCache: boolean;
}

/**
 * Judge-only series settings shared by model runs and independent oracle evaluation.
 */
export type GoldenJudgeSeries = Pick<
    GoldenSeries,
    'judgeConfig' | 'judgeCacheRoot' | 'refreshJudgeCache'
>;

/**
 * Caller-selected paths and identity for one manual golden case.
 */
export interface RunGoldenE2ECaseOptions {
    /**
     * Shared judge configuration for the benchmark invocation.
     */
    series: GoldenSeries;
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
     * Ignored local directory receiving only canonical fix-agent artifacts.
     */
    outputDirectory: string;
    /**
     * Separate ignored directory receiving the E2E classification and human-oracle evidence.
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
 * Closed case context supplied only to an independent human-candidate browser probe.
 */
export interface GoldenOracleContext {
    /**
     * Case name being classified.
     */
    caseName: string;
    /**
     * Historical issue identity and pre-fix filters SHA exposed to the normal core run.
     */
    run: GoldenE2ERun;
    /**
     * Absolute portable issue snapshot path used for independent evaluation.
     */
    issueFile: string;
    /**
     * Absolute run.json path containing only non-oracle environment pins.
     */
    runConfigPath: string;
    /**
     * Historical extension build identity reconstructed for independent browser evaluation.
     */
    extensionBuild: ExtensionBuildPin;
    /**
     * Locked release digest, or null when no completed agent run supplied one.
     */
    expectedReleaseSha256: string | null;
    /**
     * Human rule candidate kept outside every agent input.
     */
    candidate: HumanFixCandidate;
    /**
     * Local directory containing reusable browser artifacts and provenance.
     */
    outputDirectory: string;
}

/**
 * Standalone browser probe seam for selecting reporter-relevant human commit changes.
 */
export type GoldenCaseOracleProbe = (
    context: GoldenOracleContext,
) => Promise<GoldenOracleProbeResult>;

/**
 * Injectable lifecycle seams used by golden runner unit tests.
 */
export interface GoldenE2ERunnerDependencies {
    /**
     * Standard GitHub-independent local fix lifecycle.
     */
    runLocalFix?: typeof runLocalFix;
    /**
     * Independent post-lock reporter-environment assessment; defaults to the intake-extraction
     * based assessment bound to the judge's LLM configuration.
     */
    assessAgentEnvironment?: (record: LocalRunRecord) => Promise<GoldenAgentEnvironmentAssessment>;
    /**
     * Closed oracle loader used after validation, or after classification for timing metadata.
     */
    loadHumanOracle?: (caseDirectory: string) => GoldenHumanOracle;
    /**
     * Read-only first-parent human commit extraction.
     */
    extractHumanFix?: (humanFixCommit: string) => Promise<ExtractedHumanFix>;
    /**
     * Bind independent reporter-environment extraction to the judge's LLM configuration.
     */
    bindJudgeExtractReport?: (llm: LlmConfig) => (raw: RawIssue) => Promise<Report | null>;
    /**
     * Build independent human-candidate browser/vision validation from the judge configuration.
     */
    createJudgeProbe?: (judgeConfig: CoreConfig) => GoldenCaseOracleProbe;
    /**
     * Wall-clock source for case stages and independent judge verdict timestamps.
     */
    now?: () => number;
}

/**
 * Persist the E2E-only classification without modifying the locked agent record or report.
 *
 * @param outputDirectory - Ignored per-case output directory.
 * @param result - Final golden comparison result.
 */
function writeGoldenE2EResult(outputDirectory: string, result: GoldenE2EResult): void {
    writeAtomicJson(join(outputDirectory, 'e2e-result.json'), result);
}

/**
 * Build an explicit infrastructure result before the closed oracle can safely be loaded.
 *
 * @param error - Input, lifecycle, or locked-result validation error.
 * @returns Exit-code-three result without pretending the human fix was inspected.
 */
function infrastructureFailure(error: unknown): GoldenE2EResult {
    return {
        status: GoldenE2EStatus.InfrastructureFailure,
        exitCode: GoldenE2EExitCode.InfrastructureFailure,
        detail: error instanceof Error ? error.message : String(error),
        actualRule: null,
        expectedRule: null,
        humanFixCommit: null,
        humanFixFirstParent: null,
        humanCandidate: null,
    };
}

/**
 * Run one historical case through the standard local lifecycle and closed post-run human oracle.
 *
 * @param coreConfig - GitHub-independent LLM and headless browser configuration.
 * @param options - Case and ignored output paths.
 * @param dependencies - Optional lifecycle and independent-oracle seams.
 * @returns Persisted pass, regression, drift, or infrastructure classification.
 */
export async function runGoldenE2ECase(
    coreConfig: CoreConfig,
    options: RunGoldenE2ECaseOptions,
    dependencies: GoldenE2ERunnerDependencies = {},
): Promise<GoldenE2EResult> {
    const now = dependencies.now ?? Date.now;
    const workspaceRoot = process.cwd();
    const startedAt = now();
    let runReturnedAt = startedAt;
    let record: LocalRunRecord | null = null;
    let oracle: GoldenHumanOracle | null = null;
    let loaded: ReturnType<typeof loadGoldenRunCase> | null = null;
    let judge: CollectBenchmarkRecordInput['judge'] = {
        verdict: HumanFixVerdict.NotChecked,
        fromCache: false,
    };
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
    let result: GoldenE2EResult;
    try {
        loaded = loadGoldenRunCase(caseDirectory);
        const execute = dependencies.runLocalFix ?? runLocalFix;
        const blockerModules = options.blockerModules ?? [];
        // The modules keep their files outside every repository and output root, and only for
        // this case's run.
        const modulesWorkspace =
            blockerModules.length > 0
                ? reservePrivateWorkspace([workspaceRoot, outputDirectory, evaluationDirectory])
                : null;
        try {
            await execute(coreConfig, {
                issueNumber: loaded.config.issueNumber,
                knowledgeBaseSha: options.knowledgeBaseSha,
                issueFile: loaded.issueFile,
                neutralIssueInput: true,
                refuseRepositoryInstruction: true,
                environment: 'historical',
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
            runReturnedAt = now();
            if (modulesWorkspace !== null) {
                rmSync(modulesWorkspace, { recursive: true, force: true });
            }
        }
        const initialManifest = verifyLocalRunManifest(outputDirectory);
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
        // The closed oracle is read only after the normal run seals and its result validates.
        oracle = (dependencies.loadHumanOracle ?? loadGoldenHumanOracle)(caseDirectory);
        const judgeContext: GoldenJudgeCaseContext = {
            series: options.series,
            caseName: options.caseName,
            humanFixCommit: oracle.humanFixCommit,
            extensionBuild: loaded.config.extensionBuild,
            issueFile: loaded.issueFile,
            now,
        };
        const defaultAssessment = (runRecord: LocalRunRecord) =>
            assessGoldenAgentEnvironment(runRecord, {
                readReporterEnvironment: async () =>
                    (
                        await judgeReporterEnvironment(
                            judgeContext,
                            (dependencies.bindJudgeExtractReport ?? bindExtractReport)(
                                options.series.judgeConfig.llm,
                            ),
                        )
                    ).environment,
            });
        const agentEnvironment = await (dependencies.assessAgentEnvironment ?? defaultAssessment)(
            record,
        );
        const preOracle = classifyGoldenPreOracleResult(
            record.result,
            agentEnvironment,
            oracle.humanFixCommit,
        );
        if (preOracle) {
            judge = benchmarkCachedJudgement(judgeContext);
            result = preOracle;
        } else {
            if (agentEnvironment.status !== GoldenAgentEnvironmentStatus.Matched) {
                throw new Error(
                    'Golden pre-oracle classification did not handle environment failure.',
                );
            }
            const extract = dependencies.extractHumanFix ?? extractHumanCommitFix;
            const humanFix = await extract(oracle.humanFixCommit);
            if (humanFix.commit.toLowerCase() !== oracle.humanFixCommit.toLowerCase()) {
                throw new Error(
                    `Human diff extractor returned ${humanFix.commit}, expected ` +
                        `${oracle.humanFixCommit}.`,
                );
            }
            const caseProbe = dependencies.createJudgeProbe?.(options.series.judgeConfig);
            const { judgement, fromCache } = await judgeHumanFix(
                judgeContext,
                humanFix,
                async (candidate) => {
                    if (!caseProbe) {
                        return unavailableGoldenOracleProbe();
                    }
                    const extensionBuild = oracleExtensionBuild(agentEnvironment.extension);
                    return caseProbe({
                        caseName: options.caseName,
                        run: loaded!.config,
                        issueFile: loaded!.issueFile,
                        runConfigPath: loaded!.runConfigPath,
                        extensionBuild,
                        expectedReleaseSha256: extensionBuild.releaseSha256,
                        candidate,
                        outputDirectory: evaluationDirectory,
                    });
                },
            );
            judge = { verdict: judgement.status, fromCache };
            result = await classifyGoldenResult(
                record.result,
                humanFix,
                replayHumanFixJudgement(judgement),
                agentEnvironment,
            );
        }
        const finalManifest = verifyLocalRunManifest(outputDirectory);
        if (finalManifest.runId !== initialManifest.runId) {
            throw new Error('Locked agent run changed during oracle evaluation.');
        }
    } catch (error) {
        result = infrastructureFailure(error);
    }
    oracle ??= (dependencies.loadHumanOracle ?? loadGoldenHumanOracle)(caseDirectory);
    writeGoldenE2EResult(evaluationDirectory, result);
    writeBenchmarkRecord(
        evaluationDirectory,
        collectBenchmarkRecord({
            ...options,
            startedAt,
            runReturnedAt,
            evaluatedAt: now(),
            outputDirectory,
            record,
            result,
            run: loaded?.config ?? null,
            llm: coreConfig.llm,
            judge,
            oracle,
        }),
    );
    return result;
}
