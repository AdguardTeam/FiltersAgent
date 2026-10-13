import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import type { TraceRecorder } from '../tracer/trace-recorder';
import {
    type FullPageTileCoverage,
    type FullPageTileWindow,
    type CaptureState,
} from '../types/validation';

/**
 * Full-page screenshot tiling: probing, tile window math, and artifact writes.
 */
/**
 * Default overlap retained between adjacent original-resolution page tiles.
 */
const DEFAULT_FULL_PAGE_TILE_OVERLAP_PX = 160;

/**
 * Maximum image count used to keep one semantic review bounded.
 *
 * Matches the hard configuration cap so tall reporter pages (tens of thousands of pixels) still
 * complete tile coverage instead of failing the capture deterministically.
 */
const DEFAULT_FULL_PAGE_TILE_LIMIT = 48;

/**
 * Number of viewport heights ("screens") the DEFAULT capture inspects when the caller supplies no
 * explicit `tileWindow`.
 *
 * Tiling the entire document of an endless-feed page produces roughly 20 vision artifacts for a
 * single full-page inventory, and a task can take several inventories; over a 40-task run, 5 such
 * tasks consumed 58% of all vision images. A page this long behaves like a feed, and scrolling it
 * to the bottom proves nothing about the reported issue, so the DEFAULT plan (no caller-supplied
 * window) is capped to the first `DEFAULT_FULL_PAGE_WINDOW_SCREENS` viewport heights. This never
 * clips an explicitly supplied `tileWindow` (e.g. the selector-derived window from
 * `measureElementTileWindow`), which may legitimately point below this cap and always wins
 * verbatim.
 *
 * Five screens: a 9-screen page slips under a ten-screen cap and can still cost a task 98 vision
 * images, and by the fifth screen of a long page the content is the same repeating feed — anything
 * the default sweep would learn below, it has already learned above. Symptoms at a known depth are
 * unaffected: the selector-derived window is exempt from the cap by design.
 */
const DEFAULT_FULL_PAGE_WINDOW_SCREENS = 5;

/**
 * Stable prefix identifying the sole technical failure eligible for one tiled-capture retry.
 */
const FULL_PAGE_TILE_DIMENSION_CHANGE_ERROR_PREFIX =
    'Page document dimensions changed during tile capture:';

/**
 * Fixed page probe used only to size and label full-page tiles.
 */
const FULL_PAGE_TILE_PROBE = `
(function () {
    var marker = '__adguard_full_page_tile_probe__';
    var root = document.documentElement;
    var body = document.body;
    var width = Math.max(
        root ? root.scrollWidth : 0,
        root ? root.offsetWidth : 0,
        root ? root.clientWidth : 0,
        body ? body.scrollWidth : 0,
        body ? body.offsetWidth : 0,
        body ? body.clientWidth : 0
    );
    var height = Math.max(
        root ? root.scrollHeight : 0,
        root ? root.offsetHeight : 0,
        root ? root.clientHeight : 0,
        body ? body.scrollHeight : 0,
        body ? body.offsetHeight : 0,
        body ? body.clientHeight : 0
    );
    var landmarks = Array.prototype.slice
        .call(document.querySelectorAll('h1, h2, h3, h4, [role="heading"]'), 0, 200)
        .map(function (element) {
            var rect = element.getBoundingClientRect();
            return {
                y: Math.max(0, rect.top + (Number(window.scrollY) || 0)),
                text: String(element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
            };
        })
        .filter(function (landmark) { return landmark.text.length > 0; });
    return {
        marker: marker,
        documentWidth: width,
        documentHeight: height,
        scrollX: Math.max(0, Number(window.scrollX) || 0),
        scrollY: Math.max(0, Number(window.scrollY) || 0),
        landmarks: landmarks,
    };
})()
`;

/**
 * Bounded heading-like landmark returned by the fixed page tile probe.
 */
interface FullPageTileLandmark {
    /**
     * Vertical document coordinate of the landmark.
     */
    y: number;

    /**
     * Bounded visible heading text.
     */
    text: string;
}

/**
 * Trusted shape parsed from the fixed page tile probe.
 */
interface FullPageTileProbeResult {
    /**
     * Full rendered document width in CSS pixels.
     */
    documentWidth: number;

    /**
     * Full rendered document height in CSS pixels.
     */
    documentHeight: number;

    /**
     * Horizontal viewport position observed without modifying page state.
     */
    scrollX: number;

    /**
     * Vertical viewport position observed without modifying page state.
     */
    scrollY: number;

