import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { consumePreparedStrictBrowserRoute } from './strict-browser-route';
import { readLaunchResourceSnapshot } from './launch-resource-snapshot';
import { createStrictRouteDiagnostics, readLogFileTail } from './strict-route-diagnostics';
import { createStrictRouteTempDir } from './strict-route-temp-dir';
import type { LaunchedSessionPieces, SessionLaunchInputs } from './launch-wiring';
import {
    BrowserLaunchBoundary,
    BrowserLaunchError,
    BrowserConfigurationError,
} from './browser-launch-errors';

/**
 * Route-owned directories for everything a strict-route browser may write.
 */
interface StrictRouteBrowserPaths {
    /**
     * Route-owned XDG config directory.
     */
    config: string;
    /**
     * Route-owned XDG data directory.
     */
    data: string;
    /**
     * Route-owned XDG cache directory.
     */
    cache: string;
}

/**
 * Build the environment for a strict-route browser without severing the platform trust store.
 *
 * Everything with diagnostic value stays route-owned, but `HOME` must remain the operator's own
 * home directory. The route's HTTPS interception is only trusted because a certificate authority
 * was installed into the operator's user trust domain, and on macOS the whole user keychain domain
 * — including that trust domain — is resolved from `HOME`. Pointing it at an empty private
 * directory therefore hides exactly the trust the route depends on, and every intercepted
 * navigation fails as an unknown authority. `XDG_*` carries the isolation instead, and the profile
 * itself is isolated by its own user data directory. The temporary directory is the one exception
 * to route ownership: Chromium binds its ProcessSingleton socket under `$TMPDIR` beneath a 108-byte
 * `sun_path` CHECK, which the deep route-owned path overflows, so the browser gets a short private
 * temp dir instead (see `strict-route-temp-dir.ts`).
 *
 * @param operatorHome - The operator's real home directory.
 * @param paths - Route-owned directories for everything the browser may write.
 * @param tempDir - Short private temporary directory for the browser process tree.
 * @returns Fresh minimal environment for the strict-route browser process tree.
 */
function buildStrictRouteBrowserEnvironment(
    operatorHome: string,
    paths: StrictRouteBrowserPaths,
    tempDir: string,
): Record<string, string> {
    return {
        HOME: operatorHome,
        XDG_CONFIG_HOME: paths.config,
        XDG_DATA_HOME: paths.data,
        XDG_CACHE_HOME: paths.cache,
        TMPDIR: tempDir,
        TMP: tempDir,
        TEMP: tempDir,
        LANG: 'C',
    };
}

/**
 * Convert a canonical route proxy URL into the value Chromium's `--proxy-server` switch accepts.
 *
 * The switch is not a URL: its grammar is `[<scheme>://]<host>[:<port>]`, so anything after the
 * authority — including the single trailing slash a canonical URL always carries — is parsed as
 * part of the port, fails port validation, and makes Chromium silently discard the entry. An empty
 * proxy list is then reported as `ERR_NO_SUPPORTED_PROXIES` on the first navigation.
 *
 * @param proxyUrl - Canonical loopback proxy URL held by the route.
 * @returns Scheme and authority only, with no path.
 */
function chromiumProxyServerValue(proxyUrl: string): string {
    const proxy = new URL(proxyUrl);
    return `${proxy.protocol}//${proxy.host}`;
}

/**
 * Launch the strict-route browser pieces: an isolated persistent context routed through the route's
 * interception proxy, tied to the route's SPKI allowlist, and instrumented with its own
 * Chromium-log diagnostics.
 *
 * On launch failure the route root is deliberately preserved for forensics — it holds the browser
 * log, the teed output, and any crashpad dump — while the session temp dir is disposed.
 *
 * @param inputs - Session-level launch inputs shared by every family branch.
 * @returns The launched context, page, route identifier, and the roots the session must clean up.
 * @throws {BrowserConfigurationError} When the route configuration itself is unusable.
 * @throws {BrowserLaunchError} When the browser fails to launch through the route.
 */
