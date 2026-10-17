import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
    BENCHMARK_RECORD_FILE_NAME,
    BenchmarkFailureKind,
    type BenchmarkLevel,
    type BenchmarkRecord,
} from '../e2e/benchmark-record';
import { GoldenE2EStatus } from '../e2e/golden-comparator';
import { HumanFixVerdict } from '../e2e/golden-judge';
import {
    MONEY_DECIMALS,
    STATISTIC_DECIMALS,
    UNAVAILABLE,
    fixed,
    markdownCell,
} from './benchmark-summary-format';

import {
    MILLISECONDS_PER_MINUTE,
    MINUTES_PER_HOUR,
    agentMinutes,
    configurationKey,
    median,
} from './benchmark-summary-statistics';
import { mixedBenchmarkPins, type MixedBenchmarkPin } from './benchmark-summary-pins';

/**
 * Standard normal quantile for the two-sided 95% confidence interval used for model pass rates.
 */
const WILSON_Z_95 = 1.96;
/**
 * One trusted persisted record and the series root identifying its repetition.
 */
export interface LoadedBenchmarkRecord {
    /**
     * Completed comparison artifact.
     */
    record: BenchmarkRecord;
    /**
     * Parent of the directory containing the case directories.
     */
    root: string;
}

/**
 * A binomial confidence interval expressed as fractions.
 */
export interface BenchmarkInterval {
    /**
     * Lower probability bound.
     */
    low: number;
    /**
     * Upper probability bound.
     */
    high: number;
}

/**
 * One case and model configuration aggregated across repetitions.
 */
export interface BenchmarkCaseCell {
    /**
     * Counted repetitions, including provider rejections.
     */
    runs: number;
    /**
     * Passing counted repetitions.
     */
    pass: number;
    /**
     * Highest milestone in the counted repetitions.
     */
    maxLevel: BenchmarkLevel;
    /**
     * Median known cost of counted repetitions.
     */
    medianCostUsd: number | null;
    /**
     * Median preparation plus agent duration in minutes.
     */
    medianMinutes: number | null;
}

/**
 * Model configuration totals and statistics over eligible cases.
 */
export interface BenchmarkModelRow extends Omit<BenchmarkCaseCell, 'maxLevel'> {
    /**
     * Unique readable model configuration label.
     */
    label: string;
    /**
     * Provider, model roles and both reasoning settings.
     */
    configuration: BenchmarkRecord['model'];
    /**
     * Pass fraction, absent without counted runs.
     */
    passRate: number | null;
    /**
     * Wilson 95% confidence bounds, absent without counted runs.
     */
    interval: BenchmarkInterval | null;
    /**
     * Mean milestone across counted runs.
     */
    meanLevel: number | null;
    /**
     * Sum of known costs, including excluded cases and infrastructure failures.
     */
    totalCostUsd: number;
    /**
     * Agent provider rejections across every case.
     */
    rejected: number;
    /**
     * Agent intake skips across every case, counted as failed runs.
     */
    intakeSkipped: number;
    /**
     * Transient infrastructure failures across every case.
     */
    transient: number;
}

/**
 * Both comparison tables and corpus-wide timing statistics.
 */
export interface BenchmarkSummary {
    /**
     * Model configuration statistics.
     */
    models: BenchmarkModelRow[];
    /**
     * Eligible cases with cells keyed by the unique model labels.
     */
    cases: {
        /**
         * Stable golden case identity.
         */
        caseName: string;
        /**
         * Counted repetitions for each model, or null without any.
         */
        cells: Record<string, BenchmarkCaseCell | null>;
    }[];
    /**
     * Cases independently found dead by any model's judge.
     */
    excludedCases: string[];
    /**
     * Median preparation plus agent minutes across all counted runs.
     */
    agentMedianMinutes: number | null;
    /**
     * Median issue-to-fix hours across distinct eligible cases.
     */
    humanMedianHours: number | null;
    /**
     * Series-wide conditions differing across any loaded records.
     */
    mixedPins: MixedBenchmarkPin[];
}

/**
 * Calculate the Wilson score interval for a binomial proportion.
 *
 * @param successes - Passing observations.
 * @param trials - Counted observations.
 * @returns Probability bounds, or the full probability range without observations.
 */
