import { describe, expect, it } from 'vitest';
import { DomCheckMeasurementStatus, type DomCheckRecord } from '../../src/types/dom-check';
import { TraceEventType, type TraceEvent } from '../../src/types/trace';
import { reviewWith, type StubScript } from './visual-review-stub';
import { BEFORE_SLOT, SLOT_GAP, gridCheck } from './visual-review-fixtures';

/**
 * A review whose only open AFTER item is blank space at the removed slot's own place: attribution
 * places it at the BEFORE symptom, so only a DOM check can settle it.
 *
 * @param holder - The holder the adjudication names in a layout finding.
 * @returns The stub script.
 */
function slotGapScript(holder: string): StubScript {
    return {
        instances: [BEFORE_SLOT, SLOT_GAP],
        damage: [],
        attribute: () => ({ comparisonArtifactId: 'before-tile-1', comparisonObservationIndex: 1 }),
        adjudicate: { finding: 'layout', domCheckIndex: 1, holder },
    };
}

/**
 * Why the code refused each DOM-check answer, as the trace records it.
 *
 * @param events - The review's trace events.
 * @returns The refusal of every recorded answer.
 */
function refusals(events: TraceEvent[]): unknown[] {
    const decision = events.find(
        (event) =>
            event.type === TraceEventType.Decision &&
            event.payload.phase === 'candidate_visual_dom_adjudication',
    );
    const answers = (decision?.payload.answers ?? []) as Array<{ refusal: unknown }>;
    return answers.map((answer) => answer.refusal);
}

/**
 * A check that reads the holding grid through `getElementById`.
 *
 * @returns The check record.
 */
function gridByIdCheck(): DomCheckRecord {
    const measured = {
        status: DomCheckMeasurementStatus.Measured,
        result: '{"gap":"40px","background":"rgba(0, 0, 0, 0)"}',
        truncated: false,
    } as const;
    return {
        expression:
            "(() => { const s = getComputedStyle(document.getElementById('home-grid')); " +
            'return { gap: s.rowGap, background: s.backgroundColor }; })()',
        claim: 'The space below the masthead is the row gap of the transparent home grid.',
        before: measured,
        after: measured,
    };
}

describe('reviewCandidateVisually settles blank space a DOM check proves is layout', () => {
    it('sets aside blank space at the removed slot when a DOM check names the grid holding it', async () => {
        const { review } = await reviewWith(slotGapScript('.home-grid'), {
            domChecks: [gridCheck()],
        });

        expect(review.verdict).toBe('verified');
        expect(review.settlement?.observations).toEqual([
            expect.objectContaining({
                ground: 'dom_check_layout',
                domCheckIndex: 1,
                holder: '.home-grid',
            }),
        ]);
    });

    it.each(['home-grid', '#home-grid'])(
        'accepts %s for a grid the check reads by its ID',
        async (holder) => {
            const { review } = await reviewWith(slotGapScript(holder), {
                domChecks: [gridByIdCheck()],
            });

            expect(review.verdict).toBe('verified');
        },
    );

    it('keeps blank space when the holder appears only in what the check returned', async () => {
        const check: DomCheckRecord = {
            ...gridCheck(),
            expression:
                "(() => { const el = document.querySelector('main').firstElementChild; " +
                'return { className: el.className, gap: getComputedStyle(el).rowGap }; })()',
            before: {
                status: DomCheckMeasurementStatus.Measured,
                result: '{"className":"home-grid","gap":"40px"}',
                truncated: false,
            },
            after: {
                status: DomCheckMeasurementStatus.Measured,
                result: '{"className":"home-grid","gap":"40px"}',
                truncated: false,
            },
        };
        const { review, events } = await reviewWith(slotGapScript('home-grid'), {
            domChecks: [check],
        });

        expect(review.verdict).toBe('rejected');
        expect(refusals(events)).toEqual(['holder_not_queried']);
    });

    it('keeps blank space when the layout finding names an element the check never measured', async () => {
        const { review, events } = await reviewWith(slotGapScript('.sidebar-track'), {
            domChecks: [gridCheck()],
        });

        expect(review.verdict).toBe('rejected');
        expect(refusals(events)).toEqual(['holder_not_queried']);
    });

    it('keeps blank space when the check failed on the candidate page', async () => {
        const { review, events } = await reviewWith(slotGapScript('.home-grid'), {
            domChecks: [
                gridCheck({ status: DomCheckMeasurementStatus.Failed, error: 'timed out' }),
            ],
        });

        expect(review.verdict).toBe('rejected');
        expect(refusals(events)).toEqual(['load_not_measured']);
    });
});
