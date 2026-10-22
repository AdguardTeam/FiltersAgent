/**
 * The reconciled half of the candidate visual review: the vocabulary one page state's observations
 * are collected into, the merge that reconciles the passes of a state under the supported limit,
 * and the context that hands both states whole to the text-only synthesis — or refuses to — plus
 * the bounding helpers every prompt in the review passes its untrusted context through.
 *
 * Nothing here talks to the vision provider: `candidate-visual-inventory` produces these
 * observations and `candidate-visual-verifier` consumes the rendered context, and neither is
 * imported back.
 */
import { FULL_PAGE_TILE_LIMIT } from '../browser/full-page-tiles';
import type { TraceRecorder } from '../tracer/trace-recorder';
import {
    MAX_INSTANCE_DESCRIPTION_CHARS,
    MAX_INSTANCE_LANDMARK_CHARS,
    type CandidateVisualDamageEntry,
    type CandidateVisualInventoryInstance,
} from '../types/candidate-visual-instance';
import {
    MAX_ARTIFACT_ID_CHARS,
    type CandidateVisualFullPageOverviewEvidence,
} from '../types/full-page-overview-evidence';
import type { CaptureState } from '../types/validation';
import { MAX_TILES_PER_VISION_BATCH } from './candidate-visual-planning';

/**
 * Maximum complete inventory size accepted for reconciliation in either page state.
 */
export const MAX_RECONCILED_INSTANCES = 50;

/**
 * Longest model-defined symptom scope one inventory request may report. Declared here, not beside
 * the batch output schema, because the synthesis context limit is derived from it and the inventory
 * stage already imports this module; the reverse import would be a cycle.
 */
export const MAX_SYMPTOM_SCOPE_CHARS = 2_000;

/**
 * Length every batch rationale is cut to when the complete synthesis context exceeds its limit.
 *
 * A rationale explains a batch; the observations and the damage it reports are what the synthesis
 * reconciles, so the rationale is the one text shortened and nothing else is. A thousand characters
 * keeps what a batch saw and why, and drops the long restatements verbose vision models add after
 * it.
 */
export const SHORTENED_RATIONALE_CHARS = 1_000;

/**
 * Characters one serialized record may spend on keys, quotes and punctuation beyond its bounded
 * text: generous for the seven keys of a batch observation and the four of a numbered one.
 */
const SERIALIZED_RECORD_OVERHEAD_CHARS = 200;

/**
 * Largest serialized numbered observation: its cited artifact, landmark and description at their
 * schema bounds.
 */
const MAX_SERIALIZED_INSTANCE_CHARS =
    MAX_ARTIFACT_ID_CHARS +
    MAX_INSTANCE_LANDMARK_CHARS +
    MAX_INSTANCE_DESCRIPTION_CHARS +
    SERIALIZED_RECORD_OVERHEAD_CHARS;

/**
 * Largest serialized batch observation without its damage: the artifacts one batch labels, its
 * symptom scope and its shortened rationale.
 *
 * Damage stays out on purpose. At its schema bound — twenty entries of a thousand characters per
 * batch — it would put the limit near a million characters, far past what the synthesis should be
 * sent; a page whose real damage does not fit is refused instead.
 */
const MAX_SERIALIZED_OBSERVATION_FRAME_CHARS =
    MAX_TILES_PER_VISION_BATCH * MAX_ARTIFACT_ID_CHARS +
    MAX_SYMPTOM_SCOPE_CHARS +
    SHORTENED_RATIONALE_CHARS +
    SERIALIZED_RECORD_OVERHEAD_CHARS;

/**
 * Observations one page state holds beside its tile batches: the viewport inventory and the
 * overview plan's reason.
 */
const OVERVIEW_OBSERVATIONS_PER_STATE = 2;

