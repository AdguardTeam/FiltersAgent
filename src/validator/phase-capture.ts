import * as v from 'valibot';
import type { BrowserToolHandlers } from '../browser/browser-tools';
import type { TraceRecorder } from '../tracer/trace-recorder';
import type { Logger } from '../logger/logger';
import { TraceEventType } from '../types/trace';
import {
    PhaseLabel,
    FullPageTileCoverageSchema,
    type PhaseResult,
    type FullPageTileWindow,
} from '../types/validation';
import { checkAntiAdblock } from './anti-adblock-check';
import { measureElementTileWindow, windowFromPageTop } from './element-tile-window';
import type { Page } from 'playwright-core';
import type { TrustedPageEvaluator } from '../browser/trusted-page-evaluator';
import type { BrowserFallbackReason } from '../types/browser-fallback-reason';
import { settleLazyContent, type PageMaterialization } from './page-materialization';
import { withTileWindowMap } from '../browser/tile-window-map';

/**
 * Trace phase naming a phase capture whose viewport screenshot failed.
 */
const VIEWPORT_SCREENSHOT_TRACE_PHASE = 'phase_viewport_screenshot';

/**
 * Configuration for a single phase of validation.
 */
export interface PhaseConfig {
    /**
     * The browser tool handlers to use for this phase.
     */
    handlers: BrowserToolHandlers;

    /**
     * The Playwright Page object to operate on.
     */
    page: Page;

    /**
     * Directory where artifacts (screenshots, HAR, DOM) are written.
     */
    artifactsDir: string;

    /**
     * The phase label (A, B, or C).
     */
    phase: PhaseLabel;

    /**
     * The URL to navigate to.
     */
    url: string;

    /**
     * Runner-owned evaluator isolated from website main-world JavaScript.
     */
    trustedPageEvaluator: TrustedPageEvaluator;

    /**
     * Optional CSS selector of the ad element to probe.
     */
    adElementSelector?: string;

    /**
     * Optional document-space vertical span restricting original-resolution tile capture.
     *
     * Candidate validations localize the symptom element first, so capturing the whole document is
     * pure cost on tall pages; the span bounds the tile plan to the symptom neighborhood, and the
     * candidate review answers for that span, with the full-page overview only as its map.
     */
    tileWindow?: FullPageTileWindow;

    /**
     * Whether a window measured around the target also covers the first screens of the page, for a
     * candidate that can break the page away from its target.
     */
    tileWindowFromTop?: boolean;

    /**
     * Optional reveal steps the host replays identically in every phase.
     *
     * Some symptoms exist only once the page has waited or been touched: a popup that opens a few
     * seconds after load, a player hidden behind an age dialog. A phase that never waits or
     * interacts observes a page the report is not about. The replay runs after navigation and
     * before any capture, which is the only point at which all three phases have reached the same
     * state by the same route.
     *
     * Must record its own failures rather than reject: a page that died mid-interaction still has
     * captures worth comparing, and rejecting here would discard them along with the evidence of
     * what the interaction did.
     */
    interact?: () => Promise<void>;

    /**
     * Optional bounded lazy-content materialization: a scroll pass that waits for the document
     * height to settle. It runs before the reveal steps and every capture, so phases of one
     * experiment are captured in the same load state rather than wherever the site's lazy loading
     * happened to be, and nothing the scroll does closes what the reveal steps opened.
     */
    materialize?: () => Promise<PageMaterialization>;

    /**
     * Whether this phase must capture overlapping original-resolution tiles for vision review.
     */
    captureVisualTiles?: boolean;

    /**
     * Whether this phase also captures the tile window map a candidate review shows in place of an
     * overview too tall to read; only the baseline and candidate phases are reviewed.
     */
    captureTileWindowMap?: boolean;

    /**
     * Run logger that also gets a failed tile window map capture.
     */
    logger?: Logger;

    /**
     * Trace recorder for logging phase events.
     */
    recorder: TraceRecorder;
}

/**
 * Capture a single validation phase in the filtering state the environment already established.
 *
 * The phase applies no rules itself: the blocker owns the filtering state. It navigates, loads lazy
 * content, replays the reveal steps, captures screenshot, HAR, and DOM artifacts, then records
 * whether an anti-adblock response is present.
 *
 * @param config - The phase configuration.
 * @returns The PhaseResult for this phase.
 */
