import { createHash } from 'node:crypto';
import { RuleKind, normalizeRule } from '../../src/repo/rule-normalizer';
import {
    EffectiveMode,
    FixRunStatus,
    VerificationStatus,
    type FixRunResult,
} from '../../src/types/fix-run-result';
import { VISUAL_REVIEW_UNAVAILABLE_PREFIX } from '../../src/validator/candidate-visual-synthesis';
import type { GoldenAgentEnvironmentAssessment } from './golden-agent-environment';
import type { ExtractedHumanFix, HumanFixCandidate } from './human-commit-oracle';
import {
    CandidateVisualVerdict,
    CandidateVisualSymptom,
    isCandidateVisualPageUsable,
} from '../../src/types/candidate-visual-review';
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
    exitCode: 0 | 1 | 2 | 3;

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
 * E2E-only view of runner-derived candidate metadata.
 */
interface GoldenActualCandidateMetadata {
    /**
     * AdGuard syntax family derived by the runner.
     */
    syntaxKind?: unknown;

    /**
     * Concrete repository edit derived by placement logic.
     */
    repositoryEdit?: unknown;
}

/**
 * Exact and compatibility dimensions retained for one agent/human candidate comparison.
 */
interface GoldenCandidateComparison {
    /**
     * Whether both rules have the same canonical filter text.
     */
    exactRule: boolean;

    /**
     * Whether both rules have the same non-generic reporter-compatible domain scope.
     */
    domainCompatible: boolean;

    /**
     * Whether runner metadata and parsed syntax agree with the human syntax family.
     */
    syntaxKindCompatible: boolean;

    /**
     * Whether both changes belong to the same normalized filter file.
     */
    fileCompatible: boolean;

    /**
     * Whether both repository changes use the same insert/extend/replace operation.
     */
    repositoryEditExact: boolean;

