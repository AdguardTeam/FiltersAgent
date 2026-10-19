/**
 * What complete full-page vision the `finish_fix` terminal judgement demands, and which browser
 * session comes closest to satisfying it.
 *
 * These builders read only the run's session states and the artifact ids vision has analyzed, so
 * they answer "is the evidence there, and if not what is the shortest way to get it" without ever
 * touching the outcome's semantics. `terminal-outcome-validator.ts` decides what to do with the
 * answer.
 */
import { FixOutcomeKind, type FixOutcome } from '../types/fix-outcome';
import { ExtensionMode } from '../types/fix-run-result';
import { SettingsProfileKind } from '../types/settings-profile-kind';
import type { ReporterSymptomPresence } from '../types/reporter-symptom-presence';
import type { FinishFixValidationRejection } from '../types/terminal-rejection';
import { PromptDocumentName } from '../prompts/prompt-documents';
import {
    sessionBaselineCredited,
    type AgentRuntimeSessionState,
} from './agent-runtime-session-evidence';
import { closedSessionGuidance, renderGuidance } from './rejection-guidance';
import type { TerminalValidationView } from './terminal-validation-view';
import { closestVisionSessionStep, TerminalVisionNextAction } from './terminal-vision-session';

/**
 * Stable model-facing name for one environment `terminalVisionRequirement` can demand complete
 * full-page vision from.
 */
export const TerminalVisionEnvironment = {
    /**
     * Fallback requirement: any navigated page, regardless of extension mode or profile.
     */
    AnyNavigatedPage: 'any_navigated_page',

    /**
     * The unfiltered control session paired with a prepared extension for an
     * `already_fixed_current` claim.
     */
    UnfilteredControl: 'unfiltered_control',

    /**
     * The prepared-extension session paired with an unfiltered control for an
     * `already_fixed_current` claim.
     */
    PreparedExtension: 'prepared_extension',

    /**
     * The terminal current-build session required under the current-first extension selection
     * policy, or the CLI foreground's full-vision completeness bar.
     */
    CurrentPreparedExtension: 'current_prepared_extension',

    /**
     * A session proxied through the activated CLI foreground, carrying no prepared extension.
     */
    CliProxyRoute: 'cli_proxy_route',

    /**
     * The reporter-side session of a current configuration-diagnostic comparison.
     */
    CurrentReporterProfile: 'current_reporter_profile',

    /**
     * The controlled-side session of a current configuration-diagnostic comparison.
     */
    CurrentControlledProfile: 'current_controlled_profile',
} as const;

/**
 * TerminalVisionEnvironment value.
 */
export type TerminalVisionEnvironment =
    (typeof TerminalVisionEnvironment)[keyof typeof TerminalVisionEnvironment];

/**
 * How far one environment's vision requirement is satisfied.
 */
export const TerminalVisionRequirementStatus = {
    /**
     * No session of the environment exists yet.
     */
    Missing: 'missing',

    /**
     * A session exists but its navigation or full-page vision is unfinished.
     */
    Incomplete: 'incomplete',

    /**
     * A navigated session with complete, inspected full-page vision exists.
     */
    Complete: 'complete',
} as const;

/**
 * TerminalVisionRequirementStatus value.
 */
export type TerminalVisionRequirementStatus =
    (typeof TerminalVisionRequirementStatus)[keyof typeof TerminalVisionRequirementStatus];

/**
 * One environment's vision requirement: the session closest to satisfying it and what it still
 * lacks. Rendered verbatim into the rejection the model reads.
 */
export interface TerminalVisionRequirementReport {
    /**
     * The environment the requirement is about.
     */
    environment: TerminalVisionEnvironment;

    /**
     * How far the requirement is satisfied.
     */
    status: TerminalVisionRequirementStatus;

    /**
     * The best session's id, or null when none exists.
     */
    sessionId: string | null;

    /**
     * The best session's 1-based launch order, or null when none exists.
     */
    sessionOrdinal: number | null;

    /**
     * The best session's target URL, or null when none exists.
     */
    targetUrl: string | null;

    /**
     * The extension mode the environment demands, or the best session's mode.
     */
    extensionMode: ExtensionMode | null;

    /**
     * The best session's settings profile kind, or null.
     */
    selectedSettingsProfileKind: SettingsProfileKind | null;

    /**
     * Whether the best session verified its navigation.
     */
    navigationVerified: boolean;

    /**
     * Whether the best session's best capture covers the whole page.
     */
    coverageComplete: boolean;

    /**
     * Vision's verdict on the reporter symptom in that capture, or null.
     */
    reporterSymptomPresence: ReporterSymptomPresence | null;

