import { describe, expect, it } from 'vitest';
import { runAdsEnvironmentExperiment } from '../../src/validator/phase-orchestrator';
import { mockPage } from './phase-fixtures';
import { createHash } from 'node:crypto';
import { installPreflightDiagnosticLog } from '../../src/local/preflight-diagnostic-log';
import { BlockerVerificationMethod } from '../../src/environment/environment-proofs';
import { ConsoleCoverage, type IBrowserSession } from '../../src/browser/browser-interfaces';
import {
    EnvironmentAdapterLimitationCode,
    EnvironmentLimitationStage,
} from '../../src/environment/filtering-environment';
import { BrowserFallbackOrigin } from '../../src/types/browser-fallback-origin';
import { BrowserFallbackReason } from '../../src/types/browser-fallback-reason';
import type {
    AdapterPhaseLease,
    BoundEnvironmentPhaseHandle,
    EnvironmentPhaseEvidence,
    EnvironmentPhaseToken,
    FilteringEnvironmentAdapter,
    FilteringEnvironmentAdapterState,
    ValidatorPhaseCompletion,
} from '../../src/environment/filtering-environment';

/**
 * Drive the ordered-boundary experiment fixture through every adapter and recorder hook.
 *
 * @param options - Scenario switches applied while observing phases.
 * @returns The experiment result together with the ordered boundary call log.
 */
