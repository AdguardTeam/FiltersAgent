import { describe, expect, it } from 'vitest';
import type { InteractionReplayProjection } from '../../src/environment/interaction-replay';
import { SafeInteractionRecordStatus } from '../../src/environment/safe-interaction';
import {
    baselineSymptomAbsentAnswer,
    type BaselineSymptomAbsentFacts,
} from '../../src/orchestrator/baseline-symptom-absent-answer';
import { SelectorSource } from '../../src/types/overruled-selector';
import { PhaseLabel } from '../../src/types/validation';
import { AdsEnvironmentExperimentVerdict } from '../../src/validator/ads-environment-experiment-result';

/**
 * A reveal plan of one wait, which every phase performed to the end.
 */
const ONE_WAIT_PERFORMED: InteractionReplayProjection = {
    planDigest: 'a'.repeat(64),
    phases: {
        [PhaseLabel.A]: {
            status: SafeInteractionRecordStatus.Completed,
            refusalReason: null,
            executedSteps: 1,
            popupsOpened: 0,
        },
        [PhaseLabel.B]: {
            status: SafeInteractionRecordStatus.Completed,
            refusalReason: null,
            executedSteps: 1,
            popupsOpened: 0,
        },
    },
    identical: true,
    differences: [],
};

/**
 * The facts of a first experiment that ended on a baseline without the symptom after phases A and
 * B, with no reveal steps and no selector to blame.
 */
const FIRST_ABSENCE: BaselineSymptomAbsentFacts = {
    verdict: AdsEnvironmentExperimentVerdict.Inconclusive,
    phases: [PhaseLabel.A, PhaseLabel.B],
    seen: 1,
    blockedHost: undefined,
    revealSteps: null,
    revealStepsRequested: false,
    unmatchedBaselineSelector: null,
    overruledSelector: null,
};

/**
 * Join an answer's guidance lines into one text.
 *
 * @param answer - The apply_rule answer.
 * @returns The guidance as one string.
 */
function guidanceOf(answer: Record<string, unknown>): string {
    return (answer.guidance as string[]).join(' ');
}

describe('baselineSymptomAbsentAnswer', () => {
    it('states the unmatched selector and always offers reveal steps', () => {
        // The page defers its ad scripts until a click or a scroll; a plan of one wait never
        // brought the element in, yet the model needs to hear how to reveal it.
        const answer = baselineSymptomAbsentAnswer({
            ...FIRST_ABSENCE,
            revealSteps: ONE_WAIT_PERFORMED,
            revealStepsRequested: true,
            unmatchedBaselineSelector: '.code-block-1',
        });

        expect(answer).toMatchObject({
            validationSkipped: true,
            errorKind: 'baseline_symptom_absent',
            retryable: true,
            unmatchedBaselineSelector: '.code-block-1',
            phases: [PhaseLabel.A, PhaseLabel.B],
        });
        expect(guidanceOf(answer)).toContain('revealSteps');
        expect(guidanceOf(answer)).toContain('interact_page');
        expect(guidanceOf(answer)).not.toContain('symptomDescription');
    });

    it('keeps the symptom restatement when no selector was the cause', () => {
        const answer = baselineSymptomAbsentAnswer(FIRST_ABSENCE);

        expect(answer).toMatchObject({ errorKind: 'baseline_symptom_absent', retryable: true });
        expect(answer).not.toHaveProperty('unmatchedBaselineSelector');
        expect(guidanceOf(answer)).toContain('symptomDescription');
    });

    it.each([
        { source: SelectorSource.Rule, dropAdvised: false },
        { source: SelectorSource.AdElementSelector, dropAdvised: true },
    ])('advises dropping adElementSelector only when the model passed it: $source', (row) => {
        const answer = baselineSymptomAbsentAnswer({
            ...FIRST_ABSENCE,
            overruledSelector: { selector: '.player', source: row.source },
        });

        // Telling the model to drop a selector it never passed repeats the same experiment.
        const guidance = guidanceOf(answer);
        expect(guidance.includes('without adElementSelector')).toBe(row.dropAdvised);
        expect(guidance).toContain('.player');
    });

    it('asks to finish analysis-only on the second absence', () => {
        const answer = baselineSymptomAbsentAnswer({
            ...FIRST_ABSENCE,
            seen: 2,
            unmatchedBaselineSelector: '.code-block-1',
        });

        expect(answer).toMatchObject({
            errorKind: 'baseline_symptom_absent',
            retryable: false,
            requiredAction: 'finish_fix_analysis_only',
            unmatchedBaselineSelector: '.code-block-1',
        });
    });
});