export function wilsonInterval(successes: number, trials: number): BenchmarkInterval {
    if (trials === 0) {
        return { low: 0, high: 1 };
    }
    const proportion = successes / trials;
    const squaredZ = WILSON_Z_95 ** 2;
    const denominator = 1 + squaredZ / trials;
    const center = (proportion + squaredZ / (2 * trials)) / denominator;
    const margin =
        (WILSON_Z_95 / denominator) *
        Math.sqrt((proportion * (1 - proportion)) / trials + squaredZ / (4 * trials ** 2));
    return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

/**
 * Recursively find persisted comparison artifacts without following directory symlinks.
 *
 * @param directory - Search root or nested directory.
 * @returns Artifact paths in deterministic directory order.
 */
function recordFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .flatMap((entry) => {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                return recordFiles(path);
            }
            return entry.isFile() && entry.name === BENCHMARK_RECORD_FILE_NAME ? [path] : [];
        });
}

/**
 * Read trusted comparison artifacts below each supplied root.
 *
 * @param roots - Directories containing one or more benchmark records.
 * @returns Records with their repetition roots derived from the artifact layout.
 */
export function readBenchmarkRecords(roots: readonly string[]): LoadedBenchmarkRecord[] {
    const seen = new Set<string>();
    return roots.flatMap((root) => {
        const paths = recordFiles(resolve(root));
        if (paths.length === 0) {
            throw new Error(`No benchmark records found under ${root}`);
        }
        return paths
            .filter((path) => {
                if (seen.has(path)) {
                    return false;
                }
                seen.add(path);
                return true;
            })
            .map((path) => ({
                record: JSON.parse(readFileSync(path, 'utf8')) as BenchmarkRecord,
                root: dirname(dirname(dirname(path))),
            }));
    });
}

/**
 * Summarize eligible repetitions while retaining total spend and failure counts.
 *
 * @param records - Trusted records loaded from one or more series.
 * @returns Model and case comparison statistics with global drift exclusions.
 */
export function summarizeBenchmark(records: readonly LoadedBenchmarkRecord[]): BenchmarkSummary {
    const excluded = new Set(
        records
            .filter(({ record }) => record.outcome.humanFixVerdict === HumanFixVerdict.NotVerified)
            .map(({ record }) => record.case),
    );
    const groups = new Map<string, BenchmarkRecord[]>();
    for (const { record } of records) {
        const key = configurationKey(record.model);
        const group = groups.get(key) ?? [];
        group.push(record);
        groups.set(key, group);
    }
    const eligible = records
        .map(({ record }) => record)
        .filter(
            (record) =>
                !excluded.has(record.case) &&
                record.outcome.status !== GoldenE2EStatus.EnvironmentDrift &&
                record.outcome.failureKind !== BenchmarkFailureKind.Transient,
        );
    const counted = new Set(eligible);
    const configurations = [...groups.values()].map((group) => group[0]!.model);
    const models = [...groups.values()].map((all): BenchmarkModelRow => {
        const configuration = all[0]!.model;
        const sharedLabel =
            configurations.filter((model) => model.loop === configuration.loop).length > 1;
        const label = sharedLabel
            ? `${configuration.loop} (${configuration.api}, ${configuration.vision}, ${configuration.reasoningEffort}/${configuration.singleShotReasoningEffort})`
            : configuration.loop;
        const runs = all.filter((record) => counted.has(record));
        const pass = runs.filter((record) => record.outcome.status === GoldenE2EStatus.Pass).length;
        return {
            label,
            configuration,
            runs: runs.length,
            pass,
            passRate: runs.length ? pass / runs.length : null,
            interval: runs.length ? wilsonInterval(pass, runs.length) : null,
            meanLevel: runs.length
                ? runs.reduce((sum, record) => sum + record.outcome.level, 0) / runs.length
                : null,
            medianCostUsd: median(runs.map((record) => record.usage.costUsd)),
            medianMinutes: median(runs.map(agentMinutes)),
            totalCostUsd: all.reduce((sum, record) => sum + (record.usage.costUsd ?? 0), 0),
            rejected: all.filter(
                (record) => record.outcome.failureKind === BenchmarkFailureKind.ProviderRejected,
            ).length,
            intakeSkipped: all.filter(
                (record) => record.outcome.failureKind === BenchmarkFailureKind.IntakeSkipped,
            ).length,
            transient: all.filter(
                (record) => record.outcome.failureKind === BenchmarkFailureKind.Transient,
            ).length,
        };
    });
    const caseNames = [...new Set(records.map(({ record }) => record.case))]
        .filter((caseName) => !excluded.has(caseName))
        .sort();
    const cases = caseNames.map((caseName) => ({
        caseName,
        cells: Object.fromEntries(
            models.map((model) => {
                const runs = groups
                    .get(configurationKey(model.configuration))!
                    .filter((record) => record.case === caseName && counted.has(record));
                return [
                    model.label,
                    runs.length
                        ? {
                              runs: runs.length,
                              pass: runs.filter(
                                  (record) => record.outcome.status === GoldenE2EStatus.Pass,
                              ).length,
                              maxLevel: Math.max(
                                  ...runs.map((record) => record.outcome.level),
                              ) as BenchmarkLevel,
                              medianCostUsd: median(runs.map((record) => record.usage.costUsd)),
                              medianMinutes: median(runs.map(agentMinutes)),
                          }
                        : null,
                ];
            }),
        ),
    }));
    const humanDurations = caseNames.map(
        (caseName) =>
            records.find(({ record }) => record.case === caseName && record.human !== null)?.record
                .human?.elapsedMs ?? null,
    );
    const humanMedianMs = median(humanDurations);
    return {
        models,
        cases,
        excludedCases: [...excluded].sort(),
        mixedPins: mixedBenchmarkPins(records.map(({ record }) => record)),
        agentMedianMinutes: median(eligible.map(agentMinutes)),
        humanMedianHours:
            humanMedianMs === null
                ? null
                : humanMedianMs / MILLISECONDS_PER_MINUTE / MINUTES_PER_HOUR,
    };
}

