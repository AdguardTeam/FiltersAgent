/**
 * Fix-session seal mapping: how one pi seal becomes the `FixSessionRun` result the fix core
 * consumes — the accepted terminal, the rejected-terminal downgrade that preserves the model's own
 * analysis, the routing-check halt, and the host analysis-only fallback every other ending lands
 * on. Split from `fix-session.ts` so the session wiring stays the launch procedure and this stays
 * the ending vocabulary; the typed reason itself comes from the one shared mapping in the tracer,
 * so the fix path and every other mode can never disagree about what an ending was, and every
 * ending but the routing halt writes the same `run_sealed` decision event the other modes do.
 */
import { AgentTerminationReason } from '../types/agent-termination-reason';
import type { AgentObservation } from '../types/agent-run-artifacts';
import { TraceEventType, type RunTrace } from '../types/trace';
import type { TraceRecorder } from '../tracer/trace-recorder';
import { FixOutcomeKind, type FixOutcome } from '../types/fix-outcome';
import { sealSessionTrace, sealTerminationReason } from '../tracer/session-trace';
import { RejectionCap, SealKind, type TerminalOutcome } from '../pi/seal-types';
import { AcceptedSubject, analysisOnlyFallback } from '../session/analysis-only-fallback';
import type { ObservationSink } from './fix-session-observations';

/**
 * How the run's terminal decision originated: the model's accepted finish_fix call, or a host
 * fallback synthesized because the run sealed without an accepted terminal. The wire strings are
 * the ones results written by earlier builds already carry.
 */
export const FixTerminalSource = {
    /**
     * The model submitted and the host accepted a finish_fix payload.
     */
    ModelFinishFix: 'model_finish_fix',

    /**
     * The host sealed the run without an accepted model submission (rejected cap, prose, budget,
     * provider failure, abort) and synthesized the analysis-only terminal itself.
     */
    HostFallback: 'host_fallback',
} as const;

/**
 * FixTerminalSource value.
 */
export type FixTerminalSource = (typeof FixTerminalSource)[keyof typeof FixTerminalSource];

/**
 * The `phase` markers the fix path writes beside the shared `run_sealed` seal event. Traces are
 * queried by phase, and both markers are written from two modules — the rejection one by the
 * terminal hook on every refusal and by this mapping on the cap — so they are declared once here,
 * the way `SEAL_DECISION_PHASE` is declared once in the tracer.
 */
export const FixTracePhase = {
    /**
     * The host accepted a finish_fix submission and the run seals with the model's payload.
     */
    TerminalAccepted: 'terminal_accepted',

    /**
     * A finish_fix submission was refused: one host rejection, or the cap that ended the run.
     */
    TerminalRejected: 'terminal_finalization_rejected',
} as const;

/**
 * FixTracePhase value.
 */
export type FixTracePhase = (typeof FixTracePhase)[keyof typeof FixTracePhase];

/**
 * The exact routing-check reason text — a persisted observable of the routing-check flow.
 */
export const ROUTING_CHECK_HALT_REASON =
    'Routing check: the environment selection was recorded, and the run stops before any ' +
    'investigation by design.';

/**
 * Longest model-authored reasoning carried verbatim inside a downgraded host terminal, declared
 * once so the rejected-terminal mapping cannot drift.
 */
export const MAX_PRESERVED_REJECTED_REASONING_LENGTH = 6_000;

/**
 * The run result the fix core consumes after the pi session ends.
 */
export interface FixSessionRun {
    /**
     * The accepted terminal payload, or the synthesized host analysis-only outcome.
     */
    terminal: FixOutcome;

    /**
     * Whether the terminal came from the model or was synthesized by the host.
     */
    terminalSource: FixTerminalSource;

    /**
     * Why the run ended without an accepted model decision; `undefined` for accepted and
     * rejected-terminal seals.
     */
    terminationReason: AgentTerminationReason | undefined;

    /**
     * The provider's HTTP status of the final failed request, carried from a provider-failure seal;
     * `undefined` for every other ending, and for a provider failure whose message named no
     * status.
     */
    providerFailureStatus: number | undefined;

    /**
     * True only for a rejected-terminal seal (a rejected submission was never a failed run).
     */
    terminalRejected: boolean;

    /**
     * Delivered-frontier tool observations: sanitized tool results proven to reach the model in a
     * successful later turn.
     */
    observations: AgentObservation[];

    /**
     * The sealed run trace, ready for persistTrace.
     */
    trace: RunTrace;
}

/**
 * What the seal mapping needs from the session options: the run recorder alone. The usage summary
 * is already attached by the shared launch, so this module never touches the collector.
 */
export interface FixSealTarget {
    /**
     * The run trace recorder.
     */
    recorder: TraceRecorder;
}

/**
 * The seal-time context the mapping needs beyond the pi outcome.
 */
export interface SealContext {
    /**
     * Whether the routing latch fired on an accepted selection.
     */
    routingFired: boolean;