    /**
     * Whether the locked agent candidate carries its own complete bound browser/vision proof.
     *
     * This is diagnostic only: it is not independent evaluator evidence and cannot turn a
     * human-candidate mismatch into a golden pass.
     */
    boundVisionVerified: boolean;
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
 * Extract the edit discriminator without coupling the oracle to edit-specific payload fields.
 *
 * @param edit - Runner-derived repository edit value.
 * @returns Edit kind, or undefined for missing/malformed metadata.
 */
function repositoryEditKind(edit: unknown): string | undefined {
    if (typeof edit !== 'object' || edit === null || !('kind' in edit)) {
        return undefined;
    }
    return typeof edit.kind === 'string' ? edit.kind : undefined;
}

/**
 * Normalize one repository path for cross-platform comparison.
 *
 * @param value - Candidate file path.
 * @returns Slash-normalized path.
 */
function normalizeFilePath(value: string): string {
    return value.replaceAll('\\', '/');
}

/**
 * Derive an explicit first-party scope from one normalized rule.
 *
 * Cosmetic and scriptlet rules expose domains directly. A host-anchored network pattern supplies
 * its host only when no explicit domain prefix is present. Generic or ambiguous rules return no
 * scope and cannot qualify as semantic golden alternatives.
 *
 * @param rule - Normalized candidate rule.
 * @returns Sorted explicit non-exception domain scopes.
 */
function explicitRuleScopes(rule: ReturnType<typeof normalizeRule>): string[] {
    if (rule.domains.length > 0) {
        return rule.domains.filter((domain) => !domain.startsWith('~'));
    }
    if (rule.kind !== RuleKind.Network || !rule.urlPattern) {
        return [];
    }
    const host = /^\|\|([^/*^|]+)(?:[/*^|]|$)/u.exec(rule.urlPattern)?.[1]?.toLowerCase();
    return host ? [host.replace(/\.$/u, '')] : [];
}

/**
 * Check whether one explicit rule scope includes the locked reporter domain.
 *
 * @param scope - Normalized rule domain.
 * @param reportedDomain - Locked issue domain.
 * @returns Whether the rule domain covers the reporter hostname or one of its subdomains.
 */
function scopeIncludesReportedDomain(scope: string, reportedDomain: string): boolean {
    const normalizedScope = scope
        .toLowerCase()
        .replace(/^www\./u, '')
        .replace(/\.$/u, '');
    const normalizedReported = reportedDomain
        .toLowerCase()
        .replace(/^www\./u, '')
        .replace(/\.$/u, '');
    return (
        normalizedScope.length > 0 &&
        (normalizedReported === normalizedScope ||
            normalizedReported.endsWith(`.${normalizedScope}`))
    );
}

/**
 * Prove that one locked candidate was verified by the bound browser/vision lifecycle.
 *
 * @param result - Locked core result containing the agent candidate and evidence paths.
 * @returns Whether the candidate hash, validation identity, semantic review, and screenshots bind.
 */
function hasBoundVerifiedAgentVision(result: FixRunResult): boolean {
    const candidate = result.candidatePatch;
    const review = result.candidateVisualReview;
    const screenshots = result.artifactPaths.verifiedCandidateScreenshots;
    if (!candidate || !review || !screenshots) {
        return false;
    }
    const candidateRuleHash = createHash('sha256').update(candidate.rule).digest('hex');
    return (
        result.effectiveMode === EffectiveMode.Browser &&
        result.fallbackReason === null &&
        result.runStatus === 'patch_proposed' &&
        result.verificationStatus === VerificationStatus.Verified &&
        result.symptomObservation === 'reproduced' &&
        review.verdict === CandidateVisualVerdict.Verified &&
        review.symptom === CandidateVisualSymptom.Resolved &&
        review.coverageComplete &&
        review.beforeInstances.length > 0 &&
        review.remainingInstances.length === 0 &&
        isCandidateVisualPageUsable(review) &&
        review.observedDamage.length === 0 &&
        review.candidateRuleHash === candidateRuleHash &&
        review.validationArtifactId === `validation-${candidateRuleHash.slice(0, 12)}` &&
        typeof result.artifactPaths.candidateVisualReview === 'string' &&
        screenshots.before.length > 0 &&
        screenshots.after.length > 0 &&
        screenshots.beforeFullPage.length > 0 &&
        screenshots.afterFullPage.length > 0
    );
}

/**
 * Compare exact and diagnostic compatibility dimensions for one locked agent/human pair.
 *
 * @param result - Locked core result.
 * @param human - Independently reporter-relevant human candidate.
 * @returns Auditable comparison dimensions without making the final classification.
 */
function compareCandidates(
    result: FixRunResult,
    human: HumanFixCandidate,
): GoldenCandidateComparison {
    const candidate = result.candidatePatch as
        | (NonNullable<FixRunResult['candidatePatch']> & GoldenActualCandidateMetadata)
        | null;
    if (!candidate) {
        return {
            exactRule: false,
            domainCompatible: false,
            syntaxKindCompatible: false,
            fileCompatible: false,
            repositoryEditExact: false,
            boundVisionVerified: false,
        };
    }
    const agentRule = normalizeRule(candidate.rule);
    const humanRule = normalizeRule(human.rule);
    const agentScopes = explicitRuleScopes(agentRule);
    const humanScopes = explicitRuleScopes(humanRule);
    const explicitDomainsMatch =
        agentRule.domains.length === 0 && humanRule.domains.length === 0
            ? true
            : JSON.stringify(agentRule.domains) === JSON.stringify(humanRule.domains);
    const sameScopes =
        !agentRule.isException &&
        !humanRule.isException &&
        explicitDomainsMatch &&
        agentScopes.length > 0 &&
        JSON.stringify(agentScopes) === JSON.stringify(humanScopes) &&
        agentScopes.some((scope) => scopeIncludesReportedDomain(scope, result.domain));
    return {
        exactRule: agentRule.canonical === humanRule.canonical,
        domainCompatible: sameScopes,
        syntaxKindCompatible:
            candidate.syntaxKind === human.syntaxKind &&
            agentRule.syntaxKind === human.syntaxKind &&
            humanRule.syntaxKind === human.syntaxKind,
        fileCompatible: normalizeFilePath(candidate.filePath) === normalizeFilePath(human.filePath),
        repositoryEditExact: repositoryEditKind(candidate.repositoryEdit) === human.repositoryEdit,
        boundVisionVerified: hasBoundVerifiedAgentVision(result),
    };
}

/**
 * Render exact candidate comparison dimensions for pass and regression diagnostics.
 *
 * @param comparison - Auditable agent/human candidate dimensions.
 * @returns Compact stable comparison detail.
 */
function renderCandidateComparison(comparison: GoldenCandidateComparison): string {
    return [
        `exact rule: ${comparison.exactRule ? 'same' : 'different'}`,
        `domain: ${comparison.domainCompatible ? 'compatible' : 'incompatible'}`,
        `syntaxKind: ${comparison.syntaxKindCompatible ? 'compatible' : 'incompatible'}`,
        `file: ${comparison.fileCompatible ? 'compatible' : 'incompatible'}`,
        `repository edit: ${comparison.repositoryEditExact ? 'same' : 'different'}`,
        `bound vision: ${comparison.boundVisionVerified ? 'verified' : 'not verified'}`,
    ].join('; ');
}

/**
 * Compare the locked agent candidate with one browser-confirmed human rule change.
 *
 * @param result - Locked core result.
 * @param human - Candidate extracted from the human commit's first-parent diff.
 * @returns True only when rule semantics, syntax, file, and edit kind match.
 */
function candidateMatches(result: FixRunResult, human: HumanFixCandidate): boolean {
    const comparison = compareCandidates(result, human);
    return (
        comparison.exactRule &&
        comparison.syntaxKindCompatible &&
        comparison.fileCompatible &&
        comparison.repositoryEditExact
    );
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
            status: 'infrastructure_failure',
            exitCode: 3,
            detail: infrastructureDetail,
            actualRule,
            expectedRule: null,
            humanFixCommit,
            humanFixFirstParent: null,
            humanCandidate: null,
        };
    }
    if (agentEnvironment.status === 'infrastructure_failure') {
        return {
            status: 'infrastructure_failure',
            exitCode: 3,
            detail: agentEnvironment.detail,
            actualRule,
            expectedRule: null,
            humanFixCommit,
            humanFixFirstParent: null,
            humanCandidate: null,
        };
    }
    if (agentEnvironment.status === 'agent_mismatch') {
        return {
            status: 'agent_regression',
            exitCode: 1,
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
    if (result.runStatus !== 'patch_proposed') {
        mismatches.push('runStatus');
    }
    if (result.verificationStatus !== VerificationStatus.Verified) {
        mismatches.push('verificationStatus');
    }
    if (result.symptomObservation !== 'reproduced') {
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
            status: 'infrastructure_failure',
            exitCode: 3,
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
            status: 'infrastructure_failure',
            exitCode: 3,
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
        if (probe.status === 'verified') {
            relevant = { candidate, detail: probe.detail };
            break;
        } else if (probe.status === 'infrastructure_failure') {
            infrastructureDetails.push(probe.detail);
        }
    }

    if (!relevant) {
        if (infrastructureDetails.length > 0) {
            return {
                status: 'infrastructure_failure',
                exitCode: 3,
                detail: `Human candidate relevance could not be established: ${infrastructureDetails.join(' | ')}`,
                actualRule,
                expectedRule: null,
                humanFixCommit: humanFix.commit,
                humanFixFirstParent: humanFix.firstParent,
                humanCandidate: null,
            };
        }
        return {
            status: 'environment_drift',
            exitCode: 2,
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
        result.runStatus === 'patch_proposed' &&
        result.verificationStatus === VerificationStatus.Verified &&
        result.symptomObservation === 'reproduced';
    if (matched && outcomeMatches) {
        return {
            status: 'pass',
            exitCode: 0,
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
        status: 'agent_regression',
        exitCode: 1,
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
        status: 'infrastructure_failure',
        detail: 'No standalone human-candidate browser probe is configured.',
    };
}
