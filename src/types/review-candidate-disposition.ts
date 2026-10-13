/**
 * How a run's candidate stands for review: absent, unverified, unsupported shape, or inconclusive.
 */
export const ReviewCandidateDisposition = {
    NoCandidate: 'no_candidate',
    NotVerified: 'not_verified',
    Unsupported: 'unsupported',
    Inconclusive: 'inconclusive',
} as const;

/**
 * Every ReviewCandidateDisposition value, for schemas and exhaustive listings.
 */
export const REVIEW_CANDIDATE_DISPOSITION_VALUES = Object.values(ReviewCandidateDisposition);

/**
 * ReviewCandidateDisposition value.
 */
export type ReviewCandidateDisposition =
    (typeof ReviewCandidateDisposition)[keyof typeof ReviewCandidateDisposition];
