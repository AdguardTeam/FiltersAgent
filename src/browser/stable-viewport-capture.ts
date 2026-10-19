/**
 * Viewport screenshot taken at a scroll position proven stable before and after the capture.
 */
import type { IBrowserSession } from './browser-interfaces';
import {
    readStableViewportPosition,
    viewportPositionMatches,
    type ViewportPosition,
} from './page-stability';

/**
 * Capture attempts before the viewport is reported as still moving.
 */
export const VIEWPORT_CAPTURE_ATTEMPTS = 3;

/**
 * Pause before each retry, so a short scroll animation under way can finish instead of failing
 * every attempt back to back. Three attempts with two pauses wait out only a scroll that ends
 * within about half a second: the lazy-content pass makes its own long return to the top instant,
 * and `stabilizePageForCapture` settles the page after each reveal step.
 */
const VIEWPORT_CAPTURE_RETRY_DELAY_MS = 200;

/**
 * Viewport screenshot and the scroll position it was taken at.
 */
export interface StableViewportCapture {
    /**
     * PNG bytes of the viewport.
     */
    buffer: Buffer;

    /**
     * Scroll position that held across the capture.
     */
    position: ViewportPosition;
}

/**
 * Capture the viewport at a scroll position that stays put across the capture.
 *
 * @param page - Active Playwright page whose viewport is captured.
 * @returns The capture, or null when the viewport kept moving across every attempt.
 */
export async function captureStableViewport(
    page: ReturnType<IBrowserSession['getPage']>,
): Promise<StableViewportCapture | null> {
    for (let attempt = 0; attempt < VIEWPORT_CAPTURE_ATTEMPTS; attempt++) {
        if (attempt > 0) {
            await page.waitForTimeout(VIEWPORT_CAPTURE_RETRY_DELAY_MS);
        }
        const before = await readStableViewportPosition(page);
        if (!before) {
            continue;
        }
        const buffer = await page.screenshot({ fullPage: false, type: 'png' });
        const after = await readStableViewportPosition(page);
        if (after && viewportPositionMatches(before, after)) {
            return { buffer, position: after };
        }
    }
    return null;
}
