/**
 * Bounded lazy-content materialization before a phase's captures.
 *
 * Sites load feed sections, images and widgets as the reader scrolls or a timer fires. Two phases
 * captured a few seconds apart can then show the same page in different load states, and the review
 * reads the difference as something the candidate did. A bounded scroll pass that waits for the
 * document height to settle puts every phase into the same state first.
 */
import type { TrustedPageEvaluator } from '../browser/trusted-page-evaluator';
import type { TraceRecorder } from '../tracer/trace-recorder';
import { TraceEventType } from '../types/trace';
import type { PhaseLabel } from '../types/validation';

/**
 * Trace phase naming a capture whose lazy content did not settle before it was taken.
 */
const LAZY_CONTENT_TRACE_PHASE = 'lazy_content_materialization';

/**
 * Bounded same-document scroll pass used to trigger and settle lazy page content.
 */
const PAGE_MATERIALIZATION_PROBE = `
(async function () {
    if (!document.body || !document.documentElement) {
        return { materialized: false, stable: false, height: 0 };
    }
    var originalX = window.scrollX || 0;
    var originalY = window.scrollY || 0;
    var readHeight = function () {
        return Math.max(
            document.documentElement.scrollHeight || 0,
            document.body.scrollHeight || 0,
        );
    };
    var wait = function (milliseconds) {
        return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
    };
    var maximumSupportedHeight = 50000;
    var maximumScrollSteps = 128;
    var previousHeight = readHeight();
    var stable = false;
    if (previousHeight > maximumSupportedHeight) {
        return {
            materialized: false,
            stable: false,
            height: previousHeight,
            reason: 'document_height_exceeds_materialization_limit',
        };
    }
    try {
        for (var pass = 0; pass < 3; pass += 1) {
            var viewportHeight = Math.max(1, window.innerHeight || 0);
            var boundedHeight = Math.max(viewportHeight, previousHeight);
            var maximumStepDistance = Math.max(1, Math.floor(viewportHeight * 0.75));
            var steps = Math.max(1, Math.ceil(boundedHeight / maximumStepDistance));
            if (steps > maximumScrollSteps) {
                return {
                    materialized: false,
                    stable: false,
                    height: previousHeight,
                    reason: 'materialization_step_limit_exceeded',
                };
            }
            for (var step = 0; step <= steps; step += 1) {
                window.scrollTo(0, Math.round((boundedHeight * step) / steps));
                await wait(75);
            }
            await wait(250);
            var nextHeight = readHeight();
            if (nextHeight > maximumSupportedHeight) {
                previousHeight = nextHeight;
                return {
                    materialized: false,
                    stable: false,
                    height: previousHeight,
                    reason: 'document_height_exceeds_materialization_limit',
                };
            }
            if (Math.abs(nextHeight - previousHeight) <= 4) {
                stable = true;
                previousHeight = nextHeight;
                break;
            }
            previousHeight = nextHeight;
        }
    } finally {
        window.scrollTo(originalX, originalY);
        await wait(250);
    }
    return { materialized: true, stable: stable, height: previousHeight };
})()
`;

/**
 * Outcome of one bounded materialization pass.
 */
export type PageMaterialization =
    | {
          /**
           * The scroll pass completed and the page height settled.
           */
          settled: true;
      }
    | {
          /**
           * The page was not brought into a settled state.
           */
          settled: false;

          /**
           * Why: a limit the probe refused to scroll past, a height that kept changing, or the
           * evaluation error.
           */
          reason: string;
      };

/**
 * Shape the probe answers with; the probe is our own script.
 */
interface MaterializationProbeResult {
    /**
     * Whether the scroll pass ran to completion.
     */
    materialized: boolean;

    /**
     * Whether the document height settled within the passes.
     */
    stable: boolean;

    /**
     * Document height when the probe finished.
     */
    height: number;

    /**
     * The limit that stopped the probe before scrolling, when one did.
     */
    reason?: string;
}

/**
 * Materialize bounded lazy content and require document-height stability.
 *
 * @param evaluator - Trusted isolated-world evaluator for the current document.
 * @returns Settled only when a bounded scroll pass completed and page height stabilized; otherwise
 *   the reason it did not.
 */
export async function materializePage(
    evaluator: TrustedPageEvaluator,
): Promise<PageMaterialization> {
    let result: MaterializationProbeResult;
    try {
        result = (await evaluator.evaluate(
            PAGE_MATERIALIZATION_PROBE,
        )) as MaterializationProbeResult;
    } catch (error) {
        return {
            settled: false,
            reason: `materialization probe failed: ${(error as Error).message}`,
        };
    }
    if (result.materialized && result.stable) {
        return { settled: true };
    }
    return {
        settled: false,
        reason:
            result.reason ??
            (result.materialized
                ? `page height still changing at ${result.height}px after the bounded scroll passes`
                : 'the document has no body to scroll'),
    };
}

/**
 * Load a phase's lazy content before its captures, best effort.
 *
 * A page that never settles — an endless feed, a document past the probe's height limit — is still
 * captured: refusing it would make every candidate on such a site unverifiable. The trace records
 * that this phase's captures may show a different load state than the others.
 *
 * @param phase - Phase being captured.
 * @param materialize - The bounded scroll pass.
 * @param recorder - Trace recorder of the run.
 */
export async function settleLazyContent(
    phase: PhaseLabel,
    materialize: () => Promise<PageMaterialization>,
    recorder: TraceRecorder,
): Promise<void> {
    const outcome = await materialize();
    if (!outcome.settled) {
        recorder.record(TraceEventType.Error, {
            phase: LAZY_CONTENT_TRACE_PHASE,
            validationPhase: phase,
            error: outcome.reason,
        });
    }
}
