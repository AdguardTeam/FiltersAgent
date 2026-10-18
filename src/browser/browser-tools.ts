import type { Frame } from 'playwright-core';
import type { Logger } from 'pino';
import * as v from 'valibot';
import type { IBrowserSession } from './browser-interfaces';
import type { TraceRecorder } from '../tracer/trace-recorder';
import { MAX_VISION_IMAGE_BYTES } from '../pi/single-shot-input';
import { redactNetworkLog } from './har-redactor';
import { summarizeNetworkLog } from './network-log-inventory';
import { ConsentStrategy, type ReproProfile } from '../types/repro-profile';
import type { ValidationViewportPosition } from '../types/validation';
import { createTrustedPageEvaluator } from './trusted-page-evaluator';
import { AD_SLOT_INSPECTION_EXPRESSION } from './ad-slot-inspector';
import { AdSlotScanResultSchema, type AdSlotScanResult } from '../types/ad-slot-inspection';
import {
    canonicalHttpOrigin,
    defaultHostnameResolver,
    UnsafeNetworkUrlError,
    UnsafeUrlRefusal,
    validatePublicHttpUrl,
    type HostnameResolver,
} from './network-safety';
import { isAgentRefusalFallback } from '../types/browser-fallback-origin';
import {
    classifyNavigationFailure,
    extractBrowserNetworkErrorCode,
    formatNavigationFailure,
    sanitizeNavigationTarget,
} from './navigation-failure';
import {
    stabilizePageForCapture,
    readStableViewportPosition,
    viewportPositionMatches,
    boundedDuration,
    boundedTargetValue,
    roundedGeometry,
    MAX_TARGET_SELECTOR_LENGTH,
    MAX_TARGET_HINT_LENGTH,
    MAX_PAGE_STABILIZATION_TIMEOUT_MS,
    DEFAULT_PAGE_STABILITY_POLL_MS,
    DEFAULT_PAGE_STABILITY_QUIET_MS,
    type PageStabilizationEvidence,
} from './page-stability';
import { applyConsentStrategy } from './consent-interaction';
import {
    ExpressionRejectionKind,
    describeLargeEvaluationResult,
    validateExpression,
} from './expression-validator';
import { writeArtifact, captureFullPageTiles, parseTileWindowArg } from './full-page-tiles';
import { inspectPageState } from './page-state-probe';
import type { PageStateInspection } from '../types/page-state-inspection';
import { BrowserFallbackReason } from '../types/browser-fallback-reason';
import { createNavigationAdmission } from './navigation-admission';
import { RedirectOriginPolicy } from './redirect-origin-policy';

/**
 * Configuration for the browser tool handler factory.
 */
export interface BrowserToolConfig {
    /**
     * The active browser session whose page and logs are used by the tools.
     */
    session: IBrowserSession;

    /**
     * Trace recorder for registering artifact references.
     */
    recorder: TraceRecorder;

    /**
     * Directory where artifacts (screenshots, HAR, DOM) are written.
     */
    artifactsDir: string;

    /**
     * Operational logger mirroring navigation failure facts into the job log.
     */
    logger?: Logger;

    /**
     * Reported issue URL whose origin admits initial top-level navigation.
     */
    allowedOrigin: string;

    /**
     * Retention policy for redirect origins. Defaults to keeping every landing origin.
     */
    redirectOriginPolicy?: RedirectOriginPolicy;

    /**
     * Injectable resolver for public-address checks. Defaults to the operating system resolver.
     */
    resolveHostname?: HostnameResolver;

    /**
     * Number of retries for open_page before declaring the site unreachable. Default 3.
     */
    openPageRetries?: number;

    /**
     * Required quiet DOM/network window before capture. Defaults to 750 milliseconds.
     */
    postNavigationSettleMs?: number;

    /**
     * Maximum navigation-and-stabilization budget for one attempt. Capped at 15 seconds.
     */
    pageStabilizationTimeoutMs?: number;

    /**
     * Interval between bounded DOM/network stability probes. Defaults to 250 milliseconds.
     */
    pageStabilityPollMs?: number;

    /**
     * Maximum character length for evaluate_js expressions. Default
     * {@link MAX_EVALUATE_JS_EXPRESSION_CHARS}.
     */
    evaluateJsMaxLength?: number;

