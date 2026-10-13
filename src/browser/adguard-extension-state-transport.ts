import type { BrowserContext, Page } from 'playwright-core';
import { ExtensionManifestVersion } from '../environment/extension-preparation';
import {
    delay,
    findExtensionRuntime,
    formatError,
    type ExtensionRuntimeHints,
    type ExtensionRuntimeLocation,
} from './extension-runtime-location';

/**
 * The app-message transport and bounded readiness posture of the AdGuard extension state read.
 *
 * The host reads the blocker state back itself. Every such read goes over one transport — the
 * options page's `chrome.runtime.sendMessage` — and shares one bounded readiness posture: one
 * shared wall-clock budget, a retry delay, and a per-wait floor, so a slow early wait never starves
 * a later one.
 *
 * The host read-back functions built on this transport live in `adguard-extension-state-read.ts`.
 */

/**
 * Default shared wall-clock budget for one state read when no override is supplied.
 *
 * Even on fast hardware a fresh install loading a large filter set (hundreds of thousands of rules)
 * spends 6-10 seconds before the app reports readiness, and CI load stretches that further. The
 * waits poll every {@link READINESS_RETRY_DELAY_MS} and return the moment the extension is ready,
 * so a generous ceiling costs a fast session nothing.
 */
export const DEFAULT_READINESS_BUDGET_MS = 30_000;

/**
 * Minimum wall-clock allowance each individual readiness wait keeps within the shared budget.
 *
 * The floor prevents a slow early wait from starving the later ones down to a single probe.
 */
const READINESS_WAIT_FLOOR_MS = 5_000;

/**
 * Delay between read-only readiness probes.
 */
export const READINESS_RETRY_DELAY_MS = 100;

/**
 * Caller-tunable knobs for the bounded readiness waits.
 */
export interface ExtensionReadinessOptions {
    /**
     * Wall-clock budget shared by all readiness waits of one state read.
     *
     * Sharing bounds the worst case of a whole read by one budget instead of multiplying it per
     * wait, so a raised phase budget composes safely with the outer apply_rule tool deadline. Each
     * individual wait still keeps at least the built-in per-wait floor even when earlier waits
     * consumed most of the shared budget.
     */
    budgetMs?: number;
}

/**
 * Rejection marker produced by webextension-polyfill when a background listener's promise rejects.
 *
 * Chromium's raw `chrome.runtime.sendMessage` resolves this marker as an ordinary value, so without
 * interception it reaches response validation as a plain object and every failure detail — for
 * example a LevelDB `FILE_ERROR_NO_SPACE` under disk pressure — collapses into a generic validation
 * error.
 */
const POLYFILL_REJECTION_KEY = '__mozWebExtensionPolyfillReject__';

/**
 * Thrown when the extension background answered a message with a polyfill rejection marker.
 *
 * The rejection means transport and the background listener are alive but the handler itself
 * failed; the verbatim background failure text survives on the error for diagnostics and
 * infrastructure classification.
 */
export class ExtensionMessageRejectionError extends Error {
    /**
     * AdGuard application message type that was rejected.
     */
    readonly messageType: string;

    /**
     * Verbatim failure detail reported by the background listener.
     */
    readonly rejectionDetail: string;

    /**
     * @param messageType - AdGuard application message type that was rejected.
     * @param rejectionDetail - Verbatim failure detail reported by the background listener.
     */
    constructor(messageType: string, rejectionDetail: string) {
        super(`AdGuard background rejected the "${messageType}" message: ${rejectionDetail}`);
        this.name = 'ExtensionMessageRejectionError';
        this.messageType = messageType;
        this.rejectionDetail = rejectionDetail;
    }
}

/**
 * Detect the webextension-polyfill rejection marker on a fulfilled message response.
 *
 * @param response - Raw value resolved by `chrome.runtime.sendMessage`.
 * @returns The verbatim rejection detail, or null when the response is not a rejection marker.
 */
function polyfillRejectionDetail(response: unknown): string | null {
    if (typeof response !== 'object' || response === null) {
        return null;
    }
    const marker = response as Record<string, unknown>;
    if (marker[POLYFILL_REJECTION_KEY] !== true) {
        return null;
    }
    // The polyfill contract only guarantees the boolean flag; the message field's type does not.
    return typeof marker.message === 'string'
        ? marker.message
        : String(marker.message ?? 'unknown polyfill rejection');
}

/**
 * App message sent from the AdGuard options page to its background worker.
 */
interface ExtensionMessage {
    /**
     * AdGuard application message type.
     */
    type: string;

    /**
     * Optional message payload.
     */
    data?: Record<string, unknown>;
}

/**
 * Routed application message understood by AdGuard's shared extension dispatcher.
 */
interface RoutedExtensionMessage extends ExtensionMessage {
    /**
     * Fixed AdGuard handler namespace for options application messages.
     */
    handlerName: 'app';
}

/**
 * Chrome extension runtime messaging surface exposed to an options page.
 */
