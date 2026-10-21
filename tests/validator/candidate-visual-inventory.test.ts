import { describe, expect, it } from 'vitest';
import { TraceEventType } from '../../src/types/trace';
import { UNBOUND_CITATION_PHASE } from '../../src/validator/candidate-visual-inventory';
import { reviewWith } from './visual-review-stub';
import { BEFORE_SLOT, FOOTER_GRAPHIC } from './visual-review-fixtures';

describe('reviewCandidateVisually inventory citations', () => {
    it('drops a flaw cited on an image its request did not carry', async () => {
        // A flaw that rests on no image of its request may be one seen only on the map, and it
        // must not regress the page.
        const { review, events } = await reviewWith({
            instances: [BEFORE_SLOT],
            damage: [
                { ...FOOTER_GRAPHIC, artifactId: 'after-viewport', reportedOn: 'after-tile-2' },
            ],
        });

        expect(review.verdict).toBe('verified');
        expect(review.pageIntegrity).toBe('intact');
        expect(
            events.filter(
                (event) =>
                    event.type === TraceEventType.Decision &&
                    event.payload.phase === UNBOUND_CITATION_PHASE,
            ),
        ).toEqual([
            expect.objectContaining({
                payload: expect.objectContaining({
                    droppedDamage: [
                        { artifactId: 'after-viewport', description: FOOTER_GRAPHIC.description },
                    ],
                }),
            }),
        ]);
    });

    it('drops a BEFORE observation cited on the map instead of ending the review', async () => {
        // The map carries no artifact, so a model that records what it saw there can only cite a
        // name of its own; one such citation used to end the review without a verdict.
        const { review, events } = await reviewWith(
            {
                instances: [
                    BEFORE_SLOT,
                    {
                        artifactId: 'MAP',
                        reportedOn: 'before-tile-1',
                        landmark: 'Article body',
                        description: 'A REKLAMA-labelled slot visible on the map.',
                        footprint: 'visible',
                    },
                ],
                damage: [],
            },
            { overviews: true },
        );

        expect(review.verdict).toBe('verified');
        expect(
            events.some(
                (event) =>
                    event.type === TraceEventType.Decision &&
                    event.payload.phase === UNBOUND_CITATION_PHASE &&
                    JSON.stringify(event.payload.droppedInstances).includes('"MAP"'),
            ),
        ).toBe(true);
    });

    it('never verifies a candidate whose AFTER observation cites no image', async () => {
        // A tile ID copied wrong takes the observation out of the inventory; if that was the ad
        // the candidate left, the synthesis never sees it and would pass the candidate.
        const { review } = await reviewWith({
            instances: [
                BEFORE_SLOT,
                {
                    artifactId: 'after-tile-1x',
                    reportedOn: 'after-tile-1',
                    landmark: 'Below the masthead',
                    description: 'The advertising banner is still shown.',
                    footprint: 'visible',
                },
            ],
            damage: [],
        });

        expect(review.verdict).toBe('inconclusive');
        expect(review.coverageComplete).toBe(false);
    });
});