    /**
     * Vertical and horizontal overlap between original-resolution full-page tiles.
     */
    fullPageTileOverlapPx?: number;

    /**
     * Maximum number of original-resolution tiles captured for one page state.
     */
    fullPageTileLimit?: number;

    /**
     * Bounded consent interaction requested by the active reproduction profile.
     */
    consentStrategy?: ReproProfile['consentStrategy'];
}

/**
 * Browser tool handlers returned by the factory, including internal orchestration helpers.
 *
 * Each handler is a function that receives the LLM's parsed arguments and returns a plain result
 * object suitable for JSON serialization.
 */
export interface BrowserToolHandlers {
    /**
     * Navigate the browser to a URL with bounded retries.
     */
    open_page: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

    /**
     * Scroll to an optional target and prove DOM/network stability before the next capture.
     */
    stabilize_page?: (args: Record<string, unknown>) => Promise<PageStabilizationEvidence>;

    /**
     * Capture a detailed viewport screenshot and a full-page context screenshot as PNG artifacts.
     */
    screenshot: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

    /**
     * Capture the full DOM as an HTML artifact and return a text preview.
     */
    get_dom: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

    /**
     * Inspect likely ad slots through a fixed, no-argument isolated-world scan.
     */
    inspect_ad_slots: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

    /**
     * Return a redacted summary of network entries accumulated since the last reset.
     */
    get_network_log: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

    /**
     * Clear the accumulated network log without writing an artifact.
     */
    reset_network_log: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

    /**
     * Return the accumulated console messages from the session.
     */
    get_console_log: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

    /**
     * Return one bounded, redacted snapshot of the page's cookies, storage keys and frames.
     */
    inspect_page_state: (args: Record<string, unknown>) => Promise<PageStateInspection>;

