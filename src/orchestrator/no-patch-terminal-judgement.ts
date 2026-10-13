import { ReporterSymptomPresence } from '../types/reporter-symptom-presence';
import type { FinishFixValidationRejection } from '../types/terminal-rejection';
import { FixOutcomeKind, type FixOutcome } from '../types/fix-outcome';
import { FixRunStatus } from '../types/fix-run-result';
import { TargetAccessClassification } from '../environment/target-access';

/**
 * Structured reporter-symptom conclusion bound to one complete browser session.
 */
export interface TerminalSymptomPresenceEvidence {
    /**
     * Browser session that owns the classified full-page capture.
     */
    sessionId: string;

    /**
     * Vision-owned presence of the exact reporter-defined symptom.
     */
    presence: ReporterSymptomPresence;

    /**
     * Whether the same capture could show the reported content at all.
     */
    access: TargetAccessClassification;
}

/**
 * Which of the two no-patch verdicts the model's terminal decision claims.
 */
interface NoPatchClaims {
    /**
     * The decision claims the current filters already fix the report.
     */
    alreadyFixed: boolean;

    /**
     * The decision claims the reported symptom did not reproduce.
     */
    notReproduced: boolean;
}

/**
 * Whether a terminal decision claims the reported defect needs no patch, and which claim it makes.
 *
 * @param outcome - Schema-valid terminal decision proposed by the model.
 * @returns The two no-patch claims, both false for every other decision.
 */
function noPatchClaims(outcome: FixOutcome): NoPatchClaims {
    return {
        alreadyFixed:
            outcome.outcome === FixOutcomeKind.ResolveWithoutPatch &&
            outcome.runStatus === FixRunStatus.AlreadyFixedCurrent,
        notReproduced:
            (outcome.outcome === FixOutcomeKind.ResolveWithoutPatch &&
                outcome.runStatus === FixRunStatus.NotReproduced) ||
            (outcome.outcome === FixOutcomeKind.ProposeClose &&
                outcome.reproductionStatus === 'not_reproduced'),
    };
}

/**
 * The environment whose page withheld the reported content, and how.
 */
interface WithheldEnvironmentAccess {
    /**
     * Human-readable name of the offending environment.
     */
    environment: string;

    /**
     * The access classification that disqualifies its observation.
     */
    classification: TargetAccessClassification;
}

/**
 * Name the first session whose page withheld the reported content.
 *
 * A geo-blocked player, a login wall, or a bot challenge makes an absent symptom meaningless: the
 * run never saw the state the reporter described. Without this check, a pre-roll behind a regional
 * block or a popup behind a login wall is published as `not_reproduced` on exactly this evidence.
 *
 * @param control - Symptom evidence of the unfiltered control session, when one exists.
 * @param prepared - Symptom evidence of the prepared-extension session, when one exists.
 * @returns The offending environment and its classification, or undefined when both could see the
 *   page.
 */
function withheldAccess(
    control: TerminalSymptomPresenceEvidence | undefined,
    prepared: TerminalSymptomPresenceEvidence | undefined,
): WithheldEnvironmentAccess | undefined {
    const environments = [
        { environment: 'unfiltered control', classification: control?.access },
        { environment: 'prepared-extension', classification: prepared?.access },
    ];
    for (const candidate of environments) {
        if (
            candidate.classification !== undefined &&
            candidate.classification !== TargetAccessClassification.Accessible
        ) {
            return {
                environment: candidate.environment,
                classification: candidate.classification,
            };
        }
    }
    return undefined;
}

/**
 * Judge a no-patch claim against the vision-owned symptom presence of both environments.
 *
 * Pure on purpose: the runtime gathers the two observations from its session states, and this
 * decides what they permit. Keeping the judgement separate from the gathering is what makes the
 * matrix testable without a browser, a runtime, or a session.
 *
 * @param outcome - Schema-valid terminal decision proposed by the model.
 * @param control - Reporter-symptom presence proven without AdGuard, when one exists.
 * @param prepared - Reporter-symptom presence proven with the prepared extension, when one exists.
 * @returns Retryable rejection when the evidence does not support the claim, else undefined.
 */
export function judgeNoPatchSymptomMatrix(
    outcome: FixOutcome,
    control: TerminalSymptomPresenceEvidence | undefined,
    prepared: TerminalSymptomPresenceEvidence | undefined,
): FinishFixValidationRejection | undefined {
    const { alreadyFixed: claimsAlreadyFixed, notReproduced: claimsNotReproduced } =
        noPatchClaims(outcome);
    if (!claimsAlreadyFixed && !claimsNotReproduced) {
        return undefined;
    }

    const withheld = withheldAccess(control, prepared);
    if (withheld) {
        return {
            error:
                'A no-patch status requires a session that could actually see the reported ' +
                `content: the ${withheld.environment} session was ${withheld.classification}. ` +
                'An absent symptom on a page that withheld what was reported proves nothing.',
            errorKind: 'no_patch_target_not_observable',
            retryable: true,
            requiredAction: 'finish_fix_analysis_only',
            targetAccess: {
                unfilteredControl: control?.access ?? 'unknown',
                preparedExtension: prepared?.access ?? 'unknown',
            },
            guidance: [
                'Finish with analysis_only and record what blocked observation.',
                'State the candidate rule the reported mechanism would need, for human review.',
                'Do not report not_reproduced or already_fixed_current from a gated page.',
            ],
        };
    }

    const evidence = {
        unfilteredControl: control?.presence ?? 'missing',
        preparedExtension: prepared?.presence ?? 'missing',
        unfilteredSessionId: control?.sessionId ?? null,
        preparedSessionId: prepared?.sessionId ?? null,
    };
    if (
        claimsAlreadyFixed &&
        control?.presence === ReporterSymptomPresence.Present &&
        prepared?.presence === ReporterSymptomPresence.Absent
    ) {
        return undefined;
    }
    if (claimsNotReproduced) {
        const observations = [control, prepared].filter(
            (observation): observation is TerminalSymptomPresenceEvidence =>
                observation !== undefined,
        );
        if (
            observations.length > 0 &&
            observations.every(
                (observation) => observation.presence === ReporterSymptomPresence.Absent,
            )
        ) {
            return undefined;
        }
    }

    const absentInBoth =
        control?.presence === ReporterSymptomPresence.Absent &&
        prepared?.presence === ReporterSymptomPresence.Absent;
    let guidance: string[];
    if (absentInBoth) {
        guidance = [
            'Call finish_fix again with resolve_without_patch and runStatus=not_reproduced.',
            'Do not claim that current filters fixed a symptom that was absent unfiltered.',
        ];
    } else {
        guidance = [
            'Use already_fixed_current only for unfiltered=present and prepared=absent.',
            'Use not_reproduced only when every classified environment is absent.',
            'Use analysis_only when structured vision is missing or indeterminate.',
        ];
    }
    return {
        error: claimsAlreadyFixed
            ? absentInBoth
                ? 'already_fixed_current is inconsistent with vision: the exact reporter ' +
                  'symptom is absent in both unfiltered and prepared-extension sessions. '
                : 'already_fixed_current requires the exact reporter symptom to be present ' +
                  'unfiltered and absent with the prepared extension. '
            : 'not_reproduced requires the exact reporter symptom to be absent in every ' +
              'classified browser environment. ',
        errorKind: 'report_only_status_evidence_mismatch',
        retryable: true,
        requiredAction: absentInBoth
            ? 'finish_fix_not_reproduced'
            : 'choose_status_consistent_with_visual_evidence',
        reporterSymptomEvidence: evidence,
        guidance,
    };
}
