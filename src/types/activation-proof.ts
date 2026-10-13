/**
 * Which extension runtime proved the reporter settings were active.
 */
export const ActivationProof = {
    DnrRulesets: 'dnr-rulesets',
    Mv2BackgroundRuntime: 'mv2-background-runtime',
    Unavailable: 'unavailable',
} as const;

/**
 * Every ActivationProof value, for schemas and exhaustive listings.
 */
export const ACTIVATION_PROOF_VALUES = Object.values(ActivationProof);

/**
 * ActivationProof value.
 */
export type ActivationProof = (typeof ActivationProof)[keyof typeof ActivationProof];
