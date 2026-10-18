import { describe, expect, it, vi } from 'vitest';
import type { BlockerContract } from '../../src/blocker-contract/blocker-contract';
import type { PlainHttpAnswer } from '../../src/local/plain-http-probe';
import { TlsInterceptionOutcome } from '../../src/local/tls-interception-diagnostic';
import { proveBlockerHttpsFiltering } from '../../src/proxy-blocker/https-filtering-proof';
import { probed } from './https-filtering-proof-fixtures';

const ROUTE = { proxyUrl: 'http://127.0.0.1:3129', certificateDerBase64: 'Y2E=' };

/**
 * A running blocker whose log reports nothing.
 *
 * @returns The blocker.
 */
function blocker(): BlockerContract {
    return {
        describe: vi.fn(),
        start: vi.fn(),
        apply: vi.fn(),
        state: vi.fn(),
        log: vi.fn(async () => ({ revision: 1, cursor: '0', events: [] })),
        stop: vi.fn(),
    };
}

/*
 * The environment is ready only when the reported site's own traffic goes through the filter: HTTPS
 * for a site that serves it, plain HTTP for one that does not.
 */
describe('proveBlockerHttpsFiltering', () => {
    it('proves an https target by an HTTPS request, retrying one dropped connection', async () => {
        const probe = vi
            .fn()
            .mockResolvedValueOnce(
                probed('https://example.test/', TlsInterceptionOutcome.HandshakeFailed),
            )
            .mockResolvedValueOnce(
                probed('https://example.test/', TlsInterceptionOutcome.Filtered),
            );
        const probePlain = vi.fn();

        const proof = await proveBlockerHttpsFiltering({
            blocker: blocker(),
            route: ROUTE,
            targetUrl: 'https://example.test/page?x=1',
            probe,
            probePlain,
        });

        expect(proof).toEqual({ proven: true, host: 'example.test' });
        expect(probe).toHaveBeenCalledTimes(2);
        expect(probePlain).not.toHaveBeenCalled();
    });

    it('refuses an https target the proxy never filters', async () => {
        const probe = vi.fn(async (_proxyUrl: string, url: string) =>
            probed(url, TlsInterceptionOutcome.NotIntercepted),
        );

        const proof = await proveBlockerHttpsFiltering({
            blocker: blocker(),
            route: ROUTE,
            targetUrl: 'https://example.test/',
            probe,
            probePlain: vi.fn(),
        });

        expect(proof).toEqual({
            proven: false,
            host: 'example.test',
            outcome: TlsInterceptionOutcome.NotIntercepted,
        });
    });

    it('proves an http target by its HTTPS when the site serves HTTPS', async () => {
        const probe = vi.fn(async (_proxyUrl: string, url: string) =>
            probed(url, TlsInterceptionOutcome.Filtered),
        );
        const probePlain = vi.fn();

        const proof = await proveBlockerHttpsFiltering({
            blocker: blocker(),
            route: ROUTE,
            targetUrl: 'http://example.test/page',
            probe,
            probePlain,
        });

        expect(proof).toMatchObject({ proven: true });
        expect(probe).toHaveBeenCalledWith(ROUTE.proxyUrl, 'https://example.test/page', 'Y2E=');
        expect(probePlain).not.toHaveBeenCalled();
    });

    it('proves an http target served without TLS by a plain HTTP request', async () => {
        // A site with no working HTTPS is browsed over plain HTTP, which the proxy reads without
        // decrypting anything.
        const answer: PlainHttpAnswer = { statusCode: 200, location: null, failure: null };

        const proof = await proveBlockerHttpsFiltering({
            blocker: blocker(),
            route: ROUTE,
            targetUrl: 'http://example.test/',
            probe: vi.fn(async (_proxyUrl: string, url: string) =>
                probed(url, TlsInterceptionOutcome.HandshakeFailed),
            ),
            probePlain: vi.fn(async () => answer),
        });

        expect(proof).toMatchObject({ proven: true });
    });

    it('refuses an http target whose HTTPS the proxy passes through, however plain HTTP answers', async () => {
        // The host serves HTTPS and the proxy tunnelled it raw: the browser would then accept the
        // proxy's authority for HTTPS the proxy does not read.
        const answer: PlainHttpAnswer = { statusCode: 200, location: null, failure: null };
        const probePlain = vi.fn(async () => answer);

        const proof = await proveBlockerHttpsFiltering({
            blocker: blocker(),
            route: ROUTE,
            targetUrl: 'http://example.test/',
            probe: vi.fn(async (_proxyUrl: string, url: string) =>
                probed(url, TlsInterceptionOutcome.NotIntercepted),
            ),
            probePlain,
        });

        expect(proof).toEqual({
            proven: false,
            host: 'example.test',
            outcome: TlsInterceptionOutcome.NotIntercepted,
        });
    });

    it('refuses an http target that redirects to an HTTPS the proxy does not filter', async () => {
        const answer: PlainHttpAnswer = {
            statusCode: 301,
            location: 'https://example.test/',
            failure: null,
        };

        const proof = await proveBlockerHttpsFiltering({
            blocker: blocker(),
            route: ROUTE,
            targetUrl: 'http://example.test/',
            probe: vi.fn(async (_proxyUrl: string, url: string) =>
                probed(url, TlsInterceptionOutcome.HandshakeFailed),
            ),
            probePlain: vi.fn(async () => answer),
        });

        expect(proof).toEqual({
            proven: false,
            host: 'example.test',
            outcome: TlsInterceptionOutcome.HandshakeFailed,
        });
    });
});
