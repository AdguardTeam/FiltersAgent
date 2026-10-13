import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import * as v from 'valibot';
import {
    CandidateVisualVerdict,
    CandidateVisualReviewSchema,
    type CandidateVisualReview,
} from '../types/candidate-visual-review';
import type { RejectedCandidateScreenshotPaths } from '../types/fix-run-result';
import type { ArtifactRef } from '../types/trace';
import {
    candidateArtifactIdentitiesEqual,
    parseCandidateValidationArtifactFilename,
    parseCandidateValidationArtifactId,
    parseCandidateVisualReviewArtifactFilename,
    parseCandidateVisualReviewArtifactId,
    type CandidateArtifactIdentity,
} from '../types/candidate-artifact-identity';
import { ValidationViewportPositionSchema } from '../types/validation';
import { RuleKind, normalizeRule } from '../repo/rule-normalizer';
import { appliedRulesMatch } from './applied-rules-match';
import {
    calculateTrustedBaselineHash,
    type TrustedValidationContext,
} from '../validator/trusted-validation-context';

/**
 * Exact runner-owned screenshots bound to one candidate visual review.
 */
interface BoundCandidateEvidence {
    /**
     * Local path of the aligned before viewport screenshot.
     */
    before: string;

    /**
     * Local path of the aligned after viewport screenshot.
     */
    after: string;

    /**
     * Local path of the aligned before full-page screenshot.
     */
    beforeFullPage: string;

    /**
     * Local path of the aligned after full-page screenshot.
     */
    afterFullPage: string;

    /**
     * Artifact identifier of the aligned before viewport screenshot.
     */
    beforeViewportArtifactId: string;

    /**
     * Artifact identifier of the aligned after viewport screenshot.
     */
    afterViewportArtifactId: string;

    /**
     * Artifact identifier of the aligned before full-page screenshot.
     */
    beforeFullPageArtifactId: string;

    /**
     * Artifact identifier of the aligned after full-page screenshot.
     */
    afterFullPageArtifactId: string;
}

/**
 * Runner-bound visual review and the exact artifact file from which it was parsed.
 */
interface BoundVisualReview {
    /**
     * Parsed typed semantic review.
     */
    review: CandidateVisualReview;

    /**
     * Local path of the runner-owned review artifact.
     */
    artifactPath: string;
}

/**
 * Rejected evidence and its visual-review representative-selection score.
 */
interface RejectedEvidenceCandidate {
    /**
     * Screenshot pair and metadata bound to one rejected validation artifact.
     */
    evidence: RejectedCandidateScreenshotPaths;

    /**
     * Priority used only when no explicit validation artifact was selected.
     */
    score: number;
}

/**
 * Calculate the stable identity suffix for a runner-owned factual validation.
 *
 * @param rule - Exact candidate rule submitted to validation.
 * @returns Twelve-character SHA-256 prefix used by the artifact ID and filename.
 */
function factualValidationHash(rule: string): string {
    return createHash('sha256').update(rule).digest('hex').slice(0, 12);
}

/**
 * Verify the shared identity hash in a factual-validation artifact ID and filename.
 *
 * @param artifact - Runtime artifact metadata to inspect.
 * @returns Matching semantic and physical identity, or null for malformed input.
 */
function runnerValidationArtifactIdentity(artifact: ArtifactRef): CandidateArtifactIdentity | null {
    const idIdentity = parseCandidateValidationArtifactId(artifact.id);
    const filenameIdentity = parseCandidateValidationArtifactFilename(basename(artifact.path));
    return candidateArtifactIdentitiesEqual(idIdentity, filenameIdentity) ? idIdentity : null;
}

/**
 * Verify the shared identity hash in a candidate visual-review artifact ID and filename.
 *
 * @param artifact - Runtime artifact metadata to inspect.
 * @returns Matching semantic and physical identity, or null for malformed input.
 */
