/**
 * How a candidate that its vision review verified can still fail on the proxy route.
 *
 * On the extension route the review of a prepared session is the candidate's proof. On the proxy
 * route the proof is the controlled experiment itself: the candidate binds through the candidate
 * phase's CLI proof, which only a verified experiment yields. The experiment adds its own checks to
 * the review — the candidate phase must not show the symptom, and a host block must stop every
 * request to its host — so the two can disagree, and the model has to hear which one decided.
 */
import type { FinishFixValidationRejection } from '../types/terminal-rejection';
import { PhaseLabel } from '../types/validation';
import {
    AdsEnvironmentExperimentVerdict,
    type AdsEnvironmentExperimentResult,
} from '../validator/phase-orchestrator';

/**
 * Add the experiment's verdict to an apply_rule result on the proxy route.
 *
 * @param result - The observer's apply_rule result, carrying the vision review.
 * @param experiment - The controlled experiment the result came from.
 * @returns The result, with the verdict and the candidate phase's own findings when the experiment
 *   did not verify the candidate.
 */
export function withCliExperimentVerdict(
    result: Record<string, unknown>,
    experiment: AdsEnvironmentExperimentResult,
): Record<string, unknown> {
    if (experiment.verdict === AdsEnvironmentExperimentVerdict.Verified) {
        return result;
    }
    const completion = experiment.phases.find((phase) => phase.phase === PhaseLabel.C)?.completion;
    return {
        ...result,
        environmentExperiment: experiment.verdict,
        ...(completion?.kind === 'observed'
            ? {
                  candidatePhase: {
                      ...completion.targetObservation,
                      navigationVerified: completion.navigationVerified,
                  },
              }
            : {}),
        guidance: [
            'The controlled experiment did not verify this candidate, whatever visualReview says:',
            'candidatePhase names what the candidate phase still showed. On this route only a',
            'verified experiment proves a candidate. Choose a different candidate, or finish',
            'analysis_only with this one and this result.',
        ],
    };
}

/**
 * Refuse a proxy-route candidate whose experiment did not verify it.
 *
 * @param candidateRule - Canonical candidate rule of the draft.
 * @param validationArtifactId - The candidate's latest validation identity.
 * @returns The rejection naming what the model can still do on this route.
 */
export function cliCandidateUnverifiedRejection(
    candidateRule: string,
    validationArtifactId: string,
): FinishFixValidationRejection {
    return {
        error:
            'The controlled experiment did not verify this candidate, although its vision review ' +
            'did. On the proxy route the experiment is the proof, and there is no extension ' +
            'session to revalidate the candidate in.',
        errorKind: 'candidate_experiment_unverified',
        retryable: true,
        requiredAction: 'choose_another_candidate_or_analysis_only',
        candidateRule,
        currentValidationArtifactId: validationArtifactId,
        guidance: [
            'Read environmentExperiment and candidatePhase in the apply_rule result for this candidate.',
            'Choose a different candidate, or finish analysis_only with this candidate and that result.',
        ],
    };
}
