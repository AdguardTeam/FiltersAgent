import { GoldenE2EExitCode } from './golden-exit-code';
import {
    candidateMatches,
    compareCandidates,
    renderCandidateComparison,
} from './golden-candidate-comparison';
import { normalizeRule } from '../../src/repo/rule-normalizer';
import {
    FixRunStatus,
    SymptomObservation,
    VerificationStatus,
    type FixRunResult,
} from '../../src/types/fix-run-result';
import { VISUAL_REVIEW_UNAVAILABLE_PREFIX } from '../../src/validator/candidate-visual-synthesis';
import {
    GoldenAgentEnvironmentStatus,
    type GoldenAgentEnvironmentAssessment,
} from './golden-agent-environment';
import type { ExtractedHumanFix, HumanFixCandidate } from './human-commit-oracle';
import { CandidateVisualVerdict } from '../../src/types/candidate-visual-review';
import {
    isInfrastructureFallbackReason,
    isTargetEnvironmentFallbackReason,
} from '../../src/types/browser-fallback-origin';

/**
 * Terminal outcome of one manual golden E2E case.
 */
export const GoldenE2EStatus = {
    /**
     * The locked agent result matches a browser-confirmed human change.
     */
    Pass: 'pass',

    /**
     * The locked agent result diverges from the browser-confirmed human change.
     */
    AgentRegression: 'agent_regression',

    /**
     * No human commit candidate still fixes the reporter-visible defect.
     */
    EnvironmentDrift: 'environment_drift',

    /**
     * The run or the oracle probe could not be completed.
     */
    InfrastructureFailure: 'infrastructure_failure',
} as const;

/**
 * GoldenE2EStatus value.
 */
export type GoldenE2EStatus = (typeof GoldenE2EStatus)[keyof typeof GoldenE2EStatus];

/**
 * Whether an independent browser probe confirmed a human commit candidate fixes the defect.
 */
export const GoldenOracleProbeStatus = {
    /**
     * The human rule fixes the reporter-visible defect in the pinned environment.
     */
    Verified: 'verified',

    /**
     * The human rule does not fix the reporter-visible defect in the pinned environment.
     */
    NotVerified: 'not_verified',

    /**
     * The probe could not be completed.
     */
    InfrastructureFailure: 'infrastructure_failure',
} as const;

/**
 * GoldenOracleProbeStatus value.
 */
export type GoldenOracleProbeStatus =
    (typeof GoldenOracleProbeStatus)[keyof typeof GoldenOracleProbeStatus];

/**
 * Result returned by an independent browser probe of one human commit candidate.
 */
export interface GoldenOracleProbeResult {
    /**
     * Whether this human rule fixes the reporter-visible defect in the pinned environment.
     */
    status: GoldenOracleProbeStatus;

    /**
     * Human-readable browser/vision evidence or failure explanation.
     */
    detail: string;
}

/**
 * Independently validate one extracted human rule after the agent result is locked.
 */
export type GoldenOracleProbe = (candidate: HumanFixCandidate) => Promise<GoldenOracleProbeResult>;

/**
 * Machine-readable classification written beside local E2E artifacts.
 */
export interface GoldenE2EResult {
    /**
     * Stable regression classification.
     */
    status: GoldenE2EStatus;

    /**
     * Process exit code defined by the manual E2E contract.
     */
    exitCode: GoldenE2EExitCode;

    /**
     * Concise comparison or infrastructure detail.
     */
    detail: string;

    /**
     * Canonical actual rule, when the agent proposed one.
     */
    actualRule: string | null;

    /**
     * Canonical reporter-relevant human rule, when independently identified.
     */
    expectedRule: string | null;

    /**
     * Full human fix commit loaded after the locked result, when extraction succeeded.
     */
    humanFixCommit: string | null;

    /**
     * First parent used to derive the human diff, when extraction succeeded.
     */
    humanFixFirstParent: string | null;

    /**
     * Browser-confirmed reporter-relevant human change, when one was identified.
     */
    humanCandidate: HumanFixCandidate | null;
}

/**
 * Browser-confirmed human candidate paired with its oracle rationale.
 */
interface RelevantHumanCandidate {
    /**
     * Reporter-relevant rule extracted from the human commit.
     */
    candidate: HumanFixCandidate;

