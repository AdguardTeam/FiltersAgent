import { launch, launchPersistentContext } from 'cloakbrowser';
import type { Browser, BrowserContext } from 'playwright-core';
import {
    ConsoleCoverage,
    type IBrowserEngine,
    type BrowserEngineLaunchConfig,
    type BrowserEnginePersistentLaunchConfig,
} from './browser-interfaces';
import { BrowserConfigurationError } from './browser-session';

/**
 * Playwright default switches cloakbrowser withholds on its own.
 *
 * Cloakbrowser hardcodes this list internally and does not export it, and a caller-supplied
 * `ignoreDefaultArgs` replaces the wrapper's list rather than merging into it — so a launch that
 * withholds further defaults must restate these two to keep stealth intact. Keep in sync with
 * `IGNORE_DEFAULT_ARGS` in cloakbrowser's config module.
 */
const CLOAKBROWSER_IGNORED_DEFAULT_ARGS = ['--enable-automation', '--enable-unsafe-swiftshader'];

/**
 * Map the engine-neutral config onto cloakbrowser's launch option passthrough.
 *
 * Cloakbrowser spreads `launchOptions` last, after its own defaults, which makes it the channel for
 * everything the wrapper does not model: the child environment, the browser process log sink, and
 * the withheld-default-switches override.
 *
 * @param config - Engine launch configuration.
 * @returns Cloakbrowser `launchOptions` fragment.
 */
function cloakbrowserLaunchOptions(config: BrowserEngineLaunchConfig): Record<string, unknown> {
    return {
        env: config.environment,
        ...(config.browserProcessLogger ? { logger: config.browserProcessLogger } : {}),
        ...(config.ignoreDefaultArgs
            ? {
                  ignoreDefaultArgs: [
                      ...CLOAKBROWSER_IGNORED_DEFAULT_ARGS,
                      ...config.ignoreDefaultArgs,
                  ],
              }
            : {}),
    };
}

/**
 * CloakBrowser engine implementation wrapping cloakbrowser's `launch()`.
 *
 * CloakBrowser is a stealth Playwright drop-in and the default engine.
 */
export class CloakBrowserEngine implements IBrowserEngine {
    /**
     * Engine identifier for logging and diagnostics.
     */
    readonly browserType = 'cloakbrowser';

    /**
     * The stealth binary passes no page console API message and no uncaught page error to
     * Playwright, not even through a raw CDP `Runtime.enable` subscription: `page.on('console')`
     * sees only the browser's own log entries. Verified with headless sessions on a `data:` URL and
     * on a local page; CI `browser-console.json` artifacts hold nothing else.
     */
    readonly consoleCoverage = ConsoleCoverage.BrowserLogOnly;

    /**
     * Launch a CloakBrowser instance.
     *
     * @param config - Launch parameters forwarded to cloakbrowser's `launch()`.
     * @returns A Playwright-compatible Browser instance.
     */
    async launch(config: BrowserEngineLaunchConfig): Promise<Browser> {
        return launch({
            headless: config.headless,
            locale: config.locale,
            timezone: config.timezone,
            args: config.args,
            launchOptions: cloakbrowserLaunchOptions(config),
        }) as unknown as Browser;
    }

    /**
     * Launch a persistent CloakBrowser context with unpacked extensions enabled.
     *
     * Firefox policies are the Firefox channel: CloakBrowser is Chromium-only and cannot honor
     * them, and this launch loads its extensions through `extensionPaths` directories. A config
     * that carries both is rejected loudly instead of having its policies dropped silently.
     *
     * @param config - Persistent profile, extension, and fingerprint parameters.
     * @returns A Playwright-compatible persistent BrowserContext.
     * @throws {BrowserConfigurationError} When the config carries `firefoxPolicies`.
     */
    async launchPersistentContext(
        config: BrowserEnginePersistentLaunchConfig,
    ): Promise<BrowserContext> {
        if (config.firefoxPolicies) {
            throw new BrowserConfigurationError(
                `${this.browserType} cannot honor firefoxPolicies: Firefox enterprise policies ` +
                    'are the Firefox extension channel, while this Chromium engine loads its ' +
                    'extensions through `extensionPaths` directories.',
            );
        }
        return launchPersistentContext({
            userDataDir: config.userDataDir,
            extensionPaths: config.extensionPaths,
            headless: config.headless,
            locale: config.locale,
            timezone: config.timezone,
            args: config.args,
            userAgent: config.userAgent,
            viewport: config.viewport,
            launchOptions: cloakbrowserLaunchOptions(config),
        }) as unknown as BrowserContext;
    }
}
