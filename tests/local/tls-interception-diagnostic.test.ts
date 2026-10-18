import { execFileSync, spawn } from 'node:child_process';
import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    probeTlsInterception,
    TlsInterceptionOutcome,
} from '../../src/local/tls-interception-diagnostic';

const TARGET = 'https://probe.interception.test/';

let material: { caPem: Buffer; otherCaPem: Buffer; leafPem: Buffer; leafKey: Buffer } | null = null;
let workspace = '';

/**
 * Mint a throwaway authority and a leaf it issued for the probed host.
 *
 * @returns Whether the material could be produced on this machine.
 */
function mintMaterial(): boolean {
    workspace = mkdtempSync(join(tmpdir(), 'interception-probe-'));
    const run = (args: string[], input?: string): void => {
        execFileSync('openssl', args, { cwd: workspace, input, stdio: 'pipe' });
    };
    try {
        for (const name of ['ca', 'other']) {
            run([
                'req',
                '-x509',
                '-newkey',
                'rsa:2048',
                '-keyout',
                `${name}.key`,
                '-out',
                `${name}.pem`,
                '-days',
                '1',
                '-nodes',
                '-subj',
                `/CN=Interception Probe ${name}`,
                '-addext',
                'basicConstraints=critical,CA:TRUE',
                '-addext',
                'keyUsage=critical,keyCertSign,cRLSign',
            ]);
        }
        run([
            'req',
            '-newkey',
            'rsa:2048',
            '-keyout',
            'leaf.key',
            '-out',
            'leaf.csr',
            '-nodes',
            '-subj',
            '/CN=probe.interception.test',
        ]);
        execFileSync(
            'openssl',
            [
                'x509',
                '-req',
                '-in',
                'leaf.csr',
                '-CA',
                'ca.pem',
                '-CAkey',
                'ca.key',
                '-CAcreateserial',
                '-out',
                'leaf.pem',
                '-days',
                '1',
                '-extfile',
                '/dev/stdin',
            ],
            {
                cwd: workspace,
                input: 'subjectAltName=DNS:probe.interception.test\nbasicConstraints=CA:FALSE\n',
                stdio: 'pipe',
            },
        );
    } catch {
        return false;
    }
    material = {
        caPem: readFileSync(join(workspace, 'ca.pem')),
        otherCaPem: readFileSync(join(workspace, 'other.pem')),
        leafPem: readFileSync(join(workspace, 'leaf.pem')),
        leafKey: readFileSync(join(workspace, 'leaf.key')),
    };
    return true;
}

/**
 * Convert one PEM certificate into its base64 DER encoding.
 *
 * @param pem - PEM certificate bytes.
 * @returns Base64 DER of the same certificate.
 */
function derBase64(pem: Buffer): string {
    const body = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/u.exec(
        pem.toString('utf8'),
    );
    if (!body) {
        throw new Error('unreadable certificate fixture');
    }
    return body[1].replace(/\s+/gu, '');
}

/**
 * How the fixture proxy treats a tunnel once it is open.
 */
const ProxyBehaviour = {
    /**
     * Terminate TLS with the given chain and answer the request, as a filtering proxy does.
     */
    Answer: 'answer',

    /**
     * Terminate TLS but never answer the request.
     */
    Silent: 'silent',

    /**
     * Close the tunnel as soon as the client speaks, as AdGuard CLI does for a host it refuses.
     */
    Close: 'close',

    /**
     * Terminate TLS and answer only a request that looks like a browser's, as a site that drops
     * other clients does.
     */
    BrowsersOnly: 'browsers_only',
} as const;

type ProxyBehaviour = (typeof ProxyBehaviour)[keyof typeof ProxyBehaviour];

/**
 * Start an interception proxy that terminates TLS with the given chain.
 *
 * @param chain - Certificate chain the proxy presents.
 * @param behaviour - What the proxy does with an open tunnel.
 * @returns Proxy URL and a shutdown function.
 */
