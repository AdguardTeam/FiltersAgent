import { createServer as createHttpServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { probePlainHttp } from '../../src/local/plain-http-probe';

/*
 * A site served without TLS is browsed over plain HTTP; whether the proxy answers such a request,
 * and whether the answer sends the browser on to HTTPS, decides what the run can observe there.
 */
describe('plain http probe', () => {
    it('reads the status and the redirect the proxy answers a plain request with', async () => {
        const proxy = createHttpServer((request, response) => {
            if (request.url === 'http://moved.interception.test/') {
                response.writeHead(301, { location: 'https://moved.interception.test/' }).end();
                return;
            }
            response.end('ok');
        });
        await new Promise<void>((listening) =>
            proxy.listen({ host: '127.0.0.1', port: 0 }, listening),
        );
        const address = proxy.address();
        if (typeof address !== 'object' || address === null) {
            throw new Error('no proxy address');
        }
        const proxyUrl = `http://127.0.0.1:${address.port}/`;
        try {
            expect(await probePlainHttp(proxyUrl, 'http://plain.interception.test/')).toEqual({
                statusCode: 200,
                location: null,
                failure: null,
            });
            expect(await probePlainHttp(proxyUrl, 'http://moved.interception.test/')).toEqual({
                statusCode: 301,
                location: 'https://moved.interception.test/',
                failure: null,
            });
        } finally {
            proxy.closeAllConnections();
            proxy.close();
        }
    }, 30_000);

    it('is answered by a site that drops clients other than browsers', async () => {
        const proxy = createHttpServer((request, response) => {
            if (
                request.headers['user-agent']?.startsWith('Mozilla/5.0') === true &&
                request.headers.accept?.includes('text/html') === true
            ) {
                response.end('ok');
            }
        });
        await new Promise<void>((listening) =>
            proxy.listen({ host: '127.0.0.1', port: 0 }, listening),
        );
        const address = proxy.address();
        if (typeof address !== 'object' || address === null) {
            throw new Error('no proxy address');
        }
        try {
            const answer = await probePlainHttp(
                `http://127.0.0.1:${address.port}/`,
                'http://plain.interception.test/',
                1_000,
            );

            expect(answer.statusCode).toBe(200);
        } finally {
            proxy.closeAllConnections();
            proxy.close();
        }
    }, 30_000);

    it('reports an unreachable proxy as no answer rather than throwing', async () => {
        const answer = await probePlainHttp(
            'http://127.0.0.1:1/',
            'http://plain.interception.test/',
        );

        expect(answer.statusCode).toBeNull();
        expect(answer.failure).not.toBeNull();
    }, 30_000);
});