    /**
     * Bounded visible headings used to label tiles.
     */
    landmarks: FullPageTileLandmark[];
}

/**
 * Exact pixel dimensions decoded from one PNG IHDR chunk.
 */
interface PngDimensions {
    /**
     * Encoded image width in pixels.
     */
    width: number;

    /**
     * Encoded image height in pixels.
     */
    height: number;
}

/**
 * Write data to disk as an artifact and register it with the trace recorder.
 *
 * @param dir - The artifacts directory.
 * @param suffix - File extension (e.g., 'png', 'html', 'json').
 * @param data - The data to write (Buffer or string).
 * @param type - The artifact type for the trace (e.g., 'screenshot', 'dom', 'har').
 * @param recorder - The trace recorder to register the artifact with.
 * @returns The generated artifact ID.
 */
export function writeArtifact(
    dir: string,
    suffix: string,
    data: Buffer | string,
    type: string,
    recorder: TraceRecorder,
): string {
    mkdirSync(dir, { recursive: true });
    const id = randomUUID();
    const filename = `${id}.${suffix}`;
    const fullPath = join(dir, filename);
    writeFileSync(fullPath, data);
    recorder.addArtifact({
        id,
        path: fullPath,
        type,
        bytes: Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data),
    });
    return id;
}

/**
 * Parse the fixed page tile probe without trusting arbitrary page-owned values.
 *
 * @param value - Unknown fixed-probe result returned by Playwright.
 * @returns Bounded page dimensions and landmarks, or undefined for malformed output.
 */
