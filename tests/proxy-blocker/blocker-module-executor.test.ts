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
import { type FilteringEnvironmentDescriptor } from '../../src/environment/environment-vocabulary';
import { EnvironmentSelectionHost } from '../../src/environment/environment-selection';
import type { ExecutorActivationContext } from '../../src/orchestrator/filtering-executors';
import {
    createBlockerModuleExecutor,
    type BlockerModuleRunDependencies,
} from '../../src/proxy-blocker/blocker-module-executor';
import type { IssueFacts } from '../../src/types/issue-facts';

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

function fakeBlocker(describeModule: () => Promise<BlockerDescription>): BlockerContract {
    return {
        describe: describeModule,
        start: vi.fn(),
        apply: vi.fn(),
        state: vi.fn(),
        log: vi.fn(),
        stop: vi.fn(async () => ({ licenceReleased: false })),
    };
}

/**
 * Lock the module's executor as the run's selection, the way select_environment does.
 */
function lockedHost(): EnvironmentSelectionHost {
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
        requiredCapabilities: [],
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
): Promise<EnvironmentSelectionHost> {
    const host = lockedHost();
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

    it('refuses a module speaking another contract version', async () => {
        const host = await activate(
            fakeBlocker(async () => description({ contractVersion: BLOCKER_CONTRACT_VERSION + 1 })),
        );

        expect(host.snapshot()?.cliPreparation).toMatchObject({
            limitation: { code: 'contract_version_mismatch' },
        });
    });
});
