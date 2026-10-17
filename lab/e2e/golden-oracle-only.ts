import { join, resolve } from 'node:path';
import { bindExtractReport } from '../../src/intake/extract-issue-facts';
import {
    clearLocalRunOutputDir,
    materializeLocalRunOutputDir,
} from '../../src/local/output-directory';
import { loadGoldenHumanOracle, loadGoldenRunCase } from './golden-case';
import { unavailableGoldenOracleProbe } from './golden-comparator';
import { GoldenE2EExitCode } from './golden-exit-code';
import { HumanFixVerdict, judgeHumanFix, judgeReporterEnvironment } from './golden-judge';
import type { GoldenE2ERunnerDependencies, GoldenJudgeSeries } from './golden-runner';
import { extractHumanCommitFix } from './human-commit-reader';

export const GoldenOracleOnlyStatus = {
    Alive: 'alive',
    EnvironmentDrift: 'environment_drift',
    InfrastructureFailure: 'infrastructure_failure',
} as const;

/**
 * Independent oracle result classification without an agent run.
 */
export type GoldenOracleOnlyStatus =
    (typeof GoldenOracleOnlyStatus)[keyof typeof GoldenOracleOnlyStatus];

/**
 * Independent human-fix result and its command-line exit classification.
 */
export interface GoldenOracleOnlyResult {
    /**
     * Independent current human-fix classification.
     */
    status: GoldenOracleOnlyStatus;
    /**
     * Success, environment drift, or infrastructure failure exit code.
     */
    exitCode: GoldenOracleOnlyExitCode;
    /**
     * Independent evaluation or infrastructure details.
     */
    detail: string;
    /**
     * First verified human rule, or null when no rule was verified.
     */
    rule: string | null;
    /**
     * Whether a fresh shared verdict was reused without a live probe.
     */
    fromCache: boolean;
}

/**
 * Ordered selection and independent evaluation storage for a judge-only invocation.
 */
export interface RunGoldenOracleSuiteOptions {
    /**
     * Explicit case directory names in evaluation order.
     */
    caseNames: readonly string[];
    /**
     * Root containing tracked golden cases.
     */
    casesRoot: string;
    /**
     * Independent browser output root, separate from agent outputs.
     */
    oracleRoot: string;
    /**
     * Shared judge configuration and cache policy.
     */
    series: GoldenJudgeSeries;
}

/**
 * Exit classifications available without an agent run.
 */
export type GoldenOracleOnlyExitCode = Exclude<
    GoldenE2EExitCode,
    typeof GoldenE2EExitCode.AgentRegression
>;

/**
 * Independent judge seams read by a judge-only invocation.
 */
export type GoldenOracleSuiteDependencies = Pick<
    GoldenE2ERunnerDependencies,
    'loadHumanOracle' | 'extractHumanFix' | 'bindJudgeExtractReport' | 'createJudgeProbe' | 'now'
>;

/**
 * Named independent result retained for one sequential suite entry.
 */
export interface GoldenOracleOnlySuiteEntry {
    /**
     * Selected case directory name.
     */
    caseName: string;
    /**
     * Independent human-fix classification.
     */
    result: GoldenOracleOnlyResult;
}

/**
 * Aggregate result of a sequential independent oracle invocation.
 */
export interface GoldenOracleOnlySuiteResult {
    /**
     * Independent classifications in selection order.
     */
    results: GoldenOracleOnlySuiteEntry[];
    /**
     * Strongest independent result exit code.
     */
    exitCode: GoldenOracleOnlyExitCode;
}

/**
 * Evaluate human candidates independently, without agent configuration or lifecycle work.
 *
 * @param options - Ordered case selection and judge-only storage settings.
 * @param dependencies - Independent extraction, human diff, probe, and clock seams.
 * @returns Ordered independent results and their strongest exit code.
 */
