import type { SingleShotClient } from '../pi/single-shot-types';
import type { CandidateNetworkVerification } from './candidate-network-verification';
import type { SymptomKind } from './symptom-rubric';
import type { TraceRecorder } from '../tracer/trace-recorder';
import type { DomCheckRecord } from '../types/dom-check';

/**
 * The candidate visual review's input vocabulary: the runner-resolved screenshots one review reads,
 * the before/after evidence bundle they compose into, and the trusted options a review is invoked
 * with. Both stages of the review construct against exactly these — `candidate-visual-verifier`
 * runs the review, `candidate-visual-inventory` reads the same images — so the vocabulary lives in
 * its own leaf and neither stage has to import the other for a type.
 */

/**
 * One runner-resolved screenshot used as visual evidence.
 */
export interface CandidateVisualEvidenceImage {
    /**
     * Runner-owned artifact identifier for the screenshot.
     */
    id: string;

    /**
     * Local filesystem path containing the screenshot bytes.
     */
    path: string;
}

/**
 * One original-resolution full-page tile supplied to the semantic candidate review.
 */
export interface CandidateVisualEvidenceTile extends CandidateVisualEvidenceImage {
    /**
     * Stable zero-based tile position in document order.
     */
    index: number;

    /**
     * Horizontal document coordinate at which this tile begins.
     */
    x: number;

    /**
     * Vertical document coordinate at which this tile begins.
     */
    y: number;

    /**
     * Tile height in CSS pixels before device-scale rendering.
     */
    height: number;

    /**
     * Tile width in CSS pixels before device-scale rendering.
     */
    width: number;

    /**
     * Bounded runner-collected page landmark describing this tile.
     */
    landmark: string;
}

/**
 * Screenshot of the top of the document span the tiles cover, taken for a page too tall for its
 * full-page overview to be read as one image.
 */
export interface CandidateVisualTileWindowMap extends CandidateVisualEvidenceImage {
    /**
     * Vertical document coordinate at which the map begins.
     */
    y: number;

    /**
     * Map height in CSS pixels.
     */
    height: number;
}

/**
 * Pixel extent of the document one page state's full-page overview spans.
 */
export interface CandidateVisualDocumentSize {
    /**
     * Document width in CSS pixels before device-scale rendering.
     */
    width: number;

    /**
     * Document height in CSS pixels before device-scale rendering.
     */
    height: number;
}

/**
 * Aligned screenshots supplied to the semantic candidate review: both viewports and the full-page
 * overviews the browser captured, with the original-resolution tiles.
 */
export interface CandidateVisualEvidence {
    /**
     * Target viewport before the candidate rule was applied.
     */
    beforeViewport: CandidateVisualEvidenceImage;

    /**
     * Target viewport after the candidate rule was applied.
     */
    afterViewport: CandidateVisualEvidenceImage;

    /**
     * Full page before the candidate rule was applied, absent when the browser captured none.
     */
    beforeFullPage?: CandidateVisualEvidenceImage;

    /**
     * Full page after the candidate rule was applied, absent when the browser captured none.
     */
    afterFullPage?: CandidateVisualEvidenceImage;

    /**
     * Overlapping original-resolution tiles covering the before document.
     */
    beforeTiles: CandidateVisualEvidenceTile[];

    /**
     * Overlapping original-resolution tiles covering the after document.
     */
    afterTiles: CandidateVisualEvidenceTile[];

    /**
     * Whether the runner proved that before tiles cover the proven capture scope.
     *
     * A window-bounded capture proves the localized symptom neighborhood, and the review answers
     * for that window alone: the full-page overview is only its map.
     */
    beforeCoverageComplete: boolean;

    /**
     * Whether the runner proved that after tiles cover the proven capture scope.
     */
    afterCoverageComplete: boolean;

    /**
     * Whether the runner proved that before tiles cover the complete document.
     *
     * Short of it, the review records the inspected window as the reason of its overview plan.
     */
    beforeDocumentCoverageComplete: boolean;

