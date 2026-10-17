import { createHash } from 'node:crypto';
import { RuleKind, normalizeRule } from '../../src/repo/rule-normalizer';
import {
    EffectiveMode,
    FixRunStatus,
    SymptomObservation,
    VerificationStatus,
    type FixRunResult,
} from '../../src/types/fix-run-result';
import {
    CandidateVisualVerdict,
    CandidateVisualSymptom,
    isCandidateVisualPageUsable,
} from '../../src/types/candidate-visual-review';
import type { HumanFixCandidate } from './human-commit-oracle';

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
        result.runStatus === FixRunStatus.PatchProposed &&
        result.verificationStatus === VerificationStatus.Verified &&
        result.symptomObservation === SymptomObservation.Reproduced &&
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
export function compareCandidates(
    result: FixRunResult,
    human: HumanFixCandidate,
): GoldenCandidateComparison {
    const candidate = result.candidatePatch;
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
        repositoryEditExact: candidate.repositoryEdit?.kind === human.repositoryEdit,
        boundVisionVerified: hasBoundVerifiedAgentVision(result),
    };
}

/**
 * Render exact candidate comparison dimensions for pass and regression diagnostics.
 *
 * @param comparison - Auditable agent/human candidate dimensions.
 * @returns Compact stable comparison detail.
 */
export function renderCandidateComparison(comparison: GoldenCandidateComparison): string {
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
export function candidateMatches(result: FixRunResult, human: HumanFixCandidate): boolean {
    const comparison = compareCandidates(result, human);
    return (
        comparison.exactRule &&
        comparison.syntaxKindCompatible &&
        comparison.fileCompatible &&
        comparison.repositoryEditExact
    );
}

/**
 * Compare the domain, syntax, and repository file of an agent and confirmed human rule.
 *
 * @param result - Locked agent result containing a proposed rule.
 * @param human - Independently confirmed human rule candidate.
 * @returns Whether the proposed rule occupies the same human rule scope.
 */
export function matchesHumanRuleScope(result: FixRunResult, human: HumanFixCandidate): boolean {
    const comparison = compareCandidates(result, human);
    return (
        comparison.domainCompatible && comparison.syntaxKindCompatible && comparison.fileCompatible
    );
}
