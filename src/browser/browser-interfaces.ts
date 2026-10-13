import type { Browser, BrowserContext, Page, Logger as PlaywrightLogger } from 'playwright-core';
import type { FirefoxPolicies } from './firefox-policies';

/**
 * Configuration passed to the browser engine's launch method.
 */
export interface BrowserEngineLaunchConfig {
    /**
     * Whether to launch the browser in headless mode.
     */
    headless: boolean;

    /**
     * The browser locale string (e.g., 'en-US').
     */
    locale: string;

    /**
     * The browser timezone string (e.g., 'UTC').
     */
    timezone: string;

    /**
     * Additional Chromium launch arguments (e.g., '--no-sandbox').
     */
    args?: string[];

    /**
     * Allowlisted environment inherited by the Chromium process tree.
     */
    environment: Record<string, string>;

    /**
     * Optional sink receiving the browser process tree's own stdout/stderr lines.
     *
     * Playwright reports those lines through its pluggable logger under the `browser` channel;
     * supplying a sink lets a caller tee them to a durable file instead of losing everything beyond
     * the bounded excerpt a launch error carries.
     */
    browserProcessLogger?: PlaywrightLogger;

    /**
     * Playwright default Chromium switches to withhold for this launch.
     *
     * Withholding `--disable-breakpad`, for example, keeps the crashpad handler enabled so a
     * startup crash leaves a dump inside the profile directory.
     */
    ignoreDefaultArgs?: readonly string[];
}

/**
 * Configuration for launching a persistent browser context with unpacked extensions.
 */
export interface BrowserEnginePersistentLaunchConfig extends BrowserEngineLaunchConfig {
    /**
     * Temporary Chromium profile directory.
     */
    userDataDir: string;

    /**
     * Unpacked extension directories to load.
     */
    extensionPaths: string[];

    /**
     * User-agent string applied to every page in the context.
     */
    userAgent: string;

    /**
     * Initial viewport applied to every page in the context.
     */
    viewport: {
        /**
         * Viewport width in CSS pixels.
         */
        width: number;

        /**
         * Viewport height in CSS pixels.
         */
        height: number;
    };

    /**
     * Firefox enterprise policies (force-installed XPI plus managed storage) written into the
     * profile and handed to the browser through `PLAYWRIGHT_FIREFOX_POLICIES_JSON`.
     *
     * Chromium-only engines must reject a non-empty `firefoxPolicies` the same way Firefox must
     * reject a non-empty `extensionPaths`: each family loads extensions through its own channel.
     */
    firefoxPolicies?: FirefoxPolicies;
}

/**
 * Abstraction over the browser automation layer.
 *
 * Decouples BrowserSession from any specific engine (CloakBrowser, vanilla Playwright, or a mock).
 */
export interface IBrowserEngine {
    /**
     * A human-readable identifier for the engine (e.g., 'cloakbrowser').
     */
    readonly browserType: string;

    /**
     * What this engine delivers into Playwright's `console` event.
     */
    readonly consoleCoverage: ConsoleCoverage;

    /**
     * Launch a browser instance with the given configuration.
     *
     * @param config - Launch parameters (headless, locale, timezone, extra args).
     * @returns A Playwright Browser instance.
     */
    launch(config: BrowserEngineLaunchConfig): Promise<Browser>;

    /**
     * Launch a persistent browser context capable of loading unpacked extensions.
     *
     * @param config - Persistent profile and extension launch parameters.
     * @returns A Playwright BrowserContext, or undefined support when not implemented.
     */
    launchPersistentContext?(config: BrowserEnginePersistentLaunchConfig): Promise<BrowserContext>;
}

/**
 * A network request entry collected during a browser session.
 */
export interface NetworkRequestEntry {
    /**
     * The full request URL.
     */
    url: string;

    /**
     * The HTTP method (GET, POST, etc.).
     */
    method: string;

    /**
     * The Playwright resource type (document, script, xhr, etc.).
     */
    resourceType: string;

    /**
     * The HTTP response status code (0 if no response was received, e.g. blocked).
     */
    statusCode: number;

    /**
     * Request headers keyed by header name.
     */
    requestHeaders: Record<string, string>;

    /**
     * Response headers keyed by header name.
     */
    responseHeaders: Record<string, string>;
}

/**
 * What an engine delivers into Playwright's `console` event, and so into a session's console log.
 */
export const ConsoleCoverage = {
    /**
     * Only the browser's own log entries arrive: failed loads, blocked requests
     * (`net::ERR_BLOCKED_BY_CLIENT`), security, deprecation and rendering warnings. Nothing a page
     * script writes to the console and no uncaught page error ever does. Stealth Chromium builds
     * mute the CDP Runtime events those travel on, because anti-bot scripts detect an enabled
     * Runtime; a page-side hook that recovers them — a wrapped console, an exposed binding — is
     * just as detectable, so a session with this coverage stays without page output by design.
     */
    BrowserLogOnly: 'browser_log_only',

    /**
     * The page's own console output and uncaught errors arrive alongside the browser's entries.
     */
    PageConsole: 'page_console',
} as const;
export type ConsoleCoverage = (typeof ConsoleCoverage)[keyof typeof ConsoleCoverage];

/**
 * One message Playwright's `console` event delivered during a browser session. Whether the page's
 * own console output is among these messages, or only the browser's own log entries are, is the
 * engine's {@link ConsoleCoverage}.
 */
export interface ConsoleMessageEntry {
    /**
     * The console message type (log, warn, error, etc.).
     */
    type: string;

    /**
     * The console message text.
     */
    text: string;
}

/**
 * Managed browser session with pre-attached listeners and lifecycle control.
 *
 * Tool handlers and tests program against this interface, not the concrete class.
 */
export interface IBrowserSession {
    /**
     * Return the active Playwright Page.
     *
     * @throws If the session has already been closed.
     */
    getPage(): Page;

    /**
     * Close the browser and release all resources. Idempotent.
     */
    close(): Promise<void>;

    /**
     * Return network requests accumulated since session creation or the last reset.
     */
    getNetworkLog(): NetworkRequestEntry[];

    /**
     * Clear accumulated network entries and begin an isolated collection generation.
     *
     * Terminal events for requests started before the reset must not enter the new generation.
     *
     * @returns Nothing.
     */
    resetNetworkLog(): void;

    /**
     * Return the `console`-event messages accumulated since session creation;
     * {@link consoleCoverage} says whether the page's own output is among them.
     */
    getConsoleLog(): ConsoleMessageEntry[];

    /**
     * What the engine delivers into the `console` event, and so into {@link getConsoleLog}.
     */
    readonly consoleCoverage: ConsoleCoverage;

    /**
     * The directory where artifacts (screenshots, HAR, DOM snapshots) are written.
     */
    readonly artifactsDir: string;

    /**
     * Whether the session has been closed.
     */
    readonly isClosed: boolean;

    /**
     * Opaque route identity when this session consumed a strict route.
     */
    readonly strictRouteId?: string;
}
