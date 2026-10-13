/**
 * Finding the runner-owned artifacts behind one candidate: which factual validation attempted this
 * exact rule, which visual review is bound to that same validation, and which screenshots back a
 * verified verdict.
 *
 * This half of the candidate verdict is pure artifact identity and hashing — it never decides
 * whether a candidate may publish, which is `candidate-verdict.ts`'s job over what this returns.
 */
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import * as v from 'valibot';
import { normalizeRule } from '../repo/rule-normalizer';
import {
    candidateArtifactIdentitiesEqual,
    parseCandidateValidationArtifactFilename,
    parseCandidateValidationArtifactId,
    parseCandidateVisualReviewArtifactFilename,
    parseCandidateVisualReviewArtifactId,
    type CandidateArtifactIdentity,
} from '../types/candidate-artifact-identity';
import {
    CandidateVisualReviewSchema,
    type CandidateVisualReview,
} from '../types/candidate-visual-review';
import type { CandidatePatch, VerifiedCandidateScreenshotPaths } from '../types/fix-run-result';
import type { ArtifactRef } from '../types/trace';

/**
 * Validation artifact selected for the exact rule that the agent returned as its final candidate.
 */
export interface CandidateValidationSelection {
    /**
     * Runner-owned identity of the selected factual validation artifact.
     */
    validationArtifactId?: string;

    /**
     * Parsed factual validation payload.
     */
    factualValidation: unknown;

    /**
     * Typed semantic vision review bound to this exact validation, when available.
     */
    visualReview?: CandidateVisualReview;

    /**
     * Local path of the persisted visual review artifact, when available.
     */
    visualReviewArtifactPath?: string;

    /**
     * Phase C same-document control viewport screenshot identifier, when present.
     */
    beforeScreenshotArtifactId?: string;

    /**
     * Phase C screenshot artifact identifier, when present.
     */
    afterScreenshotArtifactId?: string;

    /**
     * Before full-page screenshot identifier selected for visual review.
     */
    beforeFullPageScreenshotArtifactId?: string;

    /**
     * After full-page screenshot identifier selected for visual review.
     */
    afterFullPageScreenshotArtifactId?: string;

    /**
     * Exact Phase B viewport and full-page screenshot identifiers.
     */
    beforeScreenshotArtifactIds: string[];

    /**
     * Exact Phase C viewport and full-page screenshot identifiers.
     */
    afterScreenshotArtifactIds: string[];

    /**
     * Phase C phase-local HAR artifact identifier, when present.
     */
    phaseCHarArtifactId?: string;

    /**
     * Phase C DOM snapshot artifact identifier, when present.
     */
    phaseCDomArtifactId?: string;
}

/**
 * Calculate the stable identity suffix used by runner-owned factual validation artifacts.
 *
 * @param rule - Exact candidate rule submitted to validation.
 * @returns The twelve-character SHA-256 prefix used in the artifact ID and filename.
 */
function factualValidationHash(rule: string): string {
    return createHash('sha256').update(rule).digest('hex').slice(0, 12);
}

/**
 * Read and verify the shared hash from a runner-owned factual validation artifact identity.
 *
 * @param artifact - Runtime artifact metadata to inspect.
 * @returns Matching semantic and physical identity, or null for malformed input.
 */
function runnerValidationArtifactIdentity(artifact: ArtifactRef): CandidateArtifactIdentity | null {
    const idIdentity = parseCandidateValidationArtifactId(artifact.id);
    const pathIdentity = parseCandidateValidationArtifactFilename(basename(artifact.path));
    return candidateArtifactIdentitiesEqual(idIdentity, pathIdentity) ? idIdentity : null;
}

/**
 * Read the shared hash from a runner-owned candidate visual-review artifact.
 *
 * @param artifact - Runtime artifact metadata to inspect.
 * @returns Matching semantic and physical identity, or null for malformed input.
 */
function runnerVisualReviewArtifactIdentity(
    artifact: ArtifactRef,
): CandidateArtifactIdentity | null {
    const idIdentity = parseCandidateVisualReviewArtifactId(artifact.id);
    const pathIdentity = parseCandidateVisualReviewArtifactFilename(basename(artifact.path));
    if (
        artifact.type !== 'candidate-visual-review' ||
        !candidateArtifactIdentitiesEqual(idIdentity, pathIdentity)
    ) {
        return null;
    }
    return idIdentity;
}

/**
 * Create a present-but-invalid selection that makes candidate verification fail closed.
 *
 * @returns A validation selection with no trusted factual payload or evidence artifacts.
 */
