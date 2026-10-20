/**
 * The summary fields of a final synthesis must rest on what it reconciled.
 *
 * The synthesis cannot add an observation, so in an ads review a symptom it calls unresolved needs
 * an AFTER observation it kept as remaining, and residue it calls present needs an AFTER
 * observation at all — one it may still reconcile not_same_symptom, which is the residue-only shape
 * a maintainer is handed. For a cosmetic candidate in an ads review, a regressed page needs a flaw
 * the AFTER inventory still lists or non-target content the synthesis names as gone: once the
 * runner has set aside every flaw the page showed unchanged before the candidate, a synthesis that
 * still reports the page regressed and names nothing is answering from something the inventory no
 * longer holds. A reply that breaks one of these rules is refused and repaired like any other
 * invalid reply, and stays inconclusive if repair fails; the code never rewrites a field toward a
 * passing verdict.
 */
import { RuleKind, normalizeRule } from '../repo/rule-normalizer';
import {
    CandidateVisualAdLayoutResidue,
    CandidateVisualPageIntegrity,
    CandidateVisualSymptom,
    type CandidateVisualReviewModelOutput,
} from '../types/candidate-visual-review';
import { CandidateNetworkScope } from './candidate-network-scope';
import { type SymptomKind, isBreakageSymptom } from './symptom-rubric';

/**
 * Opening of every observedDamage entry that names non-target content the AFTER state lacks.
 */
export const MISSING_CONTENT_PREFIX = 'MISSING:';

/**
 * Synthesis rubric lines asking for content the candidate removed.
 *
 * A single-state inventory pass never lists an element that is gone, so an over-broad hiding rule
 * that took an article block or a menu with the ad shows up only in what the synthesis compares;
 * naming it is what lets a regressed page stand.
 */
export const MISSING_CONTENT_RUBRIC = [
    'List in missingContent every non-target element the BEFORE inventory shows that the AFTER',
    'state lacks — an article block, a menu, a player — each by its landmark. A regressed page',
    'rests on a flaw the AFTER inventory lists or on such missing content.',
];

/**
 * Which summary fields of one review must rest on a reconciled observation.
 */
export interface SynthesisConsistency {
    /**
     * Whether an unresolved symptom needs a remaining AFTER observation.
     */
    backedSymptom: boolean;

    /**
     * Whether present residue needs an AFTER observation.
     */
    backedResidue: boolean;

    /**
     * Whether a regressed page needs a listed AFTER flaw or named missing content.
     */
    backedRegression: boolean;
}

/**
 * What the reconciled AFTER state holds for the summary fields to rest on.
 */
export interface ReconciledAfterState {
    /**
     * AFTER observations the synthesis reconciled, whatever their disposition.
     */
    observationCount: number;

    /**
     * Flaws the AFTER inventory still lists.
     */
    damageCount: number;

    /**
     * Non-target elements the synthesis names as gone after the candidate.
     */
    missingContentCount: number;
}

/**
 * Decide which summary fields one review must back.
 *
 * Only an ads review is bound: in an incorrect-blocking review the residue field reports new
 * advertising from its own records. Residue of a third-party host block may stand without an
 * observation, because the runner weighs it against the candidate's scope instead. A regressed page
 * is bound only for a cosmetic candidate: a network or scriptlet candidate can break page function
 * no image inventory lists as a flaw.
 *
 * @param kind - Problem class driving the review.
 * @param scope - Runner-computed scope of the candidate.
 * @param candidateRule - Exact candidate rule under review.
 * @returns The fields this review must back.
 */
export function synthesisConsistency(
    kind: SymptomKind,
    scope: CandidateNetworkScope,
    candidateRule: string,
): SynthesisConsistency {
    const adsReview = !isBreakageSymptom(kind);
    return {
        backedSymptom: adsReview,
        backedResidue: adsReview && scope !== CandidateNetworkScope.ThirdPartyHostBlock,
        backedRegression: adsReview && normalizeRule(candidateRule).kind === RuleKind.Cosmetic,
    };
}

/**
 * Refuse a synthesis whose summary fields rest on nothing it reconciled.
 *
 * @param output - The normalized semantic output.
 * @param consistency - Which fields this review must back.
 * @param after - What the reconciled AFTER state holds.
 * @returns Nothing when the output is consistent.
 */
export function assertConsistentSynthesis(
    output: CandidateVisualReviewModelOutput,
    consistency: SynthesisConsistency,
    after: ReconciledAfterState,
): void {
    if (
        consistency.backedSymptom &&
        output.symptom === CandidateVisualSymptom.NotResolved &&
        output.remainingInstances.length === 0
    ) {
        throw new Error(
            'symptom=not_resolved needs at least one AFTER observation reconciled as remaining, ' +
                'and none is: reconcile the observation that shows the symptom as remaining, ' +
                'report unclear when the evidence cannot tell, or resolved when the ' +
                'reporter-defined symptom is gone.',
        );
    }
    if (
        consistency.backedResidue &&
        output.adLayoutResidue === CandidateVisualAdLayoutResidue.Present &&
        after.observationCount === 0
    ) {
        throw new Error(
            'adLayoutResidue=present needs an AFTER observation of the residue, and the AFTER ' +
                'inventory holds none: report unclear when the evidence cannot tell, and absent ' +
                'only when no residue remains.',
        );
    }
    if (
        consistency.backedRegression &&
        output.pageIntegrity === CandidateVisualPageIntegrity.Regressed &&
        after.damageCount === 0 &&
        after.missingContentCount === 0
    ) {
        throw new Error(
            'pageIntegrity=regressed needs a flaw the AFTER inventory lists or non-target ' +
                'content named in missingContent, and there is neither: the runner set aside ' +
                'every flaw the page shows unchanged without the candidate. Name the non-target ' +
                'content the AFTER state lacks in missingContent, report intact when nothing else ' +
                'is visibly broken, or unclear when the evidence cannot tell.',
        );
    }
}
