import type * as v from 'valibot';
import { FULL_PAGE_CAPTURE_INCOMPLETE_KIND } from '../analyzer/full-page-capture-inspection';
import type { PreCandidateCaptureSchema } from '../analyzer/full-page-visual-batches';
import { visionOverviewRefusal } from '../pi/single-shot-input';
import type { FullPageTileCoverage } from '../types/validation';
import { tilesProveStateWithoutOverview } from '../validator/tile-coverage-proof';

/**
 * What one `screenshot` result says about the page state it captured, read the way the runtime's
 * vision requirement and the batch inventory both read it.
 *
 * The full-page overview is context: the browser cannot capture one of a very tall document, and an
 * overview no single vision request can carry or read is withheld anyway. The original-resolution
 * tiles carry the coverage proof: with an overview, complete tiles over their window; without one,
 * tiles that prove the state alone (`tilesProveStateWithoutOverview`).
 */

/**
 * Coverage facts of one screenshot result.
 */
export interface ScreenshotCaptureFacts {
    /**
     * Viewport screenshot, when the call captured one.
     */
    viewportArtifactId?: string;

    /**
     * Full-page overview, when the browser captured one.
     */
    fullPageArtifactId?: string;

    /**
     * Tile coverage the call returned, when it captured tiles.
     */
    tileCoverage?: FullPageTileCoverage;

    /**
     * Tile artifacts in document order.
     */
    tileArtifactIds: string[];

    /**
     * Whether the tiles prove the captured page state.
     */
    coverageComplete: boolean;

    /**
     * Images vision must inspect before the capture counts as seen: every tile, plus the overview
     * when one exists that a vision request can carry and read.
     */
    requiredArtifactIds: string[];
}

/**
 * Read the coverage facts of one `screenshot` tool result.
 *
 * @param result - The runner's own `screenshot` result.
 * @param artifactBytes - Recorded size of a registered artifact.
 * @returns What the capture holds and what vision must inspect of it.
 */
export function readScreenshotCapture(
    result: Record<string, unknown>,
    artifactBytes: (artifactId: string) => number | undefined,
): ScreenshotCaptureFacts {
    const capture = result as Partial<v.InferOutput<typeof PreCandidateCaptureSchema>>;
    const { artifactId: viewportArtifactId, fullPageArtifactId, tileCoverage } = capture;
    const tileArtifactIds = tileCoverage?.tiles.map((tile) => tile.artifactId) ?? [];
    const coverageComplete =
        fullPageArtifactId === undefined
            ? tilesProveStateWithoutOverview(tileCoverage)
            : tileCoverage?.complete === true && tileArtifactIds.length > 0;
    // The vision inventory excludes an overview no single request can carry or read, so the
    // runtime must not demand its inspection either. Both sides read the one shared rule.
    const overviewVisionEligible =
        fullPageArtifactId !== undefined &&
        visionOverviewRefusal({
            bytes: artifactBytes(fullPageArtifactId),
            documentWidth: tileCoverage?.documentWidth,
            documentHeight: tileCoverage?.documentHeight,
        }) === null;
    return {
        ...(viewportArtifactId === undefined ? {} : { viewportArtifactId }),
        ...(fullPageArtifactId === undefined ? {} : { fullPageArtifactId }),
        ...(tileCoverage === undefined ? {} : { tileCoverage }),
        tileArtifactIds,
        coverageComplete,
        requiredArtifactIds: coverageComplete
            ? [...(overviewVisionEligible ? [fullPageArtifactId] : []), ...tileArtifactIds]
            : [],
    };
}

/**
 * Refuse batch vision over a capture whose tiles do not prove the page, saying what is missing.
 *
 * The model is told what the capture lacks and pointed at the evidence it does have: an overview
 * the browser never captured is not offered as a fallback.
 *
 * @param rawCapture - The runner's own `screenshot` result the capture was recorded from.
 * @returns The non-retryable `inspect_full_page_capture` answer.
 */
export function incompleteCaptureRefusal(
    rawCapture: Record<string, unknown>,
): Record<string, unknown> {
    const { fullPageArtifactId, tileCoverage } = rawCapture as Partial<
        v.InferOutput<typeof PreCandidateCaptureSchema>
    >;
    const overviewCaptured = fullPageArtifactId !== undefined;
    const window = tileCoverage?.window;
    const detail =
        tileCoverage?.error ??
        (!overviewCaptured && tileCoverage?.complete === true && window
            ? `The browser captured no overview of this page, and its tiles cover only ` +
              `y=${window.fromY}..${window.toY} of ${tileCoverage.documentWidth}x` +
              `${tileCoverage.documentHeight} px.`
            : undefined);
    const evidence = [
        'the viewport screenshot',
        ...(overviewCaptured ? ['the full-page overview'] : []),
        'DOM',
        'network evidence',
    ];
    return {
        error:
            'The latest full-page tile capture is incomplete, so batch vision cannot inspect it. ' +
            (detail ? `Capture detail: ${detail} ` : '') +
            'Do not recapture the same page state; continue the investigation with ' +
            `${evidence.join(', ')} instead.`,
        errorKind: FULL_PAGE_CAPTURE_INCOMPLETE_KIND,
        retryable: false,
    };
}