/**
 * Most image requests the limit expects one page state to make: the tile batches of the largest
 * tile capture plus its overviews.
 *
 * `tileBatches` also splits by bytes, so a state of heavy tiles makes more batches than this. Its
 * context may then pass the limit and be refused, and that is intended, as is a refusal caused by
 * JSON escaping that lengthens text past its bound: the limit covers the expected worst case, and
 * whatever lies beyond it fails closed instead of losing observations.
 */
const MAX_OBSERVATIONS_PER_STATE =
    Math.ceil(FULL_PAGE_TILE_LIMIT / MAX_TILES_PER_VISION_BATCH) + OVERVIEW_OBSERVATIONS_PER_STATE;

/**
 * Page states the synthesis reconciles: before and after the candidate.
 */
const RECONCILED_PAGE_STATES = 2;

/**
 * Largest inventory context sent to the final semantic review.
 *
 * Derived from the inventory's own bounds rather than chosen: every numbered observation both
 * states may hold plus every batch frame with a shortened rationale. A context within those bounds
 * always fits when its damage and JSON escaping stay within the slack, and one that does not is
 * refused, so the synthesis is never asked to reconcile an observation it was not shown.
 */
export const MAX_TILE_INVENTORY_CONTEXT_CHARS =
    MAX_SERIALIZED_INSTANCE_CHARS * MAX_RECONCILED_INSTANCES * RECONCILED_PAGE_STATES +
    MAX_SERIALIZED_OBSERVATION_FRAME_CHARS * MAX_OBSERVATIONS_PER_STATE * RECONCILED_PAGE_STATES;

/**
 * How both state inventories fit the synthesis context.
 */
export const TileInventoryContextFit = {
    /**
     * Every observation and every batch text is sent as the inventory reported it.
     */
    Complete: 'complete',

    /**
     * Every observation is sent; batch rationales are cut to {@link SHORTENED_RATIONALE_CHARS}.
     */
    RationalesShortened: 'rationales_shortened',

    /**
     * The context passes the limit even with shortened rationales, so no synthesis is asked.
     */
    Overflow: 'overflow',
} as const;

/**
 * TileInventoryContextFit value.
 */
export type TileInventoryContextFit =
    (typeof TileInventoryContextFit)[keyof typeof TileInventoryContextFit];

/**
 * Semantic role of one supplied evidence image or image batch.
 */
export const CandidateVisualEvidenceSource = {
    /**
     * One batch of original-resolution tiles.
     */
    TileBatch: 'tile_batch',

    /**
     * A single viewport-resolution overview image.
     */
    ViewportOverview: 'viewport_overview',

    /**
     * The overview plan's reason: the document range the review answers for, when it is less than
     * the whole document, or why the overview was not shown.
     */
    FullPageOverviewReason: 'full_page_overview_reason',
} as const;

/**
 * CandidateVisualEvidenceSource value.
 */
export type CandidateVisualEvidenceSource =
    (typeof CandidateVisualEvidenceSource)[keyof typeof CandidateVisualEvidenceSource];

/**
 * Compact provenance for one bounded visual-observation request.
 */
export interface CandidateVisualInventoryObservation {
    /**
     * Semantic role of the supplied evidence image or image batch.
     */
    source: CandidateVisualEvidenceSource;

    /**
     * Exact runner-owned evidence identifiers shown in this request.
     */
    artifactIds: string[];

    /**
     * Whether the model could visually inspect the evidence for its requested purpose.
     */
    coverageObserved: boolean;

    /**
     * Model-defined scope of the reporter symptom in this evidence.
     */
    symptomScope: string;

    /**
     * Number of schema-owned instances produced by this request.
     */
    instanceCount: number;

    /**
     * Bounded visible-damage observations produced by this request.
     */
    observedDamage: CandidateVisualDamageEntry[];

    /**
     * Bounded model rationale for the visual observation.
     */
    rationale: string;
}

/**
 * Aggregated vision observations across every tile in one page state.
 */
export interface CandidateVisualTileInventory {
    /**
     * Whether every batch was visually readable according to the model.
     */
    coverageObserved: boolean;

