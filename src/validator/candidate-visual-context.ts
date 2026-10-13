/**
 * The reconciled half of the candidate visual review: the vocabulary one page state's observations
 * are collected into, the merge that reconciles the passes of a state under the supported limit,
 * and the compact context that hands both states to the text-only synthesis — plus the bounding
 * helpers every prompt in the review passes its untrusted context through.
 *
 * Nothing here talks to the vision provider: `candidate-visual-inventory` produces these
 * observations and `candidate-visual-verifier` consumes the rendered context, and neither is
 * imported back.
 */
import type { TraceRecorder } from '../tracer/trace-recorder';
import type {
    CandidateVisualFullPageOverviewEvidence,
    CandidateVisualInstance,
} from '../types/candidate-visual-review';
import type { CaptureState } from '../types/validation';

/**
 * Maximum complete inventory size accepted for reconciliation in either page state.
 */
export const MAX_RECONCILED_INSTANCES = 50;

/**
 * Maximum compact tile-inventory context sent to the final semantic review.
 */
const MAX_TILE_INVENTORY_CONTEXT_CHARS = 30_000;

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
     * A single full-page overview image.
     */
    FullPageOverview: 'full_page_overview',

    /**
     * A full-page overview omitted because complete original-resolution tiles cover the state.
     */
    FullPageOverviewOmitted: 'full_page_overview_omitted',
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
    observedDamage: string[];

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
     * Model-defined descriptions of the repeated reporter symptom family.
     */
    symptomScopes: string[];

    /**
     * Every model-observed occurrence tied to a runner-owned tile.
     */
    instances: CandidateVisualInstance[];

    /**
     * Visible damage observations reported across the state tiles.
     */
    observedDamage: string[];

    /**
     * Bounded batch rationales retained for the final semantic review.
     */
    rationales: string[];

    /**
     * Compact runner-bound description of every image request that produced this inventory.
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
 * Final compact representation of both state inventories.
 */
export interface CandidateVisualTileInventoryContext {
    /**
     * Serialized model observations supplied to the final review.
     */
    text: string;

    /**
     * Whether no inventory observations had to be omitted for prompt bounds.
     */
    complete: boolean;
}

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
        symptomScopes: [...new Set(inventories.flatMap((inventory) => inventory.symptomScopes))],
        instances,
        observedDamage: inventories.flatMap((inventory) => inventory.observedDamage).slice(0, 20),
        rationales: inventories.flatMap((inventory) => inventory.rationales),
        observations: inventories.flatMap((inventory) => inventory.observations),
    };
}

/**
 * Serialize tile observations compactly for the final model without sending every image twice.
 *
 * @param before - Vision inventory of the complete control document.
 * @param after - Vision inventory of the complete candidate-applied document.
 * @returns Bounded text and whether the complete observation set was retained.
 */
export function renderTileInventoryContext(
    before: CandidateVisualTileInventory,
    after: CandidateVisualTileInventory,
): CandidateVisualTileInventoryContext {
    const indexedBefore = {
        ...before,
        instances: before.instances.map((instance, index) => ({
            observationIndex: index + 1,
            ...instance,
        })),
    };
    const indexedAfter = {
        ...after,
        instances: after.instances.map((instance, index) => ({
            observationIndex: index + 1,
            ...instance,
        })),
    };
    const serialized = JSON.stringify({ before: indexedBefore, after: indexedAfter });
    if (serialized.length <= MAX_TILE_INVENTORY_CONTEXT_CHARS) {
        return { text: serialized, complete: true };
    }
    return {
        text: JSON.stringify({
            contextTruncated: true,
            before: {
                ...indexedBefore,
                instances: indexedBefore.instances.slice(0, 10),
                rationales: before.rationales.slice(0, 3),
            },
            after: {
                ...indexedAfter,
                instances: indexedAfter.instances.slice(0, 10),
                rationales: after.rationales.slice(0, 3),
            },
        }),
        complete: false,
    };
}
