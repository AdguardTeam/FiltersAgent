import type { BenchmarkRecord } from '../e2e/benchmark-record';

/**
 * Milliseconds per minute for all displayed benchmark stages.
 */
export const MILLISECONDS_PER_MINUTE = 60_000;
/**
 * Minutes per hour for human issue-to-fix durations.
 */
export const MINUTES_PER_HOUR = 60;

/**
 * Find the median of available numeric measurements.
 *
 * @param values - Measurements, with null identifying unavailable sources.
 * @returns Median, or null without measurements.
 */
export function median(values: (number | null)[]): number | null {
    const sorted = values.filter((value) => value !== null).sort((left, right) => left - right);
    if (sorted.length === 0) {
        return null;
    }
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Read preparation plus agent time without treating missing stages as zero.
 *
 * @param record - Persisted run measurements.
 * @returns Agent-facing elapsed minutes when both stages are known.
 */
export function agentMinutes(record: BenchmarkRecord): number | null {
    const { preparationMs, agentMs } = record.timings;
    return preparationMs === null || agentMs === null
        ? null
        : (preparationMs + agentMs) / MILLISECONDS_PER_MINUTE;
}

/**
 * Identify the complete provider and model configuration independently of property order.
 *
 * @param model - Recorded configuration.
 * @returns Stable grouping key.
 */
export function configurationKey(model: BenchmarkRecord['model']): string {
    return JSON.stringify([
        model.api,
        model.loop,
        model.vision,
        model.reasoningEffort,
        model.singleShotReasoningEffort,
    ]);
}