    /**
     * Independent browser/vision verification detail.
     */
    detail: string;
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
    const infrastructureFallback = isInfrastructureFallbackReason(result.fallbackReason ?? null);
    const targetEnvironmentFallback = isTargetEnvironmentFallbackReason(
        result.fallbackReason ?? null,
    );
    if (
        result.infrastructureFailureReason !== undefined ||
        (result.runStatus === FixRunStatus.BrowserUnavailable && !targetEnvironmentFallback) ||
        infrastructureFallback
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
 * Classify failures already proven after result locking without fetching the human commit diff.
 *
 * Agent infrastructure takes precedence over missing environment evidence. A valid but mismatched
 * reporter environment is an agent regression, while malformed case metadata is infrastructure.
 *
 * @param result - Schema-validated locked core result.
 * @param agentEnvironment - Independent post-lock reporter-environment assessment.
 * @param humanFixCommit - Closed commit identity loaded only after result locking.
 * @returns Terminal classification, or null when human rule relevance must still be probed.
 */
export function classifyGoldenPreOracleResult(
    result: FixRunResult,
    agentEnvironment: GoldenAgentEnvironmentAssessment,
    humanFixCommit: string,
): GoldenE2EResult | null {
    const actualRule = result.candidatePatch
        ? normalizeRule(result.candidatePatch.rule).canonical
        : null;
    const infrastructureDetail = infrastructureRunFailureDetail(result);
    if (infrastructureDetail !== null) {
        return {
            status: GoldenE2EStatus.InfrastructureFailure,
            exitCode: GoldenE2EExitCode.InfrastructureFailure,
            detail: infrastructureDetail,
            actualRule,
            expectedRule: null,
            humanFixCommit,
            humanFixFirstParent: null,
            humanCandidate: null,
        };
    }
    if (agentEnvironment.status === GoldenAgentEnvironmentStatus.InfrastructureFailure) {
        return {
            status: GoldenE2EStatus.InfrastructureFailure,
            exitCode: GoldenE2EExitCode.InfrastructureFailure,
            detail: agentEnvironment.detail,
            actualRule,
            expectedRule: null,
            humanFixCommit,
            humanFixFirstParent: null,
            humanCandidate: null,
        };
    }
    if (agentEnvironment.status === GoldenAgentEnvironmentStatus.AgentMismatch) {
        return {
            status: GoldenE2EStatus.AgentRegression,
            exitCode: GoldenE2EExitCode.AgentRegression,
            detail: `Reporter environment mismatch: ${agentEnvironment.detail}`,
            actualRule,
            expectedRule: null,
            humanFixCommit,
            humanFixFirstParent: null,
            humanCandidate: null,
        };
    }
    return null;
}

/**
 * Describe the agent dimensions that differ from a reporter-relevant human candidate.
 *
 * @param result - Locked core result.
 * @param human - Browser-confirmed human candidate.
 * @returns Stable mismatch summary.
 */
function mismatchDetail(result: FixRunResult, human: HumanFixCandidate): string {
    const mismatches: string[] = [];
    if (result.runStatus !== FixRunStatus.PatchProposed) {
        mismatches.push('runStatus');
    }
    if (result.verificationStatus !== VerificationStatus.Verified) {
        mismatches.push('verificationStatus');
    }
    if (result.symptomObservation !== SymptomObservation.Reproduced) {
        mismatches.push('symptomObservation');
    }
    if (!candidateMatches(result, human)) {
        mismatches.push(
            `candidate (${renderCandidateComparison(compareCandidates(result, human))})`,
        );
    }
    return `Golden mismatch: ${mismatches.join(', ')}.`;
}

/**
 * Compare a locked agent result with human commit changes selected by independent browser vision.
 *
 * Extracted human candidates are probed in first-parent diff order because a single fix commit may
 * also contain unrelated filter updates. The first candidate independently confirmed by browser
 * vision becomes the reporter-relevant oracle; later candidates are not evaluated.
 *
 * @param result - Schema-validated result loaded from run-result.json.
 * @param humanFix - Commit identity and all additions extracted from its first-parent diff.
 * @param probeHumanCandidate - Independent browser/vision reporter-relevance seam.
 * @param agentEnvironment - Optional post-lock proof of exact reporter extension and settings.
 * @returns Stable status, exit code, and diagnostic detail.
 */
export async function classifyGoldenResult(
    result: FixRunResult,
    humanFix: ExtractedHumanFix,
    probeHumanCandidate: GoldenOracleProbe,
    agentEnvironment?: GoldenAgentEnvironmentAssessment,
): Promise<GoldenE2EResult> {
    const actualRule = result.candidatePatch
        ? normalizeRule(result.candidatePatch.rule).canonical
        : null;
    const infrastructureDetail = infrastructureRunFailureDetail(result);
    if (agentEnvironment) {
        const preOracle = classifyGoldenPreOracleResult(result, agentEnvironment, humanFix.commit);
        if (preOracle) {
            return { ...preOracle, humanFixFirstParent: humanFix.firstParent };
        }
    } else if (infrastructureDetail !== null) {
        return {
            status: GoldenE2EStatus.InfrastructureFailure,
            exitCode: GoldenE2EExitCode.InfrastructureFailure,
            detail: infrastructureDetail,
            actualRule,
            expectedRule: null,
            humanFixCommit: humanFix.commit,
            humanFixFirstParent: humanFix.firstParent,
            humanCandidate: null,
        };
    }
    if (humanFix.candidates.length === 0) {
        return {
            status: GoldenE2EStatus.InfrastructureFailure,
            exitCode: GoldenE2EExitCode.InfrastructureFailure,
            detail: 'Human fix diff contains no actionable filter candidates.',
            actualRule,
            expectedRule: null,
            humanFixCommit: humanFix.commit,
            humanFixFirstParent: humanFix.firstParent,
            humanCandidate: null,
        };
    }

    let relevant: RelevantHumanCandidate | undefined;
    const infrastructureDetails: string[] = [];
    for (const candidate of humanFix.candidates) {
        const probe = await probeHumanCandidate(candidate);
        if (probe.status === GoldenOracleProbeStatus.Verified) {
            relevant = { candidate, detail: probe.detail };
            break;
        } else if (probe.status === GoldenOracleProbeStatus.InfrastructureFailure) {
            infrastructureDetails.push(probe.detail);
        }
    }

    if (!relevant) {
        if (infrastructureDetails.length > 0) {
            return {
                status: GoldenE2EStatus.InfrastructureFailure,
                exitCode: GoldenE2EExitCode.InfrastructureFailure,
                detail: `Human candidate relevance could not be established: ${infrastructureDetails.join(' | ')}`,
                actualRule,
                expectedRule: null,
                humanFixCommit: humanFix.commit,
                humanFixFirstParent: humanFix.firstParent,
                humanCandidate: null,
            };
        }
        return {
            status: GoldenE2EStatus.EnvironmentDrift,
            exitCode: GoldenE2EExitCode.EnvironmentDrift,
            detail: 'No human commit candidate still fixes the reporter-visible defect.',
            actualRule,
            expectedRule: null,
            humanFixCommit: humanFix.commit,
            humanFixFirstParent: humanFix.firstParent,
            humanCandidate: null,
        };
    }

    const matched = candidateMatches(result, relevant.candidate) ? relevant : undefined;
    const outcomeMatches =
        result.runStatus === FixRunStatus.PatchProposed &&
        result.verificationStatus === VerificationStatus.Verified &&
        result.symptomObservation === SymptomObservation.Reproduced;
    if (matched && outcomeMatches) {
        return {
            status: GoldenE2EStatus.Pass,
            exitCode: GoldenE2EExitCode.Pass,
            detail: `Agent result matches a browser-confirmed human change: ${matched.detail}`,
            actualRule,
            expectedRule: normalizeRule(matched.candidate.rule).canonical,
            humanFixCommit: humanFix.commit,
            humanFixFirstParent: humanFix.firstParent,
            humanCandidate: matched.candidate,
        };
    }

    const primary = matched ?? relevant;
    return {
        status: GoldenE2EStatus.AgentRegression,
        exitCode: GoldenE2EExitCode.AgentRegression,
        detail: `${mismatchDetail(result, primary.candidate)} Human rule verification succeeded: ${primary.detail}`,
        actualRule,
        expectedRule: normalizeRule(primary.candidate.rule).canonical,
        humanFixCommit: humanFix.commit,
        humanFixFirstParent: humanFix.firstParent,
        humanCandidate: primary.candidate,
    };
}

/**
 * Truthful default when no standalone human-candidate browser probe is configured.
 *
 * @returns Explicit infrastructure failure instead of pretending that relevance was checked.
 */
export async function unavailableGoldenOracleProbe(): Promise<GoldenOracleProbeResult> {
    return {
        status: GoldenOracleProbeStatus.InfrastructureFailure,
        detail: 'No standalone human-candidate browser probe is configured.',
    };
}
