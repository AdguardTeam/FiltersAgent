import type { Frame, Page, Request, Route } from 'playwright-core';
import type { Logger } from 'pino';
import {
    canonicalHttpOrigin,
    validatePublicHttpUrl,
    type HostnameResolver,
} from './network-safety';
import { RedirectOriginPolicy } from './redirect-origin-policy';
import { isRelatedHost } from './site-identity';

/**
 * Chromium extension pages and workers need their local custom-filter server exempted.
 */
const EXTENSION_PROTOCOL = 'chrome-extension:';

/**
 * Origin retention and public-network checks for one browser session.
 */
export interface NavigationAdmissionOptions {
    /**
     * Reported URL whose host defines related redirect hosts.
     */
    allowedOrigin: string;
    /**
     * Policy for retaining landing origins beyond one load.
     */
    redirectOriginPolicy: RedirectOriginPolicy;
    /**
     * Resolver used for fresh public-address checks.
     */
    resolveHostname: HostnameResolver;
    /**
     * Operational log for retained and temporary landing origins, and for route actions the guard
     * could not settle because the browser had closed.
     */
    logger?: Logger;
}

/**
 * Admission state shared by navigation tools and the context-wide network guard.
 */
export interface NavigationAdmission {
    /**
     * Invalid reported origin detail, when configuration cannot admit any navigation.
     */
    configurationError: string | undefined;
    /**
     * Read origins available to subsequent tool navigation.
     *
     * @returns Retained origins.
     */
    sessionOrigins(): string[];
    /**
     * Read origins admitted during the active load.
     *
     * @returns Retained and temporary origins.
     */
    currentLoadOrigins(): string[];
    /**
     * Discard temporary origins and a previous blocked navigation before a new open_page call.
     *
     * @returns Nothing.
     */
    resetLoad(): void;
    /**
     * Allow public site redirects while the admitted page is loading.
     *
     * @returns Nothing.
     */
    openWindow(): void;
    /**
     * Restrict later main-frame navigation to origins admitted for the current load.
     *
     * @returns Nothing.
     */
    closeWindow(): void;
    /**
     * Validate a main-frame navigation and retain its origin according to policy.
     *
     * @param rawUrl - Requested or landed URL.
     * @returns Promise resolved for an admitted navigation.
     */
    admitMainNavigation(rawUrl: string): Promise<void>;
    /**
     * Install one persistent guard for all pages in the browser context.
     *
     * @param page - Active issue page whose main-frame navigations require origin admission.
     * @returns Promise resolved once the guard is registered.
     */
    installGuard(page: Page): Promise<void>;
    /**
     * Consume the latest refused main-frame navigation detail.
     *
     * @returns Error detail, or undefined when no refusal remains.
     */
    takeBlockedNavigationError(): string | undefined;
}

/**
 * Read a request's frame when Playwright can associate one with it.
 *
 * @param request - Request that may originate in a worker or a not-yet-created popup frame.
 * @returns Associated frame, or undefined when Playwright cannot provide it.
 */
export function requestFrame(request: Request): Frame | undefined {
    try {
        return request.frame();
    } catch {
        return undefined;
    }
}

/**
 * Create origin admission state and a context-wide public-network guard.
 *
 * @param options - Reported origin, retention policy, resolver and optional log.
 * @returns Session-scoped admission operations.
 */
