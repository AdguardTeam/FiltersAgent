import { rmSync } from 'node:fs';
import type { Browser, BrowserContext, Page, Request } from 'playwright-core';
import type { Logger } from 'pino';
import type {
    IBrowserEngine,
    IBrowserSession,
    NetworkRequestEntry,
    ConsoleCoverage,
    ConsoleMessageEntry,
} from './browser-interfaces';
import {
    forceKillBrowserProcessesByMarker,
    runBoundedBrowserClose,
    type BrowserCloseTimings,
} from './bounded-close';
import { forceKillBrowserProcessTree } from './browser-kill-handle';
import type { PreparedStrictBrowserRoute } from './strict-browser-route';
import type { ExtensionManifestVersion } from '../environment/extension-preparation';
import type { ReproProfile } from '../types/repro-profile';
import type { FirefoxPolicies } from './firefox-policies';
import { launchSessionBrowser, type LaunchedSessionPieces } from './launch-wiring';
import { BrowserConfigurationError } from './browser-launch-errors';

export {
    BrowserConfigurationError,
    BrowserLaunchBoundary,
    BrowserLaunchError,
    SettingsFailureReason,
} from './browser-launch-errors';

/**
 * Configuration for creating a BrowserSession.
 */
export interface BrowserSessionConfig {
    /**
     * The browser engine abstraction (CloakBrowser, mock, etc.).
     */
    engine: IBrowserEngine;

    /**
     * Pino logger for operational lifecycle events.
     */
    logger: Logger;

    /**
     * The reproduction profile governing viewport, locale, timezone.
     */
    reproProfile: ReproProfile;

    /**
     * Directory where screenshots, HAR, and DOM snapshots are written.
     */
    artifactsDir: string;

    /**
     * Whether to launch the browser in headless mode.
     */
    headless: boolean;

    /**
     * Pass --no-sandbox to Chromium (only for CI/Docker; default false).
     */
    noSandbox?: boolean;

    /**
     * Unpacked AdGuard MV3 extension directory used for exact settings reproduction.
     */
    adguardExtensionPath?: string;

    /**
     * Manifest generation verified from the prepared extension artifact.
     */
    adguardExtensionManifestVersion?: ExtensionManifestVersion;

    /**
     * Firefox enterprise policies that force-install a signed XPI with managed storage.
     *
     * Engines load their extensions through the family channel: Firefox takes a signed XPI through
     * these policies, Chromium engines take an unpacked directory through `adguardExtensionPath`.
     * An engine that cannot honor the supplied policies must reject the launch loudly instead of
     * dropping them.
     */
    firefoxPolicies?: FirefoxPolicies;

    /**
     * Wall-clock budget for each extension readiness wait during configuration.
     *
     * Unset keeps the short default suited to analysis sessions; apply_rule phase sessions raise it
     * because a fresh-install MV3 bootstrap under CI load routinely outlives the default.
     */
    extensionReadinessBudgetMs?: number;

    /**
     * Optional environment-neutral one-use strict route capability.
     */
    strictRoute?: PreparedStrictBrowserRoute;

    /**
     * Exact URL bound to the supplied strict route.
     */
    strictRouteTargetUrl?: string;

    /**
     * Deadline and post-kill settle bounds for one graceful browser close.
     *
     * Unset keeps the module defaults; tests inject tiny values to exercise the escalation without
     * waiting out the production bounds.
     */
    closeTimings?: BrowserCloseTimings;

    /**
     * Accept the route proxy's own interception authority for every host in the session.
     *
     * The SPKI allowlist can only match an authority the proxy actually presents, and the AdGuard
     * CLI proxy presents the leaf alone — its authority never appears in the chain, so the
     * allowlist can never match and every navigation fails. Callers that have independently proven
     * the tunnel belongs to their own authority (see `probeTlsInterception`: the presented leaf
     * verifies under the route certificate) may set this to let evidence collection reach the
     * reported page and its third-party subresources. Only ever set it after that proof: it
     * disables certificate verification for the isolated per-run profile.
     */
    strictRouteAcceptProxyAuthority?: boolean;

