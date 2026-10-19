import * as v from 'valibot';

/**
 * How one page state's full-page overview took part in a candidate visual review, and the
 * runner-owned record of it. The overview is context: the browser cannot capture one of a very tall
 * document, and one no vision request can carry or read is withheld; the original-resolution tiles
 * carry the coverage proof either way. `planFullPageOverview` decides the mode.
 */

/**
 * Non-empty artifact identifier emitted by the trusted runner.
 */
export const ArtifactIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(256));

/**
 * How one page state's full-page overview took part in the candidate review.
 */
export const FullPageOverviewMode = {
    /**
     * Sent to vision as captured.
     */
    Original: 'original',

    /**
     * Too large for a vision request; complete document tiles stand in for it.
     */
    OmittedCompleteTiles: 'omitted_complete_tiles',

    /**
     * Withheld because the document is far taller than it is wide. Unlike the oversized modes it
     * needs no tile-coverage proof and never blocks the review: an image the model cannot read
     * protects nothing. See `planFullPageOverview`.
     */
    OmittedIllegible: 'omitted_illegible',

    /**
     * Too large for a vision request, and no complete document tiles stand in for it.
     */
    BlockedOversizedIncompleteTiles: 'blocked_oversized_incomplete_tiles',

    /**
     * The browser captured no overview, and one would have been withheld as illegible anyway: the
     * same terms as `OmittedIllegible`. The browser refuses a full-page capture of a very tall
     * document, so this is the usual way a capture ends without one.
     */
    UnavailableIllegible: 'unavailable_illegible',

    /**
     * The browser captured no overview; complete document tiles stand in for it.
     */
    UnavailableCompleteTiles: 'unavailable_complete_tiles',

    /**
     * The browser captured no overview, and no complete document tiles stand in for it.
     */
    BlockedUnavailableIncompleteTiles: 'blocked_unavailable_incomplete_tiles',
} as const;

/**
 * FullPageOverviewMode value.
 */
export type FullPageOverviewMode = (typeof FullPageOverviewMode)[keyof typeof FullPageOverviewMode];

/**
 * Overview modes recorded for a page state the browser captured no overview of.
 */
const UNAVAILABLE_OVERVIEW_MODES: readonly FullPageOverviewMode[] = [
    FullPageOverviewMode.UnavailableIllegible,
    FullPageOverviewMode.UnavailableCompleteTiles,
    FullPageOverviewMode.BlockedUnavailableIncompleteTiles,
];

/**
 * Runner-owned provenance for the full-page image used or safely omitted for vision.
 */
export const CandidateVisualFullPageOverviewEvidenceSchema = v.pipe(
    v.strictObject({
        mode: v.picklist(Object.values(FullPageOverviewMode)),
        // Null exactly when the browser captured no overview of this state.
        originalArtifactId: v.nullable(ArtifactIdSchema),
        originalBytes: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
        visionArtifactId: v.nullable(ArtifactIdSchema),
        visionBytes: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
        reason: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))),
    }),
    v.check((evidence) => {
        const captured = evidence.originalArtifactId !== null && evidence.originalBytes !== null;
        if (UNAVAILABLE_OVERVIEW_MODES.includes(evidence.mode) === captured) {
            return false;
        }
        if (evidence.mode === FullPageOverviewMode.Original) {
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
 * Runner-owned provenance for one full-page overview supplied to or omitted from vision.
 */
export type CandidateVisualFullPageOverviewEvidence = v.InferOutput<
    typeof CandidateVisualFullPageOverviewEvidenceSchema
>;
