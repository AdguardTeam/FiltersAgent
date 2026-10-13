import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright-core';
import type { Logger } from '../../src/logger/logger';
import {
    allowUserScripts,
    ToggleReport,
    type AllowUserScriptsOptions,
} from '../../src/browser/chrome-user-scripts-toggle';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

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
function fakeContext(reports: readonly string[]) {
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

        await allowUserScripts(executingContext(document), EXTENSION_ID, silentLogger(), FAST);

        expect(toggle.click).toHaveBeenCalledTimes(1);
        expect(toggle.checked).toBe(true);
    });

    it('leaves a toggle that is already on alone', async () => {
        const { document, toggle } = fakeExtensionsWebUi(true);

        await allowUserScripts(executingContext(document), EXTENSION_ID, silentLogger(), FAST);

        expect(toggle.click).not.toHaveBeenCalled();
        expect(toggle.checked).toBe(true);
    });

    it('flips the toggle on the extension own chrome://extensions page and closes it', async () => {
        const { context, page } = fakeContext([ToggleReport.RowNotFound, ToggleReport.Checked]);

        await allowUserScripts(context, EXTENSION_ID, silentLogger(), FAST);

        expect(page.goto.mock.calls[0][0]).toBe(`chrome://extensions/?id=${EXTENSION_ID}`);
        expect(page.evaluate).toHaveBeenCalledTimes(2);
        expect(page.close).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['the WebUI never renders the row', ToggleReport.RowNotFound],
        ['the row never renders its toggle', ToggleReport.ToggleNotFound],
        ['the click leaves the toggle off', ToggleReport.Unchecked],
    ])('rejects naming the last report when %s, and still closes the page', async (_, report) => {
        const { context, page } = fakeContext([report]);

        await expect(allowUserScripts(context, EXTENSION_ID, silentLogger(), FAST)).rejects.toThrow(
            report,
        );

        expect(page.evaluate).toHaveBeenCalled();
        expect(page.close).toHaveBeenCalledTimes(1);
    });
});
