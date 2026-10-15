import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeDependencies } from '../../src/orchestrator/agent-runtime';
import type { BrowserSession } from '../../src/browser/browser-session';
import {
    fakePreparedExtensionSurface,
    readBackStateFixture,
} from '../environment/test-filtering-environment-fixtures';
import type { EvidenceRouteHost } from '../../src/local/evidence-route-contract';
import { officialAdguardListRef } from '../../src/environment/filter-list-ref';
import { classifyMissingCatalogFilterId } from '../../src/environment/third-party-filter-catalog';
import type {
    EnvironmentAdapterLimitation,
    FilteringEnvironmentAdapter,
    FilteringEnvironmentAdapterState,
} from '../../src/environment/filtering-environment';
import { ExtensionManifestVersion } from '../../src/environment/extension-preparation';
import { extensionFilteringExecutor } from '../../src/orchestrator/extension-filtering-executor';
import type {
    ExecutorAdapterContext,
    FilteringExecutor,
} from '../../src/orchestrator/filtering-executors';
import { FilteringExecutorRegistry } from '../../src/orchestrator/filtering-executors';
import { AgentRuntime } from '../../src/orchestrator/agent-runtime';
import type { IssueFacts } from '../../src/types/issue-facts';
import {
    baseFacts,
    baseRegistryWithGuidance,
    browserProfile,
    browserRegistryWithApplyRuleAndOpenPage,
    PROBE_EXECUTOR,
    PROBE_PRODUCT,
    PROBE_VERSION,
    probeEvidenceRoute,
    rawIssue,
    routeAdoptingExecutor as probeRouteAdoptingExecutor,
    runtimeOptions as fixtureRuntimeOptions,
} from './route-runtime-fixtures';

/**
 * A filter id no pinned official AdGuard list carries, so `officialAdguardListRef` cannot resolve
 * it. The precondition in each test fails this suite loudly if the catalog ever pins it.
 */
const CATALOG_ABSENT_FILTER_ID = 9999;

/**
 * `Adblock Warning Removal List` in the pinned third-party registry: the reporter of AdguardFilters
 * #241534 had it enabled, and the desktop run refused its whole filter set on it before
 * `apply_rule` ever executed. It is absent from the official catalog, so it converges away and is
 * recorded.
 */
const THIRD_PARTY_FILTER_ID = 207;

/**
 * `Legitimate URL Shortener`, a third-party ruleset the MV3 build ships: a reporter import turns it
 * on in the launched Extension, so the launch read-back reports it enabled although no pinned
 * official list carries it.
 */
const BUILD_SHIPPED_THIRD_PARTY_FILTER_ID = 216;

/**
 * Facts whose reporter import URL carries the catalog-absent filter id, exactly as a desktop report
 * would: the reporter-side id channel is what an executor activation hands the run, and no upstream
 * gate validates it against the pinned interface table.
 */
const cliFacts: IssueFacts = {
    ...baseFacts,
    settingsImportUrl:
        `https://reports.adguard.com/settings/import.html?scheme_version=4&` +
        `product_version=5.4.3.99&regular_filters=${CATALOG_ABSENT_FILTER_ID}&stealth.enabled=0`,
};

function runtimeOptions(issueFacts: IssueFacts) {
    return fixtureRuntimeOptions(issueFacts, 'agent-runtime-preparation-test');
}

/**
 * Runtime dependencies serving the prepared-launch read-back gate without a browser or model: the
 * host read-back returns the shipped state fixture and the application session is a no-op runner.
 *
 * @param enabledFilterIds - Filter IDs the read-back reports enabled.
 * @returns Dependencies to spread into AgentRuntime dependencies.
 */
function launchReadBackDependencies(
    enabledFilterIds: readonly number[],
): Pick<
    AgentRuntimeDependencies,
    'readAdGuardExtensionState' | 'findExtensionRuntime' | 'createPhaseApplicationModelRunner'
> {
    return {
        readAdGuardExtensionState: vi.fn(async () => readBackStateFixture(enabledFilterIds)),
        findExtensionRuntime: vi.fn(async () => ({
            extensionId: 'test-extension-id',
            manifestVersion: ExtensionManifestVersion.Mv3,
        })),
        createPhaseApplicationModelRunner: vi.fn(() => ({
            run: async () => ({ completed: true, actionLog: [] }),
        })),
    };
}

