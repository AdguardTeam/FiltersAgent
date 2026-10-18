import { X509Certificate } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { BrowserSession } from '../../src/browser/browser-session';
import { ConsoleCoverage } from '../../src/browser/browser-interfaces';
import type { ReproProfile } from '../../src/types/repro-profile';
import { prepareProxyBlockerPublishedBaseline } from '../../src/proxy-blocker/published-baseline';
import { createAdguardCliBlocker } from '../../src/adguard-cli/adguard-cli-blocker';
import { createProxyBlockerEvidenceRoute } from '../../src/proxy-blocker/proxy-evidence-route';
import { createProxyHost, type ProxyHostInput } from '../../src/adguard-cli/proxy-host';
import { TlsInterceptionOutcome } from '../../src/local/tls-interception-diagnostic';
import { PERSISTENT_CA_TEST_CERTIFICATE_PEM } from '../adguard-cli/fixtures/persistent-ca-test-authority';
import type { DownloadedOfficialFilter } from '../../src/local/official-filter-downloader';
import { AppliedRulesReadKind, type AppliedRulesReport } from '../../src/environment/applied-rules';
import { probed } from './https-filtering-proof-fixtures';

const temporaryRoots: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
});

/**
 * The exact instant shape the live route feeds the baseline host.
 */
const ACQUIRED_AT = '2026-07-30T21:14:05.123Z';

const PROFILE: ReproProfile = {
    viewport: 'desktop',
    locale: 'en-US',
    timezone: 'UTC',
    userAgentProfile: 'Chrome',
    consentStrategy: 'untouched',
};

/**
 * Minimal child stand-in whose exit contract matches what the proxy lifecycle relies on.
 */
class FakeProxyProcess extends EventEmitter {
    pid = 4242;

    exitCode: number | null = null;

    kill(): boolean {
        if (this.exitCode === null) {
            this.exitCode = 0;
            queueMicrotask(() => this.emit('exit', 0, null));
        }
        return true;
    }
}

/**
 * A stand-in engine behind the real proxy host: it writes the filter files it was given into
 * `proxy.yaml` and starts the executable with that file, so the tests read what the proxy would
 * execute without a licensed CLI.
 *
 * @param proxyInput - The host input the route builds.
 * @returns Proxy host over the stand-in engine.
 */
function standInProxyHost(proxyInput: ProxyHostInput): ReturnType<typeof createProxyHost> {
    const certificate = new X509Certificate(PERSISTENT_CA_TEST_CERTIFICATE_PEM);
    const certificatePath = join(proxyInput.workspaceDir, 'ca.pem');
    return createProxyHost(proxyInput, {
        name: 'stand-in proxy',
        async prepare() {
            await writeFile(certificatePath, PERSISTENT_CA_TEST_CERTIFICATE_PEM);
            return { certificatePath, certificateDerBase64: certificate.raw.toString('base64') };
        },
        async writeConfiguration(port, filterFilenames) {
            await writeFile(
                join(proxyInput.workspaceDir, 'proxy.yaml'),
                [`http_proxy: ${port}`, 'filters:', ...filterFilenames.map((f) => `  - ${f}`)].join(
                    '\n',
                ),
            );
        },
        command() {
            return { args: ['proxy.yaml'] };
        },
        async release() {},
    });
}

/**
 * Structured route log captured for failure diagnosis.
 */
const logRecords: Array<{ fields: unknown; message: string }> = [];

/**
 * Structured logger retaining every record for failure diagnosis.
 *
 * @returns Logger appending to {@link logRecords}.
 */
function capturingLogger(): Logger {
    const record = (fields: unknown, message: string): void => {
        logRecords.push({ fields, message });
    };
    return { info: record, warn: record, error: record } as unknown as Logger;
}

/**
 * One complete route fixture: the real proxy host over a fake process, real files on disk.
 */
interface RouteFixture {
    route: ReturnType<typeof createProxyBlockerEvidenceRoute>;
    workspaceDir: string;
    spawnedConfigs: string[];
    readConfig(): Promise<string>;
    readUserRules(): Promise<string>;
    readFilter(filterId: number): Promise<string>;
    failNextApply(): void;
}

/**
 * Build the AdGuard CLI route exactly as the live cycle does, faking only the executable and
 * browser.
 *
 * @param createBrowserSession - The browser the route launches; a closable stand-in when omitted.
 * @param probeOutcome - What the HTTPS probe sees through the proxy.
 * @returns Route plus seams observing what the proxy would execute.
 */
