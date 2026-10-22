/**
 * Why the runner refused the coverage of a candidate visual review.
 */
export const CandidateVisualCoverageGap = {
    /**
     * The tiles of a page state do not cover their window, or the document when there is none.
     */
    TilesIncomplete: 'tiles_incomplete',

    /**
     * The capture kept only the first rows of the window that fit the tile limit.
     */
    WindowTrimmed: 'window_trimmed',

    /**
     * A vision inventory call did not read every image it was sent.
     */
    ImagesUnread: 'images_unread',

    /**
     * The runner dropped an AFTER observation cited on an image its request did not carry, which
     * may be the ad the candidate left.
     */
    CitationDropped: 'citation_dropped',
} as const;

/**
 * CandidateVisualCoverageGap value.
 */
export type CandidateVisualCoverageGap =
    (typeof CandidateVisualCoverageGap)[keyof typeof CandidateVisualCoverageGap];

/**
 * Every coverage gap, for the review schema.
 */
export const CANDIDATE_VISUAL_COVERAGE_GAP_VALUES = Object.values(CandidateVisualCoverageGap);
