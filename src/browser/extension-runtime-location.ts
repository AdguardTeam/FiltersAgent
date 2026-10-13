import { readFile, realpath } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import type { BrowserContext, Page, Worker } from 'playwright-core';
import { ExtensionManifestVersion } from '../environment/extension-preparation';

/**
 * The located-runtime half of the prepared-extension read surface: how the host finds the prepared
 * extension's background runtime inside a persistent context and derives the stable extension ID
 * the options-page transport needs.
 *
 * This module carries the location and pacing helpers the state read-back shares, so the
 * message-based reads keep one home.
 */

/**
 * Maximum time spent waiting for an AdGuard MV3 service worker.
 */
const SERVICE_WORKER_TIMEOUT_MS = 15_000;

/**
 * Delay between profile Preferences probes while the browser records an MV2 extension.
 */
const PREFERENCES_RETRY_DELAY_MS = 200;

/**
 * Chromium extension IDs consist of 32 lowercase characters in the `a`-`p` range.
 */
const CHROMIUM_EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

/**
 * Located Chromium extension runtime used to derive the stable extension ID.
 */
export interface ExtensionRuntimeLocation {
    /**
     * Chromium-generated identifier for the loaded unpacked extension.
     */
    extensionId: string;

    /**
     * Manifest generation represented by the runtime host.
     */
    manifestVersion: ExtensionManifestVersion;
}

/**
 * Filesystem hints used to resolve the MV2 runtime when the browser hides background pages.
 */
export interface ExtensionRuntimeHints {
    /**
     * Persistent profile user-data directory launched with the unpacked extension.
     */
    profilePath?: string;

    /**
     * Absolute path of the unpacked extension passed to the browser at launch.
     */
    extensionPath?: string;

    /**
     * Bounded override for the Preferences discovery deadline; defaults to the worker timeout.
     */
    discoveryTimeoutMs?: number;
}

/**
 * Pause between bounded readiness probes.
 *
 * @param milliseconds - Delay duration.
 * @returns Promise resolved after the delay.
 */
export function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

/**
 * Convert an unknown failure into a bounded diagnostic string.
 *
 * @param error - Unknown caught value.
 * @returns Human-readable error detail.
 */
export function formatError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error ?? 'unknown error');
}

/**
 * Return whether a worker belongs to a Chromium extension.
 *
 * @param worker - Playwright service worker candidate.
 * @returns True for a well-formed chrome-extension worker URL.
 */
function isChromeExtensionWorker(worker: Worker): boolean {
    try {
        const url = new URL(worker.url());
        return (
            url.protocol === 'chrome-extension:' && CHROMIUM_EXTENSION_ID_PATTERN.test(url.hostname)
        );
    } catch {
        return false;
    }
}

/**
 * Return whether a page is a Chromium extension background page.
 *
 * @param page - Playwright page candidate.
 * @returns True for a well-formed chrome-extension page URL.
 */
function isChromeExtensionPage(page: Page): boolean {
    try {
        const url = new URL(page.url());
        return (
            url.protocol === 'chrome-extension:' && CHROMIUM_EXTENSION_ID_PATTERN.test(url.hostname)
        );
    } catch {
        return false;
    }
}

/**
 * Locate the sole Chromium extension service worker in the persistent context.
 *
 * @param context - Persistent Playwright context launched with AdGuard MV3.
 * @returns The AdGuard extension service worker.
 */
async function findExtensionWorker(context: BrowserContext): Promise<Worker> {
    const existingWorkers = context.serviceWorkers().filter(isChromeExtensionWorker);
    if (existingWorkers.length > 1) {
        throw new Error('Multiple Chromium extension service workers were found.');
    }
    if (existingWorkers.length === 1) {
        return existingWorkers[0];
    }

    try {
        const worker = await context.waitForEvent('serviceworker', {
            predicate: isChromeExtensionWorker,
            timeout: SERVICE_WORKER_TIMEOUT_MS,
        });
        if (!isChromeExtensionWorker(worker)) {
            throw new Error('The discovered service worker is not a Chromium extension worker.');
        }
        return worker;
    } catch (error) {
        throw new Error(
            `Timed out waiting for the AdGuard MV3 service worker: ${formatError(error)}`,
            { cause: error },
        );
    }
}