    /**
     * Artifacts the best capture requires inspected.
     */
    requiredArtifactCount: number;

    /**
     * Of those, how many vision has inspected.
     */
    analyzedArtifactCount: number;

    /**
     * The required artifacts still uninspected.
     */
    missingArtifactIds: string[];

    /**
     * The shortest step that advances the requirement.
     */
    nextAction: TerminalVisionNextAction;
}

/**
 * Describe the best available browser session for one terminal vision requirement.
 *
 * The session is the one {@link closestVisionSessionStep} picks: a complete one, else the one the
 * model can advance furthest, so retry feedback points to the shortest recovery path instead of
 * every abandoned browser attempt.
 *
 * @param view - Read-only projection of the run the judgement reads.
 * @param environment - Stable model-facing name for the required environment.
 * @param states - Browser sessions eligible to satisfy the requirement.
 * @returns Exact session, coverage, and missing-artifact details for the terminal retry.
 */
export function terminalVisionRequirement(
    view: TerminalValidationView,
    environment: TerminalVisionEnvironment,
    states: AgentRuntimeSessionState[],
): TerminalVisionRequirementReport {
    const step = closestVisionSessionStep(view, states);
    if (!step) {
        let extensionMode: ExtensionMode | null = null;
        if (environment === TerminalVisionEnvironment.UnfilteredControl) {
            extensionMode = ExtensionMode.None;
        } else if (
            environment === TerminalVisionEnvironment.PreparedExtension ||
            environment === TerminalVisionEnvironment.CurrentPreparedExtension ||
            environment === TerminalVisionEnvironment.CurrentReporterProfile ||
            environment === TerminalVisionEnvironment.CurrentControlledProfile
        ) {
            extensionMode = ExtensionMode.Prepared;
        }
        return {
            environment,
            status: TerminalVisionRequirementStatus.Missing,
            sessionId: null,
            sessionOrdinal: null,
            targetUrl: null,
            extensionMode,
            selectedSettingsProfileKind: null,
            navigationVerified: false,
            coverageComplete: false,
            reporterSymptomPresence: null,
            requiredArtifactCount: 0,
            analyzedArtifactCount: 0,
            missingArtifactIds: [],
            nextAction: TerminalVisionNextAction.LaunchBrowserAndOpenPage,
        };
    }
    const { state, capture, missingArtifactIds, analyzedArtifactCount, nextAction } = step;
    const complete = state.navigationVerified && state.fullVisionVerified;
    return {
        environment,
        status: complete
            ? TerminalVisionRequirementStatus.Complete
            : TerminalVisionRequirementStatus.Incomplete,
        sessionId: state.sessionId,
        sessionOrdinal: [...view.sessionStates.keys()].indexOf(state.sessionId) + 1,
        targetUrl: state.targetUrl,
        extensionMode: state.extensionMode,
        selectedSettingsProfileKind: state.selectedSettingsProfileKind ?? null,
        navigationVerified: state.navigationVerified,
        coverageComplete: capture?.coverageComplete ?? false,
        reporterSymptomPresence: capture?.reporterSymptomPresence ?? null,
        requiredArtifactCount: capture?.requiredArtifactIds.length ?? 0,
        analyzedArtifactCount,
        missingArtifactIds,
        nextAction,
    };
}

/**
 * Build actionable terminal vision requirements for the model's claimed report-only status.
 *
 * @param view - Read-only projection of the run the judgement reads.
 * @param outcome - Schema-valid report-only terminal proposal.
 * @returns Required environment records with exact missing artifact identities.
 */
export function terminalVisionRequirements(
    view: TerminalValidationView,
    outcome: FixOutcome,
): TerminalVisionRequirementReport[] {
    const states = [...view.sessionStates.values()];
    // A locked CLI environment filters through the activated foreground proxy and owns no
    // extension, so its evidence lives in ordinary proxied sessions. Asking for a prepared
    // extension here would demand something this environment can never produce.
    if (view.cliEvidenceRoute) {
        return [
            terminalVisionRequirement(
                view,
                'cli_proxy_route',
                states.filter((state) => state.extensionMode === ExtensionMode.None),
            ),
        ];
    }
    if (
        outcome.outcome === FixOutcomeKind.ResolveWithoutPatch &&
        outcome.runStatus === 'already_fixed_current'
    ) {
        const preparedStates = states.filter(
            (state) =>
                state.extensionMode === ExtensionMode.Prepared &&
                // The session's baseline proof is the host read-back taken by the launch route's
                // Baseline application, or the list selection a declaring blocker's instruction
                // supplied; one of those two records is what qualifies a prepared session.
                sessionBaselineCredited(state) &&
                view.isTerminalCurrentPreparedState(state),
        );
        return [
            terminalVisionRequirement(
                view,
                'unfiltered_control',
                states.filter((state) => state.extensionMode === ExtensionMode.None),
            ),
            terminalVisionRequirement(view, 'prepared_extension', preparedStates),
        ];
    }
    // The run's one host-prepared build is the current pinned build, so the current-session
    // requirement applies to every run unconditionally.
    return [
        terminalVisionRequirement(
            view,
            'current_prepared_extension',
            states.filter((state) => view.isTerminalCurrentPreparedState(state)),
        ),
    ];
}

