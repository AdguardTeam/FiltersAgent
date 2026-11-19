import type { LoadedBenchmarkRecord } from './benchmark-summary';
import { summarizeBenchmark } from './benchmark-summary';
import { csvField } from './benchmark-summary-format';
import { MILLISECONDS_PER_MINUTE, configurationKey } from './benchmark-summary-statistics';
import { benchmarkAgentRevision } from './benchmark-summary-pins';
import type { InsertRepositoryEdit } from '../../src/types/repository-edit';
import { RepositoryEditKind } from '../../src/types/repository-edit-kind';

export const BENCHMARK_CSV_COLUMNS = [
    'case',
    'model',
    'api',
    'loop',
    'vision',
    'reasoningEffort',
    'singleShotReasoningEffort',
    'root',
    'agentCommit',
    'knowledgeBaseCommit',
    'status',
    'failureKind',
    'reporterEnvironment',
    'agentRule',
    'agentFilePath',
    'agentEdit',
    'agentBasis',
    'agentHeading',
    'humanFixCommit',
    'humanRules',
    'humanRemovedRules',
    'humanRulesError',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'requests',
    'costUsd',
    'siteCheckMinutes',
    'preparationMinutes',
    'agentMinutes',
    'finalizeMinutes',
    'evaluationMinutes',
    'totalMinutes',
    'turns',
    'humanElapsedMs',
] as const;

/**
 * Serialize a JSON column value, leaving an absent value empty.
 *
 * @param value - Column value, or undefined when the record has none.
 * @returns JSON text, or null for an empty field.
 */
function jsonOrNull(value: unknown): string | null {
    return value === undefined ? null : JSON.stringify(value);
}

/**
 * The shape earlier builds wrote: the heading under its legacy name.
 */
interface LegacyInsertHeading {
    /**
     * Heading text recorded under the name earlier builds wrote.
     */
    readonly section?: string;
}

/**
 * The heading an insert edit records, under its current name or the legacy `section` field earlier
 * builds wrote.
 *
 * @param edit - The insert edit recorded on the run's candidate.
 * @returns The heading, or null when the edit records none.
 */
function recordedHeading(edit: InsertRepositoryEdit): string | null {
    // Records are read as JSON without a parse, so an older one still carries the legacy field.
    return edit.heading ?? (edit as LegacyInsertHeading).section ?? null;
}

/**
 * Export every raw record, uncounted runs included, as RFC 4180 CSV.
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
        const candidateEdit = outcome.candidate?.repositoryEdit;
        const insertionEdit =
            candidateEdit?.kind === RepositoryEditKind.Insert ? candidateEdit : null;
        const stages = [
            timings.siteCheckMs,
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
            benchmarkAgentRevision(record.agent),
            record.environment.knowledgeBaseCommit,
            outcome.status,
            outcome.failureKind,
            outcome.reporterEnvironment?.status ?? null,
            outcome.candidate?.rule ?? outcome.candidateForReview?.rule ?? null,
            outcome.candidate?.filePath ?? outcome.candidateForReview?.placement?.filePath ?? null,
            outcome.candidate?.repositoryEdit?.kind ?? null,
            insertionEdit?.basis ?? null,
            insertionEdit === null ? null : recordedHeading(insertionEdit),
            record.human.fixCommit,
            jsonOrNull(
                record.human.rules?.map(({ rule, repositoryEdit, replacedRule }) => ({
                    rule,
                    repositoryEdit,
                    replacedRule: replacedRule ?? null,
                })),
            ),
            jsonOrNull(record.human.removedRules?.map(({ rule }) => rule)),
            record.human.rulesError,
            usage.tokens?.input ?? null,
            usage.tokens?.output ?? null,
            usage.tokens?.cacheRead ?? null,
            usage.tokens?.cacheWrite ?? null,
            usage.tokens?.reasoningTokens ?? null,
            usage.requests,
            usage.costUsd,
            ...stages,
            record.turns,
            record.human.elapsedMs,
        ]
            .map(csvField)
            .join(',');
    });
    return [[...BENCHMARK_CSV_COLUMNS].join(','), ...rows, ''].join('\r\n');
}
