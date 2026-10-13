import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
    LinkedDocumentDownloadError,
    LinkedDocumentDownloadFailureCode,
    MAX_LINKED_DOCUMENT_BYTES,
    downloadLinkedDocument,
    linkedDocumentFetchUrl,
} from '../../src/knowledge/linked-document-downloader';

const DOCUMENT_URL = 'https://example.test/docs/syntax.md';
const DOCUMENT_BODY = '## Syntax\n\nWrite element hiding rules as `##selector`.\n';

function stubFetch(
    body: string,
    headers: Record<string, string> = {},
): { fetchImpl: typeof fetch; urls: string[] } {
    const urls: string[] = [];
    const fetchImpl = (async (input: unknown) => {
        urls.push(typeof input === 'string' ? input : String(input));
        return new Response(body, { status: 200, statusText: 'OK', headers });
    }) as typeof fetch;
    return { fetchImpl, urls };
}

describe('downloadLinkedDocument', () => {
    it('returns the exact body and its sha256 digest', async () => {
        const { fetchImpl, urls } = stubFetch(DOCUMENT_BODY);
        const expectedDigest = createHash('sha256').update(DOCUMENT_BODY, 'utf8').digest('hex');

        const document = await downloadLinkedDocument(DOCUMENT_URL, fetchImpl);

        expect(urls).toEqual([DOCUMENT_URL]);
        expect(document.url).toBe(DOCUMENT_URL);
        expect(document.content).toBe(DOCUMENT_BODY);
        expect(document.sha256).toBe(expectedDigest);
    });

    it('fails naming the URL on a non-2xx response', async () => {
        const fetchImpl = (async () =>
            new Response('moved', {
                status: 503,
                statusText: 'Service Unavailable',
            })) as typeof fetch;

        const failure = await downloadLinkedDocument(DOCUMENT_URL, fetchImpl).catch(
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(LinkedDocumentDownloadError);
        expect((failure as LinkedDocumentDownloadError).code).toBe(
            LinkedDocumentDownloadFailureCode.DocumentUnavailable,
        );
        expect((failure as Error).message).toContain(DOCUMENT_URL);
    });

    it('fails naming the URL when the fetch rejects, including a timeout', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new DOMException('The operation was aborted.', 'TimeoutError');
        }) as unknown as typeof fetch;

        const failure = await downloadLinkedDocument(DOCUMENT_URL, fetchImpl).catch(
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(LinkedDocumentDownloadError);
        expect((failure as LinkedDocumentDownloadError).code).toBe(
            LinkedDocumentDownloadFailureCode.DocumentUnavailable,
        );
        expect((failure as Error).message).toContain(DOCUMENT_URL);
    });

    it('refuses a body larger than the byte cap without returning truncated content', async () => {
        const { fetchImpl } = stubFetch('x'.repeat(MAX_LINKED_DOCUMENT_BYTES + 1));

        const failure = await downloadLinkedDocument(DOCUMENT_URL, fetchImpl).catch(
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(LinkedDocumentDownloadError);
        expect((failure as LinkedDocumentDownloadError).code).toBe(
            LinkedDocumentDownloadFailureCode.DocumentTooLarge,
        );
        expect((failure as Error).message).toContain(DOCUMENT_URL);
    });

    it('refuses a declared content-length beyond the byte cap before reading it', async () => {
        const fetchImpl = (async () =>
            new Response('tiny', {
                status: 200,
                headers: { 'content-length': String(MAX_LINKED_DOCUMENT_BYTES + 1) },
            })) as typeof fetch;

        const failure = await downloadLinkedDocument(DOCUMENT_URL, fetchImpl).catch(
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(LinkedDocumentDownloadError);
        expect((failure as LinkedDocumentDownloadError).code).toBe(
            LinkedDocumentDownloadFailureCode.DocumentTooLarge,
        );
    });

    it('refuses an empty body', async () => {
        const { fetchImpl } = stubFetch('   \n');

        const failure = await downloadLinkedDocument(DOCUMENT_URL, fetchImpl).catch(
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(LinkedDocumentDownloadError);
        expect((failure as LinkedDocumentDownloadError).code).toBe(
            LinkedDocumentDownloadFailureCode.DocumentEmpty,
        );
        expect((failure as Error).message).toContain(DOCUMENT_URL);
    });

    it('refuses a non-http(s) URL naming it, before any network call', async () => {
        const fetchImpl = vi.fn() as unknown as typeof fetch;

        const failure = await downloadLinkedDocument('file:///etc/hosts', fetchImpl).catch(
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(LinkedDocumentDownloadError);
        expect((failure as LinkedDocumentDownloadError).code).toBe(
            LinkedDocumentDownloadFailureCode.DocumentSchemeUnsupported,
        );
        expect((failure as Error).message).toContain('/etc/hosts');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('refuses a URL that cannot be parsed', async () => {
        const fetchImpl = vi.fn() as unknown as typeof fetch;

        const failure = await downloadLinkedDocument('not a url', fetchImpl).catch(
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(LinkedDocumentDownloadError);
        expect((failure as LinkedDocumentDownloadError).code).toBe(
            LinkedDocumentDownloadFailureCode.DocumentSchemeUnsupported,
        );
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('refuses a credential-embedded URL without echoing the secret', async () => {
        const fetchImpl = vi.fn() as unknown as typeof fetch;

        const failure = await downloadLinkedDocument(
            'https://user:topsecret@example.test/docs/policy.md',
            fetchImpl,
        ).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(LinkedDocumentDownloadError);
        expect((failure as LinkedDocumentDownloadError).code).toBe(
            LinkedDocumentDownloadFailureCode.DocumentCredential,
        );
        const message = (failure as Error).message;
        expect(message).toContain('example.test/docs/policy.md');
        expect(message).not.toContain('topsecret');
        expect(String((failure as Error).name)).toBe('LinkedDocumentDownloadError');
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('a guidance link that answers with markup', () => {
    it('fetches a GitHub wiki page as its raw Markdown source', async () => {
        const wikiPage = 'https://github.com/gorhill/uBlock/wiki/Static-filter-syntax';
        const { fetchImpl, urls } = stubFetch(DOCUMENT_BODY);

        const document = await downloadLinkedDocument(wikiPage, fetchImpl);

        expect(urls).toEqual([
            'https://raw.githubusercontent.com/wiki/gorhill/uBlock/Static-filter-syntax.md',
        ]);
        // The document still identifies itself by the URL the instruction named.
        expect(document.url).toBe(wikiPage);
        expect(document.fetchedUrl).toBe(urls[0]);
        expect(document.content).toBe(DOCUMENT_BODY);
    });

    it('fetches a GitHub file view as its raw source', async () => {
        const fileView = 'https://github.com/uBlockOrigin/uAssets/blob/master/CONTRIBUTING.md';
        const { fetchImpl, urls } = stubFetch(DOCUMENT_BODY);

        const document = await downloadLinkedDocument(fileView, fetchImpl);

        expect(urls).toEqual([
            'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/CONTRIBUTING.md',
        ]);
        expect(document.url).toBe(fileView);
        expect(document.fetchedUrl).toBe(urls[0]);
        expect(document.content).toBe(DOCUMENT_BODY);
        // A nested path keeps its directories; a section fragment names a place in the rendered
        // page and has no raw counterpart.
        expect(
            linkedDocumentFetchUrl('https://github.com/o/r/blob/main/docs/policy.md#ordering'),
        ).toBe('https://raw.githubusercontent.com/o/r/main/docs/policy.md');
    });

    it('leaves a URL that is neither a GitHub wiki page nor a file view alone', () => {
        for (const url of [
            DOCUMENT_URL,
            'https://github.com/gorhill/uBlock/blob/master',
            'https://github.com/gorhill/uBlock/tree/master/docs',
            'https://example.test/wiki/Static-filter-syntax',
            'https://github.com/gorhill/uBlock/wiki',
            'https://github.com/gorhill/uBlock/wiki/Static-filter-syntax.md',
        ]) {
            expect(linkedDocumentFetchUrl(url)).toBe(url);
        }
    });

    it('stores an HTML document as readable text without its markup', async () => {
        const html = [
            '<!doctype html>',
            '<html><head><meta name="viewport" content="width=device-width">',
            '<script>window.x = 1;</script><style>.a{color:red}</style>',
            '<title>Static filter syntax</title></head>',
            '<body><h1>Static filter syntax</h1>',
            '<p>Write <code>example.com##.ad</code> to hide an element.</p>',
            '<ul><li>A &amp; B</li><li>3 &lt; 4</li></ul>',
            '</body></html>',
        ].join('\n');
        const { fetchImpl } = stubFetch(html, { 'content-type': 'text/html; charset=utf-8' });

        const document = await downloadLinkedDocument(DOCUMENT_URL, fetchImpl);

        expect(document.content).toContain('Static filter syntax');
        expect(document.content).toContain('example.com##.ad');
        expect(document.content).toContain('A & B');
        expect(document.content).toContain('3 < 4');
        // Nothing the reader cannot use: no tags left, and none of the head's machine content.
        // A bare `<` from a decoded entity is prose (`3 < 4`); only `<name` opens a tag.
        expect(document.content).not.toMatch(/<\/?[A-Za-z]/u);
        expect(document.content).not.toContain('window.x');
        expect(document.content).not.toContain('color:red');
        expect(document.content).not.toContain('width=device-width');
    });

    it('fails typed when an HTML document carries no readable text at all', async () => {
        const { fetchImpl } = stubFetch(
            '<html><head><script>1</script></head><body></body></html>',
            {
                'content-type': 'text/html',
            },
        );

        const failure = await downloadLinkedDocument(DOCUMENT_URL, fetchImpl).catch(
            (error: unknown) => error,
        );

        expect((failure as LinkedDocumentDownloadError).code).toBe(
            LinkedDocumentDownloadFailureCode.DocumentEmpty,
        );
    });
});
