/**
 * The map of the candidate visual review: one downscaled screenshot of a page state that goes in
 * front of every tile batch of that state, labelled with where each tile sits.
 *
 * The map orients; the tiles prove. A downscaled overview is too coarse to read a symptom from, and
 * a weak vision model asked to inventory one invents what it cannot see — embedded videos, press
 * photos, section margins, an ad label the page never had. So the map carries no artifact ID: no
 * observation can cite it, and nothing seen only on it can reach the verdict.
 *
 * Which image a state is mapped from is the overview plan's decision (`planFullPageOverview`): the
 * full-page overview of a page short enough to be read as one image, or the browser's screenshot of
 * the tile window of a page too tall for that. This module only downscales and labels it.
 */
import { readFileSync } from 'node:fs';
import { fitImage, sniffImageMime } from '../pi/single-shot-input';
import { TraceEventType } from '../types/trace';
import { CaptureState } from '../types/validation';
import type { CandidateVisualFullPageOverviewEvidence } from '../types/full-page-overview-evidence';
import type {
    CandidateVisualDocumentSize,
    CandidateVisualEvidenceTile,
    CandidateVisualTileWindowMap,
    CandidateVisualVerifierOptions,
} from './candidate-visual-evidence';
import type { CandidateVisualFullPageOverviewEvidencePair } from './candidate-visual-context';
import {
    CandidateVisualMapSource,
    MAP_LONG_EDGE_PX,
    MAX_MAP_ENCODED_BYTES,
    type CandidateVisualMapSourceImage,
    type CandidateVisualOverviewPlan,
} from './candidate-visual-planning';

/**
 * Trace phase recording which map each page state got, or why it got none.
 */
export const CANDIDATE_VISUAL_MAP_PHASE = 'candidate_visual_map';

/**
 * The map one page state's tile batches carry in front of their tiles.
 */
export interface CandidateVisualMap {
    /**
     * Downscaled map image, sent from memory and never under an artifact ID.
     */
    bytes: Buffer;

    /**
     * What the map shows, for its label.
     */
    scope: string;

    /**
     * Lowest document coordinate a tile window map shows; absent for a whole-page map.
     */
    bottom?: number;
}

/**
 * What a tile window map shows: the span its tiles cover, or the top of it when the legible aspect
 * cut the screenshot short of the last tiles.
 *
 * @param map - The tile window map.
 * @param tiles - Every tile of the page state.
 * @param document - Document extent, when measured.
 * @returns The scope its label states.
 */
function tileWindowScope(
    map: CandidateVisualTileWindowMap,
    tiles: readonly CandidateVisualEvidenceTile[],
    document: CandidateVisualDocumentSize | undefined,
): string {
    const { y, height } = map;
    const tilesBottom = Math.max(...tiles.map((tile) => tile.y + tile.height));
    return (
        `the page from y=${y} to y=${y + height}` +
        (document === undefined ? '' : ` of ${document.height} px`) +
        (y + height < tilesBottom
            ? ', the top of the span its tiles cover'
            : ', the span its tiles cover')
    );
}

/**
 * Build the map of one page state from the image its plan chose, or nothing when it chose none.
 *
 * Which map was sent, or why none was, is recorded in the trace: a state mapped from nothing is
 * still reviewed from its tiles, and the trace is the only place that says so.
 *
 * @param options - Review options owning the trace.
 * @param state - Page state the map is for.
 * @param source - The image the state's plan maps it from, if any.
 * @param tiles - Every tile of the page state.
 * @param document - Document extent, when measured.
 * @returns The map, or undefined when the state has none.
 */
async function buildStateMap(
    options: CandidateVisualVerifierOptions,
    state: CaptureState,
    source: CandidateVisualMapSourceImage | undefined,
    tiles: readonly CandidateVisualEvidenceTile[],
    document: CandidateVisualDocumentSize | undefined,
): Promise<CandidateVisualMap | undefined> {
    if (source === undefined) {
        options.recorder.record(TraceEventType.Decision, {
            phase: CANDIDATE_VISUAL_MAP_PHASE,
            state,
            source: null,
            reason: 'The page state has no overview or tile window map to show.',
        });
        return undefined;
    }
    const original = readFileSync(source.image.path);
    const bytes = await fitImage(original, MAP_LONG_EDGE_PX, MAX_MAP_ENCODED_BYTES);
    if (bytes === null) {
        options.recorder.record(TraceEventType.Error, {
            phase: CANDIDATE_VISUAL_MAP_PHASE,
            state,
            source: source.kind,
            artifactId: source.image.id,
            sourceBytes: original.byteLength,
            sourceMime: sniffImageMime(original),
            maxSidePx: MAP_LONG_EDGE_PX,
            maxEncodedBytes: MAX_MAP_ENCODED_BYTES,
            error: 'The map source could not be decoded or fitted to the map limits.',
        });
        return undefined;
    }
    options.recorder.record(TraceEventType.Decision, {
        phase: CANDIDATE_VISUAL_MAP_PHASE,
        state,
        source: source.kind,
        artifactId: source.image.id,
        bytes: bytes.length,
    });
    if (source.kind === CandidateVisualMapSource.WholePage) {
        return {
            bytes,
            scope:
                document === undefined
                    ? 'the whole page'
                    : `the whole page, ${document.width}x${document.height} px`,
        };
    }
    return {
        bytes,
        scope: tileWindowScope(source.image, tiles, document),
        bottom: source.image.y + source.image.height,
    };
}

