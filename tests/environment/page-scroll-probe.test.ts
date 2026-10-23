import { existsSync } from 'node:fs';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { firefox, type Browser, type Page } from 'playwright-core';
import { createTrustedPageEvaluator } from '../../src/browser/trusted-page-evaluator';
import { measurePageScroll } from '../../src/environment/page-scroll-probe';

/**
 * Content tall enough to scroll in any test viewport.
 */
const LONG_CONTENT = '<div style="height:5000px">Article</div>';

/**
 * Height of the test viewport.
 */
const VIEWPORT_HEIGHT = 800;

/**
 * Whether the Playwright Firefox build is installed; the Checks workflow installs it.
 */
const firefoxInstalled = existsSync(firefox.executablePath());

/**
 * What a reader's mouse wheel does to the page, measured in a real browser: only real input proves
 * the page scrolls, so a fake page could not exercise this contract.
 */
describe.skipIf(!firefoxInstalled)('page scroll probe in a real browser', () => {
    let browser: Browser;
    let page: Page;

    beforeAll(async () => {
        browser = await firefox.launch({ headless: true });
        page = await browser.newPage({ viewport: { width: 1280, height: VIEWPORT_HEIGHT } });
    });

    afterAll(async () => {
        await browser?.close();
    });

    /**
     * Load one standards-mode page and measure it.
     *
     * @param head - Styles and scripts for the page.
     * @param body - The body element with its content.
     * @returns The probe's measurement.
     */
    async function measure(head: string, body: string) {
        await page.setContent(`<!doctype html><html><head>${head}</head>${body}</html>`);
        const logger = pino({ level: 'silent' });
        return await measurePageScroll(
            page,
            await createTrustedPageEvaluator(page, { logger }),
            logger,
        );
    }

    it('moves a page nothing locks', async () => {
        const measurement = await measure('', `<body>${LONG_CONTENT}</body>`);

        expect(measurement?.wheelScrolledPx).toBeGreaterThan(0);
    });

    it('stays put on a page an anti-adblock gate locked with overflow on body', async () => {
        // A programmatic scroll still moves this page; the reader's wheel does not.
        const measurement = await measure(
            '<style>body.gate-open{overflow:hidden}</style>',
            `<body class="theme-a theme-b gate-open">${LONG_CONTENT}</body>`,
        );

        expect(measurement).toMatchObject({
            wheelScrolledPx: 0,
            innerContainerScrolled: false,
            body: { className: 'theme-a theme-b gate-open', overflowY: 'hidden' },
        });
        expect(measurement?.contentHeight).toBeGreaterThan(VIEWPORT_HEIGHT);
    });

    it('keeps the lock class a long theme class list ends with', async () => {
        const themeClasses = Array.from({ length: 30 }, (_, i) => `theme-class-${i}`).join(' ');
        const measurement = await measure(
            '<style>body.gate-open{overflow:hidden}</style>',
            `<body class="${themeClasses} gate-open">${LONG_CONTENT}</body>`,
        );

        expect(measurement?.body.className).toMatch(/ gate-open$/);
    });

    it('stays put on a page locked by fixing body in place, and keeps its content height', async () => {
        const measurement = await measure(
            '',
            `<body style="position:fixed;top:0;left:0;right:0">${LONG_CONTENT}</body>`,
        );

        expect(measurement).toMatchObject({ wheelScrolledPx: 0, body: { position: 'fixed' } });
        expect(measurement?.contentHeight).toBeGreaterThan(VIEWPORT_HEIGHT);
    });

    it('counts the content a wrapper clips as content to scroll', async () => {
        const measurement = await measure(
            '<style>body{margin:0}</style>',
            `<body><div style="height:100vh;overflow:hidden">${LONG_CONTENT}</div></body>`,
        );

        expect(measurement).toMatchObject({ wheelScrolledPx: 0, innerContainerScrolled: false });
        expect(measurement?.contentHeight).toBeGreaterThan(VIEWPORT_HEIGHT);
    });

    it('counts a locked wrapper beside a transparent gate container at the centre', async () => {
        // The candidate hid the dialog; the gate's full-screen container stays under the centre.
        const measurement = await measure(
            '<style>body{margin:0}#app{height:100vh;overflow:hidden}' +
                '#gate{position:fixed;inset:0}</style>',
            `<body><div id="app">${LONG_CONTENT}</div><div id="gate"></div></body>`,
        );

        expect(measurement?.wheelScrolledPx).toBe(0);
        expect(measurement?.contentHeight).toBeGreaterThan(VIEWPORT_HEIGHT);
    });

    it('counts the content of a wrapper fixed in place', async () => {
        const measurement = await measure(
            '<style>body{margin:0}#app{position:fixed;inset:0}</style>',
            `<body><div id="app">${LONG_CONTENT}</div></body>`,
        );

        expect(measurement?.wheelScrolledPx).toBe(0);
        expect(measurement?.contentHeight).toBeGreaterThan(VIEWPORT_HEIGHT);
    });

    it('reports a short page as one with nothing to scroll', async () => {
        const measurement = await measure('', '<body><p>Short</p></body>');

        expect(measurement?.contentHeight).toBeLessThanOrEqual(VIEWPORT_HEIGHT);
    });

    it('moves a page whose root scrolls past a hidden body overflow', async () => {
        const measurement = await measure(
            '<style>html{overflow:auto}body{overflow:hidden}</style>',
            `<body>${LONG_CONTENT}</body>`,
        );

        expect(measurement?.wheelScrolledPx).toBeGreaterThan(0);
    });

    it('moves a page that scrolls smoothly', async () => {
        const measurement = await measure(
            '<style>html{scroll-behavior:smooth}</style>',
            `<body>${LONG_CONTENT}</body>`,
        );

        expect(measurement?.wheelScrolledPx).toBeGreaterThan(0);
    });

    it('tells a container scrolled under the pointer from a locked document', async () => {
        const measurement = await measure(
            '',
            `<body style="overflow:hidden;margin:0">` +
                `<div style="height:100vh;overflow:auto">${LONG_CONTENT}</div>${LONG_CONTENT}</body>`,
        );

        expect(measurement).toMatchObject({ wheelScrolledPx: 0, innerContainerScrolled: true });
    });

    it('does not take content changing under the pointer for a scrolled container', async () => {
        // A carousel or a late ad swaps what sits under the centre while the page stays locked.
        const measurement = await measure(
            '<style>body{overflow:hidden;margin:0}#slot{height:100vh}</style>',
            `<body><div id="slot"></div>${LONG_CONTENT}<script>` +
                "setInterval(() => { slot.innerHTML = slot.firstChild ? '' : '<p>Slide</p>'; }, 50);" +
                '</script></body>',
        );

        expect(measurement).toMatchObject({ wheelScrolledPx: 0, innerContainerScrolled: false });
    });

    it('stays put on a page a gate pins in place from its scroll listener', async () => {
        // The gate opened with the page scrolled and holds it there, so the probe's jump to the top
        // bounces back too.
        const measurement = await measure(
            '',
            `<body>${LONG_CONTENT}<script>` +
                "scrollTo({ top: 300, behavior: 'instant' });" +
                "addEventListener('scroll', () => { if (scrollY !== 300) scrollTo({ top: 300, behavior: 'instant' }); });" +
                '</script></body>',
        );

        expect(measurement?.wheelScrolledPx).toBe(0);
    });

    it('moves a page whose centre holds a frame that takes the wheel', async () => {
        const measurement = await measure(
            '<style>body{margin:0}iframe{display:block;margin:0 auto;width:50%;height:100vh}</style>',
            '<body><iframe srcdoc="<div style=\'height:5000px\'>Live blog</div>"></iframe>' +
                `${LONG_CONTENT}</body>`,
        );

        expect(measurement?.wheelScrolledPx).toBeGreaterThan(0);
    });

    it('returns the page to where it was', async () => {
        await measure('', `<body>${LONG_CONTENT}</body>`);
        await page.evaluate("window.scrollTo({ top: 1234, behavior: 'instant' })");
        const logger = pino({ level: 'silent' });
        await measurePageScroll(page, await createTrustedPageEvaluator(page, { logger }), logger);

        expect(await page.evaluate('window.scrollY')).toBe(1234);
    });
});