export async function runPhase(config: PhaseConfig): Promise<PhaseResult> {
    config.recorder.record(TraceEventType.PhaseStart, { phase: config.phase, url: config.url });
    await config.handlers.reset_network_log({});

    // ── Navigate ─────────────────────────────────────────────────────────
    const openResult = await config.handlers.open_page({ url: config.url });

    if (openResult.error) {
        config.recorder.record(TraceEventType.PhaseEnd, {
            phase: config.phase,
            error: openResult.error,
        });
        return {
            phase: config.phase,
            screenshotArtifactId: '',
            harArtifactId: '',
            domArtifactId: '',
            url: config.url,
            appliedRules: [],
            antiAdblockDetected: false,
            error: String(openResult.error),
            ...(openResult.fallbackReason === undefined
                ? {}
                : { navigationFallbackReason: openResult.fallbackReason as BrowserFallbackReason }),
        };
    }

    // ── Load lazy content the same way in every phase, before the reveal steps ──
    if (config.materialize) {
        await settleLazyContent(config.phase, config.materialize, config.recorder);
    }

    // ── Replay the reveal steps before every capture ─────────────────────
    if (config.interact) {
        await config.interact();
    }

    // ── Capture artifacts ────────────────────────────────────────────────
    let tileWindow = config.tileWindow;
    if (!tileWindow && config.captureVisualTiles === true && config.adElementSelector) {
        const viewportHeight =
            typeof config.page.viewportSize === 'function'
                ? (config.page.viewportSize()?.height ?? 0)
                : 0;
        const measured = await measureElementTileWindow(
            config.trustedPageEvaluator,
            config.adElementSelector,
            viewportHeight,
            config.recorder,
        );
        tileWindow =
            measured !== undefined && config.tileWindowFromTop === true
                ? windowFromPageTop(measured, viewportHeight)
                : measured;
    }
    const screenshotResult = await config.handlers.screenshot({
        captureTiles: config.captureVisualTiles === true,
        ...(tileWindow ? { tileWindow } : {}),
    });
    const screenshotRecord = screenshotResult as Record<string, unknown>;
    if (screenshotRecord.error !== undefined) {
        // Judged later, the phase only says it has no viewport; the trace keeps why.
        config.recorder.record(TraceEventType.Error, {
            phase: VIEWPORT_SCREENSHOT_TRACE_PHASE,
            validationPhase: config.phase,
            error: String(screenshotRecord.error),
            viewportPositionError: screenshotRecord.viewportPositionError,
        });
    }
    const harResult = await config.handlers.get_network_log({});
    const domResult = await config.handlers.get_dom({});

    const harRecord = harResult as Record<string, unknown>;
    const domRecord = domResult as Record<string, unknown>;
    const screenshotArtifactValue = screenshotRecord.artifactId;
    const fullPageArtifactValue = screenshotRecord.fullPageArtifactId;
    const parsedTileCoverage = v.safeParse(
        FullPageTileCoverageSchema,
        screenshotRecord.tileCoverage,
    );
    const capturedTileCoverage = parsedTileCoverage.success ? parsedTileCoverage.output : undefined;
    const tileCoverage =
        config.captureTileWindowMap === true && capturedTileCoverage !== undefined
            ? await withTileWindowMap(
                  config.page,
                  config.artifactsDir,
                  config.recorder,
                  capturedTileCoverage,
                  config.logger,
              )
            : capturedTileCoverage;
    const harArtifactValue = harRecord.artifactId;
    const domArtifactValue = domRecord.artifactId;

    // ── Collect the anti-adblock observation ─────────────────────────────
    const antiAdblockDetected = await checkAntiAdblock(config.trustedPageEvaluator);

    config.recorder.record(TraceEventType.PhaseEnd, {
        phase: config.phase,
        url: openResult.url || config.url,
        antiAdblockDetected,
    });

    return {
        phase: config.phase,
        screenshotArtifactId:
            typeof screenshotArtifactValue === 'string' ? screenshotArtifactValue : '',
        fullPageScreenshotArtifactId:
            typeof fullPageArtifactValue === 'string' ? fullPageArtifactValue : undefined,
        tileCoverage,
        harArtifactId: typeof harArtifactValue === 'string' ? harArtifactValue : '',
        domArtifactId: typeof domArtifactValue === 'string' ? domArtifactValue : '',
        url: String(openResult.url || config.url),
        appliedRules: [],
        antiAdblockDetected,
    };
}
