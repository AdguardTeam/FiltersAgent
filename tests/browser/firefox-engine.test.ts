import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const { firefoxLaunch, firefoxLaunchPersistentContext } = vi.hoisted(() => ({
    // The engine subscribes to the launched handle's close so it can dispose that launch's own
    // home directory, so the stubs are event emitters rather than bare objects.
    firefoxLaunch: vi.fn(async (_options: Record<string, unknown>) => ({ on: vi.fn() })),
    firefoxLaunchPersistentContext: vi.fn(
        async (_userDataDir: string, _options: Record<string, unknown>) => ({ on: vi.fn() }),
    ),
}));

vi.mock('playwright-core', () => ({
    firefox: {
        launch: firefoxLaunch,
        launchPersistentContext: firefoxLaunchPersistentContext,
    },
}));

import { FirefoxEngine } from '../../src/browser/firefox-engine';
import { BrowserConfigurationError } from '../../src/browser/browser-session';
import { FIREFOX_POLICIES_ENV_VAR } from '../../src/browser/firefox-policies';

const MANAGED_STORAGE = {
    adminSettings: {
        userFilters: '||ads.example^',
        selectedFilterLists: ['user-filters'],
    },
};

describe('FirefoxEngine', () => {
    let profileDir: string;

    beforeEach(() => {
        firefoxLaunch.mockClear();
        firefoxLaunchPersistentContext.mockClear();
        profileDir = mkdtempSync(join(tmpdir(), 'firefox-engine-test-'));
    });

    afterEach(() => {
        rmSync(profileDir, { recursive: true, force: true });
    });

    it('reports the firefox browser type', () => {
        expect(new FirefoxEngine().browserType).toBe('firefox');
    });

    it('writes the policies file into the profile and points the browser at it', async () => {
        const engine = new FirefoxEngine();
        await engine.launchPersistentContext({
            headless: true,
            locale: 'en-US',
            timezone: 'UTC',
            environment: { HOME: '/home/runner' },
            userDataDir: profileDir,
            extensionPaths: [],
            userAgent: 'agent',
            viewport: { width: 1920, height: 1080 },
            firefoxPolicies: {
                policies: {
                    ExtensionSettings: {
                        'uBlock0@raymondhill.net': {
                            installation_mode: 'force_installed',
                            install_url: 'file:///tmp/u.xpi',
                        },
                    },
                    '3rdparty': {
                        Extensions: {
                            'uBlock0@raymondhill.net': MANAGED_STORAGE,
                        },
                    },
                },
            },
        });

        const written = JSON.parse(readFileSync(join(profileDir, 'policies.json'), 'utf8')) as {
            policies: { ExtensionSettings: Record<string, unknown> };
        };
        expect(written.policies.ExtensionSettings['uBlock0@raymondhill.net']).toEqual({
            installation_mode: 'force_installed',
            install_url: 'file:///tmp/u.xpi',
        });

        const options = firefoxLaunchPersistentContext.mock.calls[0]?.[1] as Record<
            string,
            unknown
        >;
        const env = options.env as Record<string, string>;
        expect(env[FIREFOX_POLICIES_ENV_VAR]).toBe(join(profileDir, 'policies.json'));
    });

    it('forwards headless, locale, timezone, user agent and viewport to playwright', async () => {
        const engine = new FirefoxEngine();
        await engine.launchPersistentContext({
            headless: false,
            locale: 'de-DE',
            timezone: 'Europe/Berlin',
            environment: { HOME: '/home/runner' },
            userDataDir: profileDir,
            extensionPaths: [],
            userAgent: 'firefox-agent',
            viewport: { width: 1280, height: 720 },
        });

        const options = firefoxLaunchPersistentContext.mock.calls[0]?.[1] as Record<
            string,
            unknown
        >;
        expect(options.headless).toBe(false);
        expect(options.locale).toBe('de-DE');
        expect(options.timezoneId).toBe('Europe/Berlin');
        expect(options.userAgent).toBe('firefox-agent');
        expect(options.viewport).toEqual({ width: 1280, height: 720 });
    });

    it('launches a plain browser through firefox.launch', async () => {
        const engine = new FirefoxEngine();
        await engine.launch({
            headless: true,
            locale: 'en-US',
            timezone: 'UTC',
            environment: { HOME: '/home/runner' },
        });

        const options = firefoxLaunch.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(options.headless).toBe(true);
        // The launch environment keeps everything the parent allowlisted except HOME, which every
        // launch replaces with its own (tests/browser/firefox-engine-home.test.ts owns that
        // contract: Firefox refuses a home owned by another user).
        expect(Object.keys(options.env as Record<string, string>)).toEqual(['HOME']);
    });

    it('rejects a non-empty extensionPaths list with BrowserConfigurationError', async () => {
        const engine = new FirefoxEngine();
        await expect(
            engine.launchPersistentContext({
                headless: true,
                locale: 'en-US',
                timezone: 'UTC',
                environment: { HOME: '/home/runner' },
                userDataDir: profileDir,
                extensionPaths: ['/tmp/unpacked-extension'],
                userAgent: 'agent',
                viewport: { width: 1920, height: 1080 },
            }),
        ).rejects.toThrow(BrowserConfigurationError);
        expect(firefoxLaunchPersistentContext).not.toHaveBeenCalled();
    });
});
