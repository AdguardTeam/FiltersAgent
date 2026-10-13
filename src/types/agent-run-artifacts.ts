import * as v from 'valibot';
import { FixOutcomeSchema } from './fix-outcome';

export const AgentObservationSchema = v.object({
    sequence: v.pipe(v.number(), v.integer(), v.minValue(0)),
    toolCallId: v.pipe(v.string(), v.minLength(1)),
    tool: v.pipe(v.string(), v.minLength(1)),
    result: v.record(v.string(), v.unknown()),
});

export const AgentRunArtifactsSchema = v.object({
    decision: v.nullable(FixOutcomeSchema),
    observations: v.array(AgentObservationSchema),
});

/**
 * Exact sanitized JSON tool result delivered in a successful later model turn.
 */
export type AgentObservation = v.InferOutput<typeof AgentObservationSchema>;

/**
 * Model-owned terminal decision and the ordered sanitized tool observations visible before it.
 */
export type AgentRunArtifacts = v.InferOutput<typeof AgentRunArtifactsSchema>;
