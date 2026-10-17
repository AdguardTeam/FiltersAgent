import type { LoadedBenchmarkRecord } from './benchmark-summary';
import { summarizeBenchmark } from './benchmark-summary';
import { csvField } from './benchmark-summary-format';
import { MILLISECONDS_PER_MINUTE, configurationKey } from './benchmark-summary-statistics';
import { benchmarkAgentRevision, benchmarkJudgeIdentity } from './benchmark-summary-pins';

export const BENCHMARK_CSV_COLUMNS = [
    'case',
    'model',
    'api',
    'loop',
    'vision',
    'reasoningEffort',
    'singleShotReasoningEffort',
    'root',
    'judge',
    'agentCommit',
    'knowledgeBaseCommit',
    'status',
    'failureKind',
    'level',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'requests',
    'costUsd',
    'preparationMinutes',
    'agentMinutes',
    'finalizeMinutes',
    'evaluationMinutes',
    'totalMinutes',
    'turns',
    'humanElapsedMs',
] as const;

/**
 * Export every raw record, including excluded cases, as RFC 4180 CSV.
 *
 * @param records - Trusted records and repetition roots.
 * @returns Header and one lossless row per record with CRLF line endings.
 */
export function renderBenchmarkCsv(records: readonly LoadedBenchmarkRecord[]): string {
    const labels = new Map(
        summarizeBenchmark(records).models.map((model) => [
            configurationKey(model.configuration),
            model.label,
        ]),
    );
    const rows = records.map(({ record, root }) => {
        const { model, outcome, usage, timings } = record;
        const stages = [
            timings.preparationMs,
            timings.agentMs,
            timings.finalizeMs,
            timings.evaluationMs,
            timings.totalMs,
        ].map((value) => (value === null ? null : value / MILLISECONDS_PER_MINUTE));
        return [
            record.case,
            labels.get(configurationKey(model))!,
            model.api,
            model.loop,
            model.vision,
            model.reasoningEffort,
            model.singleShotReasoningEffort,
            root,
            benchmarkJudgeIdentity(record.judge),
            benchmarkAgentRevision(record.agent),
            record.environment.knowledgeBaseCommit,
            outcome.status,
            outcome.failureKind,
            outcome.level,
            usage.tokens?.input ?? null,
            usage.tokens?.output ?? null,
            usage.tokens?.cacheRead ?? null,
            usage.tokens?.cacheWrite ?? null,
            usage.tokens?.reasoningTokens ?? null,
            usage.requests,
            usage.costUsd,
            ...stages,
            record.turns,
            record.human?.elapsedMs ?? null,
        ]
            .map(csvField)
            .join(',');
    });
    return [[...BENCHMARK_CSV_COLUMNS].join(','), ...rows, ''].join('\r\n');
}