/**
 * Render model totals, per-case repetitions and timing comparisons as Markdown.
 *
 * @param summary - Computed comparison statistics.
 * @returns Two tables and corpus timing and drift lines.
 */
export function renderBenchmarkSummaryMarkdown(summary: BenchmarkSummary): string {
    const modelRows = summary.models.map((model) => {
        const rate =
            model.interval && model.passRate !== null
                ? `${Math.round(model.passRate * 100)}% (${Math.round(model.interval.low * 100)}–${Math.round(model.interval.high * 100)}%)`
                : UNAVAILABLE;
        return `| ${[
            markdownCell(model.label),
            model.runs,
            model.pass,
            rate,
            fixed(model.meanLevel, STATISTIC_DECIMALS),
            fixed(model.medianCostUsd, MONEY_DECIMALS),
            fixed(model.totalCostUsd, MONEY_DECIMALS),
            fixed(model.medianMinutes, STATISTIC_DECIMALS),
            model.rejected,
            model.intakeSkipped,
            model.transient,
        ].join(' | ')} |`;
    });
    const caseRows = summary.cases.map(({ caseName, cells }) => {
        const values = summary.models.map(({ label }) => {
            const cell = cells[label];
            return cell
                ? `${cell.pass}/${cell.runs} L${cell.maxLevel} $${fixed(cell.medianCostUsd, MONEY_DECIMALS)} ${fixed(cell.medianMinutes, STATISTIC_DECIMALS)}m`
                : UNAVAILABLE;
        });
        return `| ${[markdownCell(caseName), ...values].join(' | ')} |`;
    });
    return [
        '| model | runs | pass | pass rate (95% CI) | mean L | $/case med | $ total | min/case med | rejected | intake skipped | transient |',
        '| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
        ...modelRows,
        '',
        `| case | ${summary.models.map(({ label }) => markdownCell(label)).join(' | ')} |`,
        `| --- | ${summary.models.map(() => '---').join(' | ')} |`,
        ...caseRows,
        '',
        `agent vs human: agent median ${fixed(summary.agentMedianMinutes, STATISTIC_DECIMALS)} min per case (preparation + agent); human median issue → fix ${fixed(summary.humanMedianHours, STATISTIC_DECIMALS)} h`,
        `excluded cases (drift): ${summary.excludedCases.map(markdownCell).join(', ') || UNAVAILABLE}`,
        ...(summary.mixedPins.length > 0
            ? [
                  `mixed pins: ${summary.mixedPins.map(({ pin, values }) => `${pin} (${values.length} values)`).join(', ')}`,
              ]
            : []),
        '',
    ].join('\n');
}