function runnerVisualReviewArtifactIdentity(
    artifact: ArtifactRef,
): CandidateArtifactIdentity | null {
    const idIdentity = parseCandidateVisualReviewArtifactId(artifact.id);
    const filenameIdentity = parseCandidateVisualReviewArtifactFilename(basename(artifact.path));
    return candidateArtifactIdentitiesEqual(idIdentity, filenameIdentity) ? idIdentity : null;
}

/**
 * Prove that a validation belongs to the current issue and repository baseline.
 *
 * @param record - Parsed factual-validation payload.
 * @param candidateRule - Candidate bound to the artifact identity hash.
 * @param trustedContext - Immutable current URL and repository rules.
 * @returns Whether all context and applied-rule provenance matches exactly.
 */
function hasTrustedProvenance(
    record: Record<string, unknown>,
    candidateRule: string,
    trustedContext: TrustedValidationContext,
): boolean {
    let recomputedBaselineHash: string;
    try {
        recomputedBaselineHash = calculateTrustedBaselineHash(
            trustedContext.reportedUrl,
            trustedContext.existingRules,
        );
    } catch {
        return false;
    }

    const recordedContext = record.trustedValidationContext as Record<string, unknown> | undefined;
    const phaseA = record.phaseA as Record<string, unknown> | undefined;
    const phaseB = record.phaseB as Record<string, unknown> | undefined;
    const phaseC = record.phaseC as Record<string, unknown> | undefined;
    return (
        trustedContext.baselineHash === recomputedBaselineHash &&
        recordedContext?.reportedUrl === trustedContext.reportedUrl &&
        recordedContext.baselineHash === recomputedBaselineHash &&
        recordedContext.existingRuleCount === trustedContext.existingRules.length &&
        phaseA?.url === trustedContext.reportedUrl &&
        phaseB?.url === trustedContext.reportedUrl &&
        phaseC?.url === trustedContext.reportedUrl &&
        appliedRulesMatch(phaseA?.appliedRules, []) &&
        appliedRulesMatch(phaseB?.appliedRules, trustedContext.existingRules) &&
        appliedRulesMatch(phaseC?.appliedRules, [...trustedContext.existingRules, candidateRule])
    );
}

/**
 * Resolve the exact aligned same-document viewport and full-page evidence pair.
 *
 * @param record - Parsed factual-validation payload.
 * @param artifacts - Runtime artifact registry owned by the runner.
 * @returns Bound evidence, or undefined for incomplete or unaligned evidence.
 */
function alignedEvidencePair(
    record: Record<string, unknown>,
    artifacts: readonly ArtifactRef[],
): BoundCandidateEvidence | undefined {
    const phaseC = record.phaseC as Record<string, unknown> | undefined;
    if (!phaseC || phaseC.sameDocumentControlError) {
        return undefined;
    }
    const controlViewport = v.safeParse(
        ValidationViewportPositionSchema,
        phaseC.sameDocumentControlViewport,
    );
    const candidateViewport = v.safeParse(
        ValidationViewportPositionSchema,
        phaseC.candidateViewport,
    );
    if (
        !controlViewport.success ||
        !candidateViewport.success ||
        Math.abs(controlViewport.output.x - candidateViewport.output.x) > 1 ||
        Math.abs(controlViewport.output.y - candidateViewport.output.y) > 1
    ) {
        return undefined;
    }

    const beforeId = phaseC.sameDocumentControlScreenshotArtifactId;
    const afterId = phaseC.screenshotArtifactId;
    const beforeFullPageId = phaseC.sameDocumentControlFullPageScreenshotArtifactId;
    const afterFullPageId = phaseC.fullPageScreenshotArtifactId;
    if (
        typeof beforeId !== 'string' ||
        typeof afterId !== 'string' ||
        typeof beforeFullPageId !== 'string' ||
        typeof afterFullPageId !== 'string' ||
        beforeId === afterId ||
        beforeFullPageId === afterFullPageId
    ) {
        return undefined;
    }
    const before = artifacts.find(
        (artifact) => artifact.id === beforeId && artifact.type === 'screenshot',
    );
    const after = artifacts.find(
        (artifact) => artifact.id === afterId && artifact.type === 'screenshot',
    );
    const beforeFullPage = artifacts.find(
        (artifact) => artifact.id === beforeFullPageId && artifact.type === 'screenshot-full-page',
    );
    const afterFullPage = artifacts.find(
        (artifact) => artifact.id === afterFullPageId && artifact.type === 'screenshot-full-page',
    );
    if (
        !before ||
        !after ||
        !beforeFullPage ||
        !afterFullPage ||
        before.path === after.path ||
        beforeFullPage.path === afterFullPage.path
    ) {
        return undefined;
    }
    return {
        before: before.path,
        after: after.path,
        beforeFullPage: beforeFullPage.path,
        afterFullPage: afterFullPage.path,
        beforeViewportArtifactId: beforeId,
        afterViewportArtifactId: afterId,
        beforeFullPageArtifactId: beforeFullPageId,
        afterFullPageArtifactId: afterFullPageId,
    };
}

