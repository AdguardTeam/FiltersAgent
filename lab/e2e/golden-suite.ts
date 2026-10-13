import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CoreConfig } from '../../src/config/config';
import type { UsageRatesTable } from '../../src/types/usage-summary';
import { readRunCost, type RunCost } from '../pricing/run-cost';
import type { GoldenE2EResult } from './golden-comparator';
import { runGoldenE2ECase, type GoldenE2ERunnerDependencies } from './golden-runner';

/**
 * Paths and ordered case selection for one manual suite invocation.
 */
export interface RunGoldenE2ESuiteOptions {
    /**
     * Explicit case names to execute in this exact order.
     */
    caseNames: readonly string[];

    /**
     * Tracked benchmark/e2e/cases directory.
     */
    casesRoot: string;

    /**
     * Ignored tmp/e2e-runs directory.
     */
    outputRoot: string;

    /**
     * Separate ignored tmp/e2e-evaluations directory.
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
     * Final per-case classification.
     */
    result: GoldenE2EResult;

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
     * Strongest exit code across all cases.
     */
    exitCode: 0 | 1 | 2 | 3;
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
 * @param dependencies - Optional lifecycle and independent-oracle seams.
 * @returns Per-case classifications and costs, and the strongest suite exit code.
 */
export async function runGoldenE2ESuite(
    coreConfig: CoreConfig,
    options: RunGoldenE2ESuiteOptions,
    dependencies: GoldenE2ERunnerDependencies = {},
): Promise<GoldenE2ESuiteResult> {
    if (options.caseNames.length === 0) {
        throw new Error('Golden E2E suite requires at least one case.');
    }
    const results: GoldenE2ESuiteEntry[] = [];
    for (const caseName of options.caseNames) {
        const outputDirectory = join(resolve(options.outputRoot), caseName);
        const result = await runGoldenE2ECase(
            coreConfig,
            {
                caseName,
                caseDirectory: join(resolve(options.casesRoot), caseName),
                outputDirectory,
                evaluationDirectory: join(resolve(options.evaluationRoot), caseName),
                verbose: options.verbose,
                pricingSnapshot: options.pricingSnapshot,
            },
            dependencies,
        );
        results.push({ caseName, result, cost: readRunCost(outputDirectory) });
    }
    const exitCode = Math.max(...results.map((entry) => entry.result.exitCode)) as 0 | 1 | 2 | 3;
    return { results, exitCode };
}
