import type * as v from 'valibot';
import type { ToolExecutionMode } from '@earendil-works/pi-coding-agent';

/**
 * The session tool vocabulary: the shape of one tool advertised to the model for a whole run, the
 * result one execution returns, and the gate state a tool reports when it is currently unavailable.
 * The gate types are shared in both directions — `session-tools.ts` reads them, and
 * `registry-session-tools.ts` and `fix-session-gates.ts` in `src/orchestrator` declare the run's
 * gate states from them — so they live in this leaf rather than with either side.
 */

/**
 * One tool advertised to the model for the whole session.
 */
export interface SessionToolSpec {
    /**
     * Tool name used in the model's tool calls.
     */
    name: string;

    /**
     * Model-facing description: what the tool does and when to call it.
     */
    description: string;

    /**
     * Valibot schema of the tool's arguments. Advertised to the model as a JSON object schema
     * (converted by `tool-schema.ts`) and pre-validated by pi against that converted schema before
     * execute runs — structurally invalid calls bounce without reaching execute, and unambiguous
     * primitives are coerced. Valibot enforcement inside execute stays authoritative for the full
     * schema; each tool re-validates args against its own concrete schema. The output type is
     * unknown because heterogeneous tool argument shapes meet at this boundary.
     */
    parameters: v.GenericSchema;

    /**
     * Execute one tool call.
     *
     * @param args - Arguments that passed pi's pre-execute validation against the converted schema
     *   (possibly coerced); the Valibot re-check inside execute remains authoritative.
     * @param signal - Abort signal of the current run, when one is active.
     * @returns The tool result; throwing returns the error message to the model as a tool error.
     */
    execute: (args: unknown, signal: AbortSignal | undefined) => Promise<SessionToolResult>;

    /**
     * Pi's per-tool execution mode override. Absent, the session default applies; a tool whose
     * bookkeeping assumes one call at a time declares itself sequential here.
     */
    executionMode?: ToolExecutionMode;
}

/**
 * Result of one tool execution.
 */
export interface SessionToolResult {
    /**
     * Model-facing text content of the result.
     */
    content: string;

    /**
     * Optional structured payload kept for traces and run summaries (not sent to the model as
     * prose; pi may surface it in renderers).
     */
    details?: unknown;
}

/**
 * Why a tool is gated.
 */
export const ToolGateCause = {
    /**
     * The run has not selected an environment yet; the tool needs one.
     */
    EnvironmentPending: 'environment-pending',

    /**
     * The browser session the tool was bound to is closed.
     */
    BrowserClosed: 'browser-closed',

    /**
     * The tool was quarantined for the remainder of the run after repeated policy rejections.
     */
    Quarantined: 'quarantined',

    /**
     * The tool is not applicable to this run mode: the runner owns the step the tool represents
     * (already performed in code, or performed through a different tool), so the model can never
     * perform it and the gate never lifts.
     */
    NotApplicable: 'not-applicable',

    /**
     * An earlier step of the phase failed and its owner latched the failure: the remaining step
     * tools of this short-lived phase refuse for the rest of the session.
     */
    StepFailed: 'step-failed',

    /**
     * No active browser session offers the tool: a session offers it only when what it runs can
     * serve it, so relaunching the same kind of session does not help.
     */
    NotOffered: 'not-offered',
} as const;

/**
 * ToolGateCause value.
 */
export type ToolGateCause = (typeof ToolGateCause)[keyof typeof ToolGateCause];

/**
 * The gate state of one tool: why it is unavailable and what unblocks it.
 *
 * A session tool declares its own availability through `AdaptedToolInput.gate`, a callback the
 * adapter reads immediately before the arguments are re-checked. There is no shared, mutable gate
 * registry: whoever owns the concern that makes a tool unavailable (the registry-membership
 * history, the diagnostic quarantine, a runner-owned step) owns the latch that answers for it, so
 * one concern's state can never clear another's.
 */
export interface ToolGateState {
    /**
     * Machine-readable cause of the gate.
     */
    cause: ToolGateCause;

    /**
     * Why the tool is currently unavailable, stated for the model.
     */
    reason: string;

    /**
     * The unblocking action, stated for the model.
     */
    remedy: string;
}