/**
 * Fake prepared-extension session whose only launch-relevant members are the persistent context the
 * host reads the blocker state over and the app-message surface it opens on that context: both the
 * settings-payload pre-read and the host-performed application itself drive that surface.
 *
 * @returns The session to hand createBrowserSession for a prepared launch.
 */
function fakePreparedSession(): BrowserSession {
    return {
        close: vi.fn(),
        extensionContext: fakePreparedExtensionSurface().context,
    } as unknown as BrowserSession;
}

/**
 * A limitation the capturing adapter of this suite prepares-not-ready with, so a dispatched
 * apply_rule stops right after the captured preparation request instead of opening phase sessions
 * the suite does not stub.
 */
function notReadyLimitation(): EnvironmentAdapterLimitation {
    return {
        code: 'baseline_integrity_unavailable',
        stage: 'preparation',
        detail: 'The capturing adapter never proves a baseline in this suite.',
    };
}

/**
 * The executor identity a capturing adapter reports: the recorder refuses an adapter whose kind
 * differs from the locked selection, and the selection host refuses an actual context that differs
 * from the one the executor's own preparation already bound.
 */
interface CapturingAdapterIdentity {
    /**
     * The executor the adapter belongs to.
     */
    kind: string;

    /**
     * The product the executor's preparation bound as the actual context.
     */
    product: string;

    /**
     * The product version the executor's preparation bound as the actual context.
     */
    productVersion: string;
}

/**
 * The identity of the prepared browser-extension executor in this suite.
 */
const EXTENSION_ADAPTER_IDENTITY: CapturingAdapterIdentity = {
    kind: 'browser_extension',
    product: 'AdGuard Browser Extension',
    productVersion: '5.4.3.99',
};

/**
 * The identity `routeAdoptingExecutor` binds through its preparation provenance.
 */
const PROBE_ADAPTER_IDENTITY: CapturingAdapterIdentity = {
    kind: PROBE_EXECUTOR,
    product: PROBE_PRODUCT,
    productVersion: PROBE_VERSION,
};

/**
 * The static `limited` adapter state the capturing adapter snapshots: the same body every call
 * returns.
 *
 * @param identity - The executor identity the state reports.
 * @returns The limited adapter state.
 */
function limitedAdapterState(identity: CapturingAdapterIdentity): FilteringEnvironmentAdapterState {
    return {
        kind: identity.kind,
        lifecycle: 'limited',
        stateDigest: 'e'.repeat(64),
        actualContext: {
            kind: identity.kind,
            product: identity.product,
            browser: 'CloakBrowser Chromium',
            productVersion: identity.productVersion,
        },
        capabilities: ['browser_navigation', 'filtering_control'],
        preparation: null,
        baseline: null,
        openLeaseIds: [],
        cleanup: null,
    };
}

/**
 * A fake adapter whose captured preparation request this suite asserts on: it records the exact
 * requested lists handed across the runtime/executor boundary and refuses to go ready.
 *
 * @param identity - The executor identity the adapter reports.
 * @returns The capturing adapter.
 */
function capturingNotReadyAdapter(
    identity: CapturingAdapterIdentity = EXTENSION_ADAPTER_IDENTITY,
): FilteringEnvironmentAdapter {
    return {
        kind: identity.kind,
        capabilities: () => ['browser_navigation', 'filtering_control'],
        prepare: vi.fn(async () => ({ ready: false as const, limitation: notReadyLimitation() })),
        openPhase: vi.fn(async () => ({
            ready: false as const,
            limitation: notReadyLimitation(),
        })),
        drainOpenHandles: vi.fn(async () => ({
            attempted: 0,
            closed: 0,
            failed: 0,
            failures: [],
        })),
        cleanup: vi.fn(async () => ({
            attempted: true,
            completed: true,
            finalizerAttempts: 0,
            finalizerCompleted: 0,
            finalizerFailed: 0,
            failures: [],
        })),
        snapshot: () => limitedAdapterState(identity),
    };
}

/**
 * Build the browser-extension-shaped executor registration whose adapter construction this suite
 * captures and replaces: production activation behavior (extension lifecycle reveal), hermetic
 * adapter.
 *
 * @param createAdapter - The under-test adapter factory to install.
 * @returns The registration to place in a hermetic run registry.
 */
function extensionShapedExecutor(
    createAdapter: (context: ExecutorAdapterContext) => FilteringEnvironmentAdapter,
): FilteringExecutor {
    const { createAdapter: _production, ...rest } = extensionFilteringExecutor;
    void _production;
    return { ...rest, createAdapter };
}

