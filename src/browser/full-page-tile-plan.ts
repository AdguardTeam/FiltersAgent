/**
 * Full-page tile planning: which document clips one capture takes and which window they cover.
 *
 * Pure geometry, kept apart from the capture that drives the browser, so the fit of a window to the
 * tile limit is decided in one place.
 */
import type { FullPageTileWindow } from '../types/validation';

/**
 * Width and height of a document or viewport in CSS pixels.
 */
interface FullPageTileExtent {
    /**
     * Horizontal extent in CSS pixels.
     */
    width: number;

    /**
     * Vertical extent in CSS pixels.
     */
    height: number;
}

/**
 * Document-space origin of one planned tile clip.
 */
interface FullPageTileClip {
    /**
     * Left edge of the clip in document coordinates.
     */
    x: number;

    /**
     * Top edge of the clip in document coordinates.
     */
    y: number;
}

/**
 * The clips one tile capture takes and the window they cover.
 */
export interface FullPageTilePlan {
    /**
     * Clip origins in capture order: rows top first, each row's columns left to right.
     */
    clips: FullPageTileClip[];

    /**
     * Window the clips cover: the requested one clamped to the document, or the span of the rows a
     * trimmed window kept; null when the plan covers the whole document.
     */
    window: FullPageTileWindow | null;

    /**
     * Whether an explicit window lost rows to the tile limit.
     */
    windowTrimmed: boolean;
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
 * The vertical spans a window covers, top first: the span from the top of the page down to `topToY`
 * when the window has one, then the window's own span.
 *
 * @param window - Window of a tile capture.
 * @returns Its spans, each a plain window without a top span.
 */
export function tileWindowSpans(window: FullPageTileWindow): FullPageTileWindow[] {
    const own = { fromY: window.fromY, toY: window.toY };
    return window.topToY === undefined ? [own] : [{ fromY: 0, toY: window.topToY }, own];
}

/**
 * Clamp a requested window to the document, folding a top span that reaches the window's own span
 * into one span from the top.
 *
 * @param window - Requested window.
 * @param documentHeight - Document height the capture measured.
 * @returns The window within the document.
 */
function clampTileWindow(window: FullPageTileWindow, documentHeight: number): FullPageTileWindow {
    const clamp = (y: number): number => Math.max(0, Math.min(y, documentHeight));
    const fromY = clamp(window.fromY);
    const toY = clamp(window.toY);
    if (window.topToY === undefined) {
        return { fromY, toY };
    }
    const topToY = clamp(window.topToY);
    return topToY >= fromY ? { fromY: 0, toY: Math.max(toY, topToY) } : { fromY, toY, topToY };
}

/**
 * Plan the clips of one tile capture, fitting an explicit window to the tile limit.
 *
 * A window (explicit, or the caller's default first-screens cap) shrinks the plan below the full
 * document; a window with a top span plans the rows of both spans and none of the gap between them.
 * Every row takes one clip per column, so a document wider than the viewport fills the limit with
 * fewer rows. When `keepFirstRows` is set and the window needs more clips than `limit`, the plan
 * keeps the rows that fit, top first, and its window ends where the first dropped row starts: the
 * top span alone when that row belongs to it. The kept rows cover that window continuously, which
 * is what a consumer checks a window's coverage against, and a capture given the window back plans
 * exactly the kept rows, so a later state can replay it over the same spans. Otherwise the plan is
 * returned whole, and the caller refuses one over the limit.
 *
 * @param document - Full document extent the capture measured.
 * @param viewport - Viewport extent, which is also the size of one clip.
 * @param overlapPx - Bounded overlap between adjacent clips.
 * @param limit - Maximum number of clips one capture takes.
 * @param tileWindow - Optional document-space vertical span restricting the plan.
 * @param keepFirstRows - Whether a window over the limit keeps the rows that fit.
 * @returns The planned clips and the window they cover.
 */
export function planFullPageTileClips(
    document: FullPageTileExtent,
    viewport: FullPageTileExtent,
    overlapPx: number,
    limit: number,
    tileWindow: FullPageTileWindow | undefined,
    keepFirstRows: boolean,
): FullPageTilePlan {
    const window = tileWindow ? clampTileWindow(tileWindow, document.height) : null;
    const xStarts = fullPageTileStarts(document.width, viewport.width, overlapPx);
    const allYStarts = fullPageTileStarts(document.height, viewport.height, overlapPx);
    const spans = window ? tileWindowSpans(window) : [];
    const windowYStarts = window
        ? allYStarts.filter((y) =>
              spans.some(
                  (span) =>
                      y < span.toY && Math.min(y + viewport.height, document.height) > span.fromY,
              ),
          )
        : allYStarts;
    const rowCapacity = Math.floor(limit / xStarts.length);
    const trimmed =
        keepFirstRows && window !== null && rowCapacity > 0 && windowYStarts.length > rowCapacity;
    const rows = trimmed ? windowYStarts.slice(0, rowCapacity) : windowYStarts;
    return {
        clips: rows.flatMap((y) => xStarts.map((x) => ({ x, y }))),
        window: trimmed && window ? trimTileWindow(window, windowYStarts[rowCapacity]) : window,
        windowTrimmed: trimmed,
    };
}

/**
 * The window a trimmed capture's kept rows cover.
 *
 * @param window - Window the capture planned.
 * @param cutY - Start of the first row the tile limit dropped.
 * @returns The top span alone, as far as its rows were kept, when no row of the window's own span
 *   was; otherwise the window with its own span cut at the dropped row.
 */
function trimTileWindow(window: FullPageTileWindow, cutY: number): FullPageTileWindow {
    if (window.topToY !== undefined && cutY <= window.fromY) {
        return { fromY: 0, toY: Math.min(cutY, window.topToY) };
    }
    return { ...window, toY: Math.min(window.toY, cutY) };
}
