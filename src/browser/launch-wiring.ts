import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { Logger } from 'pino';
import type { BrowserSessionConfig } from './browser-session';
import { buildBrowserSubprocessEnvironment } from './browser-subprocess-environment';
import { ExtensionManifestVersion } from '../environment/extension-preparation';
import { Viewport, type ReproProfile } from '../types/repro-profile';
import { launchStrictRoutePieces } from './strict-route-launch';
import { readBrowserProcessPid } from './browser-kill-handle';
import { BrowserLaunchError, BrowserConfigurationError } from './browser-launch-errors';

/**
 * The launched browser artifacts a family launch hands back to {@link BrowserSession.create}.
 *
 * The session constructor itself stays private to `browser-session.ts`; launch wiring assembles the
 * pieces and the session attaches its listeners around them.
 */
export interface LaunchedSessionPieces {
    /**
     * The launched Playwright browser, or the persistent context that owns the session page.
     */
    browser: Browser | BrowserContext;

    /**
     * The opened page the session's network and console listeners attach to.
     */
    page: Page;

    /**
     * Profile directory a persistent context launched with; removed again when the session closes.
     */
    profileDir?: string;

    /**
     * Strict-route identifier when the pieces came from a strict-route launch.
     */
    strictRouteId?: string;

    /**
     * Short private temp dir a strict-route browser ran with; disposed when the session closes.
     */
    strictRouteTempDir?: string;

    /**
     * The persistent context when the pieces are an unpacked-extension launch.
     */
    extensionContext?: BrowserContext;

    /**
     * Pid of Playwright's own browser process, when the launch exposed one.
     *
     * The session's kill handle: without it a close that misses its deadline has nothing to kill
     * unless the family happens to own a unique profile path (`browser-kill-handle.ts`).
     */
    browserProcessPid?: number;
}

/**
 * Resolve a deterministic browser user agent from a reproduction profile.
 *
 * @param profile - Browser and viewport preferences derived from the issue.
 * @returns A realistic user-agent string for the requested browser family.
 */