    /**
     * Evaluate a JavaScript expression in the page context (safety-validated).
     */
    evaluate_js: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/**
 * The `errorKind` an evaluate_js expression is refused with when it violates the read-only policy.
 *
 * The session layer's diagnostic quarantine matches this exact token to disable the tool after
 * three refusals in a row, so producer and matcher must spell it identically; it is exported from
 * the producer rather than restated there.
 */
export const EVALUATE_JS_POLICY_REJECTION_KIND = ExpressionRejectionKind.Policy;

/**
 * Longest evaluate_js expression the read-only validator admits, in characters.
 *
 * A focused diagnostic fits; a script long enough to need more is split into several calls. The DOM
 * checks attached to apply_rule are held to the same bound, because the same handler runs them.
 */
export const MAX_EVALUATE_JS_EXPRESSION_CHARS = 2_000;

/**
 * Maximum serialized size of the complete validated ad-slot inspection artifact.
 */
const MAX_AD_SLOT_INSPECTION_ARTIFACT_BYTES = 4 * 1024 * 1024;

/**
 * Fixed maximum size of one browser-tool result embedded into model context.
 */
const MAX_MODEL_TOOL_RESULT_BYTES = 6 * 1024;

/**
 * Maximum high-priority slot identifiers included in the model-facing ad-slot summary.
 */
const MAX_MODEL_AD_SLOT_IDENTIFIERS = 6;

/**
 * Build a grouped, compact inventory while preserving the complete scan in a trace artifact.
 *
 * @param scan - Complete validated ad-slot scan.
 * @param artifactId - Opaque identity of the complete JSON artifact.
 * @returns Bounded model-facing ad-slot summary.
 */
function compactAdSlotInventory(
    scan: AdSlotScanResult,
    artifactId: string,
): Record<string, unknown> {
    const visibilityStates: Record<string, number> = {};
    const contentStates: Record<string, number> = {};
    const signalGroups: Record<string, number> = {};
    for (const slot of scan.slots) {
        const visibility = slot.element.visibility.state;
        visibilityStates[visibility] = (visibilityStates[visibility] ?? 0) + 1;
        contentStates[slot.contentState] = (contentStates[slot.contentState] ?? 0) + 1;
        for (const signal of slot.matchedSignals) {
            signalGroups[signal] = (signalGroups[signal] ?? 0) + 1;
        }
    }
    const topSlots = scan.slots.slice(0, MAX_MODEL_AD_SLOT_IDENTIFIERS).map((slot) => ({
        tag: slot.element.tag,
        id: slot.element.id,
        classes: slot.element.classes.slice(0, 3),
        visibility: slot.element.visibility.state,
        occupiesLayoutSpace: slot.element.visibility.occupiesLayoutSpace,
        contentState: slot.contentState,
        matchedSignals: slot.matchedSignals,
        creativeSignals: slot.creativeSignals,
        rect: {
            top: roundedGeometry(slot.element.viewportRect.top),
            width: roundedGeometry(slot.element.viewportRect.width),
            height: roundedGeometry(slot.element.viewportRect.height),
        },
    }));
    return {
        scope: scan.scope,
        candidateCount: scan.candidateCount,
        returnedCount: scan.returnedCount,
        truncated: scan.truncated,
        artifactId,
        stateGroups: {
            visibility: visibilityStates,
            content: contentStates,
            matchedSignals: signalGroups,
        },
        topSlots,
        metaHint:
            `Complete ad-slot scan is persisted. Use get_detail("${artifactId}") with a key or ` +
            'limit only for a focused ancestor or slot follow-up.',
    };
}

/**
 * Record why we declined to open a URL, keeping our refusal distinct from the target's.
 *
 * A DNS answer we could not obtain is neither: the host may be gone or our own resolver may be, and
 * nothing observed here separates the two, so it stays unattributed rather than being published as
 * a fact about the reporter's site.
 *
 * @param error - Rejection thrown by the URL safety check.
 * @returns Exact fallback reason for the refusal.
 */
function refusalFallbackReason(error: unknown): BrowserFallbackReason {
    if (!(error instanceof UnsafeNetworkUrlError)) {
        return BrowserFallbackReason.UnsafeTargetUrl;
    }
    if (error.refusal === UnsafeUrlRefusal.OriginMismatch) {
        return BrowserFallbackReason.NavigationOffOrigin;
    }
    if (error.refusal === UnsafeUrlRefusal.DnsUnresolved) {
        return BrowserFallbackReason.TargetDnsUnresolved;
    }
    return BrowserFallbackReason.UnsafeTargetUrl;
}

/**
 * Create all browser tool handler functions bound to a session and recorder.
 *
 * The returned handlers implement the tool contract: they accept the LLM's parsed JSON arguments
 * and return a plain result object. Sensitive data (HAR, storage) is redacted before return or disk
 * write.
 *
 * @param config - Tool configuration with session, recorder, and output directory.
 * @returns An object mapping tool names to handler functions.
 */
export function createBrowserToolHandlers(config: BrowserToolConfig): BrowserToolHandlers {
    const { session, artifactsDir, recorder } = config;
    const retries = config.openPageRetries ?? 3;
    const pageStabilizationTimeoutMs = boundedDuration(
        config.pageStabilizationTimeoutMs,
        MAX_PAGE_STABILIZATION_TIMEOUT_MS,
        25,
        MAX_PAGE_STABILIZATION_TIMEOUT_MS,
    );
    const pageStabilityPollMs = boundedDuration(
        config.pageStabilityPollMs,
        DEFAULT_PAGE_STABILITY_POLL_MS,
        25,
        1_000,
    );
    const pageStabilityQuietMs = boundedDuration(
        config.postNavigationSettleMs,
        DEFAULT_PAGE_STABILITY_QUIET_MS,
        0,
        Math.min(3_000, pageStabilizationTimeoutMs),
    );
    const consentStrategy = config.consentStrategy ?? ConsentStrategy.Untouched;
    const logger = config.logger;
    const maxEvalLen = config.evaluateJsMaxLength ?? MAX_EVALUATE_JS_EXPRESSION_CHARS;
    const resolveHostname = config.resolveHostname ?? defaultHostnameResolver;
    const inFlightDnsResolutions = new Map<string, Promise<string[]>>();
    const resolveHostnameFresh: HostnameResolver = (hostname) => {
        const inFlight = inFlightDnsResolutions.get(hostname);
        if (inFlight) {
            return inFlight;
        }
        const pending = resolveHostname(hostname).finally(() => {
            if (inFlightDnsResolutions.get(hostname) === pending) {
                inFlightDnsResolutions.delete(hostname);
            }
        });
        inFlightDnsResolutions.set(hostname, pending);
        return pending;
    };
    const admission = createNavigationAdmission({
        allowedOrigin: config.allowedOrigin,
        redirectOriginPolicy: config.redirectOriginPolicy ?? RedirectOriginPolicy.KeepEveryLanding,
        resolveHostname: resolveHostnameFresh,
        logger,
    });

    return {
        /**
         * Navigate to a URL with bounded retries on failure.
         *
         * @param args - Tool arguments with `url` property.
         * @returns Page URL, title, and status code on success; error on failure.
         */
        async open_page(args: Record<string, unknown>) {
            admission.resetLoad();
            const url = typeof args.url === 'string' ? args.url : '';
            if (!url) {
                return { error: 'url is required' };
            }
            if (admission.sessionOrigins().length === 0) {
                return {
                    error: `navigation blocked: ${admission.configurationError ?? 'allowed origin is invalid'}`,
                    fallbackReason: BrowserFallbackReason.UnsafeTargetUrl,
                };
            }
            try {
                await validatePublicHttpUrl(url, {
                    expectedOrigins: admission.sessionOrigins(),
                    resolveHostname: resolveHostnameFresh,
                });
            } catch (error) {
                return {
                    error: `navigation blocked: ${(error as Error).message}`,
                    fallbackReason: refusalFallbackReason(error),
                };
            }

            const page = session.getPage();
            let lastError: string | undefined;
            let lastFallbackReason: BrowserFallbackReason = BrowserFallbackReason.NavigationTimeout;
            const frameNavigations: string[] = [];
            const recordFrameNavigation = (frame: Frame) => {
                if (frame === page.mainFrame()) {
                    frameNavigations.push(frame.url());
                }
            };
            page.on('framenavigated', recordFrameNavigation);
            await admission.installGuard(page);
            try {
                for (let attempt = 0; attempt < retries; attempt++) {
                    admission.takeBlockedNavigationError();
                    let blockedNavigationError: string | undefined;
                    try {
                        const attemptStartedAt = Date.now();
                        admission.openWindow();
                        const response = await page.goto(url, {
                            waitUntil: 'domcontentloaded',
                            timeout: pageStabilizationTimeoutMs,
                        });
                        blockedNavigationError = admission.takeBlockedNavigationError();
                        if (blockedNavigationError) {
                            throw new Error(blockedNavigationError);
                        }
                        const finalUrl = page.url();
                        // The route sees a script or meta redirect as a new request; an HTTP
                        // redirect is followed by the browser and only its landing shows here.
                        await admission.admitMainNavigation(finalUrl);
                        const statusCode = response?.status() ?? 200;
                        const fallbackReason =
                            statusCode === 451
                                ? BrowserFallbackReason.GeoBlocked
                                : statusCode === 404
                                  ? BrowserFallbackReason.NotFound
                                  : statusCode >= 400
                                    ? BrowserFallbackReason.HttpBlocked
                                    : undefined;
                        if (fallbackReason) {
                            return {
                                url: finalUrl,
                                title: await page.title(),
                                statusCode,
                                error: `main document returned HTTP ${statusCode}`,
                                fallbackReason,
                            };
                        }
                        const elapsedNavigationMs = Math.max(0, Date.now() - attemptStartedAt);
                        const remainingAttemptMs = pageStabilizationTimeoutMs - elapsedNavigationMs;
                        if (remainingAttemptMs < 25) {
                            throw new Error(
                                `page did not stabilize within ${pageStabilizationTimeoutMs}ms`,
                            );
                        }
                        const stabilization = await stabilizePageForCapture(session, {
                            timeoutMs: remainingAttemptMs,
                            pollMs: pageStabilityPollMs,
                            quietMs: pageStabilityQuietMs,
                            target: {
                                selector: boundedTargetValue(
                                    args.targetSelector,
                                    MAX_TARGET_SELECTOR_LENGTH,
                                ),
                                textHint: boundedTargetValue(
                                    args.targetHint,
                                    MAX_TARGET_HINT_LENGTH,
                                ),
                            },
                        });
                        admission.closeWindow();
                        if (stabilization.status !== 'stable') {
                            throw new Error(
                                stabilization.detail ?? 'page did not stabilize before capture',
                            );
                        }
                        const consent = await applyConsentStrategy(
                            session,
                            consentStrategy,
                            pageStabilizationTimeoutMs,
                            pageStabilityPollMs,
                            pageStabilityQuietMs,
                        );
                        blockedNavigationError = admission.takeBlockedNavigationError();
                        if (blockedNavigationError) {
                            return {
                                url: page.url(),
                                title: await page.title(),
                                statusCode,
                                error: `navigation blocked after consent setup: ${blockedNavigationError}`,
                                fallbackReason: BrowserFallbackReason.NavigationOffOrigin,
                                consent,
                            };
                        }
                        const postConsentUrl = page.url();
                        try {
                            if (
                                !admission
                                    .currentLoadOrigins()
                                    .includes(canonicalHttpOrigin(postConsentUrl))
                            ) {
                                throw new Error(
                                    `URL origin must remain on ${admission.currentLoadOrigins().join(', ')} ` +
                                        'after consent setup',
                                );
                            }
                        } catch (error) {
                            return {
                                url: postConsentUrl,
                                title: await page.title(),
                                statusCode,
                                error:
                                    'navigation blocked after consent setup: ' +
                                    (error as Error).message,
                                fallbackReason: BrowserFallbackReason.NavigationOffOrigin,
                                consent,
                            };
                        }
                        return {
                            url: postConsentUrl,
                            title: await page.title(),
                            statusCode,
                            stabilization,
                            consent,
                        };
                    } catch (err) {
                        admission.closeWindow();
                        blockedNavigationError ??= admission.takeBlockedNavigationError();
                        lastError = blockedNavigationError ?? (err as Error).message;
                        lastFallbackReason = blockedNavigationError
                            ? BrowserFallbackReason.NavigationOffOrigin
                            : err instanceof UnsafeNetworkUrlError
                              ? refusalFallbackReason(err)
                              : classifyNavigationFailure(err);
                        if (blockedNavigationError) {
                            break;
                        }
                        if (attempt < retries - 1) {
                            await page.waitForTimeout(1_000 * (attempt + 1));
                        }
                    } finally {
                        admission.closeWindow();
                    }
                }
                const failure = {
                    error: isAgentRefusalFallback(lastFallbackReason)
                        ? `navigation blocked: ${lastError}`
                        : formatNavigationFailure(lastFallbackReason, lastError, url, retries),
                    fallbackReason: lastFallbackReason,
                    targetUrl: sanitizeNavigationTarget(url),
                    attempts: retries,
                    ...(extractBrowserNetworkErrorCode(lastError)
                        ? { networkErrorCode: extractBrowserNetworkErrorCode(lastError) }
                        : {}),
                };
                logger?.warn(
                    {
                        targetUrl: url,
                        fallbackReason: lastFallbackReason,
                        frameNavigations,
                        error: failure.error.slice(0, 500),
                    },
                    'open_page navigation failed',
                );
                return failure;
            } finally {
                page.off('framenavigated', recordFrameNavigation);
            }
        },

        /**
         * Prove capture stability after an optional bounded target scroll.
         *
         * @param args - Optional `targetSelector` and `targetHint` values.
         * @returns Typed stability and target-scroll evidence.
         */
        async stabilize_page(args: Record<string, unknown>) {
            return stabilizePageForCapture(session, {
                timeoutMs: pageStabilizationTimeoutMs,
                pollMs: pageStabilityPollMs,
                quietMs: pageStabilityQuietMs,
                target: {
                    selector: boundedTargetValue(args.targetSelector, MAX_TARGET_SELECTOR_LENGTH),
                    textHint: boundedTargetValue(args.targetHint, MAX_TARGET_HINT_LENGTH),
                },
            });
        },

        /**
         * Capture a detailed viewport screenshot plus a full-page context image.
         *
         * The viewport artifact remains the primary ID so vision models do not lose the local
         * detail of very tall pages through full-page downscaling.
         *
         * @param args - Set `captureTiles=true` for overlapping original-resolution evidence.
         * @returns Primary and full-page artifact IDs, format, and viewport dimensions.
         */
        async screenshot(args: Record<string, unknown>) {
            const page = session.getPage();
            let viewportBuffer: Buffer | undefined;
            let viewportPosition: ValidationViewportPosition | undefined;
            for (let attempt = 0; attempt < 3; attempt++) {
                const before = await readStableViewportPosition(page);
                if (!before) {
                    continue;
                }
                const candidateBuffer = await page.screenshot({ fullPage: false, type: 'png' });
                const after = await readStableViewportPosition(page);
                if (after && viewportPositionMatches(before, after)) {
                    viewportBuffer = candidateBuffer;
                    viewportPosition = after;
                    break;
                }
            }
            if (!viewportBuffer || !viewportPosition) {
                return {
                    error: 'viewport position changed during capture',
                    viewportPositionError:
                        'could not prove a stable viewport position across three capture attempts',
                    format: 'png',
                    viewport: page.viewportSize(),
                };
            }
            const id = writeArtifact(artifactsDir, 'png', viewportBuffer, 'screenshot', recorder);
            let fullPageArtifactId: string | undefined;
            let fullPageError: string | undefined;
            try {
                const fullPageBuffer = await page.screenshot({ fullPage: true, type: 'png' });
                if (fullPageBuffer.length <= MAX_VISION_IMAGE_BYTES) {
                    fullPageArtifactId = writeArtifact(
                        artifactsDir,
                        'png',
                        fullPageBuffer,
                        'screenshot-full-page',
                        recorder,
                    );
                } else {
                    // A PNG overview this large exceeds the vision request ceiling and the
                    // per-artifact evidence limit; degrade the context overview to JPEG while
                    // the original-resolution PNG tiles keep the exact coverage proof.
                    const jpegBuffer = await page.screenshot({
                        fullPage: true,
                        type: 'jpeg',
                        quality: 60,
                    });
                    fullPageArtifactId = writeArtifact(
                        artifactsDir,
                        'jpg',
                        jpegBuffer,
                        'screenshot-full-page',
                        recorder,
                    );
                }
            } catch (error) {
                fullPageError = String((error as Error).message).slice(0, 500);
            }
            const tileCoverage =
                args.captureTiles === true
                    ? await captureFullPageTiles(
                          page,
                          artifactsDir,
                          recorder,
                          config.fullPageTileOverlapPx,
                          config.fullPageTileLimit,
                          pageStabilizationTimeoutMs,
                          parseTileWindowArg(args.tileWindow),
                      )
                    : undefined;
            const viewport = page.viewportSize();
            return {
                artifactId: id,
                fullPageArtifactId,
                fullPageError,
                tileCoverage,
                format: 'png',
                viewport,
                viewportPosition,
            };
        },

        /**
         * Capture the full DOM as an HTML artifact and return a text preview.
         *
         * @returns Artifact ID, HTML length, and visible text preview.
         */
        async get_dom() {
            const page = session.getPage();
            const html = await page.content();
            const visibleText = await page.evaluate('document.body.innerText.slice(0, 500)');
            const id = writeArtifact(artifactsDir, 'html', html, 'dom', recorder);
            return { artifactId: id, htmlLength: html.length, visibleTextPreview: visibleText };
        },

        /**
         * Inspect likely ad slots through a fixed read-only expression in an isolated world.
         *
         * Model arguments are intentionally ignored. The page result is parsed through the bounded
         * Valibot schema before it can be persisted or returned.
         *
         * @returns Validated typed slot facts and the JSON artifact ID, or a bounded error.
         */
        async inspect_ad_slots() {
            const page = session.getPage();
            const rawResult = await (
                await createTrustedPageEvaluator(page, { logger })
            ).evaluate(AD_SLOT_INSPECTION_EXPRESSION);
            const parsed = v.safeParse(AdSlotScanResultSchema, rawResult);
            if (!parsed.success) {
                return { error: 'ad-slot inspection returned an invalid bounded result' };
            }
            const boundedResult = parsed.output;
            const serialized = JSON.stringify(boundedResult, null, 2);
            if (Buffer.byteLength(serialized) > MAX_AD_SLOT_INSPECTION_ARTIFACT_BYTES) {
                return {
                    error: 'ad-slot inspection exceeded the 4 MiB complete-artifact limit',
                };
            }
            const artifactId = writeArtifact(
                artifactsDir,
                'json',
                serialized,
                'ad-slot-inspection',
                recorder,
            );
            return compactAdSlotInventory(boundedResult, artifactId);
        },

        /**
         * Return a redacted summary of network entries accumulated since the last reset and write
         * the full redacted HAR as a JSON artifact.
         *
         * @returns Artifact ID, typed HAR evidence reference, request count, blocked count, and ad
         *   request URLs.
         */
        async get_network_log() {
            const rawLog = session.getNetworkLog();
            const redacted = redactNetworkLog(rawLog);
            const id = writeArtifact(
                artifactsDir,
                'json',
                JSON.stringify(redacted, null, 2),
                'har',
                recorder,
            );
            const inventory = summarizeNetworkLog(redacted, config.allowedOrigin);
            return {
                artifactId: id,
                evidenceRef: `artifact:har:${id}`,
                requestCount: inventory.requestCount,
                blockedCount: inventory.blockedCount,
                byType: inventory.byType,
                byHost: inventory.byHost,
                requests: inventory.requests,
                blocked: inventory.blocked,
                omittedRequestCount: inventory.omittedRequestCount,
            };
        },

        /**
         * Clear the accumulated network log so the next artifact covers only one phase.
         *
         * @returns Confirmation that the network log was reset.
         */
        async reset_network_log() {
            session.resetNetworkLog();
            return { reset: true };
        },

        /**
         * Return the accumulated `console`-event messages from the session, with what they cover.
         *
         * @returns The session's console coverage and every message collected since session start.
         */
        async get_console_log() {
            return { consoleCoverage: session.consoleCoverage, messages: session.getConsoleLog() };
        },

        /**
         * Return one bounded, redacted snapshot of the page's cookies, storage keys and frames.
         *
         * Cookie values are never collected, storage values are redacted and truncated, and every
         * section is capped; see `page-state-probe.ts` for the bounds and why each one holds.
         *
         * @returns Cookie identities, redacted storage, the frame inventory, and their counts.
         */
        async inspect_page_state() {
            return inspectPageState(session.getPage());
        },

        /**
         * Evaluate a read-only JavaScript diagnostic in the page context.
         *
         * Expressions that write page state — assign, update or delete anything but the variables
         * and literals they declare, mutate DOM/browser state, schedule callbacks, execute dynamic
         * code, access sensitive storage, navigate, or make requests — are rejected. An expression
         * that does not parse is refused too, as a syntax error, and never reaches the page.
         *
         * @param args - Tool arguments with `expression` property.
         * @returns The evaluation result, or an error if validation failed.
         */
        async evaluate_js(args: Record<string, unknown>) {
            const expression = typeof args.expression === 'string' ? args.expression : '';
            if (!expression) {
                return { error: 'expression is required' };
            }
            const rejection = validateExpression(expression, maxEvalLen);
            if (rejection) {
                return { error: rejection.message, errorKind: rejection.kind };
            }
            const page = session.getPage();
            const result = await page.evaluate(expression);
            let serialized: string;
            try {
                serialized = JSON.stringify({ result });
            } catch {
                return {
                    error: 'evaluate_js returned a non-serializable result',
                    errorKind: 'result_serialization_failed',
                };
            }
            if (serialized === undefined) {
                serialized = JSON.stringify({ result: null });
            }
            const resultBytes = Buffer.byteLength(serialized);
            if (resultBytes <= MAX_MODEL_TOOL_RESULT_BYTES) {
                return { result };
            }
            const artifactId = writeArtifact(
                artifactsDir,
                'json',
                serialized,
                'evaluate-js-result',
                recorder,
            );
            return {
                artifactId,
                resultBytes,
                resultSummary: describeLargeEvaluationResult(result),
                metaHint:
                    `Complete evaluate_js result is persisted. Use get_detail("${artifactId}") ` +
                    'with a key or limit for a focused slice.',
            };
        },
    };
}
