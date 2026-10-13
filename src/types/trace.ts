import * as v from 'valibot';
import { RunUsageSummarySchema } from './usage-summary';

/**
 * Which investigation entry point produced a run trace.
 */
export const RunMode = {
    /**
     * Browser-first fix investigation that may propose a patch.
     */
    Fix: 'fix',
} as const;

/**
 * Every RunMode value, for schemas and exhaustive listings.
 */
export const RUN_MODE_VALUES = Object.values(RunMode);

/**
 * RunMode value.
 */
export type RunMode = (typeof RunMode)[keyof typeof RunMode];

export const RunModeSchema = v.picklist(RUN_MODE_VALUES);

/**
 * Kind of one recorded event in a run trace.
 */
export const TraceEventType = {
    /**
     * The run began.
     */
    RunStart: 'run_start',

    /**
     * A request was sent to the LLM.
     */
    LlmRequest: 'llm_request',

    /**
     * A response was received from the LLM.
     */
    LlmResponse: 'llm_response',

    /**
     * An agent tool call was issued.
     */
    ToolCall: 'tool_call',

    /**
     * An agent tool call returned its result.
     */
    ToolResult: 'tool_result',

    /**
     * The run recorded a decision point.
     */
    Decision: 'decision',

    /**
     * An artifact was written to disk.
     */
    ArtifactWritten: 'artifact_written',

    /**
     * A step was retried after a failure.
     */
    Retry: 'retry',

    /**
     * The run recorded an error.
     */
    Error: 'error',

    /**
     * A validation phase began.
     */
    PhaseStart: 'phase_start',

    /**
     * A validation phase ended.
     */
    PhaseEnd: 'phase_end',

    /**
     * The run ended.
     */
    RunEnd: 'run_end',
} as const;

/**
 * Every TraceEventType value, for schemas and exhaustive listings.
 */
export const TRACE_EVENT_TYPE_VALUES = Object.values(TraceEventType);

/**
 * TraceEventType value.
 */
export type TraceEventType = (typeof TraceEventType)[keyof typeof TraceEventType];

export const TraceEventTypeSchema = v.picklist(TRACE_EVENT_TYPE_VALUES);

export const TraceEventSchema = v.object({
    seq: v.pipe(v.number(), v.integer(), v.minValue(0)),
    timestamp: v.pipe(v.string(), v.isoTimestamp()),
    type: TraceEventTypeSchema,
    payload: v.record(v.string(), v.unknown()),
});

export const ArtifactRefSchema = v.object({
    id: v.string(),
    path: v.string(),
    type: v.string(),
    bytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export const RunTraceSchema = v.object({
    runId: v.string(),
    issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
    mode: RunModeSchema,
    startedAt: v.pipe(v.string(), v.isoTimestamp()),
    endedAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
    outcome: v.optional(v.string()),
    events: v.array(TraceEventSchema),
    artifacts: v.array(ArtifactRefSchema),
    tokenTotals: v.object({
        promptTokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
        completionTokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
        totalTokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
    /**
     * The run's pi-sourced Usage Summary, set by pi-driven wirings at seal time. Absent when no
     * pi-driven wiring sealed the run; carries no secrets (model ids, counts, USD only), so it
     * bypasses payload redaction.
     */
    usage: v.optional(RunUsageSummarySchema),
});

export type TraceEvent = v.InferOutput<typeof TraceEventSchema>;
export type ArtifactRef = v.InferOutput<typeof ArtifactRefSchema>;
export type RunTrace = v.InferOutput<typeof RunTraceSchema>;
