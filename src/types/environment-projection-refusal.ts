/**
 * Why canonical execution could not be projected into the retained compatibility fields.
 *
 * Each refusal names one exact invariant. A bare refusal surfaces only as "Canonical environment
 * execution cannot be projected safely", and a run whose decision the canonical evidence cannot
 * back would end on that sentence with no way to tell which of the seven checks refused it.
 *
 * The set lives in its own leaf module because the run-result schema reads it at load time, and the
 * projection module and the run-result module already import each other.
 */
export const EnvironmentProjectionRefusal = {
    BindingsDisagree: 'bindings_disagree',
    ArtifactIndexUnavailable: 'artifact_index_unavailable',
    NoProjectablePhases: 'no_projectable_phases',
    VerifiedWithoutExactAbc: 'verified_without_exact_abc',
    PhaseSessionUnprojectable: 'phase_session_unprojectable',
    VerifiedWithoutThreeSessions: 'verified_without_three_sessions',
    VerifiedWithoutCandidateBinding: 'verified_without_candidate_binding',
} as const;

/**
 * One exact reason canonical execution did not project.
 */
export type EnvironmentProjectionRefusal =
    (typeof EnvironmentProjectionRefusal)[keyof typeof EnvironmentProjectionRefusal];

/**
 * Every EnvironmentProjectionRefusal value, for the run-result schema.
 */
export const ENVIRONMENT_PROJECTION_REFUSAL_VALUES = Object.values(EnvironmentProjectionRefusal);