/**
 * The probe registration whose adapter records the run-provided context it was created with and
 * refuses to go ready.
 *
 * @param route - The evidence route the activation adopts.
 * @param recorded - Recorder for the run-provided adapter context at creation time.
 * @param reporterFilterIds - The reporter filter ids the activation hands the run.
 * @returns The registration to place in a hermetic run registry.
 */
function routeAdoptingExecutor(
    route: EvidenceRouteHost,
    recorded: { createAdapterContexts: ExecutorAdapterContext[] },
    reporterFilterIds: readonly number[] = [CATALOG_ABSENT_FILTER_ID],
): FilteringExecutor {
    return probeRouteAdoptingExecutor(
        route,
        (context) => {
            recorded.createAdapterContexts.push(context);
            return capturingNotReadyAdapter(PROBE_ADAPTER_IDENTITY);
        },
        reporterFilterIds,
    );
}

describe('AgentRuntime filtering-environment preparation', () => {
    it('requests the pinned official part of an observed read-back and records nothing as left out', async () => {
        // Precondition: the build-shipped id really is outside the official catalog, so this suite
        // fails loudly instead of exercising the wrong branch if the catalog ever pins it.
        expect(officialAdguardListRef(BUILD_SHIPPED_THIRD_PARTY_FILTER_ID)).toBeNull();

        const adapter = capturingNotReadyAdapter();
        const registry = new FilteringExecutorRegistry();
        registry.register(extensionShapedExecutor(() => adapter));
        const runtime = await AgentRuntime.create(runtimeOptions(baseFacts), {
            ...launchReadBackDependencies([2, BUILD_SHIPPED_THIRD_PARTY_FILTER_ID]),
            createBaseRegistry: async () => baseRegistryWithGuidance(),
            createBrowserSession: async () => fakePreparedSession(),
            createBrowserRegistry: async () => browserRegistryWithApplyRuleAndOpenPage(),
            filteringExecutors: registry,
        });
        try {
            await runtime.registry.dispatch('fetch_issue', { issueNumber: rawIssue.number });
            await runtime.registry.dispatch('lookup_rule_guidance', {});
            await runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
                settings: {
                    kind: 'agent_selected',
                    filterIds: [2, BUILD_SHIPPED_THIRD_PARTY_FILTER_ID],
                    stealthEnabled: false,
                },
            });

            await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'example.test##.articleAdSlot',
            });

            // A list reference exists only for a pinned official list, so that is all the request
            // can name; the adapter prepares the whole observed set from its own read-back.
            expect(adapter.prepare).toHaveBeenCalledTimes(1);
            const request = (adapter.prepare as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
            expect(request.requestedLists).toEqual([officialAdguardListRef(2)]);
            // The launched build activated the third-party ruleset and the phases run it, so a
            // report saying it was left out of the executed baseline would state the opposite of
            // what ran.
            expect(
                runtime
                    .getEnvironmentSelection()
                    ?.fidelityLimitations.find(
                        (limitation) => limitation.code === 'filter_selection_approximation',
                    ),
            ).toBeUndefined();
        } finally {
            await runtime.dispose();
        }
    });

    it('converges a route-executed request onto the official subset and records the third-party id', async () => {
        // Precondition: the third-party id really is outside the official catalog, so this suite
        // fails loudly instead of exercising the wrong branch if the catalog ever pins it.
        expect(officialAdguardListRef(THIRD_PARTY_FILTER_ID)).toBeNull();

        const { route } = probeEvidenceRoute();
        const recorded = { createAdapterContexts: [] as ExecutorAdapterContext[] };
        const registry = new FilteringExecutorRegistry();
        registry.register(routeAdoptingExecutor(route, recorded, [2, THIRD_PARTY_FILTER_ID]));
        const runtime = await AgentRuntime.create(runtimeOptions(cliFacts), {
            createBaseRegistry: async () => baseRegistryWithGuidance(),
            createBrowserRegistry: async () => browserRegistryWithApplyRuleAndOpenPage(),
            filteringExecutors: registry,
        });
        try {
            await runtime.registry.dispatch('fetch_issue', { issueNumber: rawIssue.number });
            await runtime.registry.dispatch('launch_browser', {
                extension: 'none',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
            });
            await runtime.registry.dispatch('lookup_rule_guidance', {});
            await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' });

            const result = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'example.test##.articleAdSlot',
            });

            // The environment prepared on the ids the catalog publishes instead of refusing the
            // whole set on the third-party one, and the executed baseline names that subset only.
            expect(result).not.toMatchObject({
                limitation: { code: 'baseline_manifest_invalid' },
            });
            expect(recorded.createAdapterContexts).toHaveLength(1);
            expect(recorded.createAdapterContexts[0]?.requestedLists).toEqual([
                officialAdguardListRef(2),
            ]);
            // The route cannot execute the dropped list, so it is published as the run's
            // filter-selection approximation, named from the pinned registry.
            const approximation = runtime
                .getEnvironmentSelection()
                ?.fidelityLimitations.find(
                    (limitation) => limitation.code === 'filter_selection_approximation',
                );
            expect(approximation?.detail).toContain(String(THIRD_PARTY_FILTER_ID));
            expect(approximation?.detail).toContain(
                classifyMissingCatalogFilterId(THIRD_PARTY_FILTER_ID).name,
            );
        } finally {
            await runtime.dispose();
        }
    });

    it('fails the route-executed preparation closed when no requested filter converges', async () => {
        // Precondition: the id really is absent from the pinned catalog, so this suite fails
        // loudly instead of exercising the wrong branch if the catalog ever pins it.
        expect(officialAdguardListRef(CATALOG_ABSENT_FILTER_ID)).toBeNull();

        const { route, runBaselineAction, applyCandidate, revokeCandidate, launchEvidenceSession } =
            probeEvidenceRoute();
        const recorded = { createAdapterContexts: [] as ExecutorAdapterContext[] };
        const registry = new FilteringExecutorRegistry();
        registry.register(routeAdoptingExecutor(route, recorded));
        const runtime = await AgentRuntime.create(runtimeOptions(cliFacts), {
            createBaseRegistry: async () => baseRegistryWithGuidance(),
            // Present only to make the merged apply_rule take the common-environment path; the
            // unusable request must stop long before any phase observer runs.
            observeEnvironmentPhase: vi.fn(async () => {
                throw new Error('must not be reached');
            }),
            createBrowserRegistry: async () => browserRegistryWithApplyRuleAndOpenPage(),
            filteringExecutors: registry,
        });
        try {
            await runtime.registry.dispatch('fetch_issue', { issueNumber: rawIssue.number });
            await runtime.registry.dispatch('launch_browser', {
                extension: 'none',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
            });
            await runtime.registry.dispatch('lookup_rule_guidance', {});
            await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' });

            const result = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'example.test##.articleAdSlot',
            });

            expect(result).toMatchObject({
                validationSkipped: true,
                errorKind: 'environment_capability_limited',
                retryable: false,
                limitation: {
                    code: 'baseline_manifest_invalid',
                    stage: 'preparation',
                },
            });
            // A baseline with no executable list measures nothing, so the refusal names the whole
            // requested set rather than only the id it happened to reach first.
            expect((result as { limitation: { detail: string } }).limitation.detail).toContain(
                String(CATALOG_ABSENT_FILTER_ID),
            );
            // The projection refused before any adapter existed: no baseline action, candidate
            // port, or proxied phase session ever ran behind the unusable request.
            expect(runBaselineAction).not.toHaveBeenCalled();
            expect(applyCandidate).not.toHaveBeenCalled();
            expect(revokeCandidate).not.toHaveBeenCalled();
            expect(launchEvidenceSession).toHaveBeenCalledTimes(1);
        } finally {
            await runtime.dispose();
        }
    });

    it('keeps the official-ref request as the per-official-id projection', async () => {
        const adapter = capturingNotReadyAdapter();
        const registry = new FilteringExecutorRegistry();
        registry.register(extensionShapedExecutor(() => adapter));
        const runtime = await AgentRuntime.create(runtimeOptions(baseFacts), {
            ...launchReadBackDependencies([2]),
            createBaseRegistry: async () => baseRegistryWithGuidance(),
            createBrowserSession: async () => fakePreparedSession(),
            createBrowserRegistry: async () => browserRegistryWithApplyRuleAndOpenPage(),
            filteringExecutors: registry,
        });
        try {
            await runtime.registry.dispatch('fetch_issue', { issueNumber: rawIssue.number });
            await runtime.registry.dispatch('lookup_rule_guidance', {});
            await runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
                settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
            });
            await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'example.test##.articleAdSlot',
            });

            expect(adapter.prepare).toHaveBeenCalledTimes(1);
            const request = (adapter.prepare as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
            expect(request.requestedLists).toEqual([officialAdguardListRef(2)]);
        } finally {
            await runtime.dispose();
        }
    });
});