/**
 * Extract a validated Chromium extension ID from a service worker.
 *
 * @param worker - Located extension service worker.
 * @returns Chromium extension ID.
 */
function getExtensionId(worker: Worker): string {
    const extensionId = new URL(worker.url()).hostname;
    if (!CHROMIUM_EXTENSION_ID_PATTERN.test(extensionId)) {
        throw new Error('AdGuard MV3 service worker has an invalid extension ID.');
    }
    return extensionId;
}

/**
 * Extract a validated Chromium extension ID from an extension page URL.
 *
 * @param page - Located extension background page.
 * @returns Chromium extension ID.
 */
function getExtensionPageId(page: Page): string {
    const extensionId = new URL(page.url()).hostname;
    if (!CHROMIUM_EXTENSION_ID_PATTERN.test(extensionId)) {
        throw new Error('AdGuard MV2 background page has an invalid extension ID.');
    }
    return extensionId;
}

/**
 * Locate the MV2 persistent background page for the sole loaded unpacked extension.
 *
 * @param context - Persistent Playwright context launched with AdGuard MV2.
 * @returns The AdGuard extension background page.
 */
async function findExtensionBackgroundPage(context: BrowserContext): Promise<Page> {
    const existingPages = context.backgroundPages().filter(isChromeExtensionPage);
    if (existingPages.length > 1) {
        throw new Error('Multiple Chromium extension background pages were found.');
    }
    if (existingPages.length === 1) {
        return existingPages[0];
    }

    try {
        const page = await context.waitForEvent('backgroundpage', {
            predicate: isChromeExtensionPage,
            timeout: SERVICE_WORKER_TIMEOUT_MS,
        });
        if (!isChromeExtensionPage(page)) {
            throw new Error('The discovered background page is not a Chromium extension page.');
        }
        return page;
    } catch (error) {
        throw new Error(
            `Timed out waiting for the AdGuard MV2 background page: ${formatError(error)}`,
            { cause: error },
        );
    }
}

/**
 * One extension record read from the Chromium profile Preferences file.
 */
interface PreferencesExtensionEntry {
    /**
     * Absolute path recorded for the loaded extension, when present.
     */
    path?: unknown;
}

/**
 * Minimal shape of the Chromium profile Preferences file consulted for MV2 discovery.
 */
interface PreferencesRoot {
    /**
     * Extension bookkeeping namespace written by the browser.
     */
    extensions?: {
        /**
         * Per-extension records keyed by Chromium extension ID.
         */
        settings?: Record<string, PreferencesExtensionEntry | null>;
    };
}

/**
 * Successful MV2 identity discovery result.
 */
interface Mv2ExtensionIdFound {
    /**
     * Discovered Chromium extension ID.
     */
    extensionId: string;
}

/**
 * Incomplete MV2 identity discovery carrying the last diagnostic detail.
 */
interface Mv2ExtensionIdMissing {
    /**
     * Human-readable reason the Preferences file did not yield the extension ID.
     */
    detail: string;
}

/**
 * Compare a Preferences-recorded path with the launched extension path, tolerating aliases.
 *
 * @param recordedPath - Path string recorded by the browser in Preferences.
 * @param extensionPath - Absolute unpacked extension path passed at launch.
 * @returns Whether both paths identify the same directory.
 */
async function preferencesPathMatches(
    recordedPath: string,
    extensionPath: string,
): Promise<boolean> {
    if (recordedPath === extensionPath) {
        return true;
    }
    if (resolvePath(recordedPath) === resolvePath(extensionPath)) {
        return true;
    }
    try {
        return (await realpath(recordedPath)) === (await realpath(extensionPath));
    } catch {
        return false;
    }
}

