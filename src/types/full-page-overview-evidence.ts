import * as v from 'valibot';

/**
 * How one page state's full-page overview took part in a candidate visual review, and the
 * runner-owned record of it. The overview is context: the review shows it to vision only as the
 * downscaled map in front of the tiles, which no observation can cite; the browser cannot capture
 * one of a very tall document, and one no request can read is withheld. The original-resolution
 * tiles carry the coverage proof either way. `planFullPageOverview` decides the mode.
 */

/**
 * Longest artifact identifier the runner emits. It bounds how much of the synthesis context one
 * cited identifier may take, so the context limit is derived from it.
 */
export const MAX_ARTIFACT_ID_CHARS = 256;

/**
 * Non-empty artifact identifier emitted by the trusted runner.
 */
export const ArtifactIdSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(MAX_ARTIFACT_ID_CHARS),
);

/**
 * How one page state's full-page overview took part in the candidate review.
 */
export const FullPageOverviewMode = {
    /**
     * Shown as the map, and the original-resolution tiles cover the whole document.
     */
    Original: 'original',

    /**
     * Shown as the map, while the original-resolution tiles cover only a window of the document:
     * the review answers for that window, and the reason names it.
     */
    WindowedTiles: 'windowed_tiles',

    /**
     * Withheld because the document is far taller than it is wide; the map is the tile window
     * instead. It needs no tile-coverage proof and never blocks the review: an image the model
     * cannot read protects nothing. See `planFullPageOverview`.
     */
    OmittedIllegible: 'omitted_illegible',

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
 * Overview modes whose map, when one was shown, is the overview itself.
 */
const WHOLE_PAGE_MAP_MODES: readonly FullPageOverviewMode[] = [
    FullPageOverviewMode.Original,
    FullPageOverviewMode.WindowedTiles,
];

/**
 * Overview modes recorded for a page state the browser captured no overview of.
 */
const UNAVAILABLE_OVERVIEW_MODES: readonly FullPageOverviewMode[] = [
    FullPageOverviewMode.UnavailableIllegible,
    FullPageOverviewMode.UnavailableCompleteTiles,
    FullPageOverviewMode.BlockedUnavailableIncompleteTiles,
];

/**
 * Runner-owned provenance for the full-page overview of one page state and the map it was shown as.
 */
export const CandidateVisualFullPageOverviewEvidenceSchema = v.pipe(
    v.strictObject({
        mode: v.picklist(Object.values(FullPageOverviewMode)),
        // Null exactly when the browser captured no overview of this state.
        originalArtifactId: v.nullable(ArtifactIdSchema),
        originalBytes: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
        // The artifact the map was downscaled from and the map's encoded size; null when the
        // state was shown no map.
        visionArtifactId: v.nullable(ArtifactIdSchema),
        visionBytes: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
        reason: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))),
    }),
    v.check((evidence) => {
        const captured = evidence.originalArtifactId !== null && evidence.originalBytes !== null;
        if (UNAVAILABLE_OVERVIEW_MODES.includes(evidence.mode) === captured) {
            return false;
        }
        if ((evidence.visionArtifactId === null) !== (evidence.visionBytes === null)) {
            return false;
        }
        if (
            WHOLE_PAGE_MAP_MODES.includes(evidence.mode) &&
            evidence.visionArtifactId !== null &&
            evidence.visionArtifactId !== evidence.originalArtifactId
        ) {
            return false;
        }
        return (evidence.mode === FullPageOverviewMode.Original) === (evidence.reason === null);
    }, 'Full-page overview provenance must bind original and map artifacts consistently.'),
);

/**
 * Runner-owned provenance for one full-page overview and the map it was shown as.
 */
export type CandidateVisualFullPageOverviewEvidence = v.InferOutput<
    typeof CandidateVisualFullPageOverviewEvidenceSchema
>;