/**
 * Load and verify one runner-bound candidate visual review.
 *
 * @param artifacts - Complete runner-owned artifact registry.
 * @param artifactIdentity - Semantic and physical identity shared by factual and review artifacts.
 * @param candidateRule - Exact candidate rule owned by the validation artifact.
 * @param validationArtifactId - Exact factual-validation artifact identifier.
 * @param evidence - Screenshot identifiers mechanically resolved from the factual validation.
 * @returns Parsed review and path when all runner-owned bindings match exactly.
 */
function boundVisualReview(
    artifacts: readonly ArtifactRef[],
    artifactIdentity: CandidateArtifactIdentity,
    candidateRule: string,
    validationArtifactId: string,
    evidence: BoundCandidateEvidence,
): BoundVisualReview | undefined {
    const matchingArtifacts = artifacts.filter(
        (artifact) =>
            artifact.type === 'candidate-visual-review' &&
            candidateArtifactIdentitiesEqual(
                runnerVisualReviewArtifactIdentity(artifact),
                artifactIdentity,
            ),
    );
    if (matchingArtifacts.length !== 1) {
        return undefined;
    }

    try {
        const parsed = v.parse(
            CandidateVisualReviewSchema,
            JSON.parse(readFileSync(matchingArtifacts[0].path, 'utf8')),
        );
        const candidateRuleHash = createHash('sha256').update(candidateRule).digest('hex');
        if (
            parsed.validationArtifactId !== validationArtifactId ||
            parsed.candidateRuleHash !== candidateRuleHash ||
            parsed.beforeViewportArtifactId !== evidence.beforeViewportArtifactId ||
            parsed.afterViewportArtifactId !== evidence.afterViewportArtifactId ||
            parsed.beforeFullPageArtifactId !== evidence.beforeFullPageArtifactId ||
            parsed.afterFullPageArtifactId !== evidence.afterFullPageArtifactId
        ) {
            return undefined;
        }
        return { review: parsed, artifactPath: matchingArtifacts[0].path };
    } catch {
        return undefined;
    }
}

/**
 * Convert one visual review into bounded local-report rejection reasons.
 *
 * @param review - Runner-bound semantic review for the rejected candidate.
 * @returns Stable non-empty reason list containing only the visual verdict and rationale.
 */
function rejectionReasons(review: CandidateVisualReview): string[] {
    const reasons = [`vision_${review.verdict}`];
    const rationale = review.rationale.trim().replace(/\s+/gu, ' ').slice(0, 200);
    if (rationale && rationale !== reasons[0]) {
        reasons.push(rationale);
    }
    return reasons;
}

/**
 * Rank a rejected attempt solely by its bound visual verdict.
 *
 * @param review - Runner-bound semantic review for the candidate.
 * @returns Priority where an explicit rejection outranks an inconclusive review.
 */
function evidenceScore(review: CandidateVisualReview): number {
    return review.verdict === CandidateVisualVerdict.Rejected ? 2 : 1;
}

/**
 * Bind one runner-owned factual artifact to safe rejected evidence.
 *
 * @param validationArtifact - Candidate factual-validation artifact.
 * @param artifacts - Complete runner-owned artifact registry.
 * @param trustedContext - Current issue URL and repository baseline.
 * @returns Bound evidence and its score, or undefined when any invariant fails.
 */