async function routeFixture(
    createBrowserSession: typeof BrowserSession.create = async () =>
        ({ close: async () => undefined }) as unknown as BrowserSession,
    probeOutcome: TlsInterceptionOutcome = TlsInterceptionOutcome.Filtered,
): Promise<RouteFixture> {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'adguard-cli-route-'));
    const workspaceDir = join(fixtureRoot, 'workspace');
    const filterCacheDir = await mkdtemp(join(tmpdir(), 'adguard-cli-cache-'));
    temporaryRoots.push(fixtureRoot, filterCacheDir);
    const binaryPath = join(fixtureRoot, 'adguard-cli');
    await writeFile(binaryPath, 'fixture proxy binary bytes');
    const spawnedConfigs: string[] = [];
    const downloaded: DownloadedOfficialFilter[] = [
        {
            filterId: 2,
            content: '! Base\nexample.org##.ad\n||ads.coucounews.com^\nexample.org##.shared\n',
            sha256: 'base',
            fromCache: false,
        },
        {
            filterId: 14,
            content: '! Annoyances\nexample.org##.cookie\nexample.org##.shared\n',
            sha256: 'annoyances',
            fromCache: false,
        },
    ];
    let failNextApply = false;
    const adguardCli = createAdguardCliBlocker({
        binaryPath,
        workspaceDir,
        createProxy: (proxyInput) =>
            standInProxyHost({
                ...proxyInput,
                reservePort: async () => 58_222,
                probePort: async () => true,
                spawnProcess: ((): typeof import('node:child_process').spawn => {
                    const spawn = (...args: unknown[]): FakeProxyProcess => {
                        const argv = args[1] as readonly string[];
                        spawnedConfigs.push(argv[0]!);
                        return new FakeProxyProcess();
                    };
                    return spawn as unknown as typeof import('node:child_process').spawn;
                })(),
            }),
    });
    const blocker: typeof adguardCli = {
        ...adguardCli,
        apply: async (request) => {
            if (failNextApply) {
                failNextApply = false;
                throw new Error('The proxy did not restart.');
            }
            return await adguardCli.apply(request);
        },
    };
    const route = createProxyBlockerEvidenceRoute({
        cycleId: 'cycle-fixture',
        blocker,
        workspaceDir,
        filterCacheDir,
        reporterFilterIds: [14],
        dependencies: {
            downloadFilters: async (filterIds) => ({
                filters: downloaded.filter((filter) => filterIds.includes(filter.filterId)),
                unavailableFilterIds: [],
            }),
            createBrowserSession,
            probeInterception: async (_proxyUrl, targetUrl) => probed(targetUrl, probeOutcome),
            reserveBrowserRoot: async () => {
                const root = await mkdtemp(join(tmpdir(), 'adguard-cli-browser-'));
                temporaryRoots.push(root);
                return root;
            },
        },
    });
    return {
        route,
        workspaceDir,
        spawnedConfigs,
        readConfig: () => readFile(join(workspaceDir, 'proxy.yaml'), 'utf8'),
        readUserRules: () => readFile(join(workspaceDir, 'user.txt'), 'utf8'),
        readFilter: (filterId) => readFile(join(workspaceDir, `filter-${filterId}.txt`), 'utf8'),
        failNextApply: () => {
            failNextApply = true;
        },
    };
}

/**
 * The process the preparation proof starts before any session. It runs no list and no rule, so the
 * first phase that enables a list restarts it, and a phase that enables none rides it.
 */
const PROOF_STARTS = 1;

/**
 * The page every fixture session opens.
 */
const TARGET_URL = 'https://coucounews.com/b/5JMZm0';

/**
 * Prepare the route the way the executor does before it hands the route to the run: configure it,
 * then prove the proxy filters HTTPS for the target.
 *
 * @param fixture - Route fixture.
 */
async function prepareRoute(fixture: RouteFixture): Promise<void> {
    await fixture.route.prepareConfiguration();
    const proof = await fixture.route.proveHttpsFiltering(TARGET_URL);
    expect(proof.proven).toBe(true);
}

/**
 * Launch one evidence session through the route with fixed session facts.
 *
 * @param fixture - Prepared route fixture.
 * @returns The launched session.
 */
