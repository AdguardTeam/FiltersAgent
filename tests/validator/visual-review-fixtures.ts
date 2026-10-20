/**
 * The page content the settlement suites build their stub scripts from: the advertising slot the
 * BEFORE page shows, what the AFTER inventory reports, and a DOM check of the grid around the
 * slot.
 */
import { DomCheckMeasurementStatus, type DomCheckRecord } from '../../src/types/dom-check';
import type { StubDamage, StubInstance } from './visual-review-stub';

/**
 * The advertising slot the BEFORE page shows and the candidate removes.
 */
export const BEFORE_SLOT: StubInstance = {
    artifactId: 'before-tile-1',
    landmark: 'Below the masthead',
    description: 'An empty reserved advertising slot spanning the content width.',
    footprint: 'blank_space',
};

/**
 * The site's own footer graphic, which the AFTER inventory reads as a broken image.
 */
export const FOOTER_GRAPHIC: StubDamage = {
    artifactId: 'after-tile-2',
    description: 'Footer, right column: a black error graphic with a cartoon character.',
};

/**
 * An ordinary gap between two sections of the AFTER page.
 */
export const SECTION_GAP: StubInstance = {
    artifactId: 'after-tile-2',
    landmark: 'Between the news grid and the video section',
    description: 'A blank band between the two sections, consistent with a reserved ad slot.',
    footprint: 'blank_space',
};

/**
 * Blank space at the removed slot's own place, below the masthead.
 */
export const SLOT_GAP: StubInstance = {
    artifactId: 'after-tile-1',
    landmark: 'Below the masthead',
    description: 'A blank band below the masthead where the advertising slot was.',
    footprint: 'blank_space',
};

/**
 * A DOM check naming the grid that holds the space below the masthead.
 *
 * @param after - What the check returned on the candidate page.
 * @returns The check record.
 */
export function gridCheck(
    after: DomCheckRecord['after'] = {
        status: DomCheckMeasurementStatus.Measured,
        result: '{"gap":"40px","background":"rgba(0, 0, 0, 0)"}',
        truncated: false,
    },
): DomCheckRecord {
    return {
        expression:
            "(() => { const s = getComputedStyle(document.querySelector('.home-grid')); " +
            'return { gap: s.rowGap, background: s.backgroundColor }; })()',
        claim: 'The space below the masthead is the row gap of the transparent home grid.',
        before: {
            status: DomCheckMeasurementStatus.Measured,
            result: '{"gap":"40px","background":"rgba(0, 0, 0, 0)"}',
            truncated: false,
        },
        after,
    };
}
