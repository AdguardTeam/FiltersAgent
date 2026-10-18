import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConsoleCoverage, type IBrowserSession } from '../../src/browser/browser-interfaces';
import type { BrowserSession } from '../../src/browser/browser-session';
import { BlockerVerificationMethod } from '../../src/environment/environment-proofs';
import { ExtensionManifestVersion } from '../../src/environment/extension-preparation';
import { officialAdguardListRef } from '../../src/environment/filter-list-ref';
import type {
    FilteringEnvironmentAdapter,
    FilteringEnvironmentAdapterState,
    ValidatorPhaseCompletion,
} from '../../src/environment/filtering-environment';
import { AgentRuntime } from '../../src/orchestrator/agent-runtime';
import { extensionFilteringExecutor } from '../../src/orchestrator/extension-filtering-executor';
import { FilteringExecutorRegistry } from '../../src/orchestrator/filtering-executors';
import {
    REPORTER_SETTINGS_SESSION_REQUIRED,
    VALIDATION_BASELINE_LOCKED,
} from '../../src/orchestrator/validation-baseline-lock';
import type { AdsEnvironmentPhaseObservationInput } from '../../src/validator/phase-orchestrator';
import {
    fakePreparedExtensionSurface,
    readBackStateFixture,
} from '../environment/test-filtering-environment-fixtures';
import {
    baseFacts,
    baseRegistryWithGuidance,
    browserProfile,
    browserRegistryWithApplyRuleAndOpenPage,
    probeEvidenceRoute,
    rawIssue,
    routeAdoptingExecutor,
    runtimeOptions,
} from './route-runtime-fixtures';

const actualContext = {
    kind: 'browser_extension',
    product: 'AdGuard Browser Extension',
    browser: 'CloakBrowser Chromium',
    productVersion: '5.4.3.99',
};

const baselineDigest = 'd'.repeat(64);

function adapterState(): FilteringEnvironmentAdapterState {
    return {
        kind: 'browser_extension',
        lifecycle: 'ready',
        stateDigest: 'e'.repeat(64),
        actualContext,
        capabilities: ['browser_navigation', 'filtering_control'],
        preparation: {
            preparedAt: '2026-07-24T00:00:00.000Z',
            buildDigest: 'f'.repeat(64),
            extensionRootDigest: null,
        },
        baseline: {
            environment: 'browser_extension',
            acquiredAt: '2026-07-24T00:00:00.000Z',
            enabledListKeys: ['adguard:2'],
            resources: [],
            aggregateDigest: baselineDigest,
        },
        openLeaseIds: [],
        cleanup: null,
    };
}

function fakePhaseSession(): IBrowserSession {
    return {
        artifactsDir: '/tmp/artifacts',
        isClosed: false,
        getPage: () => ({}) as never,
        close: async () => undefined,
        getNetworkLog: () => [],
        resetNetworkLog: () => undefined,
        getConsoleLog: () => [],
        consoleCoverage: ConsoleCoverage.BrowserLogOnly,
    } as IBrowserSession;
}

/**
 * A ready browser-extension adapter that opens phases A and B; the observer below ends every
 * experiment there, so phase C is never requested.
 */
function readyAdapter(): FilteringEnvironmentAdapter & { prepare: ReturnType<typeof vi.fn> } {
    return {
        kind: 'browser_extension',
        capabilities: () => ['browser_navigation', 'filtering_control'],
        prepare: vi.fn(async () => ({ ready: true as const, state: adapterState() })),
        openPhase: async (request) => {
            const sessionId = `${request.experimentId}-${request.phase}`;
            return {
                ready: true,
                handle: {
                    session: fakePhaseSession(),
                    adapterProof: {
                        leaseId: sessionId,
                        adapterStateDigest: 'e'.repeat(64),
                        phase: request.phase,
                        filteringState:
                            request.phase === 'A'
                                ? ('disabled' as const)
                                : ('published_baseline' as const),
                        sessionId,
                        actualContext,
                        baselineDigest: request.phase === 'A' ? null : baselineDigest,
                        candidateDigest: null,
                        extension:
                            request.phase === 'A'
                                ? null
                                : {
                                      packageVersion: '5.4.3.99',
                                      manifestVersion: '5.4.3.99',
                                      profileKind: 'agent_selected' as const,
                                      enabledListKeys: ['adguard:2'],
                                      activeRulesetListKeys: ['adguard:2'],
                                      stealthEnabled: false,
                                      userRulesDigest: null,
                                      application: {
                                          method: BlockerVerificationMethod.ExtensionState,
                                          appliedRules: [],
                                          actionLog: [],
                                      },
                                  },
                    },
                    close: async () => undefined,
                },
            };
        },
        drainOpenHandles: async () => ({ attempted: 0, closed: 0, failed: 0, failures: [] }),
        cleanup: async () => ({
            attempted: true,
            completed: true,
            finalizerAttempts: 0,
            finalizerCompleted: 0,
            finalizerFailed: 0,
            failures: [],
        }),
        snapshot: adapterState,
    };
}

