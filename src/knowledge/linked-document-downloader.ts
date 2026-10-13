import { createHash } from 'node:crypto';
import { reduceHtmlToText } from './html-document-text';

/**
 * Host serving GitHub's rendered web pages, including the HTML view of a repository wiki.
 */
const GITHUB_WEB_HOST = 'github.com';

/**
 * Host serving raw repository and wiki content; a wiki is its own git repository there.
 */
const GITHUB_RAW_HOST = 'raw.githubusercontent.com';

/**
 * Path segment marking a repository's wiki on the web host: `/<owner>/<repo>/wiki/<Page>`.
 */
const GITHUB_WIKI_PATH_SEGMENT = 'wiki';

/**
 * Path segment marking a repository file's rendered view on the web host:
 * `/<owner>/<repo>/blob/<ref>/<path>`.
 */
const GITHUB_BLOB_PATH_SEGMENT = 'blob';

/**
 * Extension of a wiki page's source file in the wiki's own git repository.
 */
const GITHUB_WIKI_SOURCE_EXTENSION = '.md';

/**
 * Media type of a document that arrived as markup rather than as prose.
 */
const HTML_MEDIA_TYPE = 'text/html';

/**
 * Rewrite a GitHub web page URL onto the raw source it renders.
 *
 * A guidance link naming `github.com/<owner>/<repo>/wiki/<Page>` or
 * `github.com/<owner>/<repo>/blob/<ref>/<path>` answers with the rendered page, and storing that
 * gave `lookup_rule_guidance` the page's `<head>` instead of the syntax reference. Both views have
 * a raw source: a wiki is a git repository of its own, served at
 * `raw.githubusercontent.com/wiki/<owner>/<repo>/<Page>.md`, and a repository file is served at
 * `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>` — the exact text the instruction means to
 * cite. Every other URL comes back unchanged: these are two rewrites for one known host, not a URL
 * guessing scheme.
 *
 * @param url - The URL an instruction link names.
 * @returns The URL to fetch instead, or the same URL when no rewrite applies.
 */
export function linkedDocumentFetchUrl(url: string): string {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return url;
    }
    if (parsed.hostname !== GITHUB_WEB_HOST) {
        return url;
    }
    const [owner, repository, view, ...rest] = parsed.pathname.split('/').filter(Boolean);
    if (owner === undefined || repository === undefined) {
        return url;
    }
    if (view === GITHUB_WIKI_PATH_SEGMENT && rest.length === 1) {
        const pageName = rest[0]!;
        if (pageName.endsWith(GITHUB_WIKI_SOURCE_EXTENSION)) {
            return url;
        }
        return (
            `https://${GITHUB_RAW_HOST}/${GITHUB_WIKI_PATH_SEGMENT}/${owner}/${repository}/` +
            `${pageName}${GITHUB_WIKI_SOURCE_EXTENSION}`
        );
    }
    if (view === GITHUB_BLOB_PATH_SEGMENT && rest.length >= 2) {
        return `https://${GITHUB_RAW_HOST}/${owner}/${repository}/${rest.join('/')}`;
    }
    return url;
}

/**
 * Whether a response declares itself as HTML.
 *
 * @param response - The fetched response.
 * @returns True when the declared media type is `text/html`.
 */
function declaresHtml(response: Response): boolean {
    return (response.headers.get('content-type') ?? '').toLowerCase().includes(HTML_MEDIA_TYPE);
}

/**
 * Hard deadline for one linked-document download.
 *
 * One-shot run-start fetch: the loader downloads each linked instruction document once at the start
 * of a run, with no cache and no retry convention anywhere upstream. A machine that has not
 * answered in 30s forfeits the run as a typed unreachable-link failure instead of stretching the
 * startup phase.
 */
export const LINKED_DOCUMENT_TIMEOUT_MS = 30_000;

/**
 * Largest accepted linked document.
 *
 * Far above any syntax, policy or contributing wiki page, so the cap rejects binary floods and
 * scraped archives — never truncating a real document: over the cap is a typed failure, not a
 * shorter document.
 */
