import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    consumePreparedStrictBrowserRoute,
    createPreparedStrictBrowserRoute,
    inspectPreparedStrictBrowserRoute,
} from '../../src/browser/strict-browser-route';

describe('strict browser route', () => {
    it('binds a one-use route to one exact loopback proxy and target', () => {
        const certificate = Buffer.from('fixture certificate');
        const state = {
            routeId: randomUUID(),
            cycleId: randomUUID(),
            targetUrl: 'https://example.com/',
            proxyUrl: 'http://127.0.0.1:8080/',
            spkiSha256Base64: Buffer.alloc(32).toString('base64'),
            certificateDerBase64: certificate.toString('base64'),
            certificateSha256: createHash('sha256').update(certificate).digest('hex'),
            browserRoot: '/private/tmp/owned-browser-route',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
        const route = createPreparedStrictBrowserRoute(state);

        expect(Object.keys(route)).toEqual([]);
        expect(JSON.stringify(route)).toBe('{}');
        expect(inspectPreparedStrictBrowserRoute(route)).toEqual(state);
        expect(consumePreparedStrictBrowserRoute(route, state.targetUrl)).toEqual(state);
        expect(() => consumePreparedStrictBrowserRoute(route, state.targetUrl)).toThrow(
            'strict_route_replayed',
        );
    });

    it('rejects non-loopback proxies and cross-target consumption', () => {
        const certificate = Buffer.from('fixture certificate');
        const base = {
            routeId: randomUUID(),
            cycleId: randomUUID(),
            targetUrl: 'https://example.com/',
            proxyUrl: 'http://127.0.0.1:8080/',
            spkiSha256Base64: Buffer.alloc(32).toString('base64'),
            certificateDerBase64: certificate.toString('base64'),
            certificateSha256: createHash('sha256').update(certificate).digest('hex'),
            browserRoot: '/private/tmp/owned-browser-route',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
        expect(() =>
            createPreparedStrictBrowserRoute({ ...base, proxyUrl: 'http://localhost:8080/' }),
        ).toThrow('strict_route_proxy_invalid');
        const route = createPreparedStrictBrowserRoute(base);
        expect(() => consumePreparedStrictBrowserRoute(route, 'https://example.test/')).toThrow(
            'strict_route_target_mismatch',
        );
    });

    it('routes a plain-HTTP target a reporter pasted, while still rejecting non-web URLs', () => {
        // A live run failed task #239090 over `http://www.emaillink.adtidy.org/`:
        // the reported site simply has no TLS, and the proxy filters plaintext exactly as it
        // filters TLS, so an http target must route instead of failing the whole task.
        const certificate = Buffer.from('fixture certificate');
        const base = {
            routeId: randomUUID(),
            cycleId: randomUUID(),
            targetUrl: 'http://www.emaillink.adtidy.org/',
            proxyUrl: 'http://127.0.0.1:8080/',
            spkiSha256Base64: Buffer.alloc(32).toString('base64'),
            certificateDerBase64: certificate.toString('base64'),
            certificateSha256: createHash('sha256').update(certificate).digest('hex'),
            browserRoot: '/private/tmp/owned-browser-route',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
        const route = createPreparedStrictBrowserRoute(base);

        expect(consumePreparedStrictBrowserRoute(route, base.targetUrl).targetUrl).toBe(
            base.targetUrl,
        );
        expect(() =>
            createPreparedStrictBrowserRoute({ ...base, targetUrl: 'ftp://example.test/' }),
        ).toThrow('strict_route_target_invalid');
        expect(() =>
            createPreparedStrictBrowserRoute({
                ...base,
                targetUrl: 'http://user:secret@example.test/',
            }),
        ).toThrow('strict_route_target_invalid');
    });

    it('routes a single-page target whose video identity lives in the fragment', () => {
        const certificate = Buffer.from('fixture certificate');
        const targetUrl = 'https://example.com/player#kr5qj';
        const route = createPreparedStrictBrowserRoute({
            routeId: randomUUID(),
            cycleId: randomUUID(),
            targetUrl,
            proxyUrl: 'http://127.0.0.1:8080/',
            spkiSha256Base64: Buffer.alloc(32).toString('base64'),
            certificateDerBase64: certificate.toString('base64'),
            certificateSha256: createHash('sha256').update(certificate).digest('hex'),
            browserRoot: '/private/tmp/owned-browser-route',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });

        expect(consumePreparedStrictBrowserRoute(route, targetUrl).targetUrl).toBe(targetUrl);
    });
});
