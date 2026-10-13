import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { firefox, type Page } from 'playwright-core';
import type { Logger } from 'pino';
import { BrowserSession } from '../../src/browser/browser-session';
import { createBrowserToolHandlers } from '../../src/browser/browser-tools';
import { FirefoxEngine } from '../../src/browser/firefox-engine';
import { buildFirefoxPolicies } from '../../src/browser/firefox-policies';
import { ConsentStrategy, Viewport, type ReproProfile } from '../../src/types/repro-profile';
import { RunMode } from '../../src/types/trace';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import { ensureUboXpi } from './fixtures/ubo-xpi';
import { ConsoleCoverage } from '../../src/browser/browser-interfaces';

/**
 * UBlock Origin's published Firefox extension ID (external contract of gorhill/uBlock).
 */
const UBO_EXTENSION_ID = 'uBlock0@raymondhill.net';

/**
 * User filter matching only the fixture's ad host.
 *
 * The ad must never be served from the fixture server: the Task 2 probe recorded that uBO exempts
 * loopback hosts from blocking by design, so a loopback banner can never be a blocking signal.
 */
const USER_FILTER = '||ads.example^';

/**
 * Managed-storage selected-filter-list entry that subscribes only the user filters, so the
 * force-installed uBlock Origin never starts downloading real filter lists.
 */
const USER_FILTER_LIST = 'user-filters';

/**
 * URL of the fixture's known-ad image request, matched by the user filter above.
 */
const AD_REQUEST_URL = 'http://ads.example/banner.png';

/**
 * Host the known-ad request goes to, as it appears in the network tool's per-host inventory.
 */
const AD_REQUEST_HOST = new URL(AD_REQUEST_URL).hostname;

/**
 * The console line the fixture page itself logs before its resources load: the get_console_log tool
 * must return it with its type and text, proving the tool surfaces page-originated output.
 */
const FIXTURE_READY_CONSOLE_TEXT = 'fixture-ad-page-ready';

/**
 * The recorded Task 2 seam: a request cancelled by a Firefox webRequest extension (uBO's block)
 * fails with `NS_ERROR_ABORT`. A DNS failure — this host is unresolvable — fails with the second
 * value below, so the error text separates the block from the dead host.
 */
const UBO_CANCEL_ERROR_TEXT = 'NS_ERROR_ABORT';

/**
 * Network-log failure text Firefox reports for an unresolvable host without any extension: the
 * imitation failure that must never be mistaken for a block.
 */
const DNS_FAILURE_ERROR_TEXT = 'NS_ERROR_UNKNOWN_HOST';

/**
 * Warm-up budget before the block is expected.
 *
 * The Task 2 probe observed 30–45 s for the block to engage on a fresh force-install; the budget
 * leaves headroom for slower machines and first-launch XPI installation.
 */
const UBO_WARMUP_BUDGET_MS = 240_000;

/**
 * Settle window after each navigation before the seams are sampled.
 */
const BLOCK_PROBE_SETTLE_MS = 3_000;

/**
 * The 8-byte PNG file signature, used to prove the screenshot artifact is a real PNG.
 */
const PNG_SIGNATURE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Reproduction profile matching the Firefox reporter environment the module must reproduce.
 */
const firefoxReproProfile: ReproProfile = {
    viewport: Viewport.Desktop,
    locale: 'en-US',
    timezone: 'UTC',
    userAgentProfile: 'firefox',
    consentStrategy: ConsentStrategy.Untouched,
};

type Availability = {
    /**
     * Whether the prerequisite is available.
     */
    ok: boolean;
} & {
    /**
     * The precise unavailability reason; present only when the prerequisite is missing.
     */
    reason?: string;
};

/**
 * Check whether the Playwright Firefox build is installed without launching it.
 *
 * @returns Availability, with the install command in the reason when the build is missing.
 */
function firefoxBuildAvailability(): Availability {
    try {
        const executablePath = firefox.executablePath();
        if (existsSync(executablePath)) {
            return { ok: true };
        }
        return {
            ok: false,
            reason: `Playwright Firefox build is not installed (expected at ${executablePath}); run 'pnpm exec playwright-core install firefox'`,
        };
    } catch (error) {
        return {
            ok: false,
            reason: `Playwright Firefox executable path is unavailable: ${(error as Error).message}`,
        };
    }
}

/**
 * A logger that keeps the integration suite quiet; the test's own attempt log carries the
 * diagnostics a failure needs.
 *
 * @returns A Pino-shaped logger that discards everything.
 */
function silentLogger(): Logger {
    return {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
    } as unknown as Logger;
}

