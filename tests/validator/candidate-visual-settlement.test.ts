import { describe, expect, it } from 'vitest';
import { TILE_HEIGHT, reviewWith, type StubInstance } from './visual-review-stub';
import { BEFORE_SLOT, FOOTER_GRAPHIC, SECTION_GAP, SLOT_GAP } from './visual-review-fixtures';

/**
 * Distance between the tops of two overlapping tiles, as the capture lays them out.
 */
const OVERLAPPING_TILE_STEP = 920;

describe('reviewCandidateVisually settles what the page showed without the candidate', () => {
    it('does not count a flaw the BEFORE tile shows unchanged as candidate damage', async () => {
        const { review } = await reviewWith({
            instances: [BEFORE_SLOT],
            damage: [FOOTER_GRAPHIC],
            attribute: () => ({ comparisonArtifactId: 'before-tile-2' }),
        });

        expect(review.verdict).toBe('verified');
        expect(review.pageIntegrity).toBe('intact');
        expect(review.settlement?.damage).toEqual([
            expect.objectContaining({
                artifactId: FOOTER_GRAPHIC.artifactId,
                beforeArtifactId: 'before-tile-2',
            }),
        ]);
    });

    it('does not count a gap the BEFORE tile shows unchanged as residue', async () => {
        const { review } = await reviewWith({
            instances: [BEFORE_SLOT, SECTION_GAP],
            damage: [],
            attribute: () => ({ comparisonArtifactId: 'before-tile-2' }),
        });

        expect(review.verdict).toBe('verified');
        expect(review.remainingInstances).toEqual([]);
        expect(review.settlement?.observations).toEqual([
            expect.objectContaining({
                ground: 'unchanged_before',
                beforeArtifactId: 'before-tile-2',
            }),
        ]);
    });

    it('keeps blank space where the BEFORE page showed the symptom', async () => {
        const { review } = await reviewWith({
            instances: [BEFORE_SLOT, SLOT_GAP],
            damage: [],
            attribute: () => ({
                comparisonArtifactId: 'before-tile-1',
                comparisonObservationIndex: 1,
            }),
        });

        expect(review.verdict).toBe('rejected');
        expect(review.remainingInstances).toEqual([
            expect.objectContaining({ landmark: SLOT_GAP.landmark }),
        ]);
    });

    it('keeps blank space whose BEFORE match shows the blank-space symptom', async () => {
        // The reported symptom is itself an empty slot, so the page's own gap and the slot look
        // alike; the match cites the tile on which BEFORE recorded that slot.
        const { review } = await reviewWith({
            instances: [BEFORE_SLOT, SLOT_GAP],
            damage: [],
            attribute: () => ({ comparisonArtifactId: 'before-tile-1' }),
        });

        expect(review.verdict).toBe('rejected');
        expect(review.settlement?.observations).toEqual([]);
    });

    it('asks no further BEFORE tile once a match lands on the blank-space symptom', async () => {
        // The document lost two tiles' height, so the slot gap's window spans three BEFORE tiles in
        // two requests. The first match lands on the tile where BEFORE recorded the empty slot;
        // the second request offers a tile with nothing recorded on it, and asking again there
        // would set the slot's own place aside.
        const { review } = await reviewWith(
            {
                instances: [BEFORE_SLOT, SLOT_GAP],
                damage: [],
                attribute: (_item, request) => ({
                    comparisonArtifactId: request.includes('COMPARISON artifact=before-tile-1;')
                        ? 'before-tile-1'
                        : 'before-tile-3',
                }),
            },
            {
                tileTops: {
                    before: [0, OVERLAPPING_TILE_STEP, 2 * OVERLAPPING_TILE_STEP],
                    after: [0],
                },
                documentHeights: {
                    before: 2 * OVERLAPPING_TILE_STEP + TILE_HEIGHT,
                    after: TILE_HEIGHT,
                },
            },
        );

        expect(review.verdict).toBe('rejected');
        expect(review.settlement?.observations).toEqual([]);
    });

    it('keeps blank space at a symptom the BEFORE pass cited on the viewport', async () => {
        const viewportSlot: StubInstance = {
            artifactId: 'before-viewport',
            landmark: 'Between the news grid and the video section',
            description: 'A reserved advertising frame with its label.',
            footprint: 'visible',
        };
        const { review } = await reviewWith({
            instances: [BEFORE_SLOT, viewportSlot, SECTION_GAP],
            damage: [],
            attribute: (_item, request) => {
                const listed = /^Observation (\d+): artifact=before-viewport;/mu.exec(request);
                return {
                    comparisonArtifactId: 'before-tile-2',
                    ...(listed === null ? {} : { comparisonObservationIndex: Number(listed[1]) }),
                };
            },
        });

        expect(review.verdict).toBe('rejected');
        expect(review.settlement?.observations).toEqual([]);
    });

    it('never sets aside a visible observation, whatever BEFORE shows', async () => {
        const { review } = await reviewWith({
            instances: [
                BEFORE_SLOT,
                { ...SECTION_GAP, footprint: 'visible', description: 'An empty REKLAMA frame.' },
            ],
            damage: [],
            attribute: () => ({ comparisonArtifactId: 'before-tile-2' }),
        });

        expect(review.verdict).toBe('rejected');
        expect(review.settlement?.observations).toEqual([]);
    });
});
