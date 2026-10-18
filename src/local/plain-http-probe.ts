/**
 * The plain HTTP counterpart of the HTTPS probe: one request for an `http:` target through the
 * proxy, the way a browser asks a proxy for a site served without TLS.
 */
import { connect as connectTcp } from 'node:net';
import {
    CHROMIUM_NAVIGATION_ACCEPT,
    DESKTOP_CHROMIUM_USER_AGENT,
} from '../browser/browser-identity';
import { HTTP_STATUS_LINE, PROBE_STEP_TIMEOUT_MS } from './tls-interception-diagnostic';

/**
 * Bytes read while waiting for the end of a plain HTTP response's headers.
 */
const MAXIMUM_RESPONSE_HEAD_BYTES = 64 * 1024;

/**
 * The `Location` header of a response head.
 */
const LOCATION_HEADER = /^location:\s*(.+?)\s*$/imu;

/**
 * What one plain HTTP request through the proxy got back.
 */
export interface PlainHttpAnswer {
    /**
     * Status code of the answer, or null when the proxy did not answer.
     */
    statusCode: number | null;

    /**
     * Where the answer redirects to, or null when it carries no `Location`.
     */
    location: string | null;

    /**
     * Native failure text when no answer came.
     */
    failure: string | null;
}

/**
 * Send one plain HTTP request for an `http:` target through the proxy, the way the browser asks a
 * proxy for a site served without TLS, and read the head of the answer.
 *
 * @param proxyUrl - Canonical loopback proxy URL the route exposes.
 * @param targetUrl - The `http:` target to request.
 * @param timeoutMs - Deadline for the connection and the answer.
 * @returns The answer's status and redirect, or the failure.
 */
export async function probePlainHttp(
    proxyUrl: string,
    targetUrl: string,
    timeoutMs: number = PROBE_STEP_TIMEOUT_MS,
): Promise<PlainHttpAnswer> {
    const proxy = new URL(proxyUrl);
    const target = new URL(targetUrl);
    const socket = connectTcp({ host: proxy.hostname, port: Number(proxy.port) });
    try {
        return await new Promise<PlainHttpAnswer>((resolve) => {
            let received = '';
            let settled = false;
            const settle = (answer: PlainHttpAnswer): void => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve(answer);
                }
            };
            const failed = (failure: string): void => {
                settle({ statusCode: null, location: null, failure });
            };
            const timer = setTimeout(() => failed('response_timeout'), timeoutMs);
            socket.on('error', (error: Error) => failed(error.message));
            socket.on('close', () => failed('response_closed'));
            socket.on('connect', () => {
                socket.write(
                    `GET ${target.origin}${target.pathname}${target.search} HTTP/1.1\r\n` +
                        `Host: ${target.host}\r\nUser-Agent: ${DESKTOP_CHROMIUM_USER_AGENT}\r\n` +
                        `Accept: ${CHROMIUM_NAVIGATION_ACCEPT}\r\nConnection: close\r\n\r\n`,
                );
            });
            socket.on('data', (chunk: Buffer) => {
                received += chunk.toString('latin1');
                const headEnd = received.indexOf('\r\n\r\n');
                if (headEnd === -1) {
                    if (received.length > MAXIMUM_RESPONSE_HEAD_BYTES) {
                        failed('response_head_too_large');
                    }
                    return;
                }
                const head = received.slice(0, headEnd);
                const status = HTTP_STATUS_LINE.exec(head);
                if (status === null) {
                    failed(`response_not_http: ${head.slice(0, head.indexOf('\r\n'))}`);
                    return;
                }
                settle({
                    statusCode: Number(status[1]),
                    location: LOCATION_HEADER.exec(head)?.[1] ?? null,
                    failure: null,
                });
            });
        });
    } finally {
        socket.destroy();
    }
}