function invalidCandidateValidationSelection(): CandidateValidationSelection {
    return {
        factualValidation: null,
        beforeScreenshotArtifactIds: [],
        afterScreenshotArtifactIds: [],
    };
}

/**
 * Select the latest factual validation artifact that attempted the final candidate rule.
 *
 * Exact attempts are bound by the runner-owned SHA-256 artifact identity even when candidate
 * application failed or the artifact is unreadable. Parseable attempts are also matched by
 * canonical rule equivalence so formatting-only model rewrites cannot bypass a rejected result.
 *
 * @param artifacts - Runtime artifacts registered during the agent run.
 * @param candidatePatch - Final candidate emitted by the agent.
 * @returns The matching factual result and after-screenshot ID, or undefined when none matches.
 */
export function selectCandidateValidation(
    artifacts: ArtifactRef[],
    candidatePatch: CandidatePatch | null,
): CandidateValidationSelection | undefined {
    if (!candidatePatch) {
        return undefined;
    }

    const expectedHash = factualValidationHash(candidatePatch.rule);
    const expectedCanonical = normalizeRule(candidatePatch.rule).canonical;
    const validationArtifacts = artifacts.filter(
        (artifact) => runnerValidationArtifactIdentity(artifact) !== null,
    );
    for (let index = validationArtifacts.length - 1; index >= 0; index -= 1) {
        const artifact = validationArtifacts[index];
        const artifactIdentity = runnerValidationArtifactIdentity(artifact)!;
        const artifactHash = artifactIdentity.candidateShortHash;
        const exactAttempt = artifactHash === expectedHash;
        if (artifact.type !== 'application/json') {
            if (exactAttempt) {
                return invalidCandidateValidationSelection();
            }
            continue;
        }
        try {
            const factualValidation = JSON.parse(readFileSync(artifact.path, 'utf-8')) as unknown;
            const factualRecord =
                factualValidation !== null && typeof factualValidation === 'object'
                    ? (factualValidation as Record<string, unknown>)
                    : {};
            const phaseC = factualRecord.phaseC as Record<string, unknown> | undefined;
            const phaseB = factualRecord.phaseB as Record<string, unknown> | undefined;
            const appliedRules = Array.isArray(phaseC?.appliedRules) ? phaseC.appliedRules : [];
            let attemptedRule: string | undefined;
            for (let ruleIndex = appliedRules.length - 1; ruleIndex >= 0; ruleIndex -= 1) {
                const rule = appliedRules[ruleIndex];
                if (typeof rule === 'string' && factualValidationHash(rule) === artifactHash) {
                    attemptedRule = rule;
                    break;
                }
            }
            const canonicallyEquivalentAttempt =
                attemptedRule !== undefined &&
                normalizeRule(attemptedRule).canonical === expectedCanonical;
            if (!exactAttempt && !canonicallyEquivalentAttempt) {
                continue;
            }
            const screenshotArtifactId = phaseC?.screenshotArtifactId;
            const fullPageScreenshotArtifactId = phaseC?.fullPageScreenshotArtifactId;
            const controlScreenshotArtifactId = phaseC?.sameDocumentControlScreenshotArtifactId;
            const controlFullPageScreenshotArtifactId =
                phaseC?.sameDocumentControlFullPageScreenshotArtifactId;
            const hasSameDocumentControlScreenshot =
                typeof controlScreenshotArtifactId === 'string' ||
                typeof controlFullPageScreenshotArtifactId === 'string';
            const beforeScreenshotArtifactIds = hasSameDocumentControlScreenshot
                ? [controlScreenshotArtifactId, controlFullPageScreenshotArtifactId]
                : [phaseB?.screenshotArtifactId, phaseB?.fullPageScreenshotArtifactId];
            const beforeViewportArtifactId = hasSameDocumentControlScreenshot
                ? controlScreenshotArtifactId
                : phaseB?.screenshotArtifactId;
            const beforeFullPageArtifactId = hasSameDocumentControlScreenshot
                ? controlFullPageScreenshotArtifactId
                : phaseB?.fullPageScreenshotArtifactId;
            let visualReviewArtifact: ArtifactRef | undefined;
            for (let reviewIndex = artifacts.length - 1; reviewIndex >= 0; reviewIndex -= 1) {
                const candidate = artifacts[reviewIndex];
                if (
                    candidateArtifactIdentitiesEqual(
                        runnerVisualReviewArtifactIdentity(candidate),
                        artifactIdentity,
                    )
                ) {
                    visualReviewArtifact = candidate;
                    break;
                }
            }
            let visualReview: CandidateVisualReview | undefined;
            if (visualReviewArtifact) {
                try {
                    const parsedReview = v.safeParse(
                        CandidateVisualReviewSchema,
                        JSON.parse(readFileSync(visualReviewArtifact.path, 'utf8')),
                    );
                    visualReview = parsedReview.success ? parsedReview.output : undefined;
                } catch {
                    visualReview = undefined;
                }
            }
            const harArtifactId = phaseC?.harArtifactId;
            const domArtifactId = phaseC?.domArtifactId;
            return {
                validationArtifactId: artifact.id,
                factualValidation,
                beforeScreenshotArtifactId:
                    typeof beforeViewportArtifactId === 'string'
                        ? beforeViewportArtifactId
                        : undefined,
                afterScreenshotArtifactId:
                    typeof screenshotArtifactId === 'string' ? screenshotArtifactId : undefined,
                beforeFullPageScreenshotArtifactId:
                    typeof beforeFullPageArtifactId === 'string'
                        ? beforeFullPageArtifactId
                        : undefined,
                afterFullPageScreenshotArtifactId:
                    typeof fullPageScreenshotArtifactId === 'string'
                        ? fullPageScreenshotArtifactId
                        : undefined,
                beforeScreenshotArtifactIds: beforeScreenshotArtifactIds.filter(
                    (artifactId): artifactId is string => typeof artifactId === 'string',
                ),
                afterScreenshotArtifactIds: [
                    screenshotArtifactId,
                    fullPageScreenshotArtifactId,
                ].filter((artifactId): artifactId is string => typeof artifactId === 'string'),
                phaseCHarArtifactId: typeof harArtifactId === 'string' ? harArtifactId : undefined,
                phaseCDomArtifactId: typeof domArtifactId === 'string' ? domArtifactId : undefined,
                ...(visualReview ? { visualReview } : {}),
                ...(visualReviewArtifact
                    ? { visualReviewArtifactPath: visualReviewArtifact.path }
                    : {}),
            };
        } catch {
            if (exactAttempt) {
                return invalidCandidateValidationSelection();
            }
            // An unreadable non-exact artifact cannot be bound to a canonical candidate.
        }
    }
    return undefined;
}

