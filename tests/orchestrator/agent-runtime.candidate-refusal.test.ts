import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConsoleCoverage, type IBrowserSession } from '../../src/browser/browser-interfaces';
import type {
    EnvironmentAdapterLimitation,
    EnvironmentPhaseRequest,
    FilteringEnvironmentAdapter,
    FilteringEnvironmentAdapterState,
    ValidatorPhaseCompletion,
} from '../../src/environment/filtering-environment';
import { AgentRuntime } from '../../src/orchestrator/agent-runtime';
import { FilteringExecutorRegistry } from '../../src/orchestrator/filtering-executors';
import type { AdsEnvironmentPhaseObservationInput } from '../../src/validator/phase-orchestrator';
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
    routeAdoptingExecutor,
    runtimeOptions,
} from './route-runtime-fixtures';

const actualContext = {
    kind: PROBE_EXECUTOR,
    product: PROBE_PRODUCT,
    browser: 'CloakBrowser Chromium',
    productVersion: PROBE_VERSION,
};

const baselineDigest = 'd'.repeat(64);

const cliProof = {
    cliVersion: PROBE_VERSION,
    enabledListKeys: ['adguard:2'],
    coenabledListKeys: [],
    userFilterEnabled: true,
};

function adapterState(): FilteringEnvironmentAdapterState {
    return {
        kind: PROBE_EXECUTOR,
        lifecycle: 'ready',
        stateDigest: 'e'.repeat(64),
        actualContext,
        capabilities: ['browser_navigation', 'filtering_control', 'candidate_application'],
        preparation: {
            preparedAt: '2026-07-24T00:00:00.000Z',
            buildDigest: 'f'.repeat(64),
            extensionRootDigest: null,
        },
        baseline: {
            environment: PROBE_EXECUTOR,
            acquiredAt: '2026-07-24T00:00:00.000Z',
            enabledListKeys: ['adguard:2'],
            resources: [],
            aggregateDigest: baselineDigest,
        },
        openLeaseIds: [],
        cleanup: null,
    };
}

