import type { Page } from 'playwright-core';
import type { Logger } from 'pino';
import {
    MAX_LEGIBLE_OVERVIEW_ASPECT_RATIO,
    VisionOverviewRefusal,
    visionOverviewRefusal,
} from '../pi/single-shot-input';
import type { TraceRecorder } from '../tracer/trace-recorder';
import { TraceEventType } from '../types/trace';
import { ScreenshotArtifactType, type FullPageTileCoverage } from '../types/validation';
import { writeArtifact } from './full-page-tiles';
import { MAX_PAGE_STABILIZATION_TIMEOUT_MS } from './page-stability';

/**
 * The map of a page state too tall for its full-page overview to be read as one image.
 *
 * A provider fits an image into a bounded square, so the overview of a page far taller than wide
 * arrives too narrow to read, and a model shown it invents what it cannot see. The map of such a
 * page is the top of the span its tiles cover instead, cut at the aspect the overview is held to:
 * it shows where the tiles sit, and nothing the tiles could not confirm.
 */

/**
 * JPEG quality of the map: it is downscaled before any model sees it, so it only has to show the
 * layout, and a span of several screens stays small.
 */
const TILE_WINDOW_MAP_JPEG_QUALITY = 60;

/**
 * Bound on the map capture: the one the browser tools give each tile clip by default, since the map
 * is one more clip of the same stabilized page.
 */
const TILE_WINDOW_MAP_TIMEOUT_MS = MAX_PAGE_STABILIZATION_TIMEOUT_MS;

/**
 * Longest capture error kept in the trace, in characters.
 */
const MAX_TILE_WINDOW_MAP_ERROR_CHARS = 500;

/**
 * Trace phase naming a failed map capture, so a run's trace says why a tall page state has tiles
 * but no map.
 */
const TILE_WINDOW_MAP_CAPTURE_PHASE = 'tile_window_map_capture';

/**
 * Add the tile window map to a coverage whose document is too tall for its overview to be read.
 *
 * Any other coverage comes back as it is. The map spans the tiles from the top of the first, at
 * most as tall as the legible aspect allows. A capture the browser refuses is recorded in the trace
 * with the clip it asked for and leaves the coverage without a map: the map orients the model, the
 * tiles carry the proof.
 *
 * @param page - Page holding the document the tiles were captured from.
 * @param artifactsDir - Runner-owned artifact directory.
 * @param recorder - Trace recorder that owns the map and records a failed capture.
 * @param coverage - The tile coverage just captured.
 * @param logger - Operational logger that also gets a failed capture, when the caller passes one.
 * @returns The coverage, with its map when one was due and captured.
 */
export async function withTileWindowMap(
    page: Page,
    artifactsDir: string,
    recorder: TraceRecorder,
    coverage: FullPageTileCoverage,
    logger?: Logger,
): Promise<FullPageTileCoverage> {
    const { documentWidth, documentHeight, tiles } = coverage;
    if (
        tiles.length === 0 ||
        visionOverviewRefusal({ documentWidth, documentHeight }) !== VisionOverviewRefusal.Illegible
    ) {
        return coverage;
    }
    const y = Math.min(...tiles.map((tile) => tile.y));
    const bottom = Math.max(...tiles.map((tile) => tile.y + tile.height));
    const clip = {
        x: 0,
        y,
        width: documentWidth,
        height: Math.min(bottom - y, Math.floor(MAX_LEGIBLE_OVERVIEW_ASPECT_RATIO * documentWidth)),
    };
    try {
        const jpeg = await page.screenshot({
            fullPage: true,
            clip,
            scale: 'css',
            timeout: TILE_WINDOW_MAP_TIMEOUT_MS,
            type: 'jpeg',
            quality: TILE_WINDOW_MAP_JPEG_QUALITY,
        });
        const artifactId = writeArtifact(
            artifactsDir,
            'jpg',
            jpeg,
            ScreenshotArtifactType.TileWindowMap,
            recorder,
        );
        return { ...coverage, map: { artifactId, y, height: clip.height } };
    } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(
            0,
            MAX_TILE_WINDOW_MAP_ERROR_CHARS,
        );
        recorder.record(TraceEventType.Error, {
            phase: TILE_WINDOW_MAP_CAPTURE_PHASE,
            clip,
            documentHeight,
            error: message,
        });
        logger?.warn({ err: error, clip, documentHeight }, 'tile window map capture failed');
        return coverage;
    }
}
