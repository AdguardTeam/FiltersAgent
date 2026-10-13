import * as v from 'valibot';
import {
    CANDIDATE_NETWORK_SCOPE_VALUES,
    CandidateNetworkScope,
} from '../validator/candidate-network-scope';
import { CANDIDATE_VALIDATION_ARTIFACT_ID_PATTERN } from './candidate-artifact-identity';
import {
    CandidateNetworkVerdict,
    CandidateNetworkVerificationSchema,
    type CandidateNetworkVerification,
} from '../validator/candidate-network-verification';

/**
 * Maximum number of page-damage observations accepted from one visual review.
 */
const MAX_OBSERVED_DAMAGE_ITEMS = 20;

/**
 * Maximum number of repeated symptom instances accepted from one visual review.
 */
const MAX_VISUAL_INSTANCES = 50;

/**
 * Maximum number of tile observations reconciled for either page state.
 */
const MAX_INVENTORY_RECONCILIATIONS = 50;

/**
 * Non-empty artifact identifier emitted by the trusted runner.
 */
const ArtifactIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(256));

/**
 * Bounded natural-language explanation returned by the visual model.
 */
const RationaleSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(4_000));

/**
 * Bounded description of one visually observed non-target regression.
 */
const ObservedDamageItemSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(1_000));

/**
 * Bounded description of the complete reporter-defined symptom family inspected by vision.
 */
const SymptomScopeSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(2_000));

/**
 * How one reviewed symptom instance relates to the reporter's symptom.
 */
export const CandidateInstanceDisposition = {
    SameSymptom: 'same_symptom',
    NotSameSymptom: 'not_same_symptom',
    Remaining: 'remaining',
} as const;

/**
 * CandidateInstanceDisposition value.
 */
export type CandidateInstanceDisposition =
    (typeof CandidateInstanceDisposition)[keyof typeof CandidateInstanceDisposition];

/**
 * Final semantic verdict of one candidate visual review.
 */
export const CandidateVisualVerdict = {
    Verified: 'verified',
    Rejected: 'rejected',
    Inconclusive: 'inconclusive',
} as const;

/**
 * Every candidate visual verdict value, for schemas and exhaustive listings.
 */
export const CANDIDATE_VISUAL_VERDICT_VALUES = Object.values(CandidateVisualVerdict);

/**
 * Whether the reviewed candidate resolved the reporter's symptom.
 */
export const CandidateVisualSymptom = {
    Resolved: 'resolved',
    NotResolved: 'not_resolved',
    Unclear: 'unclear',
} as const;

/**
 * Every candidate visual symptom value, for schemas and exhaustive listings.
 */
export const CANDIDATE_VISUAL_SYMPTOM_VALUES = Object.values(CandidateVisualSymptom);

/**
 * Whether an ad-shaped layout residue remained after the candidate applied.
 */
export const CandidateVisualAdLayoutResidue = {
    Absent: 'absent',
    Present: 'present',
    Unclear: 'unclear',
} as const;

/**
 * Every ad layout residue value, for schemas and exhaustive listings.
 */
export const CANDIDATE_VISUAL_AD_LAYOUT_RESIDUE_VALUES = Object.values(
    CandidateVisualAdLayoutResidue,
);

/**
 * Whether the page stayed intact after the candidate applied.
 */
export const CandidateVisualPageIntegrity = {
    Intact: 'intact',
    Regressed: 'regressed',
    Unclear: 'unclear',
} as const;

/**
 * Every page integrity value, for schemas and exhaustive listings.
 */
export const CANDIDATE_VISUAL_PAGE_INTEGRITY_VALUES = Object.values(CandidateVisualPageIntegrity);

/**
 * What a verified review's symptom claim rests on.
 */
