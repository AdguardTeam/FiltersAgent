import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    BLOCKER_CONTRACT_VERSION,
    BlockerKind,
    type BlockerContract,
    type BlockerDescription,
} from '../../src/blocker-contract/blocker-contract';
import {
    EnvironmentCapability,
    type FilteringEnvironmentDescriptor,
} from '../../src/environment/environment-vocabulary';
import { EnvironmentSelectionHost } from '../../src/environment/environment-selection';
import type { ExecutorActivationContext } from '../../src/orchestrator/filtering-executors';
import {
    createBlockerModuleExecutor,
    type BlockerModuleRunDependencies,
} from '../../src/proxy-blocker/blocker-module-executor';
import { TlsInterceptionOutcome } from '../../src/local/tls-interception-diagnostic';
import type { IssueFacts } from '../../src/types/issue-facts';
import { probed } from './https-filtering-proof-fixtures';

const EXECUTOR = 'fake_proxy';

const facts: IssueFacts = {
    issueNumber: 42,
    issueUrl: 'https://github.com/AdguardTeam/AdguardFilters/issues/42',
    reportedSiteUrls: ['https://example.test/'],
    labels: ['T: Ads', 'N: AdGuard for Windows'],
    declaredIssueType: 'Ads',
    problemType: 'ads',
    product: 'AdGuard for Windows',
    os: 'Windows 11',
    browser: 'Edge',
    enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
    screenshots: [],
};

const temporaryRoots: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
});

function description(overrides: Partial<BlockerDescription> = {}): BlockerDescription {
    return {
        contractVersion: BLOCKER_CONTRACT_VERSION,
        product: 'Fake blocker',
        version: '1.0.0',
        binarySha256: 'd'.repeat(64),
        kind: BlockerKind.Proxy,
        covers: 'everything',
        notReported: [],
        pageEvidence: null,
        ...overrides,
    };
}

function fakeBlocker(
    describeModule: () => Promise<BlockerDescription>,
    start: BlockerContract['start'] = async () => ({
        revision: 1,
        route: { proxyUrl: 'http://127.0.0.1:3129', certificateDerBase64: 'Y2E=' },
    }),
): BlockerContract {
    return {
        describe: describeModule,
        start: vi.fn(start),
        apply: vi.fn(),
        state: vi.fn(async () => ({
            running: true,
            revision: 1,
            port: 3129,
            lists: [],
            userRules: [],
        })),
        log: vi.fn(async () => ({ revision: 1, cursor: '0', events: [] })),
        stop: vi.fn(async () => ({ licenceReleased: false })),
    };
}

/**
 * Lock the module's executor as the run's selection, the way select_environment does.
 *
 * @param requiredCapabilities - The capabilities the selection requires.
 */
function lockedHost(requiredCapabilities: EnvironmentCapability[] = []): EnvironmentSelectionHost {
    const executor = createBlockerModuleExecutor({
        executor: EXECUTOR,
        selectionGuidance: 'Route desktop reports here.',
    });
    const host = new EnvironmentSelectionHost(
        facts,
        [executor.descriptor as FilteringEnvironmentDescriptor],
        { now: () => '2026-08-01T12:00:00.000Z' },
    );
    host.select({
        kind: EXECUTOR,
        requiredCapabilities,
        intent: {
            issueType: 'ads',
            rationale: 'The desktop report describes ordinary website filtering.',
            confidence: 0.8,
            evidence: [{ source: 'issue_body', observation: 'A visible ad remains.' }],
            conflicts: [],
        },
        rationale: 'Use the proxy executor.',
        confidence: 0.8,
    });
    return host;
}

async function activate(
    blocker: BlockerContract | null,
    activateEvidenceRoute = vi.fn(),
    requiredCapabilities: EnvironmentCapability[] = [],
    probeOutcome: TlsInterceptionOutcome = TlsInterceptionOutcome.Filtered,
): Promise<EnvironmentSelectionHost> {
    const host = lockedHost(requiredCapabilities);
    const workspaceDir = await mkdtemp(join(tmpdir(), 'module-executor-'));
    temporaryRoots.push(workspaceDir);
    const dependencies: BlockerModuleRunDependencies | undefined =
        blocker === null
            ? undefined
            : {
                  startBlocker: () => blocker,
                  workspaceDir,
                  filterCacheDir: workspaceDir,
                  routeDependencies: {
                      downloadFilters: async () => ({
                          filters: [
                              {
                                  filterId: 2,
                                  content: '||ads.example^\n',
                                  sha256: 'x',
                                  fromCache: true,
                              },
                          ],
                          unavailableFilterIds: [],
                      }),
                      probeInterception: async (_proxyUrl, targetUrl) =>
                          probed(targetUrl, probeOutcome),
                  },
              };
    const context: ExecutorActivationContext = {
        environmentHost: host,
        issueFacts: facts,
        targetUrl: 'https://example.test/',
        reporterFilterIds: [2],
        runtime: {
            activateEvidenceRoute,
            enableExtensionLifecycleTools: () => {
                throw new Error('a proxy module exposes no extension tools');
            },
        },
        ...(dependencies === undefined
            ? {}
            : { executorDependencies: { [EXECUTOR]: dependencies } }),
    };
    await createBlockerModuleExecutor({
        executor: EXECUTOR,
        selectionGuidance: 'Route desktop reports here.',
    }).activate(context);
    return host;
}