    /**
     * The URLs the filtering engine stopped before they reached their host, read from the engine's
     * own record.
     *
     * An extension stops a request inside the browser, so it arrives as a failed request. A
     * filtering proxy answers it itself instead, with a stub response the browser records like any
     * other; only the proxy's own log tells the two apart.
     */
    engineBlockedRequests?: () => ReadonlySet<string>;
}

/**
 * Reject a configuration that mixes the Firefox policies extension channel with the Chromium
 * unpacked-extension channel.
 *
 * `firefoxPolicies` force-installs a signed XPI through Firefox enterprise policies, while
 * `adguardExtensionPath` reproduces the prepared blocker through an unpacked Chromium extension.
 * The launch wiring accepts exactly one family channel, so a mixed configuration would be partially
 * dropped silently — and this module promises instead to reject such configs loudly.
 *
 * @param config - Session configuration to validate.
 * @returns Nothing; throws when the channels are mixed.
 */
function rejectCrossFamilyExtensionChannels(config: BrowserSessionConfig): void {
    if (config.firefoxPolicies && config.adguardExtensionPath) {
        throw new BrowserConfigurationError(
            'firefoxPolicies cannot be combined with adguardExtensionPath: Firefox enterprise ' +
                'policies are the Firefox extension channel (signed XPI), while ' +
                'adguardExtensionPath drives the Chromium unpacked-extension channel.',
        );
    }
}

/**
 * Managed browser session with pre-attached listeners and lifecycle control.
 *
 * Listeners for network requests and console messages are attached during {@link create} so no data
 * is missed before the first tool call.
 */
export class BrowserSession implements IBrowserSession {
    /**
     * The underlying Playwright Browser instance.
     */
    private readonly browser: Browser | BrowserContext;

    /**
     * The Playwright Page for navigation and interaction.
     */
    private readonly page: Page;

    /**
     * Logger for operational lifecycle events.
     */
    private readonly logger: Logger;

    /**
     * Accumulated network request log populated by response and request-failure listeners.
     */
    private readonly networkLog: NetworkRequestEntry[] = [];

    /**
     * Network collection generation assigned to requests when they start.
     */
    private networkGeneration = 0;

    /**
     * Generation in which each observed request started.
     */
    private readonly requestGenerations = new WeakMap<Request, number>();

    /**
     * Accumulated `console`-event messages, populated by the listener in {@link attachListeners}.
     */
    private readonly consoleLog: ConsoleMessageEntry[] = [];

    /**
     * What the engine delivers into the `console` event, and so into {@link consoleLog}.
     */
    readonly consoleCoverage: ConsoleCoverage;

    /**
     * Whether the session has been closed.
     */
    private isClosedFlag = false;

    /**
     * Temporary persistent-profile directory removed when the session closes.
     */
    private readonly profileDir?: string;

    /**
     * The persistent browser context when this session launched with unpacked extensions.
     *
     * The host reads the prepared extension's state back over this context after the application
     * steps; plain launches carry no context and expose nothing here.
     */
    readonly extensionContext?: BrowserContext;

    readonly artifactsDir: string;

    readonly strictRouteId?: string;

    /**
     * Short private temp dir a strict-route browser ran with, disposed on close.
     */
    private readonly strictRouteTempDir?: string;

    /**
     * Optional per-session overrides for the bounded-close timings.
     */
    private readonly closeTimings?: BrowserCloseTimings;

    /**
     * Pid of Playwright's own browser process, recorded at launch as this session's kill handle.
     */
    private readonly browserProcessPid?: number;

    /**
     * The engine's own record of the requests it stopped, when the engine answers them itself.
     */
    private readonly engineBlockedRequests?: () => ReadonlySet<string>;

