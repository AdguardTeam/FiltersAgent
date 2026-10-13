import * as v from 'valibot';
import { COST_COVERAGE_VALUES, USAGE_COMPLETENESS_VALUES } from './usage-status';
import { UnsupportedArtifactVersionError, readVersionedDocument } from './versioned-document';

/**
 * Persisted usage accounting shared by the run trace, the fix-run artifact, and cross-run benchmark
 * comparisons: per-model pricing and the Usage Summary the collector renders. The two honesty
 * statuses it carries (`usageCompleteness`, `costCoverage`) are declared in `usage-status.ts` with
 * every other usage-accounting vocabulary; this module only imports them, so `src/types/trace.ts`
 * can carry the optional `usage` block without an inverted import direction.
 *
 * The artifact this module describes (`llm-usage-summary.json` beside a locked run, and its
 * redacted publication copy `llm-usage.json`) exists on disk in two mutually unreadable shapes, and
 * one reader dispatches between them. Only the pi-sourced shape is declared in full: the
 * ledger-shaped aggregate that earlier builds wrote beside a per-attempt `llm-usage.jsonl` ledger
 * has no consumer that reads a field of one, so it is recognized by its version tag alone.
 */

/**
 * Persisted `schemaVersion` of the run usage-summary artifact.
 *
 * Each shape owns a number for the whole life of the artifact: a reader must be able to decide from
 * the file alone whether it can interpret the document, and two incompatible shapes sharing one
 * number take that decision away from it: a pi-shaped file tagged 1 would make a build that reads
 * the ledger shape accept a file whose every field it would then misread.
 */
export const UsageSummaryVersion = {
    /**
     * The ledger-shaped aggregate earlier builds wrote: per-component and per-model attempt
     * counters beside the `llm-usage.jsonl` attempt ledger. Only read, never written.
     */
    Ledger: 1,

    /**
     * The pi-sourced Usage Summary defined below: per-source and per-model completion counters
     * taken from pi's own statistics, with no attempt ledger beside it.
     */
    Run: 2,
} as const;

/**
 * Every persisted usage-summary version, for schemas, diagnostics, and exhaustive listings.
 */
export const USAGE_SUMMARY_VERSION_VALUES = Object.values(UsageSummaryVersion);

/**
 * UsageSummaryVersion value.
 */
export type UsageSummaryVersion = (typeof UsageSummaryVersion)[keyof typeof UsageSummaryVersion];

/**
 * Frozen per-million-token prices for one model.
 *
 * Field names are byte-identical to the keys of the tracked pricing document, so that document
 * stays valid as written.
 */
export const UsageModelRatesSchema = v.object({
    inputUsdPerMillionTokens: v.pipe(v.number(), v.finite(), v.minValue(0)),
    outputUsdPerMillionTokens: v.pipe(v.number(), v.finite(), v.minValue(0)),
    cachedInputUsdPerMillionTokens: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
    cacheWriteUsdPerMillionTokens: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
    reasoningUsdPerMillionTokens: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
});

/**
 * Model-keyed price table captured with one run.
 */
export const UsageRatesTableSchema = v.record(
    v.pipe(v.string(), v.minLength(1)),
    UsageModelRatesSchema,
);

/**
 * Token totals summed over REPORTED completions only, with pi semantics: `input` excludes cache
 * reads/writes and `reasoningTokens` is a subset of `output`.
 */
const TokenTotalsSchema = v.object({
    input: v.pipe(v.number(), v.integer(), v.minValue(0)),
    output: v.pipe(v.number(), v.integer(), v.minValue(0)),
    cacheRead: v.pipe(v.number(), v.integer(), v.minValue(0)),
    cacheWrite: v.pipe(v.number(), v.integer(), v.minValue(0)),
    reasoningTokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

/**
 * Aggregate of one usage source (the loop session or the metered single-shot calls).
 */
const SourceAggregateSchema = v.object({
    /**
     * Logical requests reported for this source.
     */
    requests: v.pipe(v.number(), v.integer(), v.minValue(0)),

    /**
     * Provider replies counted for this source.
     */
    completions: v.pipe(v.number(), v.integer(), v.minValue(0)),

    /**
     * Token totals over reported completions.
     */
    tokens: TokenTotalsSchema,

    /**
     * Priced USD cost, or null when nothing was priceable.
     */
    costUsd: v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0))),
});

/**
 * The persisted Usage Summary entity: token and cost accounting sourced from pi's per-message
 * usage, priced from the configured per-model rates, produced once per run by the
 * `RunUsageCollector`.
 */
export const RunUsageSummarySchema = v.object({
    schemaVersion: v.literal(UsageSummaryVersion.Run),
    /**
     * Logical units reported: one per runner session plus one per single-shot call, failed calls
     * included.
     */
    requests: v.pipe(v.number(), v.integer(), v.minValue(0)),
    /**
     * Provider replies counted (loop assistant replies with a completion stop reason plus
     * single-shot attempts that returned).
     */
    completions: v.pipe(v.number(), v.integer(), v.minValue(0)),
    /**
     * Completions whose stream carried no usage chunk.
     */
    unreportedCompletions: v.pipe(v.number(), v.integer(), v.minValue(0)),
    /**
     * Sum of (completions − 1) over single-shot calls — the bounded repair attempts this stack
     * owns; pi-internal transport retries are unobservable.
     */
    repairAttempts: v.pipe(v.number(), v.integer(), v.minValue(0)),
    /**
     * Summed LLM-engaged wall time of all reports.
     */
    durationMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
    /**
     * Token totals over reported completions, pi semantics.
     */
    tokens: TokenTotalsSchema,
    /**
     * Priced USD cost, or null when nothing was reported or nothing could be priced.
     */
    costUsd: v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0))),
    /**
     * Completeness of the reported usage chunks.
     */
    usageCompleteness: v.picklist(USAGE_COMPLETENESS_VALUES),
    /**
     * How fully the run cost could be priced from the configured rates.
     */
    costCoverage: v.picklist(COST_COVERAGE_VALUES),
    /**
     * Per-model breakdown sorted by model id.
     */
    byModel: v.array(
        v.object({
            model: v.pipe(v.string(), v.minLength(1)),
            completions: v.pipe(v.number(), v.integer(), v.minValue(0)),
            tokens: TokenTotalsSchema,
            costUsd: v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0))),
        }),
    ),
    /**
     * Per-source aggregates: the loop session and the metered single-shot calls. Strict: the
     * collector is the only producer and it never writes a third source, so a summary carrying an
     * extra source (e.g. evaluator telemetry) fails schema parse at every read boundary.
     */
    bySource: v.strictObject({
        loop: SourceAggregateSchema,
        singleShot: SourceAggregateSchema,
    }),
    /**
     * The configured rates used, persisted for audit.
     */
    rates: UsageRatesTableSchema,
});