export const CandidateVisualSymptomBasis = {
    /**
     * Vision saw the reporter's symptom before the candidate and saw it gone after.
     */
    Observed: 'observed',

    /**
     * Vision saw nothing to judge — the symptom is a request, not a picture — and the runner's
     * network verification proved the candidate blocked it: the baseline let requests to the host
     * through, the candidate let none through, and no third party the page had not contacted before
     * appeared in its place.
     */
    NetworkRequestsBlocked: 'network_requests_blocked',
} as const;

/**
 * Every symptom basis value, for schemas and exhaustive listings.
 */
export const CANDIDATE_VISUAL_SYMPTOM_BASIS_VALUES = Object.values(CandidateVisualSymptomBasis);

export const CandidateVisualSymptomBasisSchema = v.picklist(CANDIDATE_VISUAL_SYMPTOM_BASIS_VALUES);

/**
 * CandidateVisualSymptomBasis value.
 */
export type CandidateVisualSymptomBasis =
    (typeof CandidateVisualSymptomBasis)[keyof typeof CandidateVisualSymptomBasis];

/**
 * What a verified review's page-safety claim rests on.
 */
export const CandidateVisualIntegrityBasis = {
    /**
     * Vision observed the page intact after the candidate applied.
     */
    Intact: 'intact',

    /**
     * Vision could not prove first-party function for a network candidate, and did not have to: the
     * candidate blocks a host outside the reported site, the before/after is clean, and no damage
     * was observed.
     */
    ThirdPartyNetworkCleanBeforeAfter: 'third_party_network_clean_before_after',
} as const;

/**
 * CandidateVisualIntegrityBasis value.
 */
export type CandidateVisualIntegrityBasis =
    (typeof CandidateVisualIntegrityBasis)[keyof typeof CandidateVisualIntegrityBasis];

/**
 * Every integrity basis value, for schemas and exhaustive listings.
 */
export const CANDIDATE_VISUAL_INTEGRITY_BASIS_VALUES = Object.values(CandidateVisualIntegrityBasis);

/**
 * One visual occurrence tied to an exact runner-owned screenshot or tile artifact.
 */
export const CandidateVisualInstanceSchema = v.strictObject({
    artifactId: ArtifactIdSchema,
    landmark: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
    description: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
});

/**
 * Auditable final-model disposition of one before-state tile observation.
 */
export const CandidateVisualBeforeInventoryReconciliationSchema = v.strictObject({
    observationIndex: v.pipe(v.number(), v.integer(), v.minValue(1)),
    disposition: v.picklist([
        CandidateInstanceDisposition.SameSymptom,
        CandidateInstanceDisposition.NotSameSymptom,
    ]),
    rationale: RationaleSchema,
    instance: CandidateVisualInstanceSchema,
});

/**
 * Auditable final-model disposition of one after-state tile observation.
 */
export const CandidateVisualAfterInventoryReconciliationSchema = v.strictObject({
    observationIndex: v.pipe(v.number(), v.integer(), v.minValue(1)),
    disposition: v.picklist([
        CandidateInstanceDisposition.Remaining,
        CandidateInstanceDisposition.NotSameSymptom,
    ]),
    rationale: RationaleSchema,
    instance: CandidateVisualInstanceSchema,
});

/**
 * Complete audit trail binding every tile observation to the final semantic review.
 */
export const CandidateVisualInventoryReconciliationSchema = v.strictObject({
    before: v.pipe(
        v.array(CandidateVisualBeforeInventoryReconciliationSchema),
        v.maxLength(MAX_INVENTORY_RECONCILIATIONS),
    ),
    after: v.pipe(
        v.array(CandidateVisualAfterInventoryReconciliationSchema),
        v.maxLength(MAX_INVENTORY_RECONCILIATIONS),
    ),
});

/**
 * Final semantic outcome derived from the model's visual observations.
 */
export const CandidateVisualVerdictSchema = v.picklist(CANDIDATE_VISUAL_VERDICT_VALUES);

/**
 * Model judgment about whether the reported symptom disappeared after applying the candidate.
 */
export const CandidateVisualSymptomSchema = v.picklist(CANDIDATE_VISUAL_SYMPTOM_VALUES);

