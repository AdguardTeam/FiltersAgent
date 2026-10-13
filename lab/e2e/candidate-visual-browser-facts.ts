/**
 * The compact browser context handed to the candidate vision review: selector-family counts, layout
 * facts and tile coverage, with every raw DOM, HAR and measurement array left behind.
 */
import { type FactualValidationResult, type StructuralSnapshot } from '../../src/types/validation';

/**
 * Select only selector-family measurements that help vision find repeated symptom instances.
 *
 * @param snapshot - Raw browser structure snapshot for one candidate state.
 * @returns Bounded before/after family facts without DOM-derived semantic decisions.
 */
function compactCandidateFamilyFacts(snapshot: StructuralSnapshot | undefined) {
    if (!snapshot) {
        return undefined;
    }
    return {
        probeSucceeded: snapshot.probeSucceeded,
        documentHeight: snapshot.documentHeight,
        targetCount: snapshot.targetCount,
        targetVisibleCount: snapshot.targetVisibleCount,
        targetTotalHeight: snapshot.targetTotalHeight,
        targetMaximumHeight: snapshot.targetMaximumHeight,
        targetFamilyClass: snapshot.targetFamilyClass,
        familyProbeTruncated: snapshot.familyProbeTruncated,
        familyTargetCount: snapshot.familyTargetCount,
        familyTargetVisibleCount: snapshot.familyTargetVisibleCount,
        familyTargetTotalHeight: snapshot.familyTargetTotalHeight,
        familyTargetMaximumHeight: snapshot.familyTargetMaximumHeight,
    };
}

/**
 * Build purpose-specific browser context for the candidate vision review.
 *
 * DOM geometry and capture metadata are factual hints only. The returned object contains both
 * before and after selector-family counts and deliberately omits raw DOM, HAR, and measurement
 * arrays so neither truncation nor ordering can hide the after state.
 *
 * @param result - Full runner-owned factual validation result.
 * @returns Compact family, layout, and tile-coverage facts for visual interpretation.
 */
export function buildCandidateVisualBrowserFacts(result: FactualValidationResult) {
    const beforeCoverage =
        result.phaseC.sameDocumentControlTileCoverage ?? result.phaseB.tileCoverage;
    const afterCoverage = result.phaseC.tileCoverage;
    return {
        validatedSelector: result.validatedSelector,
        adElementStatus: result.adElementStatus,
        layoutFacts: result.layoutFacts,
        family: {
            before: compactCandidateFamilyFacts(result.structureFacts?.before),
            after: compactCandidateFamilyFacts(
                result.structureFacts?.afterArtifacts ?? result.structureFacts?.after,
            ),
        },
        captureCoverage: {
            before: beforeCoverage
                ? { complete: beforeCoverage.complete, tileCount: beforeCoverage.tiles.length }
                : { complete: false, tileCount: 0 },
            after: afterCoverage
                ? { complete: afterCoverage.complete, tileCount: afterCoverage.tiles.length }
                : { complete: false, tileCount: 0 },
        },
    };
}
