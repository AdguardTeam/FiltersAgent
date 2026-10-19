/**
 * Which verdict decides a candidate: the controlled experiment's, never the vision review's alone.
 *
 * The paired review compares the baseline with the candidate phase, and the experiment adds the
 * runner's own checks on top of it — the candidate phase navigated, the symptom is gone from it by
 * the structural probe and the requests too, the page stayed usable, and the reveal steps prepared
 * it like the baseline. So a review can verify a candidate the experiment refuses, and the model,
 * the candidate ledger and the binding all have to hear the experiment.
 *
 * On the extension route the binding is the prepared session's review and its evidence, and it
 * stands only on a verified experiment. On the proxy route the candidate binds through the
 * candidate phase's CLI proof, which only a verified experiment yields; when that proof is missing
 * although the experiment verified, the binding itself is what failed.
 */
import type { CandidateValidationOutcome } from './agent-runtime-candidate-context';
import type { CandidateExperimentCheck } from '../environment/candidate-phase-checks';
import {
    CandidateVisualVerdict,
    type CandidateVisualReview,
} from '../types/candidate-visual-review';
import { MAX_CANDIDATE_VALIDATION_EXECUTIONS } from '../types/candidate-limits';
import type { FinishFixValidationRejection } from '../types/terminal-rejection';
import { PhaseLabel } from '../types/validation';
import {
    AdsEnvironmentExperimentVerdict,
    type AdsEnvironmentExperimentResult,
} from '../validator/ads-environment-experiment-result';

/**
 * The experiment fields of one apply_rule result.
 */
export interface ApplyRuleExperimentFields {
    /**
     * The paired review, when the result carries one.
     */
    review: CandidateVisualReview | undefined;

    /**
     * The controlled experiment's verdict, when the result carries one.
     */
    experiment: AdsEnvironmentExperimentVerdict | undefined;

    /**
     * The runner checks the candidate phase failed, when the result names them.
     */
    failedChecks: CandidateExperimentCheck[] | undefined;
}

/**
 * Read the experiment fields of an apply_rule result.
 *
 * The result is the runner's own: the review, the verdict and the checks are what it produced
 * itself, so they are read as typed, not validated again.
 *
 * @param result - The runner's apply_rule result.
 * @returns The review, the experiment verdict and the failed checks it carries.
 */
export function readExperimentFields(result: Record<string, unknown>): ApplyRuleExperimentFields {
    return {
        review: result.visualReview as CandidateVisualReview | undefined,
        experiment: result.environmentExperiment as AdsEnvironmentExperimentVerdict | undefined,
        failedChecks: result.failedCandidateChecks as CandidateExperimentCheck[] | undefined,
    };
}

/**
 * Add the experiment's verdict to an apply_rule result.
 *
 * Every result carries the verdict. When the review verified the candidate but the experiment did
 * not, the result also states what the candidate phase showed and what the model can still do: the
 * observer's `failedCandidateChecks` already names the checks that withdrew the verdict, and when
 * no check failed — the experiment refused for another reason — the guidance names its verdict.
 *
 * @param result - The observer's apply_rule result, carrying the review and the failed checks.
 * @param experiment - The controlled experiment the result came from.
 * @returns The result with `environmentExperiment`, and with `candidatePhase` and `guidance` when
 *   the experiment refused a verified review.
 */
export function withExperimentVerdict(
    result: Record<string, unknown>,
    experiment: AdsEnvironmentExperimentResult,
): Record<string, unknown> {
    const answered = { ...result, environmentExperiment: experiment.verdict };
    const { review, failedChecks } = readExperimentFields(result);
    if (
        experiment.verdict === AdsEnvironmentExperimentVerdict.Verified ||
        review?.verdict !== CandidateVisualVerdict.Verified
    ) {
        return answered;
    }
    const completion = experiment.phases.find((phase) => phase.phase === PhaseLabel.C)?.completion;
    return {
        ...answered,
        ...(completion?.kind === 'observed'
            ? {
                  candidatePhase: {
                      ...completion.targetObservation,
                      navigationVerified: completion.navigationVerified,
                  },
              }
            : {}),
        guidance: [
            'The controlled experiment did not verify this candidate, although visualReview did:',
            'environmentExperiment decides.',
            failedChecks !== undefined && failedChecks.length > 0
                ? 'failedCandidateChecks names the runner checks the candidate phase failed.'
                : `The experiment ended ${experiment.verdict} without a failed runner check.`,
            'candidatePhase is what that phase showed. New revealSteps or new domChecks this',
            'candidate was not judged under run one more experiment, within the',
            `${MAX_CANDIDATE_VALIDATION_EXECUTIONS} runs one candidate gets in all. Otherwise choose`,
            'a different candidate, or finish analysis_only with this one and this result.',
        ],
    };
}

