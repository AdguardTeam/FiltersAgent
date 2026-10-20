/**
 * The index checks of the final synthesis: every numbered observation of both states reconciled
 * exactly once, in runner order, and no instance the synthesis adds citing another state's image;
 * and the one rule both settlement requests apply to their numbered answers. They read only indices
 * and artifact IDs, never what an observation says.
 */
import type { CandidateVisualInstance } from '../types/candidate-visual-instance';
import type { CaptureState } from '../types/validation';

/**
 * Minimal numbered observation reference shared by both reconciliation phases.
 */
export interface IndexedInventoryDisposition {
    /**
     * One-based position in the matching runner-owned tile inventory.
     */
    observationIndex: number;
}

/**
 * Require exactly one final-model disposition for every numbered tile observation.
 *
 * @param state - Page state whose inventory is being reconciled.
 * @param observationCount - Number of runner-numbered observations for the state.
 * @param dispositions - Final-model disposition indices to validate.
 * @returns Nothing when every expected index appears exactly once.
 */
export function assertCompleteInventoryReconciliation(
    state: CaptureState,
    observationCount: number,
    dispositions: ReadonlyArray<IndexedInventoryDisposition>,
): void {
    const indices = dispositions.map((item) => item.observationIndex);
    const unknown = indices.filter((index) => index < 1 || index > observationCount);
    const duplicates = [
        ...new Set(indices.filter((index, position) => indices.indexOf(index) !== position)),
    ];
    const received = new Set(indices);
    const missing = Array.from({ length: observationCount }, (_, index) => index + 1).filter(
        (index) => !received.has(index),
    );
    if (unknown.length > 0 || duplicates.length > 0 || missing.length > 0) {
        const detail = [
            missing.length > 0 ? `missing=${missing.join(',')}` : undefined,
            duplicates.length > 0 ? `duplicate=${duplicates.join(',')}` : undefined,
            unknown.length > 0 ? `unknown=${unknown.join(',')}` : undefined,
        ]
            .filter((item): item is string => item !== undefined)
            .join('; ');
        throw new Error(
            `Final vision must reconcile every ${state} tile observation exactly once` +
                (detail ? `: ${detail}` : '.'),
        );
    }
}

/**
 * Return validated dispositions in their runner-owned observation order.
 *
 * @param observationCount - Number of expected sequential observations.
 * @param dispositions - Complete dispositions already checked for exact indices.
 * @returns Dispositions ordered from observation one through the final observation.
 */
export function orderInventoryDispositions<T extends IndexedInventoryDisposition>(
    observationCount: number,
    dispositions: ReadonlyArray<T>,
): T[] {
    const byIndex = new Map(dispositions.map((item) => [item.observationIndex, item]));
    return Array.from({ length: observationCount }, (_, index) => byIndex.get(index + 1)!);
}

/**
 * Validate that newly found overview instances cite evidence from their matching page state.
 *
 * @param instances - Additional instances reported from overview images.
 * @param allowedArtifactIds - Runner-owned identifiers valid for the selected page state.
 * @param state - Human-readable page state used in fail-closed diagnostics.
 * @returns Nothing when every instance is phase-bound to trusted evidence.
 */
export function assertAdditionalInstanceBindings(
    instances: CandidateVisualInstance[],
    allowedArtifactIds: ReadonlySet<string>,
    state: CaptureState,
): void {
    for (const instance of instances) {
        if (!allowedArtifactIds.has(instance.artifactId)) {
            throw new Error(
                `Vision cited a non-${state} evidence artifact: ${instance.artifactId}`,
            );
        }
    }
}

/**
 * The indices a reply answered exactly once.
 *
 * A request that numbers what it asks about acts on an answer only when it is the one answer for
 * that number: two answers for one item give it no single answer, and the item stays open.
 *
 * @param indices - The index of every answer, in reply order.
 * @returns The indices that occur exactly once.
 */
export function answeredOnce(indices: readonly number[]): Set<number> {
    const counts = new Map<number, number>();
    for (const index of indices) {
        counts.set(index, (counts.get(index) ?? 0) + 1);
    }
    return new Set([...counts].filter(([, count]) => count === 1).map(([index]) => index));
}
