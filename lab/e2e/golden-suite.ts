import { GoldenE2EExitCode } from './golden-exit-code';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CoreConfig } from '../../src/config/config';
import type { EnabledBlockerModule } from '../../src/proxy-blocker/blocker-module-run-issue';
import type { UsageRatesTable } from '../../src/types/usage-summary';
import { readRunCost, type RunCost } from '../pricing/run-cost';
import { loadGoldenHumanOracle, type GoldenHumanOracle } from './golden-case';
import { resolveKnowledgeBaseMasterSha } from './knowledge-base-pin';
import { AGENT_OUTCOME_RANKING } from './benchmark-outcome';
import type { BenchmarkRecord, BenchmarkRunEnvironment } from './benchmark-record';
import { runGoldenE2ECase, type GoldenE2ERunnerDependencies } from './golden-runner';

/**
 * Paths and ordered case selection for one manual suite invocation.
 */
export interface RunGoldenE2ESuiteOptions {
    /**
     * Source and browser provenance captured once for the series.
     */
    runEnvironment: BenchmarkRunEnvironment;

    /**
     * Explicit immutable KnowledgeBase commit; absent resolves master once for the suite.
     */
    knowledgeBaseSha?: string;

    /**
     * Announce the selected KnowledgeBase commit before the first case begins.
     */
    onKnowledgeBaseResolved?: (sha: string) => void;

    /**
     * Explicit case names to execute in this exact order.
     */
    caseNames: readonly string[];

    /**
     * Tracked benchmark/e2e/cases directory.
     */
    casesRoot: string;

    /**
     * Root containing the selected cases' agent run directories.
     */
    outputRoot: string;

    /**
     * Refuse any selected case whose run or evaluation directory already exists.
     */
    refuseExistingCaseDirectories?: boolean;

    /**
     * Separate root containing the selected cases' evaluation directories.
     */
    evaluationRoot: string;

    /**
     * Whether every underlying local run should emit verbose logs.
     */
    verbose?: boolean;

    /**
     * The user's price table every case is priced from; absent, no case computes a cost.
     */
    pricingSnapshot?: UsageRatesTable;

    /**
     * The blocker modules every case plugs in; absent plugs in none.
     */
    blockerModules?: readonly EnabledBlockerModule[];
}

/**
 * Case lifecycle seams and one read-only KnowledgeBase resolution for the whole suite.
 */
export type GoldenE2ESuiteDependencies = GoldenE2ERunnerDependencies & {
    /**
     * Resolve KnowledgeBase master once when no explicit commit was supplied.
     */
    resolveKnowledgeBaseSha?: () => Promise<string>;
    /**
     * Closed oracle loader, read for every selected case before the first one starts.
     */
    loadHumanOracle?: (caseDirectory: string) => GoldenHumanOracle;
};

/**
 * Resolve the default replaceable directories or one isolated model output root.
 *
 * @param workspaceRoot - Workspace used to resolve a relative output root.
 * @param outputRoot - Explicit model output root, or null for the legacy directories.
 * @returns Run and evaluation roots and whether case directories must be new.
 */
export function goldenOutputLayout(
    workspaceRoot: string,
    outputRoot: string | null,
): {
    /**
     * Root containing one agent run directory per case.
     */
    outputRoot: string;
    /**
     * Root containing one evaluation directory per case.
     */
    evaluationRoot: string;
    /**
     * Whether pre-existing case directories must abort the suite.
     */
    refuseExisting: boolean;
} {
    if (outputRoot !== null) {
        const root = resolve(workspaceRoot, outputRoot);
        return {
            outputRoot: join(root, 'runs'),
            evaluationRoot: join(root, 'evaluations'),
            refuseExisting: true,
        };
    }
    return {
        outputRoot: join(workspaceRoot, 'tmp', 'e2e-runs'),
        evaluationRoot: join(workspaceRoot, 'tmp', 'e2e-evaluations'),
        refuseExisting: false,
    };
}

/**
 * Named result retained for one sequential suite entry.
 */
export interface GoldenE2ESuiteEntry {
    /**
     * Case directory name.
     */
    caseName: string;

    /**
     * The case's persisted benchmark record.
     */
    record: BenchmarkRecord;

    /**
     * The case run's cost, read back from the usage summary the run locked.
     */
    cost: RunCost;
}

