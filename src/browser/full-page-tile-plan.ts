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
 * Plan the clips of one tile capture, fitting an explicit window to the tile limit.
 *
 * A window (explicit, or the caller's default first-screens cap) shrinks the plan below the full
 * document. Every row takes one clip per column, so a document wider than the viewport fills the
 * limit with fewer rows. When `keepFirstRows` is set and the window needs more clips than `limit`,
 * the plan keeps the rows that fit, top first, and its window ends where the first dropped row
 * starts. The kept rows cover that window continuously, which is what a consumer checks a window's
 * coverage against, and a capture given the window back plans exactly the kept rows, so a later
 * state can replay it over the same span. Otherwise the plan is returned whole, and the caller
 * refuses one over the limit.
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
    const window = tileWindow
        ? {
              fromY: Math.max(0, Math.min(tileWindow.fromY, document.height)),
              toY: Math.max(0, Math.min(tileWindow.toY, document.height)),
          }
        : null;
    const xStarts = fullPageTileStarts(document.width, viewport.width, overlapPx);
    const allYStarts = fullPageTileStarts(document.height, viewport.height, overlapPx);
    const windowYStarts = window
        ? allYStarts.filter(
              (y) =>
                  y < window.toY && Math.min(y + viewport.height, document.height) > window.fromY,
          )
        : allYStarts;
    const rowCapacity = Math.floor(limit / xStarts.length);
    const trimmed =
        keepFirstRows && window !== null && rowCapacity > 0 && windowYStarts.length > rowCapacity;
    const rows = trimmed ? windowYStarts.slice(0, rowCapacity) : windowYStarts;
    return {
        clips: rows.flatMap((y) => xStarts.map((x) => ({ x, y }))),
        window:
            trimmed && window
                ? { fromY: window.fromY, toY: Math.min(window.toY, windowYStarts[rowCapacity]) }
                : window,
        windowTrimmed: trimmed,
    };
}