export function resolveUserAgent(profile: ReproProfile): string {
    const mobile = profile.viewport === Viewport.Mobile;
    const platform = mobile ? 'Linux; Android 14; Pixel 8' : 'Windows NT 10.0; Win64; x64';
    const chromium =
        `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
        `Chrome/145.0.0.0 ${mobile ? 'Mobile ' : ''}Safari/537.36`;
    const family = profile.userAgentProfile.trim().toLowerCase();
    if (family.includes('edge')) {
        return `${chromium} Edg/145.0.0.0`;
    }
    if (family.includes('opera')) {
        return `${chromium} OPR/126.0.0.0`;
    }
    if (family.includes('firefox')) {
        return `Mozilla/5.0 (${platform}; rv:147.0) Gecko/20100101 Firefox/147.0`;
    }
    if (family.includes('safari')) {
        return mobile
            ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 ' +
                  '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
            : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
                  '(KHTML, like Gecko) Version/18.0 Safari/605.1.15';
    }
    return chromium;
}

/**
 * Build Chromium launch arguments for sandboxing and an explicitly verified MV2 artifact.
 *
 * @param noSandbox - Whether the CI sandbox must be disabled.
 * @param manifestVersion - Manifest generation of the unpacked extension.
 * @returns Ordered browser arguments, or undefined when no overrides are needed.
 */
function buildPersistentContextArgs(
    noSandbox: boolean | undefined,
    manifestVersion: ExtensionManifestVersion | undefined,
): string[] | undefined {
    const args: string[] = [];
    if (noSandbox) {
        args.push('--no-sandbox');
    }
    if (manifestVersion === ExtensionManifestVersion.Mv2) {
        args.push('--disable-features=ExtensionManifestV2Disabled,ExtensionManifestV2Unsupported');
    }
    return args.length === 0 ? undefined : args;
}

/**
 * The session-level launch inputs the per-family branches receive from the dispatcher.
 */
export interface SessionLaunchInputs {
    /**
     * Launch configuration of the session being created.
     */
    config: BrowserSessionConfig;

    /**
     * Operational logger of the session being created.
     */
    logger: Logger;

    /**
     * Headless preference of the session being created.
     */
    headless: boolean;

    /**
     * Pixel size the session's page is opened with.
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
     * Deterministic user agent resolved from the reproduction profile.
     */
    userAgent: string;
}

/**
 * Launch a persistent context that force-installs a signed XPI through the Firefox policies.
 *
 * The engine stages the policies and points the patched browser at them; the session owns the
 * freshly created profile directory and removes it on close. No AdGuard configurator runs here:
 * managed storage reaches the extension through the policies themselves.
 *
 * @param inputs - Session-level launch inputs shared by every family branch.
 * @returns The launched context, page, and their profile directory.
 * @throws {BrowserLaunchError} When the engine fails to launch the persistent context.
 */
async function launchFirefoxPoliciesPieces(
    inputs: SessionLaunchInputs,
): Promise<LaunchedSessionPieces> {
    const { config, logger, headless, viewport, userAgent } = inputs;
    const { engine, reproProfile } = config;
    if (!engine.launchPersistentContext) {
        throw new BrowserConfigurationError(
            `${engine.browserType} does not support persistent extension contexts.`,
        );
    }
    const firefoxPolicies = config.firefoxPolicies;
    if (!firefoxPolicies) {
        throw new BrowserConfigurationError(
            'The Firefox policies launch branch was entered without any policies to apply.',
        );
    }
    const profileDir = mkdtempSync(join(tmpdir(), 'firefox-policies-profile-'));
    let context: BrowserContext;
    try {
        context = await engine.launchPersistentContext({
            headless,
            locale: reproProfile.locale,
            timezone: reproProfile.timezone,
            environment: buildBrowserSubprocessEnvironment(process.env),
            userDataDir: profileDir,
            extensionPaths: [],
            firefoxPolicies,
            userAgent,
            viewport,
        });
    } catch (err) {
        rmSync(profileDir, { recursive: true, force: true });
        logger.error({ err }, 'persistent browser launch failed');
        throw new BrowserLaunchError(
            `Failed to launch ${engine.browserType} with its extension policies: ` +
                `${(err as Error).message}`,
            err,
        );
    }
    const page = await context.newPage();
    await page.setViewportSize(viewport);
    logger.info(
        {
            viewport: reproProfile.viewport,
            locale: reproProfile.locale,
            policyExtensionIds: Object.keys(firefoxPolicies.policies.ExtensionSettings),
        },
        'browser session created with Firefox extension policies',
    );
    return { browser: context, page, profileDir };
}

/**
 * Launch a persistent context with the unpacked prepared extension and nothing else.
 *
 * The launch applies no settings and captures no evidence pieces — the session boots the
 * extension's own defaults, and the run's application instruction (performed against the lease
 * session) is the one mechanism that brings the blocker to the prepared state. The host reads the
 * blocker state back itself over the returned context.
 *
 * @param inputs - Session-level launch inputs shared by every family branch.
 * @returns The launched context, page, profile directory, and the persistent context itself.
 * @throws {BrowserConfigurationError} When no extension build was supplied.
 * @throws {BrowserLaunchError} When the engine fails to launch the persistent context.
 */
async function launchAdGuardExtensionPieces(
    inputs: SessionLaunchInputs,
): Promise<LaunchedSessionPieces> {
    const { config, logger, headless, viewport, userAgent } = inputs;
    const { engine, reproProfile } = config;
    const noSandbox = config.noSandbox;
    if (!config.adguardExtensionPath) {
        throw new BrowserConfigurationError(
            'The unpacked-extension launch branch was entered without an extension build.',
        );
    }
    if (!engine.launchPersistentContext) {
        throw new BrowserConfigurationError(
            `${engine.browserType} does not support persistent extension contexts.`,
        );
    }

    const profileDir = mkdtempSync(join(tmpdir(), 'adguard-agent-profile-'));
    let context: BrowserContext;
    try {
        context = await engine.launchPersistentContext({
            headless,
            locale: reproProfile.locale,
            timezone: reproProfile.timezone,
            environment: buildBrowserSubprocessEnvironment(process.env),
            args: buildPersistentContextArgs(noSandbox, config.adguardExtensionManifestVersion),
            userDataDir: profileDir,
            extensionPaths: [config.adguardExtensionPath],
            userAgent,
            viewport,
        });
    } catch (err) {
        rmSync(profileDir, { recursive: true, force: true });
        logger.error({ err }, 'persistent browser launch failed');
        throw new BrowserLaunchError(
            `Failed to launch ${engine.browserType} with AdGuard: ${(err as Error).message}`,
            err,
        );
    }

    const page = await context.newPage();
    await page.setViewportSize(viewport);
    logger.info(
        {
            viewport: reproProfile.viewport,
            locale: reproProfile.locale,
            manifestVersion: config.adguardExtensionManifestVersion ?? null,
        },
        'browser session created with the prepared extension (unconfigured launch)',
    );
    return { browser: context, page, profileDir, extensionContext: context };
}

/**
 * Launch a plain browser context without extension reproduction.
 *
 * @param inputs - Session-level launch inputs shared by every family branch.
 * @returns The launched browser and its opened page.
 * @throws {BrowserLaunchError} When the engine fails to launch.
 */
async function launchPlainBrowserPieces(
    inputs: SessionLaunchInputs,
): Promise<LaunchedSessionPieces> {
    const { config, logger, headless, viewport, userAgent } = inputs;
    const { engine, reproProfile } = config;
    let browser: Browser;
    try {
        browser = await engine.launch({
            headless,
            locale: reproProfile.locale,
            timezone: reproProfile.timezone,
            environment: buildBrowserSubprocessEnvironment(process.env),
            args: config.noSandbox ? ['--no-sandbox'] : undefined,
        });
    } catch (err) {
        logger.error({ err }, 'browser launch failed');
        throw new BrowserLaunchError(
            `Failed to launch ${engine.browserType}: ${(err as Error).message}`,
            err,
        );
    }

    logger.info({ engineType: engine.browserType }, 'browser launched');
    const page = await browser.newPage({
        locale: reproProfile.locale,
        timezoneId: reproProfile.timezone,
        userAgent,
    });
    await page.setViewportSize(viewport);
    logger.info(
        { viewport: reproProfile.viewport, locale: reproProfile.locale },
        'browser session created',
    );
    return { browser, page };
}

/**
 * Dispatch one launch onto its family branch.
 *
 * @param config - Session configuration driving the launch.
 * @param inputs - Session-level launch inputs shared by every family branch.
 * @returns The launched pieces of whichever family served the configuration.
 * @throws {BrowserLaunchError} When the engine fails to launch.
 * @throws {BrowserConfigurationError} When the launch configuration is unusable for the family.
 */
async function launchFamilyPieces(
    config: BrowserSessionConfig,
    inputs: SessionLaunchInputs,
): Promise<LaunchedSessionPieces> {
    if (config.strictRoute) {
        return await launchStrictRoutePieces(inputs);
    }
    if (config.firefoxPolicies) {
        return await launchFirefoxPoliciesPieces(inputs);
    }
    if (config.adguardExtensionPath) {
        return await launchAdGuardExtensionPieces(inputs);
    }
    return await launchPlainBrowserPieces(inputs);
}

/**
 * Launch the browser pieces a `BrowserSession` is built on, following the session's family.
 *
 * The strict route takes precedence (it carries its own isolated profile machinery), then the
 * Firefox policies channel, then the Chromium unpacked-extension channel, and the plain browser
 * launch serves everything else. Each family branch maps its own failures to the launch or
 * configuration error the caller's classifier already knows.
 *
 * Whichever branch ran, the pieces come back carrying this launch's kill handle: the pid is read
 * here, once, for every family, so no launch can reach a bounded close with nothing to kill.
 *
 * @param config - Session configuration driving the launch.
 * @returns The launched pieces the session constructor needs.
 * @throws {BrowserLaunchError} When the engine fails to launch.
 * @throws {BrowserConfigurationError} When the launch configuration is unusable for the family.
 */
export async function launchSessionBrowser(
    config: BrowserSessionConfig,
): Promise<LaunchedSessionPieces> {
    const logger = config.logger;
    const { reproProfile, headless } = config;
    const viewport =
        reproProfile.viewport === Viewport.Mobile
            ? { width: 375, height: 812 }
            : { width: 1920, height: 1080 };
    const inputs: SessionLaunchInputs = {
        config,
        logger,
        headless,
        viewport,
        userAgent: resolveUserAgent(reproProfile),
    };

    const pieces = await launchFamilyPieces(config, inputs);
    const browserProcessPid = readBrowserProcessPid(pieces.browser, logger);
    return browserProcessPid === undefined ? pieces : { ...pieces, browserProcessPid };
}
