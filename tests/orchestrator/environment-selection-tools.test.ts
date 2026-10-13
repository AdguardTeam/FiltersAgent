import { describe, expect, it } from 'vitest';
import type { IssueFacts } from '../../src/types/issue-facts';
import {
    EnvironmentCapability,
    EnvironmentLimitationCode,
    EnvironmentPreparationState,
    EnvironmentSelectionReservedCase,
    EnvironmentSelectionState,
    FilteringEnvironmentAvailability,
    type FilteringEnvironmentDescriptor,
} from '../../src/environment/environment-vocabulary';
import { EnvironmentSelectionHost } from '../../src/environment/environment-selection';
import type { ExecutorPreparationOutcome } from '../../src/environment/executor-preparation';
import type { EvidenceRouteHost } from '../../src/local/evidence-route-contract';
import { ToolRegistry } from '../../src/agent/tool-registry';
import type {
    ExecutorActivationContext,
    ExecutorRuntimeHost,
    FilteringExecutor,
} from '../../src/orchestrator/filtering-executors';
import {
    registerEnvironmentSelectionTools,
    type EnvironmentSelectionToolsHost,
} from '../../src/orchestrator/environment-selection-tools';

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
    settingsImportUrl:
        'https://reports.adguard.com/settings/import.html?scheme_version=4&' +
        'product_version=5.4.3.99&regular_filters=2&stealth.enabled=0',
};

/**
 * One activation the chosen registration left behind at the dispatch boundary.
 */
interface RecordedActivation {
    /**
     * Name of the executor whose activate ran.
     */
    executor: string;

    /**
     * Target URL the activation context locked.
     */
    targetUrl: string;

    /**
     * Reporter filter identifiers the activation context carried.
     */
    reporterFilterIds: readonly number[];
}

/**
 * The runtime-host effects the fake executor activations drove, for boundary assertions.
 */
interface RuntimeHostEffects {
    /**
     * Evidence routes the fakes adopted through the runtime host.
     */
    activatedRoutes: EvidenceRouteHost[];

    /**
     * How often a fake exposed the extension lifecycle tools.
     */
    extensionToolsRequests: number;
}

/**
 * Build an available ready-executing descriptor for one test executor name.
 *
 * @param name - Executor name the descriptor and its registration share.
 * @returns Available `not_started` descriptor advertising the shared baseline capabilities.
 */
function readyDescriptor(name: string): FilteringEnvironmentDescriptor {
    return {
        kind: name,
        availability: FilteringEnvironmentAvailability.Available,
        preparationState: EnvironmentPreparationState.NotStarted,
        limitationCode: null,
        capabilities: [
            EnvironmentCapability.BrowserNavigation,
            EnvironmentCapability.FilteringControl,
        ],
    };
}

/**
 * Build a preparable descriptor for one test executor name: the lock starts `preparing` and the
 * registration's activation binds the durable preparation outcome.
 *
 * @param name - Executor name the descriptor and its registration share.
 * @returns Available `preparable` descriptor.
 */
function preparableDescriptor(name: string): FilteringEnvironmentDescriptor {
    return {
        kind: name,
        availability: FilteringEnvironmentAvailability.Available,
        preparationState: EnvironmentPreparationState.Preparable,
        limitationCode: null,
        capabilities: [EnvironmentCapability.CliInstallation, EnvironmentCapability.CliActivation],
    };
}

/**
 * Build one fake registration whose activation records itself and drives the configured behaviors,
 * so dispatch assertions observe the exact boundary the handler crosses.
 *
 * @param input - Descriptor and optional activation behavior of the fake registration.
 * @param input.descriptor - Descriptor the registration advertises.
 * @param input.selectionGuidance - Model-facing routing prose the description composes.
 * @param input.activate - Optional activation behavior; defaults to a no-op.
 * @param input.record - Optional recorder for the activation context the handler passed.
 * @returns The fake registration.
 */
function fakeExecutor(input: {
    descriptor: FilteringEnvironmentDescriptor;
    selectionGuidance?: string;
    activate?: (context: ExecutorActivationContext) => Promise<void>;
    record?: (recorded: RecordedActivation) => void;
}): FilteringExecutor {
    return {
        name: input.descriptor.kind,
        descriptor: input.descriptor,
        selectionGuidance: input.selectionGuidance ?? `Guidance for ${input.descriptor.kind}.`,
        activate: async (context) => {
            input.record?.({
                executor: input.descriptor.kind,
                targetUrl: context.targetUrl,
                reporterFilterIds: context.reporterFilterIds,
            });
            await input.activate?.(context);
        },
        createAdapter: () => {
            throw new Error('createAdapter is not part of this suite contract.');
        },
    };
}

/**
 * Build the tools host this suite acts through: a constructed selection host over the given
 * registrations' descriptors, recording runtime-host effects the activations drive.
 *
 * @param executors - The run's resolved fake registrations.
 * @param activationRecorder - Optional sink for every activation context the handler passes.
 * @returns The host, the recording effect tracker, and the constructed selection host.
 */
