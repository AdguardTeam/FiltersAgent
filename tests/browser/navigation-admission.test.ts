import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { Page, Request, Route } from 'playwright-core';
import { createNavigationAdmission } from '../../src/browser/navigation-admission';
import { RedirectOriginPolicy } from '../../src/browser/redirect-origin-policy';

/**
 * Playwright's message for a route action on a page whose browser already closed.
 */
const TARGET_CLOSED = 'Target page, context or browser has been closed';

/**
 * Install the context-wide guard on a fake page and return the handler Playwright would call.
 *
 * @returns The guard handler and the page's main frame.
 */
async function installedGuard() {
    let guard: ((route: Route, request: Request) => Promise<void>) | undefined;
    const mainFrame = { url: () => 'https://example.com/', page: () => page };
    const page = {
        mainFrame: () => mainFrame,
        context: () => ({
            route: vi.fn(async (_pattern: string, handler: typeof guard) => {
                guard = handler;
            }),
        }),
    };
    const admission = createNavigationAdmission({
        allowedOrigin: 'https://example.com/',
        redirectOriginPolicy: RedirectOriginPolicy.KeepRelatedHosts,
        resolveHostname: async (hostname) =>
            hostname === 'private.example.com' ? ['10.0.0.1'] : ['93.184.216.34'],
        logger: pino({ level: 'silent' }),
    });
    await admission.installGuard(page as unknown as Page);
    return { guard: guard!, mainFrame };
}

/**
 * Build a route whose every action rejects the way Playwright does after the browser closed.
 *
 * @returns The closed route.
 */
function closedRoute() {
    const fail = async (): Promise<void> => {
        throw new Error(`route.abort: ${TARGET_CLOSED}`);
    };
    return { fallback: vi.fn(fail), abort: vi.fn(fail) };
}

describe('context network guard after the browser closed', () => {
    it.each([
        ['an admitted subresource', 'https://cdn.example.org/app.js'],
        ['a refused private-address subresource', 'https://private.example.com/pixel'],
    ])('settles %s instead of rejecting the route callback', async (_label, url) => {
        const { guard, mainFrame } = await installedGuard();
        const request = {
            url: () => url,
            frame: () => mainFrame,
            isNavigationRequest: () => false,
            serviceWorker: () => null,
        } as unknown as Request;

        await expect(guard(closedRoute() as unknown as Route, request)).resolves.toBeUndefined();
    });
});