describe('createBlockerModuleExecutor', () => {
    it('binds the module’s own description as path-free ready provenance', async () => {
        const activateEvidenceRoute = vi.fn();
        const host = await activate(
            fakeBlocker(async () => description()),
            activateEvidenceRoute,
        );

        const snapshot = host.snapshot();
        expect(snapshot?.state).toBe('ready');
        expect(snapshot?.cliPreparation).toMatchObject({
            state: 'ready',
            provenance: {
                source: 'blocker_module',
                product: 'Fake blocker',
                version: '1.0.0',
                digestB32: '3XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XOQ',
            },
        });
        expect(activateEvidenceRoute).toHaveBeenCalledOnce();
        expect(JSON.stringify(snapshot)).not.toContain(tmpdir());
    });

    it('advertises before selection exactly what its ready route grants', async () => {
        // A model that read only the preparation capabilities judged the module unable to browse
        // or apply a rule, and kept reports whose product filters at the network level on the
        // extension.
        const { descriptor } = createBlockerModuleExecutor({
            executor: EXECUTOR,
            selectionGuidance: 'Route desktop reports here.',
        });
        const prepared = descriptor.preparedCapabilities ?? [];

        const host = await activate(
            fakeBlocker(async () => description()),
            vi.fn(),
            prepared,
        );
        host.attachCliEvidenceRouteReady(EXECUTOR);

        expect(prepared).toEqual(
            expect.arrayContaining([
                EnvironmentCapability.BrowserNavigation,
                EnvironmentCapability.CandidateApplication,
            ]),
        );
        expect(host.capabilities()[0]?.preparedCapabilities).toEqual(prepared);
        expect(host.snapshot()?.state).toBe('ready');
        expect(host.snapshot()?.missingCapabilities).toEqual([]);
    });

    it('hands apply_rule the lists the route runs when the report has no settings link', async () => {
        // A report without a settings link names no filters; the route still runs AdGuard Base,
        // and an empty apply_rule baseline was refused as an invalid catalog selection.
        const activateEvidenceRoute = vi.fn();
        await activate(
            fakeBlocker(async () => description()),
            activateEvidenceRoute,
        );

        expect(activateEvidenceRoute).toHaveBeenCalledWith(expect.anything(), [2]);
    });

    it('ends capability-limited when the run provides no module', async () => {
        const host = await activate(null);

        expect(host.snapshot()).toMatchObject({
            state: 'capability_limited',
            cliPreparation: {
                state: 'limited',
                limitation: { code: 'module_not_provided', stage: 'module' },
            },
        });
    });

    it('ends capability-limited and stops a module that cannot describe itself', async () => {
        const blocker = fakeBlocker(async () => {
            throw new Error('The AdGuard CLI module is not configured: set ADGUARD_CLI_PATH.');
        });
        const host = await activate(blocker);

        expect(host.snapshot()?.cliPreparation).toMatchObject({
            limitation: { code: 'module_failed', stage: 'module' },
        });
        expect(blocker.stop).toHaveBeenCalledOnce();
    });

    it('calls the environment ready only after an HTTPS request went through the blocker', async () => {
        const blocker = fakeBlocker(async () => description());
        const activateEvidenceRoute = vi.fn();
        const host = await activate(blocker, activateEvidenceRoute);

        expect(blocker.start).toHaveBeenCalledOnce();
        expect(host.snapshot()?.state).toBe('ready');
        expect(activateEvidenceRoute).toHaveBeenCalledOnce();
    });

    it.each([
        TlsInterceptionOutcome.HandshakeFailed,
        TlsInterceptionOutcome.NotIntercepted,
        TlsInterceptionOutcome.NoResponse,
        TlsInterceptionOutcome.ProxyConnectFailed,
    ])(
        'ends capability-limited and stops the blocker when HTTPS is %s for the target',
        async (outcome) => {
            // The CLI once tunneled the reported site raw while the run called its environment
            // ready, and the report drew conclusions from traffic nothing had filtered.
            const blocker = fakeBlocker(async () => description());
            const activateEvidenceRoute = vi.fn();
            const host = await activate(blocker, activateEvidenceRoute, [], outcome);

            expect(host.snapshot()).toMatchObject({
                state: 'capability_limited',
                cliPreparation: {
                    state: 'limited',
                    limitation: { stage: 'filtering', code: 'https_filtering_unproven' },
                },
            });
            expect(host.snapshot()?.cliPreparation).toMatchObject({
                limitation: { detail: expect.stringContaining('example.test') },
            });
            expect(activateEvidenceRoute).not.toHaveBeenCalled();
            expect(blocker.stop).toHaveBeenCalledOnce();
        },
    );

    it('ends capability-limited when the blocker cannot start its proxy', async () => {
        const blocker = fakeBlocker(
            async () => description(),
            async () => {
                throw new Error('The AdGuard CLI licence did not activate.');
            },
        );
        const activateEvidenceRoute = vi.fn();
        const host = await activate(blocker, activateEvidenceRoute);

        expect(host.snapshot()?.cliPreparation).toMatchObject({
            limitation: { stage: 'filtering', code: 'blocker_start_failed' },
        });
        expect(activateEvidenceRoute).not.toHaveBeenCalled();
        expect(blocker.stop).toHaveBeenCalledOnce();
    });

    it('refuses a module speaking another contract version', async () => {
        const host = await activate(
            fakeBlocker(async () => description({ contractVersion: BLOCKER_CONTRACT_VERSION + 1 })),
        );

        expect(host.snapshot()?.cliPreparation).toMatchObject({
            limitation: { code: 'contract_version_mismatch' },
        });
    });
});
