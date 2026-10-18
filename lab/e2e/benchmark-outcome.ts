import { PROVIDER_REJECTION_PREFIX } from '../../src/pi/single-shot';
import {
    isInfrastructureFallbackReason,
    isTargetEnvironmentFallbackReason,
} from '../../src/types/browser-fallback-origin';
import { CandidateVisualVerdict } from '../../src/types/candidate-visual-review';
import { ExtensionMode, FixRunStatus, type FixRunResult } from '../../src/types/fix-run-result';
import { InfrastructureFailureReason } from '../../src/types/infrastructure-failure-reason';
import { ReporterSymptomPresence } from '../../src/types/reporter-symptom-presence';
import { PhaseLabel } from '../../src/types/validation';
import { VISUAL_REVIEW_UNAVAILABLE_PREFIX } from '../../src/validator/candidate-visual-synthesis';
import { INTAKE_SKIPPED_PREFIX } from '../local/local-failure-stage';

/**
 * Outcome of one benchmark case, read from the agent's own sealed result.
 *
 * The agent outcomes are ordered from the strongest to the weakest. The human fix is trusted as
 * written and never re-checked in a browser: a case whose fix no longer applies shows up as a case
 * that no model reproduces.
 */
export const BenchmarkCaseStatus = {
    /**
     * The agent proposed a rule and verified it in the browser with `apply_rule`: a
     * `patch_proposed` result.
     */
    Verified: 'verified',
    /**
     * The agent found a rule it could not verify and carried it for review.
     */
    Proposed: 'proposed',
    /**
     * The agent reproduced the reported problem with the prepared blocker but proposed no rule.
     */
    Reproduced: 'reproduced',
    /**
     * The agent neither reproduced the problem nor proposed a rule.
     */
    NotReproduced: 'not_reproduced',
    /**
     * The run failed for a reason outside the model's work; `failureKind` says which.
     */
    InfrastructureFailure: 'infrastructure_failure',
    /**
     * The case site did not answer before the run, so the agent was not started.
     */
    SiteUnreachable: 'site_unreachable',
} as const;

/**
 * Value of the benchmark case outcome.
 */
export type BenchmarkCaseStatus = (typeof BenchmarkCaseStatus)[keyof typeof BenchmarkCaseStatus];

/**
 * Agent outcomes from the strongest to the weakest, for ranking repetitions of one case.
 */
export const AGENT_OUTCOME_RANKING: readonly BenchmarkCaseStatus[] = [
    BenchmarkCaseStatus.Verified,
    BenchmarkCaseStatus.Proposed,
    BenchmarkCaseStatus.Reproduced,
    BenchmarkCaseStatus.NotReproduced,
];

export const BenchmarkFailureKind = {
    /**
     * The model provider refused a request; the same request fails again, so it counts against the
     * model.
     */
    ProviderRejected: 'provider_rejected',
    /**
     * The agent's intake declined a golden issue as outside its task.
     */
    IntakeSkipped: 'intake_skipped',
    /**
     * A retryable outage: network, browser, provider availability or case tooling.
     */
    Transient: 'transient',
} as const;

/**
 * Whether a failed run is a provider rejection, an intake skip, or a retryable outage.
 */
export type BenchmarkFailureKind = (typeof BenchmarkFailureKind)[keyof typeof BenchmarkFailureKind];

/**
 * Status, failure kind and failure detail of one sealed agent result.
 */
export interface AgentOutcome {
    /**
     * Strongest milestone the agent reached, or an infrastructure failure.
     */
    status: BenchmarkCaseStatus;
    /**
     * Failure classification for an infrastructure failure, otherwise null.
     */
    failureKind: BenchmarkFailureKind | null;
    /**
     * What failed or did not answer, for an infrastructure failure or an unreachable site; null for
     * an agent outcome.
     */
    detail: string | null;
}

/**
 * Decide whether the locked run failed before producing comparable agent behavior, and say why.
 *
 * A run-level failure is explained by the run's own reasoning. A visual review that could not run
 * is explained by the review's rationale, which names what the vision provider did — refused the
 * request or failed to answer — where the agent's reasoning only reports what it concluded around
 * the missing review.
 *
 * @param result - Locked core result.
 * @returns The failure detail for explicitly identified browser, build, LLM, or vision failures;
 *   null otherwise.
 */
function infrastructureRunFailureDetail(result: FixRunResult): string | null {
    if (
        result.infrastructureFailureReason !== undefined ||
        (result.runStatus === FixRunStatus.BrowserUnavailable &&
            !isTargetEnvironmentFallbackReason(result.fallbackReason ?? null)) ||
        isInfrastructureFallbackReason(result.fallbackReason ?? null)
    ) {
        return result.reasoning;
    }
    const review = result.candidateVisualReview;
    if (
        review?.verdict === CandidateVisualVerdict.Inconclusive &&
        review.rationale.startsWith(VISUAL_REVIEW_UNAVAILABLE_PREFIX)
    ) {
        return review.rationale;
    }
    return null;
}

