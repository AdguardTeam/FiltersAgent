import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { createBrowserToolHandlers } from '../../src/browser/browser-tools';
import { ConsoleCoverage, type IBrowserSession } from '../../src/browser/browser-interfaces';
import type { TrustedPageEvaluator } from '../../src/browser/trusted-page-evaluator';
import { phaseCaptureFailed } from '../../src/environment/extension-phase-records';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import { PhaseLabel, type PhaseResult } from '../../src/types/validation';
import { materializePage } from '../../src/validator/page-materialization';
import { runPhase } from '../../src/validator/phase-capture';

/**
 * Options object form of `window.scrollTo`.
 */
interface ScrollCall {
    left?: number;
    top?: number;
    behavior?: string;
}

/**
 * Document of a long article page, viewport of the capture browser.
 */
const DOCUMENT_HEIGHT = 8_254;
const VIEWPORT_HEIGHT = 1_080;

/**
 * Speed of a smooth scroll: a return from the bottom of this page to its top takes about 1.4
 * seconds, as in Chromium. A scroll started during another keeps moving from where the page is, the
 * way browsers retarget a running scroll animation instead of restarting it from rest.
 */
const SMOOTH_SCROLL_PX_PER_MS = 5;

/**
 * A window whose stylesheet sets `scroll-behavior: smooth` on the root, as Bootstrap 5 and
 * Tailwind's `scroll-smooth` do. Per CSSOM View, `scrollTo` with behavior `auto` (the default, and
 * the only one the two-number form has) animates; only `instant` jumps.
 *
 * @returns The window global and its `scrollTo`, for a smooth scroll the page itself makes.
 */
function smoothScrollingWindow() {
    const maximumY = DOCUMENT_HEIGHT - VIEWPORT_HEIGHT;
    let from = 0;
    let to = 0;
    let start = 0;
    let instant = true;
    const currentY = (): number => {
        if (instant) {
            return to;
        }
        const travelled = Math.min(
            Math.abs(to - from),
            (Date.now() - start) * SMOOTH_SCROLL_PX_PER_MS,
        );
        return from + Math.sign(to - from) * travelled;
    };
    const scrollTo = (optionsOrX: ScrollCall | number, y?: number): void => {
        const call: ScrollCall =
            typeof optionsOrX === 'number' ? { left: optionsOrX, top: y } : optionsOrX;
        from = currentY();
        to = Math.max(0, Math.min(maximumY, call.top ?? from));
        start = Date.now();
        instant = call.behavior === 'instant';
    };
    const window: Record<string, unknown> = {
        innerHeight: VIEWPORT_HEIGHT,
        scrollX: 0,
        scrollTo,
        requestAnimationFrame: (callback: () => void) => setTimeout(callback, 16),
        setTimeout,
    };
    Object.defineProperty(window, 'scrollY', { get: currentY });
    window.window = window;
    window.document = {
        body: { scrollHeight: DOCUMENT_HEIGHT },
        documentElement: { scrollHeight: DOCUMENT_HEIGHT },
    };
    return { window, scrollTo };
}

/**
 * Minimal valid PNG header for a full-HD viewport capture.
 *
 * @returns PNG bytes whose IHDR names 1920x1080.
 */
function viewportPng(): Buffer {
    const buffer = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
    buffer.write('IHDR', 12, 'ascii');
    buffer.writeUInt32BE(1_920, 16);
    buffer.writeUInt32BE(VIEWPORT_HEIGHT, 20);
    return buffer;
}

/**
 * Capture one phase with the real phase runner, scroll probes and screenshot handler on a
 * smooth-scrolling page.
 *
 * @param options - Whether the phase loads lazy content first, and where a reveal step starts the
 *   page's own smooth scroll to.
 * @returns The phase result and whether the extension phase records it as a failed capture.
 */
