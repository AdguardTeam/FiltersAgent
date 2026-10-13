import { createHash } from 'node:crypto';

/**
 * Private state retained for one isolated browser route.
 */
export interface StrictBrowserRouteState {
    /**
     * Route identity.
     */
    routeId: string;
    /**
     * Owning cycle identity.
     */
    cycleId: string;
    /**
     * Exact canonical target URL.
     */
    targetUrl: string;
    /**
     * Loopback HTTP proxy URL.
     */
    proxyUrl: string;
    /**
     * Canonical Chromium SPKI SHA-256 pin.
     */
    spkiSha256Base64: string;
    /**
     * Generated CA certificate encoded as base64 DER.
     */
    certificateDerBase64: string;
    /**
     * SHA-256 of generated CA DER.
     */
    certificateSha256: string;
    /**
     * Canonical agent-owned browser root.
     */
    browserRoot: string;
    /**
     * Expiration timestamp for this one-use route.
     */
    expiresAt: string;
}

declare const preparedStrictBrowserRouteBrand: unique symbol;

/**
 * Opaque one-use browser route issued by trusted Host code.
 */
export interface PreparedStrictBrowserRoute {
    /**
     * Prevent structural construction.
     */
    readonly [preparedStrictBrowserRouteBrand]: true;
}

interface StoredStrictRoute {
    /**
     * Immutable private route state.
     */
    state: Readonly<StrictBrowserRouteState>;
    /**
     * Whether the route was consumed by a browser.
     */
    consumed: boolean;
}

const strictRouteStates = new WeakMap<PreparedStrictBrowserRoute, StoredStrictRoute>();

/**
 * Validate a canonical credential-free HTTP or HTTPS route target.
 *
 * Plain `http:` targets are accepted deliberately: reporters paste them and refusing one fails the
 * task, the CLI proxy filters plaintext traffic exactly as it filters TLS, and the route's TLS
 * machinery — the SPKI launch pin — simply never engages for a connection that carries no
 * certificate. Fragments are accepted because the reporter's URL may carry one and `page.url()`
 * echoes it back; they never reach the network.
 *
 * @param value - Candidate URL.
 * @returns Parsed canonical URL.
 */
function parseStrictTargetUrl(value: string): URL {
    const url = new URL(value);
    if (
        (url.protocol !== 'https:' && url.protocol !== 'http:') ||
        url.username !== '' ||
        url.password !== '' ||
        url.href !== value
    ) {
        throw new Error('strict_route_target_invalid');
    }
    return url;
}

/**
 * Issue one opaque strict browser route after validating all public bindings.
 *
 * @param state - Private route state.
 * @returns One-use route capability.
 */
export function createPreparedStrictBrowserRoute(
    state: StrictBrowserRouteState,
): PreparedStrictBrowserRoute {
    parseStrictTargetUrl(state.targetUrl);
    const proxy = new URL(state.proxyUrl);
    if (
        proxy.protocol !== 'http:' ||
        proxy.hostname !== '127.0.0.1' ||
        proxy.username !== '' ||
        proxy.password !== '' ||
        proxy.pathname !== '/' ||
        proxy.search !== '' ||
        proxy.hash !== '' ||
        proxy.port === ''
    ) {
        throw new Error('strict_route_proxy_invalid');
    }
    if (!/^[A-Za-z0-9+/]{43}=$/u.test(state.spkiSha256Base64)) {
        throw new Error('strict_route_spki_invalid');
    }
    const certificate = Buffer.from(state.certificateDerBase64, 'base64');
    const certificateSha256 = createHash('sha256').update(certificate).digest('hex');
    if (certificateSha256 !== state.certificateSha256) {
        throw new Error('strict_route_certificate_mismatch');
    }
    if (Date.parse(state.expiresAt) <= Date.now()) {
        throw new Error('strict_route_expired');
    }
    const route = Object.freeze(Object.create(null)) as PreparedStrictBrowserRoute;
    strictRouteStates.set(route, {
        state: Object.freeze(structuredClone(state)),
        consumed: false,
    });
    return route;
}

/**
 * Inspect an issued route without consuming it.
 *
 * @param route - Opaque route capability.
 * @returns Defensive private state copy, or null for a forged capability.
 */
export function inspectPreparedStrictBrowserRoute(
    route: PreparedStrictBrowserRoute,
): StrictBrowserRouteState | null {
    const stored = strictRouteStates.get(route);
    return stored ? structuredClone(stored.state) : null;
}

/**
 * Atomically consume one route for its exact target.
 *
 * @param route - Opaque route capability.
 * @param targetUrl - Exact target the browser will navigate.
 * @param now - Current time used for expiry checks.
 * @returns Private state for trusted browser code.
 */
export function consumePreparedStrictBrowserRoute(
    route: PreparedStrictBrowserRoute,
    targetUrl: string,
    now: Date = new Date(),
): StrictBrowserRouteState {
    const stored = strictRouteStates.get(route);
    if (!stored) {
        throw new Error('strict_route_forged');
    }
    if (stored.consumed) {
        throw new Error('strict_route_replayed');
    }
    if (stored.state.targetUrl !== targetUrl) {
        throw new Error('strict_route_target_mismatch');
    }
    if (Date.parse(stored.state.expiresAt) <= now.getTime()) {
        throw new Error('strict_route_expired');
    }
    stored.consumed = true;
    return structuredClone(stored.state);
}
