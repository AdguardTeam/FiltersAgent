import { createHash, X509Certificate } from 'node:crypto';
import { connect as connectTcp, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';

const DEFAULT_TIMEOUT_MS = 8_000;
const MAXIMUM_CHAIN_LENGTH = 16;
const MAXIMUM_HANDSHAKE_BYTES = 256 * 1024;

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
     * Finite outcome of the probe itself.
     */
    outcome: 'presented' | 'proxy_connect_failed' | 'handshake_failed' | 'chain_unreadable';
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
 * @param host - Host to tunnel to.
 * @param timeoutMs - Hard deadline for the tunnel.
 * @returns Established tunnel socket.
 */
async function openProxyTunnel(proxyUrl: string, host: string, timeoutMs: number): Promise<Socket> {
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
            socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
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
            if (!/^HTTP\/1\.[01] 200\b/u.test(statusLine)) {
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
 * Probe what the running interception proxy actually presents for one host.
 *
 * A certificate rejection in the browser can only ever report that some authority was unknown. It
 * cannot say whether the authority the proxy presented is the one the route generated, nor whether
 * that authority was in the chain at all — and those two facts decide between a trust-installation
 * defect and a certificate-identity defect. This probe answers both from the same run, using the
 * proxy exactly as the browser does and verifying nothing it is not entitled to verify.
 *
 * @param proxyUrl - Canonical loopback proxy URL the route exposes.
 * @param targetUrl - Exact HTTPS target whose interception is probed.
 * @param expectedCertificateDerBase64 - Base64 DER of the authority the route generated.
 * @param timeoutMs - Hard deadline for the whole probe.
 * @returns What the proxy presented, against what the route expected.
 */
export async function probeTlsInterception(
    proxyUrl: string,
    targetUrl: string,
    expectedCertificateDerBase64: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<TlsInterceptionDiagnostic> {
    const host = new URL(targetUrl).hostname;
    const expected = new X509Certificate(Buffer.from(expectedCertificateDerBase64, 'base64'));
    const expectedDescription = describeCertificate(expected);
    const base = {
        host,
        chain: [] as readonly PresentedInterceptionCertificate[],
        expectedCertificateSha256: expectedDescription.sha256,
        expectedSpkiSha256Base64: expectedDescription.spkiSha256Base64,
        expectedCaPresentInChain: false,
        leafIssuedByExpectedCa: false,
    };
    let tunnel: Socket;
    try {
        tunnel = await openProxyTunnel(proxyUrl, host, timeoutMs);
    } catch (error) {
        return { ...base, outcome: 'proxy_connect_failed', failure: (error as Error).message };
    }
    const secure = connectTls({ socket: tunnel, servername: host, rejectUnauthorized: false });
    let leaf: X509Certificate | undefined;
    try {
        leaf = await new Promise<X509Certificate | undefined>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('handshake_timeout')), timeoutMs);
            secure.on('error', (error: Error) => {
                clearTimeout(timer);
                reject(error);
            });
            secure.on('secureConnect', () => {
                clearTimeout(timer);
                resolve(secure.getPeerX509Certificate());
            });
        });
    } catch (error) {
        return { ...base, outcome: 'handshake_failed', failure: (error as Error).message };
    } finally {
        // Both ends are closed unconditionally: wrapping an existing socket does not transfer
        // ownership of it, and an observer that leaves a live handle behind keeps the whole run
        // from ever exiting.
        secure.destroy();
        tunnel.destroy();
    }
    if (!leaf) {
        return { ...base, outcome: 'chain_unreadable', failure: null };
    }
    const chain = readPresentedChain(leaf);
    return {
        ...base,
        outcome: 'presented',
        chain: chain.map(describeCertificate),
        expectedCaPresentInChain: chain.some(
            (certificate) => certificate.fingerprint256 === expected.fingerprint256,
        ),
        leafIssuedByExpectedCa: leaf.verify(expected.publicKey),
        failure: null,
    };
}
