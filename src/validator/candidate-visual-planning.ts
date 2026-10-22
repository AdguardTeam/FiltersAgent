/**
 * The planning half of the candidate visual review: how the runner-owned screenshots of one page
 * state are measured and split into provider requests that stay inside the multimodal byte and
 * image-count budgets, before any of them is sent.
 *
 * It reads image sizes and returns request plans; it never talks to the vision provider and never
 * touches an inventory, so `candidate-visual-inventory` imports it and nothing is imported back.
 */
import { statSync } from 'node:fs';
import {
    MAX_VISION_IMAGE_BYTES,
    VISION_IMAGE_LIMITS,
    VisionOverviewRefusal,
    visionOverviewRefusal,
} from '../pi/single-shot-input';
import {
    FullPageOverviewMode,
    type CandidateVisualFullPageOverviewEvidence,
} from '../types/full-page-overview-evidence';
import type { FullPageTileWindow } from '../types/validation';
import type {
    CandidateVisualDocumentSize,
    CandidateVisualEvidenceImage,
    CandidateVisualEvidenceTile,
    CandidateVisualTileWindowMap,
} from './candidate-visual-evidence';

/**
 * Maximum original-resolution tiles sent in one provider request.
 */
export const MAX_TILES_PER_VISION_BATCH = 3;

/**
 * Maximum raw screenshot bytes accepted in one multimodal provider request.
 *
 * Base64 encoding expands this to roughly eight MiB, leaving room for JSON and schema overhead
 * below the ten-MiB gateway limit used by supported local providers. This bounds the images of a
 * whole request taken together; whether one single image may be sent at all is answered by
 * `visionOverviewRefusal` and the per-image cap it reads.
 */
const MAX_VISION_IMAGE_BYTES_PER_REQUEST = 6 * 1024 * 1024;

/**
 * Read and validate one evidence image's raw byte length.
 *
 * @param image - Runner-resolved evidence image whose local file will be sent to vision.
 * @returns Raw local screenshot byte length.
 */
export function evidenceImageBytes(image: CandidateVisualEvidenceImage): number {
    const bytes = statSync(image.path).size;
    if (bytes > MAX_VISION_IMAGE_BYTES) {
        throw new Error(
            `Evidence image ${image.id} contains ${bytes} bytes and exceeds the per-image ` +
                `byte budget of ${MAX_VISION_IMAGE_BYTES} bytes.`,
        );
    }
    return bytes;
}

/**
 * Longest side of the map a tile request carries in front of its tiles: the top of the 1,000 to
 * 2,000 px a downscaled whole-page overview is recommended at, and no larger than the side every
 * image of a many-image request must fit.
 */
export const MAP_LONG_EDGE_PX = VISION_IMAGE_LIMITS.manyImagesMaxSidePx;

/**
 * Largest base64-encoded map: every tile request carries it beside its tiles, so it takes a small
 * fixed share of {@link MAX_VISION_IMAGE_BYTES_PER_REQUEST} instead of competing with them.
 */
export const MAX_MAP_ENCODED_BYTES = 1024 * 1024;

/**
 * What one page state's map is downscaled from.
 */
export const CandidateVisualMapSource = {
    /**
     * The full-page overview of a page short enough to be read as one image.
     */
    WholePage: 'whole_page',

    /**
     * The browser's screenshot of the tile window of a page too tall for that.
     */
    TileWindow: 'tile_window',
} as const;

/**
 * CandidateVisualMapSource value.
 */
export type CandidateVisualMapSource =
    (typeof CandidateVisualMapSource)[keyof typeof CandidateVisualMapSource];

/**
 * The image one page state's map is downscaled from.
 */
export type CandidateVisualMapSourceImage =
    | {
          /**
           * The whole page.
           */
          kind: typeof CandidateVisualMapSource.WholePage;

          /**
           * The full-page overview.
           */
          image: CandidateVisualEvidenceImage;
      }
    | {
          /**
           * The tile window.
           */
          kind: typeof CandidateVisualMapSource.TileWindow;

          /**
           * The tile window screenshot.
           */
          image: CandidateVisualTileWindowMap;
      };

/**
 * How one page state's full-page overview takes part in the review.
 */
export interface CandidateVisualOverviewPlan {
    /**
     * Provenance recorded for the state; its vision fields stay empty until the map is built.
     */
    evidence: CandidateVisualFullPageOverviewEvidence;

    /**
     * The image the state's map is downscaled from, absent when the state has none.
     */
    mapSource?: CandidateVisualMapSourceImage;
}

