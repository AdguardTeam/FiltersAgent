/**
 * The attribution stage of the candidate visual review: bounded vision requests that compare what
 * an AFTER image shows with the BEFORE images of the same stretch of page, so the runner can set
 * aside what the page already showed without the candidate.
 *
 * An inventory pass sees one state, so a flaw only the AFTER pass lists — the site's own footer
 * graphic read as a broken image, app icons that never load — has no BEFORE entry to match, and an
 * ordinary gap between two sections reads as reserved ad space. Each request here shows one AFTER
 * image beside the BEFORE images where its content can sit — the BEFORE tiles of the same stretch
 * for a tile, the BEFORE viewport for the viewport — and asks, item by item, whether that content
 * is there unchanged. The code accepts a yes only when it cites one of the BEFORE images it sent,
 * and never for blank space on a BEFORE image where the BEFORE inventory recorded blank space as
 * the symptom; any other answer leaves the item for the synthesis to judge.
 */
import type { CallLimiter } from '../pi/call-limiter';
import { describeProviderFailure } from '../pi/single-shot';
import { SingleShotResultKind } from '../pi/single-shot-types';
import { TraceEventType } from '../types/trace';
import {
    CandidateVisualInstanceFootprint,
    type CandidateVisualInventoryInstance,
} from '../types/candidate-visual-instance';
import type {
    CandidateVisualEvidenceTile,
    CandidateVisualVerifierOptions,
} from './candidate-visual-evidence';
import { boundedModel } from './candidate-visual-context';
import {
    MAX_TILES_PER_VISION_BATCH,
    comparisonBatches,
    evidenceImageBytes,
} from './candidate-visual-planning';
import {
    AttributionOutputSchema,
    attributionMessages,
    readAnswers,
    type AttributionItem,
    type AttributionMatch,
    type LabelledImage,
} from './candidate-visual-attribution-request';

/**
 * Document height one page state spans: the capture's measurement, or the lowest tile edge.
 *
 * @param measured - Height the capture measured, when it did.
 * @param tiles - The state's tiles.
 * @returns Height in CSS pixels.
 */
function stateHeight(measured: number | undefined, tiles: CandidateVisualEvidenceTile[]): number {
    return measured ?? Math.max(0, ...tiles.map((tile) => tile.y + tile.height));
}

/**
 * Where a tile sits in the document, as its label states it.
 *
 * @param tile - The tile.
 * @returns The label text.
 */
function tilePlace(tile: CandidateVisualEvidenceTile): string {
    return `document x=${tile.x}..${tile.x + tile.width}, y=${tile.y}..${tile.y + tile.height}`;
}

/**
 * BEFORE tiles where the content of one AFTER tile can sit.
 *
 * Content that a hiding candidate lets move up sits in the baseline at the same height or lower, by
 * at most the height the document lost; content an exception lets render sits higher, by at most
 * the height the document gained. The window starts at the BEFORE tile that contains its top: tiles
 * overlap, and the tile before that one adds only rows the containing tile already shows.
 *
 * @param afterTile - AFTER tile whose content is looked for.
 * @param beforeTiles - Every BEFORE tile.
 * @param lost - Height the document lost under the candidate; negative when it grew.
 * @returns BEFORE tiles of that window, in document order.
 */
function beforeWindow(
    afterTile: CandidateVisualEvidenceTile,
    beforeTiles: CandidateVisualEvidenceTile[],
    lost: number,
): CandidateVisualEvidenceTile[] {
    const top = afterTile.y + Math.min(0, lost);
    const bottom = afterTile.y + afterTile.height + Math.max(0, lost);
    const column = beforeTiles.filter(
        (tile) => tile.x < afterTile.x + afterTile.width && tile.x + tile.width > afterTile.x,
    );
    const containing = column
        .filter((tile) => tile.y <= top && tile.y + tile.height > top)
        .reduce<CandidateVisualEvidenceTile | undefined>(
            (latest, tile) => (latest === undefined || tile.y > latest.y ? tile : latest),
            undefined,
        );
    return column.filter(
        (tile) =>
            (containing === undefined ? tile.y + tile.height > top : tile.y >= containing.y) &&
            tile.y < bottom,
    );
}

/**
 * Ask about every item of one AFTER image, one comparison chunk at a time, until each is settled or
 * the comparisons are exhausted.
 *
 * @param options - Review options providing the model and trace.
 * @param item - AFTER image the items are visible in.
 * @param comparisons - BEFORE images where the image's content can sit.
 * @param items - Items of this image.
 * @param beforeInstances - Every BEFORE inventory instance.
 * @param limiter - The review's call limiter.
 * @returns Matches by item key.
 */
