/**
 * What the runner set aside from the AFTER inventory before the final synthesis, and on what
 * ground.
 *
 * A synthesis shown an ordinary gap between two sections or the site's own footer graphic in the
 * AFTER state can call it residue or damage, while the BEFORE capture shows the very same thing and
 * the agent's DOM check names the grid track that holds the gap. The runner takes such observations
 * out of the AFTER inventory itself, and the review records each one here with its evidence, so a
 * maintainer reads why the synthesis never weighed it.
 */
import * as v from 'valibot';
import {
    CandidateVisualInstanceSchema,
    MAX_OBSERVED_DAMAGE_ENTRY_CHARS,
    MAX_RATIONALE_CHARS,
} from './candidate-visual-instance';
import { ArtifactIdSchema } from './full-page-overview-evidence';

/**
 * Why the runner set an AFTER observation or flaw aside before the synthesis.
 */
export const CandidateVisualSettlementGround = {
    /**
     * A BEFORE tile shows the same element or blank space unchanged: the page had it without the
     * candidate.
     */
    UnchangedBefore: 'unchanged_before',

    /**
     * An agent DOM check names the element that holds the blank space and shows it is page layout,
     * not space kept for the advertising.
     */
    DomCheckLayout: 'dom_check_layout',
} as const;

/**
 * CandidateVisualSettlementGround value.
 */
export type CandidateVisualSettlementGround =
    (typeof CandidateVisualSettlementGround)[keyof typeof CandidateVisualSettlementGround];

const SettlementRationaleSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(MAX_RATIONALE_CHARS),
);

export const CandidateVisualSettledObservationSchema = v.variant('ground', [
    v.strictObject({
        ground: v.literal(CandidateVisualSettlementGround.UnchangedBefore),
        instance: CandidateVisualInstanceSchema,
        beforeArtifactId: ArtifactIdSchema,
        rationale: SettlementRationaleSchema,
    }),
    v.strictObject({
        ground: v.literal(CandidateVisualSettlementGround.DomCheckLayout),
        instance: CandidateVisualInstanceSchema,
        domCheckIndex: v.pipe(v.number(), v.integer(), v.minValue(1)),
        holder: v.pipe(v.string(), v.minLength(1)),
        rationale: SettlementRationaleSchema,
    }),
]);

export const CandidateVisualSettledDamageSchema = v.strictObject({
    artifactId: ArtifactIdSchema,
    description: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_OBSERVED_DAMAGE_ENTRY_CHARS)),
    beforeArtifactId: ArtifactIdSchema,
    rationale: SettlementRationaleSchema,
});

export const CandidateVisualSettlementSchema = v.strictObject({
    observations: v.array(CandidateVisualSettledObservationSchema),
    damage: v.array(CandidateVisualSettledDamageSchema),
});

/**
 * One AFTER observation the runner set aside, with its ground and evidence.
 */
export type CandidateVisualSettledObservation = v.InferOutput<
    typeof CandidateVisualSettledObservationSchema
>;

/**
 * One AFTER flaw the runner found unchanged in BEFORE and set aside as the page's own.
 */
export type CandidateVisualSettledDamage = v.InferOutput<typeof CandidateVisualSettledDamageSchema>;

/**
 * Everything the runner set aside from one review's AFTER inventory.
 */
export type CandidateVisualSettlement = v.InferOutput<typeof CandidateVisualSettlementSchema>;
