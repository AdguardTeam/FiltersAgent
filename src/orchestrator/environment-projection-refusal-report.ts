/**
 * Reporting a refused environment projection where a post-mortem looks first: the diagnostic log
 * and the run's trace.
 */
import type { ProvisionalEnvironmentDisposition } from '../environment/filtering-environment';
import { recordPreflightDiagnostic } from '../local/preflight-diagnostic-log';
import type { TraceRecorder } from '../tracer/trace-recorder';
import type { FixRunResult } from '../types/fix-run-result';
import type { EnvironmentProjectionRefusal } from '../types/environment-projection-refusal';
import { TraceEventType } from '../types/trace';
import { persistTrace } from './pre-agent-artifacts';

/**
 * `phase` of the decision event that records a refused projection. A post-mortem looks the refusal
 * up in the trace by this marker, so it is declared once here instead of being respelled at the
 * record call.
 */
export const ENVIRONMENT_PROJECTION_DECISION_PHASE = 'environment_projection';

/**
 * The run a refused projection belongs to.
 */
export interface ProjectionRefusalRun {
    /**
     * Recorder of the run's trace, already sealed and written before cleanup.
     */
    recorder: TraceRecorder;

    /**
     * Directory the trace was written to.
     */
    artifactsDir: string;

    /**
     * The result the canonical execution was asked to back.
     */
    provisionalResult: FixRunResult;

    /**
     * The decision the canonical execution was asked to back.
     */
    disposition: ProvisionalEnvironmentDisposition;
}

/**
 * Record a refused projection in the diagnostic log and the run's trace.
 *
 * @param refusal - The invariant that refused the projection.
 * @param run - The run the refusal belongs to.
 */
export function reportEnvironmentProjectionRefusal(
    refusal: EnvironmentProjectionRefusal,
    run: ProjectionRefusalRun,
): void {
    const { recorder, provisionalResult } = run;
    recordPreflightDiagnostic('run', {
        note: 'environment_projection_refused',
        refusal,
        runStatus: provisionalResult.runStatus,
        candidatePatch: provisionalResult.candidatePatch !== null,
        sessions: provisionalResult.browserSessions?.length ?? 0,
    });
    recorder.record(TraceEventType.Decision, {
        phase: ENVIRONMENT_PROJECTION_DECISION_PHASE,
        refusal,
        runStatus: provisionalResult.runStatus,
        dispositionStatus: run.disposition.status,
    });
    // The trace was sealed and written before cleanup; the refusal lands after `run_end`, so the
    // same file is rewritten to carry it. A failed rewrite keeps the earlier trace and must not end
    // the run unsealed: the diagnostic log and the run result still name the refusal.
    try {
        persistTrace(recorder.toJSON(), run.artifactsDir);
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        recordPreflightDiagnostic('run', {
            note: 'environment_projection_trace_not_saved',
            refusal,
            message: err.message,
            stack: err.stack ?? null,
        });
    }
}
