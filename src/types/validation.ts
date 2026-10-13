import * as v from 'valibot';

/**
 * Labels for the three validation phases.
 */
/**
 * Which side of a candidate experiment a capture or measurement belongs to.
 */
export const CaptureState = {
    Before: 'before',
    After: 'after',
} as const;

/**
 * Capture state value.
 */
export type CaptureState = (typeof CaptureState)[keyof typeof CaptureState];

/**
 * Validation phase labels: A = clean baseline, B = repository filters, C = filters plus candidate.
 */
export const PhaseLabel = {
    A: 'A',
    B: 'B',
    C: 'C',
} as const;

/**
 * Every phase label value, for schemas and exhaustive listings.
 */
export const PHASE_LABEL_VALUES = Object.values(PhaseLabel);

export const PhaseLabelSchema = v.picklist(PHASE_LABEL_VALUES);

/**
 * Possible outcomes of the ad-element DOM probe in a single phase.
 */
export const AdElementPresence = {
    /**
     * The probe found no element matching the target selector.
     */
    NotFound: 'not_found',

    /**
     * The matched element is present and rendered visibly.
     */
    Visible: 'visible',

    /**
     * The matched element is present but not visibly rendered.
     */
    Hidden: 'hidden',

    /**
     * The probe was not run for this phase.
     */
    NotProbed: 'not_probed',
} as const;

/**
 * Every ad element presence value, for schemas and exhaustive listings.
 */
export const AD_ELEMENT_PRESENCE_VALUES = Object.values(AdElementPresence);

/**
 * Ad element presence value.
 */
export type AdElementPresence = (typeof AdElementPresence)[keyof typeof AdElementPresence];

export const AdElementPresenceSchema = v.picklist(AD_ELEMENT_PRESENCE_VALUES);

/**
 * Measured browser geometry for one target element.
 */
export const ElementGeometrySchema = v.object({
    found: v.boolean(),
    width: v.pipe(v.number(), v.minValue(0)),
    height: v.pipe(v.number(), v.minValue(0)),
});

/**
 * Deterministic browser scroll position used to align a same-document screenshot pair.
 */
export const ValidationViewportPositionSchema = v.object({
    x: v.pipe(v.number(), v.minValue(0)),
    y: v.pipe(v.number(), v.minValue(0)),
});

/**
 * One original-resolution screenshot tile covering a bounded document rectangle.
 */
export const FullPageTileSchema = v.object({
    artifactId: v.pipe(v.string(), v.minLength(1)),
    index: v.pipe(v.number(), v.integer(), v.minValue(0)),
    x: v.pipe(v.number(), v.minValue(0)),
    y: v.pipe(v.number(), v.minValue(0)),
    width: v.pipe(v.number(), v.minValue(1)),
    height: v.pipe(v.number(), v.minValue(1)),
    landmark: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
});

/**
 * Document-space vertical span a bounded tile capture was restricted to.
 *
 * Absent means the capture planned the whole document; present scopes every completeness claim to
 * the recorded region (the candidate symptom neighborhood), never to the whole page.
 */
export const FullPageTileWindowSchema = v.strictObject({
    fromY: v.pipe(v.number(), v.minValue(0)),
    toY: v.pipe(v.number(), v.minValue(0)),
});

/**
 * Document-space vertical span a bounded tile capture was restricted to.
 */
export type FullPageTileWindow = v.InferOutput<typeof FullPageTileWindowSchema>;

/**
 * Mechanical proof describing how original-resolution tiles cover one page state.
 */
export const FullPageTileCoverageSchema = v.object({
    complete: v.boolean(),
    documentWidth: v.pipe(v.number(), v.minValue(0)),
    documentHeight: v.pipe(v.number(), v.minValue(0)),
    viewportWidth: v.pipe(v.number(), v.minValue(0)),
    viewportHeight: v.pipe(v.number(), v.minValue(0)),
    overlapPx: v.pipe(v.number(), v.integer(), v.minValue(0)),
    tiles: v.array(FullPageTileSchema),
    window: v.optional(v.nullable(FullPageTileWindowSchema)),
    // True only when no explicit tileWindow was supplied and the default first-N-screens cap
    // was applied. Optional so artifacts recorded before this field existed still parse.
    windowDefaulted: v.optional(v.boolean()),
    error: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(500))),
});

/**
 * One runner-owned fact accounting for a rule supplied to a validation phase.
 */
export const RuleApplicationFactSchema = v.variant('status', [
    v.object({
        rule: v.string(),
        status: v.literal('applied'),
    }),
    v.object({
        rule: v.string(),
        status: v.literal('skipped'),
        reason: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
    }),
]);

/**
 * Schema for a single phase result within a validation run.
 */
export const PhaseResultSchema = v.object({
    phase: PhaseLabelSchema,
    screenshotArtifactId: v.string(),
    fullPageScreenshotArtifactId: v.optional(v.string()),
    tileCoverage: v.optional(FullPageTileCoverageSchema),
    sameDocumentControlScreenshotArtifactId: v.optional(v.string()),
    sameDocumentControlFullPageScreenshotArtifactId: v.optional(v.string()),
    sameDocumentControlTileCoverage: v.optional(FullPageTileCoverageSchema),
    sameDocumentControlViewport: v.optional(ValidationViewportPositionSchema),
    candidateViewport: v.optional(ValidationViewportPositionSchema),
    sameDocumentControlError: v.optional(v.string()),
    harArtifactId: v.string(),
    domArtifactId: v.string(),
    url: v.string(),
    appliedRules: v.array(v.string()),
    ruleApplications: v.optional(v.array(RuleApplicationFactSchema)),
    antiAdblockDetected: v.boolean(),
    error: v.optional(v.string()),
});

