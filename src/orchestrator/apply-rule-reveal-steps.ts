import {
    canonicalInteractionStep,
    normalizeSafeInteractionPlan,
    type NormalizedSafeInteractionPlan,
    type SafeInteractionPlanOutcome,
} from '../environment/safe-interaction';

/**
 * What apply_rule's `revealSteps` argument resolved to.
 */
export type RevealStepsRequest =
    | SafeInteractionPlanOutcome
    | {
          /**
           * Discriminator for a call that passed no steps.
           */
          kind: 'absent';
      };

/**
 * Normalize apply_rule's `revealSteps` argument into the plan every phase replays.
 *
 * `normalizeSafeInteractionPlan` stays the sole agent-request boundary; this only distinguishes a
 * call that passed nothing from one that passed a sequence.
 *
 * @param requested - Raw `revealSteps` value from the model's call.
 * @returns The normalized plan, the reason it was refused, or `absent` when none was passed.
 */
export function parseRevealSteps(requested: unknown): RevealStepsRequest {
    if (requested === undefined || (Array.isArray(requested) && requested.length === 0)) {
        return { kind: 'absent' };
    }
    return normalizeSafeInteractionPlan(
        Array.isArray(requested)
            ? requested.map((step) => canonicalInteractionStep(step))
            : requested,
    );
}

/**
 * Compose the key the baseline-symptom-absent ledger counts experiments under.
 *
 * Different reveal steps put the page into a different state, so they earn the candidate its own
 * experiments; the same steps again cannot change what the baseline shows.
 *
 * @param candidateKey - Operation-plus-canonical candidate ledger key.
 * @param plan - Reveal steps of this call, if any.
 * @returns Ledger key for this candidate under these reveal steps.
 */
export function symptomAbsenceLedgerKey(
    candidateKey: string,
    plan: NormalizedSafeInteractionPlan | undefined,
): string {
    return plan ? `${candidateKey}#reveal:${plan.digest}` : candidateKey;
}
