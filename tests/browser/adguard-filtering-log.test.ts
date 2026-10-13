import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page, Worker } from 'playwright-core';
import { openAdGuardFilteringLog } from '../../src/browser/adguard-filtering-log';
import {
    AppliedRuleFamily,
    AppliedRuleReporter,
    AppliedRulesReadKind,
    type AppliedRulesReport,
} from '../../src/environment/applied-rules';
import { ExtensionManifestVersion } from '../../src/environment/extension-preparation';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

const PAGE_URL = 'https://www.walla.co.il/';

/**
 * What the pinned v5.5.2.3 build answered on walla.co.il with the #242336 reporter's lists, trimmed
 * to twenty of the tab's 164 log entries: `getFilteringInfoByTabId` and `getFilteringLogData`
 * exactly as the extension sent them.
 */
const WALLA = JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'adguard-filtering-log-walla.json'), 'utf8'),
) as {
    getFilteringInfoByTabId: { tabId: number; filteringEvents: Array<Record<string, unknown>> };
    getFilteringLogData: { filtersMetadata: Array<Record<string, unknown>> };
};

/**
 * A custom filter the settings import installs after the log opened: a slice of EasyList Hebrew,
 * numbered from the extension's custom-filter range.
 */
const SLICE_LIST = { filterId: 1000, name: 'EasyList Hebrew lines 1-900 of 1766' };

/**
 * A log entry the slice's rule produced, in the extension's own shape.
 */
const SLICE_EVENT = {
    requestUrl: 'https://www.walla.co.il/ads/banner.js',
    frameUrl: PAGE_URL,
    requestRule: { filterId: SLICE_LIST.filterId, appliedRuleText: '||walla.co.il/ads/' },
};

/**
 * The tabs Chrome listed in that session: the default blank tab, the session page, the options and
 * thank-you pages the extension opened, and the filtering log itself.
 */
const TABS = [
    { id: 209794859, url: 'about:blank' },
    { id: WALLA.getFilteringInfoByTabId.tabId, url: PAGE_URL },
    { id: 209794861, url: `chrome-extension://${EXTENSION_ID}/pages/options.html` },
    { id: 209794862, url: 'https://welcome.adguard.com/v2/thankyou.html' },
    { id: 209794863, url: `chrome-extension://${EXTENSION_ID}/pages/filtering-log.html` },
];

/**
 * Extension-page globals a fake page evaluates its functions against.
 */
interface FakeChrome {
    runtime: {
        sendMessage(message: { type: string; data?: Record<string, unknown> }): Promise<unknown>;
        getManifest(): { version: string };
    };
    tabs: { query(query: object): Promise<unknown> };
}

const globals = globalThis as unknown as { chrome?: FakeChrome };

afterEach(() => {
    delete globals.chrome;
});

/**
 * An extension page that runs the evaluated functions in-process against a fake `chrome`, so the
 * page-side code under test is the code that runs in the browser.
 */
function fakeExtensionPage(answers: Record<string, unknown>, tabs: unknown = TABS) {
    const chrome: FakeChrome = {
        runtime: {
            sendMessage: vi.fn(async (message) => answers[message.type]),
            getManifest: () => ({ version: '5.5.2.3' }),
        },
        tabs: { query: vi.fn(async () => tabs) },
    };
    const page = {
        goto: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        url: () => `chrome-extension://${EXTENSION_ID}/pages/filtering-log.html`,
        evaluate: vi.fn(async (fn: (arg: unknown) => unknown, arg: unknown) => {
            globals.chrome = chrome;
            return await fn(arg);
        }),
    } as unknown as Page;
    const context = {
        serviceWorkers: () => [
            { url: () => `chrome-extension://${EXTENSION_ID}/pages/background.js` } as Worker,
        ],
        newPage: vi.fn().mockResolvedValue(page),
    } as unknown as BrowserContext;
    return { page, context, chrome };
}

async function readReport(answers: Record<string, unknown>, tabs?: unknown) {
    const { context } = fakeExtensionPage(answers, tabs);
    const log = await openAdGuardFilteringLog({
        context,
        manifestVersion: ExtensionManifestVersion.Mv3,
    });
    return await log.read(PAGE_URL);
}

const WALLA_ANSWERS = {
    getFilteringLogData: WALLA.getFilteringLogData,
    synchronizeOpenTabs: [],
    getFilteringInfoByTabId: WALLA.getFilteringInfoByTabId,
};

