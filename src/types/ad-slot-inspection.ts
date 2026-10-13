import * as v from 'valibot';

const BoundedCountSchema = v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(Number.MAX_SAFE_INTEGER),
);
const BoundedStringSchema = v.pipe(v.string(), v.maxLength(128));

/**
 * Determine whether a page identifier excludes C0, DEL, and C1 control characters.
 *
 * @param value - Bounded page identifier to validate.
 * @returns True when every UTF-16 code unit is outside the control ranges.
 */
function excludesControlCharacters(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
            return false;
        }
    }
    return true;
}

const BoundedIdentifierSchema = v.pipe(
    BoundedStringSchema,
    v.check(excludesControlCharacters, 'Page identifiers must not contain control characters.'),
);

export const AdSlotViewportRectSchema = v.object({
    /**
     * Horizontal viewport coordinate of the element's border box.
     */
    x: v.number(),

    /**
     * Vertical viewport coordinate of the element's border box.
     */
    y: v.number(),

    /**
     * Top viewport edge of the element's border box.
     */
    top: v.number(),

    /**
     * Right viewport edge of the element's border box.
     */
    right: v.number(),

    /**
     * Bottom viewport edge of the element's border box.
     */
    bottom: v.number(),

    /**
     * Left viewport edge of the element's border box.
     */
    left: v.number(),

    /**
     * Non-negative border-box width in CSS pixels.
     */
    width: v.pipe(v.number(), v.minValue(0)),

    /**
     * Non-negative border-box height in CSS pixels.
     */
    height: v.pipe(v.number(), v.minValue(0)),
});

export const AdSlotComputedStyleSchema = v.object({
    /**
     * Computed display value.
     */
    display: BoundedStringSchema,

    /**
     * Computed visibility value.
     */
    visibility: BoundedStringSchema,

    /**
     * Computed opacity value.
     */
    opacity: BoundedStringSchema,

    /**
     * Computed positioning mode.
     */
    position: BoundedStringSchema,

    /**
     * Computed height value.
     */
    height: BoundedStringSchema,

    /**
     * Computed minimum-height value.
     */
    minHeight: BoundedStringSchema,

    /**
     * Computed maximum-height value.
     */
    maxHeight: BoundedStringSchema,
});

export const AdSlotVisibilityStateSchema = v.picklist([
    'visible',
    'hidden',
    'offscreen',
    'zero_area',
]);

export const AdSlotVisibilitySchema = v.object({
    /**
     * Deterministic rendered-visibility classification.
     */
    state: AdSlotVisibilityStateSchema,

    /**
     * Whether the measured box currently reserves document layout space.
     */
    occupiesLayoutSpace: v.boolean(),

    /**
     * Whether the positive-area box intersects the current viewport.
     */
    intersectsViewport: v.boolean(),

    /**
     * Whether the element or one of its light-DOM ancestors is style-hidden.
     */
    ancestorHidden: v.boolean(),
});

export const AdSlotElementSnapshotSchema = v.object({
    /**
     * Lowercase HTML tag name.
     */
    tag: v.pipe(v.string(), v.minLength(1), v.maxLength(32)),

    /**
     * Bounded element ID, or null when none is present.
     */
    id: v.nullable(BoundedIdentifierSchema),

    /**
     * At most sixteen bounded class tokens.
     */
    classes: v.pipe(v.array(BoundedIdentifierSchema), v.maxLength(16)),

    /**
     * Border-box geometry relative to the current viewport.
     */
    viewportRect: AdSlotViewportRectSchema,

    /**
     * Bounded computed styles relevant to layout and visibility.
     */
    computedStyle: AdSlotComputedStyleSchema,

    /**
     * Deterministic visibility and layout-space facts.
     */
    visibility: AdSlotVisibilitySchema,
});

export const AdSlotMatchedSignalSchema = v.picklist([
    'id-ad-token',
    'class-ad-token',
    'ad-attribute-name',
    'ad-role',
    'ad-frame-url',
    'ad-tag',
]);

