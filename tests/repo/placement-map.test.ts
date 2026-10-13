import { describe, it, expect } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePlacementMap, writePlacementMap } from '../../src/repo/placement-map';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as v from 'valibot';
import { PlacementMapSchema } from '../../src/types/repo-context';

const here = dirname(fileURLToPath(import.meta.url));
const checkout = resolve(here, 'fixtures', 'checkout');

describe('generatePlacementMap', () => {
    it('discovers all three filter files', () => {
        const map = generatePlacementMap(checkout);
        expect(map.files.map((f) => f.filter).sort()).toEqual([
            'BaseFilter',
            'CosmeticFilter',
            'ExceptionFilter',
        ]);
    });

    it('records relative paths and the title-derived default section name', () => {
        const map = generatePlacementMap(checkout);
        const base = map.files.find((f) => f.filter === 'BaseFilter')!;
        expect(base.relativePath).toBe('BaseFilter/filter.txt');
    });

    it('detects sections with correct line ranges', () => {
        const map = generatePlacementMap(checkout);
        const base = map.files.find((f) => f.filter === 'BaseFilter')!;
        const generic = base.sections.find((s) => s.name === 'Generic network rules')!;
        expect(generic.startLine).toBe(3);
        expect(generic.endLine).toBe(6);
        const specific = base.sections.find((s) => s.name === 'Domain-specific rules')!;
        expect(specific.startLine).toBe(8);
    });

    it('produces a schema-valid map', () => {
        const map = generatePlacementMap(checkout);
        expect(() => v.parse(PlacementMapSchema, map)).not.toThrow();
    });

    it('writes a schema-valid map file', () => {
        const map = generatePlacementMap(checkout);
        const out = resolve(here, 'fixtures', '.tmp-placement-map.json');
        try {
            writePlacementMap(map, out);
            const written = v.parse(PlacementMapSchema, JSON.parse(readFileSync(out, 'utf8')));
            expect(written.files.map((file) => file.relativePath)).toEqual(
                map.files.map((file) => file.relativePath),
            );
        } finally {
            if (existsSync(out)) {
                rmSync(out);
            }
        }
    });
});

/**
 * Write one list file, creating its directory.
 *
 * @param root - Checkout root.
 * @param relPath - Checkout-relative path of the list file.
 * @param title - The list's own `! Title:` text.
 */
function writeListFile(root: string, relPath: string, title: string): void {
    const absPath = resolve(root, relPath);
    mkdirSync(resolve(absPath, '..'), { recursive: true });
    writeFileSync(absPath, `! Title: ${title}\nexample.test##.promo\n`, 'utf8');
}

describe('generatePlacementMap on a uAssets-style checkout', () => {
    it('makes every list file of a shared filters directory its own list', () => {
        const root = mkdtempSync(join(tmpdir(), 'uassets-placement-map-'));
        writeListFile(root, join('filters', 'badware.txt'), 'uBlock filters - Badware risks');
        writeListFile(root, join('filters', 'annoyances.txt'), 'uBlock filters - Annoyances');
        writeListFile(root, join('filters', 'unbreak.txt'), 'uBlock filters - Unbreak');
        writeListFile(root, join('thirdparties', 'easylist', 'easylist.txt'), 'EasyList');

        const map = generatePlacementMap(root);

        // Each `filters/*.txt` is a separately distributed list, so each is its own list keyed by
        // its path; a per-filter directory keeps naming its whole subtree.
        expect(map.files.map((file) => [file.filter, file.relativePath])).toEqual([
            [join('filters', 'annoyances'), join('filters', 'annoyances.txt')],
            [join('filters', 'badware'), join('filters', 'badware.txt')],
            [join('filters', 'unbreak'), join('filters', 'unbreak.txt')],
            ['thirdparties', join('thirdparties', 'easylist', 'easylist.txt')],
        ]);
        rmSync(root, { recursive: true, force: true });
    });
});