/**
 * Model judgment about reporter-related advertising layout left after the candidate.
 */
export const CandidateVisualAdLayoutResidueSchema = v.picklist(
    CANDIDATE_VISUAL_AD_LAYOUT_RESIDUE_VALUES,
);

/**
 * Model judgment about whether non-target page content remained visually intact.
 */
export const CandidateVisualPageIntegritySchema = v.picklist(
    CANDIDATE_VISUAL_PAGE_INTEGRITY_VALUES,
);

/**
 * Runner-computed relation between the candidate rule and the reported page's own site.
 */
export const CandidateVisualNetworkScopeSchema = v.picklist(CANDIDATE_NETWORK_SCOPE_VALUES);

/**
 * Runner-derived record of what a verified review's page-safety claim rests on.
 */
export const CandidateVisualIntegrityBasisSchema = v.picklist(
    CANDIDATE_VISUAL_INTEGRITY_BASIS_VALUES,
);

/**
 * Untrusted semantic output accepted directly from the visual model.
 *
 * Runner-bound artifact identifiers, candidate hashes, and the derived verdict are intentionally
 * excluded from this schema.
 */
export const CandidateVisualReviewModelOutputSchema = v.strictObject({
    symptom: CandidateVisualSymptomSchema,
    symptomScope: SymptomScopeSchema,
    adLayoutResidue: CandidateVisualAdLayoutResidueSchema,
    coverageComplete: v.boolean(),
    beforeInstances: v.pipe(
        v.array(CandidateVisualInstanceSchema),
        v.maxLength(MAX_VISUAL_INSTANCES),
    ),
    remainingInstances: v.pipe(
        v.array(CandidateVisualInstanceSchema),
        v.maxLength(MAX_VISUAL_INSTANCES),
    ),
    pageIntegrity: CandidateVisualPageIntegritySchema,
    rationale: RationaleSchema,
    observedDamage: v.pipe(
        v.array(ObservedDamageItemSchema),
        v.maxLength(MAX_OBSERVED_DAMAGE_ITEMS),
    ),
});

/**
 * Runner-owned provenance for the full-page image used or safely omitted for vision.
 */
export const CandidateVisualFullPageOverviewEvidenceSchema = v.pipe(
    v.strictObject({
        mode: v.picklist([
            'original',
            'omitted_complete_tiles',
            // Withheld because the document is far taller than it is wide. Unlike the oversized
            // modes it needs no tile-coverage proof and never blocks the review: an image the
            // model cannot read protects nothing. See `planFullPageOverview`.
            'omitted_illegible',
            'blocked_oversized_incomplete_tiles',
        ]),
        originalArtifactId: ArtifactIdSchema,
        originalBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
        visionArtifactId: v.nullable(ArtifactIdSchema),
        visionBytes: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
        reason: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))),
    }),
    v.check((evidence) => {
        if (evidence.mode === 'original') {
            return (
                evidence.visionArtifactId === evidence.originalArtifactId &&
                evidence.visionBytes === evidence.originalBytes &&
                evidence.reason === null
            );
        }
        return (
            evidence.visionArtifactId === null &&
            evidence.visionBytes === null &&
            evidence.reason !== null
        );
    }, 'Full-page overview provenance must bind original and vision artifacts consistently.'),
);

/**
 * Trusted visual-review record bound by the runner to one candidate and four evidence images.
 */
