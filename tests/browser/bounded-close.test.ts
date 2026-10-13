import { spawn } from 'node:child_process';
import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { firefox, type Browser } from 'playwright-core';
import type { Logger } from 'pino';
import {
    runBoundedBrowserClose,
    forceKillBrowserProcessesByMarker,
} from '../../src/browser/bounded-close';
import {
    forceKillBrowserProcessTree,
    readBrowserProcessPid,
} from '../../src/browser/browser-kill-handle';

function mockLogger(): Logger {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe('runBoundedBrowserClose', () => {
    it('returns graceful without force-killing when the close settles within the deadline', async () => {
        const forceKill = vi.fn().mockReturnValue(0);

        const outcome = await runBoundedBrowserClose({
            gracefulClose: () => Promise.resolve(),
            forceKill,
            logger: mockLogger(),
            deadlineMs: 1_000,
            settleMs: 1_000,
        });

        expect(outcome).toBe('graceful');
        expect(forceKill).not.toHaveBeenCalled();
    });

    it('reports close_failed without throwing when the close rejects', async () => {
        const logger = mockLogger();

        const outcome = await runBoundedBrowserClose({
            gracefulClose: () => Promise.reject(new Error('Target closed')),
            forceKill: vi.fn().mockReturnValue(0),
            logger,
            deadlineMs: 1_000,
            settleMs: 1_000,
        });

        expect(outcome).toBe('close_failed');
        expect(logger.warn).toHaveBeenCalled();
    });

    it('escalates to the force kill and reports forced when the close settles only after it', async () => {
        let unblock: (() => void) | undefined;
        const hangingClose = new Promise<void>((resolve) => {
            unblock = resolve;
        });
        const forceKill = vi.fn(() => {
            unblock?.();
            return 1;
        });

        const outcome = await runBoundedBrowserClose({
            gracefulClose: () => hangingClose,
            forceKill,
            logger: mockLogger(),
            deadlineMs: 40,
            settleMs: 500,
        });

        expect(outcome).toBe('forced');
        expect(forceKill).toHaveBeenCalledTimes(1);
    });

    it('abandons within the settle bound a close that survives the force kill', async () => {
        const startedAt = Date.now();

        const outcome = await runBoundedBrowserClose({
            gracefulClose: () => new Promise<void>(() => undefined),
            forceKill: vi.fn().mockReturnValue(0),
            logger: mockLogger(),
            deadlineMs: 40,
            settleMs: 40,
        });

        expect(outcome).toBe('abandoned');
        expect(Date.now() - startedAt).toBeLessThan(5_000);
    });

    it('survives a throwing force kill and still abandons the hung close', async () => {
        const outcome = await runBoundedBrowserClose({
            gracefulClose: () => new Promise<void>(() => undefined),
            forceKill: () => {
                throw new Error('kill unavailable');
            },
            logger: mockLogger(),
            deadlineMs: 40,
            settleMs: 40,
        });

        expect(outcome).toBe('abandoned');
    });
});

describe('forceKillBrowserProcessesByMarker', () => {
    it('refuses a marker too short to be a safe process match', () => {
        const logger = mockLogger();
        expect(forceKillBrowserProcessesByMarker('/tmp', logger)).toBe(0);
        expect(logger.error).toHaveBeenCalled();
    });

    it.skipIf(process.platform !== 'linux')(
        'kills a live process whose command line carries the marker',
        async () => {
            const marker = `bounded-close-kill-fixture-${process.pid}-${Date.now()}`;
            const child = spawn('sh', ['-c', 'sleep 30', marker], { stdio: 'ignore' });
            await new Promise((resolve) => setTimeout(resolve, 200));
            const exited = new Promise<NodeJS.Signals | null>((resolve) => {
                child.on('exit', (_code, signal) => resolve(signal));
            });

            const killed = forceKillBrowserProcessesByMarker(marker, mockLogger());

            expect(killed).toBe(1);
            expect(await exited).toBe('SIGKILL');
        },
    );
});

describe('the kill handle every launch keeps', () => {
    it('kills a detached process and the whole group it leads', async () => {
        // The shape Playwright launches a browser in: detached, so the parent leads its own group
        // and its children (renderers, helpers) are reachable through the negated pid alone.
        const child = spawn('sh', ['-c', 'sleep 30 & sleep 30'], {
            stdio: 'ignore',
            detached: true,
        });
        const pid = child.pid;
        if (pid === undefined) {
            throw new Error('the kill fixture did not start');
        }
        const exited = new Promise<NodeJS.Signals | null>((resolve) => {
            child.on('exit', (_code, signal) => resolve(signal));
        });
        await new Promise((resolve) => setTimeout(resolve, 200));

        const killed = forceKillBrowserProcessTree(pid, mockLogger());

        expect(killed).toBeGreaterThan(0);
        expect(await exited).toBe('SIGKILL');
    }, 20_000);

    it('reports no kill handle rather than throwing for a browser with no process behind it', () => {
        const logger = mockLogger();
        const connectedBrowser = { isConnected: () => true } as unknown as Browser;

        expect(readBrowserProcessPid(connectedBrowser, logger)).toBeUndefined();
        expect(logger.warn).toHaveBeenCalled();
    });

    // The Playwright Firefox build is a local prerequisite, not a CI one: the lab runner has no
    // browser install step, so the launch proof only runs where the build exists.
    it.skipIf(!existsSync(firefox.executablePath()))(
        'names the pid of a really launched browser',
        async () => {
            const logger = mockLogger();
            const browser = await firefox.launch({ headless: true });
            try {
                const pid = readBrowserProcessPid(browser, logger);
                if (pid === undefined) {
                    throw new Error('a locally launched browser must expose its process pid');
                }
                // A pid the kernel really knows: signal 0 probes existence without delivering.
                expect(() => process.kill(pid, 0)).not.toThrow();
            } finally {
                await browser.close();
            }
        },
        180_000,
    );
});
