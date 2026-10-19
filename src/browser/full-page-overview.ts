import type { Page } from 'playwright-core';
import type { Logger } from 'pino';
import { MAX_VISION_IMAGE_BYTES } from '../pi/single-shot-input';
import type { TraceRecorder } from '../tracer/trace-recorder';
import { TraceEventType } from '../types/trace';
import { writeArtifact } from './full-page-tiles';

/**
 * The full-page overview of one page state: a single context image of the whole document.
 *
 * It is context only. The original-resolution tiles carry the coverage proof, so a page state whose
 * overview could not be captured is still a complete capture when its tiles are.
 */

/**
 * JPEG quality of an overview whose PNG is too large to keep: enough to read the layout, small
 * enough to stay well under the per-image evidence limit on ordinary long pages.
 */
const OVERVIEW_JPEG_QUALITY = 60;

/**
 * Longest capture error kept on the result and in the trace, in characters.
 */
const MAX_OVERVIEW_ERROR_CHARS = 500;

/**
 * Trace phase naming a failed overview capture, so a run's trace says why a page state has tiles
 * but no overview.
 */
const FULL_PAGE_OVERVIEW_CAPTURE_PHASE = 'full_page_overview_capture';

/**
 * What one overview capture produced.
 */
export interface FullPageOverviewCapture {
    /**
     * Registered overview artifact, absent when the capture failed.
     */
    artifactId?: string;

    /**
     * Bounded browser error that left the page state without an overview.
     */
    error?: string;
}

/**
 * Capture and register the full-page overview of the current page state.
 *
 * A PNG over the vision byte cap is replaced by a JPEG of the same page. A capture the browser
 * refuses — Chromium cannot capture a very tall document, and a JPEG cannot encode one past 65,500
 * px — is recorded in the trace with the browser's own message and returned as an error, never
 * thrown: the page state goes on with its tiles alone.
 *
 * @param page - Page holding the stabilized document.
 * @param artifactsDir - Runner-owned artifact directory.
 * @param recorder - Trace recorder that owns the overview and records a failed capture.
 * @param logger - Operational logger that also gets a failed capture, when the caller passes one.
 * @returns The registered overview, or the error that prevented it.
 */
export async function captureFullPageOverview(
    page: Page,
    artifactsDir: string,
    recorder: TraceRecorder,
    logger: Logger | undefined,
): Promise<FullPageOverviewCapture> {
    try {
        const png = await page.screenshot({ fullPage: true, type: 'png' });
        if (png.length <= MAX_VISION_IMAGE_BYTES) {
            return {
                artifactId: writeArtifact(
                    artifactsDir,
                    'png',
                    png,
                    'screenshot-full-page',
                    recorder,
                ),
            };
        }
        const jpeg = await page.screenshot({
            fullPage: true,
            type: 'jpeg',
            quality: OVERVIEW_JPEG_QUALITY,
        });
        return {
            artifactId: writeArtifact(artifactsDir, 'jpg', jpeg, 'screenshot-full-page', recorder),
        };
    } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(
            0,
            MAX_OVERVIEW_ERROR_CHARS,
        );
        recorder.record(TraceEventType.Error, {
            phase: FULL_PAGE_OVERVIEW_CAPTURE_PHASE,
            error: message,
        });
        logger?.warn({ error: message }, 'full-page overview capture failed');
        return { error: message };
    }
}
