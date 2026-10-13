import {
    TraceEventType,
    type ArtifactRef,
    type RunMode,
    type RunTrace,
    type TraceEvent,
} from '../types/trace';
import type { RunUsageSummary } from '../types/usage-summary';

/**
 * Options for constructing a {@link TraceRecorder}.
 */
export interface TraceRecorderOptions {
    /**
     * Unique identifier for this run.
     */
    runId: string;

    /**
     * The issue number the run operates on.
     */
    issueNumber: number;

    /**
     * The run mode (fix / analyze / replay).
     */
    mode: RunMode;

    /**
     * Injectable clock for deterministic tests. Defaults to `new Date().toISOString()`.
     */
    now?: () => string;

    /**
     * Optional payload redaction function applied before persisting every trace event.
     *
     * When set, every payload passed to {@link record} is passed through this function and the
     * returned (redacted) value is stored. When `undefined` (the default), payloads are stored
     * as-is — preserving the existing behaviour for callers that do not require redaction.
     */
    redact?: (payload: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Mutable token-accumulation totals tracked across LLM turns.
 */
interface TokenTotals {
    /**
     * Running sum of prompt tokens across all LLM responses.
     */
    promptTokens: number;

    /**
     * Running sum of completion tokens across all LLM responses.
     */
    completionTokens: number;

    /**
     * Recomputed sum of prompt + completion tokens.
     */
    totalTokens: number;
}

/**
 * Payload of an LLM response, optionally carrying token-usage counts.
 */
export interface LlmResponsePayload {
    /**
     * Arbitrary response fields (model, content, etc.).
     */
    [key: string]: unknown;

    /**
     * Prompt token count reported by the provider, if present.
     */
    promptTokens?: number;

    /**
     * Completion token count reported by the provider, if present.
     */
    completionTokens?: number;
}

/**
 * Append-only recorder for a single agent run.
 *
 * Captures ordered `TraceEvent`s, registered artifacts, and accumulated token totals, then produces
 * a `RunTrace` object satisfying the shared schema.
 */
export class TraceRecorder {
    private readonly runId: string;
    private readonly issueNumber: number;
    private readonly mode: RunMode;
    private readonly now: () => string;
    private readonly redact?: (payload: Record<string, unknown>) => Record<string, unknown>;
    private readonly startedAt: string;
    private readonly events: TraceEvent[] = [];
    private readonly artifacts: ArtifactRef[] = [];
    private readonly tokenTotals: TokenTotals = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
    };
    private endedAt?: string;
    private outcome?: string;
    private usageSummary?: RunUsageSummary;

    constructor(options: TraceRecorderOptions) {
        this.runId = options.runId;
        this.issueNumber = options.issueNumber;
        this.mode = options.mode;
        this.now = options.now ?? (() => new Date().toISOString());
        this.redact = options.redact;
        this.record(TraceEventType.RunStart, {
            runId: this.runId,
            issueNumber: this.issueNumber,
            mode: this.mode,
        });
        this.startedAt = this.events[0].timestamp;
    }

    /**
     * Append a trace event with an auto-incrementing seq and the current timestamp.
     *
     * @param type - The trace event type.
     * @param payload - Optional payload record; defaults to an empty object.
     * @returns The appended trace event.
     */
    record(type: TraceEventType, payload: Record<string, unknown> = {}): TraceEvent {
        const safePayload = this.redact ? this.redact(payload) : payload;
        const event: TraceEvent = {
            seq: this.events.length,
            timestamp: this.now(),
            type,
            payload: safePayload,
        };
        this.events.push(event);
        return event;
    }

    /**
     * Record a `tool_call` / `tool_result` pair and return both events.
     *
     * @param tool - The tool name that was invoked.
     * @param args - The arguments passed to the tool.
     * @param result - The raw result returned by the tool.
     * @returns A tuple of `[callEvent, resultEvent]`.
     */
    recordToolCall(
        tool: string,
        args: Record<string, unknown>,
        result: Record<string, unknown>,
    ): [TraceEvent, TraceEvent] {
        const callEvent = this.record(TraceEventType.ToolCall, { tool, args });
        const resultEvent = this.record(TraceEventType.ToolResult, { tool, result });
        return [callEvent, resultEvent];
    }

    /**
     * Record an `llm_request` / `llm_response` pair and accumulate token totals.
     *
     * If the response payload carries finite `promptTokens` / `completionTokens` numbers, they are
     * added to the running totals and `totalTokens` is recomputed.
     *
     * @param request - The request payload sent to the LLM.
     * @param response - The response payload, optionally carrying token counts.
     * @returns A tuple of `[requestEvent, responseEvent]`.
     */
    recordLlmTurn(
        request: Record<string, unknown>,
        response: LlmResponsePayload,
    ): [TraceEvent, TraceEvent] {
        const reqEvent = this.record(TraceEventType.LlmRequest, request);
        const resEvent = this.record(TraceEventType.LlmResponse, response);

        const pt = response.promptTokens;
        const ct = response.completionTokens;
        if (typeof pt === 'number' && Number.isFinite(pt)) {
            this.tokenTotals.promptTokens += pt;
        }
        if (typeof ct === 'number' && Number.isFinite(ct)) {
            this.tokenTotals.completionTokens += ct;
        }
        this.tokenTotals.totalTokens =
            this.tokenTotals.promptTokens + this.tokenTotals.completionTokens;

        return [reqEvent, resEvent];
    }

    /**
     * Register an artifact (e.g. a written file or screenshot) referenced by the run.
     *
     * @param ref - The artifact reference to register.
     */
    addArtifact(ref: ArtifactRef): void {
        this.artifacts.push(ref);
    }

    /**
     * Return a snapshot of the artifacts registered so far via {@link addArtifact}.
     *
     * The returned array is a shallow copy, so callers may freely filter/map it without affecting
     * the recorder's internal accumulator. Used by the `fix` runner to extract screenshot/HAR/DOM
     * paths for the evidence pack.
     *
     * @returns A copy of the registered `ArtifactRef[]` (each `{ id, path, type, bytes }`).
     */
    getArtifacts(): ArtifactRef[] {
        return [...this.artifacts];
    }

    /**
     * Record the `run_end` event, set `endedAt` + `outcome`, and return the full trace.
     *
     * @param outcome - The run outcome label (e.g. `merged-fix`).
     * @returns The full trace object satisfying `RunTraceSchema`.
     */
    end(outcome: string): RunTrace {
        const endEvent = this.record(TraceEventType.RunEnd, { outcome });
        this.endedAt = endEvent.timestamp;
        this.outcome = outcome;
        return this.toJSON();
    }

    /**
     * Attach the run's Usage Summary so it lands in the sealed trace. Call before `end()`.
     *
     * @param summary - The collector-rendered summary.
     */
    setUsageSummary(summary: RunUsageSummary): void {
        this.usageSummary = summary;
    }

    /**
     * Return the accumulated trace as a plain object satisfying `RunTraceSchema`.
     *
     * @returns The current run trace snapshot.
     */
    toJSON(): RunTrace {
        const trace: RunTrace = {
            runId: this.runId,
            issueNumber: this.issueNumber,
            mode: this.mode,
            startedAt: this.startedAt,
            events: [...this.events],
            artifacts: [...this.artifacts],
            tokenTotals: { ...this.tokenTotals },
            ...(this.usageSummary !== undefined ? { usage: this.usageSummary } : {}),
        };
        if (this.endedAt !== undefined) {
            trace.endedAt = this.endedAt;
        }
        if (this.outcome !== undefined) {
            trace.outcome = this.outcome;
        }
        return trace;
    }
}
