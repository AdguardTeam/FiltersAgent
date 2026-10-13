/**
 * The configuration-diagnostic half of the `finish_fix` terminal judgement: proving that a
 * `configuration_specific` claim rests on two independently configured current-extension sessions
 * rather than on one session read two ways.
 *
 * The semantic conclusion stays vision-owned — this module only checks that the reporter profile
 * and the controlled baseline each carry complete, classified full-page evidence, and that the two
 * classifications are the pair the claimed status needs.
 */
import { FixOutcomeKind, type FixOutcome } from '../types/fix-outcome';
import { ReporterSymptomPresence } from '../types/reporter-symptom-presence';
import { reproEnvironmentsEqual } from '../types/repro-profile';
import { SettingsProfileKind } from '../types/settings-profile-kind';
import type { FinishFixValidationRejection } from '../types/terminal-rejection';
import type {
    AgentPageVisionCapture,
    AgentRuntimeSessionState,
} from './agent-runtime-session-evidence';
import type { TerminalValidationView } from './terminal-validation-view';
import { terminalVisionRequirement } from './terminal-vision-requirements';

/**
 * Which side of a current configuration-diagnostic comparison is being built: the reporter's
 * profile or the controlled baseline profile.
 */
const ConfigurationProfileRole = {
    /**
     * The reporter's own settings profile.
     */
    Reporter: 'reporter',

    /**
     * The controlled baseline settings profile compared against the reporter's.
     */
    Controlled: 'controlled',
} as const;

/**
 * ConfigurationProfileRole value.
 */
type ConfigurationProfileRole =
    (typeof ConfigurationProfileRole)[keyof typeof ConfigurationProfileRole];

/**
 * Build current-extension evidence for one exact diagnostic settings profile.
 *
 * Reporter evidence must also match the trusted import URL. Controlled evidence deliberately
 * remains separate from terminal reporter parity so it can prove a configuration difference.
 *
 * @param view - Read-only projection of the run the judgement reads.
 * @param role - Reporter or controlled side of the diagnostic comparison.
 * @returns Complete vision requirement plus its structured reporter-symptom classification.
 */
function currentConfigurationProfileEvidence(
    view: TerminalValidationView,
    role: ConfigurationProfileRole,
): Record<string, unknown> {
    const reporterProfileKind = view.requiresCurrentReporterSettings()
        ? SettingsProfileKind.ReportedOnCurrent
        : SettingsProfileKind.AgentSelected;
    const profileKind =
        role === 'reporter' ? reporterProfileKind : SettingsProfileKind.DefaultsPlusRequired;
    const states = [...view.sessionStates.values()].filter(
        (state) =>
            view.isCurrentPreparedState(state) &&
            state.selectedSettingsProfileKind === profileKind &&
            (role !== 'reporter' || view.isTerminalCurrentPreparedState(state)),
    );
    let classifiedState: AgentRuntimeSessionState | undefined;
    let classifiedCapture: AgentPageVisionCapture | undefined;
    for (let stateIndex = states.length - 1; stateIndex >= 0; stateIndex -= 1) {
        const candidateState = states[stateIndex]!;
        for (
            let captureIndex = candidateState.pageCaptures.length - 1;
            captureIndex >= 0;
            captureIndex -= 1
        ) {
            const candidateCapture = candidateState.pageCaptures[captureIndex]!;
            if (
                candidateState.navigationVerified &&
                candidateCapture.coverageComplete &&
                candidateCapture.requiredArtifactIds.length > 0 &&
                candidateCapture.requiredArtifactIds.every((artifactId) =>
                    candidateState.analyzedArtifactIds.has(artifactId),
                ) &&
                candidateCapture.reporterSymptomPresence !== null
            ) {
                classifiedState = candidateState;
                classifiedCapture = candidateCapture;
                break;
            }
        }
        if (classifiedState) {
            break;
        }
    }
    const requirement = terminalVisionRequirement(
        view,
        role === 'reporter' ? 'current_reporter_profile' : 'current_controlled_profile',
        classifiedState ? [classifiedState] : states,
    );
    return {
        ...requirement,
        status: classifiedCapture ? 'complete' : requirement.status,
        expectedSettingsProfileKind: profileKind,
        reporterSymptomPresence: classifiedCapture?.reporterSymptomPresence ?? null,
    };
}

