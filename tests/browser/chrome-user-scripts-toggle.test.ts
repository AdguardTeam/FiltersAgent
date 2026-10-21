import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page, Worker } from 'playwright-core';
import type { Logger } from '../../src/logger/logger';
import {
    allowUserScripts,
    TOGGLE_ATTEMPTS,
    ToggleReport,
    type AllowUserScriptsOptions,
} from '../../src/browser/chrome-user-scripts-toggle';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

/**
 * The extension's service worker; `apiPresent` is what it answers when asked whether
 * `chrome.userScripts` exists.
 */
function fakeWorker(apiPresent = true) {
    return {
        url: () => `chrome-extension://${EXTENSION_ID}/background.js`,
        evaluate: vi.fn().mockResolvedValue(apiPresent),
    } as unknown as Worker;
}

/**
 * How long a slow browser call takes: a few milliseconds of protocol latency, as a real browser
 * answers, rather than a microtask.
 */
const SLOW_CALL_MS = 5;

/**
 * A browser call that answers `value` after {@link SLOW_CALL_MS}.
 */
function slowly<T>(value: T): () => Promise<T> {
    return () => new Promise((resolve) => setTimeout(() => resolve(value), SLOW_CALL_MS));
}

/**
 * A promise that never settles: a browser call that hangs.
 */
function never(): Promise<never> {
    return new Promise(() => undefined);
}

/**
 * Poll fast and give up fast, so a suite that proves the deadline does not wait ten seconds.
 */
const FAST: AllowUserScriptsOptions = { pollMs: 1, deadlineMs: 20 };

