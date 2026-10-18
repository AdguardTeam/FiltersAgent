/**
 * The `finish_fix` terminal judgement: everything that decides whether a submitted
 * {@link FixOutcome} is backed by the evidence the run actually produced.
 *
 * The judgement reads the run, it never changes it, through the read-only
 * {@link TerminalValidationView} projection — so every rejection here can be exercised against a
 * constructed view without launching a browser, the shape `no-patch-terminal-judgement.ts` already
 * uses for the symptom matrix it owns.
 *
 * What stays here is the judgement proper: the no-patch symptom matrix, the page-access and
 * candidate-placement checks, and `validateTerminalOutcome`, which orders them. The vision
 * requirements it consults live in `terminal-vision-requirements.ts` and the
 * configuration-diagnostic pair in `terminal-configuration-evidence.ts`.
 */
import { CandidateOperation } from '../environment/filtering-environment';
import { EnvironmentSelectionState } from '../environment/environment-vocabulary';
import { classifyObservedPageAccess } from '../environment/target-access';
import { FixOutcomeKind, type FixOutcome } from '../types/fix-outcome';
import { normalizeRule } from '../repo/rule-normalizer';
import { ExtensionMode, type SymptomObservation } from '../types/fix-run-result';
import { ReporterSymptomPresence } from '../types/reporter-symptom-presence';
import type { FinishFixValidationRejection } from '../types/terminal-rejection';
import { MAX_CANDIDATE_VALIDATION_EXECUTIONS } from '../types/candidate-limits';
import {
    MAX_TECHNICAL_BROWSER_FAILURES_PER_TARGET,
    candidateLedgerKey,
} from './agent-runtime-candidate-context';
import type { AgentRuntimeEnvironmentEvidence } from './agent-runtime-session-evidence';
import { cliCandidateUnverifiedRejection } from './cli-candidate-experiment';
import {
    judgeNoPatchSymptomMatrix,
    type TerminalSymptomPresenceEvidence,
} from './no-patch-terminal-judgement';
import { validateConfigurationSpecificEvidence } from './terminal-configuration-evidence';
import {
    validateCandidatePlacement,
    validateCandidateScope,
} from './terminal-candidate-prerequisites';
import type { TerminalValidationView } from './terminal-validation-view';
import {
    hasCompleteTerminalVision,
    terminalVisionRequirements,
    validateCurrentFirstTerminalVision,
} from './terminal-vision-requirements';
import { TerminalVisionNextAction } from './terminal-vision-session';
import { closedSessionGuidance } from './rejection-guidance';

/**
 * Return the latest complete structured symptom presence for one browser environment, with whether
 * that same capture could show the reported content at all.
 *
 * @param view - Read-only projection of the run the judgement reads.
 * @param extensionMode - Unfiltered or prepared session kind to inspect.
 * @returns Session-bound presence evidence, or undefined when structured vision is incomplete.
 */
function latestTerminalSymptomPresence(
    view: TerminalValidationView,
    extensionMode: AgentRuntimeEnvironmentEvidence['extensionMode'],
): TerminalSymptomPresenceEvidence | undefined {
    const states = [...view.sessionStates.values()];
    for (let stateIndex = states.length - 1; stateIndex >= 0; stateIndex -= 1) {
        const state = states[stateIndex];
        if (state.extensionMode !== extensionMode || !state.navigationVerified) {
            continue;
        }
        // The run's one host-prepared build is the current pinned build, so a prepared session
        // counts only with its terminal-grade settings proof, unconditionally.
        if (
            extensionMode === ExtensionMode.Prepared &&
            !view.isTerminalCurrentPreparedState(state)
        ) {
            continue;
        }
        for (
            let captureIndex = state.pageCaptures.length - 1;
            captureIndex >= 0;
            captureIndex -= 1
        ) {
            const capture = state.pageCaptures[captureIndex];
            const complete =
                capture.coverageComplete &&
                capture.requiredArtifactIds.length > 0 &&
                capture.requiredArtifactIds.every((artifactId) =>
                    state.analyzedArtifactIds.has(artifactId),
                );
            if (
                complete &&
                capture.reporterSymptomPresence !== null &&
                capture.pageObstruction !== null
            ) {
                return {
                    sessionId: state.sessionId,
                    presence: capture.reporterSymptomPresence,
                    access: classifyObservedPageAccess(
                        state.pageAccessFacts?.statusCode ?? 200,
                        capture.pageObstruction,
                    ),
                };
            }
        }
    }
    return undefined;
}