export async function runGoldenOracleSuite(
    options: RunGoldenOracleSuiteOptions,
    dependencies: GoldenOracleSuiteDependencies = {},
): Promise<GoldenOracleOnlySuiteResult> {
    const results: GoldenOracleOnlySuiteEntry[] = [];
    let exitCode: GoldenOracleOnlyExitCode = GoldenE2EExitCode.Pass;
    for (const caseName of options.caseNames) {
        let result: GoldenOracleOnlyResult;
        try {
            const outputDirectory = materializeLocalRunOutputDir(
                join(resolve(options.oracleRoot), caseName),
                process.cwd(),
            );
            const caseDirectory = join(resolve(options.casesRoot), caseName);
            const loaded = loadGoldenRunCase(caseDirectory);
            const oracle = (dependencies.loadHumanOracle ?? loadGoldenHumanOracle)(caseDirectory);
            const context = {
                series: options.series,
                caseName,
                humanFixCommit: oracle.humanFixCommit,
                extensionBuild: loaded.config.extensionBuild,
                issueFile: loaded.issueFile,
                now: dependencies.now ?? Date.now,
            };
            await judgeReporterEnvironment(
                context,
                (dependencies.bindJudgeExtractReport ?? bindExtractReport)(
                    options.series.judgeConfig.llm,
                ),
            );
            const humanFix = await (dependencies.extractHumanFix ?? extractHumanCommitFix)(
                oracle.humanFixCommit,
            );
            if (humanFix.commit.toLowerCase() !== oracle.humanFixCommit.toLowerCase()) {
                throw new Error(
                    `Human diff extractor returned ${humanFix.commit}, expected ${oracle.humanFixCommit}.`,
                );
            }
            const probe = dependencies.createJudgeProbe?.(options.series.judgeConfig);
            let evidenceCleared = false;
            const { judgement, fromCache } = await judgeHumanFix(context, humanFix, (candidate) => {
                if (!evidenceCleared) {
                    clearLocalRunOutputDir(outputDirectory, process.cwd());
                    evidenceCleared = true;
                }
                return probe
                    ? probe({
                          caseName,
                          run: loaded.config,
                          issueFile: loaded.issueFile,
                          runConfigPath: loaded.runConfigPath,
                          extensionBuild: loaded.config.extensionBuild,
                          expectedReleaseSha256: null,
                          candidate,
                          outputDirectory,
                      })
                    : unavailableGoldenOracleProbe();
            });
            if (judgement.status === HumanFixVerdict.Verified) {
                result = {
                    status: GoldenOracleOnlyStatus.Alive,
                    exitCode: GoldenE2EExitCode.Pass,
                    detail: judgement.detail,
                    rule: judgement.candidate.rule,
                    fromCache,
                };
            } else if (judgement.status === HumanFixVerdict.NotVerified) {
                result = {
                    status: GoldenOracleOnlyStatus.EnvironmentDrift,
                    exitCode: GoldenE2EExitCode.EnvironmentDrift,
                    detail: judgement.detail,
                    rule: null,
                    fromCache,
                };
            } else {
                result = {
                    status: GoldenOracleOnlyStatus.InfrastructureFailure,
                    exitCode: GoldenE2EExitCode.InfrastructureFailure,
                    detail: judgement.detail,
                    rule: null,
                    fromCache,
                };
            }
        } catch (error) {
            result = {
                status: GoldenOracleOnlyStatus.InfrastructureFailure,
                exitCode: GoldenE2EExitCode.InfrastructureFailure,
                detail: error instanceof Error ? error.message : String(error),
                rule: null,
                fromCache: false,
            };
        }
        results.push({ caseName, result });
        if (result.exitCode > exitCode) {
            exitCode = result.exitCode;
        }
    }
    return { results, exitCode };
}

/**
 * Render an independent oracle result for the manual benchmark command.
 *
 * @param caseName - Selected case directory name.
 * @param result - Independent human-fix evaluation.
 * @returns One case-prefixed line, without a trailing newline.
 */
export function formatGoldenOracleOnlyLine(
    caseName: string,
    result: GoldenOracleOnlyResult,
): string {
    const cached = result.fromCache ? ' (cached)' : '';
    switch (result.status) {
        case GoldenOracleOnlyStatus.Alive:
            return `${caseName}: ${result.status} (${result.rule})${cached}`;
        case GoldenOracleOnlyStatus.EnvironmentDrift:
            return `${caseName}: ${result.status} (${result.detail})${cached}`;
        case GoldenOracleOnlyStatus.InfrastructureFailure:
            return `${caseName}: ${result.status} (${result.detail})`;
    }
}