/**
 * Aggregate result of a sequential manual E2E invocation.
 */
export interface GoldenE2ESuiteResult {
    /**
     * Per-case results in execution order.
     */
    results: GoldenE2ESuiteEntry[];

    /**
     * Whether every case produced an agent outcome.
     */
    exitCode: GoldenE2EExitCode;
}

/**
 * Discover tracked golden case directories without reading their closed oracle documents.
 *
 * @param casesRoot - Root directory containing one subdirectory per case.
 * @returns Lexically sorted case names that contain run.json.
 */
export function listGoldenCaseNames(casesRoot: string): string[] {
    const root = resolve(casesRoot);
    const names = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => existsSync(join(root, name, 'run.json')));
    const orderedNames: string[] = [];
    for (const name of names) {
        const insertionIndex = orderedNames.findIndex(
            (existingName) => name.localeCompare(existingName) < 0,
        );
        if (insertionIndex === -1) {
            orderedNames.push(name);
        } else {
            orderedNames.splice(insertionIndex, 0, name);
        }
    }
    return orderedNames;
}

/**
 * Run multiple golden cases sequentially so browser and extension builds never overlap.
 *
 * @param coreConfig - GitHub-independent LLM and headless browser configuration.
 * @param options - Ordered selection, tracked/ignored roots and the optional price table.
 * @param dependencies - Optional lifecycle seams.
 * @returns Per-case records and costs, and the suite exit code.
 */
export async function runGoldenE2ESuite(
    coreConfig: CoreConfig,
    options: RunGoldenE2ESuiteOptions,
    dependencies: GoldenE2ESuiteDependencies = {},
): Promise<GoldenE2ESuiteResult> {
    if (options.caseNames.length === 0) {
        throw new Error('Golden E2E suite requires at least one case.');
    }
    if (options.refuseExistingCaseDirectories) {
        for (const caseName of options.caseNames) {
            for (const root of [options.outputRoot, options.evaluationRoot]) {
                const directory = join(resolve(root), caseName);
                if (existsSync(directory)) {
                    throw new Error(`Golden E2E case directory already exists: ${directory}`);
                }
            }
        }
    }
    // A case without an oracle has no record to write. Reading every oracle first stops a broken
    // case before the first agent is paid for, instead of in the middle of the series. Nothing from
    // an oracle reaches an agent; the runner reads its human fix only after the agent's run seals.
    const { loadHumanOracle = loadGoldenHumanOracle, ...runnerDependencies } = dependencies;
    const oracles = new Map<string, GoldenHumanOracle>();
    for (const caseName of options.caseNames) {
        try {
            oracles.set(caseName, loadHumanOracle(join(resolve(options.casesRoot), caseName)));
        } catch (error) {
            throw new Error(
                `Golden case ${caseName} has no readable oracle.json: ` +
                    `${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
            );
        }
    }
    const knowledgeBaseSha =
        options.knowledgeBaseSha ??
        (await (dependencies.resolveKnowledgeBaseSha ?? resolveKnowledgeBaseMasterSha)());
    options.onKnowledgeBaseResolved?.(knowledgeBaseSha);
    const results: GoldenE2ESuiteEntry[] = [];
    for (const caseName of options.caseNames) {
        const outputDirectory = join(resolve(options.outputRoot), caseName);
        const record = await runGoldenE2ECase(
            coreConfig,
            {
                runEnvironment: options.runEnvironment,
                knowledgeBaseSha,
                caseName,
                caseDirectory: join(resolve(options.casesRoot), caseName),
                oracle: oracles.get(caseName)!,
                outputDirectory,
                evaluationDirectory: join(resolve(options.evaluationRoot), caseName),
                verbose: options.verbose,
                pricingSnapshot: options.pricingSnapshot,
                blockerModules: options.blockerModules,
            },
            runnerDependencies,
        );
        results.push({ caseName, record, cost: readRunCost(outputDirectory) });
    }
    // Every status but the agent's own outcomes measured no agent work.
    const incomplete = results.some(
        ({ record }) => !AGENT_OUTCOME_RANKING.includes(record.outcome.status),
    );
    return {
        results,
        exitCode: incomplete ? GoldenE2EExitCode.Incomplete : GoldenE2EExitCode.Completed,
    };
}
