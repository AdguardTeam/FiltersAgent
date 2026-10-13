import { createHash } from 'node:crypto';

export const CANDIDATE_ARTIFACT_EXECUTION_SUFFIX_PATTERN = '[a-f0-9]{16}';
export const CANDIDATE_VALIDATION_ARTIFACT_ID_PATTERN =
    /^validation-([a-f0-9]{12})(?:-execution-([a-f0-9]{16}))?$/;
export const CANDIDATE_VALIDATION_ARTIFACT_FILENAME_PATTERN =
    /^factual-validation-([a-f0-9]{12})(?:-execution-([a-f0-9]{16}))?[.]json$/;
export const CANDIDATE_VISUAL_REVIEW_ARTIFACT_ID_PATTERN =
    /^visual-review-([a-f0-9]{12})(?:-execution-([a-f0-9]{16}))?$/;
export const CANDIDATE_VISUAL_REVIEW_ARTIFACT_FILENAME_PATTERN =
    /^candidate-visual-review-([a-f0-9]{12})(?:-execution-([a-f0-9]{16}))?[.]json$/;

/**
 * Semantic candidate identity plus an optional host-owned physical execution suffix.
 */
export interface CandidateArtifactIdentity {
    /**
     * First twelve hexadecimal characters of the candidate rule SHA-256.
     */
    candidateShortHash: string;

    /**
     * Host-derived physical execution identity for retry-safe artifacts.
     */
    executionSuffix: string | null;
}

/**
 * Derive a bounded physical artifact suffix from one recorder-issued phase token.
 *
 * @param phaseTokenId - Opaque token issued by the canonical execution recorder.
 * @returns Sixteen hexadecimal characters safe for IDs and filenames.
 */
export function deriveCandidateArtifactExecutionSuffix(phaseTokenId: string): string {
    if (phaseTokenId.length === 0 || phaseTokenId.length > 1_024) {
        throw new Error('Candidate artifact phase token is invalid.');
    }
    return createHash('sha256').update(phaseTokenId).digest('hex').slice(0, 16);
}

/**
 * Parse a runner-owned validation artifact identity.
 *
 * @param value - Candidate validation artifact ID.
 * @returns Parsed semantic and physical identity, or null for malformed input.
 */
export function parseCandidateValidationArtifactId(
    value: string,
): CandidateArtifactIdentity | null {
    const match = CANDIDATE_VALIDATION_ARTIFACT_ID_PATTERN.exec(value);
    return match ? { candidateShortHash: match[1], executionSuffix: match[2] ?? null } : null;
}

/**
 * Parse a runner-owned validation artifact filename.
 *
 * @param value - Candidate validation artifact basename.
 * @returns Parsed semantic and physical identity, or null for malformed input.
 */
export function parseCandidateValidationArtifactFilename(
    value: string,
): CandidateArtifactIdentity | null {
    const match = CANDIDATE_VALIDATION_ARTIFACT_FILENAME_PATTERN.exec(value);
    return match ? { candidateShortHash: match[1], executionSuffix: match[2] ?? null } : null;
}

/**
 * Parse a runner-owned visual-review artifact identity.
 *
 * @param value - Candidate visual-review artifact ID.
 * @returns Parsed semantic and physical identity, or null for malformed input.
 */
export function parseCandidateVisualReviewArtifactId(
    value: string,
): CandidateArtifactIdentity | null {
    const match = CANDIDATE_VISUAL_REVIEW_ARTIFACT_ID_PATTERN.exec(value);
    return match ? { candidateShortHash: match[1], executionSuffix: match[2] ?? null } : null;
}

/**
 * Parse a runner-owned visual-review artifact filename.
 *
 * @param value - Candidate visual-review artifact basename.
 * @returns Parsed semantic and physical identity, or null for malformed input.
 */
export function parseCandidateVisualReviewArtifactFilename(
    value: string,
): CandidateArtifactIdentity | null {
    const match = CANDIDATE_VISUAL_REVIEW_ARTIFACT_FILENAME_PATTERN.exec(value);
    return match ? { candidateShortHash: match[1], executionSuffix: match[2] ?? null } : null;
}

/**
 * Compare semantic and physical candidate artifact identities.
 *
 * @param left - First parsed identity.
 * @param right - Second parsed identity.
 * @returns Whether both identity components agree exactly.
 */
export function candidateArtifactIdentitiesEqual(
    left: CandidateArtifactIdentity | null,
    right: CandidateArtifactIdentity | null,
): boolean {
    return (
        left !== null &&
        right !== null &&
        left.candidateShortHash === right.candidateShortHash &&
        left.executionSuffix === right.executionSuffix
    );
}

/**
 * Format the optional physical execution suffix for an artifact ID or filename.
 *
 * @param executionSuffix - Host-derived hexadecimal execution identity.
 * @returns Empty suffix when there is no execution identity, or a validated execution segment.
 */
export function formatCandidateArtifactExecutionSuffix(executionSuffix?: string): string {
    if (executionSuffix === undefined) {
        return '';
    }
    if (
        !new RegExp(`^${CANDIDATE_ARTIFACT_EXECUTION_SUFFIX_PATTERN}$`, 'u').test(executionSuffix)
    ) {
        throw new Error('Candidate artifact execution suffix is invalid.');
    }
    return `-execution-${executionSuffix}`;
}