interface ExtensionRuntime {
    /**
     * Send one application message to the extension background worker.
     *
     * @param value - Serializable extension message.
     * @returns Raw response from the background listener.
     */
    sendMessage(value: unknown): Promise<unknown>;
}

/**
 * Chrome namespace exposed to an extension options page.
 */
interface ExtensionChromeNamespace {
    /**
     * Optional runtime namespace while the options app initializes.
     */
    runtime?: ExtensionRuntime;
}

/**
 * Minimal global surface used inside Playwright page evaluation.
 */
interface ExtensionPageGlobal {
    /**
     * Optional Chrome extension namespace.
     */
    chrome?: ExtensionChromeNamespace;
}

/**
 * Send one AdGuard app message from the privileged extension options page.
 *
 * @param page - Loaded AdGuard options page.
 * @param message - App message payload.
 * @returns Raw app response.
 */
export async function sendExtensionMessage(
    page: Page,
    message: ExtensionMessage,
): Promise<unknown> {
    const routedMessage: RoutedExtensionMessage = {
        handlerName: 'app',
        ...message,
    };
    const response = await page.evaluate<unknown, RoutedExtensionMessage>(async (payload) => {
        const runtime = (globalThis as unknown as ExtensionPageGlobal).chrome?.runtime;

        if (!runtime || typeof runtime.sendMessage !== 'function') {
            throw new Error('chrome.runtime.sendMessage is unavailable on the options page.');
        }

        return runtime.sendMessage(payload);
    }, routedMessage);
    // Interception happens Node-side so the typed class survives; an in-page throw would be
    // flattened by Playwright's error serialization.
    const rejectionDetail = polyfillRejectionDetail(response);
    if (rejectionDetail !== null) {
        throw new ExtensionMessageRejectionError(message.type, rejectionDetail);
    }
    return response;
}

/**
 * Bound one readiness wait by the shared state-read deadline without starving it below the floor.
 *
 * @param sharedDeadlineAt - Absolute deadline of the whole state read.
 * @param startedAt - Start timestamp of this wait.
 * @returns Absolute deadline for this wait.
 */
export function readinessWaitDeadline(sharedDeadlineAt: number, startedAt: number): number {
    return Math.max(sharedDeadlineAt, startedAt + READINESS_WAIT_FLOOR_MS);
}

/**
 * One bounded readiness probe's knobs.
 */
interface ReadinessProbeOptions<T> {
    /**
     * Loaded AdGuard options page.
     */
    page: Page;

    /**
     * Absolute deadline of the whole state read.
     */
    sharedDeadlineAt: number;

    /**
     * Human label of the state family, for the typed failure text.
     */
    label: string;

    /**
     * One read attempt.
     */
    probe: () => Promise<T>;
}

/**
 * Run one read probe until it succeeds, bounded by the shared state-read deadline.
 *
 * Every state read over the transport shares one retry posture: a transient transport or validation
 * failure probes again after the retry delay, until the deadline (with its per-wait floor) cuts the
 * wait off with a typed failure carrying the last error — never a bare code.
 *
 * @param options - The probe's knobs.
 * @returns The first successful probe result.
 */
export async function probeUntilReady<T>(options: ReadinessProbeOptions<T>): Promise<T> {
    let lastError: unknown;
    const startedAt = Date.now();
    const deadline = readinessWaitDeadline(options.sharedDeadlineAt, startedAt);
    let attempts = 0;

    for (;;) {
        attempts += 1;
        try {
            return await options.probe();
        } catch (error) {
            lastError = error;
            if (Date.now() + READINESS_RETRY_DELAY_MS >= deadline) {
                break;
            }
            await delay(READINESS_RETRY_DELAY_MS);
        }
    }

    throw new Error(
        `${options.label} after ${attempts} probes over ` +
            `${Date.now() - startedAt}ms: ${formatError(lastError)}`,
        { cause: lastError },
    );
}

/**
 * The opened options page plus the runtime it was opened against.
 */
interface OpenedOptionsPage {
    /**
     * Located Chromium extension runtime.
     */
    runtime: ExtensionRuntimeLocation;

    /**
     * The options page opened for the message transport.
     */
    page: Page;

    /**
     * Exact options page URL the page was opened on.
     */
    optionsPageUrl: string;
}

/**
 * Open the prepared extension's options page once for the message transport.
 *
 * @param context - Persistent Playwright context containing the prepared extension.
 * @param expectedManifestVersion - Manifest generation verified from the extension build.
 * @param hints - Profile and extension paths used for Preferences-based MV2 discovery.
 * @returns The located runtime, the opened page, and its options page URL.
 */
export async function openOptionsPage(
    context: BrowserContext,
    expectedManifestVersion: ExtensionManifestVersion,
    hints?: ExtensionRuntimeHints,
): Promise<OpenedOptionsPage> {
    const runtime = await findExtensionRuntime(context, expectedManifestVersion, hints);
    const optionsPageUrl = `chrome-extension://${runtime.extensionId}/pages/options.html`;
    const page = await context.newPage();
    await page.goto(optionsPageUrl, { waitUntil: 'load' });
    return { runtime, page, optionsPageUrl };
}
