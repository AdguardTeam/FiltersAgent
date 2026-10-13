import * as v from 'valibot';
import { createLogger, type Logger } from '../logger/logger';
import type {
    SingleShotCallOptions,
    SingleShotClient,
    SingleShotResult,
    SingleShotStructuredOptions,
} from './single-shot-types';
import {
    recordUsageReport,
    TelemetryObserver,
    type CompletionUsage,
    type UsageReport,
} from './usage-reporting';
import {
    RunUsageSummarySchema,
    UsageRatesTableSchema,
    UsageSummaryVersion,
    type RunUsageSummary,
    type SourceAggregate,
    type TokenTotals,
    type UsageModelRates,
    type UsageRatesTable,
} from '../types/usage-summary';
import { CostCoverage, UsageCompleteness } from '../types/usage-status';

/**
 * Run usage accounting: price the reported completions of one run from the configured per-model
 * rates, collect every segment's report (runner sessions and single-shot calls) into the
 * schema-validated Usage Summary, and decorate a single-shot client so its calls record into that
 * collector. The report vocabulary and the pi-to-app usage mapping live in `usage-reporting.ts`;
 * this module is the only place the Usage Summary is rendered.
 */

/**
 * Round floating-point USD arithmetic to a stable persisted precision.
 *
 * @param value - Raw calculated USD value.
 * @returns Value rounded to twelve decimal places.
 */
