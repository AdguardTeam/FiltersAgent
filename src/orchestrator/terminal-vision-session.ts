/**
 * Which browser session comes closest to satisfying one terminal vision requirement, and the
 * shortest step that advances it.
 *
 * Only the run's active session is live: every launch closes the session before it, and
 * `close_browser` closes the active one. A closed session keeps its captures, so vision can still
 * inspect them by artifact id, but nothing can open or capture a page in it any more. A requirement
 * that names a closed session must therefore ask for a relaunch of its environment, never for a
 * capture in it.
 *
 * A session whose navigation failed technically is retired even while active: its page tools are
 * gone, and `launch_browser` refuses its environment from then on, for any later launch. Such a
 * session can still finish the inspection of a capture it took, but neither it nor any other
 * session of that environment is named for a capture or a relaunch.
 */
import {
    analyzedCaptureArtifactCount,
    browserSessionVisionProgress,
    type AgentPageVisionCapture,
    type AgentRuntimeSessionState,
} from './agent-runtime-session-evidence';
import type { TerminalValidationView } from './terminal-validation-view';

/**
 * The shortest next step that advances one vision requirement, named for the model.
 */
export const TerminalVisionNextAction = {
    /**
     * No session exists: launch one and open the target.
     */
    LaunchBrowserAndOpenPage: 'launch_browser_and_open_page',

    /**
     * The closest session is closed and still lacks its navigation or a complete capture: launch
     * its environment again and capture there.
     */
    RelaunchClosedSession: 'relaunch_closed_session',

    /**
     * The session never verified its navigation.
     */
    OpenPage: 'open_page',

    /**
     * No complete full-page capture exists in the session.
     */
    CaptureCompletePage: 'capture_complete_page',

    /**
     * A complete capture exists and none of it was inspected; the batch inspection covers it.
     */
    InspectFullPageCapture: 'inspect_full_page_capture',

    /**
     * Some tiles of the capture remain uninspected.
     */
    AnalyzeMissingArtifacts: 'analyze_missing_artifacts',

    /**
     * Everything is inspected; the terminal evidence only needs refreshing.
     */
    RefreshTerminalEvidence: 'refresh_terminal_evidence',
} as const;

/**
 * TerminalVisionNextAction value.
 */
export type TerminalVisionNextAction =
    (typeof TerminalVisionNextAction)[keyof typeof TerminalVisionNextAction];

/**
 * Steps that need the session's own page tools. A closed session cannot take them, and neither can
 * an active one retired after a technical navigation failure.
 */
const PAGE_ACTIONS: ReadonlySet<TerminalVisionNextAction> = new Set([
    TerminalVisionNextAction.OpenPage,
    TerminalVisionNextAction.CaptureCompletePage,
]);

/**
 * One session's progress toward a requirement: its best capture and what it still lacks.
 */
export interface TerminalVisionSessionStep {
    /**
     * The session the step is about.
     */
    state: AgentRuntimeSessionState;

    /**
     * The session's best capture, or undefined when it captured nothing.
     */
    capture: AgentPageVisionCapture | undefined;

    /**
     * The capture's required artifacts vision has not inspected yet.
     */
    missingArtifactIds: string[];

    /**
     * How many of the capture's required artifacts vision has inspected.
     */
    analyzedArtifactCount: number;

    /**
     * The shortest step that advances the requirement through this session.
     */
    nextAction: TerminalVisionNextAction;
}

/**
 * Describe what one session still lacks and the step that advances it.
 *
 * @param state - Session to describe.
 * @param activeSessionId - The run's one live session, or undefined after `close_browser`.
 * @returns The session's best capture and next step.
 */
