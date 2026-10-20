/**
 * The text-only follow-up messages the final synthesis appends to its own conversation: a repair
 * request after a reply fails local validation, and the one self-critique a proposed AFTER
 * dismissal must pass. Neither embeds the rejected reply or sends an image.
 */
import { SingleShotMessageRole, type SingleShotMessage } from '../pi/single-shot-input';
import { type SymptomKind, afterDismissalGrounds } from './symptom-rubric';

/**
 * Before/after inventory tag rendered into a reconciliation repair prompt.
 */
const ReconciliationRangeState = {
    /**
     * The before-state visual inventory.
     */
    Before: 'BEFORE',

    /**
     * The after-state visual inventory.
     */
    After: 'AFTER',
} as const;

/**
 * ReconciliationRangeState value.
 */
type ReconciliationRangeState =
    (typeof ReconciliationRangeState)[keyof typeof ReconciliationRangeState];

/**
 * Explain the exact observation indices required for one reconciliation array.
 *
 * @param state - Before or after visual inventory.
 * @param observationCount - Number of numbered observations in the inventory.
 * @returns Bounded deterministic range instruction for a repair prompt.
 */
function reconciliationRangeInstruction(
    state: ReconciliationRangeState,
    observationCount: number,
): string {
    if (observationCount === 0) {
        return `${state} reconciliation must be an empty array because there are no observations.`;
    }
    return (
        `${state} observationIndex range is exactly 1..${observationCount}; include every index ` +
        'once with no missing, duplicate, or unknown indices.'
    );
}

/**
 * Build one bounded repair message for a failed final text synthesis.
 *
 * @param validationError - Exact locally detected schema or reconciliation error.
 * @param beforeObservationCount - Number of numbered before observations.
 * @param afterObservationCount - Number of numbered after observations.
 * @returns Text-only repair instruction that never embeds the rejected model response.
 */
export function buildFinalSynthesisRepairMessage(
    validationError: string,
    beforeObservationCount: number,
    afterObservationCount: number,
): SingleShotMessage {
    return {
        role: SingleShotMessageRole.User,
        text: [
            `The previous final synthesis failed local validation: ${validationError}`,
            reconciliationRangeInstruction(ReconciliationRangeState.Before, beforeObservationCount),
            reconciliationRangeInstruction(ReconciliationRangeState.After, afterObservationCount),
            'Reuse only the already supplied text inventory. No images or new pixel inspection are',
            'needed. Return one corrected JSON object that matches the schema.',
        ].join(' '),
    };
}

/**
 * Build one bounded self-critique request for proposed after-observation dismissals.
 *
 * @param dismissedObservationIndices - Numbered after observations proposed as unrelated.
 * @param kind - Problem class driving the review, which decides the grounds a dismissal may take.
 * @returns Text-only audit instruction that reuses the fixed image inventory.
 */
export function buildAfterDismissalAuditMessage(
    dismissedObservationIndices: number[],
    kind: SymptomKind,
): SingleShotMessage {
    return {
        role: SingleShotMessageRole.User,
        text: [
            'Perform one bounded semantic self-critique before accepting the proposed AFTER',
            '`not_same_symptom` dismissals at observationIndex',
            `${dismissedObservationIndices.join(', ')}.`,
            'Recheck every proposed dismissal against the reporter-defined symptom and the already',
            'supplied image-grounded visual observation. A dismissal stands only on these grounds:',
            ...afterDismissalGrounds(kind),
            'Otherwise, if an observation repeats the same symptom anywhere on the page, return',
            '`remaining`, even when its size, severity, landmark, or prominence differs from the',
            'primary example. Browser and geometry facts may locate or measure it but cannot prove',
            'that a visually compatible symptom is unrelated; no DOM check dismisses an observation,',
            'and no BEFORE record dismisses visible advertising. Return a complete JSON object for',
            'every BEFORE and AFTER observation using only the supplied inventory; do not claim',
            'new pixel inspection.',
        ].join(' '),
    };
}
