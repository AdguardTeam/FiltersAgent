/**
 * Whether a reader can still scroll the page: a real mouse-wheel turn over the viewport, and the
 * styles of `html` and `body` that explain the answer.
 *
 * An anti-adblock gate locks the page behind its modal, typically with `overflow: hidden` or
 * `position: fixed` on `body`. A rule that hides only the modal leaves that lock in place, and the
 * screenshots of the locked page look clean. Only input the browser treats as the reader's proves
 * the page scrolls: a programmatic scroll (`scrollTo`, `scrollBy`, setting `scrollTop`) still moves
 * a page whose root keeps `overflow: hidden`. The computed overflow alone decides nothing either:
 * it misses a `position: fixed` lock and calls a page locked whose `html` scrolls past a hidden
 * `body` overflow. So the wheel decides, and the styles travel with it as the explanation.
 */
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import * as v from 'valibot';
import type { TrustedPageEvaluator } from '../browser/trusted-page-evaluator';
import type { Logger } from '../logger/logger';

/**
 * Distance of one wheel turn, in CSS pixels: a few notches of a mouse wheel, short of one viewport,
 * so any page taller than the viewport has room for it.
 */
const WHEEL_DELTA_PX = 400;

/**
 * How long a wheel turn may take to move the page. A smooth-scrolling page starts moving within a
 * frame or two; a locked one never does, so the probe waits this long before it reports that the
 * document stayed put.
 */
const WHEEL_SETTLE_TIMEOUT_MS = 1_500;

/**
 * Interval between two reads of the scroll position while a wheel turn settles.
 */
const WHEEL_POLL_INTERVAL_MS = 100;

/**
 * Longest the whole probe may take. Two wheel turns that never move the page, their reads and the
 * restore take about three seconds; the rest is room for a slow page whose every read lags, since a
 * probe cut short passes the check and would let a lock through. A page whose main thread is held,
 * by its own script or by a DOM check that never settled, answers none of them, and the phase goes
 * on without the measurement instead of waiting out the apply_rule deadline.
 */
const PAGE_SCROLL_PROBE_TIMEOUT_MS = 30_000;

/**
 * Where the second wheel turn lands, as a fraction of the viewport width: near the left edge, away
 * from the centred column where frames, maps and players sit, and from the scrollbar on the right.
 */
const SECOND_POINT_X_FRACTION = 0.05;

/**
 * Smallest share of the viewport's height an element's box must fill to count as a wrapper that can
 * lock the page: a lock covers the page, while a collapsed "read more" box or a carousel that clips
 * its own content is smaller. Short of the whole viewport, so a wrapper below a header counts too.
 */
const LOCK_WRAPPER_MIN_VIEWPORT_SHARE = 0.9;

/**
 * Longest `class` or `style` attribute the measurement keeps: enough for the lock class a site
 * adds, bounded so a utility-class soup cannot bloat the apply_rule answer. The tail is kept, since
 * a gate adds its lock class or style after the theme's own.
 */
const ATTRIBUTE_MAX_CHARS = 200;

/**
 * Wait two animation frames: the page applies hover styles, answers a scroll from its listeners and
 * lays out again within them.
 */
const SETTLE_FRAMES = `
new Promise(function (resolve) {
    requestAnimationFrame(function () {
        requestAnimationFrame(function () {
            resolve(true);
        });
    });
})
`;

/**
 * Read the page before a wheel turn: the scroll position, the viewport, the height of the content a
 * lock may clip, the elements under the viewport's centre up to `body` with their DOM paths and
 * scroll offsets, and the state of `html` and `body`.
 *
 * The content height walks the whole page, not the elements under the centre: a gate's transparent
 * full-screen container can sit there after the candidate hid its dialog, while the wrapper it
 * locked lies beside it.
 *
 * A path of child indices names an element across reads without marking the page: each read on the
 * Chromium route runs in a fresh isolated world, which keeps nothing between reads.
 */
