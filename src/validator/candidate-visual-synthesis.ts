/**
 * The final-synthesis stage of the candidate visual review: the text-only pass that reconciles both
 * already-computed image inventories into one semantic verdict, its bounded repair and dismissal
 * audit loop, and the fail-closed inconclusive output every failure lands on.
 *
 * No image is sent from here. The stage reads the inventories the image passes produced, so a
 * verdict can never be reached from pixels this run did not already cite.
 */
import * as v from 'valibot';
import { SingleShotResultKind } from '../pi/single-shot-types';
import { SingleShotMessageRole, type SingleShotMessage } from '../pi/single-shot-input';
import { TraceEventType } from '../types/trace';
import {
    CandidateVisualPageIntegrity,
    CANDIDATE_VISUAL_PAGE_INTEGRITY_VALUES,
    CandidateVisualAdLayoutResidue,
    CANDIDATE_VISUAL_AD_LAYOUT_RESIDUE_VALUES,
    CANDIDATE_VISUAL_SYMPTOM_VALUES,
    CandidateInstanceDisposition,
    CandidateVisualInstanceSchema,
    CandidateVisualReviewModelOutputSchema,
    type CandidateVisualInstance,
    type CandidateVisualInventoryReconciliation,
    type CandidateVisualReviewModelOutput,
} from '../types/candidate-visual-review';
import { CaptureState } from '../types/validation';
import { MAX_RATIONALE_CHARS } from './candidate-visual-inventory';
import {
    MAX_RECONCILED_INSTANCES,
    type CandidateVisualTileInventory,
} from './candidate-visual-context';
import type { CandidateVisualVerifierOptions } from './candidate-visual-evidence';

/**
 * Maximum text-only attempts for reconciliation, repair, and one conditional dismissal audit.
 */
const MAX_FINAL_SYNTHESIS_ATTEMPTS = 3;

/**
 * Maximum trusted validation-diagnostic length retained in retry prompts and traces.
 */
const MAX_FINAL_VALIDATION_DETAIL_CHARS = 1_000;

/**
 * Final-model disposition for one numbered before-state tile observation.
 */
const CandidateVisualBeforeDispositionOutputSchema = v.strictObject({
    observationIndex: v.pipe(v.number(), v.integer(), v.minValue(1)),
    disposition: v.picklist([
        CandidateInstanceDisposition.SameSymptom,
        CandidateInstanceDisposition.NotSameSymptom,
    ]),
    rationale: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_RATIONALE_CHARS)),
});

/**
 * Final-model disposition for one numbered after-state tile observation.
 */
const CandidateVisualAfterDispositionOutputSchema = v.strictObject({
    observationIndex: v.pipe(v.number(), v.integer(), v.minValue(1)),
    disposition: v.picklist([
        CandidateInstanceDisposition.Remaining,
        CandidateInstanceDisposition.NotSameSymptom,
    ]),
    rationale: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_RATIONALE_CHARS)),
});

/**
 * Strict semantic output used only by the final inventory-reconciliation vision call.
 */
const CandidateVisualFinalModelOutputSchema = v.strictObject({
    symptom: v.picklist(CANDIDATE_VISUAL_SYMPTOM_VALUES),
    symptomScope: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
    adLayoutResidue: v.picklist(CANDIDATE_VISUAL_AD_LAYOUT_RESIDUE_VALUES),
    coverageComplete: v.boolean(),
    beforeInventoryReconciliation: v.pipe(
        v.array(CandidateVisualBeforeDispositionOutputSchema),
        v.maxLength(MAX_RECONCILED_INSTANCES),
    ),
    afterInventoryReconciliation: v.pipe(
        v.array(CandidateVisualAfterDispositionOutputSchema),
        v.maxLength(MAX_RECONCILED_INSTANCES),
    ),
    additionalBeforeInstances: v.pipe(
        v.array(CandidateVisualInstanceSchema),
        v.maxLength(MAX_RECONCILED_INSTANCES),
    ),
    additionalRemainingInstances: v.pipe(
        v.array(CandidateVisualInstanceSchema),
        v.maxLength(MAX_RECONCILED_INSTANCES),
    ),
    pageIntegrity: v.picklist(CANDIDATE_VISUAL_PAGE_INTEGRITY_VALUES),
    rationale: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_RATIONALE_CHARS)),
    observedDamage: v.pipe(
        v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))),
        v.maxLength(20),
    ),
});

