import { describe, expect, it, vi } from 'vitest';
import type { IssueFacts } from '../../src/types/issue-facts';
import {
    EnvironmentCapability,
    EnvironmentPreparationState,
    FilteringEnvironmentAvailability,
    type FilteringEnvironmentDescriptor,
} from '../../src/environment/environment-vocabulary';
import { EnvironmentSelectionHost } from '../../src/environment/environment-selection';
import { BrowserExtensionEnvironmentAdapter } from '../../src/environment/browser-extension-environment';
import type { BrowserExtensionEnvironmentOptions } from '../../src/environment/browser-extension-environment';
import { FilteringExecutorRegistry } from '../../src/orchestrator/filtering-executors';
import {
    filteringExecutors,
    resolveRunExecutors,
    type ExecutorActivationContext,
    type ExecutorAdapterContext,
    type FilteringExecutor,
} from '../../src/orchestrator/filtering-executors';
import { extensionFilteringExecutor } from '../../src/orchestrator/extension-filtering-executor';

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

/**
 * Fake executor descriptor for hermetic registry tests.
 *
 * @param name - Executor name the descriptor must carry.
 * @returns Fresh minimal descriptor owned by the fake executor.
 */
function fakeDescriptor(name: string): FilteringEnvironmentDescriptor {
    return {
        kind: name,
        availability: FilteringEnvironmentAvailability.Available,
        preparationState: EnvironmentPreparationState.NotStarted,
        limitationCode: null,
        capabilities: [EnvironmentCapability.FilteringControl],
    };
}

/**
 * Fake executor recording its lifecycle calls.
 *
 * @param name - Executor name to register under.
 * @param toolCalls - Spy recording the runtime-host calls activate made.
 * @returns Fresh fake executor.
 */
function fakeExecutor(
    name: string,
    toolCalls: { activated: string[]; enabledExtensionTools: string[] },
): FilteringExecutor {
    return {
        name,
        descriptor: fakeDescriptor(name),
        selectionGuidance: `Fake guidance for ${name}.`,
        activate: async () => {
            toolCalls.activated.push(name);
        },
        createAdapter: () => {
            throw new Error(`The fake executor ${name} builds no adapter.`);
        },
    };
}

const toolCalls = {
    activated: [] as string[],
    enabledExtensionTools: [] as string[],
};

/**
 * Build an adapter context the extension executor's createAdapter accepts.
 *
 * @returns Minimal adapter context with inert extension options.
 */
function adapterContext(): ExecutorAdapterContext {
    const options: BrowserExtensionEnvironmentOptions = {
        extensionRoot: '/tmp/fake-extension',
        packageVersion: '5.4.3',
        manifestVersion: '5.4.3.95',
        profileKind: 'agent_selected',
        application: 'The built-in instruction version.',
        buildDigest: 'a'.repeat(64),
        settingsProvider: async () => {
            throw new Error('not used');
        },
        createSession: async () => {
            throw new Error('not used');
        },
        phaseConfiguration: async () => {
            throw new Error('not used');
        },
    };
    return {
        requestedLists: [],
        extensionOptions: options,
        evidenceRoute: null,
        launchEvidenceSession: async () => {
            throw new Error('not used');
        },
    };
}

describe('FilteringExecutorRegistry', () => {
    it('preserves registration order in names()', () => {
        const registry = new FilteringExecutorRegistry();
        registry.register(fakeExecutor('gamma_executor', toolCalls));
        registry.register(fakeExecutor('alpha_executor', toolCalls));
        expect(registry.names()).toEqual(['gamma_executor', 'alpha_executor']);
    });

    it('rejects a duplicate registration by naming the executor', () => {
        const registry = new FilteringExecutorRegistry();
        registry.register(fakeExecutor('dupe_executor', toolCalls));
        expect(() => registry.register(fakeExecutor('dupe_executor', toolCalls))).toThrow(
            /dupe_executor/u,
        );
    });

    it('rejects a registration whose descriptor names another executor', () => {
        const registry = new FilteringExecutorRegistry();
        const executor = fakeExecutor('policy_executor', toolCalls);
        registry.register(executor);
        const hermetic = new FilteringExecutorRegistry();
        const mismatched = {
            ...executor,
            descriptor: fakeDescriptor('other_executor'),
        };
        expect(() => hermetic.register(mismatched)).toThrow(/other_executor/u);
        // The failed check must not have registered anything.
        expect(hermetic.has('policy_executor')).toBe(false);
        expect(hermetic.has('other_executor')).toBe(false);
        // The original registration stays intact on its own registry.
        expect(registry.get('policy_executor')?.name).toBe('policy_executor');
    });

    it('keeps hermetic instances isolated from the module global', () => {
        expect(filteringExecutors.has('browser_extension')).toBe(true);
        const hermetic = new FilteringExecutorRegistry();
        expect(hermetic.has('browser_extension')).toBe(false);
        hermetic.register(fakeExecutor('local_executor', toolCalls));
        expect(filteringExecutors.has('local_executor')).toBe(false);
    });
});