    /**
     * Whether the runner proved that after tiles cover the complete document.
     */
    afterDocumentCoverageComplete: boolean;

    /**
     * Whether the before capture kept only the first rows of its window that fit the tile limit.
     *
     * The after capture replays the span the before capture kept, so only this flag tells that the
     * window the review answers for is shorter than the one measured around the target.
     */
    beforeWindowTrimmed: boolean;

    /**
     * Whether the after capture kept only the first rows of its window that fit the tile limit.
     */
    afterWindowTrimmed: boolean;

    /**
     * Document extent the before full-page overview spans, when the capture measured it.
     *
     * A page far taller than it is wide cannot be read as one image, so the extent decides whether
     * the overview or the tile window map is the page state's map.
     */
    beforeDocument?: CandidateVisualDocumentSize;

    /**
     * Document extent the after full-page overview spans, when the capture measured it.
     */
    afterDocument?: CandidateVisualDocumentSize;

    /**
     * Map of the before tile window, present only when the document is too tall for its overview to
     * be read as one image.
     */
    beforeTileWindowMap?: CandidateVisualTileWindowMap;

    /**
     * Map of the after tile window, present only when the document is too tall for its overview to
     * be read as one image.
     */
    afterTileWindowMap?: CandidateVisualTileWindowMap;
}

/**
 * Trusted inputs and dependencies for one final candidate visual review.
 */
export interface CandidateVisualVerifierOptions {
    /**
     * Exact candidate rule whose semantic outcome is being reviewed.
     */
    candidateRule: string;

    /**
     * Runner-owned factual-validation artifact identifier associated with the candidate.
     */
    validationArtifactId: string;

    /**
     * Optional host-derived suffix that makes physical retry artifacts unique.
     */
    artifactIdentitySuffix?: string;

    /**
     * Runner-resolved viewport and full-page before/after evidence.
     */
    evidence: CandidateVisualEvidence;

    /**
     * Optional bounded description of the exact reporter-defined symptom.
     */
    reporterSymptom?: string;

    /**
     * Problem class driving the review rubric; ads semantics when omitted.
     */
    symptomKind?: SymptomKind;

    /**
     * Optional bounded browser facts supplied as context rather than a deterministic verdict.
     */
    browserFacts?: string;

    /**
     * DOM checks the agent attached to apply_rule, with what each returned on the baseline and the
     * candidate page loads these images come from. Untrusted page data the residue rubric weighs.
     */
    domChecks?: readonly DomCheckRecord[];

    /**
     * Trusted reported page URL the experiment navigated to, never model input.
     *
     * The review classifies the candidate against it to decide whether a network block reaches a
     * host outside the reported site. A caller that supplies none leaves the candidate
     * unclassified, which is the fail-closed direction: the review then keeps the contract that
     * demands a visibly intact page.
     */
    reportedPageUrl?: string;

    /**
     * The runner's network verification of the candidate, when it is a third-party host block the
     * phase network logs can judge. It decides the symptom half of the verdict when vision finds
     * nothing to judge, and is stored on the review either way.
     */
    networkVerification?: CandidateNetworkVerification;

    /**
     * Per-run directory where the trusted review JSON is persisted.
     */
    artifactsDir: string;

    /**
     * Single-shot client used for the structured semantic review.
     */
    vision: SingleShotClient;

    /**
     * Trace recorder that owns the resulting review artifact.
     */
    recorder: TraceRecorder;

    /**
     * Cooperative cancellation from the apply_rule tool deadline that bounds the experiment this
     * review runs inside. It reaches every vision request the review makes — the per-state
     * inventories and the final synthesis — so an expired deadline cancels the in-flight completion
     * instead of leaving the tool awaiting a verdict nothing will read. A cancelled request
     * surfaces as a provider failure, which this review already fails closed on.
     */
    signal?: AbortSignal;

    /**
     * How many of this operation's independent vision completions run at once; the shared default
     * when absent. One keeps them strictly in order, which a scripted provider needs.
     */
    visionConcurrency?: number;
}