export const MAX_LINKED_DOCUMENT_BYTES = 2 * 1024 * 1024;

/**
 * Stable failure classes of the linked-document downloader.
 */
export const LinkedDocumentDownloadFailureCode = {
    /**
     * The URL could not be fetched: rejected, timed out, answered non-2xx, or does not parse.
     */
    DocumentUnavailable: 'document_unavailable',

    /**
     * The body exceeds {@link MAX_LINKED_DOCUMENT_BYTES}.
     */
    DocumentTooLarge: 'document_too_large',

    /**
     * The body carries no usable text.
     */
    DocumentEmpty: 'document_empty',

    /**
     * The URL is not an http(s) resource (or does not parse at all).
     */
    DocumentSchemeUnsupported: 'document_scheme_unsupported',

    /**
     * The URL embeds credentials; they must never reach a fetch or a log line.
     */
    DocumentCredential: 'document_credential',
} as const;

/**
 * LinkedDocumentDownloadFailureCode value.
 */
export type LinkedDocumentDownloadFailureCode =
    (typeof LinkedDocumentDownloadFailureCode)[keyof typeof LinkedDocumentDownloadFailureCode];

/**
 * Replace any userinfo section of a URL string with a marker so the failure text identifies the
 * resource without echoing its embedded credentials.
 *
 * @param url - Raw URL string as supplied by the caller.
 * @returns The same URL with `user:password` collapsed into a redaction marker.
 */
function redactUrlCredentials(url: string): string {
    return url.replace(/\/\/[^/@\s]+@/u, '//[redacted]@');
}

/**
 * Stable, URL-naming downloader failure.
 *
 * The message always names the requested URL — with any userinfo redacted — so a failed run start
 * is diagnosable from the error alone while embedded secrets stay out of logs and artifacts.
 */
export class LinkedDocumentDownloadError extends Error {
    /**
     * Stable public failure classification.
     */
    readonly code: LinkedDocumentDownloadFailureCode;

    /**
     * Requested URL, redacted of any embedded userinfo.
     */
    readonly url: string;

    /**
     * Concrete cause observed (status, timeout, scheme, byte cap).
     */
    readonly detail: string;

    /**
     * Underlying error observed at fetch time, when one exists.
     */
    override readonly cause?: unknown;

    /**
     * Create one URL-naming download failure.
     *
     * @param code - Stable public failure classification.
     * @param url - Requested URL; redacted before it reaches the message.
     * @param detail - Concrete cause observed (status, timeout, scheme, byte cap).
     * @param cause - Underlying error, when one exists.
     */
    constructor(
        code: LinkedDocumentDownloadFailureCode,
        url: string,
        detail: string,
        cause?: unknown,
    ) {
        super(
            `Linked document download failed (${code}) for ` +
                `${redactUrlCredentials(url)}: ${detail}.`,
        );
        this.name = 'LinkedDocumentDownloadError';
        this.code = code;
        this.url = url;
        this.detail = detail;
        this.cause = cause;
    }
}

/**
 * One downloaded remote document offered as this run's rule-guidance text.
 */
export interface DownloadedLinkedDocument {
    /**
     * Exact requested URL, unmodified.
     */
    url: string;

    /**
     * URL actually retrieved: the requested one, or the raw source a known rewrite points at
     * ({@link linkedDocumentFetchUrl}). Recorded so a run's evidence names what it really read.
     */
    fetchedUrl: string;

    /**
     * Readable text of the body: the bytes as sent for a prose document, the reduced text for one
     * that arrived as HTML.
     */
    content: string;

    /**
     * SHA-256 over the exact response bytes, so a run can state what it served.
     *
     * Over the bytes, not over the reduced text: the digest identifies the upstream document, and a
     * change in how markup is reduced must not look like a change in the document.
     */
    sha256: string;
}