function parseFullPageTileProbe(value: unknown): FullPageTileProbeResult | undefined {
    if (value === null || typeof value !== 'object') {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    const documentWidth = Number(record.documentWidth);
    const documentHeight = Number(record.documentHeight);
    if (
        !Number.isFinite(documentWidth) ||
        !Number.isFinite(documentHeight) ||
        documentWidth <= 0 ||
        documentHeight <= 0
    ) {
        return undefined;
    }
    const landmarks = Array.isArray(record.landmarks)
        ? record.landmarks.slice(0, 200).flatMap((landmark): FullPageTileLandmark[] => {
              if (landmark === null || typeof landmark !== 'object') {
                  return [];
              }
              const item = landmark as Record<string, unknown>;
              const y = Number(item.y);
              const text = typeof item.text === 'string' ? item.text.trim().slice(0, 120) : '';
              return Number.isFinite(y) && y >= 0 && text ? [{ y, text }] : [];
          })
        : [];
    const scrollX = Number(record.scrollX ?? 0);
    const scrollY = Number(record.scrollY ?? 0);
    return {
        documentWidth: Math.ceil(documentWidth),
        documentHeight: Math.ceil(documentHeight),
        scrollX: Number.isFinite(scrollX) && scrollX >= 0 ? scrollX : 0,
        scrollY: Number.isFinite(scrollY) && scrollY >= 0 ? scrollY : 0,
        landmarks,
    };
}

/**
 * Read the fixed document-dimension and landmark probe without trusting malformed page output.
 *
 * @param page - Active page containing the rendered document.
 * @returns Parsed document geometry, or undefined when evaluation fails or is malformed.
 */
async function readFullPageTileProbe(page: Page): Promise<FullPageTileProbeResult | undefined> {
    try {
        return parseFullPageTileProbe(await page.evaluate(FULL_PAGE_TILE_PROBE));
    } catch {
        return undefined;
    }
}

/**
 * Read the exact CSS-pixel dimensions encoded by a PNG IHDR chunk.
 *
 * @param buffer - PNG bytes returned by Playwright.
 * @returns Positive image dimensions, or undefined for a malformed/non-PNG buffer.
 */
function parsePngDimensions(buffer: Buffer): PngDimensions | undefined {
    if (buffer.length < 24) {
        return undefined;
    }
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (!buffer.subarray(0, signature.length).equals(signature)) {
        return undefined;
    }
    if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
        return undefined;
    }
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * Calculate overlapping tile starts that cover one complete document axis.
 *
 * @param extent - Full document width or height.
 * @param tileExtent - Viewport-sized tile width or height.
 * @param overlap - Requested overlap between adjacent tiles.
 * @returns Ordered unique start coordinates including the exact far edge.
 */
function fullPageTileStarts(extent: number, tileExtent: number, overlap: number): number[] {
    if (extent <= tileExtent) {
        return [0];
    }
    const step = Math.max(1, tileExtent - Math.min(overlap, tileExtent - 1));
    const starts: number[] = [];
    for (let start = 0; start + tileExtent < extent; start += step) {
        starts.push(start);
    }
    starts.push(Math.max(0, extent - tileExtent));
    return [...new Set(starts)];
}

/**
 * Select bounded page landmarks that lie inside one vertical tile.
 *
 * @param landmarks - Runner-parsed heading landmarks for the document.
 * @param y - Tile start coordinate.
 * @param height - Tile height.
 * @returns Human-readable tile landmark with a deterministic coordinate fallback.
 */
function fullPageTileLandmark(
    landmarks: readonly FullPageTileLandmark[],
    y: number,
    height: number,
): string {
    const visible = landmarks
        .filter((landmark) => landmark.y >= y && landmark.y < y + height)
        .slice(0, 3)
        .map((landmark) => landmark.text);
    return visible.length > 0
        ? visible.join(' / ').slice(0, 500)
        : `Document y=${y}..${y + height}`;
}

/**
 * Verify that one pre/post-clip probe still describes the attempt's immutable page state.
 *
 * @param expected - Baseline document and scroll state for the attempt.
 * @param observed - Fresh document and scroll state around one clip.
 * @param viewport - Fresh Playwright viewport dimensions.
 * @param viewportWidth - Baseline viewport width.
 * @param viewportHeight - Baseline viewport height.
 * @param phase - Whether the observation was taken before or after the PNG capture.
 * @returns Bounded failure detail, or undefined when state is unchanged.
 */
function fullPageTileStateError(
    expected: FullPageTileProbeResult,
    observed: FullPageTileProbeResult | undefined,
    viewport: ReturnType<Page['viewportSize']>,
    viewportWidth: number,
    viewportHeight: number,
    phase: CaptureState,
): string | undefined {
    if (!observed) {
        return `Page dimensions were unavailable ${phase} document clip capture.`;
    }
    if (
        Math.abs(observed.scrollX - expected.scrollX) > 1 ||
        Math.abs(observed.scrollY - expected.scrollY) > 1
    ) {
        return (
            `Page scroll position changed ${phase} document clip capture: ` +
            `${expected.scrollX},${expected.scrollY} -> ` +
            `${observed.scrollX},${observed.scrollY}.`
        );
    }
    if (
        !viewport ||
        Math.floor(viewport.width) !== viewportWidth ||
        Math.floor(viewport.height) !== viewportHeight
    ) {
        return `Page viewport dimensions changed ${phase} document clip capture.`;
    }
    if (
        observed.documentWidth !== expected.documentWidth ||
        observed.documentHeight !== expected.documentHeight
    ) {
        return (
            `${FULL_PAGE_TILE_DIMENSION_CHANGE_ERROR_PREFIX} ` +
            `${expected.documentWidth}x${expected.documentHeight} -> ` +
            `${observed.documentWidth}x${observed.documentHeight}.`
        );
    }
    return undefined;
}

/**
 * Capture one set of tiles against one immutable dimension probe without restoring the viewport.
 *
 * @param page - Active Playwright page containing the document.
 * @param artifactsDir - Runner-owned artifact directory.
 * @param recorder - Trace recorder that owns every emitted tile.
 * @param probe - Dimensions and landmarks fixed for this attempt.
 * @param viewportWidth - Exact viewport width in CSS pixels.
 * @param viewportHeight - Exact viewport height in CSS pixels.
 * @param overlapPx - Bounded overlap between adjacent tiles.
 * @param limit - Maximum number of emitted tiles.
 * @param screenshotTimeoutMs - Bounded Playwright timeout for each clip.
 * @param tileWindow - Optional document-space vertical span restricting the tile plan.
 * @returns Mechanical coverage proof for this single attempt.
 */
async function captureFullPageTileAttempt(
    page: Page,
    artifactsDir: string,
    recorder: TraceRecorder,
    probe: FullPageTileProbeResult,
    viewportWidth: number,
    viewportHeight: number,
    overlapPx: number,
    limit: number,
    screenshotTimeoutMs: number,
    tileWindow?: FullPageTileWindow,
): Promise<FullPageTileCoverage> {
    const window = tileWindow
        ? {
              fromY: Math.max(0, Math.min(tileWindow.fromY, probe.documentHeight)),
              toY: Math.max(0, Math.min(tileWindow.toY, probe.documentHeight)),
          }
        : null;
    const xStarts = fullPageTileStarts(probe.documentWidth, viewportWidth, overlapPx);
    const allYStarts = fullPageTileStarts(probe.documentHeight, viewportHeight, overlapPx);
    // A window (explicit or the caller's default first-N-screens cap, resolved by
    // captureFullPageTiles before this call) shrinks the planned region below the full document.
    // `complete` below is computed relative to plannedClips, not to the document, so capping the
    // window on a long page still reports `complete: true` once every planned clip is captured.
    // That is intentional: a `complete: false` coverage strips vision-verified status from the
    // whole session, and the point of the default cap is to keep long-page sessions verifiable,
    // not to fail them.
    const yStarts = window
        ? allYStarts.filter(
              (y) =>
                  y < window.toY &&
                  Math.min(y + viewportHeight, probe.documentHeight) > window.fromY,
          )
        : allYStarts;
    const plannedClips = yStarts.flatMap((y) => xStarts.map((x) => ({ x, y })));
    const tiles: FullPageTileCoverage['tiles'] = [];
    if (plannedClips.length === 0 || plannedClips.length > limit) {
        return {
            complete: false,
            documentWidth: probe.documentWidth,
            documentHeight: probe.documentHeight,
            viewportWidth,
            viewportHeight,
            overlapPx,
            tiles,
            window,
            error:
                plannedClips.length === 0
                    ? 'The requested tile window excluded every planned tile.'
                    : `Tile capture required ${plannedClips.length} images but was bounded to ${limit}.`,
        };
    }
    let captureError: string | undefined;
    for (const [index, clipStart] of plannedClips.entries()) {
        const width = Math.min(viewportWidth, probe.documentWidth - clipStart.x);
        const height = Math.min(viewportHeight, probe.documentHeight - clipStart.y);
        try {
            const before = await readFullPageTileProbe(page);
            captureError = fullPageTileStateError(
                probe,
                before,
                page.viewportSize(),
                viewportWidth,
                viewportHeight,
                'before',
            );
            if (captureError) {
                break;
            }
            const buffer = await page.screenshot({
                fullPage: true,
                clip: { x: clipStart.x, y: clipStart.y, width, height },
                scale: 'css',
                timeout: screenshotTimeoutMs,
                type: 'png',
            });
            const after = await readFullPageTileProbe(page);
            captureError = fullPageTileStateError(
                probe,
                after,
                page.viewportSize(),
                viewportWidth,
                viewportHeight,
                'after',
            );
            if (captureError) {
                break;
            }
            const pngDimensions = parsePngDimensions(buffer);
            if (pngDimensions?.width !== width || pngDimensions.height !== height) {
                captureError =
                    'Document clip PNG dimensions did not match the requested CSS-pixel tile.';
                break;
            }
            const artifactId = writeArtifact(
                artifactsDir,
                'png',
                buffer,
                'screenshot-tile',
                recorder,
            );
            tiles.push({
                artifactId,
                index,
                x: clipStart.x,
                y: clipStart.y,
                width,
                height,
                landmark: fullPageTileLandmark(probe.landmarks, clipStart.y, height),
            });
        } catch (error) {
            captureError = String((error as Error).message).slice(0, 500);
            break;
        }
    }
    const complete = plannedClips.length > 0 && tiles.length === plannedClips.length;
    return {
        window,
        complete,
        documentWidth: probe.documentWidth,
        documentHeight: probe.documentHeight,
        viewportWidth,
        viewportHeight,
        overlapPx,
        tiles,
        ...(!complete
            ? {
                  error:
                      captureError ??
                      `Tile capture required ${plannedClips.length} images but was bounded to ${limit}.`,
              }
            : {}),
    };
}

/**
 * Validate an optional caller-supplied document-space vertical span for bounded tile capture.
 *
 * Unknown shapes degrade to a full-document plan instead of failing the capture: the window is a
 * cost optimization, never a correctness gate.
 *
 * @param value - Raw tool argument candidate.
 * @returns Exact span with `fromY` strictly below `toY`, or undefined when unusable.
 */
export function parseTileWindowArg(value: unknown): FullPageTileWindow | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const candidate = value as Record<string, unknown>;
    const fromY = candidate.fromY;
    const toY = candidate.toY;
    if (
        typeof fromY !== 'number' ||
        !Number.isFinite(fromY) ||
        typeof toY !== 'number' ||
        !Number.isFinite(toY) ||
        fromY < 0 ||
        fromY >= toY
    ) {
        return undefined;
    }
    return { fromY, toY };
}

