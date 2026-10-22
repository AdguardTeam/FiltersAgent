/**
 * Whether the tiles of a candidate visual review cover what the review answers for: a runner
 * decision from the tile proofs, never from what the model makes of them.
 */
import { CandidateVisualCoverageGap } from '../types/candidate-visual-coverage-gap';
import type { CandidateVisualEvidence } from './candidate-visual-evidence';

/**
 * Find what keeps the tiles of both page states from covering what the review answers for.
 *
 * The review answers for the window its tiles cover: the neighborhood of every element the
 * candidate's selector matched, or the first screens of the page when no match could be measured,
 * which a capture takes as the page. Breakage below the window goes unseen. Tiles over the whole
 * document always cover it. A window does when its own tiles are complete and the capture did not
 * cut it short at the tile limit. A trim is read on either state: the after capture replays the
 * span the before capture kept and records no trim of its own.
 *
 * @param evidence - Runner-resolved tiles and their coverage proofs.
 * @returns Why the tile coverage is refused, or undefined when it is complete.
 */
export function tileCoverageGap(
    evidence: CandidateVisualEvidence,
): CandidateVisualCoverageGap | undefined {
    const states = [
        {
            window: evidence.beforeCoverageComplete,
            document: evidence.beforeDocumentCoverageComplete,
            trimmed: evidence.beforeWindowTrimmed,
        },
        {
            window: evidence.afterCoverageComplete,
            document: evidence.afterDocumentCoverageComplete,
            trimmed: evidence.afterWindowTrimmed,
        },
    ];
    const windowed = states.filter((state) => !state.document);
    if (windowed.length === 0) {
        return undefined;
    }
    if (windowed.some((state) => !state.window)) {
        return CandidateVisualCoverageGap.TilesIncomplete;
    }
    return states.some((state) => state.trimmed)
        ? CandidateVisualCoverageGap.WindowTrimmed
        : undefined;
}