const PAGE_STATE_READ = `
(function () {
    var root = document.documentElement;
    var body = document.body;
    if (!root || !body) {
        throw new Error('The page has no html or body element to scroll.');
    }
    var tail = function (value) {
        var text = String(value || '');
        return text.slice(Math.max(0, text.length - ${ATTRIBUTE_MAX_CHARS}));
    };
    var lockStyle = function (element) {
        var computed = getComputedStyle(element);
        return {
            className: tail(element.getAttribute('class')),
            style: tail(element.getAttribute('style')),
            overflowY: computed.overflowY,
            position: computed.position,
        };
    };
    var pathOf = function (node) {
        var path = [];
        for (; node !== root; node = node.parentElement) {
            path.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
        }
        return path;
    };
    // A body fixed in place keeps its content height in its own scroll height. So does a
    // page-sized wrapper that clips its content or is fixed in place, wherever it sits.
    var contentHeight = Math.max(root.scrollHeight, body.scrollHeight);
    var wrapperMinHeight = window.innerHeight * ${LOCK_WRAPPER_MIN_VIEWPORT_SHARE};
    var walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.clientHeight < wrapperMinHeight || node.scrollHeight <= contentHeight) {
            continue;
        }
        var style = getComputedStyle(node);
        if (
            style.position === 'fixed' ||
            style.overflowY === 'hidden' ||
            style.overflowY === 'clip'
        ) {
            contentHeight = node.scrollHeight;
        }
    }
    var chain = [];
    var element = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    for (; element && element !== body && element !== root; element = element.parentElement) {
        chain.push({ path: pathOf(element), scrollTop: element.scrollTop });
    }
    return {
        scrollY: window.scrollY,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        contentHeight: contentHeight,
        chain: chain,
        html: lockStyle(root),
        body: lockStyle(body),
    };
})()
`;

/**
 * The scroll-relevant state of `html` or `body`.
 */
const ScrollLockStyleSchema = v.object({
    className: v.string(),
    style: v.string(),
    overflowY: v.string(),
    position: v.string(),
});

/**
 * ScrollLockStyleSchema output.
 */
type ScrollLockStyle = v.InferOutput<typeof ScrollLockStyleSchema>;

/**
 * One element under the viewport's centre: its DOM path from `html` and its scroll offset.
 */
const ChainElementSchema = v.object({
    path: v.array(v.number()),
    scrollTop: v.number(),
});

/**
 * ChainElementSchema output.
 */
type ChainElement = v.InferOutput<typeof ChainElementSchema>;

/**
 * The page before a wheel turn.
 */
const PageStateSchema = v.object({
    scrollY: v.number(),
    viewportWidth: v.number(),
    viewportHeight: v.number(),
    contentHeight: v.number(),
    chain: v.array(ChainElementSchema),
    html: ScrollLockStyleSchema,
    body: ScrollLockStyleSchema,
});

/**
 * PageStateSchema output.
 */
type PageState = v.InferOutput<typeof PageStateSchema>;

/**
 * The scroll position, and the scroll offset of each element a path names; null where the path no
 * longer leads to an element.
 */
const ScrollOffsetsSchema = v.object({
    scrollY: v.number(),
    scrollTops: v.array(v.nullable(v.number())),
});

/**
 * ScrollOffsetsSchema output.
 */
type ScrollOffsets = v.InferOutput<typeof ScrollOffsetsSchema>;

/**
 * What one wheel turn moved.
 */
interface WheelOutcome {
    /**
     * How far the turn moved the document, in CSS pixels.
     */
    documentMovedPx: number;

    /**
     * Whether an element under the pointer scrolled while the document stayed put.
     */
    innerContainerScrolled: boolean;
}

/**
 * What the mouse wheel did to a phase's page.
 */
export interface PageScrollMeasurement {
    /**
     * How far the wheel moved the document, in CSS pixels; 0 when it stayed put.
     */
    wheelScrolledPx: number;

    /**
     * Whether the wheel scrolled a container under the viewport's centre while the document stayed
     * put, which says nothing about whether the document scrolls.
     */
    innerContainerScrolled: boolean;