/**
 * Distinguish agent provider rejections and intake skips from retryable failures.
 *
 * @param runResult - Sealed agent result of the failed case, or null when none was read.
 * @returns Provider rejection, intake skip, or transient failure.
 */
export function benchmarkFailureKind(runResult: FixRunResult | null): BenchmarkFailureKind {
    if (
        runResult?.infrastructureFailureReason === InfrastructureFailureReason.LlmRejected ||
        (runResult?.infrastructureFailureReason === InfrastructureFailureReason.InputUnavailable &&
            runResult.reasoning.includes(PROVIDER_REJECTION_PREFIX)) ||
        runResult?.candidateVisualReview?.rationale.includes(PROVIDER_REJECTION_PREFIX)
    ) {
        return BenchmarkFailureKind.ProviderRejected;
    }
    if (
        runResult?.infrastructureFailureReason === InfrastructureFailureReason.InputUnavailable &&
        runResult.reasoning.includes(INTAKE_SKIPPED_PREFIX)
    ) {
        return BenchmarkFailureKind.IntakeSkipped;
    }
    return BenchmarkFailureKind.Transient;
}

/**
 * Whether the agent's own check with the prepared blocker counted the reported problem as present.
 *
 * The problem the reporter had is the one the prepared blocker leaves on the page before any
 * candidate. The unfiltered session shows only that the site serves the ad, and phase C shows what
 * the candidate did, so neither counts. Nor does `symptomObservation`: the run sets it from the
 * terminal decision for the publication gate, so every analysis-only result carries
 * `indeterminate`.
 *
 * The result carries `environmentExecution` as soon as an `apply_rule` experiment prepared the
 * environment, and its browser sessions are then the projected phases in place of the sessions the
 * agent launched. Such a result is read from an observed phase B of any experiment only: a run
 * refused after preparation — an environment that never became ready — or one whose phase B failed
 * counts as not reproduced, even when the agent's own prepared session showed the problem. A call
 * refused before the environment is built, such as an edit the extension route cannot run or a call
 * from a session without the reporter's settings import, prepares nothing. Only a result without
 * `environmentExecution` is read from the prepared sessions the agent launched.
 *
 * The two sources hold different bars. Phase B counts when its `targetObservation.symptomPresent`
 * is set, and the runner sets it unless vision found the symptom absent, so an indeterminate
 * classification counts. A prepared session counts only with a vision-verified, complete capture
 * classified `present`.
 *
 * @param result - Schema-validated result loaded from run-result.json.
 * @returns Whether a baseline phase or a prepared session counted the reported problem as present.
 */
function preparedBlockerShowedSymptom(result: FixRunResult): boolean {
    const execution = result.environmentExecution;
    if (execution !== undefined) {
        return execution.phases.some(
            ({ phase, completion }) =>
                phase === PhaseLabel.B &&
                completion.kind === 'observed' &&
                completion.navigationVerified &&
                completion.targetObservation.symptomPresent,
        );
    }
    return (result.browserSessions ?? []).some(
        (session) =>
            session.extensionMode === ExtensionMode.Prepared &&
            session.navigationVerified &&
            session.captures.some(
                (capture) =>
                    capture.visionVerified &&
                    capture.coverageComplete &&
                    capture.reporterSymptomPresence === ReporterSymptomPresence.Present,
            ),
    );
}

/**
 * Read the strongest milestone from the agent's own sealed result.
 *
 * A verified rule is a `patch_proposed` result, which the result schema admits only with a verified
 * review; the benchmark does not repeat that check. A rule the agent could not verify never becomes
 * a candidate patch: it travels as `candidateForReview` on a report-only result.
 *
 * @param result - Schema-validated result loaded from run-result.json.
 * @returns Agent outcome, or an infrastructure failure with its kind and detail.
 */
export function classifyAgentOutcome(result: FixRunResult): AgentOutcome {
    const failure = infrastructureRunFailureDetail(result);
    if (failure !== null) {
        return {
            status: BenchmarkCaseStatus.InfrastructureFailure,
            failureKind: benchmarkFailureKind(result),
            detail: failure,
        };
    }
    if (result.runStatus === FixRunStatus.PatchProposed) {
        return { status: BenchmarkCaseStatus.Verified, failureKind: null, detail: null };
    }
    if (result.candidateForReview !== undefined) {
        return { status: BenchmarkCaseStatus.Proposed, failureKind: null, detail: null };
    }
    return {
        status: preparedBlockerShowedSymptom(result)
            ? BenchmarkCaseStatus.Reproduced
            : BenchmarkCaseStatus.NotReproduced,
        failureKind: null,
        detail: null,
    };
}