/**
 * Decide the verdict the candidate ledger records for one apply_rule result.
 *
 * Only the experiment proves a candidate, so a verified review stands only on a verified
 * experiment; any other experiment, or none, turns it into a rejection. A review that did not
 * verify keeps its own verdict: an inconclusive one may still be retried.
 *
 * @param reviewVerdict - The paired review's verdict.
 * @param experimentVerdict - The experiment's verdict, undefined when the result carries none.
 * @returns The verdict that decides the candidate.
 */
export function decidingCandidateVerdict(
    reviewVerdict: CandidateVisualVerdict,
    experimentVerdict: AdsEnvironmentExperimentVerdict | undefined,
): CandidateVisualVerdict {
    if (reviewVerdict !== CandidateVisualVerdict.Verified) {
        return reviewVerdict;
    }
    return experimentVerdict === AdsEnvironmentExperimentVerdict.Verified
        ? CandidateVisualVerdict.Verified
        : CandidateVisualVerdict.Rejected;
}

/**
 * Refuse a draft whose candidate the experiment refused although its review verified it.
 *
 * The same plan cannot change the verdict, so the rejection names the failed checks, or says that
 * none failed, and the ways forward: while the candidate has runs left, an experiment under reveal
 * steps or DOM checks it was not judged under; otherwise a different candidate or analysis_only.
 *
 * @param candidateRule - Canonical candidate rule of the draft.
 * @param outcome - The ledger entry of the candidate's latest experiment.
 * @returns The rejection naming the experiment, not the review, as what withheld the verdict.
 */
export function experimentRefusalRejection(
    candidateRule: string,
    outcome: CandidateValidationOutcome,
): FinishFixValidationRejection {
    return {
        error:
            'The controlled experiment did not verify this candidate, although its vision review ' +
            'did: the experiment is the candidate verification verdict.',
        errorKind: 'candidate_visual_confirmation_required',
        retryable: true,
        requiredAction: 'choose_another_candidate_or_analysis_only',
        candidateRule,
        currentValidationArtifactId: outcome.validationArtifactId ?? null,
        currentVisualVerdict: outcome.visualVerdict ?? null,
        failedCandidateChecks: outcome.failedCandidateChecks ?? [],
        validationAttemptCount: outcome.validationAttemptCount,
        maximumValidationAttempts: MAX_CANDIDATE_VALIDATION_EXECUTIONS,
        sameCandidateRetryAllowed: false,
        guidance: [
            (outcome.failedCandidateChecks ?? []).length > 0
                ? 'failedCandidateChecks names the runner checks the candidate phase failed; environmentExperiment in the apply_rule result decides.'
                : 'The experiment refused the candidate without a failed runner check; environmentExperiment in the apply_rule result names how it ended and decides.',
            ...(outcome.validationAttemptCount < MAX_CANDIDATE_VALIDATION_EXECUTIONS
                ? [
                      `Call apply_rule with new revealSteps or new domChecks this candidate was not judged under to run one more experiment, within the ${MAX_CANDIDATE_VALIDATION_EXECUTIONS} runs one candidate gets in all.`,
                      'Otherwise choose a semantically different candidate, or finish analysis_only.',
                  ]
                : ['Choose a semantically different candidate, or finish analysis_only.']),
        ],
    };
}

/**
 * Refuse a proxy-route candidate whose verified experiment left no candidate binding.
 *
 * The experiment verified the candidate, yet the binding could not be assembled: the candidate
 * phase kept no CLI proof, the validating session ran an extension, or its state is gone. No other
 * session on this route can revalidate the candidate.
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
            'The controlled experiment verified this candidate, but its evidence could not be ' +
            'bound to the draft: the candidate phase kept no CLI proof, or the validating session ' +
            'ran an extension or is gone. On the proxy route no other session can revalidate it.',
        errorKind: 'candidate_experiment_unverified',
        retryable: true,
        requiredAction: 'finish_fix_analysis_only',
        candidateRule,
        currentValidationArtifactId: validationArtifactId,
        guidance: [
            'Finish analysis_only with this candidate, quoting its apply_rule result as the reason it stayed unverified.',
        ],
    };
}