    private constructor(
        pieces: LaunchedSessionPieces,
        logger: Logger,
        artifactsDir: string,
        consoleCoverage: ConsoleCoverage,
        closeTimings?: BrowserCloseTimings,
        engineBlockedRequests?: () => ReadonlySet<string>,
    ) {
        this.browser = pieces.browser;
        this.page = pieces.page;
        this.logger = logger;
        this.artifactsDir = artifactsDir;
        this.consoleCoverage = consoleCoverage;
        this.profileDir = pieces.profileDir;
        this.strictRouteId = pieces.strictRouteId;
        this.strictRouteTempDir = pieces.strictRouteTempDir;
        this.closeTimings = closeTimings;
        this.extensionContext = pieces.extensionContext;
        this.browserProcessPid = pieces.browserProcessPid;
        this.engineBlockedRequests = engineBlockedRequests;
        this.attachListeners();
    }

    /**
     * Create a new browser session: launch the engine, open a page, set viewport, and attach
     * network + console listeners.
     *
     * The launch itself is delegated to the per-family launch wiring in `launch-wiring.ts`, which
     * maps the session config onto the strict-route, Firefox-policies, Chromium-extension, or
     * plain-launch branch.
     *
     * @param config - Session configuration.
     * @returns A new `BrowserSession` ready for tool use.
     * @throws {BrowserConfigurationError} When the config mixes the Firefox policies channel with
     *   the Chromium extension channel, or the launch configuration is otherwise unusable.
     * @throws {BrowserLaunchError} If the engine fails to launch.
     */
    static async create(config: BrowserSessionConfig): Promise<BrowserSession> {
        const { logger } = config;
        logger.info(
            { engineType: config.engine.browserType, headless: config.headless },
            'browser session creating',
        );
        rejectCrossFamilyExtensionChannels(config);
        const pieces = await launchSessionBrowser(config);
        return new BrowserSession(
            pieces,
            logger,
            config.artifactsDir,
            config.engine.consoleCoverage,
            config.closeTimings,
            config.engineBlockedRequests,
        );
    }

    /**
     * Attach network and console listeners that accumulate data from session start.
     *
     * Uses `response` for completed requests and `requestfailed` for requests that never received a
     * response. This is called in the constructor before any navigation, ensuring no requests or
     * console messages are missed.
     *
     * @returns Nothing.
     */
    private attachListeners(): void {
        const recordedRequests = new WeakSet<Request>();
        this.page.on('request', (req) => {
            if (!this.requestGenerations.has(req)) {
                this.requestGenerations.set(req, this.networkGeneration);
            }
        });
        this.page.on('response', (resp) => {
            const req = resp.request();
            const generation = this.requestGenerations.get(req);
            if (generation !== undefined && generation !== this.networkGeneration) {
                return;
            }
            if (generation === undefined) {
                this.requestGenerations.set(req, this.networkGeneration);
            }
            if (recordedRequests.has(req)) {
                return;
            }
            recordedRequests.add(req);
            this.networkLog.push({
                url: req.url(),
                method: req.method(),
                resourceType: req.resourceType(),
                statusCode: resp.status(),
                requestHeaders: req.headers(),
                responseHeaders: resp.headers(),
            });
        });
        this.page.on('requestfailed', (req) => {
            const generation = this.requestGenerations.get(req);
            if (generation !== undefined && generation !== this.networkGeneration) {
                return;
            }
            if (generation === undefined) {
                this.requestGenerations.set(req, this.networkGeneration);
            }
            if (recordedRequests.has(req)) {
                return;
            }
            recordedRequests.add(req);
            this.networkLog.push({
                url: req.url(),
                method: req.method(),
                resourceType: req.resourceType(),
                statusCode: 0,
                requestHeaders: req.headers(),
                responseHeaders: {},
            });
        });
        // What arrives here is the engine's consoleCoverage: the stealth Chromium binary delivers
        // only the browser's own log entries, Firefox the page's console output too. See
        // ConsoleCoverage.BrowserLogOnly for why no page-side hook may recover the rest.
        this.page.on('console', (msg) => {
            this.consoleLog.push({ type: msg.type(), text: msg.text() });
        });
    }