/**
 * Require a controlled current-profile comparison before accepting configuration-specific.
 *
 * The semantic conclusion remains vision-owned: the exact reporter symptom must be present under
 * the reporter's current settings and absent under fresh defaults plus the relevant recommended
 * filter. This boundary only proves both conclusions belong to complete, independently configured
 * current-extension sessions.
 *
 * @param view - Read-only projection of the run the judgement reads.
 * @param outcome - Schema-valid terminal decision proposed by the model.
 * @returns Actionable evidence or matrix correction, or undefined when the claim is proven.
 */
export function validateConfigurationSpecificEvidence(
    view: TerminalValidationView,
    outcome: FixOutcome,
): FinishFixValidationRejection | undefined {
    if (
        outcome.outcome !== FixOutcomeKind.ResolveWithoutPatch ||
        outcome.runStatus !== 'configuration_specific'
    ) {
        return undefined;
    }
    const reporterProfile = currentConfigurationProfileEvidence(view, 'reporter');
    const controlledProfile = currentConfigurationProfileEvidence(view, 'controlled');
    const reporterProfileKind = String(reporterProfile.expectedSettingsProfileKind);
    if (reporterProfile.status !== 'complete' || controlledProfile.status !== 'complete') {
        const reporterIncomplete = reporterProfile.status !== 'complete';
        const controlledMissing = controlledProfile.status === 'missing';
        return {
            error:
                'configuration_specific requires complete current-extension vision for both ' +
                'the exact reporter profile and defaults_plus_required controlled profile.',
            errorKind: 'configuration_specific_evidence_required',
            retryable: true,
            requiredAction: reporterIncomplete
                ? 'complete_reporter_current_profile_evidence'
                : controlledMissing
                  ? 'launch_controlled_current_profile'
                  : 'complete_controlled_current_profile_evidence',
            requiredTools: [
                'close_browser',
                'launch_browser',
                'open_page',
                'screenshot',
                'inspect_full_page_capture',
            ],
            reporterProfile,
            controlledProfile,
            guidance: [
                reporterProfileKind === SettingsProfileKind.ReportedOnCurrent
                    ? 'Use reported_on_current with the exact trusted import URL for reporter evidence.'
                    : 'Use agent_selected with issue-derived filter IDs and Stealth state for reporter evidence.',
                'Use defaults_plus_required with reporter metadata and issue labels for the controlled session.',
                'Capture and structurally inspect the complete page in each isolated session.',
            ],
        };
    }
    const reporterSessionId = reporterProfile.sessionId;
    const controlledSessionId = controlledProfile.sessionId;
    const reporterState =
        typeof reporterSessionId === 'string'
            ? view.sessionStates.get(reporterSessionId)
            : undefined;
    const controlledState =
        typeof controlledSessionId === 'string'
            ? view.sessionStates.get(controlledSessionId)
            : undefined;
    if (
        !reporterState ||
        !controlledState ||
        !reproEnvironmentsEqual(
            reporterState.targetUrl,
            reporterState.profile,
            controlledState.targetUrl,
            controlledState.profile,
        )
    ) {
        return {
            error:
                'configuration_specific requires reporter and controlled evidence from the ' +
                'same canonical target URL and browser reproduction profile.',
            errorKind: 'configuration_specific_environment_mismatch',
            retryable: true,
            requiredAction: 'rerun_controlled_with_reporter_environment',
            reporterProfile,
            controlledProfile,
            guidance: [
                'Launch defaults_plus_required against the same target URL used for reporter evidence.',
                'Reuse the reporter viewport, locale, timezone, user-agent profile, consent strategy, and geolocation.',
                'Change only extension settings between the two sessions.',
            ],
        };
    }
    if (
        reporterProfile.reporterSymptomPresence === ReporterSymptomPresence.Present &&
        controlledProfile.reporterSymptomPresence === ReporterSymptomPresence.Absent
    ) {
        return undefined;
    }
    return {
        error:
            'configuration_specific requires the exact reporter symptom to be present under ' +
            `the ${reporterProfileKind} reporter profile and absent under ` +
            'defaults_plus_required.',
        errorKind: 'configuration_specific_evidence_mismatch',
        retryable: true,
        requiredAction: 'choose_status_consistent_with_configuration_evidence',
        reporterProfile,
        controlledProfile,
        guidance: [
            'If the symptom is absent in both profiles, use not_reproduced only when all classified environments support it.',
            'If the symptom remains in the controlled profile, continue investigating a filter fix.',
            'If either classification is indeterminate, recapture and inspect that profile.',
        ],
    };
}