    /**
     * Height of the page's content, in CSS pixels, counting what a lock on `body` or on a wrapper
     * clips; no taller than the viewport on a page with nothing to scroll.
     */
    contentHeight: number;

    /**
     * Height of the viewport, in CSS pixels.
     */
    viewportHeight: number;

    /**
     * The scroll-relevant state of `html`.
     */
    html: ScrollLockStyle;

    /**
     * The scroll-relevant state of `body`.
     */
    body: ScrollLockStyle;
}

/**
 * Read the page's state before a wheel turn.
 *
 * @param evaluator - The phase's trusted page evaluator.
 * @returns The parsed state.
 */
async function readPageState(evaluator: TrustedPageEvaluator): Promise<PageState> {
    return v.parse(PageStateSchema, await evaluator.evaluate(PAGE_STATE_READ));
}

/**
 * Read the scroll position and the scroll offsets of the elements the paths name.
 *
 * @param evaluator - The phase's trusted page evaluator.
 * @param paths - DOM paths from `html` of the elements to read.
 * @returns The parsed offsets, one per path.
 */
async function readScrollOffsets(
    evaluator: TrustedPageEvaluator,
    paths: readonly number[][],
): Promise<ScrollOffsets> {
    const expression = `
(function (paths) {
    var root = document.documentElement;
    var at = function (path) {
        var node = root;
        for (var i = 0; node && i < path.length; i += 1) {
            node = node.children[path[i]];
        }
        return node ? node.scrollTop : null;
    };
    return { scrollY: window.scrollY, scrollTops: paths.map(at) };
})(${JSON.stringify(paths)})
`;
    return v.parse(ScrollOffsetsSchema, await evaluator.evaluate(expression));
}

/**
 * Scroll the document instantly to a vertical position, whatever its `scroll-behavior`.
 *
 * The expression yields a value because the isolated-world evaluator refuses one that returns
 * nothing.
 *
 * @param evaluator - The phase's trusted page evaluator.
 * @param top - The vertical position, in CSS pixels.
 */
async function scrollPageTo(evaluator: TrustedPageEvaluator, top: number): Promise<void> {
    await evaluator.evaluate(`(window.scrollTo({ top: ${top}, behavior: 'instant' }), true)`);
}

/**
 * Turn the wheel once where the pointer is and record what it moved.
 *
 * Once something moved, the page gets two frames to answer: a gate that pins the scroll from a
 * `scroll` listener puts the document back within them, and the probe counts where it settled.
 *
 * @param page - The phase's page.
 * @param evaluator - The phase's trusted page evaluator.
 * @param startY - The document's scroll position before the turn.
 * @param chain - The elements under the pointer before the turn; empty to count only the document.
 * @param signal - Aborted once the probe ran out of time.
 * @returns What the turn moved.
 */
async function turnWheel(
    page: Page,
    evaluator: TrustedPageEvaluator,
    startY: number,
    chain: readonly ChainElement[],
    signal: AbortSignal,
): Promise<WheelOutcome> {
    const paths = chain.map((element) => element.path);
    const containerScrolled = (read: ScrollOffsets): boolean =>
        read.scrollTops.some((top, i) => top !== null && top !== chain[i]?.scrollTop);
    const moved = (read: ScrollOffsets): boolean =>
        read.scrollY !== startY || containerScrolled(read);
    await page.mouse.wheel(0, WHEEL_DELTA_PX);
    let read = await readScrollOffsets(evaluator, paths);
    const deadline = Date.now() + WHEEL_SETTLE_TIMEOUT_MS;
    while (!moved(read) && Date.now() < deadline) {
        await delay(WHEEL_POLL_INTERVAL_MS);
        signal.throwIfAborted();
        read = await readScrollOffsets(evaluator, paths);
    }
    if (moved(read)) {
        signal.throwIfAborted();
        await evaluator.evaluate(SETTLE_FRAMES);
        read = await readScrollOffsets(evaluator, paths);
    }
    const documentMovedPx = Math.abs(read.scrollY - startY);
    return {
        documentMovedPx,
        innerContainerScrolled: documentMovedPx === 0 && containerScrolled(read),
    };
}

