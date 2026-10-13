/**
 * Fix-session delivered-frontier observations: the buffer of sanitized tool results stamped with
 * the pi turn that produced them, drained only when a LATER turn succeeds — the
 * flush-after-successful-response rule of the agent-observations contract — plus the deterministic
 * seal completion for the accepting terminal turn. Split from fix-session.ts so every module stays
 * under the repo's 500-line ceiling.
 */
import type { AgentObservation } from '../types/agent-run-artifacts';
import type { SessionTurnObservation } from '../pi/session-observations';
import { TurnStopReason } from '../pi/stop-reason';

/**
 * One buffered tool result awaiting its delivery frontier.
 */
interface PendingObservation {
    /**
     * The tool that produced the result.
     */
    tool: string;

    /**
     * The redacted structured result.
     */
    result: Record<string, unknown>;

    /**
     * Pi turn index that produced the result.
     */
    turnIndex: number;
}

/**
 * The delivered-frontier observation sink: buffers every dispatched tool result stamped with its
 * producing turn, drains it on successful later turns, and completes deterministically at seal.
 */
export interface ObservationSink {
    /**
     * Buffer one result for delivery.
     *
     * @param tool - The tool name.
     * @param result - The redacted structured result.
     */
    collect: (tool: string, result: Record<string, unknown>) => void;

    /**
     * The turn index whose turn_end events have been observed so far — the producing turn of any
     * dispatch executing right now.
     *
     * @returns The current turn index.
     */
    currentTurn: () => number;

    /**
     * Drain the frontier on a successful turn_end.
     *
     * @param turn - The completed turn observation.
     */
    onTurnEnd: (turn: SessionTurnObservation) => void;

    /**
     * Complete the frontier at seal: deliver everything from turns strictly below the accepting
     * turn, keeping the accepting turn's own results dropped.
     *
     * @param acceptingTurn - The turn whose dispatch accepted the terminal.
     */
    completeBelow: (acceptingTurn: number) => void;

    /**
     * @returns The delivered observations, in dispatch order.
     */
    delivered: () => AgentObservation[];
}

/**
 * Create the observation sink for one run.
 *
 * @returns The sink.
 */
export function createObservationSink(): ObservationSink {
    const pending: PendingObservation[] = [];
    const delivered: AgentObservation[] = [];
    let turnsEnded = 0;
    const drainBelow = (limit: number): void => {
        if (limit < 0) {
            return;
        }
        const deliverable = pending.filter((entry) => entry.turnIndex < limit);
        if (deliverable.length === 0) {
            return;
        }
        for (const entry of deliverable) {
            const sequence = delivered.length;
            delivered.push({
                sequence,
                toolCallId: `obs-${sequence}`,
                tool: entry.tool,
                result: entry.result,
            });
        }
        pending.splice(0, deliverable.length);
    };
    return {
        collect: (tool, result) => {
            pending.push({ tool, result, turnIndex: turnsEnded });
        },
        currentTurn: () => turnsEnded,
        onTurnEnd: (turn) => {
            turnsEnded = Math.max(turnsEnded, turn.index + 1);
            if (
                turn.stopReason === TurnStopReason.Stop ||
                turn.stopReason === TurnStopReason.ToolUse
            ) {
                drainBelow(turn.index);
            }
        },
        completeBelow: (acceptingTurn) => drainBelow(acceptingTurn),
        delivered: () => [...delivered],
    };
}