/**
 * Derive the reporter symptom state from session-bound structured vision, never from status text.
 *
 * @param view - Read-only projection of the run the judgement reads.
 * @returns Reproduced, not reproduced, or indeterminate from all classified environments.
 */
export function terminalSymptomObservation(view: TerminalValidationView): SymptomObservation {
    const observations = [
        latestTerminalSymptomPresence(view, 'none'),
        latestTerminalSymptomPresence(view, 'prepared'),
    ].filter(
        (observation): observation is TerminalSymptomPresenceEvidence => observation !== undefined,
    );
    if (observations.length === 0) {
        return 'indeterminate';
    }
    if (
        observations.some(
            (observation) => observation.presence === ReporterSymptomPresence.Indeterminate,
        )
    ) {
        return 'indeterminate';
    }
    if (
        observations.some((observation) => observation.presence === ReporterSymptomPresence.Present)
    ) {
        return 'reproduced';
    }
    return 'not_reproduced';
}

/**
 * Reject a no-patch status whose semantics contradict session-bound full-page vision.
 *
 * @param view - Read-only projection of the run the judgement reads.
 * @param outcome - Schema-valid terminal decision proposed by the model.
 * @returns Actionable status correction, or undefined when the claimed matrix is proven.
 */
function validateNoPatchSymptomMatrix(
    view: TerminalValidationView,
    outcome: FixOutcome,
): FinishFixValidationRejection | undefined {
    return judgeNoPatchSymptomMatrix(
        outcome,
        latestTerminalSymptomPresence(view, ExtensionMode.None),
        latestTerminalSymptomPresence(view, ExtensionMode.Prepared),
    );
}

/**
 * Verify that a terminal decision follows issue intake and has the required browser evidence.
 *
 * Issue settings remain model-visible evidence and are validated by browser/publication boundaries.
 * The terminal hook detects only trusted import presence; it never selects or infers reporter
 * settings values.
 *
 * @param outcome - Schema-valid finish_fix decision proposed by the model.
 * @param view - Read-only projection of the run the judgement reads.
 * @returns Retryable evidence prerequisite, or undefined when terminal locking is allowed.
 */