function evidenceFromArtifact(
    validationArtifact: ArtifactRef,
    artifacts: readonly ArtifactRef[],
    trustedContext: TrustedValidationContext,
): RejectedEvidenceCandidate | undefined {
    const artifactIdentity = runnerValidationArtifactIdentity(validationArtifact);
    if (!artifactIdentity || validationArtifact.type !== 'application/json') {
        return undefined;
    }

    try {
        const parsed = JSON.parse(readFileSync(validationArtifact.path, 'utf8')) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return undefined;
        }
        const record = parsed as Record<string, unknown>;
        const phaseC = record.phaseC as Record<string, unknown> | undefined;
        const appliedRules = Array.isArray(phaseC?.appliedRules) ? phaseC.appliedRules : [];
        let candidateRule: string | undefined;
        for (let index = appliedRules.length - 1; index >= 0; index -= 1) {
            const rule = appliedRules[index];
            if (
                typeof rule === 'string' &&
                factualValidationHash(rule) === artifactIdentity.candidateShortHash
            ) {
                candidateRule = rule;
                break;
            }
        }
        if (
            !candidateRule ||
            /[\r\n]/.test(candidateRule) ||
            candidateRule.length > 4_096 ||
            !hasTrustedProvenance(record, candidateRule, trustedContext)
        ) {
            return undefined;
        }

        const normalized = normalizeRule(candidateRule);
        if (normalized.kind !== RuleKind.Cosmetic && normalized.kind !== RuleKind.Network) {
            return undefined;
        }
        const evidence = alignedEvidencePair(record, artifacts);
        if (!evidence) {
            return undefined;
        }
        const review = boundVisualReview(
            artifacts,
            artifactIdentity,
            candidateRule,
            validationArtifact.id,
            evidence,
        );
        if (!review || review.review.verdict === CandidateVisualVerdict.Verified) {
            return undefined;
        }
        const reasons = rejectionReasons(review.review);
        return {
            evidence: {
                before: evidence.before,
                after: evidence.after,
                beforeFullPage: evidence.beforeFullPage,
                afterFullPage: evidence.afterFullPage,
                validationArtifactId: validationArtifact.id,
                candidateRule,
                rejectionReasons: reasons,
                visualReview: review.review,
                visualReviewArtifactPath: review.artifactPath,
            },
            score: evidenceScore(review.review),
        };
    } catch {
        return undefined;
    }
}

/**
 * Select one representative rejected validation and its aligned before/after screenshots.
 *
 * An explicit selection fails closed when it is invalid. Without one, eligible attempts are ranked
 * deterministically and equal scores retain runner artifact order.
 *
 * @param artifacts - Runtime artifacts registered during the local agent run.
 * @param trustedContext - Immutable current URL and repository baseline.
 * @param preferredValidationArtifactId - Optional exact validation artifact chosen by the agent.
 * @returns Bound rejected screenshot evidence, or undefined when no safe pair exists.
 */
export function selectRepresentativeRejectedCandidateScreenshots(
    artifacts: readonly ArtifactRef[],
    trustedContext: TrustedValidationContext,
    preferredValidationArtifactId?: string,
): RejectedCandidateScreenshotPaths | undefined {
    const validationArtifacts = artifacts.filter(
        (artifact) => runnerValidationArtifactIdentity(artifact) !== null,
    );
    if (preferredValidationArtifactId) {
        const selectedArtifact = validationArtifacts.find(
            (artifact) => artifact.id === preferredValidationArtifactId,
        );
        return selectedArtifact
            ? evidenceFromArtifact(selectedArtifact, artifacts, trustedContext)?.evidence
            : undefined;
    }

    let representative: RejectedEvidenceCandidate | undefined;
    for (const artifact of validationArtifacts) {
        const candidate = evidenceFromArtifact(artifact, artifacts, trustedContext);
        if (candidate && (!representative || candidate.score > representative.score)) {
            representative = candidate;
        }
    }
    return representative?.evidence;
}
