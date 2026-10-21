import type { BrowserContext, Page, Worker } from 'playwright-core';
import type { Logger } from '../logger/logger';
import { delay, getExtensionId, formatError } from './extension-runtime-location';

/**
 * Chromium's per-extension "Allow User Scripts" toggle, flipped on through the browser's own
 * extensions page.
 *
 * Chromium 138+ exposes `chrome.userScripts` to an extension only after that toggle is on, and the
 * pinned AdGuard MV3 build runs raw JavaScript user rules and custom filters only through that API:
 * without it a raw JavaScript user rule does nothing, the build sends `customFilters: []` to its
 * engine and an imported custom filter is inert. Every Chromium launch of such a build turns it on
 * (`launch-wiring.ts`); Chrome itself ships it off. Seeding the profile's Preferences does not turn
 * the toggle on; clicking it on `chrome://extensions` does, and the API is available at once, with
 * no extension reload. Verified live on Chromium 145 headless. The WebUI flips the toggle's own
 * `checked` locally on the click, so an attempt counts only once the extension's service worker
 * itself can call `chrome.userScripts`.
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
 * What one probe reports: the page-side script's reading of the extensions WebUI, or that the
 * toggle reads on while the extension still lacks the API.
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

    /**
     * The toggle reads back as on, but the extension's service worker still cannot use
     * `chrome.userScripts`. Reported by the host, never by the page-side script.
     */
    ApiMissing: 'checked=true, chrome.userScripts unusable in the service worker',
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
 * How many times one launch tries to turn the toggle on, each on a freshly opened extensions page.
 *
 * The toggle is a click in the browser's own WebUI, not a setting the profile can carry, so what
 * fails it is the page: a WebUI that has not rendered the row yet on a cold profile, or a
 * navigation that did not load. A fresh page clears both. Three attempts absorb a slow start; a
 * WebUI that still shows no toggle after that is a browser whose extensions page changed, and
 * another attempt would only repeat the same report.
 */
export const TOGGLE_ATTEMPTS = 3;

/**
 * The script one probe evaluates in the extension's service worker: whether the extension itself
 * can use the API the toggle gates.
 *
 * The same check the pinned build makes before it hands rules to the API: with the toggle off
 * `chrome.userScripts` may still exist while its calls throw, so the probe calls `getScripts()`,
 * and it requires `execute`, which the build runs its rules through. The returned promise is caught
 * so a rejection does not surface in the extension's own error log.
 */
const USER_SCRIPTS_API_ENABLED_SCRIPT = `(() => {
    try {
        chrome.userScripts.getScripts().catch(() => undefined);
        return chrome.userScripts.execute !== undefined;
    } catch {
        return false;
    }
})()`;

/**
 * What a deadline error names when no probe of the attempt finished.
 */
const NO_PROBE_REPORT = 'no probe finished';

/**
 * Pacing overrides for the toggle wait; production callers take the defaults.
 */
export interface AllowUserScriptsOptions {
    /**
     * Delay between probes; defaults to {@link TOGGLE_POLL_MS}.
     */
    pollMs?: number;

    /**
     * Wall-clock bound of one attempt, from opening its page to closing it; defaults to
     * {@link TOGGLE_DEADLINE_MS}.
     */
    deadlineMs?: number;

    /**
     * How many attempts to make before giving up; defaults to {@link TOGGLE_ATTEMPTS}.
     */
    attempts?: number;
}

/**
 * Settle one browser call within the time an attempt has left, or reject naming the step.
 *
 * Playwright's own timeouts do not cover every call (`evaluate` and `close` have none, `goto`
 * defaults to 30 s), so each call of an attempt races the attempt's deadline instead.
 *
 * @param call - The browser call in flight.
 * @param remainingMs - What is left of the attempt's deadline.
 * @param step - The step named in the rejection.
 * @returns The call's result when it settles in time.
 * @throws Error naming the step when the deadline passes first; the call's own rejection otherwise.
 */