/**
 * Serve the fixture page whose known-ad image points outside the loopback (see USER_FILTER).
 *
 * @returns The listening server and its loopback base URL.
 */
async function startAdFixtureServer(): Promise<{ server: Server; base: string }> {
    const html =
        '<!doctype html><html><body><h1>firefox ublock session fixture</h1>' +
        `<script>console.info('${FIXTURE_READY_CONSOLE_TEXT}');</script>` +
        `<img id="ad" src="${AD_REQUEST_URL}"></body></html>`;
    const server = createServer((request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(html);
    });
    await new Promise<void>((resolveListen) => {
        server.listen({ host: '127.0.0.1', port: 0 }, resolveListen);
    });
    const address = server.address();
    if (typeof address !== 'object' || address === null) {
        throw new Error('fixture server address missing');
    }
    return { server, base: `http://127.0.0.1:${address.port}` };
}

/*
 * The AC gate for the Firefox slice of the "browser with extension" module: a real Playwright
 * Firefox build with a force-installed signed uBlock Origin XPI (Playwright policies, Path A) has
 * to block a filtered request — the block is attributed through the recorded NS_ERROR_ABORT seam,
 * because `statusCode 0` alone also appears for the unresolvable ad host — and every page tool
 * must keep working through the session. Local-run gate: skipped with the precise reason when the
 * Firefox build or the XPI fixture is unavailable; no workflow installs the build.
 */