function silentLogger(): Logger {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

/**
 * A persistent context whose one new page answers the toggle script with canned reports, in order;
 * the last report repeats once the list is exhausted.
 */
function fakeContext(reports: readonly ToggleReport[]) {
    const evaluate = vi.fn();
    for (const report of reports) {
        evaluate.mockResolvedValueOnce(report);
    }
    evaluate.mockResolvedValue(reports[reports.length - 1]);
    const page = {
        goto: vi.fn().mockResolvedValue(undefined),
        evaluate,
        close: vi.fn().mockResolvedValue(undefined),
    };
    const context = {
        newPage: vi.fn().mockResolvedValue(page as unknown as Page),
    } as unknown as BrowserContext;
    return { context, page };
}

/**
 * One element of the fake extensions WebUI: a tag, an optional id, an open shadow root, and for the
 * toggle its `checked` state and the click that flips it.
 */
interface FakeElement {
    tag: string;
    id?: string;
    shadowRoot: FakeRoot | null;
    checked?: boolean;
    click?: () => void;
}

/**
 * A document or shadow root holding one flat level of light-DOM children, answering the two
 * selector shapes the script uses: `tag`, `tag#id` and `*`.
 */
interface FakeRoot {
    querySelector(selector: string): FakeElement | null;
    querySelectorAll(selector: string): FakeElement[];
}

function matches(element: FakeElement, selector: string): boolean {
    if (selector === '*') {
        return true;
    }
    const [tag, id] = selector.split('#');
    return element.tag === tag && (id === undefined || element.id === id);
}

function fakeRoot(children: FakeElement[]): FakeRoot {
    return {
        querySelector: (selector) => children.find((child) => matches(child, selector)) ?? null,
        querySelectorAll: (selector) => children.filter((child) => matches(child, selector)),
    };
}

/**
 * The WebUI as Chromium 145 renders it: `extensions-manager` → `extensions-detail-view` → the
 * toggle row, each behind an open shadow root, with the `cr-toggle` in the row's own.
 */
function fakeExtensionsWebUi(checked: boolean) {
    const toggle: FakeElement = {
        tag: 'cr-toggle',
        shadowRoot: null,
        checked,
        click: vi.fn(() => {
            toggle.checked = !toggle.checked;
        }),
    };
    const row: FakeElement = {
        tag: 'extensions-toggle-row',
        id: 'allow-user-scripts',
        shadowRoot: fakeRoot([toggle]),
    };
    const detailView: FakeElement = {
        tag: 'extensions-detail-view',
        shadowRoot: fakeRoot([row]),
    };
    const manager: FakeElement = { tag: 'extensions-manager', shadowRoot: fakeRoot([detailView]) };
    return { document: fakeRoot([manager]), toggle };
}

/**
 * A context whose page runs the evaluated script string in-process against the fake WebUI, so the
 * code under test is the code that runs in the browser.
 */
function executingContext(document: FakeRoot) {
    const page = {
        goto: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn(async (script: string) =>
            new Function('document', `return ${script}`)(document),
        ),
        close: vi.fn().mockResolvedValue(undefined),
    };
    return {
        newPage: vi.fn().mockResolvedValue(page as unknown as Page),
    } as unknown as BrowserContext;
}

describe('allowUserScripts', () => {
    it('reaches the toggle through the open shadow roots and clicks it once when off', async () => {
        const { document, toggle } = fakeExtensionsWebUi(false);

        await allowUserScripts(executingContext(document), fakeWorker(), silentLogger(), FAST);

        expect(toggle.click).toHaveBeenCalledTimes(1);
        expect(toggle.checked).toBe(true);
    });

    it('leaves a toggle that is already on alone', async () => {
        const { document, toggle } = fakeExtensionsWebUi(true);

        await allowUserScripts(executingContext(document), fakeWorker(), silentLogger(), FAST);

        expect(toggle.click).not.toHaveBeenCalled();
        expect(toggle.checked).toBe(true);
    });

    it('flips the toggle on the extension own chrome://extensions page and closes it', async () => {
        const { context, page } = fakeContext([ToggleReport.RowNotFound, ToggleReport.Checked]);

        await allowUserScripts(context, fakeWorker(), silentLogger(), FAST);

        expect(page.goto.mock.calls[0][0]).toBe(`chrome://extensions/?id=${EXTENSION_ID}`);
        expect(page.evaluate).toHaveBeenCalledTimes(2);
        expect(page.close).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['the WebUI never renders the row', ToggleReport.RowNotFound],
        ['the row never renders its toggle', ToggleReport.ToggleNotFound],
        ['the click leaves the toggle off', ToggleReport.Unchecked],
    ])(
        'rejects naming the last report when %s on every attempt, closing each page',
        async (_, report) => {
            const { context, page } = fakeContext([report]);

            await expect(
                allowUserScripts(context, fakeWorker(), silentLogger(), FAST),
            ).rejects.toThrow(report);

            expect(context.newPage).toHaveBeenCalledTimes(TOGGLE_ATTEMPTS);
            expect(page.close).toHaveBeenCalledTimes(TOGGLE_ATTEMPTS);
        },
    );

    it.each([
        [ToggleReport.RowNotFound, true],
        [ToggleReport.Unchecked, true],
        [ToggleReport.ApiMissing, false],
    ])(
        'names the last report %s when every probe takes protocol time',
        async (expected, apiEnabled) => {
            const pageReport = apiEnabled ? expected : ToggleReport.Checked;
            const { context, page } = fakeContext([pageReport]);
            page.evaluate.mockImplementation(slowly(pageReport));
            const worker = fakeWorker();
            vi.mocked(worker.evaluate).mockImplementation(slowly(apiEnabled) as never);

            await expect(allowUserScripts(context, worker, silentLogger(), FAST)).rejects.toThrow(
                expected,
            );
        },
    );

    it('rejects when the toggle reads on but the service worker never sees the API', async () => {
        const { context } = fakeContext([ToggleReport.Checked]);

        await expect(
            allowUserScripts(context, fakeWorker(false), silentLogger(), FAST),
        ).rejects.toThrow(ToggleReport.ApiMissing);
    });

    it('ends an attempt at its deadline when the page never loads', async () => {
        const { context, page } = fakeContext([ToggleReport.Checked]);
        page.goto.mockImplementation(never);

        await expect(
            allowUserScripts(context, fakeWorker(), silentLogger(), FAST),
        ).rejects.toThrow();

        expect(context.newPage).toHaveBeenCalledTimes(TOGGLE_ATTEMPTS);
    });

    it('turns the toggle on even when the page never finishes closing', async () => {
        const { context, page } = fakeContext([ToggleReport.Checked]);
        page.close.mockImplementation(never);

        await allowUserScripts(context, fakeWorker(), silentLogger(), FAST);

        expect(context.newPage).toHaveBeenCalledTimes(1);
    });

    it('tries again on a fresh page when an attempt fails', async () => {
        const { context, page } = fakeContext([ToggleReport.Checked]);
        page.goto.mockRejectedValueOnce(new Error('net::ERR_ABORTED'));

        await allowUserScripts(context, fakeWorker(), silentLogger(), FAST);

        expect(context.newPage).toHaveBeenCalledTimes(2);
        expect(page.close).toHaveBeenCalledTimes(2);
    });
});
