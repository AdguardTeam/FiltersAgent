import { VisionOverviewRefusal, visionOverviewRefusal } from '../pi/single-shot-input';
import type { FullPageTileCoverage, PhaseResult } from '../types/validation';

/**
 * When the original-resolution tiles of one page state prove it without a full-page overview.
 *
 * The browser cannot always capture an overview: Chromium refuses a document taller than about
 * 17,500 px. A tile capture's `complete` covers its window only. The pre-candidate inventory reads
 * the rest of the page from the overview; the candidate review shows it only as a map and answers
 * for the window. Without an overview the tiles prove the state on the terms the candidate review's
 * `planFullPageOverview` applies: they cover the whole document, or the document is too tall for
 * any overview to be read, and the window is all a review could inspect anyway.
 */

/**
 * Decide whether complete tiles prove a page state that has no full-page overview.
 *
 * @param coverage - The state's tile coverage, when it captured tiles.
 * @returns Whether the tiles cover the whole document, or their window of an illegibly tall one.
 */
export function tilesProveStateWithoutOverview(
    coverage: FullPageTileCoverage | undefined,
): boolean {
    if (coverage?.complete !== true || coverage.tiles.length === 0) {
        return false;
    }
    return (
        !coverage.window ||
        visionOverviewRefusal({
            documentWidth: coverage.documentWidth,
            documentHeight: coverage.documentHeight,
        }) === VisionOverviewRefusal.Illegible
    );
}

/**
 * Decide whether one phase's capture proves its page state.
 *
 * @param result - Phase facts the runner captured.
 * @returns Whether the phase holds a viewport screenshot and either an overview or tiles that prove
 *   the state without one.
 */
export function phaseCapturedPageState(result: PhaseResult): boolean {
    return (
        result.screenshotArtifactId.length > 0 &&
        (Boolean(result.fullPageScreenshotArtifactId) ||
            tilesProveStateWithoutOverview(result.tileCoverage))
    );
}
