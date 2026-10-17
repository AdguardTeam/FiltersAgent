import { describe, expect, it, vi } from 'vitest';
import type { Request, Route } from 'playwright-core';
import { createBrowserToolHandlers } from '../../src/browser/browser-tools';
import { ConsoleCoverage, type IBrowserSession } from '../../src/browser/browser-interfaces';
import { RedirectOriginPolicy } from '../../src/browser/redirect-origin-policy';
import { BrowserFallbackReason } from '../../src/types/browser-fallback-reason';
import { ConsentStrategy } from '../../src/types/repro-profile';
import type { TraceRecorder } from '../../src/tracer/trace-recorder';

function fixture(policy: RedirectOriginPolicy = RedirectOriginPolicy.KeepRelatedHosts) {
    let guard: ((route: Route, request: Request) => Promise<void>) | undefined;
    let currentUrl = 'https://example.com/';
    let landingUrl: string | undefined;
    let consentNavigation = false;
    let evaluateNavigation = false;
    let status = 200;
    const mainFrame = { url: () => currentUrl, page: () => page };
    const context = {
        route: vi.fn(async (_pattern, handler) => {
            guard = handler;
        }),
        unroute: vi.fn(),
    };
    async function request(url: string, frame: unknown = mainFrame, navigation = true) {
        const route = { abort: vi.fn(), fallback: vi.fn() };
        await guard!(
            route as unknown as Route,
            {
                url: () => url,
                frame: () => {
                    if (frame === undefined) {
                        throw new Error('frame is not available');
                    }
                    return frame;
                },
                isNavigationRequest: () => navigation,
                serviceWorker: () => null,
            } as Request,
        );
        return route;
    }
    const page = {
        context: () => context,
        mainFrame: () => mainFrame,
        on: vi.fn(),
        off: vi.fn(),
        url: () => currentUrl,
        title: async () => 'Example',
        goto: vi.fn(async (url: string) => {
            currentUrl = landingUrl ?? url;
            if (landingUrl) {
                await request(landingUrl);
            }
            return { status: () => status };
        }),
        waitForTimeout: vi.fn(),
        evaluate: vi.fn(async (expression: string) => {
            if (expression.includes('__adguard_page_stability_probe__')) {
                return {
                    readyState: 'complete',
                    htmlLength: 100,
                    nodeCount: 10,
                    textLength: 10,
                    scrollHeight: 100,
                    scrollY: 0,
                    resourceCount: 1,
                    domFingerprint: 'stable',
                };
            }
            if (expression.includes('__adguard_consent_page_state__')) {
                if (consentNavigation) {
                    await request('https://example.org/consent');
                }
                return { bodyClassName: '', visibleObstructionCount: 0, visibleObstructions: [] };
            }
            if (evaluateNavigation) {
                await request('https://example.org/later');
            }
            return 'Example';
        }),
    };
    const tools = createBrowserToolHandlers({
        session: {
            getPage: () => page,
            getNetworkLog: () => [],
            consoleCoverage: ConsoleCoverage.BrowserLogOnly,
        } as unknown as IBrowserSession,
        recorder: {} as TraceRecorder,
        artifactsDir: '/tmp',
        allowedOrigin: 'https://example.com/',
        redirectOriginPolicy: policy,
        resolveHostname: async () => ['93.184.216.34'],
        openPageRetries: 1,
        postNavigationSettleMs: 0,
        consentStrategy: ConsentStrategy.Accept,
    });
    return {
        tools,
        request,
        context,
        page,
        setLanding: (url: string) => {
            landingUrl = url;
        },
        setConsentNavigation: (enabled = true) => {
            consentNavigation = enabled;
        },
        setEvaluateNavigation: () => {
            evaluateNavigation = true;
        },
        setStatus: (value: number) => {
            status = value;
        },
    };
}