/**
 * Fetch one linked document within the declared size and time bounds.
 *
 * The whole body must arrive as usable text inside one request: over the byte cap or empty is a
 * typed failure, never a truncated or padded document — the instruction documents are read "as they
 * are", so any silent rewrite would corrupt the exact text the run cites.
 *
 * Two transformations do apply, and both exist because the alternative is no guidance at all. A
 * GitHub wiki page or file view is fetched as its raw source ({@link linkedDocumentFetchUrl}), and
 * a document that answers with `text/html` is reduced to its readable text before it is stored: a
 * stored HTML page reached `lookup_rule_guidance` as the page's `<head>`.
 *
 * @param url - Http(s) URL of the document to fetch.
 * @param fetchImpl - Injectable fetch for deterministic tests; production uses global fetch.
 * @returns The readable body text, the URL really retrieved, and the SHA-256 of the exact bytes.
 * @throws {LinkedDocumentDownloadError} With a stable code naming the URL for every failure class.
 */
export async function downloadLinkedDocument(
    url: string,
    fetchImpl: typeof fetch = fetch,
): Promise<DownloadedLinkedDocument> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new LinkedDocumentDownloadError(
            LinkedDocumentDownloadFailureCode.DocumentSchemeUnsupported,
            url,
            'URL cannot be parsed',
        );
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new LinkedDocumentDownloadError(
            LinkedDocumentDownloadFailureCode.DocumentSchemeUnsupported,
            url,
            `unsupported protocol ${parsed.protocol}; only http(s) documents are fetched`,
        );
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
        throw new LinkedDocumentDownloadError(
            LinkedDocumentDownloadFailureCode.DocumentCredential,
            url,
            'URL embeds credentials; they are never fetched or stored',
        );
    }

    const fetchedUrl = linkedDocumentFetchUrl(url);
    let response: Response;
    try {
        response = await fetchImpl(fetchedUrl, {
            signal: AbortSignal.timeout(LINKED_DOCUMENT_TIMEOUT_MS),
            redirect: 'follow',
        });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new LinkedDocumentDownloadError(
            LinkedDocumentDownloadFailureCode.DocumentUnavailable,
            url,
            `fetch of ${redactUrlCredentials(fetchedUrl)} failed: ${detail}`,
            error,
        );
    }
    if (!response.ok) {
        throw new LinkedDocumentDownloadError(
            LinkedDocumentDownloadFailureCode.DocumentUnavailable,
            url,
            `unexpected HTTP status ${response.status}`,
        );
    }

    const declaredLength = response.headers.get('content-length');
    const declaredBytes = declaredLength === null ? 0 : Number(declaredLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_LINKED_DOCUMENT_BYTES) {
        throw new LinkedDocumentDownloadError(
            LinkedDocumentDownloadFailureCode.DocumentTooLarge,
            url,
            `declared content-length ${declaredLength} exceeds the ` +
                `${MAX_LINKED_DOCUMENT_BYTES}-byte cap`,
        );
    }

    let bytes: Uint8Array;
    try {
        bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new LinkedDocumentDownloadError(
            LinkedDocumentDownloadFailureCode.DocumentUnavailable,
            url,
            `body could not be read: ${detail}`,
            error,
        );
    }
    if (bytes.byteLength > MAX_LINKED_DOCUMENT_BYTES) {
        throw new LinkedDocumentDownloadError(
            LinkedDocumentDownloadFailureCode.DocumentTooLarge,
            url,
            `body is ${bytes.byteLength} bytes, above the ${MAX_LINKED_DOCUMENT_BYTES}-byte cap`,
        );
    }
    const decoded = new TextDecoder('utf-8').decode(bytes);
    const content = declaresHtml(response) ? reduceHtmlToText(decoded) : decoded;
    if (content.trim().length === 0) {
        throw new LinkedDocumentDownloadError(
            LinkedDocumentDownloadFailureCode.DocumentEmpty,
            url,
            declaresHtml(response)
                ? 'the HTML body carries no readable text outside its markup'
                : 'body carries no usable text',
        );
    }

    return {
        url,
        fetchedUrl,
        content,
        sha256: createHash('sha256').update(bytes).digest('hex'),
    };
}
