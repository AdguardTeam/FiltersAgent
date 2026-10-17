import { randomUUID } from 'node:crypto';
import { BrowserMode } from '../../src/types/browser-mode';
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { CoreConfig } from '../../src/config/config';
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
import {
    readLocalRunOutput,
    type LocalExtensionProvenance,
    type LocalRunRecord,
} from '../../src/local/run-output';
import {
    loadGoldenHumanOracle,
    loadGoldenRunCase,
    type GoldenE2ERun,
    type GoldenHumanOracle,
} from './golden-case';
import {
    assessGoldenAgentEnvironment,
    type GoldenAgentEnvironmentAssessment,
} from './golden-agent-environment';
import { bindExtractReport } from '../../src/intake/extract-issue-facts';
import { type ExtractedHumanFix, type HumanFixCandidate } from './human-commit-oracle';
import { extractHumanCommitFix } from './human-commit-reader';
import {
    classifyGoldenPreOracleResult,
    classifyGoldenResult,
    unavailableGoldenOracleProbe,
    type GoldenE2EResult,
    type GoldenOracleProbeResult,
} from './golden-comparator';

/**
 * Caller-selected paths and identity for one manual golden case.
 */
export interface RunGoldenE2ECaseOptions {
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
 * Post-run context supplied only to an independent human-candidate browser probe.
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
     * Absolute portable issue snapshot path used by the completed agent run.
     */
    issueFile: string;

    /**
     * Absolute run.json path containing only non-oracle environment pins.
     */
    runConfigPath: string;

    /**
     * Locked extension build provenance reused without exposing the human commit to the agent.
     */
    extension: LocalExtensionProvenance | null;

    /**
     * Human rule candidate extracted only after the agent output was locked.
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
     * based assessment bound to the case run's LLM configuration.
     */
    assessAgentEnvironment?: (
        record: LocalRunRecord,
        issueFile: string,
    ) => Promise<GoldenAgentEnvironmentAssessment>;

    /**
     * Closed oracle.json loader invoked only after result validation.
     */
    loadHumanOracle?: (caseDirectory: string) => GoldenHumanOracle;

    /**
     * Read-only first-parent human commit extraction.
     */
    extractHumanFix?: (humanFixCommit: string) => Promise<ExtractedHumanFix>;

    /**
     * Independent human-candidate browser/vision validation.
     */
    probeHumanCandidate?: GoldenCaseOracleProbe;
}

/**
 * Persist the E2E-only classification without modifying the locked agent record or report.
 *
 * @param outputDirectory - Ignored per-case output directory.
 * @param result - Final golden comparison result.
 */
function writeGoldenE2EResult(outputDirectory: string, result: GoldenE2EResult): void {
    mkdirSync(outputDirectory, { recursive: true });
    const outputPath = join(outputDirectory, 'e2e-result.json');
    const temporaryPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
        writeFileSync(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
        });
        renameSync(temporaryPath, outputPath);
    } finally {
        rmSync(temporaryPath, { force: true });
    }
}

/**
 * Build an explicit infrastructure result before the closed oracle can safely be loaded.
 *
 * @param error - Input, lifecycle, or locked-result validation error.
 * @returns Exit-code-three result without pretending the human fix was inspected.
 */
function infrastructureFailure(error: unknown): GoldenE2EResult {
    return {
        status: 'infrastructure_failure',
        exitCode: 3,
        detail: error instanceof Error ? error.message : String(error),
        actualRule: null,
        expectedRule: null,
        humanFixCommit: null,
        humanFixFirstParent: null,
        humanCandidate: null,
    };
}

/**
 * Determine whether two real directories are equal or nested in either direction.
 *
 * @param first - First canonical real directory.
 * @param second - Second canonical real directory.
 * @returns True when the directories overlap.
 */
function goldenDirectoriesOverlap(first: string, second: string): boolean {
    const firstToSecond = relative(first, second);
    const secondToFirst = relative(second, first);
    const firstContainsSecond =
        firstToSecond === '' || (!firstToSecond.startsWith('..') && !isAbsolute(firstToSecond));
    const secondContainsFirst =
        secondToFirst === '' || (!secondToFirst.startsWith('..') && !isAbsolute(secondToFirst));
    return firstContainsSecond || secondContainsFirst;
}

/**
 * Resolve an existing path or its nearest existing ancestor without creating the destination.
 *
 * @param path - Absolute prospective directory path.
 * @returns Canonical prospective path with existing symlink components resolved.
 */
