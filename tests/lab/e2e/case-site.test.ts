import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { probeSiteReachability, reportedSiteUrl } from '../../../lab/e2e/case-site';
import type { RawIssue } from '../../../src/github/fetch-issue';

const servers: Server[] = [];

afterEach(async () => {
    await Promise.all(
        servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
});

function issueWith(body: string): RawIssue {
    return {
        number: 1,
        url: 'https://github.com/example-owner/example-repo/issues/1',
        title: 'example.org',
        body,
        state: 'closed',
        labels: [],
        assignee: null,
        comments: [],
    };
}

async function listen(
    status: number,
    handle: Parameters<typeof createServer>[1] = (_request, response) => {
        response.writeHead(status).end('challenge');
    },
): Promise<string> {
    const server = createServer(handle);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

describe('reportedSiteUrl', () => {
    it('reads the link text, not the anonymizing redirect, with escaped separators decoded', () => {
        const body =
            '### Issue URL (Ads)\n' +
            '[https://www.example.org/compare.php?a=1&amp;b=2](https://adguardteam.github.io/' +
            'AnonymousRedirect/redirect.html?url=https%3A%2F%2Fwww.example.org%2F)\n';
        expect(reportedSiteUrl(issueWith(body))).toBe(
            'https://www.example.org/compare.php?a=1&b=2',
        );
    });

    it('reads a bare URL under the heading', () => {
        expect(
            reportedSiteUrl(issueWith('### Issue URL (Ads)\n\nhttps://example.org/page\n')),
        ).toBe('https://example.org/page');
    });

    it.each([
        ['no section', '### Comment\nAds everywhere.'],
        ['a heading without the problem type', '### Issue URL\nhttps://example.org/'],
        ['a value that is not a URL', '### Issue URL (Ads)\nexample dot org'],
        ['a value that is not http(s)', '### Issue URL (Ads)\nftp://example.org/'],
    ])('refuses a report with %s', (_name, body) => {
        expect(() => reportedSiteUrl(issueWith(body))).toThrow(/Issue URL/u);
    });
});

describe('probeSiteReachability', () => {
    it.each([200, 403, 503])('counts an HTTP %s response as reachable', async (status) => {
        expect(await probeSiteReachability(await listen(status))).toEqual({
            reachable: true,
            answer: `HTTP ${status}`,
        });
    });

    it('counts a redirect a client without cookies would loop on as reachable', async () => {
        // A consent redirect sets a cookie and sends the client back to itself; a browser returns
        // with the cookie, a plain request never does.
        const url = await listen(302, (_request, response) => {
            response.writeHead(302, { location: '/', 'set-cookie': 'consent=1' }).end();
        });

        expect(await probeSiteReachability(url)).toEqual({ reachable: true, answer: 'HTTP 302' });
    });

    it.each([
        [
            'accepts the connection and drops it',
            ((request) => {
                request.socket.destroy();
            }) as Parameters<typeof createServer>[1],
            /UND_ERR_SOCKET/u,
        ],
        [
            // Chromium loads a page whose headers pass undici's 16 KiB limit.
            'answers with headers undici refuses to parse',
            ((_request, response) => {
                response.writeHead(200, { 'x-padding': 'a'.repeat(20_000) }).end();
            }) as Parameters<typeof createServer>[1],
            /HEADERS_OVERFLOW/u,
        ],
    ])('counts a host that %s as reachable, recording why', async (_name, handle, answer) => {
        const url = await listen(200, handle);

        expect(await probeSiteReachability(url)).toEqual({
            reachable: true,
            answer: expect.stringMatching(answer),
        });
    });

    it('reports a refused connection as unreachable with its network cause', async () => {
        const url = await listen(200);
        await new Promise((resolve) => servers.pop()!.close(resolve));

        expect(await probeSiteReachability(url)).toEqual({
            reachable: false,
            answer: expect.stringMatching(/ECONNREFUSED/u),
        });
    });
});
