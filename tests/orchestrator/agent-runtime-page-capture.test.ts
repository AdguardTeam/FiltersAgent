import { describe, expect, it } from 'vitest';
import {
    incompleteCaptureRefusal,
    readScreenshotCapture,
} from '../../src/orchestrator/agent-runtime-page-capture';

/**
 * Viewport height of the captures below; the default tile window spans five of them.
 */
const VIEWPORT_HEIGHT = 1_080;

/**
 * One `screenshot` result whose tiles cover the default first five screens of the document.
 *
 * @param documentHeight - Height of the captured document.
 * @param overviewCaptured - Whether the browser captured the full-page overview.
 * @returns The screenshot tool's result.
 */
function windowedCapture(documentHeight: number, overviewCaptured: boolean) {
    const tiles = Array.from({ length: 5 }, (_, index) => ({
        artifactId: `tile-${index}`,
        index,
        x: 0,
        y: index * VIEWPORT_HEIGHT,
        width: 1_920,
        height: VIEWPORT_HEIGHT,
        landmark: `Screen ${index + 1}`,
    }));
    return {
        artifactId: 'viewport',
        ...(overviewCaptured ? { fullPageArtifactId: 'overview' } : {}),
        tileCoverage: {
            window: { fromY: 0, toY: 5 * VIEWPORT_HEIGHT },
            windowDefaulted: true,
            complete: true,
            documentWidth: 1_920,
            documentHeight,
            viewportWidth: 1_920,
            viewportHeight: VIEWPORT_HEIGHT,
            overlapPx: 0,
            tiles,
        },
    };
}

describe('readScreenshotCapture', () => {
    // The tiles of a long page cover its first screens; the overview shows the rest. Chromium
    // cannot capture an overview of a page about 17,500 px and taller, and one that tall is too
    // narrow for vision to read anyway, so there the tile window is all anyone could inspect.
    it.each([
        {
            page: 'a page too tall to read whole, without an overview',
            height: 17_811,
            overview: false,
        },
        { page: 'a readable page with its overview', height: 8_000, overview: true },
    ])(
        'counts the tile window of $page as seen once vision inspects it',
        ({ height, overview }) => {
            const facts = readScreenshotCapture(windowedCapture(height, overview), () => 1_024);

            expect(facts.coverageComplete).toBe(true);
            expect(facts.requiredArtifactIds).toEqual(
                expect.arrayContaining(['tile-0', 'tile-1', 'tile-2', 'tile-3', 'tile-4']),
            );
        },
    );

    it('does not count the tile window of a readable page as seen without its overview', () => {
        const facts = readScreenshotCapture(windowedCapture(8_000, false), () => 1_024);

        expect(facts.coverageComplete).toBe(false);
        expect(facts.requiredArtifactIds).toEqual([]);
    });
});

describe('incompleteCaptureRefusal', () => {
    it('names the window the tiles cover and offers no overview the browser never captured', () => {
        const refusal = incompleteCaptureRefusal(windowedCapture(8_000, false));

        expect(refusal).toMatchObject({ retryable: false });
        expect(refusal.error).toContain(`y=0..${5 * VIEWPORT_HEIGHT}`);
        expect(refusal.error).not.toContain('full-page overview');
    });
});
