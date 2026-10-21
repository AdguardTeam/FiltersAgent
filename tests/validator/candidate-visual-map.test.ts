import { describe, expect, it } from 'vitest';
import type { SingleShotMessage } from '../../src/pi/single-shot-input';
import { TraceEventType } from '../../src/types/trace';
import { CANDIDATE_VISUAL_MAP_PHASE } from '../../src/validator/candidate-visual-map';
import { TILE_HEIGHT, reviewWith, sentImages } from './visual-review-stub';
import { BEFORE_SLOT } from './visual-review-fixtures';

/**
 * Height of a page far taller than wide: its 1920 px wide overview shrinks to a stripe.
 */
const TALL_DOCUMENT_HEIGHT = 17_811;

/**
 * Every tile batch request of a review.
 *
 * @param requests - Messages of every structured call.
 * @returns The tile batch requests.
 */
function tileBatchRequests(requests: SingleShotMessage[][]): SingleShotMessage[][] {
    return requests.filter((messages) =>
        messages.some((message) => message.text?.includes('Inventory source: TILE_BATCH')),
    );
}

describe('reviewCandidateVisually full-page map', () => {
    it('never rejects a candidate for a symptom seen only on the full-page overview', async () => {
        // A weak vision model asked to inventory the downscaled overview reported REKLAMA slots
        // and ad creatives the original-resolution tiles of the same state did not show, and
        // the review rejected a correct candidate on them alone.
        const { review } = await reviewWith(
            {
                instances: [
                    BEFORE_SLOT,
                    {
                        artifactId: 'after-full-page',
                        landmark: 'Article body, after the second paragraph',
                        description: 'A REKLAMA-labelled reserved advertising slot.',
                        footprint: 'visible',
                    },
                ],
                damage: [],
            },
            { overviews: true },
        );

        expect(review.verdict).toBe('verified');
        expect(review.remainingInstances).toEqual([]);
    });

    it('shows every tile batch the map first and labels each tile with its place', async () => {
        const { review, requests } = await reviewWith(
            { instances: [BEFORE_SLOT], damage: [] },
            { overviews: true },
        );

        expect(review.verdict).toBe('verified');
        const batches = tileBatchRequests(requests);
        expect(batches).toHaveLength(2);
        for (const batch of batches) {
            const [map, ...tiles] = sentImages(batch);
            expect(map !== undefined && 'bytes' in map.image).toBe(true);
            expect(map?.text).not.toContain('artifact=');
            expect(tiles.map(({ image }) => 'path' in image)).toEqual([true, true]);
            for (const place of [`1 of 2, y=0–${TILE_HEIGHT}`, `2 of 2, y=${TILE_HEIGHT}–`]) {
                expect(map?.text).toContain(place);
                expect(tiles[0]?.text).toContain(place);
            }
        }
    });

    it('maps a page too tall for its overview by the span its tiles cover', async () => {
        const { review, requests, events } = await reviewWith(
            { instances: [BEFORE_SLOT], damage: [] },
            {
                overviews: true,
                tileWindowMaps: true,
                documentHeights: { before: TALL_DOCUMENT_HEIGHT, after: TALL_DOCUMENT_HEIGHT },
            },
        );

        expect(review.verdict).toBe('verified');
        const mapDecisions = events.filter(
            (event) =>
                event.type === TraceEventType.Decision &&
                event.payload.phase === CANDIDATE_VISUAL_MAP_PHASE,
        );
        expect(mapDecisions.map((event) => event.payload.artifactId).sort()).toEqual([
            'after-tile-window-map',
            'before-tile-window-map',
        ]);
        expect(review.fullPageOverviewEvidence?.after.visionArtifactId).toBe(
            'after-tile-window-map',
        );
        for (const batch of tileBatchRequests(requests)) {
            const [map] = sentImages(batch);
            expect(map !== undefined && 'bytes' in map.image).toBe(true);
        }
    });

    it('marks the tiles a cut tile window map does not show', async () => {
        // On a tall mobile page the map stops at the legible aspect, short of the last tiles; a
        // manifest that places them on the map points the model at pixels the map does not have.
        const { requests } = await reviewWith(
            { instances: [BEFORE_SLOT], damage: [] },
            {
                tileWindowMaps: true,
                tileWindowMapHeight: TILE_HEIGHT,
                documentHeights: { before: TALL_DOCUMENT_HEIGHT, after: TALL_DOCUMENT_HEIGHT },
            },
        );

        for (const batch of tileBatchRequests(requests)) {
            const [map] = sentImages(batch);
            const lines = map?.text.split('\n') ?? [];
            const marked = lines.filter((line) => line.includes('below the map'));
            expect(marked).toHaveLength(1);
            expect(marked[0]).toContain(`2 of 2, y=${TILE_HEIGHT}–`);
        }
    });
});