describe('page scroll probe on a page that never answers', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('gives up in time so the phase goes on without a measurement', async () => {
        // A DOM check that never settled, or the page's own script, holds the main thread: every
        // read queues behind it.
        vi.useFakeTimers();
        const held = { evaluate: () => new Promise<unknown>(() => undefined) };
        const measurement = measurePageScroll({} as Page, held, pino({ level: 'silent' }));
        await vi.runAllTimersAsync();

        expect(await measurement).toBeNull();
    });

    it('leaves the page alone once the page answers too late', async () => {
        vi.useFakeTimers();
        const lateRead = {
            scrollY: 0,
            viewportWidth: 1280,
            viewportHeight: VIEWPORT_HEIGHT,
            contentHeight: 5_000,
            chain: [],
            html: { className: '', style: '', overflowY: 'visible', position: 'static' },
            body: { className: '', style: '', overflowY: 'visible', position: 'static' },
        };
        const evaluate = vi.fn(
            () => new Promise<unknown>((resolve) => setTimeout(() => resolve(lateRead), 600_000)),
        );
        const mouse = { move: vi.fn(), wheel: vi.fn() };
        const warn = vi.fn();
        const logger = { warn } as unknown as Parameters<typeof measurePageScroll>[2];
        const measurement = measurePageScroll({ mouse } as unknown as Page, { evaluate }, logger);
        await vi.runAllTimersAsync();

        expect(await measurement).toBeNull();
        // No wheel turn, no restore, and the timeout is the only warning.
        expect(evaluate).toHaveBeenCalledTimes(1);
        expect(mouse.move).not.toHaveBeenCalled();
        expect(mouse.wheel).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
    });
});