function toolsHost(executors: readonly FilteringExecutor[]): {
    host: EnvironmentSelectionToolsHost;
    effects: RuntimeHostEffects;
    selectionHost: EnvironmentSelectionHost;
} {
    const selectionHost = new EnvironmentSelectionHost(
        facts,
        executors.map((executor) => executor.descriptor),
        { now: () => '2026-07-23T20:00:00.000Z' },
    );
    const effects: RuntimeHostEffects = { activatedRoutes: [], extensionToolsRequests: 0 };
    const runtime: ExecutorRuntimeHost = {
        activateEvidenceRoute: (route) => {
            effects.activatedRoutes.push(route);
        },
        enableExtensionLifecycleTools: () => {
            effects.extensionToolsRequests += 1;
        },
    };
    return {
        host: {
            environmentHost: selectionHost,
            executors: [...executors],
            markBaseTool: () => undefined,
            activateEvidenceRoute: (route, reporterFilterIds) =>
                runtime.activateEvidenceRoute(route, reporterFilterIds),
            enableExtensionLifecycleTools: () => runtime.enableExtensionLifecycleTools(),
            activateExecutor: async (registration) => {
                await registration.activate({
                    environmentHost: selectionHost,
                    issueFacts: facts,
                    targetUrl: 'https://example.test/article',
                    reporterFilterIds: [2],
                    runtime,
                });
            },
        },
        effects,
        selectionHost,
    };
}

/**
 * Build a select_environment request naming one kind.
 *
 * @param kind - Executor name or reserved case the request picks.
 * @returns The tool-arguments record.
 */
function selectionRequest(kind: string): Record<string, unknown> {
    return {
        kind,
        requiredCapabilities: [],
        intent: {
            issueType: 'ads',
            rationale: 'The issue evidence was classified by the agent.',
            confidence: 0.9,
            evidence: [{ source: 'issue_body', observation: 'The report describes the symptom.' }],
            conflicts: [],
        },
        rationale: 'This environment best matches the available evidence and capabilities.',
        confidence: 0.85,
    };
}

/**
 * Read one registered definition from the registry, failing the test when absent.
 *
 * @param registry - Registry the tools registered into.
 * @param name - Tool name to read.
 * @returns The registered definition.
 */
function registeredDefinition(registry: ToolRegistry, name: string) {
    const definition = registry
        .getDefinitions()
        .find((candidate) => candidate.function.name === name);
    expect(definition, `expected ${name} to be registered`).toBeDefined();
    return definition!;
}