async function attributeImage(
    options: CandidateVisualVerifierOptions,
    item: LabelledImage,
    comparisons: LabelledImage[],
    items: AttributionItem[],
    beforeInstances: CandidateVisualInventoryInstance[],
    limiter: CallLimiter,
): Promise<Map<string, AttributionMatch>> {
    const matches = new Map<string, AttributionMatch>();
    const closed = new Set<string>();
    const model = boundedModel(options.vision.modelId);
    const { batches, leftOut } = comparisonBatches(
        comparisons,
        MAX_TILES_PER_VISION_BATCH - 1,
        evidenceImageBytes(item.image),
    );
    if (leftOut > 0) {
        // A pair past the request budget would fail at the provider on every attempt, so those
        // comparisons are not made and their items stay with the synthesis.
        options.recorder.record(TraceEventType.Decision, {
            phase: 'candidate_visual_attribution_bytes',
            validationArtifactId: options.validationArtifactId,
            afterArtifactId: item.image.id,
            comparisonsLeftOut: leftOut,
        });
    }
    const symptomImageIds = new Set(
        beforeInstances
            .filter(
                (instance) => instance.footprint === CandidateVisualInstanceFootprint.BlankSpace,
            )
            .map((instance) => instance.artifactId),
    );
    const viewportId = options.evidence.beforeViewport.id;
    for (const chunk of batches) {
        const open = items.filter(
            (candidate) => !matches.has(candidate.key) && !closed.has(candidate.key),
        );
        if (open.length === 0) {
            break;
        }
        const chunkIds = new Set(chunk.map((labelled) => labelled.image.id));
        // The BEFORE viewport is not placed in the document, so its observations are listed with
        // every chunk: the model can still tell a tile's space is where one of them sits.
        const observations = beforeInstances.filter(
            (instance) => chunkIds.has(instance.artifactId) || instance.artifactId === viewportId,
        );
        const result = await limiter.run(() =>
            options.vision.structured({
                messages: attributionMessages(options, item, chunk, open, observations),
                schema: AttributionOutputSchema,
                ...(options.signal === undefined ? {} : { signal: options.signal }),
            }),
        );
        if (result.kind === SingleShotResultKind.ProviderFailure) {
            throw new Error(
                `Vision attribution of ${item.image.id} ${describeProviderFailure(result)}`,
            );
        }
        const requestMeta = {
            purpose: 'candidate_visual_attribution',
            model,
            afterArtifactId: item.image.id,
            evidenceArtifactIds: [item.image.id, ...chunkIds],
            itemCount: open.length,
        };
        if (result.kind === SingleShotResultKind.InvalidResult) {
            // The items stay open: an answer the code cannot read sets nothing aside.
            options.recorder.recordLlmTurn(requestMeta, { model, invalid: result.detail });
            continue;
        }
        const answers = readAnswers(result.value, open, chunk, symptomImageIds);
        for (const [key, match] of answers.matches) {
            matches.set(key, match);
        }
        for (const key of answers.atSymptom) {
            closed.add(key);
        }
        options.recorder.recordLlmTurn(requestMeta, {
            model,
            matchedCount: answers.matches.size,
            refusals: answers.refusals,
        });
    }
    return matches;
}

/**
 * Find which AFTER items the BEFORE state shows unchanged.
 *
 * An item cited on an AFTER tile is compared with the BEFORE tiles of its window, one cited on the
 * AFTER viewport with the BEFORE viewport. An item cited on the full-page overview is not asked
 * about: the overview spans a page state at a scale no BEFORE image shares at the same detail.
 *
 * @param options - Review options providing the evidence, model and trace.
 * @param items - Every AFTER item to attribute.
 * @param beforeInstances - Every BEFORE inventory instance.
 * @param limiter - The review's call limiter; images run side by side under it.
 * @returns Matches by item key; an item absent from it stays the synthesis's to judge.
 */
export async function attributeAfterItems(
    options: CandidateVisualVerifierOptions,
    items: AttributionItem[],
    beforeInstances: CandidateVisualInventoryInstance[],
    limiter: CallLimiter,
): Promise<Map<string, AttributionMatch>> {
    if (items.length === 0) {
        return new Map();
    }
    const { beforeTiles, afterTiles, beforeViewport, afterViewport } = options.evidence;
    const lost =
        stateHeight(options.evidence.beforeDocument?.height, beforeTiles) -
        stateHeight(options.evidence.afterDocument?.height, afterTiles);
    const requests = [
        ...afterTiles.map((tile) => ({
            item: { image: tile, place: tilePlace(tile) },
            comparisons: beforeWindow(tile, beforeTiles, lost).map((before) => ({
                image: before,
                place: tilePlace(before),
            })),
        })),
        {
            item: { image: afterViewport, place: 'viewport overview' },
            comparisons: [{ image: beforeViewport, place: 'viewport overview' }],
        },
    ];
    const byImage = new Map<string, AttributionItem[]>();
    for (const item of items) {
        byImage.set(item.artifactId, [...(byImage.get(item.artifactId) ?? []), item]);
    }
    const imageMatches = await Promise.all(
        requests.flatMap((request) => {
            const imageItems = byImage.get(request.item.image.id);
            return imageItems === undefined
                ? []
                : [
                      attributeImage(
                          options,
                          request.item,
                          request.comparisons,
                          imageItems,
                          beforeInstances,
                          limiter,
                      ),
                  ];
        }),
    );
    const matches = new Map(imageMatches.flatMap((image) => [...image]));
    options.recorder.record(TraceEventType.Decision, {
        phase: 'candidate_visual_attribution',
        validationArtifactId: options.validationArtifactId,
        itemCount: items.length,
        matchedCount: matches.size,
        heightLost: lost,
    });
    return matches;
}