describe('openAdGuardFilteringLog', () => {
    it('keeps the extension own filtering-log page open so the log records', async () => {
        const { page, context } = fakeExtensionPage(WALLA_ANSWERS);

        await openAdGuardFilteringLog({ context, manifestVersion: ExtensionManifestVersion.Mv3 });

        expect(page.goto).toHaveBeenCalledWith(
            `chrome-extension://${EXTENSION_ID}/pages/filtering-log.html`,
            { waitUntil: 'load' },
        );
        expect(page.close).not.toHaveBeenCalled();
    });

    it('names the EasyList Hebrew rules the extension applied on walla.co.il', async () => {
        const read = await readReport(WALLA_ANSWERS);

        expect(read.kind).toBe(AppliedRulesReadKind.Report);
        const report = (read as { report: AppliedRulesReport }).report;
        expect(report.engine).toBe('AdGuard Browser Extension 5.5.2.3');
        expect(report.notReported).toEqual([]);
        expect(report.lists).toContainEqual({ id: 108, name: 'EasyList Hebrew' });
        expect(report.events).toContainEqual({
            rule:
                'sheee.co.il,walla.co.il,~mail.walla.co.il' +
                "#%#//scriptlet('ubo-aopr', 'googletag.cmd')",
            family: AppliedRuleFamily.Script,
            filterIds: [108],
            target: PAGE_URL,
            reportedBy: [AppliedRuleReporter.Engine],
        });
        const btoa = report.events.find((event) =>
            event.rule.endsWith("#%#//scriptlet('ubo-aopr', 'btoa')"),
        );
        expect(btoa).toMatchObject({ family: AppliedRuleFamily.Script, filterIds: [108] });
        const csp = report.events.filter((event) => event.rule.startsWith('||walla.co.il^$csp='));
        expect(csp).toHaveLength(2);
        expect(csp[0]).toMatchObject({
            family: AppliedRuleFamily.Network,
            filterIds: [108],
            reportedBy: [AppliedRuleReporter.BrowserDeclarative],
        });
        expect(report.events).toContainEqual(
            expect.objectContaining({
                rule: '||tags.dxmdp.com^',
                filterIds: [3],
                reportedBy: [AppliedRuleReporter.Engine, AppliedRuleReporter.BrowserDeclarative],
            }),
        );
        expect(report.events).toContainEqual(
            expect.objectContaining({
                rule: '@@||walla.co.il^$csp',
                family: AppliedRuleFamily.NetworkException,
                filterIds: [2],
            }),
        );
        const outbrain = report.events.filter((event) => event.rule === '##.OUTBRAIN');
        expect(outbrain.map((event) => event.family)).toEqual([
            AppliedRuleFamily.ElementHiding,
            AppliedRuleFamily.ElementHiding,
        ]);
        expect(outbrain[0]!.target).toMatch(/^<div class="OUTBRAIN"/u);
        expect(report.trackingProtection).toEqual([{ action: 'SendDoNotTrack', requests: 4 }]);
    });

    it('names a custom filter the settings import created after the log opened', async () => {
        const answers: Record<string, unknown> = { ...WALLA_ANSWERS };
        const { context } = fakeExtensionPage(answers);
        const log = await openAdGuardFilteringLog({
            context,
            manifestVersion: ExtensionManifestVersion.Mv3,
        });
        answers.getFilteringLogData = {
            ...WALLA.getFilteringLogData,
            filtersMetadata: [...WALLA.getFilteringLogData.filtersMetadata, SLICE_LIST],
        };
        answers.getFilteringInfoByTabId = {
            ...WALLA.getFilteringInfoByTabId,
            filteringEvents: [...WALLA.getFilteringInfoByTabId.filteringEvents, SLICE_EVENT],
        };

        const read = await log.read(PAGE_URL);

        expect(read.kind).toBe(AppliedRulesReadKind.Report);
        const report = (read as { report: AppliedRulesReport }).report;
        expect(report.lists).toContainEqual({ id: SLICE_LIST.filterId, name: SLICE_LIST.name });
        expect(report.events).toContainEqual(
            expect.objectContaining({
                rule: SLICE_EVENT.requestRule.appliedRuleText,
                family: AppliedRuleFamily.Network,
                filterIds: [SLICE_LIST.filterId],
                target: SLICE_EVENT.requestUrl,
            }),
        );
    });

    it('refuses to guess when no tab or several tabs show the page', async () => {
        const none = await readReport(
            WALLA_ANSWERS,
            TABS.filter((tab) => tab.url !== PAGE_URL),
        );
        expect(none).toMatchObject({ kind: AppliedRulesReadKind.Unavailable });
        expect((none as { reason: string }).reason).toContain('about:blank');

        const twice = await readReport(WALLA_ANSWERS, [...TABS, { id: 1, url: PAGE_URL }]);
        expect(twice).toMatchObject({ kind: AppliedRulesReadKind.Unavailable });
        expect((twice as { reason: string }).reason).toContain(PAGE_URL);
    });

    it('says so when the extension log holds no entry for the tab', async () => {
        const read = await readReport({ ...WALLA_ANSWERS, getFilteringInfoByTabId: undefined });

        expect(read).toMatchObject({ kind: AppliedRulesReadKind.Unavailable });
        expect((read as { reason: string }).reason).toMatch(/no entry/iu);
    });

    it('fails loudly on a log entry of an unexpected shape', async () => {
        const [first, ...rest] = WALLA.getFilteringInfoByTabId.filteringEvents;
        const malformed = {
            ...WALLA.getFilteringInfoByTabId,
            filteringEvents: [{ ...first, requestRule: { filterId: '108' } }, ...rest],
        };

        await expect(
            readReport({ ...WALLA_ANSWERS, getFilteringInfoByTabId: malformed }),
        ).rejects.toThrow(/number/u);
    });
});
