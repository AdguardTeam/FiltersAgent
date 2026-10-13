/**
 * Fix-session terminal tool: the typed finish_fix built from the shared terminal-tool factory with
 * the runtime's host hook adapted to the flat model-facing rejection string, each rejection
 * recorded to the trace, and the accepting turn index captured for the seal-time observation
 * completion. Split from fix-session.ts so every module stays under the repo's 500-line ceiling; it
 * imports nothing from there, so the fix session and its terminal stay an acyclic pair.
 */
import type { FinishFixValidationRejection } from '../types/terminal-rejection';
import { TraceEventType } from '../types/trace';
import type { TraceRecorder } from '../tracer/trace-recorder';
import { FixOutcomeSchema, type FixOutcome } from '../types/fix-outcome';
import { TOOL_GUIDANCE } from '../agent/tool-catalog';
import { ToolName } from '../agent/tool-names';
import { buildTerminalTool, type TerminalToolController } from '../pi/terminal-tool';
import type { SessionToolResult } from '../pi/session-tool-types';
import { FixTracePhase } from './fix-session-seal';
import { terminalRejectionFingerprint } from './terminal-rejection-fingerprint';

/**
 * The runtime slice the terminal hook consumes.
 */
export interface FixTerminalHost {
    /**
     * Host-side terminal validation: a structured rejection, or `undefined` to accept.
     */
    validateTerminalOutcome(outcome: FixOutcome): FinishFixValidationRejection | undefined;
}

/**
 * Compose one flat model-facing rejection reason from a structured terminal rejection.
 *
 * The vocabulary is large (issue_screenshot_analysis_required, report_only_full_vision_required,
 * candidate_visual_confirmation_required, ...), so the composer is generic: the error line plus the
 * required action and guidance when present, followed by every structured field as JSON. The
 * structured tail is not decoration: a rejection whose prose names the wrong prerequisite can carry
 * the right one only in `currentVisionRequirement.nextAction`, and dropping the tail seals runs.
 *
 * @param rejection - The structured host rejection.
 * @returns The flat reason string shown to the model.
 */
function formatTerminalRejection(rejection: FinishFixValidationRejection): string {
    // Destructuring is what keeps the prose and the tail complementary: a field rendered as prose
    // is taken out of the rest, and every other field — errorKind, requirement reports, observed
    // profile kinds, symptom presence — reaches the model verbatim in the tail.
    const { error, retryable, requiredAction, guidance, ...details } = rejection;
    const parts = [error];
    if (retryable === false) {
        parts.push('This rejection is not retryable.');
    }
    if (typeof requiredAction === 'string') {
        parts.push(`Required action: ${requiredAction}.`);
    }
    if (typeof guidance === 'string') {
        parts.push(guidance);
    } else if (Array.isArray(guidance)) {
        parts.push(guidance.join(' '));
    }
    parts.push(`Details: ${JSON.stringify(details)}`);
    return parts.join(' ');
}

/**
 * The built fix terminal and the rejected-capture accessors.
 */
export interface FixTerminalState {
    /**
     * The session runner's terminal controller.
     */
    controller: TerminalToolController<FixOutcome>;

    /**
     * The last host-rejected submission, when the cap sealed.
     */
    lastRejectedOutcome: () => FixOutcome | undefined;
}

/**
 * Build the fix terminal tool with the host hook adapter and the accepting-turn capture.
 *
 * @param host - The runtime slice validating submissions.
 * @param recorder - The run trace recorder.
 * @param onAccepted - Fired when a submission passes host validation.
 * @returns The controller plus the last rejected outcome accessor.
 */
export function buildFixTerminal(
    host: FixTerminalHost,
    recorder: TraceRecorder,
    onAccepted: () => void,
): FixTerminalState {
    let lastRejectedOutcome: FixOutcome | undefined;
    let lastFingerprint: string | undefined;
    const inner = buildTerminalTool<FixOutcome>({
        name: ToolName.FinishFix,
        description: TOOL_GUIDANCE[ToolName.FinishFix]!,
        schema: FixOutcomeSchema,
        validateHost: (outcome) => {
            const rejection = host.validateTerminalOutcome(outcome);
            if (rejection === undefined) {
                return undefined;
            }
            lastRejectedOutcome = outcome;
            const reason = formatTerminalRejection(rejection);
            const fingerprint = terminalRejectionFingerprint(rejection);
            // The trace carries what the streak compared, so a sealed run reads as "three
            // rejections at the same evidence progress" rather than three unrelated events.
            recorder.record(TraceEventType.Error, {
                phase: FixTracePhase.TerminalRejected,
                message: reason,
                errorKind: rejection.errorKind,
                fingerprint,
                evidenceProgressed:
                    lastFingerprint !== undefined && lastFingerprint !== fingerprint,
            });
            lastFingerprint = fingerprint;
            return { reason, fingerprint };
        },
    });
    const captured: TerminalToolController<FixOutcome> = {
        ...inner,
        tool: {
            ...inner.tool,
            execute: async (args, signal): Promise<SessionToolResult> => {
                const result = await inner.tool.execute(args, signal);
                onAccepted();
                return result;
            },
        },
    };
    return {
        controller: captured,
        lastRejectedOutcome: () => lastRejectedOutcome,
    };
}