/**
 * Read the extension ID recorded for the launched path in the profile Preferences file.
 *
 * @param profilePath - Persistent profile user-data directory.
 * @param extensionPath - Absolute unpacked extension path passed at launch.
 * @returns Matching extension ID, or a diagnostic detail when none matched.
 */
async function readMv2ExtensionIdFromPreferences(
    profilePath: string,
    extensionPath: string,
): Promise<Mv2ExtensionIdFound | Mv2ExtensionIdMissing> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(await readFile(join(profilePath, 'Default', 'Preferences'), 'utf8'));
    } catch (error) {
        return { detail: `Preferences read failed: ${formatError(error)}` };
    }
    const settings = (parsed as PreferencesRoot | null)?.extensions?.settings;
    if (settings === undefined || Array.isArray(settings)) {
        return { detail: 'Preferences has no extensions.settings object yet.' };
    }
    const matches: string[] = [];
    for (const [id, entry] of Object.entries(settings)) {
        const recordedPath = entry?.path;
        if (typeof recordedPath !== 'string' || !CHROMIUM_EXTENSION_ID_PATTERN.test(id)) {
            continue;
        }
        if (await preferencesPathMatches(recordedPath, extensionPath)) {
            matches.push(id);
        }
    }
    if (matches.length > 1) {
        return {
            detail: `Multiple extension IDs match the loaded extension path: ${matches.join(', ')}.`,
        };
    }
    if (matches.length === 1) {
        return { extensionId: matches[0] };
    }
    return { detail: 'No Preferences extension entry matches the loaded extension path yet.' };
}

/**
 * Poll the profile Preferences until the browser records the launched MV2 extension.
 *
 * @param hints - Profile and extension paths used at launch.
 * @returns Discovered Chromium extension ID.
 */
async function waitForMv2ExtensionIdFromPreferences(hints: ExtensionRuntimeHints): Promise<string> {
    const deadline = Date.now() + (hints.discoveryTimeoutMs ?? SERVICE_WORKER_TIMEOUT_MS);
    let detail = 'Preferences discovery has not run yet.';
    while (Date.now() < deadline) {
        const result = await readMv2ExtensionIdFromPreferences(
            hints.profilePath as string,
            hints.extensionPath as string,
        );
        if ('extensionId' in result) {
            return result.extensionId;
        }
        detail = result.detail;
        await delay(PREFERENCES_RETRY_DELAY_MS);
    }
    throw new Error(
        `Timed out discovering the AdGuard MV2 extension ID from the profile Preferences: ${detail}`,
    );
}

/**
 * Locate the extension runtime matching the expected manifest generation.
 *
 * @param context - Persistent Playwright extension context.
 * @param expectedManifestVersion - Manifest generation verified from the built manifest.
 * @param hints - Profile and extension paths used for Preferences-based MV2 discovery.
 * @returns Located extension ID and runtime generation.
 */
export async function findExtensionRuntime(
    context: BrowserContext,
    expectedManifestVersion: ExtensionManifestVersion,
    hints?: ExtensionRuntimeHints,
): Promise<ExtensionRuntimeLocation> {
    if (expectedManifestVersion === ExtensionManifestVersion.Mv2) {
        if (hints?.profilePath !== undefined && hints.extensionPath !== undefined) {
            return {
                extensionId: await waitForMv2ExtensionIdFromPreferences(hints),
                manifestVersion: ExtensionManifestVersion.Mv2,
            };
        }
        const page = await findExtensionBackgroundPage(context);
        return {
            extensionId: getExtensionPageId(page),
            manifestVersion: ExtensionManifestVersion.Mv2,
        };
    }
    const worker = await findExtensionWorker(context);
    return {
        extensionId: getExtensionId(worker),
        manifestVersion: ExtensionManifestVersion.Mv3,
    };
}
