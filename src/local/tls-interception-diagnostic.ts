import { createHash, X509Certificate } from 'node:crypto';
import { connect as connectTcp, type Socket } from 'node:net';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import {
    CHROMIUM_NAVIGATION_ACCEPT,
    DESKTOP_CHROMIUM_USER_AGENT,
} from '../browser/browser-identity';

/**
 * Deadline for each step of a probe: the connection, the handshake, and the answer.
 */
export const PROBE_STEP_TIMEOUT_MS = 8_000;
const MAXIMUM_CHAIN_LENGTH = 16;
const MAXIMUM_HANDSHAKE_BYTES = 256 * 1024;

/**
 * Bytes read while waiting for the response status line. A status line is a few dozen bytes; a peer
 * that sends more without one is not answering HTTP.
 */
const MAXIMUM_STATUS_LINE_BYTES = 8 * 1024;

/**
 * Port an `https:` target without an explicit port is served on.
 */
const HTTPS_DEFAULT_PORT = 443;

/**
 * The HTTP/1.x response status line and its status code.
 */
export const HTTP_STATUS_LINE = /^HTTP\/1\.[01] (\d{3})\b/u;

/**
 * How far one HTTPS request through the interception proxy got.
 */
export const TlsInterceptionOutcome = {
    /**
     * The proxy presented a leaf the route authority issued and answered the request: the request
     * went through the filtering proxy.
     */
    Filtered: 'filtered',

    /**
     * The handshake completed with a leaf the route authority did not issue: the proxy passed the
     * connection through without reading it.
     */
    NotIntercepted: 'not_intercepted',

    /**
     * The proxy presented a leaf the route authority issued but never answered the request.
     */
    NoResponse: 'no_response',

    /**
     * The TLS handshake through the tunnel did not complete; a proxy refusing to filter a host may
     * close the tunnel this way.
     */
    HandshakeFailed: 'handshake_failed',

    /**
     * The proxy did not open a tunnel to the host.
     */
    ProxyConnectFailed: 'proxy_connect_failed',
} as const;

/**
 * TlsInterceptionOutcome value.
 */
export type TlsInterceptionOutcome =
    (typeof TlsInterceptionOutcome)[keyof typeof TlsInterceptionOutcome];

/**
 * One certificate exactly as the interception proxy presented it.
 */
export interface PresentedInterceptionCertificate {
    /**
     * Subject common name, or null when the certificate carries none.
     */
    subjectCommonName: string | null;
    /**
     * Issuer common name, or null when the certificate carries none.
     */
    issuerCommonName: string | null;
    /**
     * Lowercase SHA-256 over the certificate DER.
     */
    sha256: string;
    /**
     * Base64 SHA-256 over the exported SubjectPublicKeyInfo DER — the value Chromium's
     * certificate-error allowlist compares against.
     */
    spkiSha256Base64: string;
}

/**
 * What the proxy actually presented at interception time, against what the route generated.
 */
export interface TlsInterceptionDiagnostic {
    /**
     * How far the request got.
     */
    outcome: TlsInterceptionOutcome;
    /**
     * Host whose interception was probed.
     */
    host: string;
    /**
     * Leaf-first chain the proxy presented.
     */
    chain: readonly PresentedInterceptionCertificate[];
    /**
     * SHA-256 of the certificate authority the route generated and trusts.
     */
    expectedCertificateSha256: string;
    /**
     * Base64 SPKI SHA-256 of that same authority, as handed to the browser allowlist.
     */
    expectedSpkiSha256Base64: string;
    /**
     * Whether that exact authority appears in the presented chain, which is the only way Chromium's
     * SPKI allowlist can ever match it.
     */
    expectedCaPresentInChain: boolean;
    /**
     * Whether the presented leaf verifies against that authority's public key.
     */
    leafIssuedByExpectedCa: boolean;
    /**
     * Status code the proxy answered the request with, or null when it did not answer.
     */
    statusCode: number | null;
    /**
     * Native failure text when the probe could not complete.
     */
    failure: string | null;
}

/**
 * Read a common name from an X.509 subject or issuer field.
 *
 * @param field - Multi-line subject or issuer text.
 * @returns The common name, or null when the field carries none.
 */
function commonName(field: string | undefined): string | null {
    if (!field) {
        return null;
    }
    for (const line of field.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('CN=')) {
            return trimmed.slice(3);
        }
    }
    return null;
}

/**
 * Project one certificate into its comparable public identities.
 *
 * @param certificate - Parsed presented certificate.
 * @returns Path-free identity projection.
 */