function roundUsd(value: number): number {
    return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

/**
 * Price one reported completion from its model's frozen per-million rates.
 *
 * Pi's `input` EXCLUDES cache reads/writes: cached tokens are not a subset of `input`. There is
 * therefore NO subtraction step: cache-read prices at its specialized rate (falling back to the
 * input rate), cache-write at its specialized rate (falling back to the input rate — not every rate
 * pin carries one), the non-reasoning output at the output rate, and the reasoning subset at its
 * specialized rate (falling back to the output rate).
 *
 * @param completion - Normalized completion usage.
 * @param pricing - Model pricing, or undefined when the model is unknown.
 * @returns Priced USD cost, or null when the completion is unreported or unpriced.
 */
function priceCompletion(
    completion: CompletionUsage,
    pricing: UsageModelRates | undefined,
): number | null {
    if (!completion.reported || !pricing) {
        return null;
    }
    const reasoning = Math.min(completion.reasoningTokens, completion.output);
    const cachedRate = pricing.cachedInputUsdPerMillionTokens ?? pricing.inputUsdPerMillionTokens;
    const cacheWriteRate =
        pricing.cacheWriteUsdPerMillionTokens ?? pricing.inputUsdPerMillionTokens;
    const reasoningRate = pricing.reasoningUsdPerMillionTokens ?? pricing.outputUsdPerMillionTokens;
    return roundUsd(
        (completion.input * pricing.inputUsdPerMillionTokens +
            completion.cacheRead * cachedRate +
            completion.cacheWrite * cacheWriteRate +
            (completion.output - reasoning) * pricing.outputUsdPerMillionTokens +
            reasoning * reasoningRate) /
            1_000_000,
    );
}

/**
 * Token sums of one completion set, over reported completions only.
 *
 * @param completions - Normalized completion usages.
 * @returns Zeroed totals when nothing was reported.
 */
function tokenTotals(completions: readonly CompletionUsage[]): TokenTotals {
    const reported = completions.filter((completion) => completion.reported);
    return {
        input: reported.reduce((sum, completion) => sum + completion.input, 0),
        output: reported.reduce((sum, completion) => sum + completion.output, 0),
        cacheRead: reported.reduce((sum, completion) => sum + completion.cacheRead, 0),
        cacheWrite: reported.reduce((sum, completion) => sum + completion.cacheWrite, 0),
        reasoningTokens: reported.reduce((sum, completion) => sum + completion.reasoningTokens, 0),
    };
}

/**
 * Sum the priced completions of one set.
 *
 * @param completions - Normalized completion usages.
 * @param rates - The configured rates table.
 * @returns Rounded sum of priced costs, or null when nothing was priceable.
 */
function pricedCost(
    completions: readonly CompletionUsage[],
    rates: UsageRatesTable,
): number | null {
    const prices = completions
        .map((completion) => priceCompletion(completion, rates[completion.model]))
        .filter((price): price is number => price !== null);
    return prices.length === 0 ? null : roundUsd(prices.reduce((sum, price) => sum + price, 0));
}

/**
 * Aggregate one source (loop or single-shot) over its reports.
 *
 * @param reports - Reports of the source.
 * @param rates - The configured rates table.
 * @returns The source aggregate.
 */
function aggregateSource(reports: readonly UsageReport[], rates: UsageRatesTable): SourceAggregate {
    const completions = reports.flatMap((report) => report.completions);
    return {
        requests: reports.length,
        completions: completions.length,
        tokens: tokenTotals(completions),
        costUsd: pricedCost(completions, rates),
    };
}

/**
 * Collect one run's usage reports and render the persisted Usage Summary on demand.
 *
 * The collector accepts pi-free reports from the runner sessions (`addSession`) and the metered
 * single-shot client (`addSingleShot`); cost derives only from the configured rates table, and
 * absent usage yields explicit zeros plus statuses — never invented numbers.
 */
export interface RunUsageCollector {
    /**
     * Record one runner session's report (loops; one report per run from `onSessionUsage`).
     *
     * @param report - The session's pi-free usage report.
     */
    addSession(report: UsageReport): void;

    /**
     * Record one logical single-shot call's report.
     *
     * @param report - The call's pi-free usage report.
     */
    addSingleShot(report: UsageReport): void;

    /**
     * Render the schema-validated Usage Summary of everything recorded so far.
     *
     * @returns The run's usage summary.
     */
    summary(): RunUsageSummary;
}

/**
 * Options for one run-scoped usage collector.
 */
export interface RunUsageCollectorOptions {
    /**
     * The configured frozen rates table; defaults to `{}`, which makes every priced slot an honest
     * unknown (costUsd null).
     */
    rates?: UsageRatesTable;
}

/**
 * Create one run-scoped usage collector with the given frozen rates table.
 *
 * The rates table is schema-validated at construction (an empty table means honest unknown costs:
 * every priced slot stays null). The rendered summary is schema-validated at each render.
 *
 * @param options - Collector options.
 * @returns The run-scoped collector.
 */
export function createRunUsageCollector(options: RunUsageCollectorOptions = {}): RunUsageCollector {
    const rates = v.parse(UsageRatesTableSchema, options.rates ?? {});
    const sessions: UsageReport[] = [];
    const singleShots: UsageReport[] = [];
    return {
        addSession(report: UsageReport): void {
            sessions.push(report);
        },
        addSingleShot(report: UsageReport): void {
            singleShots.push(report);
        },
        summary(): RunUsageSummary {
            const allCompletions = [
                ...sessions.flatMap((report) => report.completions),
                ...singleShots.flatMap((report) => report.completions),
            ];
            const reported = allCompletions.filter((completion) => completion.reported);
            const pricedCompletions = reported.filter(
                (completion) => rates[completion.model] !== undefined,
            );
            // Pushed into the group the map already owns: rebuilding it with a spread copied
            // every completion of the model again per completion. The arrays are local to this
            // call and hold references the stored reports own, so nothing observable is mutated.
            const modelGroups = new Map<string, CompletionUsage[]>();
            for (const completion of allCompletions) {
                const group = modelGroups.get(completion.model);
                if (group === undefined) {
                    modelGroups.set(completion.model, [completion]);
                } else {
                    group.push(completion);
                }
            }
            const usageCompleteness =
                allCompletions.length === 0 || reported.length === 0
                    ? UsageCompleteness.Unreported
                    : reported.length === allCompletions.length
                      ? UsageCompleteness.Complete
                      : UsageCompleteness.Partial;
            const costCoverage =
                reported.length === 0 || pricedCompletions.length === 0
                    ? CostCoverage.None
                    : pricedCompletions.length === reported.length
                      ? CostCoverage.Full
                      : CostCoverage.Partial;
            return v.parse(RunUsageSummarySchema, {
                schemaVersion: UsageSummaryVersion.Run,
                requests: sessions.length + singleShots.length,
                completions: allCompletions.length,
                unreportedCompletions: allCompletions.length - reported.length,
                repairAttempts: singleShots.reduce(
                    (sum, report) => sum + Math.max(0, report.completions.length - 1),
                    0,
                ),
                durationMs:
                    sessions.reduce((sum, report) => sum + report.durationMs, 0) +
                    singleShots.reduce((sum, report) => sum + report.durationMs, 0),
                tokens: tokenTotals(allCompletions),
                costUsd: pricedCost(allCompletions, rates),
                usageCompleteness,
                costCoverage,
                byModel: [...modelGroups.entries()]
                    .sort(([first], [second]) => first.localeCompare(second))
                    .map(([model, completions]) => ({
                        model,
                        completions: completions.length,
                        tokens: tokenTotals(completions),
                        costUsd: pricedCost(completions, rates),
                    })),
                bySource: {
                    loop: aggregateSource(sessions, rates),
                    singleShot: aggregateSource(singleShots, rates),
                },
                rates,
            });
        },
    };
}

/**
 * Options of the metered single-shot decorator.
 */
export interface MeterSingleShotOptions {
    /**
     * Diagnostics sink for collector failures; defaults to the application logger, mirroring the
     * `options.logger ?? createLogger()` convention of the rest of `src/pi`.
     */
    logger?: Logger;
}

/**
 * Wrap one single-shot client so its calls record usage into the run's collector.
 *
 * Both call paths record EVERY attempted provider call, the failed ones included: their usage is an
 * explicit unreported zero rather than an omission, so a run whose vision calls failed cannot
 * render as complete usage. A collector failure is logged and re-offered as degraded telemetry by
 * `recordUsageReport`, and never reaches the observed call.
 *
 * @param client - The client to observe.
 * @param collector - The run-scoped usage collector.
 * @param options - Diagnostics sink for collector failures.
 * @returns The wrapped client with identical request behavior.
 */
export function meterSingleShotClient(
    client: SingleShotClient,
    collector: RunUsageCollector,
    options: MeterSingleShotOptions = {},
): SingleShotClient {
    const logger = options.logger ?? createLogger();
    const record = (report: UsageReport): void => {
        recordUsageReport(
            (delivered) => collector.addSingleShot(delivered),
            report,
            TelemetryObserver.SingleShotUsage,
            logger,
        );
    };
    /**
     * Time one call and record every attempt it made. Both paths return the same result union, so
     * one wrapper serves them: the usages already carry their model, and nothing here re-attributes
     * them.
     *
     * @param call - The underlying client call.
     * @returns The untouched result.
     */
    const metered = async <T>(
        call: () => Promise<SingleShotResult<T>>,
    ): Promise<SingleShotResult<T>> => {
        const startedAt = Date.now();
        const result = await call();
        record({ completions: result.usages, durationMs: Date.now() - startedAt });
        return result;
    };
    return {
        modelId: client.modelId,
        structured: <T>(callOptions: SingleShotStructuredOptions<T>) =>
            metered(() => client.structured(callOptions)),
        text: (callOptions: SingleShotCallOptions) => metered(() => client.text(callOptions)),
    };
}