/**
 * Frozen per-million-token prices for one model.
 */
export type UsageModelRates = v.InferOutput<typeof UsageModelRatesSchema>;

/**
 * Model-keyed price table captured with one run.
 */
export type UsageRatesTable = v.InferOutput<typeof UsageRatesTableSchema>;

/**
 * Token totals of one report, aggregated over reported completions.
 */
export type TokenTotals = v.InferOutput<typeof TokenTotalsSchema>;

/**
 * Sum one report's token totals, cache INCLUSIVE.
 *
 * The one place this sum is spelled out. `input` is cache-exclusive under pi and `reasoningTokens`
 * is already a subset of `output`, so the total is exactly the four disjoint counters and nothing
 * else — a fifth term or a dropped cache term produces a number that still looks plausible in a
 * persisted summary and silently misstates every cross-run cost and cache comparison built on it.
 *
 * @param tokens - Token totals of one report, source aggregate, or per-model entry.
 * @returns Cache-inclusive total token count.
 */
export function totalTokens(tokens: TokenTotals): number {
    return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

/**
 * Aggregate of one usage source.
 */
export type SourceAggregate = v.InferOutput<typeof SourceAggregateSchema>;

/**
 * The persisted Usage Summary entity.
 */
export type RunUsageSummary = v.InferOutput<typeof RunUsageSummarySchema>;

/**
 * One persisted usage summary, tagged by the version it was written in.
 */
export type PersistedUsageSummary =
    | {
          /**
           * Marks the ledger-shaped document, whose fields count transport attempts. Carries no
           * payload: no consumer reads the shape, so the tag is the whole answer a reader of one
           * can give.
           */
          version: typeof UsageSummaryVersion.Ledger;
      }
    | {
          /**
           * Marks the pi-shaped document, whose fields count provider completions.
           */
          version: typeof UsageSummaryVersion.Run;

          /**
           * The parsed pi-sourced Usage Summary.
           */
          run: RunUsageSummary;
      };

/**
 * Artifact name opening every rejection of a usage summary this build will not interpret.
 */
const USAGE_SUMMARY_ARTIFACT = 'Persisted usage summary';

/**
 * The ledger-shaped summary as this build reads it: its version tag, and nothing else.
 *
 * Its counters are attempt-shaped and cache-inclusive, and nothing in this build reads a field of
 * one — the manifest verifier only has to establish which shape a locked run's summary belongs to,
 * and the bytes themselves are proven by the digest its locking manifest bound them with.
 * Re-declaring the eighteen unread counters would be a second definition of a document nothing can
 * produce and nothing interprets.
 */
const LedgerUsageSummaryEnvelopeSchema = v.object({
    schemaVersion: v.literal(UsageSummaryVersion.Ledger),
});

/**
 * Recognize one persisted usage summary by the version it declares, parsing whatever that version
 * still has a reader for.
 *
 * @param value - Decoded JSON read from a usage-summary artifact.
 * @returns The summary tagged with its version, carrying the parsed document where one is read.
 * @throws UnsupportedArtifactVersionError When the document declares no known version.
 */
export function readPersistedUsageSummary(value: unknown): PersistedUsageSummary {
    const document = readVersionedDocument(value, {
        artifact: USAGE_SUMMARY_ARTIFACT,
        schemas: {
            [UsageSummaryVersion.Ledger]: LedgerUsageSummaryEnvelopeSchema,
            [UsageSummaryVersion.Run]: RunUsageSummarySchema,
        },
    });
    return document.schemaVersion === UsageSummaryVersion.Ledger
        ? { version: UsageSummaryVersion.Ledger }
        : { version: UsageSummaryVersion.Run, run: document };
}

/**
 * Parse one persisted usage summary that a pi-shaped consumer must be able to interpret.
 *
 * A ledger-shaped document is rejected rather than converted: its counters are attempt-shaped and
 * cache-inclusive, so any mapping onto the pi shape would invent per-source splits and reported
 * completion counts the ledger never recorded.
 *
 * @param value - Decoded JSON read from a usage-summary artifact.
 * @returns The parsed pi-sourced Usage Summary.
 * @throws UnsupportedArtifactVersionError When the document is not a pi-shaped summary.
 */
export function readRunUsageSummary(value: unknown): RunUsageSummary {
    const persisted = readPersistedUsageSummary(value);
    if (persisted.version !== UsageSummaryVersion.Run) {
        throw new UnsupportedArtifactVersionError(USAGE_SUMMARY_ARTIFACT, persisted.version, [
            UsageSummaryVersion.Run,
        ]);
    }
    return persisted.run;
}