function fakeSession(): IBrowserSession {
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
 * A CLI-shaped adapter that opens phases A and B, and answers phase C from `candidatePhase`.
 */
function routeAdapter(
    candidatePhase: (request: EnvironmentPhaseRequest) => EnvironmentAdapterLimitation,
): FilteringEnvironmentAdapter & { openPhase: ReturnType<typeof vi.fn> } {
    return {
        kind: PROBE_EXECUTOR,
        capabilities: () => ['browser_navigation', 'filtering_control', 'candidate_application'],
        prepare: async () => ({ ready: true, state: adapterState() }),
        openPhase: vi.fn(async (request: EnvironmentPhaseRequest) => {
            if (request.phase === 'C') {
                return { ready: false as const, limitation: candidatePhase(request) };
            }
            const sessionId = `${request.experimentId}-${request.phase}`;
            return {
                ready: true as const,
                handle: {
                    session: fakeSession(),
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
                        extension: null,
                        cli:
                            request.phase === 'A' ? { ...cliProof, enabledListKeys: [] } : cliProof,
                    },
                    close: async () => undefined,
                },
            };
        }),
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
 * Every phase shows the symptom, so each experiment reaches phase C.
 */
async function symptomEverywhere(
    input: AdsEnvironmentPhaseObservationInput,
): Promise<ValidatorPhaseCompletion> {
    return {
        kind: 'observed',
        sessionId: input.proof.sessionId,
        targetUrl: 'https://nettg.pl/',
        targetObservation: { symptomPresent: true, pageUsable: true },
        navigationVerified: true,
        artifacts: [],
        vision: null,
        candidateValidation: null,
        rejectedCandidates: [],
    };
}

async function routeRuntime(adapter: FilteringEnvironmentAdapter) {
    const { route } = probeEvidenceRoute();
    const registry = new FilteringExecutorRegistry();
    registry.register(routeAdoptingExecutor(route, () => adapter, [2]));
    // The trusted validation context reads the checkout, so it must exist, even empty.
    const filtersPath = mkdtempSync(join(tmpdir(), 'agent-runtime-candidate-refusal-'));
    const runtime = await AgentRuntime.create(
        { ...runtimeOptions(baseFacts, 'agent-runtime-candidate-refusal-test'), filtersPath },
        {
            createBaseRegistry: async () => baseRegistryWithGuidance(),
            createBrowserRegistry: async () => browserRegistryWithApplyRuleAndOpenPage(),
            filteringExecutors: registry,
            observeEnvironmentPhase: symptomEverywhere,
        },
    );
    await runtime.registry.dispatch('fetch_issue', { issueNumber: rawIssue.number });
    await runtime.registry.dispatch('launch_browser', {
        extension: 'none',
        targetUrl: 'https://nettg.pl/',
        profile: browserProfile,
    });
    await runtime.registry.dispatch('lookup_rule_guidance', {});
    await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' });
    const dispose = async (): Promise<void> => {
        await runtime.dispose();
        rmSync(filtersPath, { recursive: true, force: true });
    };
    return { runtime, dispose };
}

function candidatePhasesOpened(adapter: { openPhase: ReturnType<typeof vi.fn> }): string[] {
    return adapter.openPhase.mock.calls
        .map(([request]) => request as EnvironmentPhaseRequest)
        .filter((request) => request.phase === 'C')
        .map((request) => request.candidate!.operation);
}

describe('AgentRuntime candidate refusals on a route-executed environment', () => {
    it('refuses only the edit of a line the published list lacks and still runs the next rule', async () => {
        const adapter = routeAdapter((request) =>
            request.candidate!.operation === 'edit'
                ? {
                      code: 'baseline_line_not_found',
                      stage: 'candidate',
                      detail: 'The line the candidate edits is not in the published baseline.',
                  }
                : {
                      code: 'phase_proof_unavailable',
                      stage: 'phase',
                      detail: 'The official filtering state differs between the phases.',
                  },
        );
        const { runtime, dispose } = await routeRuntime(adapter);
        try {
            const refused = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl,example.org,example.com##.preferred-source',
                operation: 'edit',
                originalRule: 'example.org,example.com##.preferred-source',
            });

            expect(refused).toMatchObject({
                validationSkipped: true,
                errorKind: 'baseline_line_not_found',
                retryable: false,
            });
            expect(runtime.getEnvironmentSelection()?.state).toBe('ready');

            // The refusal judged the line the request named, not the candidate: two more like it
            // must not use up the three semantic attempts the added rule still needs.
            for (const host of ['example.net', 'example.info']) {
                expect(
                    await runtime.registry.dispatch('apply_rule', {
                        candidateRule: `nettg.pl,${host}##.preferred-source`,
                        operation: 'edit',
                        originalRule: `${host}##.preferred-source`,
                    }),
                ).toMatchObject({ errorKind: 'baseline_line_not_found' });
            }

            const added = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl##.preferred-source',
            });

            // The added rule ran its own experiment up to the candidate phase, where the environment
            // itself was lost: that loss still ends rule verification for the run.
            expect(candidatePhasesOpened(adapter)).toEqual(['edit', 'edit', 'edit', 'add']);
            expect(added).toMatchObject({
                validationSkipped: true,
                errorKind: 'environment_capability_limited',
                limitation: { code: 'phase_proof_unavailable' },
            });
            expect(runtime.getEnvironmentSelection()?.state).toBe('capability_limited');

            const phasesBefore = adapter.openPhase.mock.calls.length;
            expect(
                await runtime.registry.dispatch('apply_rule', {
                    candidateRule: 'nettg.pl##.another-widget',
                }),
            ).toMatchObject({ errorKind: 'environment_capability_limited' });
            expect(adapter.openPhase.mock.calls.length).toBe(phasesBefore);
        } finally {
            await dispose();
        }
    });

    it('names a line that occurs twice in the published list as its own refusal', async () => {
        const adapter = routeAdapter(() => ({
            code: 'baseline_line_not_unique',
            stage: 'candidate',
            detail: 'The line the candidate edits is not one published baseline line.',
        }));
        const { runtime, dispose } = await routeRuntime(adapter);
        try {
            const refused = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl,example.org##.twice',
                operation: 'edit',
                originalRule: 'example.org##.twice',
            });

            expect(refused).toMatchObject({
                validationSkipped: true,
                errorKind: 'baseline_line_not_unique',
                retryable: false,
            });
            expect(runtime.getEnvironmentSelection()?.state).toBe('ready');
        } finally {
            await dispose();
        }
    });

    it.each([
        [
            'an edit of a line the published list lacks',
            {
                candidateRule: 'nettg.pl,example.org##.preferred-source',
                operation: 'edit',
                originalRule: 'example.org##.preferred-source',
            },
            'baseline_line_not_found',
        ],
        [
            'a removal the environment cannot run',
            { candidateRule: 'example.org##.preferred-source', operation: 'remove' },
            'candidate_operation_unsupported',
        ],
    ])('answers a repeat of %s without opening its phases again', async (_name, args, code) => {
        const adapter = routeAdapter(() => ({
            code: code as EnvironmentAdapterLimitation['code'],
            stage: 'candidate',
            detail: 'The environment refused this candidate.',
        }));
        const { runtime, dispose } = await routeRuntime(adapter);
        try {
            const first = await runtime.registry.dispatch('apply_rule', args);
            const phasesAfterFirst = adapter.openPhase.mock.calls.length;

            const repeat = await runtime.registry.dispatch('apply_rule', args);

            // The lists and the environment's operations are fixed for the run, so the repeat can
            // only be refused again: it gets the same answer and costs no phase.
            expect(repeat).toEqual(first);
            expect(repeat).toMatchObject({ errorKind: code, retryable: false });
            expect(adapter.openPhase.mock.calls.length).toBe(phasesAfterFirst);
        } finally {
            await dispose();
        }
    });

    it.each([
        ['a candidate rule', { candidateRule: 'nettg.pl##.preferred-source\n@@||example.com^' }],
        [
            'the line an edit replaces',
            {
                candidateRule: 'nettg.pl,example.org##.preferred-source',
                operation: 'edit',
                originalRule: 'example.org##.preferred-source\nexample.org##.other',
            },
        ],
    ])('refuses %s spanning several lines before any phase opens', async (_name, args) => {
        const adapter = routeAdapter(() => {
            throw new Error('phase C must not be reached');
        });
        const { runtime, dispose } = await routeRuntime(adapter);
        try {
            const refused = await runtime.registry.dispatch('apply_rule', args);

            expect(refused).toMatchObject({
                errorKind: 'candidate_shape_invalid',
                retryable: true,
            });
            expect(adapter.openPhase).not.toHaveBeenCalled();
        } finally {
            await dispose();
        }
    });
});