/**
 * Return whether a report-only decision has complete vision evidence for its claimed status.
 *
 * `already_fixed_current` needs both an unfiltered control and a prepared-extension page. Other
 * report-only outcomes need one navigated full-page capture whose tiles were all inspected by
 * vision, with the overview when the browser captured one that vision can read.
 *
 * @param view - Read-only projection of the run the judgement reads.
 * @param outcome - Schema-valid report-only terminal proposal.
 * @returns Whether the runtime owns all required browser and vision evidence.
 */
export function hasCompleteTerminalVision(
    view: TerminalValidationView,
    outcome: FixOutcome,
): boolean {
    const completeEnvironments = [...view.sessionStates.values()].filter(
        (state) => state.navigationVerified && state.fullVisionVerified,
    );
    if (completeEnvironments.length === 0) {
        return false;
    }
    // Mirrors terminalVisionRequirements: the CLI route proves its filtering through proxied
    // sessions, which carry no extension.
    if (view.cliEvidenceRoute) {
        return completeEnvironments.some(
            (environment) => environment.extensionMode === ExtensionMode.None,
        );
    }
    if (
        outcome.outcome === FixOutcomeKind.ResolveWithoutPatch &&
        outcome.runStatus === 'already_fixed_current'
    ) {
        return (
            completeEnvironments.some(
                (environment) => environment.extensionMode === ExtensionMode.None,
            ) &&
            completeEnvironments.some(
                (environment) =>
                    environment.extensionMode === ExtensionMode.Prepared &&
                    sessionBaselineCredited(environment) &&
                    view.isTerminalCurrentPreparedState(environment),
            )
        );
    }
    return completeEnvironments.some((environment) =>
        view.isTerminalCurrentPreparedState(environment),
    );
}

/**
 * Require current-prepared full-page vision before a live prepared decision can lock.
 *
 * The run's one host-prepared build is the current pinned build, so the requirement applies to
 * every run unconditionally. Bounded technical browser exhaustion is the only model-terminal
 * exception; the core maps that analysis-only decision to the matching typed browser-infrastructure
 * or target-URL status.
 *
 * @param view - Read-only projection of the run the judgement reads.
 * @param outcome - Schema-valid terminal proposal from the model.
 * @returns Actionable current-session prerequisite, or undefined when satisfied or exempt.
 */
