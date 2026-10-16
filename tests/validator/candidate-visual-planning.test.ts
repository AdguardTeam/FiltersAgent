import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { tileBatches } from '../../src/validator/candidate-visual-planning';
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