async function runOrderedExperiment(
    options: { baselineSymptomPresent?: boolean; navigationFailsIn?: 'A' | 'B' | 'C' } = {},
): Promise<{
    result: Awaited<ReturnType<typeof runAdsEnvironmentExperiment>>;
    calls: string[];
}> {
    const calls: string[] = [];
    const actualContext = {
        kind: 'browser_extension' as const,
        product: 'AdGuard Browser Extension',
        browser: 'CloakBrowser Chromium',
        productVersion: '5.0.0',
    };
    const state: FilteringEnvironmentAdapterState = {
        kind: 'browser_extension',
        lifecycle: 'ready',
        stateDigest: 'a'.repeat(64),
        actualContext,
        capabilities: ['browser_navigation', 'filtering_control', 'phase_proof'],
        preparation: null,
        baseline: null,
        openLeaseIds: [],
        cleanup: null,
    };
    const session = {
        artifactsDir: '/tmp/artifacts',
        isClosed: false,
        getPage: () => mockPage(),
        close: async () => {
            calls.push('close');
        },
        getNetworkLog: () => [],
        resetNetworkLog: () => undefined,
        getConsoleLog: () => [],
        consoleCoverage: ConsoleCoverage.BrowserLogOnly,
    } as IBrowserSession;
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- Scenario-local fixture.
    const filteringStateFor = (phase: 'A' | 'B' | 'C') => {
        if (phase === 'A') {
            return 'disabled' as const;
        }
        if (phase === 'B') {
            return 'published_baseline' as const;
        }
        return 'published_baseline_plus_candidate' as const;
    };
    /**
     * Exact single-line candidate rule this experiment fixture applies in C, with its digest.
     */
    const candidateRule = 'example.test##.ad';
    const candidateDigest = createHash('sha256').update(candidateRule, 'utf8').digest('hex');
    const adapter: FilteringEnvironmentAdapter = {
        kind: 'browser_extension',
        capabilities: () => state.capabilities,
        prepare: async () => ({ ready: true, state }),
        openPhase: async (request) => {
            calls.push(`open:${request.phase}`);
            const extensionProof = {
                packageVersion: '5.0.0',
                manifestVersion: '5.0.0',
                profileKind: 'agent_selected' as const,
                enabledListKeys: ['adguard:2'],
                activeRulesetListKeys: ['adguard:2'],
                stealthEnabled: false,
                userRulesDigest: request.phase === 'C' ? candidateDigest : null,
                application: {
                    method: BlockerVerificationMethod.ExtensionState,
                    appliedRules: request.phase === 'C' ? [candidateRule] : [],
                    actionLog: [],
                },
            };
            return {
                ready: true,
                handle: {
                    session,
                    adapterProof: {
                        leaseId: `lease-${request.phase}`,
                        adapterStateDigest: state.stateDigest,
                        phase: request.phase,
                        filteringState: filteringStateFor(request.phase),
                        sessionId: `session-${request.phase}`,
                        actualContext,
                        baselineDigest: request.phase === 'A' ? null : 'b'.repeat(64),
                        candidateDigest: request.phase === 'C' ? candidateDigest : null,
                        extension: request.phase === 'A' ? null : extensionProof,
                    },
                    close: async () => {
                        calls.push(`close:${request.phase}`);
                    },
                },
            };
        },
        drainOpenHandles: async () => ({ attempted: 0, closed: 0, failed: 0, failures: [] }),
        snapshot: () => structuredClone(state),
        cleanup: async () => ({
            attempted: true,
            completed: true,
            finalizerAttempts: 0,
            finalizerCompleted: 0,
            finalizerFailed: 0,
            failures: [],
        }),
    };
    const recorder = {
        beginPhase: (request: { phase: string }) => {
            calls.push(`begin:${request.phase}`);
            return {
                tokenId: `token-${request.phase}`,
                runId: 'run-6',
                experimentId: 'experiment-1',
                phase: request.phase as 'A' | 'B' | 'C',
            };
        },
        bindPhaseLease: (
            token: EnvironmentPhaseToken,
            lease: AdapterPhaseLease,
            _state: FilteringEnvironmentAdapterState,
        ): BoundEnvironmentPhaseHandle => {
            calls.push(`bind:${token.phase}`);
            return { token, lease };
        },
        completePhase: (
            token: EnvironmentPhaseToken,
            completion: ValidatorPhaseCompletion,
        ): EnvironmentPhaseEvidence => {
            calls.push(`complete:${token.phase}`);
            return {
                runId: 'run-6',
                experimentId: 'experiment-1',
                phase: token.phase as 'A' | 'B' | 'C',
                proof: {
                    leaseId: `lease-${token.phase}`,
                    adapterStateDigest: state.stateDigest,
                    phase: token.phase as 'A' | 'B' | 'C',
                    filteringState: filteringStateFor(token.phase),
                    sessionId: `session-${token.phase}`,
                    actualContext,
                    baselineDigest: token.phase === 'A' ? null : 'b'.repeat(64),
                    candidateDigest: token.phase === 'C' ? candidateDigest : null,
                    extension: null,
                },
                completion,
            };
        },
    };

    const result = await runAdsEnvironmentExperiment({
        runId: 'run-6',
        experimentId: 'experiment-1',
        adapter,
        recorder,
        targetUrl: 'https://example.test/',
        candidate: { operation: 'add', rule: 'example.test##.ad' },
        observe: async ({ phase, proof }) => {
            if (phase === options.navigationFailsIn) {
                return {
                    kind: 'failed',
                    sessionId: proof.sessionId,
                    limitation: {
                        code: EnvironmentAdapterLimitationCode.PhaseNavigationFailed,
                        stage: EnvironmentLimitationStage.Phase,
                        detail: `Phase ${phase} navigation failed (http_blocked)`,
                    },
                    navigationFallbackReason: BrowserFallbackReason.HttpBlocked,
                };
            }
            let candidateValidation: Extract<
                ValidatorPhaseCompletion,
                { kind: 'observed' }
            >['candidateValidation'] = null;
            if (phase === 'C') {
                candidateValidation = {
                    validationArtifactId: 'validation-candidate',
                    candidateDigest: proof.candidateDigest!,
                    verified: true,
                    screenshotArtifactIds: ['before', 'after', 'before-full', 'after-full'],
                };
            }
            return {
                kind: 'observed',
                sessionId: proof.sessionId,
                targetUrl: 'https://example.test/',
                targetObservation: {
                    symptomPresent:
                        phase === 'B' ? (options.baselineSymptomPresent ?? true) : phase !== 'C',
                    pageUsable: true,
                },
                navigationVerified: true,
                artifacts: [],
                vision: null,
                candidateValidation,
                rejectedCandidates: [],
            };
        },
    });

    return { result, calls };
}

