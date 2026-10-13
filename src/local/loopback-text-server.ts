import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * Address the server binds. The documents are fetched by the browser this run drives on the same
 * machine, so nothing outside the host ever needs to reach them, and binding the loopback address
 * alone keeps them off every other interface.
 */
const LOOPBACK_HOST = '127.0.0.1';

/**
 * Shape of a document name: one URL path segment made of characters that need no percent-encoding,
 * so the URL `publish` returns is byte for byte the request path the browser sends back and the
 * lookup is an exact string match.
 */
const DOCUMENT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Media type every response carries. The pinned extension's custom-filter loader accepts
 * text/plain, text/html or application/octet-stream; the documents are filter text, so text/plain
 * is the honest one, and the charset states how the bytes were produced.
 */
const DOCUMENT_CONTENT_TYPE = 'text/plain; charset=utf-8';

/**
 * Cache directive on every response. A republished document must be re-read from the server the
 * next time the extension fetches its URL, never from a browser cache.
 */
const CACHE_CONTROL = 'no-store';

/**
 * The one method the server answers; everything else is refused with an Allow header naming it.
 */
const ALLOWED_METHOD = 'GET';

/**
 * A run-owned HTTP server on the loopback interface that serves a few named text documents.
 */
export interface LoopbackTextServer {
    /**
     * Port the kernel assigned to the server.
     */
    readonly port: number;
    /**
     * Store a document under `/<name>`, replacing an earlier document published under the same
     * name.
     *
     * @param name - Path segment matching `[A-Za-z0-9._-]+`; anything else throws.
     * @param text - Document body, served as UTF-8.
     * @returns Absolute http URL the document is served at.
     */
    publish(name: string, text: string): string;
    /**
     * Stop accepting connections, drop the open ones and resolve once the server is closed. A
     * second call resolves with the first.
     *
     * @returns Resolves when the server no longer listens.
     */
    close(): Promise<void>;
}

/**
 * Write one text response with the headers every answer carries.
 *
 * @param response - Response to write and end.
 * @param status - HTTP status.
 * @param body - Body bytes, or text encoded as UTF-8.
 * @param headers - Extra headers for this answer.
 */
function respond(
    response: ServerResponse,
    status: number,
    body: Buffer | string,
    headers: Record<string, string> = {},
): void {
    const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    response.writeHead(status, {
        'Content-Type': DOCUMENT_CONTENT_TYPE,
        'Cache-Control': CACHE_CONTROL,
        'Content-Length': bytes.byteLength,
        ...headers,
    });
    response.end(bytes);
}

/**
 * Answer one request: the published document at its exact path, or a refusal.
 *
 * @param documents - Published documents keyed by request path.
 * @param request - Incoming request.
 * @param response - Response to write.
 */
function serveDocument(
    documents: ReadonlyMap<string, Buffer>,
    request: IncomingMessage,
    response: ServerResponse,
): void {
    const path = request.url ?? '';
    if (request.method !== ALLOWED_METHOD) {
        respond(
            response,
            405,
            `method ${request.method} is not allowed here; ${ALLOWED_METHOD} is`,
            {
                Allow: ALLOWED_METHOD,
            },
        );
        return;
    }
    const body = documents.get(path);
    if (body === undefined) {
        respond(response, 404, `no document is published at ${path}`);
        return;
    }
    respond(response, 200, body);
}

/**
 * Bind the server to a kernel-chosen loopback port.
 *
 * @param server - Server to bind.
 * @returns Port the kernel assigned.
 */
async function listenOnLoopback(server: Server): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
        const onListenError = (error: Error): void => {
            reject(
                new Error(`loopback text server failed to listen on ${LOOPBACK_HOST}`, {
                    cause: error,
                }),
            );
        };
        server.once('error', onListenError);
        server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
            server.off('error', onListenError);
            const address = server.address();
            if (address === null || typeof address === 'string') {
                server.close();
                reject(
                    new Error(
                        `loopback text server bound a non-TCP address: ${JSON.stringify(address)}`,
                    ),
                );
                return;
            }
            resolve(address.port);
        });
    });
}

/**
 * Close a listening server. Open connections are destroyed rather than waited out: the server is
 * closed when the run releases its host state, and a browser's idle keep-alive socket must not hold
 * that up.
 *
 * @param server - Listening server.
 * @returns Resolves once the server has stopped listening.
 */
async function closeServer(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error === undefined) {
                resolve();
                return;
            }
            reject(error);
        });
        server.closeAllConnections();
    });
}

/**
 * Start a loopback text server on a kernel-chosen port.
 *
 * @returns The listening server.
 */
export async function createLoopbackTextServer(): Promise<LoopbackTextServer> {
    const documents = new Map<string, Buffer>();
    const server = createServer((request, response) => {
        serveDocument(documents, request, response);
    });
    const port = await listenOnLoopback(server);
    let closing: Promise<void> | null = null;
    return {
        port,
        publish(name, text) {
            if (!DOCUMENT_NAME_PATTERN.test(name)) {
                throw new Error(
                    `loopback text server: document name ${JSON.stringify(name)} does not match ` +
                        `${DOCUMENT_NAME_PATTERN.source}`,
                );
            }
            documents.set(`/${name}`, Buffer.from(text, 'utf8'));
            return `http://${LOOPBACK_HOST}:${port}/${name}`;
        },
        close() {
            closing ??= closeServer(server);
            return closing;
        },
    };
}
