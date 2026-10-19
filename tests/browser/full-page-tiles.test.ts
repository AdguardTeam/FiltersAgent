import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FULL_PAGE_TILE_LIMIT, captureFullPageTiles } from '../../src/browser/full-page-tiles';
import type { TraceRecorder } from '../../src/tracer/trace-recorder';
import type { FullPageTileCoverage, FullPageTileWindow } from '../../src/types/validation';

const VIEWPORT = { width: 1_920, height: 1_080 };
const SCREENSHOT_TIMEOUT_MS = 1_000;

/**
 * The PNG signature and IHDR chunk of an image of the given size: all a tile capture reads back.
 */
function pngHeader(width: number, height: number): Buffer {
    const buffer = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
    buffer.write('IHDR', 12, 'ascii');
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer;
}

/**
 * A stable page of the given document size whose clip screenshots have the requested size.
 */
function stablePage(documentWidth: number, documentHeight: number): Page {
    return {
        viewportSize: () => VIEWPORT,
        evaluate: async () => ({
            documentWidth,
            documentHeight,
            landmarks: [],
            scrollX: 0,
            scrollY: 0,
        }),
        screenshot: async (options: { clip: { width: number; height: number } }) =>
            pngHeader(options.clip.width, options.clip.height),
    } as unknown as Page;
}

describe('captureFullPageTiles', () => {
    let artifactsDir: string;
    const recorder = { addArtifact: vi.fn() } as unknown as TraceRecorder;

    beforeEach(() => {
        artifactsDir = mkdtempSync(join(tmpdir(), 'full-page-tiles-'));
    });

    afterEach(() => {
        rmSync(artifactsDir, { recursive: true, force: true });
    });

    /**
     * Capture the given explicit window on a stable page.
     */
    async function captureWindow(
        documentWidth: number,
        window: FullPageTileWindow,
    ): Promise<FullPageTileCoverage> {
        return captureFullPageTiles(
            stablePage(documentWidth, 30_000),
            artifactsDir,
            recorder,
            undefined,
            undefined,
            SCREENSHOT_TIMEOUT_MS,
            window,
        );
    }

    it('keeps the first rows of a window wider than one capture carries on a two-column page', async () => {
        // A selector whose matches spread down a page wider than the viewport plans two tiles per
        // row. Past the limit the capture used to take no tile at all, so the review saw none of
        // the instances, not even the first.
        const coverage = await captureWindow(2_178, { fromY: 0, toY: 26_000 });

        expect(coverage.complete).toBe(true);
        expect(coverage.windowTrimmed).toBe(true);
        expect(coverage.tiles.length).toBeGreaterThan(0);
        expect(coverage.tiles.length).toBeLessThanOrEqual(FULL_PAGE_TILE_LIMIT);
        expect(new Set(coverage.tiles.map((tile) => tile.x)).size).toBe(2);
        expect(Math.min(...coverage.tiles.map((tile) => tile.y))).toBe(0);
        // The recorded window is what the tiles cover, so the review answers for exactly that,
        // and a later state given it back tiles the same rows.
        expect(coverage.window!.fromY).toBe(0);
        expect(coverage.window!.toY).toBeLessThan(26_000);
        expect(
            Math.max(...coverage.tiles.map((tile) => tile.y + tile.height)),
        ).toBeGreaterThanOrEqual(coverage.window!.toY);
        const replayed = await captureWindow(2_178, coverage.window!);
        expect(replayed.windowTrimmed).toBeUndefined();
        expect(replayed.window).toEqual(coverage.window);
        expect(replayed.tiles.map((tile) => [tile.x, tile.y])).toEqual(
            coverage.tiles.map((tile) => [tile.x, tile.y]),
        );
    });

    it('captures a window within the limit whole and unchanged', async () => {
        const window = { fromY: 4_000, toY: 9_000 };

        const coverage = await captureWindow(2_178, window);

        expect(coverage.complete).toBe(true);
        expect(coverage.windowTrimmed).toBeUndefined();
        expect(coverage.window).toEqual(window);
        expect(Math.min(...coverage.tiles.map((tile) => tile.y))).toBeLessThanOrEqual(4_000);
        expect(
            Math.max(...coverage.tiles.map((tile) => tile.y + tile.height)),
        ).toBeGreaterThanOrEqual(9_000);
    });
});