/**
 * Phase B shows no symptom, so each experiment concludes after its baseline phase.
 */
async function baselineWithoutSymptom(
    input: AdsEnvironmentPhaseObservationInput,
): Promise<ValidatorPhaseCompletion> {
    return {
        kind: 'observed',
        sessionId: input.proof.sessionId,
        targetUrl: 'https://nettg.pl/',
        targetObservation: { symptomPresent: input.phase !== 'B', pageUsable: true },
        navigationVerified: true,
        artifacts: [],
        vision: null,
        candidateValidation: null,
        rejectedCandidates: [],
    };
}

/**
 * A reporter settings import naming filters 2 and 3 with Stealth Mode off.
 */
const REPORTER_IMPORT_URL =
    'https://reports.adguard.com/settings/import.html?scheme_version=4&' +
    'product_version=5.4.3.99&regular_filters=2,3&stealth.enabled=0';

/**
 * A prepared-extension runtime whose launches read back exactly the filters they asked for.
 *
 * @param issueBody - The issue text the run reads, the fixture issue's by default.
 * @returns The runtime, a launcher for prepared sessions, the observer and the adapter factory.
 */
async function preparedRuntime(issueBody: string = rawIssue.body) {
    let readBackFilterIds: readonly number[] = [2];
    const adapter = readyAdapter();
    const createAdapter = vi.fn(() => adapter);
    const observe = vi.fn(baselineWithoutSymptom);
    const { createAdapter: _production, ...extensionExecutor } = extensionFilteringExecutor;
    void _production;
    const registry = new FilteringExecutorRegistry();
    registry.register({ ...extensionExecutor, createAdapter });
    // The trusted validation context reads the checkout, so it must exist, even empty.
    const filtersPath = mkdtempSync(join(tmpdir(), 'agent-runtime-baseline-lock-'));
    const runtime = await AgentRuntime.create(
        {
            ...runtimeOptions(baseFacts, 'agent-runtime-baseline-lock-test'),
            issue: { ...rawIssue, body: issueBody },
            filtersPath,
        },
        {
            readAdGuardExtensionState: vi.fn(async () => readBackStateFixture(readBackFilterIds)),
            findExtensionRuntime: vi.fn(async () => ({
                extensionId: 'test-extension-id',
                manifestVersion: ExtensionManifestVersion.Mv3,
            })),
            createPhaseApplicationModelRunner: vi.fn(() => ({
                run: async () => ({ completed: true, actionLog: [] }),
            })),
            createBaseRegistry: async () => baseRegistryWithGuidance(),
            createBrowserSession: async () =>
                ({
                    close: vi.fn(),
                    extensionContext: fakePreparedExtensionSurface().context,
                }) as unknown as BrowserSession,
            createBrowserRegistry: async () => browserRegistryWithApplyRuleAndOpenPage(),
            filteringExecutors: registry,
            observeEnvironmentPhase: observe,
        },
    );
    await runtime.registry.dispatch('fetch_issue', { issueNumber: rawIssue.number });
    await runtime.registry.dispatch('lookup_rule_guidance', {});
    const launch = async (
        filterIds: readonly number[],
        settings: Record<string, unknown> = {
            kind: 'agent_selected',
            filterIds: [...filterIds],
            stealthEnabled: false,
        },
    ): Promise<string> => {
        readBackFilterIds = filterIds;
        const launched = await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings,
        });
        expect(launched).toMatchObject({ launched: true, settingsVerified: true });
        return String(launched.sessionId);
    };
    const dispose = async (): Promise<void> => {
        await runtime.dispose();
        rmSync(filtersPath, { recursive: true, force: true });
    };
    return { runtime, launch, adapter, createAdapter, observe, dispose };
}

