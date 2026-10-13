import { describe, expect, it } from 'vitest';
import {
    buildFixTerminal,
    type FixTerminalState,
} from '../../src/orchestrator/fix-session-terminal';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import { RunMode } from '../../src/types/trace';
import type { FinishFixValidationRejection } from '../../src/types/terminal-rejection';
import type { FixOutcome } from '../../src/types/fix-outcome';

const ANALYSIS_ONLY: FixOutcome = { outcome: 'analysis_only', reasoning: 'No safer rule exists.' };

/**
 * The current-extension full-vision rejection the runtime emits when a qualifying session exists
 * but its capture was never inspected — the wall one live pass hit three times per run.
 *
 * @param sessionId - Volatile identity of the session the requirement points at.
 * @param analyzedArtifactCount - Progress counter of the requirement.
 * @param error - Model-facing prose.
 * @returns The structured rejection.
 */
function visionRejection(
    sessionId: string,
    analyzedArtifactCount: number,
    error = 'A current-first result requires complete full-page vision.',
): FinishFixValidationRejection {
    return {
        error,
        errorKind: 'current_extension_full_vision_required',
        retryable: true,
        requiredAction: 'inspect_current_extension_full_page',
        guidance: ['Capture and inspect the full page.'],
        currentVisionRequirement: {
            status: 'incomplete',
            sessionId,
            selectedSettingsProfileKind: 'reported_on_current',
            requiredArtifactCount: 4,
            analyzedArtifactCount,
            nextAction: 'capture_complete_page',
        },
    };
}

/**
 * Build the fix terminal over a host whose rejections are scripted in order.
 *
 * @param rejections - What the host answers to each successive submission.
 * @returns The terminal state under test.
 */
function scriptedTerminal(
    rejections: (FinishFixValidationRejection | undefined)[],
): FixTerminalState {
    let submission = 0;
    return buildFixTerminal(
        { validateTerminalOutcome: () => rejections[submission++] },
        new TraceRecorder({ runId: 'fix-terminal-test', issueNumber: 1, mode: RunMode.Fix }),
        () => {},
    );
}

/**
 * Submit the way the session does: execute, then feed the error text back through the observation
 * channel the runner wires from pi's `tool_execution_end` events.
 *
 * @param terminal - The terminal under test.
 * @returns The rejection text the model would read, or undefined on acceptance.
 */
async function submit(terminal: FixTerminalState): Promise<string | undefined> {
    const error = await terminal.controller.tool
        .execute(ANALYSIS_ONLY, undefined)
        .catch((caught: unknown) => caught);
    if (error instanceof Error) {
        terminal.controller.observeRejection(error.message);
        return error.message;
    }
    return undefined;
}

describe('buildFixTerminal', () => {
    it('hands the model the structured rejection, not only its prose', async () => {
        const terminal = scriptedTerminal([visionRejection('session-1', 0)]);

        const message = await submit(terminal);

        // The prose names the prerequisite in general terms; the requirement report names the
        // exact session and its next step, and the model must see both.
        expect(message).toContain('A current-first result requires complete full-page vision.');
        expect(message).toContain('Required action: inspect_current_extension_full_page.');
        expect(message).toContain('"nextAction":"capture_complete_page"');
        expect(message).toContain('"selectedSettingsProfileKind":"reported_on_current"');
    });

    it('counts a relaunch without progress as the same wall, and progress as a new one', async () => {
        const terminal = scriptedTerminal([
            visionRejection('session-1', 0),
            visionRejection('session-2', 0, 'Reworded: the capture is still uninspected.'),
            visionRejection('session-2', 2),
        ]);

        await submit(terminal);
        await submit(terminal);
        // A fresh session id and new wording with the same counters: the model repeated itself.
        expect(terminal.controller.repeatedRejections()).toBe(2);

        await submit(terminal);
        // Two more tiles analyzed: the model moved, so the streak restarted.
        expect(terminal.controller.repeatedRejections()).toBe(1);
        expect(terminal.controller.rejections()).toBe(3);
        expect(terminal.lastRejectedOutcome()).toEqual(ANALYSIS_ONLY);
    });
});
