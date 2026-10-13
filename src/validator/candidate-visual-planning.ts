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
    VisionOverviewRefusal,
    visionOverviewRefusal,
} from '../pi/single-shot-input';
import type { CandidateVisualFullPageOverviewEvidence } from '../types/candidate-visual-review';
import type {
    CandidateVisualDocumentSize,
    CandidateVisualEvidenceImage,
    CandidateVisualEvidenceTile,
} from './candidate-visual-evidence';

/**
 * Maximum original-resolution tiles sent in one provider request.
 */
const MAX_TILES_PER_VISION_BATCH = 3;

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
    if (bytes > MAX_VISION_IMAGE_BYTES_PER_REQUEST) {
        throw new Error(
            `Evidence image ${image.id} contains ${bytes} bytes and exceeds the per-request ` +
                `image byte budget of ${MAX_VISION_IMAGE_BYTES_PER_REQUEST} bytes.`,
        );
    }
    return bytes;
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
 * @returns Bounded reason recorded in the overview provenance.
 */
function illegibleOverviewReason(
    document: CandidateVisualDocumentSize,
    tiles: readonly CandidateVisualEvidenceTile[],
): string {
    const inspected =
        tiles.length > 0
            ? `original-resolution tiles from y=${Math.min(...tiles.map((tile) => tile.y))} to ` +
              `y=${Math.max(...tiles.map((tile) => tile.y + tile.height))} of ` +
              `${document.height} px were inspected instead`
            : 'no original-resolution tiles were inspected';
    return (
        `Original full-page overview is ${document.width}x${document.height} px (aspect ` +
        `${(document.height / document.width).toFixed(1)}:1) and is too tall for a vision ` +
        `model to read as one image, which the provider fits into a bounded square; ` +
        `${inspected}, and the rest of the page was not inspected.`
    );
}

/**
 * Plan how one original full-page artifact participates in the bounded vision review.
 *
 * An oversized original is never mutated or sent beyond the provider byte limit. It may be omitted
 * only when a non-empty, mechanically complete original-resolution tile set covers the same state.
 * The schema keeps a distinct nullable vision artifact reference so omission cannot be confused
 * with the immutable original and a future derivative can extend the contract explicitly.
 *
 * An overview the provider would shrink past readability is omitted on different terms: it needs no
 * tile-coverage proof and never blocks the review, because an image the model cannot read protects
 * nothing while blocking would make every long page unverifiable.
 *
 * @param image - Immutable runner-owned full-page evidence artifact.
 * @param coverageComplete - Whether the runner proved complete document tile coverage.
 * @param tiles - Ordered original-resolution tiles for the same page state.
 * @param document - Document extent the overview spans, when the capture measured it.
 * @returns Validated provenance describing the original and vision-facing overview.
 */
export function planFullPageOverview(
    image: CandidateVisualEvidenceImage,
    coverageComplete: boolean,
    tiles: readonly CandidateVisualEvidenceTile[],
    document?: CandidateVisualDocumentSize,
): CandidateVisualFullPageOverviewEvidence {
    const originalBytes = statSync(image.path).size;
    const refusal = visionOverviewRefusal({
        bytes: originalBytes,
        documentWidth: document?.width,
        documentHeight: document?.height,
    });
    if (refusal === null) {
        return {
            mode: 'original',
            originalArtifactId: image.id,
            originalBytes,
            visionArtifactId: image.id,
            visionBytes: originalBytes,
            reason: null,
        };
    }
    // Only a measured document can refuse an overview as illegible, so the extent the reason
    // reports is present on this branch; the guard is what hands it to the reason.
    if (refusal === VisionOverviewRefusal.Illegible && document !== undefined) {
        return {
            mode: 'omitted_illegible',
            originalArtifactId: image.id,
            originalBytes,
            visionArtifactId: null,
            visionBytes: null,
            reason: illegibleOverviewReason(document, tiles),
        };
    }
    if (coverageComplete && tiles.length > 0) {
        return {
            mode: 'omitted_complete_tiles',
            originalArtifactId: image.id,
            originalBytes,
            visionArtifactId: null,
            visionBytes: null,
            reason:
                `Original full-page overview exceeds the ${MAX_VISION_IMAGE_BYTES}-` +
                'byte vision request limit; complete original-resolution tiles provide visual ' +
                'coverage without altering the original artifact.',
        };
    }
    return {
        mode: 'blocked_oversized_incomplete_tiles',
        originalArtifactId: image.id,
        originalBytes,
        visionArtifactId: null,
        visionBytes: null,
        reason:
            `Original full-page overview exceeds the ${MAX_VISION_IMAGE_BYTES}-byte ` +
            'vision request limit and complete original-resolution tiles are unavailable.',
    };
}

/**
 * Split page tiles into count- and byte-bounded provider requests without omitting any image.
 *
 * @param tiles - Complete ordered tile list for one page state.
 * @returns Ordered batches containing at most the configured image limit.
 */
export function tileBatches(tiles: CandidateVisualEvidenceTile[]): CandidateVisualEvidenceTile[][] {
    const batches: CandidateVisualEvidenceTile[][] = [];
    let current: CandidateVisualEvidenceTile[] = [];
    let currentBytes = 0;
    for (const tile of tiles) {
        const bytes = evidenceImageBytes(tile);
        if (
            current.length > 0 &&
            (current.length >= MAX_TILES_PER_VISION_BATCH ||
                currentBytes + bytes > MAX_VISION_IMAGE_BYTES_PER_REQUEST)
        ) {
            batches.push(current);
            current = [];
            currentBytes = 0;
        }
        current.push(tile);
        currentBytes += bytes;
    }
    if (current.length > 0) {
        batches.push(current);
    }
    return batches;
}