describe('AgentRuntime validation baseline', () => {
    it('locks nothing on a refused apply_rule and takes the baseline from the first experiment', async () => {
        const { runtime, launch, adapter, createAdapter, observe, dispose } =
            await preparedRuntime();
        try {
            await launch([2]);
            const refused = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl,example.org##.banner',
                operation: 'edit',
                originalRule: 'example.org##.banner',
            });
            expect(refused).toMatchObject({ errorKind: 'candidate_operation_unsupported' });
            // The refusal ran no experiment, so no environment was built from this session.
            expect(createAdapter).not.toHaveBeenCalled();

            await launch([2, 3]);
            await runtime.registry.dispatch('apply_rule', { candidateRule: 'nettg.pl##.banner' });

            // The first experiment ran in the second session, and the environment prepared that
            // session's lists, not the lists of the session the refused call came from.
            expect(observe).toHaveBeenCalled();
            expect(adapter.prepare).toHaveBeenCalledTimes(1);
            expect(adapter.prepare.mock.calls[0]?.[0].requestedLists).toEqual([
                officialAdguardListRef(2),
                officialAdguardListRef(3),
            ]);
        } finally {
            await dispose();
        }
    });

    it('refuses an experiment from a session with other lists and names the locked baseline', async () => {
        const { runtime, launch, observe, dispose } = await preparedRuntime();
        try {
            const lockingSessionId = await launch([2]);
            const first = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl##.banner',
            });
            expect(first).toMatchObject({ errorKind: 'baseline_symptom_absent' });
            const observedBefore = observe.mock.calls.length;

            const otherSessionId = await launch([2, 3]);
            const refused = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl##.sidebar-ad',
            });

            // The experiment would have run on the first session's lists while the model reads
            // the verdict as one for this session: it is refused instead, naming both baselines.
            expect(refused).toMatchObject({
                validationSkipped: true,
                errorKind: VALIDATION_BASELINE_LOCKED,
                lockedBaseline: {
                    sessionId: lockingSessionId,
                    enabledListKeys: ['adguard:2'],
                },
                sessionBaseline: {
                    sessionId: otherSessionId,
                    enabledListKeys: ['adguard:2', 'adguard:3'],
                },
            });
            expect(observe.mock.calls.length).toBe(observedBefore);
            // The refusal judged the session, not the candidate, so it spends no attempt.
            expect(refused.remainingCandidateAttempts).toBe(first.remainingCandidateAttempts);

            // A new session with the locked settings and profile runs its experiment.
            await launch([2]);
            const relaunched = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl##.sidebar-ad',
            });
            expect(relaunched).toMatchObject({ errorKind: 'baseline_symptom_absent' });
            expect(observe.mock.calls.length).toBeGreaterThan(observedBefore);
        } finally {
            await dispose();
        }
    });

    it('runs no experiment outside the reporter settings when the issue carries an import', async () => {
        const { runtime, launch, adapter, createAdapter, observe, dispose } = await preparedRuntime(
            `${rawIssue.body}\n\nSettings: ${REPORTER_IMPORT_URL}`,
        );
        try {
            await launch([2], { kind: 'defaults_plus_required', requiredFilterIds: [] });
            const refused = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl##.banner',
            });

            // Only the reporter-settings session can verify a rule here, so the controlled session
            // gets no experiment: it would lock a baseline no verdict can come from.
            expect(refused).toMatchObject({
                validationSkipped: true,
                errorKind: REPORTER_SETTINGS_SESSION_REQUIRED,
                retryable: true,
                remainingCandidateAttempts: 3,
            });
            expect(createAdapter).not.toHaveBeenCalled();
            expect(observe).not.toHaveBeenCalled();

            await launch([2, 3], { kind: 'reported_on_current', importUrl: REPORTER_IMPORT_URL });
            const reporterRun = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl##.banner',
            });

            // The reporter session runs the run's first experiment and takes the baseline.
            expect(reporterRun).toMatchObject({ errorKind: 'baseline_symptom_absent' });
            expect(observe).toHaveBeenCalled();
            expect(adapter.prepare).toHaveBeenCalledTimes(1);
            expect(adapter.prepare.mock.calls[0]?.[0].requestedLists).toEqual([
                officialAdguardListRef(2),
                officialAdguardListRef(3),
            ]);
        } finally {
            await dispose();
        }
    });

    it('keeps experiments on the CLI route when the issue carries an import', async () => {
        const { route } = probeEvidenceRoute();
        // The environment itself is not under test: building it is the step the reporter-settings
        // refusal would have skipped.
        const createAdapter = vi.fn((): FilteringEnvironmentAdapter => {
            throw new Error('The environment is not under test.');
        });
        const registry = new FilteringExecutorRegistry();
        registry.register(routeAdoptingExecutor(route, createAdapter, [2]));
        const runtime = await AgentRuntime.create(
            {
                ...runtimeOptions(baseFacts, 'agent-runtime-baseline-lock-cli-test'),
                issue: {
                    ...rawIssue,
                    body: `${rawIssue.body}\n\nSettings: ${REPORTER_IMPORT_URL}`,
                },
            },
            {
                createBaseRegistry: async () => baseRegistryWithGuidance(),
                createBrowserRegistry: async () => browserRegistryWithApplyRuleAndOpenPage(),
                filteringExecutors: registry,
            },
        );
        try {
            await runtime.registry.dispatch('fetch_issue', { issueNumber: rawIssue.number });
            await runtime.registry.dispatch('launch_browser', {
                extension: 'none',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
            });
            await runtime.registry.dispatch('lookup_rule_guidance', {});
            await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' });

            const applied = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl##.banner',
            });

            // CLI sessions take no extension settings, so the import cannot hold the call back.
            expect(applied.errorKind).not.toBe(REPORTER_SETTINGS_SESSION_REQUIRED);
            expect(createAdapter).toHaveBeenCalledTimes(1);
        } finally {
            await runtime.dispose();
        }
    });
});
