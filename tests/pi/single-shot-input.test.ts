import { describe, expect, it } from 'vitest';
import {
    MAX_VISION_IMAGE_BYTES,
    VisionOverviewRefusal,
    visionOverviewRefusal,
} from '../../src/pi/single-shot-input';

describe('visionOverviewRefusal', () => {
    it('refuses an overview above the 5 MB per-image limit of the Anthropic API', () => {
        expect(
            visionOverviewRefusal({
                bytes: 5 * 1024 * 1024 + 1,
                documentWidth: 1_280,
                documentHeight: 2_000,
            }),
        ).toBe(VisionOverviewRefusal.Oversized);
    });

    // The contract: an overview a provider would shrink below readability never reaches the model.
    // In one live run a 375x10334 px mobile overview went as one image, arrived about 74 px
    // wide, and the model reported ten "remaining" reserved ad bands read off the symptom text
    // while the tiles and the viewport of that same state showed every band gone — which rejected a
    // correct candidate. A page a provider can still show must keep going, or no long page is
    // verifiable at all.
    it.each([
        {
            name: 'the mobile page whose fabricated inventory rejected a correct candidate',
            overview: { bytes: 1_300_000, documentWidth: 375, documentHeight: 10_334 },
            expected: VisionOverviewRefusal.Illegible,
        },
        {
            name: 'a mobile page still inside the ratio',
            overview: { bytes: 400_000, documentWidth: 375, documentHeight: 3_000 },
            expected: null,
        },
        {
            name: 'a desktop page exactly at the ratio',
            overview: { bytes: 400_000, documentWidth: 1_280, documentHeight: 10_240 },
            expected: null,
        },
        {
            name: 'a desktop page one pixel past the ratio',
            overview: { bytes: 400_000, documentWidth: 1_280, documentHeight: 10_241 },
            expected: VisionOverviewRefusal.Illegible,
        },
        {
            name: 'a readable page no request can carry',
            overview: {
                bytes: MAX_VISION_IMAGE_BYTES + 1,
                documentWidth: 1_280,
                documentHeight: 2_000,
            },
            expected: VisionOverviewRefusal.Oversized,
        },
        {
            name: 'an overview whose capture recorded no document extent',
            overview: { bytes: 1_300_000 },
            expected: null,
        },
    ])('refuses or admits $name', ({ overview, expected }) => {
        expect(visionOverviewRefusal(overview)).toBe(expected);
    });
});