/**
 * Resolve the viewport and full-page screenshot pairs for one verified final candidate.
 *
 * Artifact IDs come from the exact runner-bound visual review selection. The function does not
 * interpret their pixels or page structure.
 *
 * @param selection - Validation selected for the exact final candidate.
 * @param artifacts - Runner-owned artifact registry.
 * @param candidateVerified - Whether the runner-bound visual review passed.
 * @returns Exact before/after paths, or undefined when the pair is incomplete.
 */
export function verifiedCandidateScreenshotPaths(
    selection: CandidateValidationSelection | undefined,
    artifacts: ArtifactRef[],
    candidateVerified: boolean,
): VerifiedCandidateScreenshotPaths | undefined {
    if (
        !candidateVerified ||
        !selection?.beforeScreenshotArtifactId ||
        !selection.afterScreenshotArtifactId ||
        !selection.beforeFullPageScreenshotArtifactId ||
        !selection.afterFullPageScreenshotArtifactId ||
        selection.beforeScreenshotArtifactId === selection.afterScreenshotArtifactId
    ) {
        return undefined;
    }
    const before = artifacts.find(
        (artifact) =>
            artifact.type === 'screenshot' && artifact.id === selection.beforeScreenshotArtifactId,
    );
    const after = artifacts.find(
        (artifact) =>
            artifact.type === 'screenshot' && artifact.id === selection.afterScreenshotArtifactId,
    );
    const beforeFullPage = artifacts.find(
        (artifact) =>
            artifact.type === 'screenshot-full-page' &&
            artifact.id === selection.beforeFullPageScreenshotArtifactId,
    );
    const afterFullPage = artifacts.find(
        (artifact) =>
            artifact.type === 'screenshot-full-page' &&
            artifact.id === selection.afterFullPageScreenshotArtifactId,
    );
    return before && after && beforeFullPage && afterFullPage
        ? {
              before: before.path,
              after: after.path,
              beforeFullPage: beforeFullPage.path,
              afterFullPage: afterFullPage.path,
          }
        : undefined;
}

/**
 * Report whether the run persisted any candidate validation artifact at all.
 *
 * The verdict needs this without needing the artifact identities themselves, and the identity rules
 * belong to this module, so it asks the question here rather than re-deriving the answer.
 *
 * @param artifacts - Runner-owned artifact registry.
 * @returns Whether at least one runner-owned factual validation artifact was registered.
 */
export function hasPersistedCandidateValidation(artifacts: readonly ArtifactRef[]): boolean {
    return artifacts.some((artifact) => runnerValidationArtifactIdentity(artifact) !== null);
}