describe('runAdsEnvironmentExperiment', () => {
    it('uses ordered recorder/adapter boundaries and verifies the same Ads target in B/C', async () => {
        const { result, calls } = await runOrderedExperiment();

        expect(result.verdict).toBe('verified');
        expect(result.inconclusiveReason).toBeUndefined();
        expect(calls).toEqual([
            'begin:A',
            'open:A',
            'bind:A',
            'complete:A',
            'close:A',
            'begin:B',
            'open:B',
            'bind:B',
            'complete:B',
            'close:B',
            'begin:C',
            'open:C',
            'bind:C',
            'complete:C',
            'close:C',
        ]);
    });

    it('names the absent baseline symptom instead of returning a bare inconclusive verdict', async () => {
        const { result, calls } = await runOrderedExperiment({ baselineSymptomPresent: false });

        expect(result.verdict).toBe('inconclusive');
        expect(result.inconclusiveReason).toBe('baseline_symptom_absent');
        expect(result.limitation).toBeNull();
        expect(calls).not.toContain('open:C');
    });

    it.each([
        { phase: 'A' as const, opened: ['open:A'] },
        { phase: 'C' as const, opened: ['open:A', 'open:B', 'open:C'] },
    ])(
        'ends inconclusive on the phase whose browser could not load the page: $phase',
        async (row) => {
            const { result, calls } = await runOrderedExperiment({ navigationFailsIn: row.phase });

            // The page stopped the phase, not the environment: no limitation, and no phase after
            // the failed one opens.
            expect(result).toMatchObject({
                verdict: 'inconclusive',
                limitation: null,
                inconclusiveReason: 'phase_navigation_failed',
                failedNavigation: { phase: row.phase, origin: BrowserFallbackOrigin.Site },
            });
            expect(calls.filter((call) => call.startsWith('open:'))).toEqual(row.opened);
        },
    );

    it('settles the bound phase as failed when the validation deadline aborts mid-observation', async () => {
        const calls: string[] = [];
        const completions: ValidatorPhaseCompletion[] = [];
        const controller = new AbortController();
        const actualContext = {
            kind: 'browser_extension' as const,
            product: 'AdGuard Browser Extension',
            browser: 'CloakBrowser Chromium',
            productVersion: '5.0.0',
        };
        const state: FilteringEnvironmentAdapterState = {
            kind: 'browser_extension',
            lifecycle: 'ready',
            stateDigest: 'a'.repeat(64),
            actualContext,
            capabilities: ['browser_navigation', 'filtering_control', 'phase_proof'],
            preparation: null,
            baseline: null,
            openLeaseIds: [],
            cleanup: null,
        };
        const session = {
            artifactsDir: '/tmp/artifacts',
            isClosed: false,
            getPage: () => mockPage(),
            close: async () => {},
            getNetworkLog: () => [],
            resetNetworkLog: () => undefined,
            getConsoleLog: () => [],
            consoleCoverage: ConsoleCoverage.BrowserLogOnly,
        } as IBrowserSession;
        const adapter: FilteringEnvironmentAdapter = {
            kind: 'browser_extension',
            capabilities: () => state.capabilities,
            prepare: async () => ({ ready: true, state }),
            openPhase: async (request) => ({
                ready: true,
                handle: {
                    session,
                    adapterProof: {
                        leaseId: `lease-${request.phase}`,
                        adapterStateDigest: state.stateDigest,
                        phase: request.phase,
                        filteringState: 'disabled' as const,
                        sessionId: `session-${request.phase}`,
                        actualContext,
                        baselineDigest: null,
                        candidateDigest: null,
                        extension: null,
                    },
                    close: async () => {
                        calls.push(`close:${request.phase}`);
                    },
                },
            }),
            drainOpenHandles: async () => ({ attempted: 0, closed: 0, failed: 0, failures: [] }),
            snapshot: () => structuredClone(state),
            cleanup: async () => ({
                attempted: true,
                completed: true,
                finalizerAttempts: 0,
                finalizerCompleted: 0,
                finalizerFailed: 0,
                failures: [],
            }),
        };
        const recorder = {
            beginPhase: (request: { phase: string }) => ({
                tokenId: `token-${request.phase}`,
                runId: 'run-6',
                experimentId: 'experiment-1',
                phase: request.phase as 'A' | 'B' | 'C',
            }),
            bindPhaseLease: (
                token: EnvironmentPhaseToken,
                lease: AdapterPhaseLease,
                _state: FilteringEnvironmentAdapterState,
            ): BoundEnvironmentPhaseHandle => {
                calls.push(`bind:${token.phase}`);
                return { token, lease };
            },
            completePhase: (
                token: EnvironmentPhaseToken,
                completion: ValidatorPhaseCompletion,
            ): EnvironmentPhaseEvidence => {
                calls.push(`complete:${token.phase}`);
                completions.push(completion);
                return {
                    runId: 'run-6',
                    experimentId: 'experiment-1',
                    phase: token.phase as 'A' | 'B' | 'C',
                    proof: {
                        leaseId: `lease-${token.phase}`,
                        adapterStateDigest: state.stateDigest,
                        phase: token.phase as 'A' | 'B' | 'C',
                        filteringState: 'disabled' as const,
                        sessionId: `session-${token.phase}`,
                        actualContext,
                        baselineDigest: null,
                        candidateDigest: null,
                        extension: null,
                    },
                    completion,
                };
            },
        };

        const result = await runAdsEnvironmentExperiment({
            runId: 'run-6',
            experimentId: 'experiment-1',
            adapter,
            recorder,
            targetUrl: 'https://example.test/',
            candidate: { operation: 'add', rule: 'example.test##.ad' },
            signal: controller.signal,
            observe: () => {
                // The observation never settles on its own: only the deadline abort may end it.
                setTimeout(() => controller.abort(), 10);
                return new Promise<ValidatorPhaseCompletion>(() => {});
            },
        });

        expect(result.verdict).toBe('capability_limited');
        expect(result.limitation?.code).toBe('phase_proof_unavailable');
        expect(calls).toEqual(['bind:A', 'complete:A', 'close:A']);
        expect(completions).toHaveLength(1);
        expect(completions[0]!.kind).toBe('failed');
    });

    it('records the underlying observation failure in the run diagnostics', async () => {
        const recorded: Array<{ channel: string; detail: unknown }> = [];
        installPreflightDiagnosticLog({
            path: '(memory)',
            record: (channel, detail) => {
                recorded.push({ channel, detail });
            },
            close: () => undefined,
        });
        const actualContext = {
            kind: 'browser_extension' as const,
            product: 'AdGuard Browser Extension',
            browser: 'CloakBrowser Chromium',
            productVersion: '5.0.0',
        };
        const state: FilteringEnvironmentAdapterState = {
            kind: 'browser_extension',
            lifecycle: 'ready',
            stateDigest: 'a'.repeat(64),
            actualContext,
            capabilities: ['browser_navigation', 'filtering_control', 'phase_proof'],
            preparation: null,
            baseline: null,
            openLeaseIds: [],
            cleanup: null,
        };
        const session = {
            artifactsDir: '/tmp/artifacts',
            isClosed: false,
            getPage: () => mockPage(),
            close: async () => undefined,
            getNetworkLog: () => [],
            resetNetworkLog: () => undefined,
            getConsoleLog: () => [],
            consoleCoverage: ConsoleCoverage.BrowserLogOnly,
        } as IBrowserSession;
        const adapter: FilteringEnvironmentAdapter = {
            kind: 'browser_extension',
            capabilities: () => state.capabilities,
            prepare: async () => ({ ready: true, state }),
            openPhase: async (request) => ({
                ready: true,
                handle: {
                    session,
                    adapterProof: {
                        leaseId: `lease-${request.phase}`,
                        adapterStateDigest: state.stateDigest,
                        phase: request.phase,
                        filteringState: 'disabled',
                        sessionId: `session-${request.phase}`,
                        actualContext,
                        baselineDigest: null,
                        candidateDigest: null,
                        extension: null,
                    },
                    close: async () => undefined,
                },
            }),
            drainOpenHandles: async () => ({ attempted: 0, closed: 0, failed: 0, failures: [] }),
            snapshot: () => structuredClone(state),
            cleanup: async () => ({
                attempted: true,
                completed: true,
                finalizerAttempts: 0,
                finalizerCompleted: 0,
                finalizerFailed: 0,
                failures: [],
            }),
        };
        const recorder = {
            beginPhase: (request: { phase: string }) => ({
                tokenId: `token-${request.phase}`,
                runId: 'run-7',
                experimentId: 'experiment-2',
                phase: request.phase as 'A' | 'B' | 'C',
            }),
            bindPhaseLease: (
                token: EnvironmentPhaseToken,
                lease: AdapterPhaseLease,
                _state: FilteringEnvironmentAdapterState,
            ): BoundEnvironmentPhaseHandle => ({ token, lease }),
            completePhase: (
                token: EnvironmentPhaseToken,
                completion: ValidatorPhaseCompletion,
            ): EnvironmentPhaseEvidence => ({
                runId: 'run-7',
                experimentId: 'experiment-2',
                phase: token.phase as 'A' | 'B' | 'C',
                proof: {
                    leaseId: `lease-${token.phase}`,
                    adapterStateDigest: state.stateDigest,
                    phase: token.phase as 'A' | 'B' | 'C',
                    filteringState: 'disabled',
                    sessionId: `session-${token.phase}`,
                    actualContext,
                    baselineDigest: null,
                    candidateDigest: null,
                    extension: null,
                },
                completion,
            }),
        };

        try {
            const result = await runAdsEnvironmentExperiment({
                runId: 'run-7',
                experimentId: 'experiment-2',
                adapter,
                recorder,
                targetUrl: 'https://example.test/',
                candidate: { operation: 'add', rule: 'example.test##.ad' },
                observe: async () => {
                    throw new Error('net::ERR_TIMED_OUT at https://example.test/');
                },
            });

            expect(result.limitation).toMatchObject({ code: 'phase_proof_unavailable' });
            expect(recorded).toContainEqual(
                expect.objectContaining({
                    channel: 'cli_phase',
                    detail: expect.objectContaining({
                        note: 'phase_observation_failed',
                        phase: 'A',
                        error: expect.objectContaining({
                            message: expect.stringContaining('ERR_TIMED_OUT'),
                        }),
                    }),
                }),
            );
        } finally {
            installPreflightDiagnosticLog(null);
        }
    });
});
