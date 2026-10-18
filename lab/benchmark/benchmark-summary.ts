import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
    BENCHMARK_RECORD_FILE_NAME,
    BENCHMARK_RECORD_SCHEMA_VERSION,
    type BenchmarkRecord,
} from '../e2e/benchmark-record';
import {
    AGENT_OUTCOME_RANKING,
    BenchmarkCaseStatus,
    BenchmarkFailureKind,
} from '../e2e/benchmark-outcome';
import { GoldenAgentEnvironmentStatus } from '../e2e/golden-agent-environment';
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
 * Standard normal quantile for the two-sided 95% confidence interval used for model verified rates.
 */
const WILSON_Z_95 = 1.96;

/**
 * Agent outcomes that reached the reported problem: a rule or a reproduction.
 */
const REACHED_PROBLEM_STATUSES: ReadonlySet<BenchmarkCaseStatus> = new Set([
    BenchmarkCaseStatus.Verified,
    BenchmarkCaseStatus.Proposed,
    BenchmarkCaseStatus.Reproduced,
]);

/**
 * One trusted persisted record and the series root identifying its repetition.
 */
export interface LoadedBenchmarkRecord {
    /**
     * Completed benchmark artifact.
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
     * Counted repetitions, including provider rejections and intake skips.
     */
    runs: number;
    /**
     * Counted repetitions the agent verified with its own browser check.
     */
    verified: number;
    /**
     * Strongest agent outcome among the counted repetitions, or null when every one failed.
     */
    best: BenchmarkCaseStatus | null;
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
 * Model configuration totals and statistics over counted runs.
 */
export interface BenchmarkModelRow extends Omit<BenchmarkCaseCell, 'best'> {
    /**
     * Unique readable model configuration label.
     */
    label: string;
    /**
     * Provider, model roles and both reasoning settings.
     */
    configuration: BenchmarkRecord['model'];
    /**
     * Verified fraction, absent without counted runs.
     */
    verifiedRate: number | null;
    /**
     * Wilson 95% confidence bounds of the verified rate, absent without counted runs.
     */
    interval: BenchmarkInterval | null;
    /**
     * Counted runs that proposed a rule they did not verify.
     */
    proposed: number;
    /**
     * Counted runs that reproduced the problem without proposing a rule.
     */
    reproduced: number;
    /**
     * Counted runs whose verified session did not use the reporter's environment.
     */
    environmentMismatches: number;
    /**
     * Sum of known costs across every run, transient failures included.
     */
    totalCostUsd: number;
    /**
     * Agent provider rejections across every case, counted as failed runs.
     */
    rejected: number;
    /**
     * Agent intake skips across every case, counted as failed runs.
     */
    intakeSkipped: number;
    /**
     * Transient infrastructure failures across every case, not counted.
     */
    transient: number;
    /**
     * Runs not started because the case site did not answer, not counted.
     */
    siteUnreachable: number;
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
     * Cases with cells keyed by the unique model labels.
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
     * Cases whose runs reached an agent outcome yet never reproduced the problem or proposed a
     * rule, for any model: the candidates for a stale case.
     */
    notReproducedCases: string[];
    /**
     * Cases whose site did not answer before at least one run.
     */
    unreachableCases: string[];
    /**
     * Median preparation plus agent minutes across all counted runs.
     */
    agentMedianMinutes: number | null;
    /**
     * Median issue-to-fix hours across the distinct cases with counted runs.
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
    const loaded = roots.flatMap((root) => {
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
                path,
                record: JSON.parse(readFileSync(path, 'utf8')) as BenchmarkRecord,
                root: dirname(dirname(dirname(path))),
            }));
    });
    // Earlier records carry the removed judge's verdicts and statuses; mixing them in would count
    // two different outcome sets as one. All of them are named at once, not one per rerun.
    const older = loaded.filter(
        ({ record }) => record.schemaVersion !== BENCHMARK_RECORD_SCHEMA_VERSION,
    );
    if (older.length > 0) {
        throw new Error(
            `This summary reads version ${BENCHMARK_RECORD_SCHEMA_VERSION} benchmark records; ` +
                `older records:\n${older
                    .map(
                        ({ path, record }) => `  ${path} (version ${String(record.schemaVersion)})`,
                    )
                    .join('\n')}`,
        );
    }
    return loaded.map(({ record, root }) => ({ record, root }));
}

/**
 * Decide whether a run counts toward its model's rates.
 *
 * A provider rejection and an intake skip fail the same way again, so they count against the model.
 * A transient failure and an unreachable site measured no agent work.
 *
 * @param record - One persisted run.
 * @returns Whether the run is counted.
 */
function isCounted(record: BenchmarkRecord): boolean {
    return (
        record.outcome.status !== BenchmarkCaseStatus.SiteUnreachable &&
        record.outcome.failureKind !== BenchmarkFailureKind.Transient
    );
}

/**
 * Pick the strongest agent outcome among repetitions.
 *
 * @param records - Counted repetitions of one case.
 * @returns The highest-ranked agent outcome, or null when every repetition failed.
 */
function bestOutcome(records: readonly BenchmarkRecord[]): BenchmarkCaseStatus | null {
    const statuses = new Set(records.map((record) => record.outcome.status));
    return AGENT_OUTCOME_RANKING.find((status) => statuses.has(status)) ?? null;
}

/**
 * Count runs with one exact outcome status.
 *
 * @param records - Runs to count.
 * @param status - Outcome to match.
 * @returns Number of matching runs.
 */
function countStatus(records: readonly BenchmarkRecord[], status: BenchmarkCaseStatus): number {
    return records.filter((record) => record.outcome.status === status).length;
}

/**
 * Count runs with one failure kind.
 *
 * @param records - Runs to count.
 * @param kind - Failure kind to match.
 * @returns Number of matching runs.
 */
function countFailureKind(records: readonly BenchmarkRecord[], kind: BenchmarkFailureKind): number {
    return records.filter((record) => record.outcome.failureKind === kind).length;
}

/**
 * Summarize counted repetitions while retaining total spend and failure counts.
 *
 * @param records - Trusted records loaded from one or more series.
 * @returns Model and case comparison statistics.
 */
export function summarizeBenchmark(records: readonly LoadedBenchmarkRecord[]): BenchmarkSummary {
    const groups = new Map<string, BenchmarkRecord[]>();
    for (const { record } of records) {
        const key = configurationKey(record.model);
        const group = groups.get(key) ?? [];
        group.push(record);
        groups.set(key, group);
    }
    const counted = records.map(({ record }) => record).filter(isCounted);
    const configurations = [...groups.values()].map((group) => group[0]!.model);
    const models = [...groups.values()].map((all): BenchmarkModelRow => {
        const configuration = all[0]!.model;
        const sharedLabel =
            configurations.filter((model) => model.loop === configuration.loop).length > 1;
        const label = sharedLabel
            ? `${configuration.loop} (${configuration.api}, ${configuration.vision}, ${configuration.reasoningEffort}/${configuration.singleShotReasoningEffort})`
            : configuration.loop;
        const runs = all.filter(isCounted);
        const verified = countStatus(runs, BenchmarkCaseStatus.Verified);
        return {
            label,
            configuration,
            runs: runs.length,
            verified,
            verifiedRate: runs.length ? verified / runs.length : null,
            interval: runs.length ? wilsonInterval(verified, runs.length) : null,
            proposed: countStatus(runs, BenchmarkCaseStatus.Proposed),
            reproduced: countStatus(runs, BenchmarkCaseStatus.Reproduced),
            environmentMismatches: runs.filter(
                (record) =>
                    record.outcome.reporterEnvironment?.status ===
                    GoldenAgentEnvironmentStatus.AgentMismatch,
            ).length,
            medianCostUsd: median(runs.map((record) => record.usage.costUsd)),
            medianMinutes: median(runs.map(agentMinutes)),
            totalCostUsd: all.reduce((sum, record) => sum + (record.usage.costUsd ?? 0), 0),
            rejected: countFailureKind(all, BenchmarkFailureKind.ProviderRejected),
            intakeSkipped: countFailureKind(all, BenchmarkFailureKind.IntakeSkipped),
            transient: countFailureKind(all, BenchmarkFailureKind.Transient),
            siteUnreachable: countStatus(all, BenchmarkCaseStatus.SiteUnreachable),
        };
    });
    const caseNames = [...new Set(records.map(({ record }) => record.case))].sort();
    const cases = caseNames.map((caseName) => ({
        caseName,
        cells: Object.fromEntries(
            models.map((model) => {
                const runs = groups
                    .get(configurationKey(model.configuration))!
                    .filter((record) => record.case === caseName && isCounted(record));
                return [
                    model.label,
                    runs.length
                        ? {
                              runs: runs.length,
                              verified: countStatus(runs, BenchmarkCaseStatus.Verified),
                              best: bestOutcome(runs),
                              medianCostUsd: median(runs.map((record) => record.usage.costUsd)),
                              medianMinutes: median(runs.map(agentMinutes)),
                          }
                        : null,
                ];
            }),
        ),
    }));
    // Only runs that reached the agent's own outcome say anything about the case: a provider
    // rejection or an intake skip fails before the investigation does.
    const agentRuns = counted.filter((record) =>
        AGENT_OUTCOME_RANKING.includes(record.outcome.status),
    );
    const notReproducedCases = caseNames.filter((caseName) => {
        const runs = agentRuns.filter((record) => record.case === caseName);
        return (
            runs.length > 0 &&
            !runs.some((record) => REACHED_PROBLEM_STATUSES.has(record.outcome.status))
        );
    });
    const unreachableCases = caseNames.filter((caseName) =>
        records.some(
            ({ record }) =>
                record.case === caseName &&
                record.outcome.status === BenchmarkCaseStatus.SiteUnreachable,
        ),
    );
    // Over the cases the agent median covers, so both sides of the comparison share one corpus: a
    // run without agent time, such as an intake skip, brings no case to either side.
    const timedRuns = counted.filter((record) => agentMinutes(record) !== null);
    const humanDurations = [...new Set(timedRuns.map((record) => record.case))].map(
        (caseName) => timedRuns.find((record) => record.case === caseName)!.human.elapsedMs,
    );
    const humanMedianMs = median(humanDurations);
    return {
        models,
        cases,
        notReproducedCases,
        unreachableCases,
        mixedPins: mixedBenchmarkPins(records.map(({ record }) => record)),
        agentMedianMinutes: median(counted.map(agentMinutes)),
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
 * @returns Two tables and the corpus timing and case lines.
 */
export function renderBenchmarkSummaryMarkdown(summary: BenchmarkSummary): string {
    const modelRows = summary.models.map((model) => {
        const rate =
            model.interval && model.verifiedRate !== null
                ? `${Math.round(model.verifiedRate * 100)}% (${Math.round(model.interval.low * 100)}–${Math.round(model.interval.high * 100)}%)`
                : UNAVAILABLE;
        return `| ${[
            markdownCell(model.label),
            model.runs,
            model.verified,
            rate,
            model.proposed,
            model.reproduced,
            model.environmentMismatches,
            fixed(model.medianCostUsd, MONEY_DECIMALS),
            fixed(model.totalCostUsd, MONEY_DECIMALS),
            fixed(model.medianMinutes, STATISTIC_DECIMALS),
            model.rejected,
            model.intakeSkipped,
            model.transient,
            model.siteUnreachable,
        ].join(' | ')} |`;
    });
    const caseRows = summary.cases.map(({ caseName, cells }) => {
        const values = summary.models.map(({ label }) => {
            const cell = cells[label];
            return cell
                ? `${cell.verified}/${cell.runs} ${cell.best ?? UNAVAILABLE} $${fixed(cell.medianCostUsd, MONEY_DECIMALS)} ${fixed(cell.medianMinutes, STATISTIC_DECIMALS)}m`
                : UNAVAILABLE;
        });
        return `| ${[markdownCell(caseName), ...values].join(' | ')} |`;
    });
    return [
        '| model | runs | verified | verified rate (95% CI) | proposed | reproduced | env mismatch | $/case med | $ total | min/case med | rejected | intake skipped | transient | site unreachable |',
        '| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
        ...modelRows,
        '',
        `| case | ${summary.models.map(({ label }) => markdownCell(label)).join(' | ')} |`,
        `| --- | ${summary.models.map(() => '---').join(' | ')} |`,
        ...caseRows,
        '',
        `agent vs human: agent median ${fixed(summary.agentMedianMinutes, STATISTIC_DECIMALS)} min per case (preparation + agent); human median issue → fix ${fixed(summary.humanMedianHours, STATISTIC_DECIMALS)} h`,
        `no model reproduced: ${summary.notReproducedCases.map(markdownCell).join(', ') || UNAVAILABLE}`,
        `site unreachable: ${summary.unreachableCases.map(markdownCell).join(', ') || UNAVAILABLE}`,
        ...(summary.mixedPins.length > 0
            ? [
                  `mixed pins: ${summary.mixedPins.map(({ pin, values }) => `${pin} (${values.length} values)`).join(', ')}`,
              ]
            : []),
        '',
    ].join('\n');
}