    /**
     * Return the active Playwright Page.
     *
     * @returns The current page instance.
     * @throws If the session has already been closed.
     */
    getPage(): Page {
        if (this.isClosedFlag) {
            throw new Error('BrowserSession is closed');
        }
        return this.page;
    }

    /**
     * Return the accumulated network request log.
     *
     * A request the engine stopped reads as one that never received a response, whichever way the
     * engine stopped it.
     *
     * @returns Network request entries collected since session creation or the last reset.
     */
    getNetworkLog(): NetworkRequestEntry[] {
        const blocked = this.engineBlockedRequests?.();
        if (blocked === undefined || blocked.size === 0) {
            return this.networkLog;
        }
        return this.networkLog.map((entry) =>
            blocked.has(entry.url) ? { ...entry, statusCode: 0, responseHeaders: {} } : entry,
        );
    }

    /**
     * Clear accumulated network entries and start a new collection generation.
     *
     * Requests already in flight remain tagged with the previous generation, so their late terminal
     * events cannot leak into the next phase.
     *
     * @returns Nothing.
     */
    resetNetworkLog(): void {
        this.networkGeneration += 1;
        this.networkLog.length = 0;
    }

    /**
     * Return the accumulated `console`-event messages.
     *
     * @returns Every message collected since session creation; {@link consoleCoverage} says whether
     *   the page's own output is among them.
     */
    getConsoleLog(): ConsoleMessageEntry[] {
        return this.consoleLog;
    }

    /**
     * Whether the session has been closed.
     *
     * @returns `true` if {@link close} has been called.
     */
    get isClosed(): boolean {
        return this.isClosedFlag;
    }

    /**
     * Close the browser session and release all resources. Idempotent.
     *
     * The close is hard-bounded and never throws: on a page wedged mid-navigation the protocol
     * close can block forever (a close after a navigation timeout has been seen to sit for over an
     * hour inside `close_browser` until the CI SIGTERM killed the process group), so a close that
     * misses its deadline escalates to a SIGKILL of every process carrying this session's unique
     * profile path, and directory cleanup plus the outcome log run on every path.
     */
    async close(): Promise<void> {
        if (this.isClosedFlag) {
            return;
        }
        this.isClosedFlag = true;
        const outcome = await runBoundedBrowserClose({
            gracefulClose: async () => {
                try {
                    await this.page.unroute('**/*');
                } catch {
                    /* ignore — no routes may have been registered */
                }
                this.page.removeAllListeners();
                await this.browser.close();
            },
            forceKill: () => {
                // The pid recorded at launch is the handle every family has; the marker scan adds
                // the strays of a persistent context (a renderer reparented away from the group).
                let killed = 0;
                if (this.browserProcessPid !== undefined) {
                    killed += forceKillBrowserProcessTree(this.browserProcessPid, this.logger);
                }
                const marker = this.profileDir ?? this.strictRouteTempDir;
                if (marker) {
                    killed += forceKillBrowserProcessesByMarker(marker, this.logger);
                }
                if (this.browserProcessPid === undefined && !marker) {
                    this.logger.error(
                        {},
                        'no kill handle for this browser: the launch exposed neither a process ' +
                            'pid nor a session-owned profile path, so the close can only be ' +
                            'abandoned',
                    );
                }
                return killed;
            },
            logger: this.logger,
            deadlineMs: this.closeTimings?.deadlineMs,
            settleMs: this.closeTimings?.settleMs,
        });
        try {
            if (this.profileDir) {
                rmSync(this.profileDir, { recursive: true, force: true });
            }
            if (this.strictRouteTempDir) {
                rmSync(this.strictRouteTempDir, { recursive: true, force: true });
            }
        } catch (error) {
            this.logger.warn(
                { error: error instanceof Error ? error.message : String(error) },
                'session directory cleanup failed',
            );
        }
        this.logger.info({ outcome }, 'browser session closed');
    }
}