async function startInterceptionProxy(
    chain: Buffer,
    behaviour: ProxyBehaviour = ProxyBehaviour.Answer,
): Promise<{ proxyUrl: string; close(): void }> {
    const tls: TlsServer = createTlsServer({ key: material!.leafKey, cert: chain }, (socket) =>
        socket.on('error', () => undefined),
    );
    const inner: Server = createHttpServer((request, response) => {
        const fromBrowser =
            request.headers['user-agent']?.startsWith('Mozilla/5.0') === true &&
            request.headers.accept?.includes('text/html') === true;
        if (
            behaviour === ProxyBehaviour.Answer ||
            (behaviour === ProxyBehaviour.BrowsersOnly && fromBrowser)
        ) {
            response.end('ok');
        }
    });
    tls.on('secureConnection', (socket) => inner.emit('connection', socket));
    const proxy = createHttpServer((_request, response) => response.end('ok'));
    proxy.on('connect', (_request, clientSocket, head) => {
        clientSocket.on('error', () => undefined);
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (behaviour === ProxyBehaviour.Close) {
            clientSocket.once('data', () => clientSocket.destroy());
            return;
        }
        if (head.length > 0) {
            clientSocket.unshift(head);
        }
        tls.emit('connection', clientSocket);
    });
    await new Promise<void>((listening) => proxy.listen({ host: '127.0.0.1', port: 0 }, listening));
    const address = proxy.address();
    if (typeof address !== 'object' || address === null) {
        throw new Error('no proxy address');
    }
    return {
        proxyUrl: `http://127.0.0.1:${address.port}/`,
        close() {
            proxy.closeAllConnections();
            proxy.close();
            tls.close();
            inner.closeAllConnections();
            inner.close();
        },
    };
}

beforeAll(() => {
    if (!mintMaterial()) {
        material = null;
    }
});

afterAll(() => {
    if (workspace) {
        rmSync(workspace, { recursive: true, force: true });
    }
});

/*
 * A route may call its environment ready only after an HTTPS request really went through the
 * filtering proxy under the route's own authority. A proxy that tunnels a host raw, refuses it, or
 * never answers leaves the run on unfiltered traffic, and each of those must be named.
 */