/**
 * Say which document ranges the original-resolution tiles inspected.
 *
 * Tiles that overlap or touch form one range; a window with a top span leaves a gap between two,
 * and the clause names both rather than claim the gap was inspected.
 *
 * @param tiles - Ordered original-resolution tiles of the page state.
 * @param document - Document extent, when the capture measured it.
 * @returns The inspected ranges, as a clause.
 */
function inspectedTiles(
    tiles: readonly CandidateVisualEvidenceTile[],
    document: CandidateVisualDocumentSize | undefined,
): string {
    if (tiles.length === 0) {
        return 'no original-resolution tiles were inspected';
    }
    const ranges: FullPageTileWindow[] = [];
    for (const tile of [...tiles].sort((left, right) => left.y - right.y)) {
        const last = ranges.at(-1);
        if (last !== undefined && tile.y <= last.toY) {
            last.toY = Math.max(last.toY, tile.y + tile.height);
        } else {
            ranges.push({ fromY: tile.y, toY: tile.y + tile.height });
        }
    }
    return (
        `original-resolution tiles from ` +
        ranges.map((range) => `y=${range.fromY} to y=${range.toY}`).join(' and from ') +
        (document === undefined ? '' : ` of ${document.height} px`) +
        ' were inspected'
    );
}

/**
 * Say why an unreadably tall overview was withheld and exactly what was read in its place.
 *
 * The sentence is persisted in the review and read by maintainers, so it names the pixel size and
 * aspect that refused the image, the document range the original-resolution tiles did cover, and —
 * the part no verdict may be read without — that the rest of the page went uninspected.
 *
 * @param document - Document extent of the withheld overview.
 * @param tiles - Ordered original-resolution tiles inspected for the same page state.
 * @param captured - Whether the browser captured the overview at all.
 * @returns Bounded reason recorded in the overview provenance.
 */
function illegibleOverviewReason(
    document: CandidateVisualDocumentSize,
    tiles: readonly CandidateVisualEvidenceTile[],
    captured: boolean,
): string {
    const extent =
        `${document.width}x${document.height} px (aspect ` +
        `${(document.height / document.width).toFixed(1)}:1)`;
    const overview = captured
        ? `Original full-page overview is ${extent} and is too tall`
        : `The browser captured no full-page overview, and one of ${extent} would be too tall`;
    return (
        `${overview} for a vision model to read as one image, which the provider fits into a ` +
        `bounded square; ${inspectedTiles(tiles, document)} instead, and the rest of the page ` +
        'was not inspected.'
    );
}

/**
 * Plan how one page state's full-page overview takes part in the review.
 *
 * The overview is never inventoried: it reaches vision only as the map in front of the tiles, so
 * what the review answers for is always the range its tiles cover. A plan records that range
 * whenever it is less than the document, so neither the synthesis nor the run report reads
 * page-wide coverage into a review of a window.
 *
 * An overview of a page short enough to be read as one image is the map at any byte size, since the
 * map is a downscaled derivative. An overview the provider would shrink past readability is
 * withheld: the map is then the browser's screenshot of the tile window. The document's shape
 * decides that before anything else, so a long page ends the same way whether its overview was
 * captured or not: the browser refuses a full-page capture of a very tall document. Short of that,
 * a state the browser captured no overview of is reviewed only when its tiles cover the whole
 * document, the terms `phaseCapturedPageState` proves the phase on.
 *
 * @param image - Immutable runner-owned full-page evidence artifact, absent when none was captured.
 * @param coverageComplete - Whether the runner proved complete document tile coverage.
 * @param tiles - Ordered original-resolution tiles for the same page state.
 * @param document - Document extent the overview spans, when the capture measured it.
 * @param tileWindowMap - Screenshot of the tile window, captured only for an illegibly tall page.
 * @returns The provenance to record and the image to map the state from.
 */
