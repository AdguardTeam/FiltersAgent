import { afterEach, describe, expect, it } from 'vitest';
import {
    createLoopbackTextServer,
    type LoopbackTextServer,
} from '../../src/local/loopback-text-server';

describe('loopback text server', () => {
    let server: LoopbackTextServer | null = null;

    afterEach(async () => {
        await server?.close();
        server = null;
    });

    /*
     * The contract: the pinned MV3 extension downloads a custom filter with fetch from an http URL
     * and accepts a 200 text/plain body as the filter text. Every document a run publishes is
     * served that way, byte for byte, at the URL publish returned and nowhere else.
     */
    it('serves published documents byte for byte and nothing else', async () => {
        server = await createLoopbackTextServer();
        const ascii = '! Title: slice\nexample.com##.ad\n';
        const unicode = '! Заголовок: срез\n||пример.рф^\n';

        const asciiUrl = server.publish('slice-1.txt', ascii);
        const unicodeUrl = server.publish('slice_2', unicode);
        expect(asciiUrl).toBe(`http://127.0.0.1:${server.port}/slice-1.txt`);

        const asciiResponse = await fetch(asciiUrl);
        expect(asciiResponse.status).toBe(200);
        expect(asciiResponse.headers.get('content-type')).toBe('text/plain; charset=utf-8');
        expect(asciiResponse.headers.get('cache-control')).toBe('no-store');
        expect(await asciiResponse.text()).toBe(ascii);

        const unicodeResponse = await fetch(unicodeUrl);
        expect(unicodeResponse.status).toBe(200);
        expect(new Uint8Array(await unicodeResponse.arrayBuffer())).toEqual(
            new TextEncoder().encode(unicode),
        );

        server.publish('slice_2', 'replaced\n');
        const replaced = await fetch(unicodeUrl);
        expect(replaced.status).toBe(200);
        expect(await replaced.text()).toBe('replaced\n');

        const missing = await fetch(`http://127.0.0.1:${server.port}/absent`);
        expect(missing.status).toBe(404);

        const post = await fetch(asciiUrl, { method: 'POST', body: 'ignored' });
        expect(post.status).toBe(405);

        expect(() => server?.publish('../escape', 'text')).toThrow();
        expect(() => server?.publish('', 'text')).toThrow();
    });

    it('refuses connections once closed and tolerates a second close', async () => {
        server = await createLoopbackTextServer();
        const url = server.publish('doc', 'text\n');
        expect((await fetch(url)).status).toBe(200);

        await server.close();
        await server.close();

        await expect(fetch(url)).rejects.toThrow();
    });
});