async function launchSession(fixture: RouteFixture): Promise<BrowserSession> {
    const artifactsDir = await mkdtemp(join(tmpdir(), 'adguard-cli-artifacts-'));
    temporaryRoots.push(artifactsDir);
    try {
        return await fixture.route.launchEvidenceSession({
            targetUrl: TARGET_URL,
            reproProfile: PROFILE,
            artifactsDir,
            headless: true,
            noSandbox: false,
            logger: capturingLogger(),
        });
    } catch (error) {
        throw new Error(
            `launch failed: ${String(error)}; log=${JSON.stringify(logRecords.slice(-3))}`,
            { cause: error },
        );
    }
}

describe('createProxyBlockerEvidenceRoute', () => {
    it('launches a session only after proving HTTPS filtering, trusting the proxy authority', async () => {
        const created: Parameters<typeof BrowserSession.create>[0][] = [];
        const fixture = await routeFixture(async (config) => {
            created.push(config);
            return { close: async () => undefined } as unknown as BrowserSession;
        });
        await fixture.route.prepareConfiguration();

        await expect(launchSession(fixture)).rejects.toThrow();
        expect(created).toHaveLength(0);

        expect(await fixture.route.proveHttpsFiltering(TARGET_URL)).toMatchObject({
            proven: true,
        });
        await launchSession(fixture);
        expect(created).toHaveLength(1);
        expect(created[0]?.strictRouteAcceptProxyAuthority).toBe(true);
        await fixture.route.stop?.();
    });

    it('proves HTTPS filtering with no list running, so a list blocking the target cannot fail it', async () => {
        // A report that a site does not open names a site some list blocks outright; with the lists
        // running, the proxy refused the probe at the handshake and the run lost its environment.
        const fixture = await routeFixture();
        await prepareRoute(fixture);

        const proofConfig = await fixture.readConfig();
        expect(proofConfig).not.toContain('filter-2.txt');
        expect(proofConfig).not.toContain('filter-14.txt');
        await fixture.route.stop?.();
    });

    it('refuses sessions when the proxy did not decrypt HTTPS for the target', async () => {
        // The CLI once tunneled the reported site raw; the browser then rejected every leaf the CLI
        // minted for the other hosts, and nothing the run saw had been filtered.
        const created: unknown[] = [];
        const fixture = await routeFixture(async (config) => {
            created.push(config);
            return { close: async () => undefined } as unknown as BrowserSession;
        }, TlsInterceptionOutcome.HandshakeFailed);
        await fixture.route.prepareConfiguration();

        expect(await fixture.route.proveHttpsFiltering(TARGET_URL)).toMatchObject({
            proven: false,
            outcome: TlsInterceptionOutcome.HandshakeFailed,
        });
        await expect(launchSession(fixture)).rejects.toThrow();
        expect(created).toHaveLength(0);
        await fixture.route.stop?.();
    });

    it('byte-attributes every requested filter of the published baseline', async () => {
        const fixture = await routeFixture();
        await prepareRoute(fixture);
        const ports = fixture.route.environmentPorts();

        // The adapter folds this into its state digest under a pinned sha256 schema, so a route
        // handing over any other identity shape fails exactly at apply_rule.
        expect(ports.installationDigest).toMatch(/^[0-9a-f]{64}$/u);

        const result = await prepareProxyBlockerPublishedBaseline(
            { environment: 'adguard_cli', requestedFilterIds: [2, 14], acquiredAt: ACQUIRED_AT },
            ports.baselineHost,
        );

        expect(result).toMatchObject({ ready: true });
        if (!result.ready) {
            return;
        }
        expect(result.baseline.unattributedListKeys).toBeUndefined();
        expect(result.baseline.resources.map((resource) => resource.listKey)).toEqual([
            'adguard:2',
            'adguard:14',
        ]);
        await fixture.route.stop?.();
    });

    it('executes only the filters the established phase enabled', async () => {
        const fixture = await routeFixture();
        await prepareRoute(fixture);
        const ports = fixture.route.environmentPorts();
        await prepareProxyBlockerPublishedBaseline(
            { environment: 'adguard_cli', requestedFilterIds: [2, 14], acquiredAt: ACQUIRED_AT },
            ports.baselineHost,
        );

        // The control phase disables the whole baseline before its session opens, exactly as the
        // environment adapter does; the proxy the session then rides must execute no filter list.
        await ports.baselineHost.runBaselineAction('disable_filter', 2);
        await ports.baselineHost.runBaselineAction('disable_filter', 14);
        await launchSession(fixture);
        const controlConfig = await fixture.readConfig();
        expect(controlConfig).not.toContain('filter-2.txt');
        expect(controlConfig).not.toContain('filter-14.txt');
        expect(controlConfig).toContain('user.txt');
        expect(fixture.spawnedConfigs).toHaveLength(PROOF_STARTS);

        // The baseline phase re-enables the requested set; its session must execute both lists.
        await ports.baselineHost.runBaselineAction('enable_filter', 2);
        await ports.baselineHost.runBaselineAction('enable_filter', 14);
        await launchSession(fixture);
        const baselineConfig = await fixture.readConfig();
        expect(baselineConfig).toContain('filter-2.txt');
        expect(baselineConfig).toContain('filter-14.txt');
        expect(fixture.spawnedConfigs).toHaveLength(PROOF_STARTS + 1);

        // The same enabled set must not restart the proxy again: reconciliation acts on drift
        // alone, so back-to-back sessions of one phase ride one process.
        await launchSession(fixture);
        expect(fixture.spawnedConfigs).toHaveLength(PROOF_STARTS + 1);
        await fixture.route.stop?.();
    });

    it('keeps the enabled subset while a candidate rule is applied and revoked', async () => {
        const fixture = await routeFixture();
        await prepareRoute(fixture);
        const ports = fixture.route.environmentPorts();
        await prepareProxyBlockerPublishedBaseline(
            { environment: 'adguard_cli', requestedFilterIds: [2, 14], acquiredAt: ACQUIRED_AT },
            ports.baselineHost,
        );
        await launchSession(fixture);

        const rule = 'coucounews.com##div[class$="continue_coupang"]';
        await ports.applyCandidate!(rule);
        expect(await fixture.readUserRules()).toContain(rule);
        const candidateConfig = await fixture.readConfig();
        expect(candidateConfig).toContain('filter-2.txt');
        expect(candidateConfig).toContain('filter-14.txt');

        await ports.revokeCandidate!();
        expect(await fixture.readUserRules()).not.toContain(rule);
        await fixture.route.stop?.();
    });

    it('replaces one published line in the executed list and restores the locked bytes', async () => {
        const fixture = await routeFixture();
        await prepareRoute(fixture);
        const ports = fixture.route.environmentPorts();
        const prepared = await prepareProxyBlockerPublishedBaseline(
            { environment: 'adguard_cli', requestedFilterIds: [2, 14], acquiredAt: ACQUIRED_AT },
            ports.baselineHost,
        );
        if (!prepared.ready) {
            throw new Error('The baseline fixture did not prepare.');
        }
        const locked = prepared.baseline.resources.find(
            (resource) => resource.listKey === 'adguard:2',
        )!;
        await launchSession(fixture);
        const published = await fixture.readFilter(2);

        const outcome = await ports.applyBaselineEdit(
            '||ads.coucounews.com^',
            '||ads.coucounews.com^$third-party',
        );

        // The receipt's preimage must be the bytes the baseline locked: that is what lets the
        // adapter prove the candidate phase differs from the baseline by this one line.
        expect(outcome).toMatchObject({
            applied: true,
            receipt: {
                filterId: 2,
                beforeSha256: locked.sha256,
                replacedLineCount: 1,
                extraSourceCount: 0,
            },
        });
        if (!outcome.applied) {
            return;
        }
        expect(outcome.receipt.afterSha256).not.toBe(outcome.receipt.beforeSha256);
        expect(await fixture.readFilter(2)).toBe(
            published.replace('||ads.coucounews.com^\n', '||ads.coucounews.com^$third-party\n'),
        );
        expect(await fixture.readFilter(14)).toContain('example.org##.cookie');
        expect(fixture.spawnedConfigs).toHaveLength(PROOF_STARTS + 2);

        expect(await ports.revokeBaselineEdit()).toBe(locked.sha256);
        expect(await fixture.readFilter(2)).toBe(published);
        expect(fixture.spawnedConfigs).toHaveLength(PROOF_STARTS + 3);
        // Nothing is in effect any more, so a second revoke restarts nothing.
        expect(await ports.revokeBaselineEdit()).toBeNull();
        expect(fixture.spawnedConfigs).toHaveLength(PROOF_STARTS + 3);
        await fixture.route.stop?.();
    });

    it('restores the locked bytes on a retry after the first restore failed', async () => {
        const fixture = await routeFixture();
        await prepareRoute(fixture);
        const ports = fixture.route.environmentPorts();
        const prepared = await prepareProxyBlockerPublishedBaseline(
            { environment: 'adguard_cli', requestedFilterIds: [2, 14], acquiredAt: ACQUIRED_AT },
            ports.baselineHost,
        );
        if (!prepared.ready) {
            throw new Error('The baseline fixture did not prepare.');
        }
        const locked = prepared.baseline.resources.find(
            (resource) => resource.listKey === 'adguard:2',
        )!;
        await launchSession(fixture);
        const published = await fixture.readFilter(2);
        await ports.applyBaselineEdit('||ads.coucounews.com^', '||ads.coucounews.com^$third-party');

        fixture.failNextApply();
        await expect(ports.revokeBaselineEdit()).rejects.toThrow('The proxy did not restart.');

        // The cleanup retry must still restore the list, not report that nothing was in effect.
        expect(await ports.revokeBaselineEdit()).toBe(locked.sha256);
        expect(await fixture.readFilter(2)).toBe(published);
        await fixture.route.stop?.();
    });

    it('deletes one published line from the executed list', async () => {
        const fixture = await routeFixture();
        await prepareRoute(fixture);
        const ports = fixture.route.environmentPorts();
        await prepareProxyBlockerPublishedBaseline(
            { environment: 'adguard_cli', requestedFilterIds: [2, 14], acquiredAt: ACQUIRED_AT },
            ports.baselineHost,
        );
        await launchSession(fixture);
        const published = await fixture.readFilter(14);

        const outcome = await ports.applyBaselineRemoval('example.org##.cookie');

        expect(outcome).toMatchObject({
            applied: true,
            receipt: { filterId: 14, replacedLineCount: 1 },
        });
        expect(await fixture.readFilter(14)).toBe(published.replace('example.org##.cookie\n', ''));
        await ports.revokeBaselineEdit();
        expect(await fixture.readFilter(14)).toBe(published);
        await fixture.route.stop?.();
    });

    it('refuses a line it cannot attribute to exactly one executed list', async () => {
        const fixture = await routeFixture();
        await prepareRoute(fixture);
        const ports = fixture.route.environmentPorts();
        await prepareProxyBlockerPublishedBaseline(
            { environment: 'adguard_cli', requestedFilterIds: [2, 14], acquiredAt: ACQUIRED_AT },
            ports.baselineHost,
        );
        await launchSession(fixture);

        await expect(ports.applyBaselineRemoval('example.org##.absent')).resolves.toEqual({
            applied: false,
            refusal: 'baseline_line_not_found',
        });
        await expect(
            ports.applyBaselineEdit('example.org##.shared', 'example.org##.shared-widget'),
        ).resolves.toEqual({ applied: false, refusal: 'baseline_line_not_unique' });
        // A list the phase does not execute is not part of the baseline being corrected.
        await ports.baselineHost.runBaselineAction('disable_filter', 14);
        await expect(ports.applyBaselineRemoval('example.org##.cookie')).resolves.toEqual({
            applied: false,
            refusal: 'baseline_line_not_found',
        });
        // A refusal changed nothing: the blocker never restarted and there is nothing to restore.
        expect(fixture.spawnedConfigs).toHaveLength(PROOF_STARTS + 1);
        expect(await ports.revokeBaselineEdit()).toBeNull();
        await fixture.route.stop?.();
    });

    it('reads what the proxy logged for a session until the proxy restarts', async () => {
        const fixture = await routeFixture();
        await prepareRoute(fixture);
        await launchSession(fixture);
        const accessLog = join(fixture.workspaceDir, 'access.log');
        await writeFile(
            accessLog,
            '24.09.2026 07:56:27.010000 "manual_proxy" HTTP GET https://ads.coucounews.com/old.js ' +
                '- 0 script BLOCKED 1 ID=1 - 0b 0ms -- ||ads.coucounews.com^\n',
        );

        // A session whose page loaded nothing from the proxy yet: no content script, no frame.
        const session = {
            getPage: () => ({ on: () => undefined, frames: () => [] }),
        } as unknown as BrowserSession;
        const log = await fixture.route.openAppliedRulesLog(session, {
            warn: () => undefined,
        } as unknown as Logger);
        await appendFile(
            accessLog,
            '24.09.2026 07:57:36.537000 "manual_proxy" HTTP GET https://ads.coucounews.com/new.js ' +
                '- 0 script BLOCKED 1 ID=1 - 0b 1ms -- ||ads.coucounews.com^\n',
        );
        const read = await log.read('https://coucounews.com/b/5JMZm0');

        expect(read.kind).toBe(AppliedRulesReadKind.Report);
        const report = (read as { report: AppliedRulesReport }).report;
        expect(report.events.map((event) => [event.target, event.filterIds])).toEqual([
            ['https://ads.coucounews.com/new.js', [2]],
        ]);
        expect(report.lists).toEqual([{ id: 2, name: 'AdGuard Base filter' }]);

        await fixture.route.environmentPorts().applyCandidate!('coucounews.com##.ad');
        expect(await log.read('https://coucounews.com/b/5JMZm0')).toMatchObject({
            kind: AppliedRulesReadKind.Unavailable,
        });
        await fixture.route.stop?.();
    });

    it('reads a request the proxy answered for a blocking rule as blocked', async () => {
        // AdguardFilters #242675: the proxy served its stub 500 for every request the candidate
        // `||thebicyclehut.com^` stopped, the session recorded them as completed, and the block
        // was judged to have let the requests through.
        let responseListener: ((response: unknown) => void) | undefined;
        const page = {
            setViewportSize: async () => undefined,
            on: (event: string, listener: (response: unknown) => void) => {
                if (event === 'response') {
                    responseListener = listener;
                }
            },
        };
        const fixture = await routeFixture(
            async (config) =>
                // The route's own session configuration, launched on a stand-in engine: only the
                // strict-route launch channel is left out.
                await BrowserSession.create({
                    ...config,
                    strictRoute: undefined,
                    strictRouteTargetUrl: undefined,
                    engine: {
                        browserType: 'stand-in',
                        consoleCoverage: ConsoleCoverage.BrowserLogOnly,
                        launch: async () =>
                            ({
                                newPage: async () => page,
                            }) as unknown as import('playwright-core').Browser,
                    },
                }),
        );
        await prepareRoute(fixture);
        const accessLog = join(fixture.workspaceDir, 'access.log');
        // Blocked before the session launched: another session's request.
        await writeFile(
            accessLog,
            '27.09.2026 07:06:20.000000 "manual_proxy" HTTP GET https://ads.coucounews.com/old.js ' +
                '- 0 script BLOCKED 1 ID=1 - 0b 0ms -- ||ads.coucounews.com^\n',
        );
        const session = await launchSession(fixture);
        const respond = (url: string, status: number): void =>
            responseListener!({
                request: () => ({
                    url: () => url,
                    method: () => 'GET',
                    resourceType: () => 'script',
                    headers: () => ({}),
                }),
                status: () => status,
                headers: () => ({ 'content-length': '24' }),
            });
        for (const url of [
            'https://ads.coucounews.com/old.js',
            'https://ads.coucounews.com/new.js',
            'https://ads.coucounews.com/allowed.js',
            'https://coucounews.com/app.js',
        ]) {
            respond(url, url.endsWith('app.js') ? 200 : 500);
        }
        await appendFile(
            accessLog,
            '27.09.2026 07:06:27.063000 "manual_proxy" HTTP GET https://ads.coucounews.com/new.js ' +
                '- 0 script BLOCKED 1 ID=1 - 0b 1ms -- ||ads.coucounews.com^\n' +
                '27.09.2026 07:06:27.070000 "manual_proxy" HTTP GET ' +
                'https://ads.coucounews.com/allowed.js - 500 script ALLOWED 1 ID=1 203.0.113.7:443 ' +
                '24b 1ms -- @@||ads.coucounews.com/allowed.js\n' +
                '27.09.2026 07:06:27.090000 "manual_proxy" HTTP GET https://coucounews.com/app.js ' +
                '- 200 script NONE 0 - 203.0.113.7:443 534b 29ms -- \n',
        );

        // The blocker log is read in the background, so the block shows on a read after it lands.
        await vi.waitFor(() =>
            expect(session.getNetworkLog().map((entry) => [entry.url, entry.statusCode])).toEqual([
                ['https://ads.coucounews.com/old.js', 500],
                ['https://ads.coucounews.com/new.js', 0],
                ['https://ads.coucounews.com/allowed.js', 500],
                ['https://coucounews.com/app.js', 200],
            ]),
        );
        await fixture.route.stop?.();
    });
});
