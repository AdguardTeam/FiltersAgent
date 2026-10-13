import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import { BrowserSession } from '../../src/browser/browser-session';
import { ConsoleCoverage, type IBrowserEngine } from '../../src/browser/browser-interfaces';
import { createPreparedStrictBrowserRoute } from '../../src/browser/strict-browser-route';
import type { ReproProfile } from '../../src/types/repro-profile';

const profile: ReproProfile = {
    viewport: 'desktop',
    locale: 'en-US',
    timezone: 'UTC',
    userAgentProfile: 'Chrome',
    consentStrategy: 'untouched',
};

function silentLogger(): Logger {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

/**
 * Launch one strict route through the production seam and capture what the engine received.
 *
 * @returns The exact launch configuration and the route root it was scoped to.
 */
async function captureStrictRouteLaunch(): Promise<{
    launched: { environment: Record<string, string>; userDataDir: string };
    browserRoot: string;
    routeRoot: string;
}> {
    const page = {
        setViewportSize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        removeAllListeners: vi.fn(),
        url: vi.fn().mockReturnValue('https://example.com/'),
        route: vi.fn(),
        unroute: vi.fn().mockResolvedValue(undefined),
    };
    const launchPersistentContext = vi.fn().mockResolvedValue({
        newPage: vi.fn().mockResolvedValue(page),
        close: vi.fn().mockResolvedValue(undefined),
    });
    const engine: IBrowserEngine = {
        browserType: 'mock',
        consoleCoverage: ConsoleCoverage.BrowserLogOnly,
        launch: vi.fn(),
        launchPersistentContext,
    } as unknown as IBrowserEngine;

    const browserRoot = mkdtempSync(join(tmpdir(), 'strict-route-trust-'));
    chmodSync(browserRoot, 0o700);
    const certificate = Buffer.from('ephemeral fixture CA');
    const targetUrl = 'https://example.com/';
    const session = await BrowserSession.create({
        engine,
        logger: silentLogger(),
        reproProfile: profile,
        artifactsDir: browserRoot,
        headless: true,
        strictRoute: createPreparedStrictBrowserRoute({
            routeId: randomUUID(),
            cycleId: randomUUID(),
            targetUrl,
            proxyUrl: 'http://127.0.0.1:49152/',
            spkiSha256Base64: Buffer.alloc(32, 7).toString('base64'),
            certificateDerBase64: certificate.toString('base64'),
            certificateSha256: createHash('sha256').update(certificate).digest('hex'),
            browserRoot,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        strictRouteTargetUrl: targetUrl,
    });
    const routeRoot = realpathSync(browserRoot);
    await session.close();
    return { launched: launchPersistentContext.mock.calls[0]?.[0], browserRoot, routeRoot };
}

/*
 * The route's HTTPS interception is trusted only because a certificate authority was installed
 * into the operator's own user trust domain — the sole reason the operator is ever asked for a
 * macOS password. On macOS that whole domain is resolved from the launched process's HOME, so a
 * browser launched with a private HOME cannot see the trust that was just installed for it and
 * every intercepted navigation fails as an unknown authority. That is a production failure with no
 * unit-level signal, so this suite asks the real system resolver whether the environment the
 * production seam builds can still reach the operator's trust domain.
 */
describe('strict route trust domain', () => {
    it.runIf(process.platform === 'darwin')(
        'launches the browser where the operator user trust domain still resolves',
        async () => {
            const { launched, browserRoot } = await captureStrictRouteLaunch();
            let resolved = '';
            let failure = '';
            try {
                resolved = execFileSync('/usr/bin/security', ['default-keychain'], {
                    env: launched.environment,
                    encoding: 'utf8',
                });
            } catch (error) {
                failure = (error as Error).message.split('\n')[0];
            } finally {
                rmSync(browserRoot, { recursive: true, force: true });
            }
            expect(failure).toBe('');
            expect(resolved).toContain('Library/Keychains');
        },
    );

    it('keeps everything with diagnostic value inside the route root', async () => {
        const { launched, browserRoot, routeRoot } = await captureStrictRouteLaunch();
        try {
            const owned = [
                launched.userDataDir,
                launched.environment.XDG_CONFIG_HOME,
                launched.environment.XDG_DATA_HOME,
                launched.environment.XDG_CACHE_HOME,
            ];
            for (const path of owned) {
                const child = relative(routeRoot, path);
                expect(child.startsWith('..')).toBe(false);
                expect(child).not.toBe('');
            }
            // The temporary directory is the one documented exception: Chromium's
            // ProcessSingleton CHECKs its `$TMPDIR/org.chromium.Chromium.XXXXXX/SingletonSocket`
            // path against the 108-byte sun_path and SIGTRAPs at startup when the deep
            // route-owned path overflows it, so TMPDIR is a short private dir instead. It holds
            // only the dead singleton socket and browser scratch — nothing to diagnose.
            expect(launched.environment.TMPDIR.startsWith(routeRoot)).toBe(false);
        } finally {
            rmSync(browserRoot, { recursive: true, force: true });
        }
    });
});