export function planFullPageOverview(
    image: CandidateVisualEvidenceImage | undefined,
    coverageComplete: boolean,
    tiles: readonly CandidateVisualEvidenceTile[],
    document?: CandidateVisualDocumentSize,
    tileWindowMap?: CandidateVisualTileWindowMap,
): CandidateVisualOverviewPlan {
    const original = {
        originalArtifactId: image?.id ?? null,
        originalBytes: image === undefined ? null : statSync(image.path).size,
        visionArtifactId: null,
        visionBytes: null,
    };
    // Only a measured document can refuse an overview as illegible, so the extent the reason
    // reports is present on this branch; the guard is what hands it to the reason.
    if (
        document !== undefined &&
        visionOverviewRefusal({
            documentWidth: document.width,
            documentHeight: document.height,
        }) === VisionOverviewRefusal.Illegible
    ) {
        return {
            evidence: {
                ...original,
                mode:
                    image === undefined
                        ? FullPageOverviewMode.UnavailableIllegible
                        : FullPageOverviewMode.OmittedIllegible,
                reason: illegibleOverviewReason(document, tiles, image !== undefined),
            },
            ...(tileWindowMap === undefined
                ? {}
                : {
                      mapSource: {
                          kind: CandidateVisualMapSource.TileWindow,
                          image: tileWindowMap,
                      },
                  }),
        };
    }
    const tilesCoverDocument = coverageComplete && tiles.length > 0;
    if (image === undefined) {
        return {
            evidence: {
                ...original,
                mode: tilesCoverDocument
                    ? FullPageOverviewMode.UnavailableCompleteTiles
                    : FullPageOverviewMode.BlockedUnavailableIncompleteTiles,
                reason: tilesCoverDocument
                    ? 'The browser captured no full-page overview; complete original-resolution ' +
                      'tiles provide visual coverage.'
                    : 'The browser captured no full-page overview and complete ' +
                      'original-resolution tiles are unavailable.',
            },
        };
    }
    return {
        evidence: tilesCoverDocument
            ? { ...original, mode: FullPageOverviewMode.Original, reason: null }
            : {
                  ...original,
                  mode: FullPageOverviewMode.WindowedTiles,
                  reason:
                      `The full-page overview was shown only as a map; ` +
                      `${inspectedTiles(tiles, document)}, and the rest of the page was not ` +
                      'inspected.',
              },
        mapSource: { kind: CandidateVisualMapSource.WholePage, image },
    };
}

/**
 * Split page tiles into count- and byte-bounded provider requests without omitting any image.
 *
 * @param tiles - Complete ordered tile list for one page state.
 * @param reservedBytes - Bytes every request already spends on the map sent in front of its tiles.
 * @returns Ordered batches containing at most the configured image limit.
 */
export function tileBatches(
    tiles: CandidateVisualEvidenceTile[],
    reservedBytes = 0,
): CandidateVisualEvidenceTile[][] {
    const batches: CandidateVisualEvidenceTile[][] = [];
    let current: CandidateVisualEvidenceTile[] = [];
    let currentBytes = reservedBytes;
    for (const tile of tiles) {
        const bytes = evidenceImageBytes(tile);
        if (
            current.length > 0 &&
            (current.length >= MAX_TILES_PER_VISION_BATCH ||
                currentBytes + bytes > MAX_VISION_IMAGE_BYTES_PER_REQUEST)
        ) {
            batches.push(current);
            current = [];
            currentBytes = reservedBytes;
        }
        current.push(tile);
        currentBytes += bytes;
    }
    if (current.length > 0) {
        batches.push(current);
    }
    return batches;
}

/**
 * One comparison a request may carry: anything that holds the image it sends.
 */
export interface ComparisonImage {
    /**
     * The image sent for the comparison.
     */
    image: CandidateVisualEvidenceImage;
}

/**
 * Comparison requests planned for one item image.
 */
export interface ComparisonBatches<T> {
    /**
     * Ordered batches, each within the request byte budget beside the reserved images.
     */
    batches: T[][];

    /**
     * Comparisons too large to fit beside the reserved images in any request.
     */
    leftOut: number;
}

/**
 * Split comparison images into requests that each also carry images already reserved for them.
 *
 * Unlike {@link tileBatches}, a request here is never allowed past the byte budget to keep an image:
 * an image that does not fit beside the reserved bytes even alone is left out, and the caller
 * leaves what it was meant to compare to the synthesis.
 *
 * @param items - Ordered comparisons, each carrying one image.
 * @param maxImages - Most comparison images one request may carry.
 * @param reservedBytes - Bytes every request already spends on the images sent beside them.
 * @returns Ordered batches, and how many comparisons fit in none.
 */
export function comparisonBatches<T extends ComparisonImage>(
    items: readonly T[],
    maxImages: number,
    reservedBytes: number,
): ComparisonBatches<T> {
    const batches: T[][] = [];
    let current: T[] = [];
    let currentBytes = reservedBytes;
    let leftOut = 0;
    for (const item of items) {
        const bytes = evidenceImageBytes(item.image);
        if (reservedBytes + bytes > MAX_VISION_IMAGE_BYTES_PER_REQUEST) {
            leftOut += 1;
            continue;
        }
        if (
            current.length >= maxImages ||
            currentBytes + bytes > MAX_VISION_IMAGE_BYTES_PER_REQUEST
        ) {
            batches.push(current);
            current = [];
            currentBytes = reservedBytes;
        }
        current.push(item);
        currentBytes += bytes;
    }
    if (current.length > 0) {
        batches.push(current);
    }
    return { batches, leftOut };
}