/**
 * Capture overlapping original-resolution document clips without changing viewport scroll state.
 *
 * Playwright interprets `clip` as document coordinates when `fullPage=true` and uses Chromium's
 * capture-beyond-viewport path. A dimension transition receives one fresh-probe retry; other
 * failures and a second transition remain fail-closed.
 *
 * When `tileWindow` is omitted and the document exceeds `DEFAULT_FULL_PAGE_WINDOW_SCREENS` viewport
 * heights, the plan defaults to the first `DEFAULT_FULL_PAGE_WINDOW_SCREENS` screens instead of the
 * whole document, and the returned coverage sets `windowDefaulted`. A caller that supplies
 * `tileWindow` always gets it back unchanged, never clipped by this default.
 *
 * @param page - Active Playwright page containing the stabilized document.
 * @param artifactsDir - Runner-owned artifact directory.
 * @param recorder - Trace recorder that owns every emitted tile.
 * @param configuredOverlapPx - Optional requested overlap between adjacent tiles.
 * @param configuredLimit - Optional maximum tile count for one page state.
 * @param screenshotTimeoutMs - Bounded timeout for each Playwright clip capture.
 * @param tileWindow - Optional document-space vertical span restricting the tile plan.
 * @returns Mechanical coverage proof and exact registered tile identities.
 */