async function captureSmoothScrollingPhase(options: {
    materialize: boolean;
    pageScrollTop?: number;
}): Promise<{ result: PhaseResult; failed: boolean }> {
    const page = smoothScrollingWindow();
    const evaluateInPage = async (expression: string): Promise<unknown> =>
        await runInNewContext(expression, page.window);
    const cdpSession = {
        send: async (method: string, params?: Record<string, unknown>) => {
            if (method === 'Page.getFrameTree') {
                return { frameTree: { frame: { id: 'main' } } };
            }
            if (method === 'Page.createIsolatedWorld') {
                return { executionContextId: 1 };
            }
            if (method === 'Runtime.evaluate') {
                try {
                    return { result: { value: await evaluateInPage(String(params?.expression)) } };
                } catch (error) {
                    return { exceptionDetails: { text: (error as Error).message } };
                }
            }
            return {};
        },
        detach: async () => undefined,
    };
    const browserPage = {
        screenshot: async () => {
            // Encoding a full-HD PNG takes Chromium tens of milliseconds.
            await delay(40);
            return viewportPng();
        },
        waitForTimeout: async (milliseconds: number) => await delay(milliseconds),
        evaluate: async () => false,
        viewportSize: () => ({ width: 1_920, height: VIEWPORT_HEIGHT }),
        context: () => ({ newCDPSession: async () => cdpSession }),
        url: () => 'https://example.com/article',
        content: async () => '<html></html>',
    };
    const session = {
        getPage: () => browserPage,
        getNetworkLog: () => [],
        resetNetworkLog: () => undefined,
        getConsoleLog: () => [],
        consoleCoverage: ConsoleCoverage.BrowserLogOnly,
        close: async () => undefined,
        artifactsDir: tmpdir(),
        isClosed: false,
    } as unknown as IBrowserSession;
    const artifactsDir = mkdtempSync(join(tmpdir(), 'smooth-scroll-capture-'));
    const recorder = new TraceRecorder({ runId: 'smooth-scroll', issueNumber: 1, mode: 'fix' });
    const handlers = {
        ...createBrowserToolHandlers({
            session,
            recorder,
            artifactsDir,
            allowedOrigin: 'https://example.com/',
            logger: pino({ level: 'silent' }),
        }),
        reset_network_log: async () => ({ reset: true }),
        open_page: async () => ({ url: 'https://example.com/article', statusCode: 200 }),
        get_network_log: async () => ({ artifactId: 'har' }),
        get_dom: async () => ({ artifactId: 'dom' }),
    };
    const evaluator: TrustedPageEvaluator = { evaluate: evaluateInPage };
    const { pageScrollTop } = options;
    const result = await runPhase({
        handlers,
        page: browserPage as unknown as Page,
        artifactsDir,
        phase: PhaseLabel.A,
        url: 'https://example.com/article',
        trustedPageEvaluator: evaluator,
        ...(options.materialize ? { materialize: () => materializePage(evaluator) } : {}),
        ...(pageScrollTop === undefined
            ? {}
            : {
                  interact: async () => {
                      page.scrollTo({ top: pageScrollTop, behavior: 'smooth' });
                  },
              }),
        recorder,
    });
    return { result, failed: phaseCaptureFailed(result, recorder, PhaseLabel.A) };
}

describe('phase capture on a smooth-scrolling page', () => {
    it('keeps the viewport screenshot after loading lazy content', async () => {
        // Loading lazy content scrolls to the bottom and back; on this page a plain scrollTo
        // returns to the top through an animation of more than a second the capture cannot wait
        // out.
        const { result, failed } = await captureSmoothScrollingPhase({ materialize: true });

        expect(result.screenshotArtifactId).not.toBe('');
        expect(failed).toBe(false);
    }, 20_000);

    it('captures the viewport once a smooth scroll the page started settles', async () => {
        // A 300 ms scroll: still running for the first capture attempt, over before the last.
        const { result, failed } = await captureSmoothScrollingPhase({
            materialize: false,
            pageScrollTop: 1_500,
        });

        expect(result.screenshotArtifactId).not.toBe('');
        expect(failed).toBe(false);
    }, 20_000);
});