export function createNavigationAdmission(
    options: NavigationAdmissionOptions,
): NavigationAdmission {
    const origins = new Set<string>();
    const temporaryOrigins = new Set<string>();
    let configurationError: string | undefined;
    let issueHostname = '';
    try {
        const origin = canonicalHttpOrigin(options.allowedOrigin);
        origins.add(origin);
        issueHostname = new URL(origin).hostname;
    } catch (error) {
        configurationError = (error as Error).message;
    }
    let windowOpen = false;
    let blockedNavigationError: string | undefined;
    let guardInstall: Promise<void> | undefined;

    /**
     * Validate one main-frame destination and record newly admitted origins.
     *
     * @param rawUrl - Requested or landed URL.
     * @returns Promise resolved when the navigation is safe and admitted.
     */
    async function admitMainNavigation(rawUrl: string): Promise<void> {
        const url = await validatePublicHttpUrl(rawUrl, {
            ...(windowOpen ? {} : { expectedOrigins: [...origins, ...temporaryOrigins] }),
            resolveHostname: options.resolveHostname,
        });
        if (origins.has(url.origin) || temporaryOrigins.has(url.origin)) {
            return;
        }
        const retained =
            options.redirectOriginPolicy === RedirectOriginPolicy.KeepEveryLanding ||
            isRelatedHost(url.hostname, issueHostname);
        (retained ? origins : temporaryOrigins).add(url.origin);
        options.logger?.info(
            { landingOrigin: url.origin, sessionOrigins: [...origins], retained },
            retained
                ? 'redirect landing origin retained for this session'
                : 'redirect landing origin admitted for the current load only',
        );
    }

    /**
     * Decide whether one intercepted request may proceed, recording a refused main-frame
     * navigation.
     *
     * @param page - Issue page whose main frame is origin-restricted.
     * @param request - The intercepted request.
     * @returns `true` when the request may proceed, `false` when the guard refuses it.
     */
    async function admitsRequest(page: Page, request: Request): Promise<boolean> {
        let mainNavigation = false;
        try {
            const rawUrl = request.url();
            const protocol = new URL(rawUrl).protocol;
            if (protocol !== 'http:' && protocol !== 'https:') {
                return true;
            }
            const frame = requestFrame(request);
            mainNavigation =
                frame !== undefined && frame === page.mainFrame() && request.isNavigationRequest();
            if (mainNavigation) {
                await admitMainNavigation(rawUrl);
                return true;
            }
            const extensionRequest =
                request.serviceWorker()?.url().startsWith(EXTENSION_PROTOCOL) === true ||
                (!request.isNavigationRequest() &&
                    frame !== undefined &&
                    new URL(frame.page().mainFrame().url()).protocol === EXTENSION_PROTOCOL);
            if (!extensionRequest) {
                await validatePublicHttpUrl(rawUrl, { resolveHostname: options.resolveHostname });
            }
            return true;
        } catch (error) {
            if (mainNavigation) {
                blockedNavigationError = (error as Error).message;
            }
            return false;
        }
    }

    /**
     * Register one context-wide guard with main-frame admission before extension exemptions.
     *
     * @param page - Issue page whose main frame is origin-restricted.
     * @returns Promise resolved after registration.
     */
    function installGuard(page: Page): Promise<void> {
        if (guardInstall) {
            return guardInstall;
        }
        const guard = async (route: Route, request: Request): Promise<void> => {
            const admitted = await admitsRequest(page, request);
            try {
                await (admitted ? route.fallback() : route.abort('blockedbyclient'));
            } catch (error) {
                // The admission check awaits a DNS lookup, so the browser can close while a
                // request waits on it, and the route action then rejects. Playwright rethrows a
                // route callback's rejection outside every caller, where it kills the process on
                // an unhandled rejection; the request is gone with its page either way.
                options.logger?.warn(
                    { err: error, url: request.url(), admitted },
                    'the network guard could not settle an intercepted request',
                );
            }
        };
        guardInstall = page
            .context()
            .route('**/*', guard)
            .then(() => undefined);
        return guardInstall;
    }

    return {
        configurationError,
        sessionOrigins: () => [...origins],
        currentLoadOrigins: () => [...origins, ...temporaryOrigins],
        resetLoad: () => {
            temporaryOrigins.clear();
            blockedNavigationError = undefined;
        },
        openWindow: () => {
            windowOpen = true;
        },
        closeWindow: () => {
            windowOpen = false;
        },
        admitMainNavigation,
        installGuard,
        takeBlockedNavigationError: () => {
            const error = blockedNavigationError;
            blockedNavigationError = undefined;
            return error;
        },
    };
}
