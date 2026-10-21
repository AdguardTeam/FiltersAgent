/**
 * One visual occurrence the candidate review cites: the schema every inventory, synthesis and
 * persisted review shares, kept apart from the review record so the records built on it can import
 * it without importing the review.
 */
import * as v from 'valibot';
import { ArtifactIdSchema } from './full-page-overview-evidence';

/**
 * Longest landmark one visual occurrence may name: enough for a page region in a sentence. The
 * synthesis context limit is derived from it, since every occurrence is sent there whole.
 */
export const MAX_INSTANCE_LANDMARK_CHARS = 500;

/**
 * Longest description of one visual occurrence. The synthesis context limit is derived from it,
 * since every occurrence is sent there whole.
 */
export const MAX_INSTANCE_DESCRIPTION_CHARS = 1_000;

/**
 * One visual occurrence tied to an exact runner-owned screenshot or tile artifact.
 *
 * Every field is required and checked; a key beside them is dropped rather than refused, because a
 * vision model annotates its instances (`landmark_note`) the same way it annotates a whole reply.
 */
export const CandidateVisualInstanceSchema = v.object({
    artifactId: ArtifactIdSchema,
    landmark: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_INSTANCE_LANDMARK_CHARS)),
    description: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_INSTANCE_DESCRIPTION_CHARS)),
});

/**
 * One visual symptom occurrence tied to an evidence artifact and page landmark.
 */
export type CandidateVisualInstance = v.InferOutput<typeof CandidateVisualInstanceSchema>;

/**
 * What one inventory instance shows, so the runner knows which instances it may ever set aside.
 */
export const CandidateVisualInstanceFootprint = {
    /**
     * Only empty space: no creative, ad label, frame or placeholder block is visible in it.
     */
    BlankSpace: 'blank_space',

    /**
     * Something visible: advertising, an ad label, a frame, a placeholder block, or broken content.
     */
    Visible: 'visible',
} as const;

/**
 * CandidateVisualInstanceFootprint value.
 */
export type CandidateVisualInstanceFootprint =
    (typeof CandidateVisualInstanceFootprint)[keyof typeof CandidateVisualInstanceFootprint];

export const CandidateVisualInventoryInstanceSchema = v.object({
    ...CandidateVisualInstanceSchema.entries,
    footprint: v.picklist(Object.values(CandidateVisualInstanceFootprint)),
});

/**
 * One inventory instance with what the vision pass said it shows.
 */
export type CandidateVisualInventoryInstance = v.InferOutput<
    typeof CandidateVisualInventoryInstanceSchema
>;

/**
 * Longest rationale any reply of the visual review may give, and the review persists: an
 * explanation of a few paragraphs.
 */
export const MAX_RATIONALE_CHARS = 4_000;

/**
 * Longest damage entry one inventory request may report: one flaw and its landmark in a few
 * sentences.
 */
export const MAX_OBSERVED_DAMAGE_ENTRY_CHARS = 1_000;

/**
 * One visible rendering flaw an inventory request reported.
 *
 * The artifact is an image the request carried and routes the flaw to its comparison with the
 * BEFORE state; an entry citing anything else is dropped before it gets here. BEFORE entries carry
 * the pre-existing prefix in their description.
 */
export const CandidateVisualDamageEntrySchema = v.object({
    artifactId: ArtifactIdSchema,
    description: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_OBSERVED_DAMAGE_ENTRY_CHARS)),
});

/**
 * One visible rendering flaw an inventory request reported, tied to the image it is in.
 */
export type CandidateVisualDamageEntry = v.InferOutput<typeof CandidateVisualDamageEntrySchema>;
