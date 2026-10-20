import { describe, expect, it } from 'vitest';
import { TraceEventType, type TraceEvent } from '../../src/types/trace';
import { reviewWith } from './visual-review-stub';
import { BEFORE_SLOT, FOOTER_GRAPHIC, SECTION_GAP } from './visual-review-fixtures';

/**
 * Validation errors the final synthesis was sent back to repair.
 *
 * @param events - The review's trace events.
 * @returns The validation error of every synthesis retry.
 */
function synthesisRetryErrors(events: TraceEvent[]): string[] {
    return events
        .filter(
            (event) =>
                event.type === TraceEventType.Retry &&
                event.payload.phase === 'candidate_visual_review_synthesis',
        )
        .map((event) => String(event.payload.validationError));
}

describe('reviewCandidateVisually holds the synthesis summary to what it reconciled', () => {
    it('refuses a regressed page once every listed flaw is set aside, and stays inconclusive', async () => {
        const { review, events } = await reviewWith({
            instances: [BEFORE_SLOT],
            damage: [FOOTER_GRAPHIC],
            attribute: () => ({ comparisonArtifactId: 'before-tile-2' }),
            alwaysRegressed: true,
        });

        expect(review.verdict).toBe('inconclusive');
        expect(synthesisRetryErrors(events)).not.toEqual([]);
        expect(
            synthesisRetryErrors(events).every((error) => error.startsWith('pageIntegrity=')),
        ).toBe(true);
    });

    it('keeps a regressed page when the synthesis names content the candidate removed', async () => {
        const { review } = await reviewWith({
            instances: [BEFORE_SLOT],
            damage: [FOOTER_GRAPHIC],
            attribute: () => ({ comparisonArtifactId: 'before-tile-2' }),
            alwaysRegressed: true,
            missingContent: ['The article list below the masthead is gone.'],
        });

        expect(review.verdict).toBe('rejected');
        expect(review.pageIntegrity).toBe('regressed');
        expect(review.observedDamage).toEqual([
            expect.stringContaining('The article list below the masthead is gone.'),
        ]);
    });

    it('refuses residue once every AFTER observation is set aside, and stays inconclusive', async () => {
        const { review, events } = await reviewWith({
            instances: [BEFORE_SLOT, SECTION_GAP],
            damage: [],
            attribute: () => ({ comparisonArtifactId: 'before-tile-2' }),
            alwaysResidue: true,
        });

        expect(review.verdict).toBe('inconclusive');
        expect(synthesisRetryErrors(events)).not.toEqual([]);
        expect(
            synthesisRetryErrors(events).every((error) => error.startsWith('adLayoutResidue=')),
        ).toBe(true);
    });
});