    /**
     * Whether the runner dropped an AFTER observation cited on an image its request did not carry.
     */
    citationDropped: boolean;

    /**
     * Every model-observed occurrence tied to a runner-owned tile.
     */
    instances: CandidateVisualInventoryInstance[];

    /**
     * Every image request that produced this inventory, with the symptom scope, damage and
     * rationale it reported; the only place those texts are kept.
     */
    observations: CandidateVisualInventoryObservation[];
}

/**
 * Runner-owned full-page overview provenance for both aligned page states.
 */
export interface CandidateVisualFullPageOverviewEvidencePair {
    /**
     * Before-state original and vision overview relationship.
     */
    before: CandidateVisualFullPageOverviewEvidence;

    /**
     * After-state original and vision overview relationship.
     */
    after: CandidateVisualFullPageOverviewEvidence;
}

/**
 * Both state inventories rendered within the synthesis context limit.
 */
export interface FittedTileInventoryContext {
    /**
     * Whether the batch rationales had to be shortened to fit.
     */
    fit:
        | typeof TileInventoryContextFit.Complete
        | typeof TileInventoryContextFit.RationalesShortened;

    /**
     * Serialized observations of both states supplied to the final review.
     */
    text: string;

    /**
     * Length of {@link FittedTileInventoryContext.text}.
     */
    chars: number;

    /**
     * Context limit the text was measured against.
     */
    limitChars: number;
}

/**
 * Both state inventories that pass the synthesis context limit even with shortened rationales.
 */
export interface OverflowingTileInventoryContext {
    /**
     * Always {@link TileInventoryContextFit.Overflow}.
     */
    fit: typeof TileInventoryContextFit.Overflow;

    /**
     * Length of the context with every batch rationale shortened.
     */
    chars: number;

    /**
     * Context limit the context passed.
     */
    limitChars: number;
}

/**
 * Both state inventories rendered for the final review, or the size that kept them out of it.
 */
export type CandidateVisualTileInventoryContext =
    | FittedTileInventoryContext
    | OverflowingTileInventoryContext;

/**
 * Bound a potentially large optional context value before including it in a prompt.
 *
 * @param value - Optional untrusted context supplied by the caller.
 * @param maximumChars - Maximum number of characters to preserve.
 * @returns Trimmed bounded text, or a fallback label when no text is available.
 */
function boundedContext(value: string | undefined, maximumChars: number): string {
    const trimmed = value?.trim();
    return trimmed ? trimmed.slice(0, maximumChars) : '(not provided)';
}

/**
 * Remove runner artifact identifiers from descriptive context before showing it beside labelled
 * evidence images.
 *
 * Artifact identifiers in earlier observations are provenance, not citable evidence for the current
 * visual phase. Keeping them in free-form context can cause a vision model to copy an unrelated
 * identifier instead of citing one of the images it actually received.
 *
 * @param value - Optional descriptive context that may contain earlier artifact identifiers.
 * @param maximumChars - Maximum number of characters to preserve after redaction.
 * @param recorder - Trace recorder containing all runner-owned artifact identifiers.
 * @returns Bounded semantic text without citable-looking runner artifact identifiers.
 */
export function boundedSemanticContext(
    value: string | undefined,
    maximumChars: number,
    recorder: TraceRecorder,
): string {
    let result = boundedContext(value, maximumChars);
    const artifactIds: string[] = [];
    for (const artifact of recorder.getArtifacts()) {
        if (artifact.id.length === 0) {
            continue;
        }
        const insertionIndex = artifactIds.findIndex(
            (artifactId) => artifact.id.length > artifactId.length,
        );
        if (insertionIndex === -1) {
            artifactIds.push(artifact.id);
        } else {
            artifactIds.splice(insertionIndex, 0, artifact.id);
        }
    }
    for (const artifactId of artifactIds) {
        result = result.replaceAll(artifactId, '[runner artifact reference omitted]');
    }
    return result;
}