function describeCertificate(certificate: X509Certificate): PresentedInterceptionCertificate {
    return {
        subjectCommonName: commonName(certificate.subject),
        issuerCommonName: commonName(certificate.issuer),
        sha256: createHash('sha256').update(certificate.raw).digest('hex'),
        spkiSha256Base64: createHash('sha256')
            .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
            .digest('base64'),
    };
}

/**
 * Open one HTTP `CONNECT` tunnel to the named host through a loopback proxy.
 *
 * @param proxyUrl - Canonical loopback proxy URL.
 * @param authority - `host:port` to tunnel to.
 * @param timeoutMs - Hard deadline for the tunnel.
 * @returns Established tunnel socket.
 */
async function openProxyTunnel(
    proxyUrl: string,
    authority: string,
    timeoutMs: number,
): Promise<Socket> {
    const proxy = new URL(proxyUrl);
    return await new Promise<Socket>((resolve, reject) => {
        const socket = connectTcp({ host: proxy.hostname, port: Number(proxy.port) });
        let received = '';
        let settled = false;
        const fail = (reason: string): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            reject(new Error(reason));
        };
        const timer = setTimeout(() => fail('proxy_connect_timeout'), timeoutMs);
        socket.on('error', (error: Error) => fail(error.message));
        socket.on('close', () => fail('proxy_connect_closed'));
        socket.on('connect', () => {
            socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
        });
        socket.on('data', (chunk: Buffer) => {
            if (settled) {
                return;
            }
            received += chunk.toString('latin1');
            if (received.length > MAXIMUM_HANDSHAKE_BYTES) {
                fail('proxy_connect_response_too_large');
                return;
            }
            const end = received.indexOf('\r\n\r\n');
            if (end === -1) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            socket.removeAllListeners('data');
            socket.removeAllListeners('close');
            socket.removeAllListeners('error');
            const statusLine = received.slice(0, received.indexOf('\r\n'));
            if (HTTP_STATUS_LINE.exec(statusLine)?.[1] !== '200') {
                socket.destroy();
                reject(new Error(`proxy_connect_rejected: ${statusLine}`));
                return;
            }
            const trailing = received.slice(end + 4);
            if (trailing.length > 0) {
                socket.unshift(Buffer.from(trailing, 'latin1'));
            }
            resolve(socket);
        });
    });
}

/**
 * Read the leaf-first chain a completed TLS handshake presented.
 *
 * `getPeerX509Certificate` links each certificate to the one that issued it, so the walk stops as
 * soon as a certificate is self-issued or repeats — the chain as sent, not as reconstructed.
 *
 * @param leaf - Peer certificate of the established session.
 * @returns Leaf-first parsed chain.
 */
function readPresentedChain(leaf: X509Certificate): X509Certificate[] {
    const chain: X509Certificate[] = [];
    const seen = new Set<string>();
    let current: X509Certificate | undefined = leaf;
    while (current && chain.length < MAXIMUM_CHAIN_LENGTH) {
        const fingerprint = current.fingerprint256;
        if (seen.has(fingerprint)) {
            break;
        }
        seen.add(fingerprint);
        chain.push(current);
        current = current.issuerCertificate;
    }
    return chain;
}

/**
 * Wait for a TLS handshake over the tunnel to complete.
 *
 * @param secure - TLS socket wrapping the tunnel.
 * @param timeoutMs - Hard deadline for the handshake.
 * @returns The peer certificate, or undefined when the peer sent none.
 */
async function completeHandshake(
    secure: TLSSocket,
    timeoutMs: number,
): Promise<X509Certificate | undefined> {
    return await new Promise<X509Certificate | undefined>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('handshake_timeout')), timeoutMs);
        secure.once('error', (error: Error) => {
            clearTimeout(timer);
            reject(error);
        });
        secure.once('close', () => {
            clearTimeout(timer);
            reject(new Error('handshake_closed'));
        });
        secure.once('secureConnect', () => {
            clearTimeout(timer);
            resolve(secure.getPeerX509Certificate());
        });
    });
}

/**
 * Send one request over an established TLS session, the way the run's browser asks for a page, and
 * read the status code of the answer.
 *
 * @param secure - Established TLS socket.
 * @param target - The requested URL.
 * @param timeoutMs - Hard deadline for the answer.
 * @returns The response status code.
 */
