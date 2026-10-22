import { describe, expect, it, vi } from 'vitest';
import { runPhase } from '../../src/validator/phase-capture';
import { BrowserFallbackReason } from '../../src/types/browser-fallback-reason';
import { TraceEventType } from '../../src/types/trace';
import {
    PhaseLabel,
    type FullPageTileCoverage,
    type FullPageTileWindow,
} from '../../src/types/validation';
import type { Logger } from '../../src/logger/logger';
import { mockPage } from './phase-fixtures';
import type { BrowserToolHandlers } from '../../src/browser/browser-tools';
import type { PageStateInspection } from '../../src/types/page-state-inspection';
import type { TraceRecorder } from '../../src/tracer/trace-recorder';
import type { Page } from 'playwright-core';
import { runInNewContext } from 'node:vm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TrustedPageEvaluator } from '../../src/browser/trusted-page-evaluator';

/**
 * Create a minimal mock TraceRecorder.
 */
function mockRecorder(): TraceRecorder {
    return {
        record: vi.fn(),
        addArtifact: vi.fn(),
        recordToolCall: vi.fn(),
        recordLlmTurn: vi.fn(),
    } as unknown as TraceRecorder;
}

/**
 * Adapt legacy browser-tool test responses to the trusted evaluator interface.
 */
function trustedEvaluatorFromHandlers(handlers: BrowserToolHandlers): TrustedPageEvaluator {
    return {
        evaluate: async (expression: string): Promise<unknown> => {
            const response = await handlers.evaluate_js({ expression });
            if (
                response === null ||
                typeof response !== 'object' ||
                !Object.prototype.hasOwnProperty.call(response, 'result')
            ) {
                throw new Error('Malformed explicit test evaluator response.');
            }
            return (response as Record<string, unknown>).result;
        },
    };
}

/**
 * The empty page-state snapshot the inspect_page_state handler stub returns; this suite never
 * exercises the probe itself.
 */
const EMPTY_PAGE_STATE: PageStateInspection = {
    cookies: [],
    localStorage: {},
    sessionStorage: {},
    frames: [],
    counts: {
        cookies: { total: 0, returned: 0 },
        localStorage: { total: 0, returned: 0 },
        sessionStorage: { total: 0, returned: 0 },
        frames: { total: 0, returned: 0 },
    },
    truncated: false,
};

/**
 * Create mock BrowserToolHandlers with controllable return values.
 */
function mockHandlers(
    overrides: Partial<{
        openPageResult: Record<string, unknown>;
        screenshotResult: Record<string, unknown>;
        getDomResult: Record<string, unknown>;
        getNetworkLogResult: Record<string, unknown>;
        evaluateJsResult: Record<string, unknown>;
        evaluateJsImpl: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    }> = {},
): BrowserToolHandlers {
    const evaluate_js =
        overrides.evaluateJsImpl ??
        vi.fn().mockResolvedValue(overrides.evaluateJsResult ?? { result: false });

    return {
        open_page: vi.fn().mockResolvedValue(
            overrides.openPageResult ?? {
                url: 'https://example.com',
                title: 'Example',
                statusCode: 200,
            },
        ),
        screenshot: vi.fn().mockResolvedValue(
            overrides.screenshotResult ?? {
                artifactId: 'screenshot-uuid',
                fullPageArtifactId: 'screenshot-full-page-uuid',
                format: 'png',
                viewport: { width: 1920, height: 1080 },
                viewportPosition: { x: 0, y: 0 },
            },
        ),
        get_dom: vi.fn().mockResolvedValue(
            overrides.getDomResult ?? {
                artifactId: 'dom-uuid',
                htmlLength: 5000,
                textPreview: 'Example page content',
            },
        ),
        inspect_ad_slots: vi.fn().mockResolvedValue({
            scope: 'main_frame_light_dom',
            candidateCount: 0,
            returnedCount: 0,
            truncated: false,
            slots: [],
            artifactId: 'slots-uuid',
        }),
        get_network_log: vi.fn().mockResolvedValue(
            overrides.getNetworkLogResult ?? {
                artifactId: 'har-uuid',
                requestCount: 42,
                summary: '42 requests',
            },
        ),
        reset_network_log: vi.fn().mockResolvedValue({ reset: true }),
        get_console_log: vi.fn().mockResolvedValue({ messages: [] }),
        inspect_page_state: vi.fn().mockResolvedValue(EMPTY_PAGE_STATE),
        evaluate_js,
    };
}

/**
 * Tile coverage of a mobile page too tall for its overview to be read as one image.
 */
