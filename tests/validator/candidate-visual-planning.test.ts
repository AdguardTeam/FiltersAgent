import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { planFullPageOverview, tileBatches } from '../../src/validator/candidate-visual-planning';
import { MAX_VISION_IMAGE_BYTES } from '../../src/pi/single-shot-input';

const root = mkdtempSync(join(tmpdir(), 'candidate-visual-planning-'));
const MIB = 1024 * 1024;

afterAll(() => rmSync(root, { recursive: true, force: true }));

function tile(index: number, bytes: number) {
    const path = join(root, `tile-${index}.png`);
    writeFileSync(path, Buffer.alloc(bytes));
    return {
        id: `tile-${index}`,
        path,
        index,
        x: 0,
        y: index * 100,
        width: 100,
        height: 100,
        landmark: 'Page section.',
    };
}

describe('tileBatches', () => {
    it('refuses a tile above the per-image cap even when it fits the request budget', () => {
        expect(() => tileBatches([tile(0, MAX_VISION_IMAGE_BYTES + 1)])).toThrow(/per-image/u);
    });

    it('accepts the per-image boundary and splits only above the combined six-MiB budget', () => {
        const tiles = [tile(0, MAX_VISION_IMAGE_BYTES), tile(1, MIB), tile(2, 1)];
        expect(tileBatches(tiles).map((batch) => batch.map((image) => image.id))).toEqual([
            ['tile-0', 'tile-1'],
            ['tile-2'],
        ]);
    });
});

describe('planFullPageOverview', () => {
    it('names each range a window with a top span inspected, not the gap between them', () => {
        // The reason is what the report prints as the inspected range; one range from the top tile
        // to the bottom one would claim the screens between the first five and the ad were seen.
        const overview = join(root, 'overview.png');
        writeFileSync(overview, Buffer.alloc(16));
        const tiles = [0, 920, 8_920].map((y, index) => ({
            ...tile(index, 16),
            y,
            width: 1_920,
            height: 1_080,
        }));

        const plan = planFullPageOverview({ id: 'overview', path: overview }, false, tiles, {
            width: 1_920,
            height: 12_000,
        });

        expect(plan.evidence.reason).toContain(
            'tiles from y=0 to y=2000 and from y=8920 to y=10000 of 12000 px were inspected',
        );
    });
});