describe('tls interception diagnostic', () => {
    it('proves an HTTPS request went through the proxy under the route authority', async () => {
        if (!material) {
            return;
        }
        const proxy = await startInterceptionProxy(material.leafPem);
        try {
            const observed = await probeTlsInterception(
                proxy.proxyUrl,
                TARGET,
                derBase64(material.caPem),
            );
            expect(observed.outcome).toBe(TlsInterceptionOutcome.Filtered);
            expect(observed.statusCode).toBe(200);
            expect(observed.chain).toHaveLength(1);
            expect(observed.chain[0].subjectCommonName).toBe('probe.interception.test');
            expect(observed.chain[0].issuerCommonName).toBe('Interception Probe ca');
            expect(observed.leafIssuedByExpectedCa).toBe(true);
            expect(observed.expectedCaPresentInChain).toBe(false);
        } finally {
            proxy.close();
        }
    }, 30_000);

    it('reports a proxy presenting another authority as not intercepting', async () => {
        if (!material) {
            return;
        }
        const proxy = await startInterceptionProxy(material.leafPem);
        try {
            const observed = await probeTlsInterception(
                proxy.proxyUrl,
                TARGET,
                derBase64(material.otherCaPem),
            );
            expect(observed.outcome).toBe(TlsInterceptionOutcome.NotIntercepted);
            expect(observed.statusCode).toBeNull();
            expect(observed.leafIssuedByExpectedCa).toBe(false);
            expect(observed.expectedCaPresentInChain).toBe(false);
        } finally {
            proxy.close();
        }
    }, 30_000);

    it('records the authority as present when the proxy sends it in the chain', async () => {
        if (!material) {
            return;
        }
        const proxy = await startInterceptionProxy(
            Buffer.concat([material.leafPem, material.caPem]),
        );
        try {
            const observed = await probeTlsInterception(
                proxy.proxyUrl,
                TARGET,
                derBase64(material.caPem),
            );
            expect(observed.outcome).toBe(TlsInterceptionOutcome.Filtered);
            expect(observed.chain).toHaveLength(2);
            expect(observed.expectedCaPresentInChain).toBe(true);
            expect(observed.chain[1].spkiSha256Base64).toBe(observed.expectedSpkiSha256Base64);
        } finally {
            proxy.close();
        }
    }, 30_000);

    it('reports a proxy that closes the tunnel it opened as a failed handshake', async () => {
        if (!material) {
            return;
        }
        const proxy = await startInterceptionProxy(material.leafPem, ProxyBehaviour.Close);
        try {
            const observed = await probeTlsInterception(
                proxy.proxyUrl,
                TARGET,
                derBase64(material.caPem),
                2_000,
            );
            expect(observed.outcome).toBe(TlsInterceptionOutcome.HandshakeFailed);
            expect(observed.statusCode).toBeNull();
            expect(observed.failure).not.toBeNull();
        } finally {
            proxy.close();
        }
    }, 30_000);

    it('is answered by a site that drops clients other than browsers', async () => {
        if (!material) {
            return;
        }
        const proxy = await startInterceptionProxy(material.leafPem, ProxyBehaviour.BrowsersOnly);
        try {
            const observed = await probeTlsInterception(
                proxy.proxyUrl,
                TARGET,
                derBase64(material.caPem),
                1_000,
            );
            expect(observed.outcome).toBe(TlsInterceptionOutcome.Filtered);
        } finally {
            proxy.close();
        }
    }, 30_000);

    it('reports an intercepted request that is never answered as no response', async () => {
        if (!material) {
            return;
        }
        const proxy = await startInterceptionProxy(material.leafPem, ProxyBehaviour.Silent);
        try {
            const observed = await probeTlsInterception(
                proxy.proxyUrl,
                TARGET,
                derBase64(material.caPem),
                1_000,
            );
            expect(observed.outcome).toBe(TlsInterceptionOutcome.NoResponse);
            expect(observed.leafIssuedByExpectedCa).toBe(true);
            expect(observed.statusCode).toBeNull();
        } finally {
            proxy.close();
        }
    }, 30_000);
    it('leaves no live handle behind, so the run it observes can still exit', async () => {
        if (!material) {
            return;
        }
        const script = join(workspace, 'exit-probe.mts');
        writeFileSync(
            script,
            [
                `import { createServer as http } from 'node:http';`,
                `import { createServer as tls } from 'node:tls';`,
                `import { readFileSync } from 'node:fs';`,
                `import { probeTlsInterception, TlsInterceptionOutcome } from ${JSON.stringify(
                    resolve('src/local/tls-interception-diagnostic.ts'),
                )};`,
                `const dir = ${JSON.stringify(workspace)};`,
                `const leaf = readFileSync(dir + '/leaf.pem');`,
                `const key = readFileSync(dir + '/leaf.key');`,
                `const secure = tls({ key, cert: leaf }, (s) => s.on('error', () => {}));`,
                `const inner = http((_q, r) => r.end('ok'));`,
                `secure.on('secureConnection', (s) => inner.emit('connection', s));`,
                `const proxy = http((_q, r) => r.end('ok'));`,
                `proxy.on('connect', (_q, socket, head) => {`,
                `    socket.on('error', () => {});`,
                `    socket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');`,
                `    if (head.length > 0) socket.unshift(head);`,
                `    secure.emit('connection', socket);`,
                `});`,
                `await new Promise((done) => proxy.listen({ host: '127.0.0.1', port: 0 }, done));`,
                `const port = proxy.address().port;`,
                `const ca = readFileSync(dir + '/ca.pem').toString();`,
                `const der = /-----BEGIN CERTIFICATE-----([\\s\\S]+?)-----END/.exec(ca)[1]`,
                `    .replace(/\\s+/g, '');`,
                `const observed = await probeTlsInterception(`,
                `    'http://127.0.0.1:' + port + '/',`,
                `    ${JSON.stringify(TARGET)},`,
                `    der,`,
                `);`,
                `if (observed.outcome !== TlsInterceptionOutcome.Filtered) throw new Error(observed.outcome);`,
                `proxy.close();`,
                `secure.close();`,
                `inner.close();`,
            ].join('\n'),
        );
        const exited = await new Promise<{ code: number | null; timedOut: boolean }>((done) => {
            const child = spawn(resolve('node_modules/.bin/tsx'), [script], { stdio: 'ignore' });
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                done({ code: null, timedOut: true });
            }, 30_000);
            child.on('exit', (code) => {
                clearTimeout(timer);
                done({ code, timedOut: false });
            });
        });
        expect(exited.timedOut).toBe(false);
        expect(exited.code).toBe(0);
    }, 60_000);

    it('reports an unreachable proxy as a connect failure rather than throwing', async () => {
        if (!material) {
            return;
        }
        const observed = await probeTlsInterception(
            'http://127.0.0.1:1/',
            TARGET,
            derBase64(material.caPem),
            1_000,
        );
        expect(observed.outcome).toBe(TlsInterceptionOutcome.ProxyConnectFailed);
        expect(observed.chain).toHaveLength(0);
    }, 30_000);
});
