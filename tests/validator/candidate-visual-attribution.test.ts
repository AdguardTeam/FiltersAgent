import { describe, expect, it } from 'vitest';
import { TraceEventType } from '../../src/types/trace';
import { TILE_HEIGHT, reviewWith } from './visual-review-stub';
import { BEFORE_SLOT, FOOTER_GRAPHIC } from './visual-review-fixtures';

/**
 * Distance between the tops of two overlapping tiles, as the capture lays them out.
 */
const OVERLAPPING_TILE_STEP = 920;

/**
 * Height the document gains when an exception lets hidden content render again, more than enough to
 * move the second tile's content into the first BEFORE tile.
 */
const GROWN_HEIGHT = 600;

describe('reviewCandidateVisually compares an AFTER item with the BEFORE images where it can sit', () => {
    it('keeps a flaw whose BEFORE match cites a tile outside the window', async () => {
        // The graphic sits on the second AFTER tile, so it can only be on the second BEFORE tile;
        // the first one shows another stretch of the page.
        const { review } = await reviewWith({
            instances: [BEFORE_SLOT],
            damage: [FOOTER_GRAPHIC],
            attribute: () => ({ comparisonArtifactId: 'before-tile-1' }),
        });

        expect(review.verdict).toBe('rejected');
        expect(review.pageIntegrity).toBe('regressed');
        expect(review.settlement?.damage).toEqual([]);
    });

    it('starts the window at the BEFORE tile that contains the AFTER tile top', async () => {
        // The first BEFORE tile overlaps the second AFTER tile's top by 160 px, rows the second
        // BEFORE tile also shows, so a match on it is not one the window offers.
        const tops = [0, OVERLAPPING_TILE_STEP];
        const { review } = await reviewWith(
            {
                instances: [BEFORE_SLOT],
                damage: [FOOTER_GRAPHIC],
                attribute: () => ({ comparisonArtifactId: 'before-tile-1' }),
            },
            { tileTops: { before: tops, after: tops } },
        );

        expect(review.verdict).toBe('rejected');
        expect(review.settlement?.damage).toEqual([]);
    });

    it('reaches up the BEFORE page when the document grew under the candidate', async () => {
        const height = 2 * TILE_HEIGHT;
        const { review } = await reviewWith(
            {
                instances: [BEFORE_SLOT],
                damage: [FOOTER_GRAPHIC],
                attribute: () => ({ comparisonArtifactId: 'before-tile-1' }),
            },
            { documentHeights: { before: height, after: height + GROWN_HEIGHT } },
        );

        expect(review.verdict).toBe('verified');
        expect(review.settlement?.damage).toEqual([
            expect.objectContaining({ beforeArtifactId: 'before-tile-1' }),
        ]);
    });

    it('does not count a flaw the BEFORE viewport shows unchanged as candidate damage', async () => {
        const { review } = await reviewWith({
            instances: [BEFORE_SLOT],
            damage: [{ ...FOOTER_GRAPHIC, artifactId: 'after-viewport' }],
            attribute: () => ({ comparisonArtifactId: 'before-viewport' }),
        });

        expect(review.verdict).toBe('verified');
        expect(review.settlement?.damage).toEqual([
            expect.objectContaining({ beforeArtifactId: 'before-viewport' }),
        ]);
    });

    it('leaves a flaw to the synthesis when its tile and the BEFORE tile exceed one request', async () => {
        const { review, events } = await reviewWith(
            {
                instances: [BEFORE_SLOT],
                damage: [FOOTER_GRAPHIC],
                attribute: () => ({ comparisonArtifactId: 'before-tile-2' }),
            },
            { largeImages: ['after-tile-2', 'before-tile-2'] },
        );

        expect(review.verdict).toBe('rejected');
        expect(
            events.filter(
                (event) =>
                    event.type === TraceEventType.Decision &&
                    event.payload.phase === 'candidate_visual_attribution_bytes',
            ),
        ).toEqual([
            expect.objectContaining({
                payload: expect.objectContaining({
                    afterArtifactId: 'after-tile-2',
                    comparisonsLeftOut: 1,
                }),
            }),
        ]);
    });

    it('keeps a flaw that cites an image outside its request for the synthesis', async () => {
        const { review } = await reviewWith({
            instances: [BEFORE_SLOT],
            damage: [
                { ...FOOTER_GRAPHIC, artifactId: 'after-viewport', reportedOn: 'after-tile-2' },
            ],
            attribute: () => ({ comparisonArtifactId: 'before-viewport' }),
        });

        expect(review.verdict).toBe('rejected');
        expect(review.pageIntegrity).toBe('regressed');
    });
});
