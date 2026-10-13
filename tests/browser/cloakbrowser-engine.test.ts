import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger as PlaywrightLogger } from 'playwright-core';

const { cloakLaunch, cloakLaunchPersistentContext } = vi.hoisted(() => ({
    cloakLaunch: vi.fn(async (_options: Record<string, unknown>) => ({})),
    cloakLaunchPersistentContext: vi.fn(async (_options: Record<string, unknown>) => ({})),
}));

vi.mock('cloakbrowser', () => ({
    launch: cloakLaunch,
    launchPersistentContext: cloakLaunchPersistentContext,
}));

import { CloakBrowserEngine } from '../../src/browser/cloakbrowser-engine';
import { BrowserConfigurationError } from '../../src/browser/browser-session';
import { buildFirefoxPolicies } from '../../src/browser/firefox-policies';

function sink(): PlaywrightLogger {
    return { isEnabled: () => true, log: vi.fn() };
}

describe('CloakBrowserEngine', () => {
    beforeEach(() => {
        cloakLaunch.mockClear();
        cloakLaunchPersistentContext.mockClear();
    });

    it('has browserType "cloakbrowser"', () => {
        const engine = new CloakBrowserEngine();
        expect(engine.browserType).toBe('cloakbrowser');
    });

    it('launch is a function', () => {
        const engine = new CloakBrowserEngine();
        expect(typeof engine.launch).toBe('function');
    });

    it('supports persistent contexts for extension-backed reproduction', () => {
        const engine = new CloakBrowserEngine();
        expect(typeof engine.launchPersistentContext).toBe('function');
    });

    it('forwards environment, process log sink, and withheld defaults through launch options', async () => {
        const engine = new CloakBrowserEngine();
        const browserProcessLogger = sink();
        await engine.launchPersistentContext({
            headless: true,
            locale: 'en-US',
            timezone: 'UTC',
            environment: { HOME: '/home/runner' },
            userDataDir: '/tmp/profile',
            extensionPaths: [],
            userAgent: 'agent',
            viewport: { width: 1920, height: 1080 },
            browserProcessLogger,
            ignoreDefaultArgs: ['--disable-breakpad'],
        });

        const options = cloakLaunchPersistentContext.mock.calls[0]?.[0] as {
            launchOptions: Record<string, unknown>;
        };
        expect(options.launchOptions.env).toEqual({ HOME: '/home/runner' });
        expect(options.launchOptions.logger).toBe(browserProcessLogger);
        // cloakbrowser's own stealth withholds must survive the caller's override.
        expect(options.launchOptions.ignoreDefaultArgs).toEqual([
            '--enable-automation',
            '--enable-unsafe-swiftshader',
            '--disable-breakpad',
        ]);
    });

    it('omits optional launch options when the caller supplies none', async () => {
        const engine = new CloakBrowserEngine();
        await engine.launch({
            headless: true,
            locale: 'en-US',
            timezone: 'UTC',
            environment: { HOME: '/home/runner' },
        });

        const options = cloakLaunch.mock.calls[0]?.[0] as {
            launchOptions: Record<string, unknown>;
        };
        expect(options.launchOptions.env).toEqual({ HOME: '/home/runner' });
        expect(options.launchOptions).not.toHaveProperty('logger');
        expect(options.launchOptions).not.toHaveProperty('ignoreDefaultArgs');
    });

    it('rejects firefoxPolicies loudly without launching', async () => {
        const engine = new CloakBrowserEngine();
        await expect(
            engine.launchPersistentContext({
                headless: true,
                locale: 'en-US',
                timezone: 'UTC',
                environment: { HOME: '/home/runner' },
                userDataDir: '/tmp/profile',
                extensionPaths: [],
                userAgent: 'agent',
                viewport: { width: 1920, height: 1080 },
                firefoxPolicies: buildFirefoxPolicies({
                    extensionId: 'uBlock0@raymondhill.net',
                    xpiPath: '/tmp/u.xpi',
                }),
            }),
        ).rejects.toThrow(BrowserConfigurationError);
        expect(cloakLaunchPersistentContext).not.toHaveBeenCalled();
        expect(cloakLaunch).not.toHaveBeenCalled();
    });
});