export function validateTerminalOutcome(
    outcome: FixOutcome,
    view: TerminalValidationView,
): FinishFixValidationRejection | undefined {
    if (view.fetchedIssueNumber !== view.issue.number) {
        return {
            error:
                `Call fetch_issue with issueNumber=${view.issue.number} before ` +
                'finish_fix so every terminal decision is based on the allowed issue.',
            errorKind: 'issue_fetch_required',
            retryable: true,
            requiredAction: 'fetch_issue',
            requiredTool: 'fetch_issue',
            issueNumber: view.issue.number,
        };
    }
    const environmentSelection = view.environmentSelection();
    if (!environmentSelection) {
        return {
            error:
                'Inspect the advertised capabilities and call select_environment before ' +
                'finishing the run.',
            errorKind: 'environment_selection_required',
            retryable: true,
            requiredAction: 'select_environment',
            requiredTool: 'select_environment',
        };
    }
    if (environmentSelection.state !== EnvironmentSelectionState.Ready) {
        if (outcome.outcome === FixOutcomeKind.AnalysisOnly) {
            return undefined;
        }
        return {
            error:
                'Unsupported or capability-limited selections may finish only with an ' +
                'analysis_only report and cannot claim a candidate or verified no-patch result.',
            errorKind: 'environment_report_only_required',
            retryable: true,
            requiredAction: 'finish_fix_analysis_only',
            selectedKind: environmentSelection.selectedKind,
            selectionState: environmentSelection.state,
        };
    }
    const remainingIssueScreenshotIndices = view.remainingIssueScreenshotIndices();
    if (remainingIssueScreenshotIndices.length > 0) {
        return {
            error:
                'Analyze every unique user issue screenshot before finish_fix by passing each ' +
                'remaining issueScreenshotIndex returned by fetch_issue.',
            errorKind: 'issue_screenshot_analysis_required',
            retryable: true,
            requiredAction: 'analyze_issue_screenshots',
            requiredTool: 'analyze_screenshot',
            availableIssueScreenshotIndices: view.issueAttachmentArtifactIds.map(
                (_, index) => index + 1,
            ),
            remainingIssueScreenshotIndices,
        };
    }
    if (outcome.outcome !== FixOutcomeKind.ProposeRule) {
        if (!view.hasBrowserEvidence()) {
            if (view.hasExhaustedTechnicalBrowserFailure()) {
                return undefined;
            }
            return {
                error:
                    'Browser-first fix cannot finish before successful page navigation or ' +
                    'bounded technical browser retries are exhausted.',
                errorKind: 'browser_first_evidence_required',
                retryable: true,
                requiredAction: 'fetch_issue_and_run_browser',
                requiredTools: ['fetch_issue', 'launch_browser', 'open_page'],
                maximumTechnicalAttempts: MAX_TECHNICAL_BROWSER_FAILURES_PER_TARGET,
                // A page that loads fine but shows a wall is neither a verified navigation nor a
                // technical failure; only vision confirming the wall moves such a run forward
                // (without it, a run relaunches on this refusal until it is sealed).
                guidance: [
                    'When open_page succeeds but a sign-in page, a regional block or a bot check ' +
                        'stands in for the reported page, capture it with screenshot and classify ' +
                        'it with analyze_screenshot.',
                    'Every session vision confirms as walled spends one of the ' +
                        `${MAX_TECHNICAL_BROWSER_FAILURES_PER_TARGET} technical attempts; once ` +
                        'they are spent, finish_fix accepts analysis_only.',
                ],
            };
        }
        const currentVisionRejection = validateCurrentFirstTerminalVision(view, outcome);
        if (currentVisionRejection) {
            return currentVisionRejection;
        }
        if (
            outcome.outcome === FixOutcomeKind.AnalysisOnly &&
            view.hasExhaustedTechnicalBrowserFailure()
        ) {
            // Bounded technical browser exhaustion is the only model-terminal exception:
            // once browser access is exhausted, an analysis_only report describes the
            // evidence that physically exists instead of demanding captures that can no
            // longer be produced. The core maps this decision to the matching typed
            // browser-infrastructure or target-URL status.
            return undefined;
        }
        if (!hasCompleteTerminalVision(view, outcome)) {
            const visionRequirements = terminalVisionRequirements(view, outcome);
            const incomplete = visionRequirements.filter(
                (requirement) => requirement.status !== 'complete',
            );
            const retryDetail = incomplete
                .map((requirement) => {
                    const missingArtifactIds = Array.isArray(requirement.missingArtifactIds)
                        ? requirement.missingArtifactIds.join(', ')
                        : '';
                    const sessionDetail =
                        typeof requirement.sessionOrdinal === 'number'
                            ? `browser session #${String(requirement.sessionOrdinal)}`
                            : 'no browser session yet';
                    return (
                        `${String(requirement.environment)} ` +
                        `(${sessionDetail}, next ${String(requirement.nextAction)})` +
                        (missingArtifactIds
                            ? `; missing screenshot artifacts: ${missingArtifactIds}`
                            : '')
                    );
                })
                .join(' | ');
            let requiredAction = 'complete_terminal_vision_requirements';
            if (
                incomplete.every(
                    (requirement) =>
                        requirement.nextAction === TerminalVisionNextAction.AnalyzeMissingArtifacts,
                )
            ) {
                requiredAction = 'analyze_missing_screenshot_artifacts';
            } else if (
                incomplete.every(
                    (requirement) =>
                        requirement.nextAction === TerminalVisionNextAction.InspectFullPageCapture,
                )
            ) {
                requiredAction = 'inspect_full_page_capture';
            }
            // A closed session cannot take a capture: its requirement is met by launching the
            // same environment again, so the launch is offered and the session named.
            const relaunches = incomplete.filter(
                (requirement) =>
                    requirement.nextAction === TerminalVisionNextAction.RelaunchClosedSession,
            );
            return {
                error:
                    'Every report-only decision requires a navigated full-page capture whose ' +
                    'overview and every original-resolution tile were inspected by vision. ' +
                    `Incomplete requirements: ${retryDetail}.`,
                errorKind: 'report_only_full_vision_required',
                retryable: true,
                requiredAction,
                requiredTools: [
                    ...(relaunches.length > 0 ? ['launch_browser'] : []),
                    'open_page',
                    'screenshot',
                    'inspect_full_page_capture',
                    'analyze_screenshot',
                ],
                visionRequirements,
                guidance: [
                    'Follow nextAction for each incomplete visionRequirements entry.',
                    'For inspect_full_page_capture, call it once on the active latest capture.',
                    'For analyze_missing_artifacts, retry only the listed artifact IDs.',
                    'Call screenshot with captureTiles=true only when capture_complete_page is required.',
                    'For already_fixed_current, complete both unfiltered and prepared-extension environments.',
                    ...relaunches.flatMap((requirement) =>
                        closedSessionGuidance(
                            requirement.sessionOrdinal,
                            `the ${requirement.environment} environment`,
                        ),
                    ),
                ],
            };
        }
        const symptomMatrixRejection = validateNoPatchSymptomMatrix(view, outcome);
        if (symptomMatrixRejection) {
            return symptomMatrixRejection;
        }
        const configurationRejection = validateConfigurationSpecificEvidence(view, outcome);
        if (configurationRejection) {
            return configurationRejection;
        }
        return undefined;
    }
    const currentVisionRejection = validateCurrentFirstTerminalVision(view, outcome);
    if (currentVisionRejection) {
        return currentVisionRejection;
    }
    const canonical = normalizeRule(outcome.ruleProposal.rule).canonical;
    // Terminal draft proposals are always additive candidates in the ledger.
    const ledgerKey = candidateLedgerKey(CandidateOperation.Add, canonical);
    // Before the placement binding: a draft carrying an extension plan's merged line would
    // otherwise be sent to resolve a placement for that line and end at the safety gate anyway.
    const scopeRejection = validateCandidateScope(view, outcome);
    if (scopeRejection) {
        return scopeRejection;
    }
    const placementRejection = validateCandidatePlacement(view, outcome);
    if (placementRejection) {
        return placementRejection;
    }
    const validationOutcome = view.candidateValidationOutcome(ledgerKey);
    const validationArtifactId = validationOutcome?.validationArtifactId;
    const visionVerified =
        validationArtifactId !== undefined && validationOutcome?.visualVerdict === 'verified';
    if (!visionVerified) {
        const sameCandidateRetryAllowed = view.canRetryInconclusiveVisualReview(ledgerKey);
        let guidance: string[];
        if (sameCandidateRetryAllowed) {
            guidance = [
                'Call apply_rule again with the exact same candidate in the current browser session.',
                'An inconclusive bound-vision retry does not consume another semantic candidate attempt.',
                'Do not substitute a manual analyze_screenshot opinion for the runner-bound visualReview.',
            ];
        } else {
            guidance = [
                'Use the visualReview returned by apply_rule as the only candidate verification verdict.',
                'Choose a semantically different candidate when the review rejected the rule, otherwise finish analysis_only.',
                'Once no distinct candidate or attempt is left, on any report but incorrect blocking a rule the review rejected only for ad layout residue (adLayoutResidue present, symptom resolved or unclear, remainingInstances empty, pageIntegrity intact, observedDamage empty) finishes analysis_only as candidateForReview, the residue named in unverifiedReason; on an incorrect-blocking report residue means the exception brought ads back, and the rule is not carried.',
                'Do not substitute a manual analyze_screenshot opinion for the runner-bound visualReview.',
            ];
        }
        return {
            error: sameCandidateRetryAllowed
                ? 'The bound candidate vision review was inconclusive; resolve any visible comparison obstruction and retry the exact same apply_rule validation.'
                : 'A rule proposal requires a complete verified vision review from the latest apply_rule result.',
            errorKind: 'candidate_visual_confirmation_required',
            retryable: true,
            requiredAction: validationOutcome
                ? sameCandidateRetryAllowed
                    ? 'retry_same_candidate_validation'
                    : 'choose_another_candidate_or_analysis_only'
                : 'apply_candidate_rule',
            candidateRule: canonical,
            currentValidationArtifactId: validationArtifactId ?? null,
            currentVisualVerdict: validationOutcome?.visualVerdict ?? null,
            validationAttemptCount: validationOutcome?.validationAttemptCount ?? 0,
            maximumValidationAttempts: MAX_CANDIDATE_VALIDATION_EXECUTIONS,
            sameCandidateRetryAllowed,
            guidance,
        };
    }
    const verifiedEnvironment = view.getVerifiedCandidateEnvironment(validationArtifactId!);
    if (!verifiedEnvironment && view.cliEvidenceRoute) {
        return cliCandidateUnverifiedRejection(canonical, validationArtifactId!);
    }
    if (!verifiedEnvironment) {
        const validationEnvironment = view.getValidationEnvironment(validationArtifactId!);
        // The run's one host-prepared build is the current pinned build by construction, so the
        // dedicated rejection fires exactly when the validated session ran no extension at all.
        const ranPreparedExtension =
            validationEnvironment?.extensionMode === ExtensionMode.Prepared &&
            validationEnvironment.extension !== undefined;
        if (!ranPreparedExtension) {
            return {
                error:
                    'A candidate must be vision-verified in the same prepared session that ' +
                    "loaded the run's current pinned extension. Unfiltered control evidence " +
                    'is diagnostic only.',
                errorKind: 'candidate_current_extension_evidence_required',
                retryable: true,
                requiredAction: 'revalidate_candidate_in_current_extension_session',
                candidateRule: canonical,
                currentValidationArtifactId: validationArtifactId,
                currentSessionId: validationEnvironment?.sessionId ?? null,
                guidance: [
                    'Launch the prepared extension with issue-supported settings.',
                    'Call apply_rule with this exact candidate in that session.',
                ],
            };
        }
        const reporterParityRequired = view.requiresCurrentReporterSettings();
        const guidance = [
            'Launch or use a prepared-extension session with the issue-supported settings.',
        ];
        if (reporterParityRequired) {
            guidance.push(
                'Use settings.kind=reported_on_current with the reporter importUrl from fetch_issue, decoding only Markdown &amp; separators.',
            );
        }
        guidance.push(
            'Confirm launch_browser returned settingsVerified=true and settingsEvidence.',
            'Call apply_rule with this exact candidate in that same browser session.',
            'Evidence from another prepared-extension session cannot verify this candidate.',
        );
        return {
            error:
                'A rule proposal requires candidate verification in the same prepared-extension ' +
                'browser session that produced verified settings evidence.' +
                (reporterParityRequired
                    ? ' This issue has an explicit reporter settings import, so the candidate ' +
                      'session must use settings.kind=reported_on_current.'
                    : ''),
            errorKind: reporterParityRequired
                ? 'candidate_reporter_settings_required'
                : 'candidate_environment_evidence_required',
            retryable: true,
            requiredAction: reporterParityRequired
                ? 'revalidate_candidate_with_reported_on_current'
                : 'revalidate_candidate_in_prepared_extension_session',
            candidateRule: canonical,
            currentValidationArtifactId: validationArtifactId,
            currentExtensionMode: validationEnvironment?.extensionMode ?? null,
            currentSessionId: validationEnvironment?.sessionId ?? null,
            guidance,
        };
    }
    return undefined;
}