export const AdSlotCreativeSignalSchema = v.picklist([
    'self-iframe',
    'self-image',
    'self-video',
    'self-canvas',
    'self-object',
    'descendant-iframe',
    'descendant-image',
    'descendant-video',
    'descendant-canvas',
    'descendant-object',
    'css-background-image',
]);

export const AdSlotContentStateSchema = v.picklist(['empty', 'creative', 'unknown']);

export const AdSlotRecordSchema = v.object({
    /**
     * Snapshot of the candidate element itself.
     */
    element: AdSlotElementSnapshotSchema,

    /**
     * Parent-first snapshots of the full available light-DOM ancestor chain.
     */
    ancestors: v.pipe(v.array(AdSlotElementSnapshotSchema), v.maxLength(32)),

    /**
     * Whether more than thirty-two ancestors existed and were omitted.
     */
    ancestorChainTruncated: v.boolean(),

    /**
     * Fixed, non-page-controlled signals that made the element a candidate.
     */
    matchedSignals: v.pipe(v.array(AdSlotMatchedSignalSchema), v.maxLength(6)),

    /**
     * Bounded deterministic classification of the slot contents.
     */
    contentState: AdSlotContentStateSchema,

    /**
     * Fixed evidence categories supporting a creative classification.
     */
    creativeSignals: v.pipe(v.array(AdSlotCreativeSignalSchema), v.maxLength(11)),

    /**
     * Whitespace-normalized text length without exposing text content.
     */
    meaningfulTextLength: BoundedCountSchema,

    /**
     * Number of light-DOM descendants observed for the candidate.
     */
    descendantCount: BoundedCountSchema,

    /**
     * Whether the candidate had more than 128 descendants and content is therefore unknown.
     */
    contentScanTruncated: v.boolean(),
});

export const AdSlotScanResultSchema = v.pipe(
    v.object({
        /**
         * Explicit scope excluding subframes and shadow DOM.
         */
        scope: v.literal('main_frame_light_dom'),

        /**
         * Total signal-matched elements found across all main-frame light-DOM tags.
         */
        candidateCount: BoundedCountSchema,

        /**
         * Number of prioritized records returned to the caller.
         */
        returnedCount: v.pipe(BoundedCountSchema, v.maxValue(32)),

        /**
         * Whether candidate inspection or record return limits omitted matches.
         */
        truncated: v.boolean(),

        /**
         * At most thirty-two prioritized ad-slot records.
         */
        slots: v.pipe(v.array(AdSlotRecordSchema), v.maxLength(32)),
    }),
    v.check(
        (result) =>
            result.returnedCount === result.slots.length &&
            result.returnedCount <= result.candidateCount &&
            result.truncated === result.candidateCount > result.returnedCount,
        'Ad-slot counts and truncation state are inconsistent.',
    ),
);

export const AdSlotInspectionResultSchema = v.pipe(
    v.object({
        /**
         * Explicit scope excluding subframes and shadow DOM.
         */
        scope: v.literal('main_frame_light_dom'),

        /**
         * Total signal-matched elements found across all main-frame light-DOM tags.
         */
        candidateCount: BoundedCountSchema,

        /**
         * Number of prioritized records returned to the caller.
         */
        returnedCount: v.pipe(BoundedCountSchema, v.maxValue(32)),

        /**
         * Whether candidate inspection or record return limits omitted matches.
         */
        truncated: v.boolean(),

        /**
         * At most thirty-two prioritized ad-slot records.
         */
        slots: v.pipe(v.array(AdSlotRecordSchema), v.maxLength(32)),

        /**
         * Opaque identifier of the persisted validated JSON artifact.
         */
        artifactId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    }),
    v.check(
        (result) =>
            result.returnedCount === result.slots.length &&
            result.returnedCount <= result.candidateCount &&
            result.truncated === result.candidateCount > result.returnedCount,
        'Ad-slot counts and truncation state are inconsistent.',
    ),
);

/**
 * Deterministic scan result before artifact persistence.
 */
export type AdSlotScanResult = v.InferOutput<typeof AdSlotScanResultSchema>;