export async function launchStrictRoutePieces(
    inputs: SessionLaunchInputs,
): Promise<LaunchedSessionPieces> {
    const { config, logger, headless, viewport, userAgent } = inputs;
    const { engine, reproProfile } = config;
    if (!config.strictRoute) {
        throw new BrowserConfigurationError(
            'The strict-route launch branch was entered without a prepared route.',
        );
    }
    if (!config.strictRouteTargetUrl) {
        throw new BrowserConfigurationError('A strict route requires its exact target URL.');
    }
    if (!engine.launchPersistentContext) {
        throw new BrowserConfigurationError(
            `${engine.browserType} does not support an isolated persistent route context.`,
        );
    }
    const route = consumePreparedStrictBrowserRoute(
        config.strictRoute,
        config.strictRouteTargetUrl,
    );
    const routeRoot = realpathSync(route.browserRoot);
    const routeRootStats = lstatSync(routeRoot);
    if (
        !routeRootStats.isDirectory() ||
        routeRootStats.isSymbolicLink() ||
        (routeRootStats.mode & 0o077) !== 0
    ) {
        throw new BrowserConfigurationError('Strict browser route root is not private.');
    }
    const paths = {
        profile: join(routeRoot, 'profile'),
        config: join(routeRoot, 'xdg-config'),
        data: join(routeRoot, 'xdg-data'),
        cache: join(routeRoot, 'xdg-cache'),
        logs: join(routeRoot, 'logs'),
    };
    for (const path of Object.values(paths)) {
        mkdirSync(path, { recursive: false, mode: 0o700 });
        chmodSync(path, 0o700);
        const canonical = realpathSync(path);
        const child = relative(routeRoot, canonical);
        if (
            child === '' ||
            child === '..' ||
            child.startsWith(`..${sep}`) ||
            child.startsWith(sep) ||
            lstatSync(path).isSymbolicLink()
        ) {
            throw new BrowserConfigurationError('Strict browser route path escaped its root.');
        }
    }
    let context: BrowserContext | undefined;
    let launchBoundary: BrowserLaunchError['boundary'] = BrowserLaunchBoundary.RuntimeOrContext;
    const strictRouteLaunchStartedAt = Date.now();
    const diagnostics = createStrictRouteDiagnostics(paths.logs);
    // Short flat temp dir: Chromium's ProcessSingleton CHECKs its singleton socket path
    // against the 108-byte sun_path and SIGTRAPs at startup when the route-owned tree's
    // depth overflows it, so TMPDIR must not live inside the route root.
    const tempDir = createStrictRouteTempDir();
    // Logged before the call, not after: this launch can hang for hours, and a line
    // that only appears on success tells nothing about a hang. The
    // resource snapshot is captured for the same reason: strict-route launch crashes
    // cluster with parallel CI jobs, so every launch records the fd limit, /dev/shm
    // size, and memory headroom it started from.
    logger.info(
        {
            routeId: route.routeId,
            proxyUrl: route.proxyUrl,
            acceptProxyAuthority: config.strictRouteAcceptProxyAuthority === true,
            profileDir: paths.profile,
            headless,
            locale: reproProfile.locale,
            timezone: reproProfile.timezone,
            resources: readLaunchResourceSnapshot(),
        },
        'strict route browser launching',
    );
    try {
        const launched = await engine.launchPersistentContext({
            headless,
            locale: reproProfile.locale,
            timezone: reproProfile.timezone,
            environment: buildStrictRouteBrowserEnvironment(homedir(), paths, tempDir.path),
            args: [
                `--proxy-server=${chromiumProxyServerValue(route.proxyUrl)}`,
                `--ignore-certificate-errors-spki-list=${route.spkiSha256Base64}`,
                ...(config.strictRouteAcceptProxyAuthority ? ['--ignore-certificate-errors'] : []),
                '--disable-quic',
                // Reading the operator's trust domain must not mean writing to their
                // keychain: without this Chromium would create its own Safe Storage item
                // and macOS would raise a second, undisclosed password prompt.
                '--use-mock-keychain',
                // Chromium's own log is the one place a startup CHECK always writes its
                // FATAL line before the process traps; the playwright wrapper surfaces
                // only a bounded excerpt, so the full log goes to a route-owned file.
                '--enable-logging',
                `--log-file=${diagnostics.chromiumLogPath}`,
                ...(config.noSandbox ? ['--no-sandbox'] : []),
            ],
            userDataDir: paths.profile,
            extensionPaths: [],
            userAgent,
            viewport,
            browserProcessLogger: diagnostics.browserProcessLogger,
            ignoreDefaultArgs: diagnostics.ignoreDefaultArgs,
        });
        context = launched;
        launchBoundary = BrowserLaunchBoundary.PageSetup;
        logger.info(
            {
                routeId: route.routeId,
                launchMs: Date.now() - strictRouteLaunchStartedAt,
            },
            'strict route browser launched',
        );
        const page = await launched.newPage();
        await page.setViewportSize(viewport);
        logger.info(
            { routeId: route.routeId, totalMs: Date.now() - strictRouteLaunchStartedAt },
            'strict route browser session ready',
        );
        return {
            browser: launched,
            page,
            profileDir: routeRoot,
            strictRouteId: route.routeId,
            strictRouteTempDir: tempDir.path,
        };
    } catch (error) {
        await context?.close().catch(() => undefined);
        // The temp dir holds only the dead singleton socket, so it is disposed even
        // though the route root itself is preserved for forensics.
        tempDir.dispose();
        // The route root is deliberately NOT removed: it holds the Chromium log, the
        // teed browser output, and any crashpad dump the dead browser left behind —
        // exactly the forensics a startup crash needs. In CI the route root sits inside
        // the proxy-CLI workspace, which the run wrapper sweeps into the diagnostics
        // artifact; locally the logged path is the pointer.
        logger.warn(
            {
                routeId: route.routeId,
                launchBoundary,
                routeDiagnosticsDir: routeRoot,
                chromiumLogTail: readLogFileTail(diagnostics.chromiumLogPath),
                error: error instanceof Error ? error.message : String(error),
            },
            'strict route browser launch failed; route root preserved for diagnostics',
        );
        throw new BrowserLaunchError(
            `Failed to launch ${engine.browserType} through strict route.`,
            error,
            launchBoundary,
        );
    }
}