/**
 * Normalize the configured model name for the persisted runner-owned record.
 *
 * @param model - Configured vision model identifier.
 * @returns A non-empty model identifier accepted by the shared schema.
 */
export function boundedModel(model: string): string {
    return model.trim().slice(0, 200) || 'unknown-model';
}

/**
 * Merge detailed tiles and overview observations for one page state without losing provenance.
 *
 * The state is part of the overflow diagnostic on purpose: both aligned states are reconciled by
 * this one function, and an operator reading a review that failed closed on the limit has to know
 * which document the observations came from before the count means anything.
 *
 * @param inventories - Complete inventories produced from non-overlapping provider requests.
 * @param state - Whether these inventories describe the control or candidate-applied document.
 * @returns One bounded state inventory used by the final text-only semantic synthesis.
 */
export function combineStateInventories(
    inventories: CandidateVisualTileInventory[],
    state: CaptureState,
): CandidateVisualTileInventory {
    const instances = inventories.flatMap((inventory) => inventory.instances);
    if (instances.length > MAX_RECONCILED_INSTANCES) {
        throw new Error(
            `Vision ${state} inventory contains ${instances.length} observations; the supported ` +
                `complete reconciliation limit is ${MAX_RECONCILED_INSTANCES}.`,
        );
    }
    return {
        coverageObserved:
            inventories.length > 0 && inventories.every((inventory) => inventory.coverageObserved),
        citationDropped: inventories.some((inventory) => inventory.citationDropped),
        instances,
        observations: inventories.flatMap((inventory) => inventory.observations),
    };
}

/**
 * Serialize both states for the final review, numbering every observation it must reconcile.
 *
 * @param before - Vision inventory of the complete control document.
 * @param after - Vision inventory of the complete candidate-applied document.
 * @param shortenRationales - Whether every batch rationale is cut to its shortened length.
 * @returns The serialized context.
 */
function serializeInventories(
    before: CandidateVisualTileInventory,
    after: CandidateVisualTileInventory,
    shortenRationales: boolean,
): string {
    const render = (inventory: CandidateVisualTileInventory): Record<string, unknown> => ({
        coverageObserved: inventory.coverageObserved,
        instances: inventory.instances.map((instance, index) => ({
            observationIndex: index + 1,
            ...instance,
        })),
        observations: shortenRationales
            ? inventory.observations.map((observation) => ({
                  ...observation,
                  rationale: observation.rationale.slice(0, SHORTENED_RATIONALE_CHARS),
              }))
            : inventory.observations,
    });
    return JSON.stringify({ before: render(before), after: render(after) });
}

/**
 * Render both state inventories for the final review without dropping any observation.
 *
 * The synthesis must reconcile every numbered observation, so none is ever left out: when the
 * complete context passes the limit only the batch rationales are shortened, and when even that
 * does not fit the context is refused and the caller asks no synthesis at all.
 *
 * @param before - Vision inventory of the complete control document.
 * @param after - Vision inventory of the complete candidate-applied document.
 * @returns The fitted context text, or the size that passed the limit.
 */
export function renderTileInventoryContext(
    before: CandidateVisualTileInventory,
    after: CandidateVisualTileInventory,
): CandidateVisualTileInventoryContext {
    const limitChars = MAX_TILE_INVENTORY_CONTEXT_CHARS;
    const complete = serializeInventories(before, after, false);
    if (complete.length <= limitChars) {
        return {
            fit: TileInventoryContextFit.Complete,
            text: complete,
            chars: complete.length,
            limitChars,
        };
    }
    const shortened = serializeInventories(before, after, true);
    if (shortened.length <= limitChars) {
        return {
            fit: TileInventoryContextFit.RationalesShortened,
            text: shortened,
            chars: shortened.length,
            limitChars,
        };
    }
    return { fit: TileInventoryContextFit.Overflow, chars: shortened.length, limitChars };
}