export function validateCurrentFirstTerminalVision(
    view: TerminalValidationView,
    outcome: FixOutcome,
): FinishFixValidationRejection | undefined {
    if (
        outcome.outcome === FixOutcomeKind.AnalysisOnly &&
        view.hasExhaustedTechnicalBrowserFailure()
    ) {
        return undefined;
    }
    // A locked CLI environment has no extension by construction — its filtering evidence comes
    // from sessions proxied through the activated CLI foreground. Demanding a prepared
    // extension here would be unsatisfiable, so the same completeness bar is applied to the
    // CLI evidence sessions instead.
    if (view.cliEvidenceRoute) {
        const cliRequirement = terminalVisionRequirement(
            view,
            'current_prepared_extension',
            [...view.sessionStates.values()].filter(
                (state) => state.extensionMode === ExtensionMode.None && state.navigationVerified,
            ),
        );
        if (cliRequirement.status === TerminalVisionRequirementStatus.Complete) {
            return undefined;
        }
        return {
            error:
                'A locked proxy-executor result requires complete full-page vision from a ' +
                'session proxied through the activated proxy foreground.',
            errorKind: 'cli_route_full_vision_required',
            retryable: true,
            requiredAction: 'inspect_cli_route_full_page',
            requiredTools: [
                'launch_browser',
                'open_page',
                'screenshot',
                'inspect_full_page_capture',
                'analyze_screenshot',
            ],
            currentVisionRequirement: cliRequirement,
            guidance:
                qualifyingSessionGuidance(
                    cliRequirement,
                    'the CLI evidence route (extension="none")',
                ) ?? renderGuidance(PromptDocumentName.RejectionCliRouteLaunch),
        };
    }
    const requirement = terminalVisionRequirement(
        view,
        'current_prepared_extension',
        [...view.sessionStates.values()].filter((state) =>
            view.isTerminalCurrentPreparedState(state),
        ),
    );
    if (requirement.status === TerminalVisionRequirementStatus.Complete) {
        return undefined;
    }
    if (view.requiresCurrentReporterSettings()) {
        const currentStates = [...view.sessionStates.values()].filter((state) =>
            view.isCurrentPreparedState(state),
        );
        // Only a run whose current-build sessions are ALL controlled profiles is missing the
        // reporter settings. Once one session already runs `reported_on_current` with the
        // reporter's exact import, what is missing is its full-page vision, and the generic
        // rejection below names that step. Firing this branch for such sessions too seals runs:
        // the model follows the settings guidance — closes the session, launches a fresh
        // `reported_on_current` one — and never re-captures the page, since nothing tells it the
        // capture is the missing piece.
        const diagnosticOnly =
            currentStates.length > 0 &&
            !currentStates.some((state) => view.isTerminalCurrentPreparedState(state));
        if (diagnosticOnly) {
            return {
                error:
                    'This current-first issue contains an explicit trusted reporter settings ' +
                    'import URL. Controlled defaults_plus_required or agent_selected sessions ' +
                    'are diagnostic only and cannot support a terminal decision. Launch the ' +
                    'current extension with settings.kind=reported_on_current and pass the ' +
                    'reporter importUrl from fetch_issue (decoding Markdown &amp; separators ' +
                    'only) so Chromium can prove the ' +
                    'reporter filter IDs and Stealth state.',
                errorKind: 'current_reporter_settings_required',
                retryable: true,
                requiredAction: 'launch_current_extension_with_reported_on_current',
                requiredTools: [
                    'close_browser',
                    'launch_browser',
                    'open_page',
                    'screenshot',
                    'inspect_full_page_capture',
                    'analyze_screenshot',
                ],
                expectedSettingsProfileKind: SettingsProfileKind.ReportedOnCurrent,
                actualProfileKinds: [
                    ...new Set(
                        currentStates.map(
                            (state) => state.selectedSettingsProfileKind ?? 'missing',
                        ),
                    ),
                ],
                currentVisionRequirement: requirement,
                guidance: [
                    'Close the diagnostic current-extension session.',
                    'Keep the prepared extension selected as current.',
                    'Launch a fresh prepared session with settings.kind=reported_on_current.',
                    'Preserve importUrl values; decode Markdown &amp; separators to & if present.',
                    'Capture and inspect the complete page, then revalidate the same candidate there.',
                ],
            };
        }
    }
    return {
        error:
            'A current-first result requires complete full-page vision from a prepared ' +
            'extension session whose immutable provenance is environment=current. A ' +
            'reporter-version comparison cannot replace current evidence.',
        errorKind: 'current_extension_full_vision_required',
        retryable: true,
        requiredAction: 'inspect_current_extension_full_page',
        requiredTools: [
            'launch_browser',
            'open_page',
            'screenshot',
            'inspect_full_page_capture',
            'analyze_screenshot',
        ],
        currentVisionRequirement: requirement,
        guidance:
            qualifyingSessionGuidance(
                requirement,
                `the current build with ${String(requirement.selectedSettingsProfileKind)} settings`,
            ) ?? renderGuidance(PromptDocumentName.RejectionCurrentExtensionLaunch),
    };
}

/**
 * Guidance for a full-vision rejection when a qualifying session already exists.
 *
 * A live session must not be told to launch again — that loop seals the run — but to finish the
 * capture in the session it has, with the requirement's own next action. A closed one can take no
 * further capture, so it is named as the environment to relaunch. Absent a qualifying session the
 * caller keeps its launch-first guidance.
 *
 * @param requirement - The vision requirement report.
 * @param sessionDescription - What the qualifying session runs, for the model.
 * @returns Ordered guidance lines, or undefined when no qualifying session exists.
 */
function qualifyingSessionGuidance(
    requirement: TerminalVisionRequirementReport,
    sessionDescription: string,
): string[] | undefined {
    if (requirement.status !== TerminalVisionRequirementStatus.Incomplete) {
        return undefined;
    }
    if (requirement.nextAction === TerminalVisionNextAction.RelaunchClosedSession) {
        return closedSessionGuidance(requirement.sessionOrdinal, sessionDescription);
    }
    return renderGuidance(PromptDocumentName.RejectionQualifyingSession, {
        sessionOrdinal: String(requirement.sessionOrdinal),
        sessionDescription,
        nextAction: requirement.nextAction,
    });
}
