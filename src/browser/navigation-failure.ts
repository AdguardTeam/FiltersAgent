import { BrowserFallbackReason } from '../types/browser-fallback-reason';

/**
 * Chromium network errors that prove the target could not be reached from the current runner.
 */
const TARGET_UNREACHABLE_ERROR_CODES = new Set([
    'ERR_ADDRESS_UNREACHABLE',
    'ERR_CONNECTION_CLOSED',
    'ERR_CONNECTION_REFUSED',
    'ERR_CONNECTION_RESET',
    'ERR_INTERNET_DISCONNECTED',
    'ERR_NAME_NOT_RESOLVED',
    'ERR_NETWORK_ACCESS_DENIED',
    'ERR_NETWORK_CHANGED',
    'ERR_PROXY_CONNECTION_FAILED',
    'ERR_TUNNEL_CONNECTION_FAILED',
]);

/**
 * Maximum diagnostic text retained after removing browser call-log noise.
 */
const MAX_NAVIGATION_DIAGNOSTIC_LENGTH = 240;

/**
 * Convert an unknown browser error into stable text for bounded inspection.
 *
 * @param error - Error thrown by the browser boundary.
 * @returns String form used only for classification and compact diagnostics.
 */
function browserErrorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Extract one Chromium `ERR_*` network code without retaining a raw Playwright call log.
 *
 * @param error - Error or diagnostic text returned by Chromium navigation.
 * @returns Uppercase Chromium error code, when present.
 */
export function extractBrowserNetworkErrorCode(error: unknown): string | undefined {
    return /\b(ERR_[A-Z0-9_]+)\b/u.exec(browserErrorText(error))?.[1];
}

/**
 * Classify a navigation failure as target reachability or a bounded navigation timeout.
 *
 * @param error - Error thrown by Playwright navigation or page stabilization.
 * @returns Stable fallback category consumed by the agent runtime.
 */
export function classifyNavigationFailure(error: unknown): BrowserFallbackReason {
    const errorCode = extractBrowserNetworkErrorCode(error);
    return errorCode && TARGET_UNREACHABLE_ERROR_CODES.has(errorCode)
        ? BrowserFallbackReason.TargetUnreachable
        : BrowserFallbackReason.NavigationTimeout;
}

/**
 * Remove credentials, query parameters, and fragments from a user-visible navigation target.
 *
 * @param rawUrl - Validated browser navigation URL.
 * @returns Safe URL suitable for reports, or a generic target label for malformed input.
 */
export function sanitizeNavigationTarget(rawUrl: string): string {
    try {
        const parsed = new URL(rawUrl);
        parsed.username = '';
        parsed.password = '';
        parsed.search = '';
        parsed.hash = '';
        return parsed.href;
    } catch {
        return 'the reported target';
    }
}

/**
 * Remove multiline Playwright call logs and bound a non-reachability navigation diagnostic.
 *
 * @param error - Raw browser error retained only inside the current process.
 * @returns Compact single-line diagnostic with no Playwright call log.
 */
function compactNavigationDiagnostic(error: unknown): string {
    const firstSection = browserErrorText(error).split(/\nCall log:/u, 1)[0] ?? '';
    const singleLine = firstSection.replace(/\s+/gu, ' ').trim();
    return singleLine.slice(0, MAX_NAVIGATION_DIAGNOSTIC_LENGTH);
}

/**
 * Render a concise model- and user-facing navigation failure.
 *
 * @param fallbackReason - Classified browser fallback category.
 * @param error - Original browser error, used only for a bounded summary.
 * @param targetUrl - Validated target URL.
 * @param attempts - Physical navigation attempts made by this tool call.
 * @returns Concise diagnostic that distinguishes an unreachable target from a timeout.
 */
export function formatNavigationFailure(
    fallbackReason: BrowserFallbackReason,
    error: unknown,
    targetUrl: string,
    attempts: number,
): string {
    const safeTarget = sanitizeNavigationTarget(targetUrl);
    const attemptLabel = `${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}`;
    const errorCode = extractBrowserNetworkErrorCode(error);
    if (fallbackReason === BrowserFallbackReason.TargetUnreachable) {
        return (
            `Target unreachable from this runner after ${attemptLabel}: ${safeTarget} ` +
            `(${errorCode ?? 'network connection failed'}).`
        );
    }
    const diagnostic = compactNavigationDiagnostic(error);
    return (
        `Navigation did not complete after ${attemptLabel}: ${safeTarget}` +
        `${diagnostic ? ` (${diagnostic})` : ''}.`
    );
}