export const CandidateVisualReviewSchema = v.pipe(
    v.strictObject({
        verdict: CandidateVisualVerdictSchema,
        symptom: CandidateVisualSymptomSchema,
        symptomScope: SymptomScopeSchema,
        adLayoutResidue: CandidateVisualAdLayoutResidueSchema,
        coverageComplete: v.boolean(),
        beforeInstances: v.pipe(
            v.array(CandidateVisualInstanceSchema),
            v.maxLength(MAX_VISUAL_INSTANCES),
        ),
        remainingInstances: v.pipe(
            v.array(CandidateVisualInstanceSchema),
            v.maxLength(MAX_VISUAL_INSTANCES),
        ),
        pageIntegrity: CandidateVisualPageIntegritySchema,
        candidateNetworkScope: v.optional(CandidateVisualNetworkScopeSchema),
        integrityBasis: v.optional(CandidateVisualIntegrityBasisSchema),
        networkVerification: v.optional(CandidateNetworkVerificationSchema),
        symptomBasis: v.optional(CandidateVisualSymptomBasisSchema),
        validationArtifactId: v.pipe(v.string(), v.regex(CANDIDATE_VALIDATION_ARTIFACT_ID_PATTERN)),
        candidateRuleHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
        beforeViewportArtifactId: ArtifactIdSchema,
        afterViewportArtifactId: ArtifactIdSchema,
        beforeFullPageArtifactId: ArtifactIdSchema,
        afterFullPageArtifactId: ArtifactIdSchema,
        fullPageOverviewEvidence: v.optional(
            v.strictObject({
                before: CandidateVisualFullPageOverviewEvidenceSchema,
                after: CandidateVisualFullPageOverviewEvidenceSchema,
            }),
        ),
        model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
        rationale: RationaleSchema,
        observedDamage: v.pipe(
            v.array(ObservedDamageItemSchema),
            v.maxLength(MAX_OBSERVED_DAMAGE_ITEMS),
        ),
        inventoryReconciliation: v.optional(CandidateVisualInventoryReconciliationSchema),
    }),
    v.check((review) => {
        const scope = review.candidateNetworkScope;
        const network = review.networkVerification;
        return (
            review.verdict === deriveCandidateVisualVerdict(review, scope, network) &&
            // A review written before the bases existed carries none and is left alone; one that
            // states a basis must state the basis its own observations, scope and network
            // verification produce, so the annotation a maintainer reads can never disagree with
            // the verdict beside it.
            (review.integrityBasis === undefined ||
                review.integrityBasis ===
                    deriveCandidateVisualIntegrityBasis(review, scope, network)) &&
            (review.symptomBasis === undefined ||
                review.symptomBasis === deriveCandidateVisualSymptomBasis(review, scope, network))
        );
    }, 'Visual review verdict and bases must match its semantic observations.'),
);

/**
 * Final semantic outcome of a candidate visual review.
 */
export type CandidateVisualVerdict = v.InferOutput<typeof CandidateVisualVerdictSchema>;

/**
 * Model judgment about resolution of the reporter-defined symptom.
 */
export type CandidateVisualSymptom = v.InferOutput<typeof CandidateVisualSymptomSchema>;

/**
 * Vision-owned state of advertising wrappers, labels, frames, or reserved space after a fix.
 */
export type CandidateVisualAdLayoutResidue = v.InferOutput<
    typeof CandidateVisualAdLayoutResidueSchema
>;

/**
 * Model judgment about visible non-target page integrity.
 */
export type CandidateVisualPageIntegrity = v.InferOutput<typeof CandidateVisualPageIntegritySchema>;

/**
 * One visual symptom occurrence tied to an evidence artifact and page landmark.
 */
export type CandidateVisualInstance = v.InferOutput<typeof CandidateVisualInstanceSchema>;

/**
 * Complete auditable dispositions for the before and after tile inventories.
 */
export type CandidateVisualInventoryReconciliation = v.InferOutput<
    typeof CandidateVisualInventoryReconciliationSchema
>;

/**
 * Untrusted semantic output returned by the visual model.
 */
export type CandidateVisualReviewModelOutput = v.InferOutput<
    typeof CandidateVisualReviewModelOutputSchema
>;

/**
 * Runner-owned provenance for one full-page overview supplied to or omitted from vision.
 */
export type CandidateVisualFullPageOverviewEvidence = v.InferOutput<
    typeof CandidateVisualFullPageOverviewEvidenceSchema
>;

/**
 * Trusted runner-bound record of a candidate visual review.
 */