/**
 * Turn the wheel over the page from its top and record what moved, then return the page to where it
 * was.
 *
 * The page starts from the top, so the turn has room to move it whatever reveal step or capture
 * left it scrolled. The pointer reaches the centre and the page settles before the baseline is
 * read, so hover styles and a gate's answer to the jump are part of it. When the centre moved
 * nothing, a frame or a widget there may have taken the wheel, so a second turn lands near the left
 * edge and counts only the document: a lock on `html` or `body` stops the wheel everywhere.
 *
 * Once the probe ran out of time it stops before its next step and leaves the page alone: the phase
 * has moved on, and a late wheel turn or restore would only act on a page nobody measures.
 *
 * @param page - The phase's page.
 * @param evaluator - The phase's trusted page evaluator.
 * @param logger - Where a failed restore is logged.
 * @param signal - Aborted once the probe ran out of time.
 * @returns The measurement.
 */
async function probePageScroll(
    page: Page,
    evaluator: TrustedPageEvaluator,
    logger: Logger,
    signal: AbortSignal,
): Promise<PageScrollMeasurement> {
    const start = await readPageState(evaluator);
    try {
        signal.throwIfAborted();
        await scrollPageTo(evaluator, 0);
        const centreY = start.viewportHeight / 2;
        signal.throwIfAborted();
        await page.mouse.move(start.viewportWidth / 2, centreY);
        await evaluator.evaluate(SETTLE_FRAMES);
        signal.throwIfAborted();
        const baseline = await readPageState(evaluator);
        signal.throwIfAborted();
        const atCentre = await turnWheel(page, evaluator, baseline.scrollY, baseline.chain, signal);
        let wheelScrolledPx = atCentre.documentMovedPx;
        if (wheelScrolledPx === 0 && !atCentre.innerContainerScrolled) {
            signal.throwIfAborted();
            await page.mouse.move(start.viewportWidth * SECOND_POINT_X_FRACTION, centreY);
            wheelScrolledPx = (await turnWheel(page, evaluator, baseline.scrollY, [], signal))
                .documentMovedPx;
        }
        return {
            wheelScrolledPx,
            innerContainerScrolled: atCentre.innerContainerScrolled,
            contentHeight: baseline.contentHeight,
            viewportHeight: baseline.viewportHeight,
            html: baseline.html,
            body: baseline.body,
        };
    } finally {
        if (!signal.aborted) {
            await scrollPageTo(evaluator, start.scrollY).catch((error: unknown) => {
                logger.warn({ err: error }, 'The page scroll probe could not restore the position');
            });
        }
    }
}

/**
 * Measure what the mouse wheel does to a phase's page, within a time bound.
 *
 * The wheel moves the page and the pointer may trigger hover styles, so the probe runs after every
 * capture and read of the phase.
 *
 * @param page - The phase's page.
 * @param evaluator - The phase's trusted page evaluator.
 * @param logger - Where a failed or late measurement is logged before it is reported as none.
 * @returns The measurement, or null when the page could not be measured in time.
 */
export async function measurePageScroll(
    page: Page,
    evaluator: TrustedPageEvaluator,
    logger: Logger,
): Promise<PageScrollMeasurement | null> {
    const expiry = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
            expiry.abort();
            logger.warn(
                { timeoutMs: PAGE_SCROLL_PROBE_TIMEOUT_MS },
                'The page scroll probe did not finish in time',
            );
            resolve(null);
        }, PAGE_SCROLL_PROBE_TIMEOUT_MS);
    });
    const measurement = probePageScroll(page, evaluator, logger, expiry.signal).catch(
        (error: unknown) => {
            // A probe stopped by the time bound was already reported as late.
            if (!expiry.signal.aborted) {
                logger.warn({ err: error }, 'The page scroll probe could not measure the page');
            }
            return null;
        },
    );
    try {
        return await Promise.race([measurement, timedOut]);
    } finally {
        clearTimeout(timer);
    }
}
