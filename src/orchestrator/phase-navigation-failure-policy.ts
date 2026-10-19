/**
 * What `apply_rule` tells the model when a phase browser could not load the reported page, and how
 * many such experiments one rule may spend.
 *
 * Who stopped the navigation decides the answer: a site that refuses automated visits may load on
 * one more experiment, the runner's own refusal meets the same experiment again, and a redirect
 * only the candidate phase made points at the rule rather than at the page.
 */
import type { EnvironmentPhase } from '../environment/environment-proofs';
import { BrowserFallbackOrigin } from '../types/browser-fallback-origin';
import { PhaseLabel } from '../types/validation';
import {
    ExperimentInconclusiveReason,
    type AdsEnvironmentExperimentVerdict,
    type FailedPhaseNavigation,
} from '../validator/ads-environment-experiment-result';

/**
 * Navigation failures one candidate may meet before `apply_rule` stops running experiments for it.
 *
 * Phase browsers are fresh sessions, so a site that refuses automated visits only some of the time
 * may load on a second experiment; a third that meets the same refusal tells nothing new and costs
 * another unfiltered phase with its vision review.
 */
const PHASE_NAVIGATION_FAILURE_LIMIT = 2;

/**
 * What each origin of a failed phase navigation tells the model before the limit.
 */
const NAVIGATION_FAILURE_GUIDANCE: Readonly<Record<BrowserFallbackOrigin, readonly string[]>> = {
    [BrowserFallbackOrigin.Site]: [
        'The site refused the phase browser, so the candidate was never judged; this is not a',
        'verdict on the rule. Every phase opens a fresh browser, so a site that refuses automated',
        'visits only some of the time may load on one more call with the same arguments.',
    ],
    [BrowserFallbackOrigin.Agent]: [
        'The runner itself refused this navigation, for example because the page left the',
        'reported origin; on an anti-adblock report that redirect can be the symptom itself. The',
        'candidate was never judged, and the same experiment meets the same refusal.',
    ],
    [BrowserFallbackOrigin.Infrastructure]: [
        'The phase browser failed before it reached the site, so the candidate was never judged.',
        'One more call with the same arguments may succeed.',
    ],
    [BrowserFallbackOrigin.Indeterminate]: [
        'The phase browser could not load the page, and nothing recorded says whether the site,',
        'the network or the filtering route stopped it. The candidate was never judged; one more',
        'call with the same arguments may succeed.',
    ],
};

/**
 * What the model is told when phase C fails after the unfiltered and baseline phases loaded.
 */
const CANDIDATE_PHASE_NAVIGATION_GUIDANCE = [
    'Phases A and B loaded the page, but phase C, with the candidate applied, did not, so the',
    'candidate was never judged. The failure may be transient or may come from the candidate',
    'itself; one more call with the same arguments tells the two apart.',
];

/**
 * What the model is told when only phase C, with the candidate applied, left the reported origin.
 */
const CANDIDATE_PHASE_REDIRECT_GUIDANCE = [
    'Phases A and B loaded the page on the reported origin, but with the candidate applied phase C',
    'left it, and the runner does not follow a page off the reported origin. Only the candidate',
    'differs between B and C, so it most likely caused the redirect. This rule will not be run',
    'again; change the rule instead of repeating it.',
];

/**
 * What the run remembers about one rule's experiments that a phase browser could not load.
 */
interface NavigationFailureRecord {
    /**
     * Experiments for the rule that ended this way, or the limit once one cannot be repeated.
     */
    count: number;

    /**
     * Whether the latest one left the origin only in the candidate phase, which points at the rule
     * rather than at the page.
     */
    candidateRedirect: boolean;
}

/**
 * Record one more experiment for a rule that a phase browser could not load the page for.
 *
 * The runner's own refusal meets the same experiment again, so it spends the whole limit at once:
 * the next call for the rule is refused before any phase opens, not merely advised against.
 *
 * @param previous - What earlier experiments for this rule recorded, if any ended this way.
 * @param failedNavigation - The failure the latest experiment ended on.
 * @returns The record to keep.
 */
function recordNavigationFailure(
    previous: NavigationFailureRecord | undefined,
    failedNavigation: FailedPhaseNavigation,
): NavigationFailureRecord {
    const ownRefusal = failedNavigation.origin === BrowserFallbackOrigin.Agent;
    return {
        count: ownRefusal ? PHASE_NAVIGATION_FAILURE_LIMIT : (previous?.count ?? 0) + 1,
        candidateRedirect: ownRefusal && failedNavigation.phase === PhaseLabel.C,
    };
}

