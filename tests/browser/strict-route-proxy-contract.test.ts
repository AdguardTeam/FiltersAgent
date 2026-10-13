import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { Logger } from 'pino';
import { BrowserSession } from '../../src/browser/browser-session';
import { CloakBrowserEngine } from '../../src/browser/cloakbrowser-engine';
import { createPreparedStrictBrowserRoute } from '../../src/browser/strict-browser-route';
import type { ReproProfile } from '../../src/types/repro-profile';

const PROBE_URL = 'http://strict-route-proxy-contract.test/probe';
const PROBE_BODY = 'served-by-the-route-proxy';

const testProfile: ReproProfile = {
    viewport: 'desktop',
    locale: 'en-US',
    timezone: 'UTC',
    userAgentProfile: 'Chrome',
    consentStrategy: 'untouched',
};

function silentLogger(): Logger {
    return {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
    } as unknown as Logger;
}

async function startLoopbackProxy(received: string[]): Promise<{ server: Server; port: number }> {
    const server = createServer((request, response) => {
        received.push(request.url ?? '');
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end(PROBE_BODY);
    });
    await new Promise<void>((resolve) => {
        server.listen({ host: '127.0.0.1', port: 0 }, resolve);
    });
    const address = server.address();
    if (typeof address !== 'object' || address === null) {
        throw new Error('proxy address missing');
    }
    return { server, port: address.port };
}

/*
 * The contract under test is the one that broke in production: a strict route names a loopback
 * proxy, and the browser it launches must actually send its traffic there. Chromium's
 * `--proxy-server` switch is not a URL — a value that looks right can be silently discarded,
 * leaving an empty proxy list and `ERR_NO_SUPPORTED_PROXIES` on the first navigation. Only a real
 * browser can settle whether the launched argument satisfies that grammar, so this suite launches
 * one against a real loopback listener rather than asserting on the argument's spelling.
 */
describe('strict route proxy contract', () => {
    it('sends the launched browser traffic through the loopback proxy the route names', async () => {
        const received: string[] = [];
        const { server, port } = await startLoopbackProxy(received);
        const browserRoot = mkdtempSync(join(tmpdir(), 'strict-route-proxy-contract-'));
        chmodSync(browserRoot, 0o700);
        const certificate = Buffer.from('ephemeral fixture CA');
        const targetUrl = 'https://example.com/';
        const strictRoute = createPreparedStrictBrowserRoute({
            routeId: randomUUID(),
            cycleId: randomUUID(),
            targetUrl,
            proxyUrl: `http://127.0.0.1:${port}/`,
            spkiSha256Base64: Buffer.alloc(32, 7).toString('base64'),
            certificateDerBase64: certificate.toString('base64'),
            certificateSha256: createHash('sha256').update(certificate).digest('hex'),
            browserRoot,
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
        });

        let session: BrowserSession | undefined;
        let body = '';
        let navigationFailure = '';
        try {
            session = await BrowserSession.create({
                engine: new CloakBrowserEngine(),
                logger: silentLogger(),
                reproProfile: testProfile,
                artifactsDir: browserRoot,
                headless: true,
                noSandbox: process.env.CI === 'true',
                strictRoute,
                strictRouteTargetUrl: targetUrl,
            });
            try {
                const response = await session.getPage().goto(PROBE_URL, { timeout: 30_000 });
                body = (await response?.text()) ?? '';
            } catch (error) {
                navigationFailure = (error as Error).message.split('\n')[0];
            }
        } finally {
            await session?.close();
            server.close();
            rmSync(browserRoot, { recursive: true, force: true });
        }

        expect(navigationFailure).toBe('');
        expect(received).toContain(PROBE_URL);
        expect(body).toBe(PROBE_BODY);
    }, 120_000);
});
