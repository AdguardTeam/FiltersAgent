import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page, Worker } from 'playwright-core';
import { readAdGuardExtensionState } from '../../src/browser/adguard-extension-state-read';
import { ExtensionMessageRejectionError } from '../../src/browser/adguard-extension-state-transport';
import { ExtensionManifestVersion } from '../../src/environment/extension-preparation';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

const rulesLimits = {
    dynamicRulesEnabledCount: 120,
    dynamicRulesMaximumCount: 30_000,
    dynamicRulesUnsafeEnabledCount: 4,
    dynamicRulesUnsafeMaximumCount: 5_000,
    dynamicRulesRegexpsEnabledCount: 1,
    dynamicRulesRegexpsMaximumCount: 1_000,
    staticFiltersEnabledCount: 3,
    staticFiltersMaximumCount: 50,
    staticRulesEnabledCount: 42_000,
    staticRulesMaximumCount: 100_000,
    staticRulesRegexpsEnabledCount: 15,
    staticRulesRegexpsMaxCount: 1_000,
    actuallyEnabledFilters: [17, 2, 3],
    expectedEnabledFilters: [],
    areFilterLimitsExceeded: false,
};

const optionsData = {
    appVersion: '5.4.3.95',
    settings: {
        values: {
            'stealth-disable-stealth-mode': true,
        },
    },
    filtersMetadata: {
        filters: [
            { filterId: 17, enabled: true },
            { filterId: 4, enabled: false },
            {
                filterId: 2,
                enabled: true,
                name: 'AdGuard Base filter',
                groupId: 1,
                version: '2.0.0.0',
            },
            { filterId: 3, enabled: true },
        ],
        categories: [{ groupId: 1, groupName: 'Ad blocking' }],
    },
    runtimeInfo: {
        areFilterLimitsExceeded: false,
    },
};

function createWorker(url = `chrome-extension://${EXTENSION_ID}/background.js`): Worker {
    return {
        url: vi.fn().mockReturnValue(url),
    } as unknown as Worker;
}

function createPage(responses: Record<string, unknown> = {}): Page {
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockImplementation(async (_fn, message: { type: string }) => {
            const defaults: Record<string, unknown> = {
                getOptionsData: optionsData,
                getIsAppInitialized: true,
                getRulesLimitsCountersMv3: rulesLimits,
                getUserRules: { content: '' },
            };
            const response =
                message.type in responses ? responses[message.type] : defaults[message.type];
            if (typeof response === 'function') {
                return response(message);
            }
            return response;
        }),
    } as unknown as Page;
}

function createContext(page: Page, workers: Worker[] = [createWorker()]): BrowserContext {
    return {
        serviceWorkers: vi.fn().mockReturnValue(workers),
        backgroundPages: vi.fn().mockReturnValue([]),
        waitForEvent: vi.fn().mockResolvedValue(createWorker()),
        newPage: vi.fn().mockResolvedValue(page),
    } as unknown as BrowserContext;
}

describe('readAdGuardExtensionState', () => {
    it('reads the observed settings state over the extension message transport', async () => {
        const page = createPage();
        const context = createContext(page);

        const read = await readAdGuardExtensionState(context, ExtensionManifestVersion.Mv3);

        expect(page.goto).toHaveBeenCalledWith(
            `chrome-extension://${EXTENSION_ID}/pages/options.html`,
            { waitUntil: 'load' },
        );
        expect(read).toMatchObject({
            extensionId: EXTENSION_ID,
            optionsPageUrl: `chrome-extension://${EXTENSION_ID}/pages/options.html`,
            manifestVersion: 3,
            appVersion: '5.4.3.95',
            optionsEnabledFilterIds: [2, 3, 17],
            rulesLimits,
        });
        expect(page.close).toHaveBeenCalledOnce();
    });

    it('carries the observed user-rule content and its exact digest in the state read', async () => {
        const rules = ['example.com##.ad-slot', 'example.org##.banner'];
        const page = createPage({
            getUserRules: { content: `${rules.join('\n')}\n` },
        });

        const read = await readAdGuardExtensionState(
            createContext(page),
            ExtensionManifestVersion.Mv3,
        );

        expect(read.userRules.content).toBe(rules.join('\n'));
        expect(read.userRules.contentSha256).toBe(
            createHash('sha256').update(rules.join('\n'), 'utf8').digest('hex'),
        );
        expect(read.userRules.ruleCount).toBe(2);
    });

    it('waits for options readiness without failing a first empty read', async () => {
        let optionsCalls = 0;
        const page = createPage({
            getOptionsData: () => {
                optionsCalls += 1;
                return optionsCalls === 1 ? undefined : optionsData;
            },
        });

        const read = await readAdGuardExtensionState(
            createContext(page),
            ExtensionManifestVersion.Mv3,
        );

        expect(read.appVersion).toBe('5.4.3.95');
        expect(optionsCalls).toBe(2);
    });

    it('fails the options readiness wait as a typed failure carrying the last error', async () => {
        const polyfillRejection = {
            __mozWebExtensionPolyfillReject__: true,
            message: 'IO error: FILE_ERROR_NO_SPACE',
        };
        const page = createPage({ getOptionsData: polyfillRejection });
        vi.useFakeTimers();

        try {
            const result = readAdGuardExtensionState(
                createContext(page),
                ExtensionManifestVersion.Mv3,
                { budgetMs: 50 },
            );
            const rejection = expect(result).rejects.toThrow(
                /did not become ready after \d+ probes over \d+ms/,
            );
            await vi.runAllTimersAsync();
            const error: unknown = await result.catch((caught: unknown) => caught);
            await rejection;
            expect((error as { cause?: unknown }).cause).toBeInstanceOf(
                ExtensionMessageRejectionError,
            );
            expect((error as Error).message).toContain('FILE_ERROR_NO_SPACE');
        } finally {
            vi.useRealTimers();
        }
    });
});
