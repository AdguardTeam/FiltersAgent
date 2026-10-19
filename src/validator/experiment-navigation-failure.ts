/**
 * A phase browser that could not load the reported page.
 *
 * The site, not the environment, stopped such a phase: it answered the phase browser with an HTTP
 * error or never answered. The experiment cannot compare states it never captured, so it ends
 * inconclusive and says which phase stopped and why.
 */
import { PUBLIC_DETAIL_MAX_LENGTH } from '../environment/environment-proofs';
import {
    EnvironmentAdapterLimitationCode,
    type EnvironmentPhaseEvidence,
} from '../environment/filtering-environment';
import type { PhaseLabel, PhaseResult } from '../types/validation';
import { BrowserFallbackOrigin, browserFallbackOrigin } from '../types/browser-fallback-origin';
import {
    AdsEnvironmentExperimentVerdict,
    ExperimentInconclusiveReason,
    type AdsEnvironmentExperimentResult,
    type FailedPhaseNavigation,
} from './ads-environment-experiment-result';

/**
 * Recognize a phase whose browser could not load the reported page.
 *
 * Such a phase completes — its session opened and closed cleanly — so the environment is sound;
 * only the page stopped the comparison.
 *
 * @param evidence - Completed phase evidence.
 * @returns The failed navigation, or null when the phase loaded its page.
 */
export function failedPhaseNavigation(
    evidence: EnvironmentPhaseEvidence,
): FailedPhaseNavigation | null {
    const { completion } = evidence;
    if (
        completion.kind !== 'failed' ||
        completion.limitation.code !== EnvironmentAdapterLimitationCode.PhaseNavigationFailed
    ) {
        return null;
    }
    return {
        phase: evidence.phase,
        detail: completion.limitation.detail,
        origin:
            completion.navigationFallbackReason === undefined
                ? BrowserFallbackOrigin.Indeterminate
                : browserFallbackOrigin(completion.navigationFallbackReason),
    };
}

/**
 * State why one phase browser could not load the reported page, in the words the model and the run
 * result read.
 *
 * @param phase - Phase whose navigation failed.
 * @param result - The phase runner's facts, carrying the navigation error.
 * @returns Bounded public detail naming the phase, the error and its classification.
 */
export function describePhaseNavigationFailure(phase: PhaseLabel, result: PhaseResult): string {
    const reason = result.navigationFallbackReason ? ` (${result.navigationFallbackReason})` : '';
    return `Phase ${phase} navigation failed${reason}: ${result.error ?? 'unknown error'}`.slice(
        0,
        PUBLIC_DETAIL_MAX_LENGTH,
    );
}

/**
 * End an experiment whose phase could not load the page: the candidate was never judged.
 *
 * @param phases - Phase evidence recorded so far.
 * @param failedNavigation - The phase that stopped and why.
 * @returns Inconclusive result naming the failed phase.
 */
export function navigationFailedResult(
    phases: EnvironmentPhaseEvidence[],
    failedNavigation: FailedPhaseNavigation,
): AdsEnvironmentExperimentResult {
    return {
        verdict: AdsEnvironmentExperimentVerdict.Inconclusive,
        phases,
        limitation: null,
        inconclusiveReason: ExperimentInconclusiveReason.PhaseNavigationFailed,
        failedNavigation,
    };
}