function sessionStep(
    state: AgentRuntimeSessionState,
    activeSessionId: string | undefined,
): TerminalVisionSessionStep {
    const completeCapture = state.pageCaptures.reduce<AgentPageVisionCapture | undefined>(
        (latest, candidate) =>
            candidate.coverageComplete &&
            candidate.requiredArtifactIds.length > 0 &&
            candidate.requiredArtifactIds.every((artifactId) =>
                state.analyzedArtifactIds.has(artifactId),
            )
                ? candidate
                : latest,
        undefined,
    );
    const capture =
        completeCapture ??
        [...state.pageCaptures].reduce<AgentPageVisionCapture | undefined>((best, candidate) => {
            if (!best) {
                return candidate;
            }
            return analyzedCaptureArtifactCount(state, candidate) >=
                analyzedCaptureArtifactCount(state, best)
                ? candidate
                : best;
        }, undefined);
    const missingArtifactIds = capture
        ? capture.requiredArtifactIds.filter(
              (artifactId) => !state.analyzedArtifactIds.has(artifactId),
          )
        : [];
    const analyzedArtifactCount =
        (capture?.requiredArtifactIds.length ?? 0) - missingArtifactIds.length;
    // The batch inspection reads the active session's latest capture and needs no page tool, so
    // a retired active session keeps it.
    const active = state.sessionId === activeSessionId;
    const canBatchInspectCapture =
        capture !== undefined && active && state.pageCaptures.at(-1) === capture;
    let nextAction: TerminalVisionNextAction = TerminalVisionNextAction.RefreshTerminalEvidence;
    if (!state.navigationVerified) {
        nextAction = TerminalVisionNextAction.OpenPage;
    } else if (!capture || !capture.coverageComplete || capture.requiredArtifactIds.length === 0) {
        nextAction = TerminalVisionNextAction.CaptureCompletePage;
    } else if (missingArtifactIds.length > 0) {
        nextAction =
            analyzedArtifactCount === 0 && canBatchInspectCapture
                ? TerminalVisionNextAction.InspectFullPageCapture
                : TerminalVisionNextAction.AnalyzeMissingArtifacts;
    }
    if ((!active || state.technicalNavigationFailed) && PAGE_ACTIONS.has(nextAction)) {
        nextAction = TerminalVisionNextAction.RelaunchClosedSession;
    }
    return { state, capture, missingArtifactIds, analyzedArtifactCount, nextAction };
}

/**
 * Pick the furthest-progressed step, the later session on a tie.
 *
 * @param steps - Candidate steps in launch order.
 * @returns The furthest step, or undefined for an empty list.
 */
function furthestStep(steps: TerminalVisionSessionStep[]): TerminalVisionSessionStep | undefined {
    return steps.reduce<TerminalVisionSessionStep | undefined>((best, candidate) => {
        if (!best) {
            return candidate;
        }
        return browserSessionVisionProgress(candidate.state) >=
            browserSessionVisionProgress(best.state)
            ? candidate
            : best;
    }, undefined);
}

/**
 * Find the session closest to satisfying one requirement.
 *
 * A complete session wins. Otherwise a session the model can still advance — the live one, or a
 * closed one whose capture only needs inspecting — wins over a closed one that would need a
 * relaunch, and among those the session with the most analyzed artifacts of one capture wins, so
 * retry feedback points to the shortest recovery path instead of every abandoned browser attempt. A
 * session that would need a relaunch of an environment `launch_browser` refuses is no candidate at
 * all: with nothing else left the requirement reads as missing, and the launch-first guidance asks
 * for a fresh environment.
 *
 * @param view - The run's sessions and its one live session.
 * @param states - Sessions eligible to satisfy the requirement, in launch order.
 * @returns The closest session's step, or undefined when no session is eligible.
 */
export function closestVisionSessionStep(
    view: Pick<TerminalValidationView, 'activeSessionId' | 'sessionStates'>,
    states: AgentRuntimeSessionState[],
): TerminalVisionSessionStep | undefined {
    const { activeSessionId } = view;
    const completeState = states.reduce<AgentRuntimeSessionState | undefined>(
        (latest, candidate) =>
            candidate.navigationVerified && candidate.fullVisionVerified ? candidate : latest,
        undefined,
    );
    if (completeState) {
        return sessionStep(completeState, activeSessionId);
    }
    // launch_browser refuses the environment of every retired session, whichever session of that
    // environment asks for it again — an eligible one or not.
    const failedEnvironmentKeys = new Set(
        [...view.sessionStates.values()]
            .filter((state) => state.technicalNavigationFailed)
            .map((state) => state.environmentKey),
    );
    const steps = states.map((state) => sessionStep(state, activeSessionId));
    const relaunch = (step: TerminalVisionSessionStep): boolean =>
        step.nextAction === TerminalVisionNextAction.RelaunchClosedSession;
    return (
        furthestStep(steps.filter((step) => !relaunch(step))) ??
        furthestStep(steps.filter((step) => !failedEnvironmentKeys.has(step.state.environmentKey)))
    );
}