/**
 * Answer an `apply_rule` call whose phase browser could not load the reported page.
 *
 * The candidate was never judged, and the answer says which phase stopped and why, so the model
 * neither reads it as a verdict on the rule nor repeats the experiment blindly. A refusal of our
 * own is final at once: repeating the experiment meets it again. When only the candidate phase left
 * the origin, the candidate is the likely cause and the model is asked to change it rather than to
 * give up.
 *
 * @param verdict - Verdict of the inconclusive experiment.
 * @param phases - Phases that ran, in order.
 * @param failedNavigation - The phase that stopped, why, and who stopped it.
 * @param seen - The count `recordNavigationFailure` recorded for this rule.
 * @returns The model-facing answer.
 */
function phaseNavigationFailedAnswer(
    verdict: AdsEnvironmentExperimentVerdict,
    phases: readonly EnvironmentPhase[],
    failedNavigation: FailedPhaseNavigation,
    seen: number,
): Record<string, unknown> {
    const ownRefusal = failedNavigation.origin === BrowserFallbackOrigin.Agent;
    const candidatePhase = failedNavigation.phase === PhaseLabel.C;
    const answer = {
        validationSkipped: true,
        environmentExperiment: verdict,
        phases,
        errorKind: ExperimentInconclusiveReason.PhaseNavigationFailed,
        failedPhase: failedNavigation.phase,
        detail: failedNavigation.detail,
    };
    if (candidatePhase && ownRefusal) {
        return { ...answer, retryable: false, guidance: CANDIDATE_PHASE_REDIRECT_GUIDANCE };
    }
    const explanation = candidatePhase
        ? CANDIDATE_PHASE_NAVIGATION_GUIDANCE
        : NAVIGATION_FAILURE_GUIDANCE[failedNavigation.origin];
    if (!ownRefusal && seen < PHASE_NAVIGATION_FAILURE_LIMIT) {
        return { ...answer, retryable: true, guidance: explanation };
    }
    return {
        ...answer,
        retryable: false,
        requiredAction: 'finish_fix_analysis_only',
        guidance: [
            ...(ownRefusal ? explanation : []),
            'This candidate cannot be judged in a controlled experiment. Do not retry it.',
            'Finish analysis-only with this rule as candidateForReview and the phase failure',
            'as unverifiedReason, quoting the detail without naming a cause it does not show.',
        ],
    };
}

/**
 * The run's record of phase navigation failures, per candidate rule.
 *
 * A page that refuses the phase browsers does so whatever the reveal steps, so the record is kept
 * per rule alone.
 */
export class NavigationFailureLedger {
    /**
     * What the experiments for each rule recorded, by rule ledger key.
     */
    private readonly records = new Map<string, NavigationFailureRecord>();

    /**
     * Refuse a rule that already spent its navigation-failure limit, before any phase opens.
     *
     * The answers ask the model to stop through `retryable: false`; this refusal makes the stop
     * hard instead of advisory. A rule whose candidate phase alone left the origin is refused too,
     * but another rule may still verify, so that refusal does not ask the model to finish.
     *
     * @param ruleKey - Ledger key of the candidate rule.
     * @returns The refusal, or null when the rule may run.
     */
    refusal(ruleKey: string): Record<string, unknown> | null {
        const record = this.records.get(ruleKey);
        if (record === undefined || record.count < PHASE_NAVIGATION_FAILURE_LIMIT) {
            return null;
        }
        const errorKind = `${ExperimentInconclusiveReason.PhaseNavigationFailed}_exhausted`;
        return record.candidateRedirect
            ? {
                  validationSkipped: true,
                  errorKind,
                  retryable: false,
                  guidance: [
                      'With this rule applied the page left the reported origin, so it will not be',
                      'run again. Change the rule instead of repeating it.',
                  ],
              }
            : {
                  validationSkipped: true,
                  errorKind,
                  retryable: false,
                  requiredAction: 'finish_fix_analysis_only',
                  guidance: [
                      'The experiments for this rule could not load the reported page in at least one',
                      'phase. Another experiment will not be run. Finish analysis-only with this rule',
                      'as candidateForReview and the phase failure as unverifiedReason.',
                  ],
              };
    }

    /**
     * Record an experiment that ended on a failed navigation and answer it.
     *
     * @param ruleKey - Ledger key of the candidate rule.
     * @param verdict - Verdict of the inconclusive experiment.
     * @param phases - Phases that ran, in order.
     * @param failedNavigation - The phase that stopped, why, and who stopped it.
     * @returns The model-facing answer.
     */
    answer(
        ruleKey: string,
        verdict: AdsEnvironmentExperimentVerdict,
        phases: readonly EnvironmentPhase[],
        failedNavigation: FailedPhaseNavigation,
    ): Record<string, unknown> {
        const record = recordNavigationFailure(this.records.get(ruleKey), failedNavigation);
        this.records.set(ruleKey, record);
        return phaseNavigationFailedAnswer(verdict, phases, failedNavigation, record.count);
    }
}