export type CandidateVisualReview = v.InferOutput<typeof CandidateVisualReviewSchema>;

/**
 * Whether a clean before/after is the whole page-safety evidence this candidate can produce.
 *
 * The visual reviewer is told to report `pageIntegrity: unclear` for a network candidate whenever
 * images cannot show that a first-party interactive function the blocked request served still
 * works. For a block aimed outside the reported site there is no such function to lose: the host
 * serves the page nothing it owns, so a resolved symptom with no residue and no observed damage is
 * the complete case. The runner decides this from the rule text and the trusted reported URL, so a
 * model cannot reach it by overstating `intact`.
 *
 * @param output - Parsed semantic output returned by the visual model.
 * @param scope - Runner-computed scope of the candidate, absent for a review that predates it.
 * @returns Whether an unclear page integrity may still carry a verified verdict.
 */
function unclearIntegrityIsComplete(
    output: CandidateVisualReviewModelOutput,
    scope: CandidateNetworkScope | undefined,
): boolean {
    return (
        output.pageIntegrity === CandidateVisualPageIntegrity.Unclear &&
        output.observedDamage.length === 0 &&
        scope === CandidateNetworkScope.ThirdPartyHostBlock
    );
}

/**
 * Whether the advertising footprint the model saw left behind stands against the candidate.
 *
 * Residue is a cosmetic rule's job: a block of a third-party host stops the advertising from
 * loading and cannot collapse space the page itself reserves for it. A maintainer fix can be
 * exactly such a rule, leaving the reserved band alone, while the review rejects the same rule for
 * that band in about one run out of five. So residue present counts against every candidate except
 * a third-party host block, where it stays a reported fact.
 *
 * @param output - Parsed semantic output returned by the visual model.
 * @param scope - Runner-computed scope of the candidate.
 * @returns Whether present residue rejects this candidate.
 */
function residueStandsAgainstCandidate(
    output: CandidateVisualReviewModelOutput,
    scope: CandidateNetworkScope | undefined,
): boolean {
    return (
        output.adLayoutResidue === CandidateVisualAdLayoutResidue.Present &&
        scope !== CandidateNetworkScope.ThirdPartyHostBlock
    );
}

/**
 * Whether the runner's network verification, not the model's symptom judgement, decides this
 * review.
 *
 * It does when there is one and vision found no instance of the symptom before the candidate: a
 * request has no picture, so the images could never have shown it and cannot show it gone. When
 * vision did see instances the symptom is visible after all, and the visual judgement decides as
 * for any other candidate; the network facts then stay a recorded fact beside it.
 *
 * @param output - Parsed semantic output returned by the visual model.
 * @param network - Runner-computed network verification of the candidate, when it is a host block.
 * @returns Whether the network verification carries the symptom half of the verdict.
 */
function networkDecidesSymptom(
    output: CandidateVisualReviewModelOutput,
    network: CandidateNetworkVerification | undefined,
): network is CandidateNetworkVerification {
    return network !== undefined && output.beforeInstances.length === 0;
}

/**
 * Derives the final verdict from the model's independent symptom and integrity judgments.
 *
 * @param output - Parsed semantic output returned by the visual model.
 * @param scope - Runner-computed scope of the candidate, absent for a review that predates it.
 * @param network - Runner-computed network verification of the candidate, when it is a host block.
 * @returns The final candidate verdict enforced by the runner.
 */