async function requestStatusCode(
    secure: TLSSocket,
    target: URL,
    timeoutMs: number,
): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
        let received = '';
        let settled = false;
        const settle = (outcome: () => void): void => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                outcome();
            }
        };
        const timer = setTimeout(
            () => settle(() => reject(new Error('response_timeout'))),
            timeoutMs,
        );
        secure.on('error', (error: Error) => settle(() => reject(error)));
        secure.on('close', () => settle(() => reject(new Error('response_closed'))));
        secure.on('data', (chunk: Buffer) => {
            received += chunk.toString('latin1');
            const lineEnd = received.indexOf('\r\n');
            if (lineEnd === -1) {
                if (received.length > MAXIMUM_STATUS_LINE_BYTES) {
                    settle(() => reject(new Error('response_status_line_too_large')));
                }
                return;
            }
            const status = HTTP_STATUS_LINE.exec(received.slice(0, lineEnd));
            settle(() =>
                status === null
                    ? reject(new Error(`response_not_http: ${received.slice(0, lineEnd)}`))
                    : resolve(Number(status[1])),
            );
        });
        secure.write(
            `GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\n` +
                `User-Agent: ${DESKTOP_CHROMIUM_USER_AGENT}\r\n` +
                `Accept: ${CHROMIUM_NAVIGATION_ACCEPT}\r\nConnection: close\r\n\r\n`,
        );
    });
}

/**
 * Send one HTTPS request for a target through the running interception proxy, the way the browser
 * does, and report how far it got.
 *
 * Only a request the proxy answered under the route's own authority went through the filter: a
 * proxy that passes a host through presents the site's own leaf, one that refuses it closes the
 * tunnel, and neither filters anything. The chain the proxy presented is kept either way, because
 * it is what tells those failures apart in the run log.
 *
 * @param proxyUrl - Canonical loopback proxy URL the route exposes.
 * @param targetUrl - The target whose host is requested over HTTPS.
 * @param expectedCertificateDerBase64 - Base64 DER of the authority the route generated.
 * @param timeoutMs - Deadline for each step: the tunnel, the handshake, and the answer.
 * @returns How far the request got, and what the proxy presented.
 */
export async function probeTlsInterception(
    proxyUrl: string,
    targetUrl: string,
    expectedCertificateDerBase64: string,
    timeoutMs: number = PROBE_STEP_TIMEOUT_MS,
): Promise<TlsInterceptionDiagnostic> {
    const target = new URL(targetUrl);
    const host = target.hostname;
    const port =
        target.protocol === 'https:' && target.port !== '' ? target.port : HTTPS_DEFAULT_PORT;
    const expected = new X509Certificate(Buffer.from(expectedCertificateDerBase64, 'base64'));
    const expectedDescription = describeCertificate(expected);
    const base = {
        host,
        chain: [] as readonly PresentedInterceptionCertificate[],
        expectedCertificateSha256: expectedDescription.sha256,
        expectedSpkiSha256Base64: expectedDescription.spkiSha256Base64,
        expectedCaPresentInChain: false,
        leafIssuedByExpectedCa: false,
        statusCode: null,
    };
    let tunnel: Socket;
    try {
        tunnel = await openProxyTunnel(proxyUrl, `${host}:${port}`, timeoutMs);
    } catch (error) {
        return {
            ...base,
            outcome: TlsInterceptionOutcome.ProxyConnectFailed,
            failure: (error as Error).message,
        };
    }
    const secure = connectTls({ socket: tunnel, servername: host, rejectUnauthorized: false });
    try {
        let leaf: X509Certificate | undefined;
        try {
            leaf = await completeHandshake(secure, timeoutMs);
        } catch (error) {
            return {
                ...base,
                outcome: TlsInterceptionOutcome.HandshakeFailed,
                failure: (error as Error).message,
            };
        }
        if (!leaf) {
            return {
                ...base,
                outcome: TlsInterceptionOutcome.HandshakeFailed,
                failure: 'no_peer_certificate',
            };
        }
        const chain = readPresentedChain(leaf);
        const presented = {
            ...base,
            chain: chain.map(describeCertificate),
            expectedCaPresentInChain: chain.some(
                (certificate) => certificate.fingerprint256 === expected.fingerprint256,
            ),
            leafIssuedByExpectedCa: leaf.verify(expected.publicKey),
        };
        if (!presented.leafIssuedByExpectedCa) {
            return { ...presented, outcome: TlsInterceptionOutcome.NotIntercepted, failure: null };
        }
        try {
            const statusCode = await requestStatusCode(secure, target, timeoutMs);
            return {
                ...presented,
                outcome: TlsInterceptionOutcome.Filtered,
                statusCode,
                failure: null,
            };
        } catch (error) {
            return {
                ...presented,
                outcome: TlsInterceptionOutcome.NoResponse,
                failure: (error as Error).message,
            };
        }
    } finally {
        // Both ends are closed unconditionally: wrapping an existing socket does not transfer
        // ownership of it, and an observer that leaves a live handle behind keeps the whole run
        // from ever exiting.
        secure.destroy();
        tunnel.destroy();
    }
}
