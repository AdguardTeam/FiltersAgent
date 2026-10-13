import type { BrowserContext } from 'playwright-core';
import type { Logger } from '../logger/logger';
import { delay } from './extension-runtime-location';

/**
 * Chromium's per-extension "Allow User Scripts" toggle, flipped on through the browser's own
 * extensions page.
 *
 * Chromium 138+ exposes `chrome.userScripts` to an extension only after that toggle is on, and the
 * pinned AdGuard MV3 build applies custom filters only when the API exists: without it the build
 * sends `customFilters: []` to its engine and an imported custom filter is inert. Seeding the
 * profile's Preferences does not turn the toggle on; clicking it on `chrome://extensions` does, and
 * the API is available at once, with no extension reload. Verified live on Chromium 145 headless.
 */

/**
 * Chromium's extensions WebUI, opened on one extension's own detail view.
 */
const EXTENSIONS_PAGE_URL_PREFIX = 'chrome://extensions/?id=';

/**
 * Delay between probes of the extensions WebUI for the toggle row.
 *
 * The detail view renders in a few frames once the page loaded; a quarter second keeps the wait
 * short without hammering the WebUI's DOM walk.
 */
export const TOGGLE_POLL_MS = 250;

/**
 * Wall-clock deadline for the toggle row to render and the click to take.
 *
 * The page normally renders well under a second even headless; ten seconds absorbs a cold profile
 * on a loaded CI runner while still failing a session fast when the WebUI never shows the row.
 */
export const TOGGLE_DEADLINE_MS = 10_000;

/**
 * What the page-side script reports after one probe of the extensions WebUI.
 */
export const ToggleReport = {
    /**
     * The `extensions-toggle-row#allow-user-scripts` element is not in the page yet.
     */
    RowNotFound: 'row not found',

    /**
     * The row exists but has no `cr-toggle` in its shadow root yet.
     */
    ToggleNotFound: 'toggle not found',

    /**
     * The toggle reads back as on, whether it already was or the probe's click turned it on.
     */
    Checked: 'checked=true',

    /**
     * The probe clicked the toggle and it still reads back as off.
     */
    Unchecked: 'checked=false',
} as const;
export type ToggleReport = (typeof ToggleReport)[keyof typeof ToggleReport];

/**
 * The script one probe evaluates in the extensions page, as a string.
 *
 * A string, not a function: the repo runs probes through tsx, whose bundler decorates nested
 * functions with a `__name` helper that the page does not have, so a serialized function body
 * throws inside the browser.
 *
 * The WebUI is Polymer/Lit: `extensions-manager` renders `extensions-detail-view` in its shadow
 * root, which renders the toggle rows in its own, so `querySelector` from `document` never reaches
 * them. `findRow` looks for the row under one root, then descends into every open shadow root under
 * it, depth first. The row itself keeps its `cr-toggle` in its shadow root; a click on that flips
 * `checked` synchronously, so the script clicks only when it reads off and reports the state it
 * reads back.
 */
const ALLOW_USER_SCRIPTS_SCRIPT = `(() => {
    const findRow = (root) => {
        const row = root.querySelector('extensions-toggle-row#allow-user-scripts');
        if (row) {
            return row;
        }
        for (const element of root.querySelectorAll('*')) {
            if (element.shadowRoot) {
                const found = findRow(element.shadowRoot);
                if (found) {
                    return found;
                }
            }
        }
        return null;
    };
    const row = findRow(document);
    if (!row) {
        return ${JSON.stringify(ToggleReport.RowNotFound)};
    }
    const toggle = row.shadowRoot ? row.shadowRoot.querySelector('cr-toggle') : null;
    if (!toggle) {
        return ${JSON.stringify(ToggleReport.ToggleNotFound)};
    }
    if (!toggle.checked) {
        toggle.click();
    }
    return toggle.checked
        ? ${JSON.stringify(ToggleReport.Checked)}
        : ${JSON.stringify(ToggleReport.Unchecked)};
})()`;

/**
 * Pacing overrides for the toggle wait; production callers take the defaults.
 */
export interface AllowUserScriptsOptions {
    /**
     * Delay between probes; defaults to {@link TOGGLE_POLL_MS}.
     */
    pollMs?: number;

    /**
     * Wall-clock deadline for the toggle to read back on; defaults to {@link TOGGLE_DEADLINE_MS}.
     */
    deadlineMs?: number;
}

/**
 * Turn on Chromium's "Allow User Scripts" toggle for one extension.
 *
 * Opens the extension's detail view on `chrome://extensions` in a new page of the persistent
 * context, probes it until the toggle reads back on, and closes the page whether or not it did.
 *
 * @param context - The persistent context the extension is loaded in.
 * @param extensionId - Chromium's id of the loaded extension.
 * @param logger - Where the outcome and each failed probe are logged.
 * @param options - Pacing overrides; production callers omit them.
 * @returns Resolves once the toggle reads back on.
 * @throws Error naming the page's last report when the deadline passes with the toggle still off.
 */
export async function allowUserScripts(
    context: BrowserContext,
    extensionId: string,
    logger: Logger,
    options: AllowUserScriptsOptions = {},
): Promise<void> {
    const pollMs = options.pollMs ?? TOGGLE_POLL_MS;
    const deadlineMs = options.deadlineMs ?? TOGGLE_DEADLINE_MS;
    const url = `${EXTENSIONS_PAGE_URL_PREFIX}${extensionId}`;
    const startedAt = Date.now();
    const page = await context.newPage();
    try {
        await page.goto(url, { waitUntil: 'load' });
        let probes = 0;
        for (;;) {
            // Our own script's answer: one of the reports declared above, trusted as such.
            const report = (await page.evaluate(ALLOW_USER_SCRIPTS_SCRIPT)) as ToggleReport;
            probes += 1;
            const elapsedMs = Date.now() - startedAt;
            if (report === ToggleReport.Checked) {
                logger.info(
                    { extensionId, elapsedMs, probes },
                    'Chromium "Allow User Scripts" is on for the extension',
                );
                return;
            }
            if (elapsedMs >= deadlineMs) {
                throw new Error(
                    `Chromium "Allow User Scripts" did not turn on for extension ${extensionId} ` +
                        `within ${deadlineMs} ms (${probes} probes of ${url}); ` +
                        `the page last reported: ${report}`,
                );
            }
            logger.debug(
                { extensionId, elapsedMs, probes, report },
                'Chromium "Allow User Scripts" toggle not on yet; probing again',
            );
            await delay(pollMs);
        }
    } finally {
        await page.close();
    }
}