/**
 * Strict output returned by the final inventory-reconciliation vision call.
 */
type CandidateVisualFinalModelOutput = v.InferOutput<typeof CandidateVisualFinalModelOutputSchema>;

/**
 * Parsed semantic result plus its complete runner-bound inventory audit trail.
 */
interface NormalizedCandidateVisualOutput {
    /**
     * Schema-owned semantic review fields used to derive the verdict.
     */
    semanticOutput: CandidateVisualReviewModelOutput;

    /**
     * Exact disposition of every before and after tile observation.
     */
    inventoryReconciliation: CandidateVisualInventoryReconciliation;
}

/**
 * Minimal numbered observation reference shared by both reconciliation phases.
 */
interface IndexedInventoryDisposition {
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
function assertCompleteInventoryReconciliation(
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
function orderInventoryDispositions<T extends IndexedInventoryDisposition>(
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
function assertAdditionalInstanceBindings(
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
 * Reconcile every tile observation and copy only schema-owned semantic fields from vision.
 *
 * @param output - Final provider result containing explicit inventory dispositions.
 * @param beforeInventory - Complete numbered before-state tile inventory.
 * @param afterInventory - Complete numbered after-state tile inventory.
 * @param allowedBeforeArtifactIds - Runner-owned before-state identifiers the model may cite.
 * @param allowedAfterArtifactIds - Runner-owned after-state identifiers the model may cite.
 * @param runnerCoverageComplete - Whether the tile capture mechanically covered both documents.
 * @returns Strict semantic observations plus an auditable runner-bound reconciliation.
 */
function normalizeModelOutput(
    output: CandidateVisualFinalModelOutput,
    beforeInventory: CandidateVisualTileInventory,
    afterInventory: CandidateVisualTileInventory,
    allowedBeforeArtifactIds: ReadonlySet<string>,
    allowedAfterArtifactIds: ReadonlySet<string>,
    runnerCoverageComplete: boolean,
): NormalizedCandidateVisualOutput {
    assertCompleteInventoryReconciliation(
        'before',
        beforeInventory.instances.length,
        output.beforeInventoryReconciliation,
    );
    assertCompleteInventoryReconciliation(
        'after',
        afterInventory.instances.length,
        output.afterInventoryReconciliation,
    );
    assertAdditionalInstanceBindings(
        output.additionalBeforeInstances,
        allowedBeforeArtifactIds,
        'before',
    );
    assertAdditionalInstanceBindings(
        output.additionalRemainingInstances,
        allowedAfterArtifactIds,
        'after',
    );
    if (
        output.additionalBeforeInstances.length > 0 ||
        output.additionalRemainingInstances.length > 0
    ) {
        throw new Error(
            'Final text-only vision synthesis cannot introduce additional visual instances.',
        );
    }

    const beforeReconciliation = orderInventoryDispositions(
        beforeInventory.instances.length,
        output.beforeInventoryReconciliation,
    ).map((item) => ({
        ...item,
        instance: beforeInventory.instances[item.observationIndex - 1],
    }));
    const afterReconciliation = orderInventoryDispositions(
        afterInventory.instances.length,
        output.afterInventoryReconciliation,
    ).map((item) => ({
        ...item,
        instance: afterInventory.instances[item.observationIndex - 1],
    }));
    const semanticOutput = v.parse(CandidateVisualReviewModelOutputSchema, {
        symptom: output.symptom,
        symptomScope: output.symptomScope,
        adLayoutResidue: output.adLayoutResidue,
        coverageComplete: output.coverageComplete && runnerCoverageComplete,
        beforeInstances: [
            ...beforeReconciliation
                .filter((item) => item.disposition === CandidateInstanceDisposition.SameSymptom)
                .map((item) => item.instance),
            ...output.additionalBeforeInstances,
        ],
        remainingInstances: [
            ...afterReconciliation
                .filter((item) => item.disposition === CandidateInstanceDisposition.Remaining)
                .map((item) => item.instance),
            ...output.additionalRemainingInstances,
        ],
        pageIntegrity: output.pageIntegrity,
        rationale: output.rationale,
        observedDamage: output.observedDamage,
    });
    return {
        semanticOutput,
        inventoryReconciliation: {
            before: beforeReconciliation,
            after: afterReconciliation,
        },
    };
}

/**
 * Return every runner-owned screenshot identifier involved in the visual review.
 *
 * @param options - Review options containing the complete evidence set.
 * @returns Evidence identifiers in stable before/after order.
 */
function evidenceArtifactIds(options: CandidateVisualVerifierOptions): string[] {
    return [
        options.evidence.beforeViewport.id,
        options.evidence.afterViewport.id,
        options.evidence.beforeFullPage.id,
        options.evidence.afterFullPage.id,
        ...options.evidence.beforeTiles.map((tile) => tile.id),
        ...options.evidence.afterTiles.map((tile) => tile.id),
    ];
}

/**
 * Convert a final-synthesis validation failure to a bounded trusted diagnostic.
 *
 * @param error - Schema, JSON, or inventory-reconciliation failure.
 * @returns Bounded error detail safe for prompts, traces, and persisted rationale.
 */
function finalValidationDetail(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(
        0,
        MAX_FINAL_VALIDATION_DETAIL_CHARS,
    );
}

/**
 * Before/after inventory tag rendered into a reconciliation repair prompt.
 */
const ReconciliationRangeState = {
    /**
     * The before-state visual inventory.
     */
    Before: 'BEFORE',

    /**
     * The after-state visual inventory.
     */
    After: 'AFTER',
} as const;

/**
 * ReconciliationRangeState value.
 */
type ReconciliationRangeState =
    (typeof ReconciliationRangeState)[keyof typeof ReconciliationRangeState];

/**
 * Explain the exact observation indices required for one reconciliation array.
 *
 * @param state - Before or after visual inventory.
 * @param observationCount - Number of numbered observations in the inventory.
 * @returns Bounded deterministic range instruction for a repair prompt.
 */
function reconciliationRangeInstruction(
    state: ReconciliationRangeState,
    observationCount: number,
): string {
    if (observationCount === 0) {
        return `${state} reconciliation must be an empty array because there are no observations.`;
    }
    return (
        `${state} observationIndex range is exactly 1..${observationCount}; include every index ` +
        'once with no missing, duplicate, or unknown indices.'
    );
}

/**
 * Build one bounded repair message for a failed final text synthesis.
 *
 * @param validationError - Exact locally detected schema or reconciliation error.
 * @param beforeObservationCount - Number of numbered before observations.
 * @param afterObservationCount - Number of numbered after observations.
 * @returns Text-only repair instruction that never embeds the rejected model response.
 */
function buildFinalSynthesisRepairMessage(
    validationError: string,
    beforeObservationCount: number,
    afterObservationCount: number,
): SingleShotMessage {
    return {
        role: SingleShotMessageRole.User,
        text: [
            `The previous final synthesis failed local validation: ${validationError}`,
            reconciliationRangeInstruction(ReconciliationRangeState.Before, beforeObservationCount),
            reconciliationRangeInstruction(ReconciliationRangeState.After, afterObservationCount),
            'Reuse only the already supplied text inventory. No images or new pixel inspection are',
            'needed. Return one corrected JSON object that matches the schema.',
        ].join(' '),
    };
}

/**
 * Build one bounded self-critique request for proposed after-observation dismissals.
 *
 * @param dismissedObservationIndices - Numbered after observations proposed as unrelated.
 * @returns Text-only audit instruction that reuses the fixed image inventory.
 */
function buildAfterDismissalAuditMessage(dismissedObservationIndices: number[]): SingleShotMessage {
    return {
        role: SingleShotMessageRole.User,
        text: [
            'Perform one bounded semantic self-critique before accepting the proposed AFTER',
            '`not_same_symptom` dismissals at observationIndex',
            `${dismissedObservationIndices.join(', ')}.`,
            'Recheck every proposed dismissal against the reporter-defined symptom and the',
            'already supplied image-grounded visual observation. A dismissal requires strong',
            'image-grounded evidence of a visually distinct normal structure or feature.',
            'If an observation repeats the same symptom anywhere on the page, return `remaining`,',
            'even when its size, severity, landmark, or prominence differs from the primary',
            'example. Browser, DOM, and geometry facts may locate or measure it but cannot prove',
            'that a visually compatible symptom is unrelated. Return a complete JSON object for',
            'every BEFORE and AFTER observation using only the supplied inventory; do not claim',
            'new pixel inspection.',
        ].join(' '),
    };
}

/**
 * Local validation outcome for one final-synthesis attempt.
 */
const FinalSynthesisAttemptStatus = {
    /**
     * The synthesis output passed local schema and reconciliation validation.
     */
    Validated: 'validated',

    /**
     * The synthesis output failed local schema or reconciliation validation.
     */
    ValidationFailed: 'validation_failed',
} as const;

/**
 * FinalSynthesisAttemptStatus value.
 */
type FinalSynthesisAttemptStatus =
    (typeof FinalSynthesisAttemptStatus)[keyof typeof FinalSynthesisAttemptStatus];

/**
 * Record one bounded final-synthesis attempt without retaining the untrusted model response.
 *
 * @param options - Review options owning the trace and validation identity.
 * @param model - Bounded vision-model identifier.
 * @param attempt - One-based final-synthesis attempt number.
 * @param status - Local validation outcome for this attempt.
 * @param detail - Optional bounded validation failure or semantic result fields.
 * @returns Nothing after appending the trace events.
 */
function recordFinalSynthesisAttempt(
    options: CandidateVisualVerifierOptions,
    model: string,
    attempt: number,
    status: FinalSynthesisAttemptStatus,
    detail: Record<string, unknown>,
): void {
    options.recorder.recordLlmTurn(
        {
            purpose: 'candidate_visual_review',
            phase: 'final_synthesis',
            model,
            attempt,
            validationArtifactId: options.validationArtifactId,
            evidenceArtifactIds: evidenceArtifactIds(options),
        },
        {
            model,
            status,
            ...detail,
        },
    );
}

/**
 * Reconcile already-computed image inventories with bounded text-only repair attempts.
 *
 * Image inventory calls happen before this function. Validation retries reuse the same text
 * inventory and append only the exact local error and required index ranges. A schema-valid result
 * that proposes an after-observation dismissal receives one bounded semantic self-critique before
 * it can be returned. A schema-valid semantic `unclear` result without dismissals returns
 * directly.
 *
 * @param options - Review options providing the model, trace, and runner-owned evidence.
 * @param baseMessages - Original text-only synthesis messages containing the fixed inventories.
 * @param beforeInventory - Already-computed before-state visual inventory.
 * @param afterInventory - Already-computed after-state visual inventory.
 * @param allowedBeforeArtifactIds - Runner-owned before screenshot identifiers.
 * @param allowedAfterArtifactIds - Runner-owned after screenshot identifiers.
 * @param runnerCoverageComplete - Whether capture and inventory coverage were complete.
 * @param model - Bounded vision-model identifier.
 * @returns Normalized semantic result and complete reconciliation audit trail.
 */
export async function synthesizeFinalReview(
    options: CandidateVisualVerifierOptions,
    baseMessages: SingleShotMessage[],
    beforeInventory: CandidateVisualTileInventory,
    afterInventory: CandidateVisualTileInventory,
    allowedBeforeArtifactIds: ReadonlySet<string>,
    allowedAfterArtifactIds: ReadonlySet<string>,
    runnerCoverageComplete: boolean,
    model: string,
): Promise<NormalizedCandidateVisualOutput> {
    let messages = baseMessages;
    let lastValidationError = 'unknown final synthesis validation failure';
    let dismissalAuditPerformed = false;
    for (let attempt = 1; attempt <= MAX_FINAL_SYNTHESIS_ATTEMPTS; attempt += 1) {
        let untrustedOutput: CandidateVisualFinalModelOutput;
        const result = await options.vision.structured({
            messages,
            schema: CandidateVisualFinalModelOutputSchema,
            maxAttempts: 1,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        // One schema-validation attempt per outer attempt: the loop owns bounded repair and the
        // dismissal audit, so the client must not burn its own repair budget here.
        if (result.kind === SingleShotResultKind.ProviderFailure) {
            throw new Error(result.message);
        }
        if (result.kind === SingleShotResultKind.InvalidResult) {
            lastValidationError = result.detail;
            recordFinalSynthesisAttempt(
                options,
                model,
                attempt,
                FinalSynthesisAttemptStatus.ValidationFailed,
                {
                    validationError: lastValidationError,
                },
            );
            if (attempt === MAX_FINAL_SYNTHESIS_ATTEMPTS) {
                break;
            }
            options.recorder.record(TraceEventType.Retry, {
                phase: 'candidate_visual_review_synthesis',
                attempt,
                nextAttempt: attempt + 1,
                validationArtifactId: options.validationArtifactId,
                validationError: lastValidationError,
                beforeObservationCount: beforeInventory.instances.length,
                afterObservationCount: afterInventory.instances.length,
            });
            messages = [
                ...messages,
                buildFinalSynthesisRepairMessage(
                    lastValidationError,
                    beforeInventory.instances.length,
                    afterInventory.instances.length,
                ),
            ];
            continue;
        }
        untrustedOutput = result.value;

        try {
            const normalized = normalizeModelOutput(
                untrustedOutput,
                beforeInventory,
                afterInventory,
                allowedBeforeArtifactIds,
                allowedAfterArtifactIds,
                runnerCoverageComplete,
            );
            const dismissedAfterObservationIndices = untrustedOutput.afterInventoryReconciliation
                .filter((item) => item.disposition === CandidateInstanceDisposition.NotSameSymptom)
                .map((item) => item.observationIndex);
            if (!dismissalAuditPerformed && dismissedAfterObservationIndices.length > 0) {
                recordFinalSynthesisAttempt(
                    options,
                    model,
                    attempt,
                    FinalSynthesisAttemptStatus.Validated,
                    {
                        symptom: normalized.semanticOutput.symptom,
                        coverageComplete: normalized.semanticOutput.coverageComplete,
                        pageIntegrity: normalized.semanticOutput.pageIntegrity,
                        dismissalAuditRequired: true,
                        dismissedAfterObservationIndices,
                    },
                );
                lastValidationError =
                    'Final vision proposed AFTER dismissals without completing the required ' +
                    'semantic self-critique.';
                if (attempt === MAX_FINAL_SYNTHESIS_ATTEMPTS) {
                    break;
                }
                options.recorder.record(TraceEventType.Retry, {
                    phase: 'candidate_visual_review_dismissal_audit',
                    attempt,
                    nextAttempt: attempt + 1,
                    validationArtifactId: options.validationArtifactId,
                    dismissedAfterObservationIndices,
                });
                messages = [
                    ...messages,
                    buildAfterDismissalAuditMessage(dismissedAfterObservationIndices),
                ];
                dismissalAuditPerformed = true;
                continue;
            }
            recordFinalSynthesisAttempt(
                options,
                model,
                attempt,
                FinalSynthesisAttemptStatus.Validated,
                {
                    symptom: normalized.semanticOutput.symptom,
                    coverageComplete: normalized.semanticOutput.coverageComplete,
                    pageIntegrity: normalized.semanticOutput.pageIntegrity,
                },
            );
            return normalized;
        } catch (error) {
            lastValidationError = finalValidationDetail(error);
            recordFinalSynthesisAttempt(
                options,
                model,
                attempt,
                FinalSynthesisAttemptStatus.ValidationFailed,
                {
                    validationError: lastValidationError,
                },
            );
            if (attempt === MAX_FINAL_SYNTHESIS_ATTEMPTS) {
                break;
            }
            options.recorder.record(TraceEventType.Retry, {
                phase: 'candidate_visual_review_synthesis',
                attempt,
                nextAttempt: attempt + 1,
                validationArtifactId: options.validationArtifactId,
                validationError: lastValidationError,
                beforeObservationCount: beforeInventory.instances.length,
                afterObservationCount: afterInventory.instances.length,
            });
            messages = [
                ...messages,
                buildFinalSynthesisRepairMessage(
                    lastValidationError,
                    beforeInventory.instances.length,
                    afterInventory.instances.length,
                ),
            ];
        }
    }
    throw new Error(
        `Final vision synthesis failed after ${MAX_FINAL_SYNTHESIS_ATTEMPTS} attempts: ` +
            lastValidationError,
    );
}

/**
 * Convert any model or screenshot failure into a bounded inconclusive observation.
 *
 * @param error - Failure raised while preparing or executing the visual review.
 * @returns Typed fail-closed semantic output suitable for persistence.
 */
export function inconclusiveModelOutput(error: unknown): CandidateVisualReviewModelOutput {
    const detail = error instanceof Error ? error.message : String(error);
    return {
        symptom: 'unclear',
        symptomScope: 'The reported symptom scope could not be reviewed.',
        adLayoutResidue: CandidateVisualAdLayoutResidue.Unclear,
        coverageComplete: false,
        beforeInstances: [],
        remainingInstances: [],
        pageIntegrity: CandidateVisualPageIntegrity.Unclear,
        rationale: `Visual review unavailable: ${detail}`.slice(0, MAX_RATIONALE_CHARS),
        observedDamage: [],
    };
}