/**
 * Result of probing the ad element's visibility across phases B and C.
 *
 * Computed by the orchestrator's DOM probe and exposed as a raw observation. It does not authorize
 * or reject a candidate rule.
 */
export const AdElementStatusSchema = v.object({
    selector: v.string(),
    phaseB: AdElementPresenceSchema,
    phaseC: AdElementPresenceSchema,
});

/**
 * Bounded evidence that a meaningful element is materially covered in the viewport.
 */
export const OcclusionEvidenceSchema = v.object({
    targetKey: v.pipe(v.string(), v.minLength(1)),
    blockerKeys: v.array(v.pipe(v.string(), v.minLength(1))),
    occludedSampleCount: v.pipe(v.number(), v.integer(), v.minValue(1)),
    sampleCount: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

/**
 * Aggregate rendered geometry for one category of meaningful page content.
 */
export const MeaningfulGeometrySchema = v.object({
    totalCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
    visibleCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
    visibleArea: v.pipe(v.number(), v.minValue(0)),
    clippedCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
    occludedCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
    elementKeys: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
    occlusionEvidence: v.optional(v.array(OcclusionEvidenceSchema)),
});

/**
 * Stable per-element geometry used to bind layout comparisons across candidate toggles.
 */
export const StructuralTargetMeasurementSchema = v.object({
    key: v.pipe(v.string(), v.minLength(1)),
    width: v.pipe(v.number(), v.minValue(0)),
    height: v.pipe(v.number(), v.minValue(0)),
});

/**
 * Raw browser measurements describing selector scope and rendered page structure.
 */
export const StructuralSnapshotSchema = v.object({
    probeSucceeded: v.boolean(),
    targetCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
    targetVisibleCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
    targetTotalHeight: v.pipe(v.number(), v.minValue(0)),
    targetTotalArea: v.pipe(v.number(), v.minValue(0)),
    targetMaximumHeight: v.optional(v.pipe(v.number(), v.minValue(0))),
    targetFamilyClass: v.optional(v.nullable(v.string())),
    familyProbeTruncated: v.optional(v.boolean()),
    familyTargetCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    familyTargetVisibleCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    familyTargetTotalHeight: v.optional(v.pipe(v.number(), v.minValue(0))),
    familyTargetMaximumHeight: v.optional(v.pipe(v.number(), v.minValue(0))),
    targetMeasurements: v.optional(v.array(StructuralTargetMeasurementSchema)),
    familyTargetMeasurements: v.optional(v.array(StructuralTargetMeasurementSchema)),
    documentTimeOrigin: v.optional(v.pipe(v.number(), v.minValue(0))),
    documentHeight: v.pipe(v.number(), v.minValue(0)),
    fixedTopOverlayBottom: v.pipe(v.number(), v.minValue(0)),
    visibleHeadingCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
    visibleBreadcrumbCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
    overlappedHeadingCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
    overlappedBreadcrumbCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
    minimumOverlappedLandmarkTop: v.nullable(v.number()),
    meaningfulTextLength: v.pipe(v.number(), v.integer(), v.minValue(0)),
    textGeometry: MeaningfulGeometrySchema,
    mediaGeometry: MeaningfulGeometrySchema,
    controlGeometry: MeaningfulGeometrySchema,
});

/**
 * Raw same-document structure snapshots collected before and after a candidate.
 */
export const CandidateStructureFactsSchema = v.object({
    before: StructuralSnapshotSchema,
    after: StructuralSnapshotSchema,
    afterArtifacts: v.optional(StructuralSnapshotSchema),
    restoredControl: v.optional(StructuralSnapshotSchema),
});

/**
 * Raw target geometry collected before and after a candidate CSS rule.
 */
export const CandidateLayoutFactsSchema = v.object({
    selector: v.string(),
    before: ElementGeometrySchema,
    after: ElementGeometrySchema,
});

/**
 * Public evidence that browser validation used runner-bound issue and repository inputs.
 */
export const TrustedValidationEvidenceSchema = v.object({
    reportedUrl: v.pipe(v.string(), v.url()),
    baselineHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    existingRuleCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

/**
 * Schema for the factual three-phase validation result returned by `runValidation` and the
 * `apply_rule` tool. Contains no verdict — the LLM determines the verdict after inspecting the
 * returned artifact IDs and summary.
 */
export const FactualValidationResultSchema = v.object({
    trustedValidationContext: TrustedValidationEvidenceSchema,
    phaseA: PhaseResultSchema,
    phaseB: PhaseResultSchema,
    phaseC: PhaseResultSchema,
    layoutFacts: v.optional(CandidateLayoutFactsSchema),
    validatedSelector: v.string(),
    adElementStatus: AdElementStatusSchema,
    structureFacts: v.optional(CandidateStructureFactsSchema),
    summary: v.string(),
});

export type PhaseLabel = v.InferOutput<typeof PhaseLabelSchema>;
export type PhaseResult = v.InferOutput<typeof PhaseResultSchema>;
export type ElementGeometry = v.InferOutput<typeof ElementGeometrySchema>;
export type ValidationViewportPosition = v.InferOutput<typeof ValidationViewportPositionSchema>;
export type FullPageTileCoverage = v.InferOutput<typeof FullPageTileCoverageSchema>;
export type RuleApplicationFact = v.InferOutput<typeof RuleApplicationFactSchema>;
export type StructuralSnapshot = v.InferOutput<typeof StructuralSnapshotSchema>;
export type FactualValidationResult = v.InferOutput<typeof FactualValidationResultSchema>;
