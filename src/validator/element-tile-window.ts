/**
 * The document-space window a validation phase tiles around the candidate's target elements.
 */
import { DEFAULT_FULL_PAGE_WINDOW_SCREENS } from '../browser/full-page-tiles';
import type { TrustedPageEvaluator } from '../browser/trusted-page-evaluator';
import { RuleKind, normalizeRule } from '../repo/rule-normalizer';
import type { TraceRecorder } from '../tracer/trace-recorder';
import { TraceEventType } from '../types/trace';
import type { FullPageTileWindow } from '../types/validation';
import { CandidateNetworkScope, deriveCandidateNetworkScope } from './candidate-network-scope';

/**
 * Build the in-page expression measuring the document-space vertical span of every rendered match.
 *
 * A selector that hides several slots must bound all of them: tiles around the first match alone
 * leave the others to the downscaled full-page overview, where the review cannot judge them.
 * Matches with no rendered box (hidden, detached, collapsed) bound nothing; when none is rendered
 * the expression reports `found: false` and the caller falls back to the default capture plan.
 *
 * @param selector - Exact localized symptom selector.
 * @returns Self-contained expression returning `{ found, top, bottom }` in document coordinates.
 */
function elementDocumentSpanProbe(selector: string): string {
    return `
(function () {
    var elements = document.querySelectorAll(${JSON.stringify(selector)});
    var scrollY = window.scrollY || 0;
    var top = Infinity;
    var bottom = -Infinity;
    for (var index = 0; index < elements.length; index += 1) {
        var rect = elements[index].getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        top = Math.min(top, rect.top + scrollY);
        bottom = Math.max(bottom, rect.bottom + scrollY);
    }
    if (!(bottom > top)) return { found: false, top: 0, bottom: 0 };
    return { found: true, top: top, bottom: bottom };
})()
`;
}

/**
 * Measure the document-space tile window around every rendered element the selector matches.
 *
 * The window spans the matches plus one viewport above and below, so the before/after comparison
 * sees each instance of the symptom and its immediate layout neighborhood at original resolution
 * instead of the whole document. The tile capture owns the fit: a window wider than one capture
 * carries keeps its first rows there (`windowTrimmed`).
 *
 * @param evaluator - Runner-owned evaluator isolated from page JavaScript.
 * @param selector - Exact localized symptom selector.
 * @param viewportHeight - Current viewport height used as the context margin.
 * @param recorder - Trace recorder that keeps why a measurement failed.
 * @returns Document-space span, or undefined when no rendered match can bound one.
 */
export async function measureElementTileWindow(
    evaluator: TrustedPageEvaluator,
    selector: string,
    viewportHeight: number,
    recorder: TraceRecorder,
): Promise<FullPageTileWindow | undefined> {
    if (viewportHeight <= 0) {
        return undefined;
    }
    try {
        const result = await evaluator.evaluate(elementDocumentSpanProbe(selector));
        if (result && typeof result === 'object') {
            const span = result as Record<string, unknown>;
            if (
                span.found === true &&
                typeof span.top === 'number' &&
                Number.isFinite(span.top) &&
                typeof span.bottom === 'number' &&
                Number.isFinite(span.bottom) &&
                span.bottom > span.top
            ) {
                return {
                    fromY: Math.max(0, span.top - viewportHeight),
                    toY: span.bottom + viewportHeight,
                };
            }
        }
    } catch (error) {
        // The default capture plan still runs; the trace keeps why the window was not measured
        // (an extended-CSS selector the browser rejects, an evaluator lost to navigation).
        recorder.record(TraceEventType.Error, {
            phase: 'tile_window_measurement',
            selector,
            error: error instanceof Error ? error.message : String(error),
        });
    }
    return undefined;
}

/**
 * Whether a candidate's tile window must also cover the first screens of the page.
 *
 * A request block other than one of a host outside the reported site can break the page anywhere,
 * not only around the ad element its window is measured at. Its review takes the first screens a
 * default capture inspects as the page, the way it does for a candidate with no measurable target,
 * so breakage at the top of the page is seen.
 *
 * @param candidateRule - Candidate under validation.
 * @param reportedUrl - Trusted reported page URL.
 * @returns Whether the window must also cover the first screens.
 */
export function tileWindowStartsAtTop(candidateRule: string, reportedUrl: string): boolean {
    return (
        normalizeRule(candidateRule).kind === RuleKind.Network &&
        deriveCandidateNetworkScope(candidateRule, reportedUrl) !==
            CandidateNetworkScope.ThirdPartyHostBlock
    );
}

/**
 * Add the first screens of the page to a window measured around the target.
 *
 * A target within the first screens joins them in one span from the top. A target below them keeps
 * its own span, and the first screens become the window's top span, so the gap between them costs
 * no tiles and a deep target does not run into the tile limit.
 *
 * @param window - Window measured around the target.
 * @param viewportHeight - Current viewport height, the height of one screen.
 * @returns The window covering the first screens and the target.
 */
export function windowFromPageTop(
    window: FullPageTileWindow,
    viewportHeight: number,
): FullPageTileWindow {
    const firstScreensBottom = DEFAULT_FULL_PAGE_WINDOW_SCREENS * viewportHeight;
    return window.fromY <= firstScreensBottom
        ? { fromY: 0, toY: Math.max(window.toY, firstScreensBottom) }
        : { fromY: window.fromY, toY: window.toY, topToY: firstScreensBottom };
}
