import { describe, expect, it } from 'vitest';
import { CandidateExperimentCheck } from '../../src/environment/candidate-phase-checks';
import type { EnvironmentPhaseEvidence } from '../../src/environment/filtering-environment';
import {
    decidingCandidateVerdict,
    experimentRefusalRejection,
    withExperimentVerdict,
} from '../../src/orchestrator/candidate-experiment-verdict';
import { MAX_CANDIDATE_VALIDATION_EXECUTIONS } from '../../src/types/candidate-limits';
import { CandidateVisualVerdict } from '../../src/types/candidate-visual-review';
import { PhaseLabel } from '../../src/types/validation';
import {
    AdsEnvironmentExperimentVerdict,
    type AdsEnvironmentExperimentResult,
} from '../../src/validator/ads-environment-experiment-result';

/**
 * Build the observer's apply_rule result around one review verdict.
 *
 * @param verdict - The paired review's verdict.
 * @param failedCandidateChecks - The runner checks the candidate phase failed.
 * @returns The result as the observer hands it over.
 */
function observerResult(
    verdict: CandidateVisualVerdict,
    failedCandidateChecks: CandidateExperimentCheck[] = [],
): Record<string, unknown> {
    return {
        validationArtifactId: 'validation-0123456789ab',
        visualReview: { verdict, validationArtifactId: 'validation-0123456789ab' },
        failedCandidateChecks,
    };
}

/**
 * Build an experiment whose candidate phase completed with the given observation.
 *
 * @param verdict - The experiment's verdict.
 * @returns The experiment the observer's result came from.
 */
function experimentWith(verdict: AdsEnvironmentExperimentVerdict): AdsEnvironmentExperimentResult {
    const candidatePhase = {
        phase: PhaseLabel.C,
        completion: {
            kind: 'observed',
            navigationVerified: true,
            targetObservation: { symptomPresent: false, pageUsable: true },
        },
    } as unknown as EnvironmentPhaseEvidence;
    return { verdict, phases: [candidatePhase], limitation: null };
}

describe('withExperimentVerdict', () => {
    it.each([
        {
            case: 'a verified experiment',
            review: CandidateVisualVerdict.Verified,
            experiment: AdsEnvironmentExperimentVerdict.Verified,
        },
        {
            case: 'a review the experiment had nothing to overrule',
            review: CandidateVisualVerdict.Rejected,
            experiment: AdsEnvironmentExperimentVerdict.Inconclusive,
        },
    ])('adds only the verdict when the experiment verified, or for $case', (scenario) => {
        const result = observerResult(scenario.review);

        expect(withExperimentVerdict(result, experimentWith(scenario.experiment))).toEqual({
            ...result,
            environmentExperiment: scenario.experiment,
        });
    });

    it('names the failed checks when the experiment refused a verified review', () => {
        const result = observerResult(CandidateVisualVerdict.Verified, [
            CandidateExperimentCheck.RevealStepsPreparedAlike,
        ]);

        const answer = withExperimentVerdict(
            result,
            experimentWith(AdsEnvironmentExperimentVerdict.Inconclusive),
        );

        expect(answer).toMatchObject({
            environmentExperiment: AdsEnvironmentExperimentVerdict.Inconclusive,
            failedCandidateChecks: [CandidateExperimentCheck.RevealStepsPreparedAlike],
            candidatePhase: { symptomPresent: false, pageUsable: true, navigationVerified: true },
        });
        // The guidance points the model at the field that says why, and at the one way the same
        // candidate earns another experiment.
        const guidance = (answer.guidance as string[]).join(' ');
        expect(guidance).toContain('failedCandidateChecks');
        expect(guidance).toContain('revealSteps');
    });

    it('names the verdict when the experiment refused a verified review without a failed check', () => {
        const answer = withExperimentVerdict(
            observerResult(CandidateVisualVerdict.Verified),
            experimentWith(AdsEnvironmentExperimentVerdict.Inconclusive),
        );

        // An empty failedCandidateChecks explains nothing, so the guidance does not send the model
        // there and says how the experiment ended instead.
        const guidance = (answer.guidance as string[]).join(' ');
        expect(guidance).toContain(AdsEnvironmentExperimentVerdict.Inconclusive);
        expect(guidance).not.toContain('failedCandidateChecks');
    });
});

describe('decidingCandidateVerdict', () => {
    it.each([
        {
            review: CandidateVisualVerdict.Verified,
            experiment: AdsEnvironmentExperimentVerdict.Verified,
            decided: CandidateVisualVerdict.Verified,
        },
        {
            review: CandidateVisualVerdict.Verified,
            experiment: AdsEnvironmentExperimentVerdict.Inconclusive,
            decided: CandidateVisualVerdict.Rejected,
        },
        {
            review: CandidateVisualVerdict.Verified,
            experiment: undefined,
            decided: CandidateVisualVerdict.Rejected,
        },
        {
            review: CandidateVisualVerdict.Inconclusive,
            experiment: AdsEnvironmentExperimentVerdict.Inconclusive,
            decided: CandidateVisualVerdict.Inconclusive,
        },
        {
            review: CandidateVisualVerdict.Rejected,
            experiment: AdsEnvironmentExperimentVerdict.Inconclusive,
            decided: CandidateVisualVerdict.Rejected,
        },
    ])(
        'records a verified review the experiment refused as rejected: $review review, $experiment experiment',
        ({ review, experiment, decided }) => {
            expect(decidingCandidateVerdict(review, experiment)).toBe(decided);
        },
    );
});

describe('experimentRefusalRejection', () => {
    it.each([
        { validationAttemptCount: 1, rerunOffered: true },
        { validationAttemptCount: MAX_CANDIDATE_VALIDATION_EXECUTIONS, rerunOffered: false },
    ])(
        'offers a new reveal-steps or DOM-checks experiment only while runs are left: $validationAttemptCount run(s)',
        ({ validationAttemptCount, rerunOffered }) => {
            const rejection = experimentRefusalRejection('example.org##.ad', {
                attemptNumber: 1,
                validationAttemptCount,
                validationArtifactId: 'validation-0123456789ab',
                visualVerdict: CandidateVisualVerdict.Rejected,
                reviewVerdict: CandidateVisualVerdict.Verified,
                failedCandidateChecks: [CandidateExperimentCheck.RevealStepsPreparedAlike],
            });

            expect(rejection).toMatchObject({
                errorKind: 'candidate_visual_confirmation_required',
                failedCandidateChecks: [CandidateExperimentCheck.RevealStepsPreparedAlike],
            });
            expect((rejection.guidance as string[]).join(' ').includes('revealSteps')).toBe(
                rerunOffered,
            );
        },
    );

    it('does not point at an empty failedCandidateChecks', () => {
        const rejection = experimentRefusalRejection('example.org##.ad', {
            attemptNumber: 1,
            validationAttemptCount: 1,
            validationArtifactId: 'validation-0123456789ab',
            visualVerdict: CandidateVisualVerdict.Rejected,
            reviewVerdict: CandidateVisualVerdict.Verified,
            failedCandidateChecks: [],
        });

        const guidance = (rejection.guidance as string[]).join(' ');
        expect(guidance).not.toContain('failedCandidateChecks');
        expect(guidance).toContain('environmentExperiment');
    });
});