    /**
     * The turn index whose dispatch accepted the terminal.
     */
    acceptingTurn: number;

    /**
     * The observation sink completing the delivered frontier.
     */
    sink: ObservationSink;

    /**
     * How many times pi compacted this run's context, marked on the seal like every other mode's.
     */
    compactions: number;

    /**
     * The last host-rejected outcome, when the cap sealed.
     */
    lastRejectedOutcome: FixOutcome | undefined;
}

/**
 * Reconstruct the analysis_only outcome for the rejected-terminal seal: the last rejected payload's
 * preserved reasoning, sliced to the shared bound, then the host summary.
 *
 * The model's analysis leads because the report shows only the start of the reasoning, and what the
 * run found matters to a maintainer more than why the host stopped it.
 *
 * @param hostSummary - Naming the exhausted rejection budget and the last rejection reason.
 * @param rejected - The last rejected payload.
 * @returns The composed analysis-only outcome.
 */
function rejectedTerminalOutcome(
    hostSummary: string,
    rejected: FixOutcome | undefined,
): FixOutcome {
    const reasoning =
        rejected === undefined
            ? hostSummary
            : `${rejected.reasoning.slice(0, MAX_PRESERVED_REJECTED_REASONING_LENGTH)}\n\n${hostSummary}`;
    return { outcome: FixOutcomeKind.AnalysisOnly, reasoning };
}

/**
 * Map one pi seal onto the fix run result and the sealed trace.
 *
 * @param outcome - The sealed pi outcome.
 * @param target - The run recorder.
 * @param context - The seal-time context (routing latch, sink, compaction count, rejected capture).
 * @returns The fix-run-shaped result.
 */
export function sealFixTrace(
    outcome: TerminalOutcome<FixOutcome>,
    target: FixSealTarget,
    context: SealContext,
): FixSessionRun {
    const { recorder } = target;
    if (outcome.kind === SealKind.Terminal || outcome.kind === SealKind.RejectedTerminal) {
        // Deterministic frontier completion: the accepting turn's turn_end may never arrive (the
        // runner aborts the session when the terminal settlement wins), so deliver whatever is
        // provably older than the accepting turn; the accepting turn's own results stay dropped.
        context.sink.completeBelow(context.acceptingTurn);
    }
    const observations = context.sink.delivered();
    const seal = (): RunTrace => sealSessionTrace(recorder, outcome, context.compactions);
    if (outcome.kind === SealKind.Terminal) {
        recorder.record(TraceEventType.Decision, { phase: FixTracePhase.TerminalAccepted });
        return {
            terminal: outcome.payload,
            terminalSource: FixTerminalSource.ModelFinishFix,
            terminationReason: undefined,
            providerFailureStatus: undefined,
            terminalRejected: false,
            observations,
            trace: seal(),
        };
    }
    if (outcome.kind === SealKind.RejectedTerminal) {
        const hostSummary = [
            `The run sealed after ${outcome.rejections} rejected terminal submissions:`,
            outcome.cappedBy === RejectionCap.Streak
                ? 'the model resubmitted at the same evidence progress up to the streak cap.'
                : 'rejections accumulated across differing reasons up to the total ceiling.',
            `Last rejection reason: ${outcome.lastReason}`,
        ].join(' ');
        recorder.record(TraceEventType.Error, {
            phase: FixTracePhase.TerminalRejected,
            message: hostSummary,
        });
        return {
            terminal: rejectedTerminalOutcome(hostSummary, context.lastRejectedOutcome),
            terminalSource: FixTerminalSource.HostFallback,
            terminationReason: undefined,
            providerFailureStatus: undefined,
            terminalRejected: true,
            observations,
            trace: seal(),
        };
    }
    if (context.routingFired) {
        // The routing halt is the one ending pi does not name: the latch aborts the session, and
        // the fix path relabels that abort as a caller halt, so it writes its own end reason.
        recorder.record(TraceEventType.Decision, {
            phase: AgentTerminationReason.HaltedByCaller,
        });
        return {
            terminal: {
                outcome: FixOutcomeKind.AnalysisOnly,
                reasoning: ROUTING_CHECK_HALT_REASON,
            },
            terminalSource: FixTerminalSource.HostFallback,
            terminationReason: AgentTerminationReason.HaltedByCaller,
            providerFailureStatus: undefined,
            terminalRejected: false,
            observations,
            trace: recorder.end(AgentTerminationReason.HaltedByCaller),
        };
    }
    return {
        terminal: analysisOnlyFallback(outcome, AcceptedSubject.FixOutcome),
        terminalSource: FixTerminalSource.HostFallback,
        terminationReason: sealTerminationReason(outcome),
        providerFailureStatus:
            outcome.kind === SealKind.ProviderFailure ? outcome.status : undefined,
        terminalRejected: false,
        observations,
        trace: seal(),
    };
}