describe('redirect admission and context guard', () => {
    it('keeps a related landing origin for the rest of a historical session', async () => {
        const f = fixture();
        f.setLanding('https://sub.example.com/landing');
        expect((await f.tools.open_page({ url: 'https://example.com/' })).error).toBeUndefined();
        expect(
            (await f.tools.open_page({ url: 'https://sub.example.com/next' })).error,
        ).toBeUndefined();
    });
    it('opens an unrelated landing origin for the current load only in a historical session', async () => {
        const f = fixture();
        f.setLanding('https://example.org/landing');
        expect((await f.tools.open_page({ url: 'https://example.com/' })).error).toBeUndefined();
        expect((await f.tools.open_page({ url: 'https://example.org/next' })).fallbackReason).toBe(
            BrowserFallbackReason.NavigationOffOrigin,
        );
        expect(f.page.goto).toHaveBeenCalledOnce();
    });
    it('admits a temporary landing origin through consent reloads until the next open_page', async () => {
        const f = fixture();
        f.setLanding('https://example.org/landing');
        f.setConsentNavigation();
        expect((await f.tools.open_page({ url: 'https://example.com/' })).error).toBeUndefined();
        const sameLoadNavigation = await f.request('https://example.org/reload');
        expect(sameLoadNavigation.fallback).toHaveBeenCalledOnce();
        expect(sameLoadNavigation.abort).not.toHaveBeenCalled();

        f.setLanding('https://example.com/next');
        f.setConsentNavigation(false);
        expect(
            (await f.tools.open_page({ url: 'https://example.com/next' })).error,
        ).toBeUndefined();
        const previousLoadNavigation = await f.request('https://example.org/reload');
        expect(previousLoadNavigation.abort).toHaveBeenCalledWith('blockedbyclient');
        expect(previousLoadNavigation.fallback).not.toHaveBeenCalled();
    });
    it.each(Object.values(RedirectOriginPolicy))(
        'refuses a navigation during consent setup in both redirect policies: %s',
        async (policy) => {
            const f = fixture(policy);
            f.setConsentNavigation();
            expect((await f.tools.open_page({ url: 'https://example.com/' })).fallbackReason).toBe(
                BrowserFallbackReason.NavigationOffOrigin,
            );
        },
    );
    it.each(Object.values(RedirectOriginPolicy))(
        'closes the redirect window when open_page returns an HTTP error status: %s',
        async (policy) => {
            const f = fixture(policy);
            f.setStatus(404);
            expect((await f.tools.open_page({ url: 'https://example.com/' })).fallbackReason).toBe(
                BrowserFallbackReason.NotFound,
            );
            f.setEvaluateNavigation();
            await f.tools.evaluate_js({ expression: 'document.title' });
            const late = await f.request('https://example.org/later');
            expect(late.abort).toHaveBeenCalledWith('blockedbyclient');
            expect(late.fallback).not.toHaveBeenCalled();
        },
    );
    it('answers a navigation whose frame cannot be read', async () => {
        const f = fixture();
        await f.tools.open_page({ url: 'https://example.com/' });
        for (const [url, blocked] of [
            ['http://127.0.0.1/secret', true],
            ['https://example.org/', false],
        ] as const) {
            const route = { abort: vi.fn(), fallback: vi.fn() };
            const handler = f.context.route.mock.calls[0][1];
            await handler(route, {
                url: () => url,
                isNavigationRequest: () => true,
                serviceWorker: () => null,
                frame: () => {
                    throw new Error('frame is not available');
                },
            });
            expect(route.abort).toHaveBeenCalledTimes(blocked ? 1 : 0);
            expect(route.fallback).toHaveBeenCalledTimes(blocked ? 0 : 1);
        }
    });
    it("guards requests from every page of the session's browser context", async () => {
        const f = fixture();
        await f.tools.open_page({ url: 'https://example.com/' });
        const route = await f.request(
            'http://10.0.0.1/private',
            { url: () => 'https://example.org/', page: () => f.page },
            false,
        );
        expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
        expect(route.fallback).not.toHaveBeenCalled();
    });
    it('lets an extension service worker refetch a loopback custom filter without a frame', async () => {
        const f = fixture();
        await f.tools.open_page({ url: 'https://example.com/' });
        const route = { abort: vi.fn(), fallback: vi.fn() };
        const handler = f.context.route.mock.calls[0][1];
        await handler(route, {
            url: () => 'http://127.0.0.1:1234/list',
            isNavigationRequest: () => false,
            serviceWorker: () => ({ url: () => 'chrome-extension://extension/background.js' }),
            frame: () => {
                throw new Error('service-worker requests have no frame');
            },
        });
        expect(route.fallback).toHaveBeenCalledOnce();
        expect(route.abort).not.toHaveBeenCalled();
    });
    it('refuses private navigation from a web subframe redirected to an extension resource', async () => {
        const f = fixture();
        await f.tools.open_page({ url: 'https://example.com/' });
        const redirectedSubframe = {
            url: () => 'chrome-extension://extension/noopframe.html',
            page: () => f.page,
        };
        const route = await f.request('http://127.0.0.1/private', redirectedSubframe);
        expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
        expect(route.fallback).not.toHaveBeenCalled();
    });
    it('lets requests of extension pages through the context guard', async () => {
        const f = fixture();
        await f.tools.open_page({ url: 'https://example.com/' });
        const extensionPage = {
            mainFrame: () => extensionFrame,
        };
        const extensionFrame = {
            url: () => 'chrome-extension://extension/options.html',
            page: () => extensionPage,
        };
        for (const url of [
            'chrome-extension://extension/options.html',
            'http://127.0.0.1:1234/list',
        ]) {
            const route = await f.request(url, extensionFrame, false);
            expect(route.fallback).toHaveBeenCalledOnce();
            expect(route.abort).not.toHaveBeenCalled();
        }
        const webRequest = await f.request('http://127.0.0.1:1234/list', undefined, false);
        expect(webRequest.abort).toHaveBeenCalledWith('blockedbyclient');
    });
});
