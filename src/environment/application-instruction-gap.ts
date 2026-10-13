/**
 * The refusal vocabulary of a run instruction's application contract.
 *
 * It lives in the environment layer beside `BlockerVerificationMethod` (`environment-proofs.ts`)
 * because both halves of the same contract belong together: the instruction declares how the host
 * applies and verifies a rule, and the environment records which part it could not honor. Keeping
 * the gap in `src/knowledge` put the two halves on opposite sides of the layer edge and made
 * `src/environment` import from `src/knowledge` to record its own refusals.
 */

/**
 * Stable refusal classes for an instruction whose application contract is missing or malformed.
 *
 * A run whose instruction cannot describe how to apply and verify a rule records which part is
 * missing and invents nothing.
 */
export const ApplicationInstructionGap = {
    /**
     * The instruction carries no rule-application section: nothing describes how to apply a rule.
     */
    NoApplicationMethod: 'no-application-method',

    /**
     * No state-verification section, or one that never declares a usable `read:` line: the host is
     * not told how to read the blocker state back.
     */
    NoVerificationMethod: 'no-verification-method',

    /**
     * The declared read method is not one of the known verification methods.
     */
    UnknownVerificationMethod: 'unknown-verification-method',

    /**
     * The declared verification method is known but this executor supplies no reader for it.
     */
    VerificationMethodUnsupported: 'verification-method-unsupported',

    /**
     * The declared file-backed target is relative and its resolution escapes the run's host-state
     * root: the host maintains file-backed blocker state only inside that run-owned directory —
     * deliberately outside the repository checkout — and refuses this target before reading it.
     */
    VerificationTargetOutsideHostState: 'verification-target-outside-host-state',
} as const;

/**
 * ApplicationInstructionGap value.
 */
export type ApplicationInstructionGap =
    (typeof ApplicationInstructionGap)[keyof typeof ApplicationInstructionGap];
