import type { Usage } from '@earendil-works/pi-ai';
import type { Logger } from '../logger/logger';
/**
 * The usage-reporting vocabulary every telemetry producer in `src/pi` shares: the model-attributed
 * completion usage, the per-segment report, the pi-to-app mapping (the ONE implementation of the
 * no-usage-chunk rule), and the delivery path every producer records through. Leaf module — it
 * knows nothing about sessions, pricing or the Usage Summary, so the session runner, the
 * single-shot boundary and the collector can all depend on it without depending on each other.
 *
 * Recording is observational and must never break the observed call, but "non-fatal" is not
 * "invisible": `recordUsageReport` is the one delivery path, and a sink that throws is logged with
 * the caught error and its observer context, so a lost segment leaves evidence instead of silence.
 */

/**
 * Which telemetry observer a diagnostic belongs to, so one grep over a run log finds every gap.
 */
export const TelemetryObserver = {
    /**
     * The session runner's per-turn observer (trace recording).
     */
    TurnEnd: 'onTurnEnd',

    /**
     * The session runner's per-compaction observer (trace recording of pi's context rewrites).
     */
    Compaction: 'onCompaction',

    /**
     * The session runner's per-bounce observer (trace recording of tool calls pi refused before
     * `execute`).
     */
    ToolBounce: 'onToolBounce',

    /**
     * The session runner's once-per-run usage report.
     */
    SessionUsage: 'onSessionUsage',

    /**
     * The metered single-shot client's per-call usage report.
     */
    SingleShotUsage: 'singleShotUsage',
} as const;

/**
 * TelemetryObserver value.
 */
export type TelemetryObserver = (typeof TelemetryObserver)[keyof typeof TelemetryObserver];

/**
 * Normalized usage of ONE provider completion, in this layer's own vocabulary — the single shape
 * every telemetry producer in `src/pi` reports, so a turn observation, a single-shot result and the
 * run's usage report can never disagree about what the same pi `Usage` said. There is exactly one
 * of these per provider reply, produced once by {@link toCompletionUsage}: the four shapes that
 * preceded it needed an `attribute`/`toCompletion` layer to convert between them, and the trace
 * ended up recording zeros as reported for a turn the usage report marked unreported.
 *
 * `reported` carries the no-usage-chunk signal explicitly and every count is zeroed when it is
 * false, because a completion whose telemetry never arrived is stated as such rather than rendered
 * as a free request.
 */
export interface CompletionUsage {
    /**
     * The resolved call model the completion ran against (the pricing attribution). It is the id
     * the run ASKED for, never a gateway's echoed build name, because the price table is keyed by
     * the former.
     */
    model: string;

    /**
     * Whether the provider's stream carried a usage chunk.
     */
    reported: boolean;

    /**
     * Non-cache input tokens (pi semantics: cache reads/writes are excluded).
     */
    input: number;

    /**
     * Output tokens; reasoning is a subset.
     */
    output: number;

    /**
     * Cache-read tokens.
     */
    cacheRead: number;

    /**
     * Cache-write tokens.
     */
    cacheWrite: number;

    /**
     * Reasoning subset of output, when reported.
     */
    reasoningTokens: number;
}

/**
 * Pi-free usage report of one logical LLM-engaged segment: a runner session (from `onSessionUsage`)
 * or one single-shot call (from the metered wrapper; each attempt is one completion, so a repaired
 * call prices both).
 */
export interface UsageReport {
    /**
     * Completions of this report, in order; empty when the segment produced none.
     */
    completions: CompletionUsage[];

    /**
     * Summed wall time of the segment in milliseconds.
     */
    durationMs: number;
}

/**
 * Map one pi message usage onto the pi-free normalized shape, attributed to its model. The ONE
 * implementation of the no-usage-chunk rule and the only producer of a {@link CompletionUsage}: the
 * session path, the turn observation and the single-shot boundary all go through it, so they can
 * never drift apart.
 *
 * `reported` carries the exact no-usage-chunk signal: pi's pinned openai-completions adapter
 * initializes the streamed output message with a zeroed usage object that has NO `reasoning` key
 * and always sets `reasoning` (possibly 0) when a usage chunk arrives, so `usage.reasoning ===
 * undefined` ⟺ the provider sent no usage chunk.
 *
 * @param model - The resolved call model id (the pricing attribution).
 * @param usage - The pi-reported usage object.
 * @returns The normalized completion usage; classified unreported and zeroed when no usage chunk
 *   arrived.
 */
export function toCompletionUsage(model: string, usage: Usage): CompletionUsage {
    const reported = usage.reasoning !== undefined;
    return {
        model,
        reported,
        input: reported ? usage.input : 0,
        output: reported ? usage.output : 0,
        cacheRead: reported ? usage.cacheRead : 0,
        cacheWrite: reported ? usage.cacheWrite : 0,
        reasoningTokens: reported ? (usage.reasoning ?? 0) : 0,
    };
}

/**
 * Deliver one usage report to a telemetry sink without ever letting the sink break its caller, and
 * without ever losing the failure silently.
 *
 * A throwing sink (a broken collector, a redaction failure, a recorder that lost its file) is
 * logged with the caught error and the observer context: the segment is then genuinely missing from
 * the run summary, and the log line is what says so. The delivery is NOT retried in a degraded
 * shape — every sink this receives is an array push into the run's collector, so a second call
 * would fail exactly as the first did.
 *
 * @param sink - The recording function (the collector method, or the runner's usage observer).
 * @param report - The report to record.
 * @param observer - Which observer this delivery belongs to, for the log line.
 * @param logger - Diagnostics sink.
 */
export function recordUsageReport(
    sink: (report: UsageReport) => void,
    report: UsageReport,
    observer: TelemetryObserver,
    logger: Logger,
): void {
    try {
        sink(report);
    } catch (error) {
        logger.error(
            { err: error, observer, completions: report.completions.length },
            'usage observer failed; this segment is missing from the run usage summary',
        );
    }
}