describe('resolveRunExecutors', () => {
    it('resolves the registered set when the run names none', () => {
        const registry = new FilteringExecutorRegistry();
        registry.register(fakeExecutor('a', toolCalls));
        registry.register(fakeExecutor('b', toolCalls));
        expect(resolveRunExecutors(undefined, registry).map((executor) => executor.name)).toEqual([
            'a',
            'b',
        ]);
    });

    it('rejects an unknown run executor naming it and the registered set', () => {
        const registry = new FilteringExecutorRegistry();
        registry.register(fakeExecutor('a', toolCalls));
        registry.register(fakeExecutor('b', toolCalls));
        expect(() => resolveRunExecutors(['a', 'ghost'], registry)).toThrow(
            'Unknown executor "ghost". Registered executors: a, b.',
        );
    });

    it('rejects a run that names no executor at all', () => {
        const registry = new FilteringExecutorRegistry();
        registry.register(fakeExecutor('a', toolCalls));
        expect(() => resolveRunExecutors([], registry)).toThrow(/no executor/i);
    });

    it('resolves the requested order and rejects repeated names', () => {
        const registry = new FilteringExecutorRegistry();
        registry.register(fakeExecutor('a', toolCalls));
        registry.register(fakeExecutor('b', toolCalls));
        expect(resolveRunExecutors(['b', 'a'], registry).map((executor) => executor.name)).toEqual([
            'b',
            'a',
        ]);
        expect(() => resolveRunExecutors(['a', 'a'], registry)).toThrow(/twice/u);
    });
});

describe('extensionFilteringExecutor', () => {
    it('registers itself in the module global under its executor name', () => {
        expect(filteringExecutors.get('browser_extension')).toBe(extensionFilteringExecutor);
    });

    it("carries today's extension descriptor and routing guidance", () => {
        expect(extensionFilteringExecutor.descriptor).toMatchObject({
            kind: 'browser_extension',
            availability: 'available',
            preparationState: 'not_started',
            limitationCode: null,
            capabilities: [
                'browser_navigation',
                'filtering_control',
                'extension_filtering',
                'candidate_application',
                'baseline_integrity',
                'phase_proof',
            ],
        });
        expect(extensionFilteringExecutor.selectionGuidance).toMatch(/extension/i);
    });

    it('exposes extension lifecycle tools only for a ready accepted selection', async () => {
        const runtime = {
            activateEvidenceRoute: vi.fn(),
            enableExtensionLifecycleTools: vi.fn(),
        };
        const host = new EnvironmentSelectionHost(facts, [
            {
                kind: 'browser_extension',
                availability: FilteringEnvironmentAvailability.Available,
                preparationState: EnvironmentPreparationState.NotStarted,
                limitationCode: null,
                capabilities: [
                    EnvironmentCapability.BrowserNavigation,
                    EnvironmentCapability.FilteringControl,
                    EnvironmentCapability.ExtensionFiltering,
                    EnvironmentCapability.CandidateApplication,
                    EnvironmentCapability.BaselineIntegrity,
                    EnvironmentCapability.PhaseProof,
                ],
            },
        ]);

        // A locked but capability-limited selection must not expose the lifecycle tools.
        await host.select({
            kind: 'browser_extension',
            requiredCapabilities: ['cli_filtering'],
            intent: {
                issueType: 'ads',
                rationale: 'The report describes a website advertisement.',
                confidence: 0.9,
                evidence: [{ source: 'issue_body', observation: 'A banner remains visible.' }],
                conflicts: [],
            },
            rationale: 'Lock the extension environment.',
            confidence: 0.9,
        });
        const context: ExecutorActivationContext = {
            environmentHost: host,
            issueFacts: facts,
            targetUrl: 'https://example.test/',
            reporterFilterIds: [2],
            runtime,
        };
        await extensionFilteringExecutor.activate(context);
        expect(runtime.enableExtensionLifecycleTools).not.toHaveBeenCalled();

        // A ready selection must expose them.
        const readyHost = new EnvironmentSelectionHost(facts, [
            {
                kind: 'browser_extension',
                availability: FilteringEnvironmentAvailability.Available,
                preparationState: EnvironmentPreparationState.NotStarted,
                limitationCode: null,
                capabilities: [
                    EnvironmentCapability.BrowserNavigation,
                    EnvironmentCapability.FilteringControl,
                    EnvironmentCapability.ExtensionFiltering,
                    EnvironmentCapability.CandidateApplication,
                    EnvironmentCapability.BaselineIntegrity,
                    EnvironmentCapability.PhaseProof,
                ],
            },
        ]);
        readyHost.select({
            kind: 'browser_extension',
            requiredCapabilities: [],
            intent: {
                issueType: 'ads',
                rationale: 'The report describes a website advertisement.',
                confidence: 0.9,
                evidence: [{ source: 'issue_body', observation: 'A banner remains visible.' }],
                conflicts: [],
            },
            rationale: 'Lock the extension environment.',
            confidence: 0.9,
        });
        await extensionFilteringExecutor.activate({
            ...context,
            environmentHost: readyHost,
        });
        expect(runtime.enableExtensionLifecycleTools).toHaveBeenCalledTimes(1);
        expect(runtime.activateEvidenceRoute).not.toHaveBeenCalled();
    });

    it('builds the browser-extension adapter from the context options', () => {
        const adapter = extensionFilteringExecutor.createAdapter(adapterContext());
        expect(adapter).toBeInstanceOf(BrowserExtensionEnvironmentAdapter);
        expect(adapter.kind).toBe('browser_extension');
    });
});