async function withinDeadline<T>(call: Promise<T>, remainingMs: number, step: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    // A late rejection after the deadline must not surface as an unhandled rejection.
    call.catch(() => undefined);
    try {
        return await Promise.race([
            call,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`${step} did not settle before the attempt deadline`)),
                    Math.max(remainingMs, 0),
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Probe the toggle once: read it on the extensions page, clicking it when off, and once it reads
 * on, ask the extension's service worker whether it can use the API.
 *
 * @param page - The extensions page opened on the extension's detail view.
 * @param worker - The extension's service worker.
 * @param remainingMs - What is left of the attempt's deadline, read at each call.
 * @returns {@link ToggleReport.Checked} Only when the service worker can use the API; the page's
 *   report, or {@link ToggleReport.ApiMissing}, otherwise.
 * @throws Error naming the step when a call fails or does not settle in time.
 */
async function probeToggle(
    page: Page,
    worker: Worker,
    remainingMs: () => number,
): Promise<ToggleReport> {
    // Our own script's answer: one of the reports declared above, trusted as such.
    const report = (await withinDeadline(
        page.evaluate(ALLOW_USER_SCRIPTS_SCRIPT),
        remainingMs(),
        'probing the toggle',
    )) as ToggleReport;
    if (report !== ToggleReport.Checked) {
        return report;
    }
    const apiEnabled = (await withinDeadline(
        worker.evaluate(USER_SCRIPTS_API_ENABLED_SCRIPT),
        remainingMs(),
        'probing the service worker',
    )) as boolean;
    return apiEnabled ? ToggleReport.Checked : ToggleReport.ApiMissing;
}

/**
 * Make one attempt at turning the toggle on, on a page of its own, within one deadline.
 *
 * Opens the extension's detail view on `chrome://extensions` in a new page of the persistent
 * context and probes it until the toggle reads back on and the service worker can use
 * `chrome.userScripts`, then closes the page. Every browser call, the close included, is bounded by
 * what is left of the deadline.
 *
 * @param context - The persistent context the extension is loaded in.
 * @param worker - The extension's service worker, where the API must appear.
 * @param extensionId - Chromium's id of the loaded extension.
 * @param logger - Where each probe that is not done yet and a close that failed are logged.
 * @param pollMs - Delay between probes.
 * @param deadlineMs - Wall-clock bound of this attempt.
 * @returns The number of probes it took.
 * @throws Error naming the page's last report when the deadline passes before the API appears, or
 *   naming the step when opening, loading or probing the page fails or does not settle in time.
 */
async function allowUserScriptsOnce(
    context: BrowserContext,
    worker: Worker,
    extensionId: string,
    logger: Logger,
    pollMs: number,
    deadlineMs: number,
): Promise<number> {
    const url = `${EXTENSIONS_PAGE_URL_PREFIX}${extensionId}`;
    const startedAt = Date.now();
    const remainingMs = (): number => deadlineMs - (Date.now() - startedAt);
    const page = await withinDeadline(context.newPage(), remainingMs(), 'opening the page');
    try {
        await withinDeadline(
            // A zero timeout means no timeout to Playwright, so the floor is one millisecond.
            page.goto(url, { waitUntil: 'load', timeout: Math.max(remainingMs(), 1) }),
            remainingMs(),
            `loading ${url}`,
        );
        let probes = 0;
        let lastReport: ToggleReport | undefined;
        const deadlinePassed = (cause?: unknown): Error =>
            new Error(
                `Chromium "Allow User Scripts" did not turn on for extension ${extensionId} ` +
                    `within ${deadlineMs} ms (${probes} probes of ${url}); ` +
                    `the last probe reported: ${lastReport ?? NO_PROBE_REPORT}`,
                { cause },
            );
        for (;;) {
            let report: ToggleReport;
            try {
                report = await probeToggle(page, worker, remainingMs);
            } catch (error) {
                // A probe the deadline cut off says nothing new; the last finished probe does.
                if (lastReport !== undefined && remainingMs() <= 0) {
                    throw deadlinePassed(error);
                }
                throw error;
            }
            probes += 1;
            if (report === ToggleReport.Checked) {
                return probes;
            }
            lastReport = report;
            // No time for a pause and another probe: stop on what this one reported.
            if (remainingMs() <= pollMs) {
                throw deadlinePassed();
            }
            logger.debug(
                { extensionId, elapsedMs: Date.now() - startedAt, probes, report },
                'Chromium "Allow User Scripts" toggle not on yet; probing again',
            );
            await delay(pollMs);
        }
    } finally {
        await withinDeadline(
            page.close(),
            Math.max(remainingMs(), pollMs),
            'closing the page',
        ).catch((error: unknown) => {
            logger.warn({ err: error, extensionId }, 'the extensions page did not close');
        });
    }
}

/**
 * Turn on Chromium's "Allow User Scripts" toggle for one extension.
 *
 * Each attempt opens the extension's detail view on `chrome://extensions` in a new page and probes
 * it until the toggle reads back on and the extension's service worker can use
 * `chrome.userScripts`; an attempt that fails is logged and the next one starts on a fresh page.
 *
 * @param context - The persistent context the extension is loaded in.
 * @param worker - The extension's running service worker; its URL names the extension.
 * @param logger - Where the outcome, each failed attempt and each probe that is not done yet are
 *   logged.
 * @param options - Pacing overrides; production callers omit them.
 * @returns Resolves once the service worker can use the API.
 * @throws Error naming the last attempt's failure when no attempt turned the toggle on.
 */
export async function allowUserScripts(
    context: BrowserContext,
    worker: Worker,
    logger: Logger,
    options: AllowUserScriptsOptions = {},
): Promise<void> {
    const pollMs = options.pollMs ?? TOGGLE_POLL_MS;
    const deadlineMs = options.deadlineMs ?? TOGGLE_DEADLINE_MS;
    const attempts = options.attempts ?? TOGGLE_ATTEMPTS;
    const extensionId = getExtensionId(worker);
    const startedAt = Date.now();
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const probes = await allowUserScriptsOnce(
                context,
                worker,
                extensionId,
                logger,
                pollMs,
                deadlineMs,
            );
            logger.info(
                { extensionId, elapsedMs: Date.now() - startedAt, attempt, probes },
                'Chromium "Allow User Scripts" is on for the extension',
            );
            return;
        } catch (error) {
            lastError = error;
            logger.warn(
                { err: error, extensionId, attempt, attempts },
                'Chromium "Allow User Scripts" attempt failed',
            );
        }
    }
    throw new Error(
        `Chromium "Allow User Scripts" did not turn on for extension ${extensionId} after ` +
            `${attempts} attempts: ${formatError(lastError)}`,
        { cause: lastError },
    );
}
