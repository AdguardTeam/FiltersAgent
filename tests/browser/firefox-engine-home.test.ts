import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext } from 'playwright-core';
import type { Logger } from 'pino';
import { FirefoxEngine, type FirefoxBrowserType } from '../../src/browser/firefox-engine';
import { buildFirefoxPolicies } from '../../src/browser/firefox-policies';

/**
 * The contract under test: Firefox refuses to run as root under a `$HOME` owned by another user, so
 * every launch must hand the browser a home the launching process itself owns. The env the engine
 * passes to playwright-core is the only place that can be observed without starting a browser, and
 * it is exactly what the browser's own ownership check reads.
 */

/**
 * Inherited environment a container action hands the launch: a `HOME` the process does not own is
 * precisely the value the engine has to replace.
 */
const INHERITED_ENVIRONMENT = { PATH: '/usr/bin', HOME: '/github/home' };

/**
 * Logger stub: the launch log line is a diagnostic, not the contract under test.
 *
 * @returns A logger recording nothing.
 */
function silentLogger(): Logger {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

/**
 * One recorded launch: the env the engine handed playwright-core and the close hook it attached.
 */
interface RecordedLaunch {
    /**
     * Environment of the launch, as playwright-core received it.
     */
    environment: Record<string, string>;

    /**
     * Fire the listener the engine registered for the browser/context closing.
     *
     * @returns Nothing.
     */
    close: () => void;
}

/**
 * Build a launched-browser stub whose close listeners can be fired on demand.
 *
 * @returns The stub handle and the trigger firing every listener the engine attached to it.
 */
function fakeLaunchedBrowser(): { handle: Browser & BrowserContext; fire: () => void } {
    const listeners: (() => void)[] = [];
    const handle = {
        on: (_event: string, listener: () => void) => {
            listeners.push(listener);
        },
    } as unknown as Browser & BrowserContext;
    return {
        handle,
        fire: () => {
            for (const listener of listeners) {
                listener();
            }
        },
    };
}

/**
 * Build a playwright-core stub that records each launch's env and exposes its close hook.
 *
 * @param recorded - Array every launch appends its record to.
 * @returns The recording browser-type stub.
 */
function recordingBrowserType(recorded: RecordedLaunch[]): FirefoxBrowserType {
    return {
        launch: async (options) => {
            const { handle, fire } = fakeLaunchedBrowser();
            recorded.push({
                environment: (options?.env ?? {}) as Record<string, string>,
                close: fire,
            });
            return handle;
        },
        launchPersistentContext: async (_userDataDir, options) => {
            const { handle, fire } = fakeLaunchedBrowser();
            recorded.push({
                environment: (options?.env ?? {}) as Record<string, string>,
                close: fire,
            });
            return handle;
        },
    };
}

/**
 * Assert one recorded launch got a home under the OS temp dir that exists and is process-owned.
 *
 * @param recorded - The launch record to check.
 * @returns The home path the launch received.
 */
function assertOwnedTempHome(recorded: RecordedLaunch): string {
    const home = recorded.environment['HOME'] ?? '';
    expect(home).not.toBe(INHERITED_ENVIRONMENT.HOME);
    expect(home.startsWith(tmpdir())).toBe(true);
    expect(existsSync(home)).toBe(true);
    const currentUid = process.getuid?.();
    if (currentUid !== undefined) {
        expect(statSync(home).uid).toBe(currentUid);
    }
    return home;
}

describe('FirefoxEngine launch home', () => {
    it('hands a plain launch its own process-owned home under the OS temp dir', async () => {
        const recorded: RecordedLaunch[] = [];
        const engine = new FirefoxEngine({
            browserType: recordingBrowserType(recorded),
            logger: silentLogger(),
        });

        await engine.launch({
            headless: true,
            locale: 'en-US',
            timezone: 'UTC',
            environment: { ...INHERITED_ENVIRONMENT },
        });

        expect(recorded.length).toBe(1);
        const home = assertOwnedTempHome(recorded[0]!);
        // The home lives as long as the browser: Firefox keeps writing into it all session.
        recorded[0]!.close();
        expect(existsSync(home)).toBe(false);
    });

    it('hands a persistent policies launch its own home beside the staged policies', async () => {
        const recorded: RecordedLaunch[] = [];
        const engine = new FirefoxEngine({
            browserType: recordingBrowserType(recorded),
            logger: silentLogger(),
        });
        const profileDir = mkdtempSync(join(tmpdir(), 'firefox-engine-profile-'));
        try {
            await engine.launchPersistentContext({
                headless: true,
                locale: 'en-US',
                timezone: 'UTC',
                environment: { ...INHERITED_ENVIRONMENT },
                userDataDir: profileDir,
                extensionPaths: [],
                userAgent: 'agent',
                viewport: { width: 1_280, height: 720 },
                firefoxPolicies: buildFirefoxPolicies({
                    extensionId: 'uBlock0@raymondhill.net',
                    xpiPath: join(profileDir, 'ubo.xpi'),
                    managedStorage: {},
                }),
            });

            expect(recorded.length).toBe(1);
            const home = assertOwnedTempHome(recorded[0]!);
            // The staged policies still reach the browser through their own variable.
            expect(recorded[0]!.environment['PLAYWRIGHT_FIREFOX_POLICIES_JSON']).toContain(
                profileDir,
            );
            recorded[0]!.close();
            expect(existsSync(home)).toBe(false);
        } finally {
            rmSync(profileDir, { recursive: true, force: true });
        }
    });

    it('removes the home again when the launch itself fails', async () => {
        const homes: string[] = [];
        const engine = new FirefoxEngine({
            browserType: {
                launch: async (options) => {
                    homes.push(((options?.env ?? {}) as Record<string, string>)['HOME'] ?? '');
                    throw new Error('launch refused');
                },
                launchPersistentContext: async () => {
                    throw new Error('unused');
                },
            },
            logger: silentLogger(),
        });

        await expect(
            engine.launch({
                headless: true,
                locale: 'en-US',
                timezone: 'UTC',
                environment: { ...INHERITED_ENVIRONMENT },
            }),
        ).rejects.toThrow('launch refused');
        expect(homes.length).toBe(1);
        expect(existsSync(homes[0]!)).toBe(false);
    });
});