/**
 * The maps of both page states and the overview provenance that records them.
 */
export interface CandidateVisualStateMaps {
    /**
     * Map of the control document, absent when it has none.
     */
    before?: CandidateVisualMap;

    /**
     * Map of the candidate-applied document, absent when it has none.
     */
    after?: CandidateVisualMap;

    /**
     * Each state's overview provenance, completed with the map it was shown as.
     */
    evidence: CandidateVisualFullPageOverviewEvidencePair;
}

/**
 * The provenance of one page state's overview, completed with the map it was shown as.
 *
 * @param plan - The state's overview plan.
 * @param map - The map built from the plan's source, absent when none was.
 * @returns The provenance to record.
 */
function withMap(
    plan: CandidateVisualOverviewPlan,
    map: CandidateVisualMap | undefined,
): CandidateVisualFullPageOverviewEvidence {
    return map === undefined || plan.mapSource === undefined
        ? plan.evidence
        : {
              ...plan.evidence,
              visionArtifactId: plan.mapSource.image.id,
              visionBytes: map.bytes.length,
          };
}

/**
 * Build the map of both page states from the images their plans chose.
 *
 * @param options - Review options providing the evidence and the trace.
 * @param before - Overview plan of the control document.
 * @param after - Overview plan of the candidate-applied document.
 * @returns Both maps and the provenance recording them.
 */
export async function buildStateMaps(
    options: CandidateVisualVerifierOptions,
    before: CandidateVisualOverviewPlan,
    after: CandidateVisualOverviewPlan,
): Promise<CandidateVisualStateMaps> {
    const { evidence } = options;
    const [beforeMap, afterMap] = await Promise.all([
        buildStateMap(
            options,
            CaptureState.Before,
            before.mapSource,
            evidence.beforeTiles,
            evidence.beforeDocument,
        ),
        buildStateMap(
            options,
            CaptureState.After,
            after.mapSource,
            evidence.afterTiles,
            evidence.afterDocument,
        ),
    ]);
    return {
        ...(beforeMap === undefined ? {} : { before: beforeMap }),
        ...(afterMap === undefined ? {} : { after: afterMap }),
        evidence: { before: withMap(before, beforeMap), after: withMap(after, afterMap) },
    };
}

/**
 * Where one tile sits, as its label and the manifest beside the map state it, and as every other
 * request of the review that shows a tile states it.
 *
 * @param tile - The tile.
 * @param tileCount - Tiles of the page state.
 * @param document - Document extent, when measured.
 * @returns The position text.
 */
export function tilePosition(
    tile: CandidateVisualEvidenceTile,
    tileCount: number,
    document: CandidateVisualDocumentSize | undefined,
): string {
    return (
        `TILE ${tile.index + 1} of ${tileCount}, y=${tile.y}–${tile.y + tile.height}` +
        (document === undefined ? '' : ` of ${document.height} px`) +
        `, x=${tile.x}–${tile.x + tile.width}`
    );
}

/**
 * Label of the map and the manifest of every tile of its page state.
 *
 * @param map - The state's map.
 * @param tiles - Every tile of the state, in document order.
 * @param document - Document extent, when measured.
 * @returns The text sent with the map image.
 */
export function mapLabel(
    map: CandidateVisualMap,
    tiles: readonly CandidateVisualEvidenceTile[],
    document: CandidateVisualDocumentSize | undefined,
): string {
    const { bottom } = map;
    return [
        `MAP: downscaled screenshot of ${map.scope}. Orientation only: it carries no artifact ` +
            'and cannot be cited. The tiles of this page state are:',
        ...tiles.map(
            (tile) =>
                tilePosition(tile, tiles.length, document) +
                (bottom !== undefined && tile.y >= bottom ? ' (below the map)' : ''),
        ),
    ].join('\n');
}

/**
 * Inventory rubric lines for a tile batch that carries a map.
 */
export const MAP_INVENTORY_RUBRIC = [
    'The MAP image comes first: a downscaled screenshot that shows where each tile sits on the',
    'page. Use it only to orient yourself and read every detail from the tiles. Record an',
    'instance or a flaw only when a supplied tile shows it, cite that tile, and never record',
    'anything that is visible only on the map.',
];
