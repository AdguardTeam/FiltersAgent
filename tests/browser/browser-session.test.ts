import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import {
    BrowserSession,
    BrowserConfigurationError,
    BrowserLaunchError,
} from '../../src/browser/browser-session';
import { ConsoleCoverage, type IBrowserEngine } from '../../src/browser/browser-interfaces';
import type { ReproProfile } from '../../src/types/repro-profile';
import { createPreparedStrictBrowserRoute } from '../../src/browser/strict-browser-route';
import { buildFirefoxPolicies } from '../../src/browser/firefox-policies';

function mockPage(overrides: Record<string, unknown> = {}) {
    return {
        setViewportSize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        removeAllListeners: vi.fn(),
        url: vi.fn().mockReturnValue('https://example.com'),
        route: vi.fn(),
        unroute: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function mockBrowser(overrides: Record<string, unknown> = {}) {
    return {
        newPage: vi.fn().mockResolvedValue(mockPage()),
        close: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function mockContext(overrides: Record<string, unknown> = {}) {
    return {
        newPage: vi.fn().mockResolvedValue(mockPage()),
        close: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function mockRequest(url: string) {
    return {
        url: () => url,
        method: () => 'GET',
        resourceType: () => 'script',
        headers: () => ({}),
    };
}

function mockEngine(overrides: Partial<IBrowserEngine> = {}): IBrowserEngine {
    return {
        browserType: 'mock',
        consoleCoverage: ConsoleCoverage.BrowserLogOnly,
        launch: vi.fn().mockResolvedValue(mockBrowser()),
        ...overrides,
    };
}

function mockLogger(): Logger {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

const testProfile: ReproProfile = {
    viewport: 'desktop',
    locale: 'en-US',
    timezone: 'UTC',
    userAgentProfile: 'Chrome',
    consentStrategy: 'untouched',
};

describe('BrowserSession', () => {
    let engine: IBrowserEngine;
    let logger: Logger;

    beforeEach(() => {
        engine = mockEngine();
        logger = mockLogger();
    });

    it('creates session and exposes page', async () => {
        const session = await BrowserSession.create({
            engine,
            logger,
            reproProfile: testProfile,
            artifactsDir: '/tmp',
            headless: true,
        });
        expect(session.isClosed).toBe(false);
        expect(session.getPage()).toBeDefined();
        expect(session.getNetworkLog()).toEqual([]);
        expect(session.getConsoleLog()).toEqual([]);
        expect(session.consoleCoverage).toBe(ConsoleCoverage.BrowserLogOnly);
    });

    it('launches a strict route with only the ephemeral CA SPKI allowlist', async () => {
        const page = mockPage();
        const context = mockContext({ newPage: vi.fn().mockResolvedValue(page) });
        const launchPersistentContext = vi.fn().mockResolvedValue(context);
        const eng = mockEngine({ launchPersistentContext });
        const browserRoot = mkdtempSync(join(tmpdir(), 'strict-spki-browser-'));
        chmodSync(browserRoot, 0o700);
        const certificate = Buffer.from('ephemeral fixture CA');
        const spki = Buffer.alloc(32, 7).toString('base64');
        const targetUrl = 'https://example.com/';
        const strictRoute = createPreparedStrictBrowserRoute({
            routeId: randomUUID(),
            cycleId: randomUUID(),
            targetUrl,
            proxyUrl: 'http://127.0.0.1:49152/',
            spkiSha256Base64: spki,
            certificateDerBase64: certificate.toString('base64'),
            certificateSha256: createHash('sha256').update(certificate).digest('hex'),
            browserRoot,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });

        const session = await BrowserSession.create({
            engine: eng,
            logger,
            reproProfile: testProfile,
            artifactsDir: '/tmp',
            headless: true,
            strictRoute,
            strictRouteTargetUrl: targetUrl,
        });

        const launched = launchPersistentContext.mock.calls[0]?.[0];
        expect(launched.args).toContain('--proxy-server=http://127.0.0.1:49152');
        expect(launched.args).toContain(`--ignore-certificate-errors-spki-list=${spki}`);
        expect(launched).not.toHaveProperty('ignoreHTTPSErrors');
        expect(launched.args).not.toContain('--ignore-certificate-errors');
        await session.close();
    });

    it('arms strict-route diagnostics and still cleans the route root after a healthy session', async () => {
        const page = mockPage();
        const context = mockContext({ newPage: vi.fn().mockResolvedValue(page) });
        const launchPersistentContext = vi.fn().mockResolvedValue(context);
        const eng = mockEngine({ launchPersistentContext });
        const browserRoot = mkdtempSync(join(tmpdir(), 'strict-diag-browser-'));
        chmodSync(browserRoot, 0o700);
        const canonicalRoot = realpathSync(browserRoot);
        const certificate = Buffer.from('ephemeral fixture CA');
        const spki = Buffer.alloc(32, 7).toString('base64');
        const targetUrl = 'https://example.com/';
        const strictRoute = createPreparedStrictBrowserRoute({
            routeId: randomUUID(),
            cycleId: randomUUID(),
            targetUrl,
            proxyUrl: 'http://127.0.0.1:49152/',
            spkiSha256Base64: spki,
            certificateDerBase64: certificate.toString('base64'),
            certificateSha256: createHash('sha256').update(certificate).digest('hex'),
            browserRoot,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });

        const session = await BrowserSession.create({
            engine: eng,
            logger,
            reproProfile: testProfile,
            artifactsDir: '/tmp',
            headless: true,
            strictRoute,
            strictRouteTargetUrl: targetUrl,
        });

        const launched = launchPersistentContext.mock.calls[0]?.[0];
        expect(launched.args).toContain('--enable-logging');
        expect(launched.args).toContain(
            `--log-file=${join(canonicalRoot, 'logs', 'browser-chromium.log')}`,
        );
        expect(launched.ignoreDefaultArgs).toContain('--disable-breakpad');
        expect(launched.browserProcessLogger.isEnabled('browser', 'error')).toBe(true);
        expect(existsSync(join(canonicalRoot, 'logs'))).toBe(true);

        await session.close();
        expect(existsSync(canonicalRoot)).toBe(false);
    });

    it('keeps the strict-route temp dir short enough for the Chromium singleton socket', async () => {
        const page = mockPage();
        const context = mockContext({ newPage: vi.fn().mockResolvedValue(page) });
        const launchPersistentContext = vi.fn().mockResolvedValue(context);
        const eng = mockEngine({ launchPersistentContext });
        const browserRoot = mkdtempSync(join(tmpdir(), 'strict-tmp-browser-'));
        chmodSync(browserRoot, 0o700);
        const certificate = Buffer.from('ephemeral fixture CA');
        const spki = Buffer.alloc(32, 7).toString('base64');
        const targetUrl = 'https://example.com/';
        const strictRoute = createPreparedStrictBrowserRoute({
            routeId: randomUUID(),
            cycleId: randomUUID(),
            targetUrl,
            proxyUrl: 'http://127.0.0.1:49152/',
            spkiSha256Base64: spki,
            certificateDerBase64: certificate.toString('base64'),
            certificateSha256: createHash('sha256').update(certificate).digest('hex'),
            browserRoot,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });

        const session = await BrowserSession.create({
            engine: eng,
            logger,
            reproProfile: testProfile,
            artifactsDir: '/tmp',
            headless: true,
            strictRoute,
            strictRouteTargetUrl: targetUrl,
        });

        const launched = launchPersistentContext.mock.calls[0]?.[0];
        const tempDir = launched.environment.TMPDIR as string;
        // Chromium's ProcessSingleton binds its singleton socket at
        // `$TMPDIR/org.chromium.Chromium.XXXXXX/SingletonSocket` under
        // CHECK(path.length() < sizeof(sockaddr_un::sun_path)) — 108 bytes on Linux glibc —
        // and the process dies on SIGTRAP when the route-owned deep path overflows it.
        const socketPathSuffix = '/org.chromium.Chromium.XXXXXX/SingletonSocket';
        expect(tempDir.length + socketPathSuffix.length).toBeLessThan(108);
        expect(tempDir.startsWith(browserRoot)).toBe(false);
        expect(existsSync(tempDir)).toBe(true);
        expect(launched.environment.TMP).toBe(tempDir);
        expect(launched.environment.TEMP).toBe(tempDir);

        await session.close();
        expect(existsSync(tempDir)).toBe(false);
    });

    it('preserves the strict route root with its browser logs when the launch crashes', async () => {
        const browserRoot = mkdtempSync(join(tmpdir(), 'strict-crash-browser-'));
        chmodSync(browserRoot, 0o700);
        const canonicalRoot = realpathSync(browserRoot);
        const launchPersistentContext = vi.fn().mockImplementation(async () => {
            // The dying browser wrote its FATAL line to the route-owned log before trapping.
            writeFileSync(
                join(canonicalRoot, 'logs', 'browser-chromium.log'),
                '[1:1:0101/000000.000000:FATAL:check.cc] Check failed: boom.\n',
            );
            throw new Error(
                'browserType.launchPersistentContext: Target page, context or browser has ' +
                    'been closed\n[pid=1] <process did exit: exitCode=null, signal=SIGTRAP>',
            );
        });
        const eng = mockEngine({ launchPersistentContext });
        const certificate = Buffer.from('ephemeral fixture CA');
        const spki = Buffer.alloc(32, 7).toString('base64');
        const targetUrl = 'https://example.com/';
        const strictRoute = createPreparedStrictBrowserRoute({
            routeId: randomUUID(),
            cycleId: randomUUID(),
            targetUrl,
            proxyUrl: 'http://127.0.0.1:49152/',
            spkiSha256Base64: spki,
            certificateDerBase64: certificate.toString('base64'),
            certificateSha256: createHash('sha256').update(certificate).digest('hex'),
            browserRoot,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });

        try {
            await expect(
                BrowserSession.create({
                    engine: eng,
                    logger,
                    reproProfile: testProfile,
                    artifactsDir: '/tmp',
                    headless: true,
                    strictRoute,
                    strictRouteTargetUrl: targetUrl,
                }),
            ).rejects.toBeInstanceOf(BrowserLaunchError);

            expect(existsSync(canonicalRoot)).toBe(true);
            // The short temp dir holds only the dead singleton socket: unlike the route root
            // it carries no forensics, so a failed launch disposes it immediately.
            const failedLaunch = launchPersistentContext.mock.calls[0]?.[0];
            expect(existsSync(failedLaunch.environment.TMPDIR as string)).toBe(false);
            const warnings = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
            const diagnostic = warnings
                .map((call) => call[0] as Record<string, unknown>)
                .find((payload) => payload.routeDiagnosticsDir === canonicalRoot);
            expect(diagnostic).toBeDefined();
            expect(diagnostic?.chromiumLogTail).toContain('FATAL:check.cc');
        } finally {
            rmSync(canonicalRoot, { recursive: true, force: true });
        }
    });

    it('applies locale, timezone, and user-agent profile when opening the page', async () => {
        const page = mockPage();
        const newPage = vi.fn().mockResolvedValue(page);
        const browser = mockBrowser({ newPage });
        const eng = mockEngine({ launch: vi.fn().mockResolvedValue(browser) });

        await BrowserSession.create({
            engine: eng,
            logger,
            reproProfile: testProfile,
            artifactsDir: '/tmp',
            headless: true,
        });

        expect(newPage).toHaveBeenCalledWith(
            expect.objectContaining({
                locale: 'en-US',
                timezoneId: 'UTC',
                userAgent: expect.stringContaining('Chrome/'),
            }),
        );
    });

    it('attaches network listener during create (F2)', async () => {
        const page = mockPage();
        const browser = mockBrowser({ newPage: vi.fn().mockResolvedValue(page) });
        const eng = mockEngine({ launch: vi.fn().mockResolvedValue(browser) });
        await BrowserSession.create({
            engine: eng,
            logger,
            reproProfile: testProfile,
            artifactsDir: '/tmp',
            headless: true,
        });
        expect(page.on).toHaveBeenCalledWith('request', expect.any(Function));
        expect(page.on).toHaveBeenCalledWith('response', expect.any(Function));
        expect(page.on).toHaveBeenCalledWith('requestfailed', expect.any(Function));
    });

    it('attaches console listener during create (F8)', async () => {
        const page = mockPage();
        const browser = mockBrowser({ newPage: vi.fn().mockResolvedValue(page) });
        const eng = mockEngine({ launch: vi.fn().mockResolvedValue(browser) });
        await BrowserSession.create({
            engine: eng,
            logger,
            reproProfile: testProfile,
            artifactsDir: '/tmp',
            headless: true,
        });
        expect(page.on).toHaveBeenCalledWith('console', expect.any(Function));
    });

    it('removes event listeners on close (F11)', async () => {
        const page = mockPage();
        const browser = mockBrowser({ newPage: vi.fn().mockResolvedValue(page) });
        const eng = mockEngine({ launch: vi.fn().mockResolvedValue(browser) });
        const session = await BrowserSession.create({
            engine: eng,
            logger,
            reproProfile: testProfile,
            artifactsDir: '/tmp',
            headless: true,
        });
        await session.close();
        expect(page.removeAllListeners).toHaveBeenCalled();
        expect(page.unroute).toHaveBeenCalled();
        expect(browser.close).toHaveBeenCalled();
        expect(session.isClosed).toBe(true);
    });

    it('getPage throws after close', async () => {
        const session = await BrowserSession.create({
            engine,
            logger,
            reproProfile: testProfile,
            artifactsDir: '/tmp',
            headless: true,
        });
        await session.close();
        expect(() => session.getPage()).toThrow(/closed/);
    });

    it('close is idempotent', async () => {
        const session = await BrowserSession.create({
            engine,
            logger,
            reproProfile: testProfile,
            artifactsDir: '/tmp',
            headless: true,
        });
        await session.close();
        await session.close(); // no throw
    });

    it('close resolves within its bound when the underlying browser close never settles', async () => {
        const page = mockPage();
        const browser = mockBrowser({
            newPage: vi.fn().mockResolvedValue(page),
            close: vi.fn().mockReturnValue(new Promise<void>(() => undefined)),
        });
        const eng = mockEngine({ launch: vi.fn().mockResolvedValue(browser) });
        const session = await BrowserSession.create({
            engine: eng,
            logger,
            reproProfile: testProfile,
            artifactsDir: '/tmp',
            headless: true,
            closeTimings: { deadlineMs: 40, settleMs: 40 },
        });

        await session.close();

        expect(session.isClosed).toBe(true);
    });

    it('close resolves without throwing when the underlying browser close rejects', async () => {
        const page = mockPage();
        const browser = mockBrowser({
            newPage: vi.fn().mockResolvedValue(page),
            close: vi
                .fn()
                .mockRejectedValue(new Error('Target page, context or browser has been closed')),
        });
        const eng = mockEngine({ launch: vi.fn().mockResolvedValue(browser) });
        const session = await BrowserSession.create({
            engine: eng,
            logger,
            reproProfile: testProfile,
            artifactsDir: '/tmp',
            headless: true,
        });

        await session.close();

        expect(session.isClosed).toBe(true);
    });

    it('throws BrowserLaunchError on launch failure (F3)', async () => {
        const failingEngine = mockEngine({
            launch: vi.fn().mockRejectedValue(new Error('ENOENT')),
        });
        await expect(
            BrowserSession.create({
                engine: failingEngine,
                logger,
                reproProfile: testProfile,
                artifactsDir: '/tmp',
                headless: true,
            }),
        ).rejects.toThrow(BrowserLaunchError);
        expect(logger.error).toHaveBeenCalled();
    });

    it('logs lifecycle events (F7)', async () => {
        await BrowserSession.create({
            engine,
            logger,
            reproProfile: testProfile,
            artifactsDir: '/tmp',
            headless: true,
        });
        expect(logger.info).toHaveBeenCalledWith(
            expect.objectContaining({}),
            'browser session created',
        );
    });

    it('passes --no-sandbox only when configured (F10)', async () => {
        const eng = mockEngine();
        await BrowserSession.create({
            engine: eng,
            logger,
            reproProfile: testProfile,
            artifactsDir: '/tmp',
            headless: true,
            noSandbox: true,
        });
        expect(eng.launch).toHaveBeenCalledWith(
            expect.objectContaining({ args: ['--no-sandbox'] }),
        );
    });

    it('does NOT pass --no-sandbox when not configured (F10)', async () => {
        const eng = mockEngine();
        await BrowserSession.create({
            engine: eng,
            logger,
            reproProfile: testProfile,
            artifactsDir: '/tmp',
            headless: true,
            noSandbox: false,
        });
        expect(eng.launch).toHaveBeenCalledWith(expect.objectContaining({ args: undefined }));
    });

    it('launches the prepared extension into a persistent context and exposes the context for the host read-back', async () => {
        const page = mockPage();
        const context = mockContext({ newPage: vi.fn().mockResolvedValue(page) });
        const launchPersistentContext = vi.fn().mockResolvedValue(context);
        const eng = mockEngine({ launchPersistentContext });

        const session = await BrowserSession.create({
            engine: eng,
            logger,
            reproProfile: testProfile,
            artifactsDir: '/tmp',
            headless: true,
            adguardExtensionPath: '/tmp/adguard-extension',
        });

        expect(eng.launch).not.toHaveBeenCalled();
        expect(launchPersistentContext).toHaveBeenCalledWith(
            expect.objectContaining({
                extensionPaths: ['/tmp/adguard-extension'],
                userDataDir: expect.any(String),
            }),
        );
        // The host reads the prepared extension's state back over the
        // session's own persistent context; there is no launch-time settings application.
        expect(session.extensionContext).toBe(context);
        await session.close();
        expect(context.close).toHaveBeenCalled();
    });

    it('enables the historical MV2 runtime when the prepared build ships manifest v2', async () => {
        const page = mockPage();
        const context = mockContext({ newPage: vi.fn().mockResolvedValue(page) });
        const launchPersistentContext = vi.fn().mockResolvedValue(context);
        const eng = mockEngine({ launchPersistentContext });

        const session = await BrowserSession.create({
            engine: eng,
            logger,
            reproProfile: testProfile,
            artifactsDir: '/tmp',
            headless: true,
            noSandbox: true,
            adguardExtensionPath: '/tmp/adguard-extension-mv2',
            adguardExtensionManifestVersion: 2,
        });

        expect(launchPersistentContext).toHaveBeenCalledWith(
            expect.objectContaining({
                args: [
                    '--no-sandbox',
                    '--disable-features=ExtensionManifestV2Disabled,ExtensionManifestV2Unsupported',
                ],
            }),
        );
        await session.close();
    });

    it('rejects Firefox policies mixed with the Chromium extension channel without launching', async () => {
        const launchPersistentContext = vi.fn().mockResolvedValue(mockContext());
        const eng = mockEngine({ launchPersistentContext });

        await expect(
            BrowserSession.create({
                engine: eng,
                logger,
                reproProfile: testProfile,
                artifactsDir: '/tmp',
                headless: true,
                firefoxPolicies: buildFirefoxPolicies({
                    extensionId: 'uBlock0@raymondhill.net',
                    xpiPath: '/tmp/u.xpi',
                }),
                adguardExtensionPath: '/tmp/adguard-extension',
            }),
        ).rejects.toThrow(BrowserConfigurationError);
        expect(eng.launch).not.toHaveBeenCalled();
        expect(launchPersistentContext).not.toHaveBeenCalled();
    });

    it('accumulates network requests from pre-attached listener', async () => {
        const page = mockPage();
        let responseHandler: Function = vi.fn();
        page.on = vi.fn().mockImplementation((event: string, handler: Function) => {
            if (event === 'response') {
                responseHandler = handler;
            }
        });
        const browser = mockBrowser({ newPage: vi.fn().mockResolvedValue(page) });
        const eng = mockEngine({ launch: vi.fn().mockResolvedValue(browser) });
        const session = await BrowserSession.create({
            engine: eng,
            logger,
            reproProfile: testProfile,
            artifactsDir: '/tmp',
            headless: true,
        });
        // Simulate a response
        responseHandler({
            request: () => ({
                url: () => 'https://ad.example.com/banner.js',
                method: () => 'GET',
                resourceType: () => 'script',
                headers: () => ({ Accept: '*/*' }),
            }),
            status: () => 200,
            headers: () => ({}),
        });
        const log = session.getNetworkLog();
        expect(log).toHaveLength(1);
        expect(log[0].url).toBe('https://ad.example.com/banner.js');
    });

    it('records failed requests with a zero status code', async () => {
        const page = mockPage();
        let requestFailedHandler: Function = vi.fn();
        page.on = vi.fn().mockImplementation((event: string, handler: Function) => {
            if (event === 'requestfailed') {
                requestFailedHandler = handler;
            }
        });
        const browser = mockBrowser({ newPage: vi.fn().mockResolvedValue(page) });
        const eng = mockEngine({ launch: vi.fn().mockResolvedValue(browser) });
        const session = await BrowserSession.create({
            engine: eng,
            logger,
            reproProfile: testProfile,
            artifactsDir: '/tmp',
            headless: true,
        });

        requestFailedHandler({
            url: () => 'https://ad.example.com/blocked.js',
            method: () => 'GET',
            resourceType: () => 'script',
            headers: () => ({ Accept: '*/*' }),
        });

        expect(session.getNetworkLog()).toEqual([
            {
                url: 'https://ad.example.com/blocked.js',
                method: 'GET',
                resourceType: 'script',
                statusCode: 0,
                requestHeaders: { Accept: '*/*' },
                responseHeaders: {},
            },
        ]);
    });

    it('does not duplicate a successful response when requestfailed is also emitted', async () => {
        const page = mockPage();
        let responseHandler: Function = vi.fn();
        let requestFailedHandler: Function = vi.fn();
        page.on = vi.fn().mockImplementation((event: string, handler: Function) => {
            if (event === 'response') {
                responseHandler = handler;
            }
            if (event === 'requestfailed') {
                requestFailedHandler = handler;
            }
        });
        const browser = mockBrowser({ newPage: vi.fn().mockResolvedValue(page) });
        const eng = mockEngine({ launch: vi.fn().mockResolvedValue(browser) });
        const session = await BrowserSession.create({
            engine: eng,
            logger,
            reproProfile: testProfile,
            artifactsDir: '/tmp',
            headless: true,
        });
        const request = {
            url: () => 'https://example.com/app.js',
            method: () => 'GET',
            resourceType: () => 'script',
            headers: () => ({}),
        };

        responseHandler({
            request: () => request,
            status: () => 200,
            headers: () => ({ 'content-type': 'application/javascript' }),
        });
        requestFailedHandler(request);

        expect(session.getNetworkLog()).toHaveLength(1);
        expect(session.getNetworkLog()[0].statusCode).toBe(200);
    });

    it('clears accumulated network entries without detaching listeners', async () => {
        const page = mockPage();
        let responseHandler: Function = vi.fn();
        page.on = vi.fn().mockImplementation((event: string, handler: Function) => {
            if (event === 'response') {
                responseHandler = handler;
            }
        });
        const browser = mockBrowser({ newPage: vi.fn().mockResolvedValue(page) });
        const eng = mockEngine({ launch: vi.fn().mockResolvedValue(browser) });
        const session = await BrowserSession.create({
            engine: eng,
            logger,
            reproProfile: testProfile,
            artifactsDir: '/tmp',
            headless: true,
        });
        const emitResponse = (url: string): void => {
            responseHandler({
                request: () => ({
                    url: () => url,
                    method: () => 'GET',
                    resourceType: () => 'document',
                    headers: () => ({}),
                }),
                status: () => 200,
                headers: () => ({}),
            });
        };

        emitResponse('https://example.com/phase-a');
        session.resetNetworkLog();
        emitResponse('https://example.com/phase-b');

        expect(session.getNetworkLog().map((entry) => entry.url)).toEqual([
            'https://example.com/phase-b',
        ]);
    });

    it('ignores terminal events from requests started before the network reset', async () => {
        const page = mockPage();
        let requestHandler: Function = vi.fn();
        let responseHandler: Function = vi.fn();
        let requestFailedHandler: Function = vi.fn();
        page.on = vi.fn().mockImplementation((event: string, handler: Function) => {
            if (event === 'request') {
                requestHandler = handler;
            }
            if (event === 'response') {
                responseHandler = handler;
            }
            if (event === 'requestfailed') {
                requestFailedHandler = handler;
            }
        });
        const browser = mockBrowser({ newPage: vi.fn().mockResolvedValue(page) });
        const eng = mockEngine({ launch: vi.fn().mockResolvedValue(browser) });
        const session = await BrowserSession.create({
            engine: eng,
            logger,
            reproProfile: testProfile,
            artifactsDir: '/tmp',
            headless: true,
        });
        const lateResponseRequest = mockRequest('https://example.com/late-response.js');
        const lateFailureRequest = mockRequest('https://example.com/late-failure.js');
        const currentRequest = mockRequest('https://example.com/current.js');

        requestHandler(lateResponseRequest);
        requestHandler(lateFailureRequest);
        session.resetNetworkLog();
        responseHandler({
            request: () => lateResponseRequest,
            status: () => 200,
            headers: () => ({}),
        });
        requestFailedHandler(lateFailureRequest);
        requestHandler(currentRequest);
        responseHandler({
            request: () => currentRequest,
            status: () => 200,
            headers: () => ({}),
        });

        expect(session.getNetworkLog().map((entry) => entry.url)).toEqual([
            'https://example.com/current.js',
        ]);
    });
});