describe('Firefox session with force-installed uBlock Origin', () => {
    it('blocks the known ad through the managed-storage user filter and serves the page tools (AC1+AC2+AC3)', async (ctx) => {
        const firefoxBuild = firefoxBuildAvailability();
        if (!firefoxBuild.ok) {
            ctx.skip(true, firefoxBuild.reason ?? 'Firefox build unavailable');
            return;
        }
        const xpi = await ensureUboXpi();
        if (!xpi.ok) {
            ctx.skip(true, xpi.reason);
            return;
        }

        const artifactsDir = mkdtempSync(join(tmpdir(), 'firefox-ublock-session-'));
        const { server, base } = await startAdFixtureServer();
        const policies = buildFirefoxPolicies({
            extensionId: UBO_EXTENSION_ID,
            xpiPath: xpi.path,
            managedStorage: {
                adminSettings: {
                    userFilters: USER_FILTER,
                    selectedFilterLists: [USER_FILTER_LIST],
                },
            },
        });
        let session: BrowserSession | undefined;
        try {
            session = await BrowserSession.create({
                engine: new FirefoxEngine(),
                logger: silentLogger(),
                reproProfile: firefoxReproProfile,
                artifactsDir,
                headless: true,
                firefoxPolicies: policies,
            });
            const page: Page = session.getPage();
            const seamErrorTexts = new Map<string, string>();
            page.on('requestfailed', (request) => {
                seamErrorTexts.set(request.url(), request.failure()?.errorText ?? 'unknown');
            });

            // AC1+AC2: the block can warm up slowly on a freshly force-installed profile, so poll
            // navigations until the recorded seam appears or the budget expires. The attempt log
            // keeps a failure diagnosable from this single run.
            const attemptLog: string[] = [];
            let attempts = 0;
            const blockDeadline = Date.now() + UBO_WARMUP_BUDGET_MS;
            while (Date.now() < blockDeadline) {
                attempts += 1;
                try {
                    await page.goto(`${base}/index.html`, { waitUntil: 'load', timeout: 30_000 });
                } catch (error) {
                    attemptLog.push(
                        `attempt ${attempts}: goto failed: ${(error as Error).message.split('\n')[0]}`,
                    );
                    continue;
                }
                await page.waitForTimeout(BLOCK_PROBE_SETTLE_MS);
                const statusCodeZeroEntry = session
                    .getNetworkLog()
                    .find((entry) => entry.url === AD_REQUEST_URL && entry.statusCode === 0);
                const seamErrorText = seamErrorTexts.get(AD_REQUEST_URL) ?? 'none';
                attemptLog.push(
                    `attempt ${attempts}: statusCode0=${statusCodeZeroEntry ? 'present' : 'absent'} seam=${seamErrorText}`,
                );
                if (statusCodeZeroEntry && seamErrorText === UBO_CANCEL_ERROR_TEXT) {
                    break;
                }
            }

            const finalSeamErrorText = seamErrorTexts.get(AD_REQUEST_URL) ?? 'none';
            expect(
                finalSeamErrorText,
                `uBO block did not engage within ${UBO_WARMUP_BUDGET_MS} ms across ${attempts} attempts ` +
                    `(expected extension cancel ${UBO_CANCEL_ERROR_TEXT}; a bare DNS failure ` +
                    `imitating the block would read ${DNS_FAILURE_ERROR_TEXT}):\n${attemptLog.join('\n')}`,
            ).toBe(UBO_CANCEL_ERROR_TEXT);
            const adNetworkEntries = session
                .getNetworkLog()
                .filter((entry) => entry.url === AD_REQUEST_URL);
            expect(adNetworkEntries.length).toBeGreaterThan(0);
            // AC1: the extension-cancelled request appears in the session's network log with the
            // zero status code BrowserSession records for every requestfailed event.
            expect(adNetworkEntries.at(-1)?.statusCode).toBe(0);

            const recorder = new TraceRecorder({
                runId: 'firefox-ublock-session-test',
                issueNumber: 10,
                mode: RunMode.Fix,
            });
            const tools = createBrowserToolHandlers({
                session,
                recorder,
                artifactsDir,
                allowedOrigin: base,
                logger: silentLogger(),
            });

            // AC1+AC2 DOM proof and the evaluate_js part of AC3: a blocked image never decodes.
            const evaluation = await tools.evaluate_js({
                expression: 'document.getElementById("ad")?.naturalWidth ?? -1',
            });
            expect(evaluation.error).toBeUndefined();
            expect(evaluation.result).toBe(0);

            // AC3: the remaining page tools return data through the Firefox session.
            const dom = await tools.get_dom({});
            expect(dom.artifactId).toBeDefined();
            expect(dom.htmlLength).toBeGreaterThan(0);
            expect(String(dom.visibleTextPreview).length).toBeGreaterThan(0);

            const screenshot = await tools.screenshot({});
            expect(screenshot.error).toBeUndefined();
            const screenshotPath = join(artifactsDir, `${String(screenshot.artifactId)}.png`);
            expect(existsSync(screenshotPath)).toBe(true);
            expect(readFileSync(screenshotPath).subarray(0, PNG_SIGNATURE_BYTES.length)).toEqual(
                PNG_SIGNATURE_BYTES,
            );

            // AC3 through the network tools: the blocked ad is visible in the phase inventory the
            // tool returns, and a reset ends the phase so the entry is no longer returned.
            const networkLog = await tools.get_network_log({});
            const beforeResetRequests = Array.isArray(networkLog.requests)
                ? (networkLog.requests as Array<{ host: string; status: number }>)
                : [];
            const blockedAdSummary = beforeResetRequests.find(
                (summary) => summary.host === AD_REQUEST_HOST,
            );
            expect(blockedAdSummary?.status).toBe(0);
            const beforeResetBlocked = Array.isArray(networkLog.blocked)
                ? (networkLog.blocked as string[])
                : [];
            expect(beforeResetBlocked).toContain(AD_REQUEST_URL);

            const resetResult = await tools.reset_network_log({});
            expect(resetResult.reset).toBe(true);

            const postResetLog = await tools.get_network_log({});
            expect(postResetLog.blockedCount ?? 0).toBe(0);
            const postResetRequests = Array.isArray(postResetLog.requests)
                ? (postResetLog.requests as Array<{ host: string; status: number }>)
                : [];
            expect(postResetRequests.some((summary) => summary.host === AD_REQUEST_HOST)).toBe(
                false,
            );

            const pageState = await tools.inspect_page_state({});
            expect(Array.isArray(pageState.cookies)).toBe(true);
            expect(pageState.frames.map((frame) => frame.url)).toContain(`${base}/index.html`);

            // AC3: the engine declares page console coverage and get_console_log proves it: the
            // fixture's own marker line must appear with type and text, not just an empty list.
            const consoleLog = await tools.get_console_log({});
            expect(consoleLog.consoleCoverage).toBe(ConsoleCoverage.PageConsole);
            const consoleMessages = Array.isArray(consoleLog.messages)
                ? (consoleLog.messages as Array<{ type: string; text: string }>)
                : [];
            expect(
                consoleMessages.some(
                    (message) =>
                        message.type === 'info' && message.text === FIXTURE_READY_CONSOLE_TEXT,
                ),
            ).toBe(true);
            expect(tools.stabilize_page).toBeDefined();

            const stability = await tools.stabilize_page!({});
            expect(stability.status).toBe('stable');
        } finally {
            await session?.close();
            await new Promise<void>((resolveClose) => {
                server.close(() => resolveClose());
            });
            rmSync(artifactsDir, { recursive: true, force: true });
        }
    }, 420_000);
});
