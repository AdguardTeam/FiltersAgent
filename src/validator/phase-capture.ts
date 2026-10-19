import * as v from 'valibot';
import type { BrowserToolHandlers } from '../browser/browser-tools';
import type { TraceRecorder } from '../tracer/trace-recorder';
import { TraceEventType } from '../types/trace';
import {
    PhaseLabel,
    FullPageTileCoverageSchema,
    type PhaseResult,
    type FullPageTileWindow,
} from '../types/validation';
import { checkAntiAdblock } from './anti-adblock-check';
import { measureElementTileWindow } from './element-tile-window';
import type { Page } from 'playwright-core';
import type { TrustedPageEvaluator } from '../browser/trusted-page-evaluator';

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
     * pure cost on tall pages; the span bounds the tile plan to the symptom neighborhood while the
     * full-page overview keeps the global context.
     */
    tileWindow?: FullPageTileWindow;

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
     * Whether this phase must capture overlapping original-resolution tiles for vision review.
     */
    captureVisualTiles?: boolean;

    /**
     * Trace recorder for logging phase events.
     */
    recorder: TraceRecorder;
}

/**
 * Capture a single validation phase in the filtering state the environment already established.
 *
 * The phase applies no rules itself: the blocker owns the filtering state. It navigates, replays
 * the reveal steps, captures screenshot, HAR, and DOM artifacts, then records whether an
 * anti-adblock response is present.
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
        };
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
        tileWindow = await measureElementTileWindow(
            config.trustedPageEvaluator,
            config.adElementSelector,
            viewportHeight,
            config.recorder,
        );
    }
    const screenshotResult = await config.handlers.screenshot({
        captureTiles: config.captureVisualTiles === true,
        ...(tileWindow ? { tileWindow } : {}),
    });
    const harResult = await config.handlers.get_network_log({});
    const domResult = await config.handlers.get_dom({});

    const screenshotRecord = screenshotResult as Record<string, unknown>;
    const harRecord = harResult as Record<string, unknown>;
    const domRecord = domResult as Record<string, unknown>;
    const screenshotArtifactValue = screenshotRecord.artifactId;
    const fullPageArtifactValue = screenshotRecord.fullPageArtifactId;
    const parsedTileCoverage = v.safeParse(
        FullPageTileCoverageSchema,
        screenshotRecord.tileCoverage,
    );
    const tileCoverage = parsedTileCoverage.success ? parsedTileCoverage.output : undefined;
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
