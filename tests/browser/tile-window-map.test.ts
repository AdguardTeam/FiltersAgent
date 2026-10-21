import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTileWindowMap } from '../../src/browser/tile-window-map';
import { MAX_LEGIBLE_OVERVIEW_ASPECT_RATIO } from '../../src/pi/single-shot-input';
import type { TraceRecorder } from '../../src/tracer/trace-recorder';
import { TraceEventType } from '../../src/types/trace';
import type { FullPageTileCoverage } from '../../src/types/validation';

/**
 * Mobile viewport of the page, in CSS pixels.
 */
const VIEWPORT = { width: 375, height: 812 };

/**
 * Tallest map of the mobile page that can still be read as one image.
 */
const LEGIBLE_MAP_HEIGHT = MAX_LEGIBLE_OVERVIEW_ASPECT_RATIO * VIEWPORT.width;

/**
 * Height of a mobile page whose overview arrives about 74 px wide.
 */
const TALL_DOCUMENT_HEIGHT = 10_334;

/**
 * Coverage of five stacked mobile tiles from the top of a document of the given height.
 *
 * @param documentHeight - Document height in CSS pixels.
 * @returns The coverage.
 */
function fiveScreens(documentHeight: number): FullPageTileCoverage {
    return {
        complete: true,
        documentWidth: VIEWPORT.width,
        documentHeight,
        viewportWidth: VIEWPORT.width,
        viewportHeight: VIEWPORT.height,
        overlapPx: 0,
        tiles: Array.from({ length: 5 }, (_, index) => ({
            artifactId: `tile-${index + 1}`,
            index,
            x: 0,
            y: index * VIEWPORT.height,
            width: VIEWPORT.width,
            height: VIEWPORT.height,
            landmark: `screen ${index + 1}`,
        })),
        window: { fromY: 0, toY: 5 * VIEWPORT.height },
        windowDefaulted: true,
    };
}

describe('withTileWindowMap', () => {
    let artifactsDir: string;
    const recorder = { addArtifact: vi.fn(), record: vi.fn() } as unknown as TraceRecorder;
    const screenshot = vi.fn(async () => Buffer.from('jpeg'));
    const page = { screenshot } as unknown as Page;

    beforeEach(() => {
        artifactsDir = mkdtempSync(join(tmpdir(), 'tile-window-map-'));
        screenshot.mockClear();
    });

    afterEach(() => {
        rmSync(artifactsDir, { recursive: true, force: true });
    });

    it('maps the tiles of a page too tall to read as one overview, no taller than legible', async () => {
        const coverage = await withTileWindowMap(
            page,
            artifactsDir,
            recorder,
            fiveScreens(TALL_DOCUMENT_HEIGHT),
        );

        expect(coverage.map).toMatchObject({ y: 0, height: LEGIBLE_MAP_HEIGHT });
        expect(screenshot).toHaveBeenCalledWith(
            expect.objectContaining({
                clip: { x: 0, y: 0, width: VIEWPORT.width, height: LEGIBLE_MAP_HEIGHT },
            }),
        );
    });

    it('takes no map of a page whose overview can be read as one image', async () => {
        const coverage = await withTileWindowMap(
            page,
            artifactsDir,
            recorder,
            fiveScreens(MAX_LEGIBLE_OVERVIEW_ASPECT_RATIO * VIEWPORT.width),
        );

        expect(coverage.map).toBeUndefined();
        expect(screenshot).not.toHaveBeenCalled();
    });

    it('leaves the coverage without a map when the browser refuses the capture', async () => {
        screenshot.mockRejectedValueOnce(new Error('Cannot take screenshot'));

        const coverage = await withTileWindowMap(
            page,
            artifactsDir,
            recorder,
            fiveScreens(TALL_DOCUMENT_HEIGHT),
        );

        expect(coverage).toEqual(fiveScreens(TALL_DOCUMENT_HEIGHT));
        expect(recorder.record).toHaveBeenCalledWith(
            TraceEventType.Error,
            expect.objectContaining({
                clip: expect.objectContaining({ y: 0, height: LEGIBLE_MAP_HEIGHT }),
                error: 'Cannot take screenshot',
            }),
        );
    });
});