function tallCoverage(): FullPageTileCoverage {
    return {
        complete: true,
        documentWidth: 375,
        documentHeight: 10_334,
        viewportWidth: 375,
        viewportHeight: 812,
        overlapPx: 0,
        tiles: [
            {
                artifactId: 'tile-1',
                index: 0,
                x: 0,
                y: 0,
                width: 375,
                height: 812,
                landmark: 'Top of the page',
            },
        ],
    };
}

describe('runPhase', () => {
    it('returns PhaseResult with error when open_page fails', async () => {
        const handlers = mockHandlers({
            openPageResult: { error: 'net::ERR_CONNECTION_TIMED_OUT' },
        });
        const page = mockPage();
        const artifactsDir = '/tmp/test-artifacts';

        const result = await runPhase({
            handlers,
            page,
            artifactsDir,
            phase: 'A',
            url: 'https://example.com',
            trustedPageEvaluator: trustedEvaluatorFromHandlers(handlers),
            adElementSelector: undefined,
            recorder: mockRecorder(),
        });

        expect(result.error).toBeDefined();
        expect(result.phase).toBe('A');
    });

    it('bounds tile capture to the measured symptom window when a selector is localized', async () => {
        const handlers = mockHandlers();
        const screenshotArgs: Record<string, unknown>[] = [];
        vi.mocked(handlers.screenshot).mockImplementation(async (args) => {
            screenshotArgs.push(args as Record<string, unknown>);
            return {
                artifactId: 'shot',
                fullPageArtifactId: 'shot-full',
                viewportPosition: { x: 0, y: 0 },
            } as never;
        });
        vi.mocked(handlers.evaluate_js).mockImplementation(async (args) => {
            const expression = String((args as Record<string, unknown>).expression ?? '');
            if (expression.includes('window.scrollY')) {
                return { result: { found: true, top: 2_000, bottom: 2_600 } } as never;
            }
            return { result: null } as never;
        });
        const page = {
            ...mockPage(),
            viewportSize: vi.fn().mockReturnValue({ width: 1_000, height: 1_000 }),
        } as unknown as Page;

        await runPhase({
            handlers,
            page,
            artifactsDir: '/tmp/test-artifacts',
            phase: 'B',
            url: 'https://example.com',
            trustedPageEvaluator: trustedEvaluatorFromHandlers(handlers),
            adElementSelector: '.ad-banner',
            captureVisualTiles: true,
            recorder: mockRecorder(),
        });

        // One viewport above and below the element: top 2000..2600 with a 1000px margin.
        expect(screenshotArgs).toEqual([
            {
                captureTiles: true,
                tileWindow: { fromY: 1_000, toY: 3_600 },
            },
        ]);
    });

    /**
     * Run one tile-capturing phase on a page whose selector matches the given document spans,
     * measuring them with the real in-page probe, and return the window the capture was asked for.
     */
    async function capturedTileWindow(
        matches: { top: number; bottom: number }[],
        viewportHeight: number,
        tileWindowFromTop = false,
    ): Promise<FullPageTileWindow | undefined> {
        const handlers = mockHandlers();
        const screenshotArgs: Record<string, unknown>[] = [];
        vi.mocked(handlers.screenshot).mockImplementation(async (args) => {
            screenshotArgs.push(args as Record<string, unknown>);
            return {
                artifactId: 'shot',
                fullPageArtifactId: 'shot-full',
                viewportPosition: { x: 0, y: 0 },
            } as never;
        });
        const scrollY = 500;
        const elements = matches.map(({ top, bottom }) => ({
            getBoundingClientRect: () => ({
                top: top - scrollY,
                bottom: bottom - scrollY,
                width: bottom > top ? 300 : 0,
                height: bottom - top,
            }),
        }));
        const evaluator: TrustedPageEvaluator = {
            evaluate: async (expression: string): Promise<unknown> =>
                runInNewContext(expression, {
                    document: {
                        querySelector: () => elements[0] ?? null,
                        querySelectorAll: () => elements,
                    },
                    window: { scrollY },
                }),
        };
        const page = {
            ...mockPage(),
            viewportSize: vi.fn().mockReturnValue({ width: 1_920, height: viewportHeight }),
        } as unknown as Page;

        await runPhase({
            handlers,
            page,
            artifactsDir: '/tmp/test-artifacts',
            phase: 'B',
            url: 'https://example.com',
            trustedPageEvaluator: evaluator,
            adElementSelector: '.ad-slot',
            captureVisualTiles: true,
            ...(tileWindowFromTop ? { tileWindowFromTop } : {}),
            recorder: mockRecorder(),
        });

        expect(screenshotArgs).toHaveLength(1);
        return screenshotArgs[0].tileWindow as FullPageTileWindow | undefined;
    }

    it.each([
        {
            label: 'near the top',
            match: { top: 800, bottom: 1_000 },
            window: { fromY: 0, toY: 5_400 },
        },
        {
            label: 'below the first screens',
            match: { top: 9_000, bottom: 9_250 },
            window: { fromY: 7_920, toY: 10_330, topToY: 5_400 },
        },
    ])(
        'adds the first screens to the window of a request block whose ad sits $label',
        async (row) => {
            // A request block can break the page away from its ad, so its tiles also take in the first
            // five screens, which the review answers for whatever the candidate. A deep ad keeps its
            // own span: the gap between them would cost tiles nobody reviews.
            const window = await capturedTileWindow([row.match], 1_080, true);

            expect(window).toEqual(row.window);
        },
    );

    it('bounds tile capture around every instance a multi-instance selector matches', async () => {
        // A selector that hides several slots must get original-resolution tiles at each of them;
        // judged from the downscaled overview, the lower slots leave the review unclear.
        const instances = [
            { top: 122, bottom: 322 },
            { top: 2_900, bottom: 3_200 },
            { top: 5_400, bottom: 5_650 },
        ];

        const window = await capturedTileWindow(
            [...instances, { top: 4_000, bottom: 4_000 }],
            1_080,
        );

        expect(window).toBeDefined();
        for (const instance of instances) {
            expect(window!.fromY).toBeLessThanOrEqual(instance.top);
            expect(window!.toY).toBeGreaterThanOrEqual(instance.bottom);
        }
    });

    it('returns successful PhaseResult with artifacts', async () => {
        const handlers = mockHandlers();
        const page = mockPage();
        const artifactsDir = '/tmp/test-artifacts';

        const result = await runPhase({
            handlers,
            page,
            artifactsDir,
            phase: 'B',
            url: 'https://example.com',
            trustedPageEvaluator: trustedEvaluatorFromHandlers(handlers),
            adElementSelector: '.ad-banner',
            recorder: mockRecorder(),
        });

        expect(result.phase).toBe('B');
        expect(result.screenshotArtifactId).toBeDefined();
        expect(result.fullPageScreenshotArtifactId).toBe('screenshot-full-page-uuid');
        expect(result.harArtifactId).toBeDefined();
        expect(result.domArtifactId).toBeDefined();
        expect(result.url).toBe('https://example.com');
        expect(result.error).toBeUndefined();
    });

    it.each([
        { captureTileWindowMap: true, mapped: true },
        { captureTileWindowMap: false, mapped: false },
    ])(
        'adds the tile window map of a page too tall to read only when asked: $captureTileWindowMap',
        async ({ captureTileWindowMap, mapped }) => {
            // Only the reviewed phases need the map; any other capture would take a clip and
            // register an artifact nothing reads.
            const handlers = mockHandlers({
                screenshotResult: {
                    artifactId: 'screenshot-uuid',
                    tileCoverage: tallCoverage(),
                },
            });
            const page = mockPage();
            const screenshot = vi.fn().mockResolvedValue(Buffer.from('jpeg'));
            Object.assign(page, { screenshot });
            const artifactsDir = mkdtempSync(join(tmpdir(), 'phase-capture-map-'));
            try {
                const result = await runPhase({
                    handlers,
                    page,
                    artifactsDir,
                    phase: PhaseLabel.B,
                    url: 'https://example.com',
                    trustedPageEvaluator: trustedEvaluatorFromHandlers(handlers),
                    captureVisualTiles: true,
                    captureTileWindowMap,
                    recorder: mockRecorder(),
                });

                expect(result.tileCoverage?.map !== undefined).toBe(mapped);
                expect(screenshot).toHaveBeenCalledTimes(mapped ? 1 : 0);
            } finally {
                rmSync(artifactsDir, { recursive: true, force: true });
            }
        },
    );

    it('logs a refused tile window map capture', async () => {
        const handlers = mockHandlers({
            screenshotResult: { artifactId: 'screenshot-uuid', tileCoverage: tallCoverage() },
        });
        const page = mockPage();
        Object.assign(page, {
            screenshot: vi.fn().mockRejectedValue(new Error('Cannot take screenshot')),
        });
        const logger = { warn: vi.fn() };

        await runPhase({
            handlers,
            page,
            artifactsDir: '/tmp/test-artifacts',
            phase: PhaseLabel.C,
            url: 'https://example.com',
            trustedPageEvaluator: trustedEvaluatorFromHandlers(handlers),
            captureVisualTiles: true,
            captureTileWindowMap: true,
            recorder: mockRecorder(),
            logger: logger as unknown as Logger,
        });

        expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('traces why the phase captured no viewport screenshot', async () => {
        const handlers = mockHandlers({
            screenshotResult: {
                error: 'viewport position changed during capture',
                viewportPositionError: 'could not prove a stable viewport position',
                format: 'png',
            },
        });
        const recorder = mockRecorder();

        const result = await runPhase({
            handlers,
            page: mockPage(),
            artifactsDir: '/tmp/test-artifacts',
            phase: PhaseLabel.B,
            url: 'https://example.com',
            trustedPageEvaluator: trustedEvaluatorFromHandlers(handlers),
            recorder,
        });

        // The phase is judged without a viewport later; the trace has to say what the capture hit.
        expect(result.screenshotArtifactId).toBe('');
        expect(vi.mocked(recorder.record)).toHaveBeenCalledWith(
            TraceEventType.Error,
            expect.objectContaining({
                validationPhase: PhaseLabel.B,
                error: expect.stringContaining('viewport position changed during capture'),
            }),
        );
    });

    it('resets the network log before navigation', async () => {
        const handlers = mockHandlers();
        const calls: string[] = [];
        vi.mocked(handlers.reset_network_log).mockImplementation(async () => {
            calls.push('reset');
            return { reset: true };
        });
        vi.mocked(handlers.open_page).mockImplementation(async () => {
            calls.push('open');
            return { url: 'https://example.com', statusCode: 200 };
        });

        await runPhase({
            handlers,
            page: mockPage(),
            artifactsDir: '/tmp/test-artifacts',
            phase: 'A',
            url: 'https://example.com',
            trustedPageEvaluator: trustedEvaluatorFromHandlers(handlers),
            recorder: mockRecorder(),
        });

        expect(handlers.reset_network_log).toHaveBeenCalledOnce();
        expect(calls).toEqual(['reset', 'open']);
    });

    it('keeps why the page could not be opened', async () => {
        const handlers = mockHandlers({
            openPageResult: {
                error: 'main document returned HTTP 403',
                statusCode: 403,
                fallbackReason: BrowserFallbackReason.HttpBlocked,
            },
        });

        const result = await runPhase({
            handlers,
            page: mockPage(),
            artifactsDir: '/tmp/test-artifacts',
            phase: 'B',
            url: 'https://example.com',
            trustedPageEvaluator: trustedEvaluatorFromHandlers(handlers),
            recorder: mockRecorder(),
        });

        // The answer to the model says who refused the page; the reason has to survive the phase.
        expect(result.navigationFallbackReason).toBe(BrowserFallbackReason.HttpBlocked);
    });

    it.each([
        { settled: true as const },
        { settled: false as const, reason: 'page height still changing' },
    ])(
        'loads lazy content before the reveal steps and captures either way: %o',
        async (outcome) => {
            const handlers = mockHandlers();
            const order: string[] = [];
            vi.mocked(handlers.screenshot).mockImplementation(async () => {
                order.push('screenshot');
                return { artifactId: 'shot', fullPageArtifactId: 'shot-full' } as never;
            });
            const recorder = mockRecorder();

            const result = await runPhase({
                handlers,
                page: mockPage(),
                artifactsDir: '/tmp/test-artifacts',
                phase: 'B',
                url: 'https://example.com',
                trustedPageEvaluator: trustedEvaluatorFromHandlers(handlers),
                materialize: async () => {
                    order.push('materialize');
                    return outcome;
                },
                interact: async () => {
                    order.push('interact');
                },
                recorder,
            });

            // Every phase scrolls the same way first, so their captures share one load state, and the
            // reveal steps come last so nothing the scroll does closes what they opened. A page that
            // never settles, such as an endless feed, is still captured, and the trace says why.
            expect(order.slice(0, 2)).toEqual(['materialize', 'interact']);
            expect(order).toContain('screenshot');
            expect(result.error).toBeUndefined();
            expect(result.screenshotArtifactId).toBe('shot');
            if (!outcome.settled) {
                expect(vi.mocked(recorder.record)).toHaveBeenCalledWith(
                    TraceEventType.Error,
                    expect.objectContaining({ error: outcome.reason }),
                );
            }
        },
    );
});