export async function captureFullPageTiles(
    page: Page,
    artifactsDir: string,
    recorder: TraceRecorder,
    configuredOverlapPx: number | undefined,
    configuredLimit: number | undefined,
    screenshotTimeoutMs: number,
    tileWindow?: FullPageTileWindow,
): Promise<FullPageTileCoverage> {
    const viewport = page.viewportSize();
    const viewportWidth = Math.max(0, Math.floor(viewport?.width ?? 0));
    const viewportHeight = Math.max(0, Math.floor(viewport?.height ?? 0));
    const requestedOverlap = Number.isFinite(configuredOverlapPx)
        ? Math.max(0, Math.floor(configuredOverlapPx ?? 0))
        : DEFAULT_FULL_PAGE_TILE_OVERLAP_PX;
    const overlapPx = Math.min(
        requestedOverlap,
        Math.max(0, Math.min(viewportWidth, viewportHeight) - 1),
    );
    const limit = Number.isFinite(configuredLimit)
        ? Math.min(48, Math.max(1, Math.floor(configuredLimit ?? 1)))
        : DEFAULT_FULL_PAGE_TILE_LIMIT;
    let probe = await readFullPageTileProbe(page);
    if (!probe || viewportWidth === 0 || viewportHeight === 0) {
        return {
            complete: false,
            documentWidth: probe?.documentWidth ?? 0,
            documentHeight: probe?.documentHeight ?? 0,
            viewportWidth,
            viewportHeight,
            overlapPx,
            tiles: [],
            window: tileWindow ?? null,
            error: 'Page dimensions were unavailable for original-resolution tile capture.',
        };
    }

    // DEFAULT_FULL_PAGE_WINDOW_SCREENS caps the DEFAULT plan only: an explicitly supplied
    // tileWindow (e.g. the selector-derived window from measureElementTileWindow, which may
    // legitimately point below this cap) is used unchanged and is never clipped here.
    const defaultWindowThresholdPx = DEFAULT_FULL_PAGE_WINDOW_SCREENS * viewportHeight;
    const windowDefaulted = !tileWindow && probe.documentHeight > defaultWindowThresholdPx;
    const effectiveTileWindow: FullPageTileWindow | undefined = tileWindow
        ? tileWindow
        : windowDefaulted
          ? { fromY: 0, toY: defaultWindowThresholdPx }
          : undefined;

    let coverage = await captureFullPageTileAttempt(
        page,
        artifactsDir,
        recorder,
        probe,
        viewportWidth,
        viewportHeight,
        overlapPx,
        limit,
        screenshotTimeoutMs,
        effectiveTileWindow,
    );
    if (coverage.error?.startsWith(FULL_PAGE_TILE_DIMENSION_CHANGE_ERROR_PREFIX)) {
        probe = await readFullPageTileProbe(page);
        if (probe) {
            coverage = await captureFullPageTileAttempt(
                page,
                artifactsDir,
                recorder,
                probe,
                viewportWidth,
                viewportHeight,
                overlapPx,
                limit,
                screenshotTimeoutMs,
                effectiveTileWindow,
            );
        } else {
            coverage = {
                ...coverage,
                complete: false,
                error: 'Page dimensions were unavailable for the single tile capture retry.',
            };
        }
    }
    // Surface the default cap on the coverage itself (repo directive: no silent caps) so
    // consumers can tell "inspected the first N screens of a taller document" apart from a
    // genuinely short page or a caller-chosen window.
    return windowDefaulted ? { ...coverage, windowDefaulted: true } : coverage;
}