describe('registerEnvironmentSelectionTools', () => {
    it('dispatches the accepted selection through the chosen registration activate', async () => {
        const activatedRoute: EvidenceRouteHost = {
            prepareConfiguration: async () => undefined,
            launchEvidenceSession: async () => {
                throw new Error('not used');
            },
            environmentPorts: () => {
                throw new Error('not used');
            },
            openAppliedRulesLog: () => {
                throw new Error('not used');
            },
            snapshot: () => {
                throw new Error('not used');
            },
        };
        const activations: RecordedActivation[] = [];
        const alpha = fakeExecutor({
            descriptor: readyDescriptor('alpha_probe'),
            activate: async (context) => {
                context.runtime.activateEvidenceRoute(activatedRoute, [2]);
            },
            record: (recorded) => activations.push(recorded),
        });
        const beta = fakeExecutor({ descriptor: readyDescriptor('beta_probe') });
        const { host, effects } = toolsHost([alpha, beta]);
        const registry = new ToolRegistry();
        registerEnvironmentSelectionTools(registry, host);

        const result = await registry.dispatch('select_environment', {
            ...selectionRequest('alpha_probe'),
        });

        expect(result).toMatchObject({ accepted: true, kind: 'alpha_probe', state: 'ready' });
        expect(activations).toEqual([
            {
                executor: 'alpha_probe',
                targetUrl: 'https://example.test/article',
                reporterFilterIds: [2],
            },
        ]);
        expect(effects.activatedRoutes).toEqual([activatedRoute]);
        expect(effects.extensionToolsRequests).toBe(0);
    });

    it('never activates an executor for the reserved unsupported-product case', async () => {
        const activations: RecordedActivation[] = [];
        const alpha = fakeExecutor({
            descriptor: readyDescriptor('alpha_probe'),
            record: (recorded) => activations.push(recorded),
        });
        const { host } = toolsHost([
            alpha,
            fakeExecutor({ descriptor: readyDescriptor('beta_probe') }),
        ]);
        const registry = new ToolRegistry();
        registerEnvironmentSelectionTools(registry, host);

        const result = await registry.dispatch('select_environment', {
            ...selectionRequest(EnvironmentSelectionReservedCase.UnsupportedProductCase),
        });

        expect(result).toMatchObject({
            accepted: true,
            kind: 'unsupported_product_case',
            state: 'unsupported',
        });
        expect(activations).toEqual([]);
    });

    it('composes the description from the generic skeleton, available guidance, and the reserved sentence', () => {
        const alpha = fakeExecutor({
            descriptor: readyDescriptor('alpha_probe'),
            selectionGuidance: 'Alpha reports belong to alpha_probe.',
        });
        const beta = fakeExecutor({
            descriptor: readyDescriptor('beta_probe'),
            selectionGuidance: 'Beta reports belong to beta_probe.',
        });
        const dimmed = fakeExecutor({
            descriptor: {
                ...readyDescriptor('dimmed_probe'),
                availability: FilteringEnvironmentAvailability.Unavailable,
            },
            selectionGuidance: 'Dimmed guidance must not be advertised.',
        });
        const { host } = toolsHost([alpha, beta, dimmed]);
        const registry = new ToolRegistry();
        registerEnvironmentSelectionTools(registry, host);

        const description = registeredDefinition(registry, 'select_environment').function
            .description;

        // The model-facing prose around the compositions is free to change; what must hold is that
        // every available registration's distinct guidance is advertised, the reserved case keeps
        // its typed marker so the model can name it, and unavailable guidance stays out.
        expect(description).toContain('Alpha reports belong to alpha_probe.');
        expect(description).toContain('Beta reports belong to beta_probe.');
        expect(description).toContain(EnvironmentSelectionReservedCase.UnsupportedProductCase);
        expect(description).not.toContain('Dimmed guidance must not be advertised');
    });

    it('refreshes the model-facing response when a preparable executor activates ready', async () => {
        const preparation: ExecutorPreparationOutcome = {
            ready: true,
            provenance: {
                source: 'official_release',
                product: 'Probe CLI',
                version: '1.0.0',
                digestB32: 'digestb32examplevalue0123456789abcdefghijklmnopqrstuvwxyz',
            },
        };
        const preparable = fakeExecutor({
            descriptor: preparableDescriptor('preparable_probe'),
            activate: async (context) => {
                context.environmentHost.attachExecutorPreparation(preparation);
            },
        });
        const { host } = toolsHost([
            preparable,
            fakeExecutor({ descriptor: readyDescriptor('beta_probe') }),
        ]);
        const registry = new ToolRegistry();
        registerEnvironmentSelectionTools(registry, host);

        const result = await registry.dispatch('select_environment', {
            ...selectionRequest('preparable_probe'),
        });

        expect(result).toMatchObject({
            accepted: true,
            kind: 'preparable_probe',
            state: 'ready',
            limitationCode: null,
            cliPreparation: { state: 'ready', provenance: { product: 'Probe CLI' } },
        });
    });

    it('reports the typed host lock outcome when the reporter baseline cannot execute', async () => {
        const activations: RecordedActivation[] = [];
        const preparable = fakeExecutor({
            descriptor: preparableDescriptor('preparable_probe'),
            record: (recorded) => activations.push(recorded),
        });
        const { host } = toolsHost([
            preparable,
            fakeExecutor({ descriptor: readyDescriptor('beta_probe') }),
        ]);
        const registry = new ToolRegistry();
        const selectionHost = new EnvironmentSelectionHost(
            { ...facts, enabledFilters: [{ name: 'EasyList' }] },
            [preparable.descriptor, readyDescriptor('beta_probe')],
            { now: () => '2026-07-23T20:00:00.000Z' },
        );
        registerEnvironmentSelectionTools(registry, { ...host, environmentHost: selectionHost });

        const result = await registry.dispatch('select_environment', {
            ...selectionRequest('preparable_probe'),
        });

        expect(result).toMatchObject({
            accepted: true,
            state: EnvironmentSelectionState.CapabilityLimited,
            limitationCode: EnvironmentLimitationCode.FilterSelectionNotExecutable,
        });
        // No preparation pass ran for a baseline that cannot execute, so the response carries no
        // preparation record at all — the field stays absent, not null.
        expect('cliPreparation' in result).toBe(false);
        // The accepted selection still dispatches through the registration; the registration
        // itself declines to prepare for a baseline that cannot execute.
        expect(activations).toEqual([
            {
                executor: 'preparable_probe',
                targetUrl: 'https://example.test/article',
                reporterFilterIds: [2],
            },
        ]);
    });

    it('registers update_observed_intent without select_environment for a sole executor', () => {
        const sole = fakeExecutor({ descriptor: readyDescriptor('alpha_probe') });
        const { host } = toolsHost([sole]);
        const registry = new ToolRegistry();

        registerEnvironmentSelectionTools(registry, host);

        const names = registry.getToolNames();
        expect(names).toContain('update_observed_intent');
        expect(names).not.toContain('select_environment');
    });
});
