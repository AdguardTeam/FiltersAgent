import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LLM_USAGE_SUMMARY_FILE_NAME } from '../../src/local/run-manifest';
import { CostCoverage } from '../../src/types/usage-status';
import { readRunUsageSummary } from '../../src/types/usage-summary';
import { LLM_PRICING_FILE_VAR } from './usage-pricing';

/**
 * What one run's cost line says, read back from the usage summary the run locked. The summary
 * records the rate table the run priced with, so whether a price file was supplied is a fact of the
 * run itself and not of the shell that reads it afterwards.
 */
export const RunCostStatus = {
    /**
     * Every reported completion was priced.
     */
    Priced: 'priced',

    /**
     * Some completions were priced; the figure covers only those.
     */
    PartiallyPriced: 'partially_priced',

    /**
     * The run had no price file, so no cost was computed.
     */
    NoPricingFile: 'no_pricing_file',

    /**
     * A price file was supplied but priced none of the run's completions: the models it names
     * differ from the ones the provider reported, or the provider reported no usage.
     */
    Unpriced: 'unpriced',

    /**
     * The run ended before it wrote a usage summary.
     */
    NoUsage: 'no_usage',
} as const;

/**
 * RunCostStatus value.
 */
export type RunCostStatus = (typeof RunCostStatus)[keyof typeof RunCostStatus];

/**
 * One run's cost as the benchmark reports it.
 */
export interface RunCost {
    /**
     * Whether and how fully the run was priced.
     */
    status: RunCostStatus;

    /**
     * Priced USD total, or null when nothing was priced.
     */
    usd: number | null;

    /**
     * Model ids the run used that the price file does not list.
     */
    unpricedModels: string[];
}

/**
 * Read the cost of one finished run from its locked usage summary.
 *
 * @param runDirectory - The run's output directory.
 * @returns The run's cost.
 */
export function readRunCost(runDirectory: string): RunCost {
    const summaryPath = join(runDirectory, LLM_USAGE_SUMMARY_FILE_NAME);
    if (!existsSync(summaryPath)) {
        return { status: RunCostStatus.NoUsage, usd: null, unpricedModels: [] };
    }
    const summary = readRunUsageSummary(JSON.parse(readFileSync(summaryPath, 'utf8')));
    const unpricedModels = summary.byModel
        .map((entry) => entry.model)
        .filter((model) => summary.rates[model] === undefined);
    if (Object.keys(summary.rates).length === 0) {
        return { status: RunCostStatus.NoPricingFile, usd: null, unpricedModels };
    }
    switch (summary.costCoverage) {
        case CostCoverage.Full:
            return { status: RunCostStatus.Priced, usd: summary.costUsd, unpricedModels };
        case CostCoverage.Partial:
            return { status: RunCostStatus.PartiallyPriced, usd: summary.costUsd, unpricedModels };
        case CostCoverage.None:
            return { status: RunCostStatus.Unpriced, usd: null, unpricedModels };
    }
}

/**
 * Format a USD amount for a cost line. Four decimals, because a single benchmark case on a cheap
 * model costs fractions of a cent and two decimals would print most of them as zero.
 *
 * @param usd - Amount in USD.
 * @returns The amount with a dollar sign.
 */
export function formatUsd(usd: number): string {
    return `$${usd.toFixed(4)}`;
}

/**
 * Render one run's cost as the single line the benchmark prints under the case.
 *
 * @param cost - The run's cost.
 * @returns The human-readable cost line.
 */
export function describeRunCost(cost: RunCost): string {
    const missing = cost.unpricedModels.join(', ');
    switch (cost.status) {
        case RunCostStatus.Priced:
            return `cost: ${formatUsd(cost.usd ?? 0)}`;
        case RunCostStatus.PartiallyPriced:
            return `cost: ${formatUsd(cost.usd ?? 0)} (partial, not in the price file: ${missing})`;
        case RunCostStatus.NoPricingFile:
            return `cost: not computed, no price file (set ${LLM_PRICING_FILE_VAR})`;
        case RunCostStatus.Unpriced:
            return missing.length > 0
                ? `cost: not computed, not in the price file: ${missing}`
                : 'cost: not computed, the provider reported no usage';
        case RunCostStatus.NoUsage:
            return 'cost: unknown, the run wrote no usage summary';
    }
}