export function deriveCandidateVisualVerdict(
    output: CandidateVisualReviewModelOutput,
    scope?: CandidateNetworkScope,
    network?: CandidateNetworkVerification,
): CandidateVisualVerdict {
    if (networkDecidesSymptom(output, network)) {
        // The images hold only the page-safety half here: a page the candidate visibly broke
        // rejects the block however cleanly the requests stopped.
        return network.verdict === CandidateNetworkVerdict.Verified &&
            output.pageIntegrity !== CandidateVisualPageIntegrity.Regressed &&
            output.observedDamage.length === 0
            ? CandidateVisualVerdict.Verified
            : CandidateVisualVerdict.Rejected;
    }
    if (
        output.symptom === CandidateVisualSymptom.NotResolved ||
        residueStandsAgainstCandidate(output, scope) ||
        output.remainingInstances.length > 0 ||
        output.pageIntegrity === CandidateVisualPageIntegrity.Regressed
    ) {
        return CandidateVisualVerdict.Rejected;
    }

    if (
        output.symptom === CandidateVisualSymptom.Resolved &&
        (output.adLayoutResidue === CandidateVisualAdLayoutResidue.Absent ||
            (output.adLayoutResidue === CandidateVisualAdLayoutResidue.Present &&
                scope === CandidateNetworkScope.ThirdPartyHostBlock)) &&
        output.coverageComplete &&
        output.beforeInstances.length > 0 &&
        (output.pageIntegrity === CandidateVisualPageIntegrity.Intact ||
            unclearIntegrityIsComplete(output, scope))
    ) {
        return CandidateVisualVerdict.Verified;
    }

    return CandidateVisualVerdict.Inconclusive;
}

/**
 * Derives what a verified review's page-safety claim rests on, so a report can show it.
 *
 * @param output - Parsed semantic output returned by the visual model.
 * @param scope - Runner-computed scope of the candidate, absent for a review that predates it.
 * @param network - Runner-computed network verification of the candidate, when it is a host block.
 * @returns The basis of a verified verdict, or undefined when the verdict is not verified.
 */
export function deriveCandidateVisualIntegrityBasis(
    output: CandidateVisualReviewModelOutput,
    scope?: CandidateNetworkScope,
    network?: CandidateNetworkVerification,
): CandidateVisualIntegrityBasis | undefined {
    if (deriveCandidateVisualVerdict(output, scope, network) !== CandidateVisualVerdict.Verified) {
        return undefined;
    }
    return output.pageIntegrity === CandidateVisualPageIntegrity.Intact
        ? CandidateVisualIntegrityBasis.Intact
        : CandidateVisualIntegrityBasis.ThirdPartyNetworkCleanBeforeAfter;
}

/**
 * Derives what a verified review's symptom claim rests on, so a report can show it.
 *
 * @param output - Parsed semantic output returned by the visual model.
 * @param scope - Runner-computed scope of the candidate, absent for a review that predates it.
 * @param network - Runner-computed network verification of the candidate, when it is a host block.
 * @returns The basis of a verified verdict, or undefined when the verdict is not verified.
 */
export function deriveCandidateVisualSymptomBasis(
    output: CandidateVisualReviewModelOutput,
    scope?: CandidateNetworkScope,
    network?: CandidateNetworkVerification,
): CandidateVisualSymptomBasis | undefined {
    if (deriveCandidateVisualVerdict(output, scope, network) !== CandidateVisualVerdict.Verified) {
        return undefined;
    }
    return networkDecidesSymptom(output, network)
        ? CandidateVisualSymptomBasis.NetworkRequestsBlocked
        : CandidateVisualSymptomBasis.Observed;
}

/**
 * Whether a review leaves the page usable enough for the run to build on it.
 *
 * This is the one place the whole path asks that question, so a candidate the review verified and
 * one the run may carry to a rule proposal cannot be decided on different readings of the same
 * record. A page vision saw intact is usable. So is the third-party network case: the basis is only
 * ever stored on a verified review, and the schema's invariant re-derives it from the review's own
 * observations and runner-computed scope, so reading it here inherits that proof rather than
 * re-stating the conditions behind it.
 *
 * @param review - Trusted runner-bound review of the candidate.
 * @returns Whether the reviewed page counts as usable.
 */
export function isCandidateVisualPageUsable(review: CandidateVisualReview): boolean {
    return (
        review.pageIntegrity === CandidateVisualPageIntegrity.Intact ||
        review.integrityBasis === CandidateVisualIntegrityBasis.ThirdPartyNetworkCleanBeforeAfter
    );
}