function canonicalProspectiveDirectory(path: string): string {
    let ancestor = resolve(path);
    const missingComponents: string[] = [];
    while (!existsSync(ancestor)) {
        const parent = dirname(ancestor);
        if (parent === ancestor) {
            break;
        }
        missingComponents.unshift(basename(ancestor));
        ancestor = parent;
    }
    return resolve(realpathSync(ancestor), ...missingComponents);
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
    const caseDirectory = realpathSync(resolve(options.caseDirectory));
    const prospectiveOutputDirectory = canonicalProspectiveDirectory(options.outputDirectory);
    const prospectiveEvaluationDirectory = canonicalProspectiveDirectory(
        options.evaluationDirectory,
    );
    if (
        goldenDirectoriesOverlap(prospectiveOutputDirectory, prospectiveEvaluationDirectory) ||
        goldenDirectoriesOverlap(prospectiveOutputDirectory, caseDirectory) ||
        goldenDirectoriesOverlap(prospectiveEvaluationDirectory, caseDirectory)
    ) {
        throw new Error(
            'Golden agent, evaluator, and tracked case directories must be mutually separate.',
        );
    }
    const outputDirectory = materializeLocalRunOutputDir(
        resolve(options.outputDirectory),
        process.cwd(),
    );
    const evaluationDirectory = materializeLocalRunOutputDir(
        resolve(options.evaluationDirectory),
        process.cwd(),
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
    clearLocalRunOutputDir(outputDirectory, process.cwd());
    clearLocalRunOutputDir(evaluationDirectory, process.cwd());
    let result: GoldenE2EResult;
    try {
        const loaded = loadGoldenRunCase(caseDirectory);
        const execute = dependencies.runLocalFix ?? runLocalFix;
        const blockerModules = options.blockerModules ?? [];
        // The modules keep their files outside every repository and output root, and only for
        // this case's run.
        const modulesWorkspace =
            blockerModules.length > 0
                ? reservePrivateWorkspace([process.cwd(), outputDirectory, evaluationDirectory])
                : null;
        try {
            await execute(coreConfig, {
                issueNumber: loaded.config.issueNumber,
                issueFile: loaded.issueFile,
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
                              labFilterCacheDir(process.cwd()),
                          ),
                      }),
            });
        } finally {
            if (modulesWorkspace !== null) {
                rmSync(modulesWorkspace, { recursive: true, force: true });
            }
        }
        const initialManifest = verifyLocalRunManifest(outputDirectory);
        const record = readLocalRunOutput(join(outputDirectory, 'run-result.json'));
        if (record.result.issueNumber !== loaded.config.issueNumber) {
            throw new Error('Locked run issue does not match the selected golden case.');
        }
        if (record.result.filtersBaseSha !== loaded.config.filtersBaseSha) {
            throw new Error('Locked run filters base does not match the selected golden case.');
        }
        const defaultAssessment = (runRecord: LocalRunRecord, issueFile: string) =>
            assessGoldenAgentEnvironment(runRecord, issueFile, {
                extractReport: bindExtractReport(coreConfig.llm),
            });
        const agentEnvironment = await (dependencies.assessAgentEnvironment ?? defaultAssessment)(
            record,
            loaded.issueFile,
        );

        // This is the first point at which the closed oracle may be inspected. The normal run has
        // completed, run-result.json exists, and its Host wrapper schema has been validated.
        const oracleLoader = dependencies.loadHumanOracle ?? loadGoldenHumanOracle;
        const oracle = oracleLoader(caseDirectory);
        const preOracle = classifyGoldenPreOracleResult(
            record.result,
            agentEnvironment,
            oracle.humanFixCommit,
        );
        if (preOracle) {
            result = preOracle;
        } else {
            if (agentEnvironment.status !== 'matched') {
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
            const caseProbe = dependencies.probeHumanCandidate;
            result = await classifyGoldenResult(
                record.result,
                humanFix,
                async (candidate) => {
                    if (!caseProbe) {
                        return unavailableGoldenOracleProbe();
                    }
                    return caseProbe({
                        caseName: options.caseName,
                        run: loaded.config,
                        issueFile: loaded.issueFile,
                        runConfigPath: loaded.runConfigPath,
                        extension: agentEnvironment.extension,
                        candidate,
                        outputDirectory: evaluationDirectory,
                    });
                },
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
    writeGoldenE2EResult(evaluationDirectory, result);
    return result;
}
