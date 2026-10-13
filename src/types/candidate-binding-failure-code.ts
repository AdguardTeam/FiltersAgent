/**
 * Stable failure codes a review candidate binding exposes outside the trust boundary.
 */
export const CandidateBindingFailureCode = {
    CandidateMismatch: 'candidate_mismatch',
    SourceCommitMismatch: 'source_commit_mismatch',
    UnsafeTarget: 'unsafe_target',
    TargetUnavailable: 'target_unavailable',
    TargetTooLarge: 'target_too_large',
    TargetTooManyLines: 'target_too_many_lines',
    InvalidRule: 'invalid_rule',
    StalePreimage: 'stale_preimage',
    AmbiguousPreimage: 'ambiguous_preimage',
    SourcePreimageMismatch: 'source_preimage_mismatch',
} as const;

export const CANDIDATE_BINDING_FAILURE_CODE_VALUES = Object.values(CandidateBindingFailureCode);

/**
 * One review candidate binding failure code.
 */
export type CandidateBindingFailureCode =
    (typeof CandidateBindingFailureCode)[keyof typeof CandidateBindingFailureCode];
