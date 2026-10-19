import { PhaseLabel } from '../types/validation';
import {
    describeDiagnosticError,
    recordPreflightDiagnostic,
} from '../local/preflight-diagnostic-log';
import type { IBrowserSession } from '../browser/browser-interfaces';
import {
    EnvironmentAdapterLimitationCode,
    EnvironmentLimitationStage,
    type AdapterPhaseLease,
    type BeginEnvironmentPhaseRequest,
    type BoundEnvironmentPhaseHandle,
    type EnvironmentAdapterLimitation,
    type EnvironmentCandidate,
    type EnvironmentPhaseEvidence,
    type EnvironmentPhaseToken,
    type FilteringEnvironmentAdapter,
    type FilteringEnvironmentAdapterState,
    type ValidatorPhaseCompletion,
} from '../environment/filtering-environment';
import {
    type EnvironmentPhase,
    type EnvironmentPhaseStateProof,
} from '../environment/environment-proofs';
import { failedPhaseNavigation, navigationFailedResult } from './experiment-navigation-failure';
import {
    AdsEnvironmentExperimentVerdict,
    ExperimentInconclusiveReason,
    type AdsEnvironmentExperimentResult,
} from './ads-environment-experiment-result';

/**
 * Recorder surface required by the shared Ads experiment.
 */
export interface AdsEnvironmentExperimentRecorder {
    /**
     * Issue one exact run/experiment/phase token.
     *
     * @param request - Exact requested phase boundary.
     * @returns Opaque recorder token.
     */
    beginPhase(request: BeginEnvironmentPhaseRequest): EnvironmentPhaseToken;

    /**
     * Bind a ready adapter lease before any validator observation.
     *
     * @param token - Recorder-issued token.
     * @param lease - Ready adapter lease.
     * @param state - Adapter-only state observed with the lease.
     * @returns Bound handle accepted for observation.
     */
    bindPhaseLease(
        token: EnvironmentPhaseToken,
        lease: AdapterPhaseLease,
        state: FilteringEnvironmentAdapterState,
    ): BoundEnvironmentPhaseHandle;

    /**
     * Submit one complete observed-or-failed outcome.
     *
     * @param token - Bound recorder token.
     * @param completion - Complete validator outcome.
     * @returns Canonical phase evidence.
     */
    completePhase(
        token: EnvironmentPhaseToken,
        completion: ValidatorPhaseCompletion,
    ): EnvironmentPhaseEvidence;
}

/**
 * Inputs exposed to one environment-independent browser observer.
 */
export interface AdsEnvironmentPhaseObservationInput {
    /**
     * Exact phase being observed.
     */
    phase: EnvironmentPhase;

    /**
     * Recorder-issued phase token used only for host-owned physical artifact identity.
     */
    phaseTokenId: string;

    /**
     * Common browser session established by the adapter.
     */
    session: IBrowserSession;

    /**
     * Adapter-authored exact phase proof.
     */
    proof: EnvironmentPhaseStateProof;

    /**
     * The experiment's cooperative cancellation, when the outer tool deadline provided one. An
     * observer threads it into the out-of-loop vision calls it makes, so an expired deadline
     * cancels the in-flight completion instead of leaving the tool awaiting a reply nothing will
     * read. The phase's own browser work is bounded by the abort race in `racePhaseAbort`.
     */
    signal?: AbortSignal;
}

/**
 * Inputs one environment phase execution needs, with or without a candidate.
 */
export interface EnvironmentPhaseExecutionConfig {
    /**
     * Run identity owned by the outer lifecycle.
     */
    runId: string;

    /**
     * Stable identity shared by this attempt's phases.
     */
    experimentId: string;

    /**
     * Already selected and prepared filtering adapter.
     */
    adapter: FilteringEnvironmentAdapter;

    /**
     * Sole canonical environment execution recorder.
     */
    recorder: AdsEnvironmentExperimentRecorder;

    /**
     * Canonical issue target URL.
     */
    targetUrl: string;

    /**
     * Exact candidate for C, or null when this attempt has none.
     */
    candidate: EnvironmentCandidate | null;

    /**
     * Official list-key subset for phase B, or null for the whole locked baseline.
     */
    enabledListKeys?: readonly string[] | null;

    /**
     * Collect complete browser facts for one adapter-established phase.
     *
     * @param input - Common session plus exact phase proof.
     * @returns Complete validator-owned observation.
     */
    observe(input: AdsEnvironmentPhaseObservationInput): Promise<ValidatorPhaseCompletion>;

    /**
     * Optional cooperative cancellation for the whole experiment.
     *
     * When the outer tool deadline fires, the abort lets each in-flight phase record a failed
     * completion and close its session instead of leaking a bound lease that would fail run
     * finalization with an opaque unsettled-phase error.
     */
    signal?: AbortSignal;
}

/**
 * Shared Ads A/B/C experiment inputs.
 */
export interface AdsEnvironmentExperimentConfig extends EnvironmentPhaseExecutionConfig {
    /**
     * Exact additive candidate applied in C.
     */
    candidate: EnvironmentCandidate;
}

/**
 * One successfully observed and closed environment phase.
 */
export interface CompletedEnvironmentPhaseResult {
    /**
     * Discriminator for a completed phase.
     */
    completed: true;

    /**
     * Canonical recorder-owned evidence.
     */
    evidence: EnvironmentPhaseEvidence;

    /**
     * Explicit proof that close did not produce a limitation.
     */
    closeLimitation: null;
}

/**
 * One environment phase stopped by observation, capability, or cleanup failure.
 */
export interface LimitedEnvironmentPhaseResult {
    /**
     * Discriminator for a stopped phase.
     */
    completed: false;

    /**
     * Canonical evidence when observation reached recorder completion.
     */
    evidence: EnvironmentPhaseEvidence | null;

    /**
     * Stable reason the phase could not complete.
     */
    limitation: EnvironmentAdapterLimitation;
}

/**
 * Result of one complete environment phase lifecycle.
 */
export type EnvironmentPhaseRunResult =
    | CompletedEnvironmentPhaseResult
    | LimitedEnvironmentPhaseResult;

/**
 * Reject the returned promise as soon as the cooperative cancellation signal fires.
 *
 * The phase observation cannot abort its browser work mid-flight, but the rejection routes through
 * the existing failure path so the phase records a failed completion instead of leaking its lease.
 *
 * @param work - In-flight phase observation.
 * @param signal - Cooperative cancellation signal, when the outer deadline provided one.
 * @returns The observation outcome unless the abort wins the race.
 */
async function racePhaseAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
        return work;
    }
    if (signal.aborted) {
        // Keep handlers attached to the in-flight work so its later settlement is never
        // reported as an unhandled rejection.
        work.then(
            () => undefined,
            () => undefined,
        );
        throw new Error('phase observation aborted by the validation deadline');
    }
    return await Promise.race([
        work,
        new Promise<never>((resolve, reject) => {
            signal.addEventListener(
                'abort',
                () => reject(new Error('phase observation aborted by the validation deadline')),
                { once: true },
            );
        }),
    ]);
}

/**
 * Stable limitation returned when the outer validation deadline stops a phase.
 *
 * @returns Phase-scoped proof limitation.
 */
function deadlineAbortLimitation(): EnvironmentAdapterLimitation {
    return {
        code: EnvironmentAdapterLimitationCode.PhaseProofUnavailable,
        stage: EnvironmentLimitationStage.Phase,
        detail: 'The validation deadline stopped the controlled browser observation.',
    };
}

/**
 * Establish, bind, observe, complete, and close one environment phase.
 *
 * @param config - Shared phase execution configuration.
 * @param phase - Exact phase to execute.
 * @returns Canonical evidence or typed limitation.
 */
export async function executeEnvironmentPhase(
    config: EnvironmentPhaseExecutionConfig,
    phase: EnvironmentPhase,
): Promise<EnvironmentPhaseRunResult> {
    if (config.signal?.aborted) {
        return { completed: false, evidence: null, limitation: deadlineAbortLimitation() };
    }
    const token = config.recorder.beginPhase({
        runId: config.runId,
        experimentId: config.experimentId,
        phase,
    });
    const opened = await config.adapter.openPhase({
        experimentId: config.experimentId,
        phase,
        targetUrl: config.targetUrl,
        candidate: phase === PhaseLabel.C ? config.candidate : null,
        // Phase A has nothing enabled and phase C is bound to the baseline phase state, so B is the
        // only phase that may narrow the enabled official set.
        enabledListKeys: phase === PhaseLabel.B ? (config.enabledListKeys ?? null) : null,
        // Forwarded so a B/C application session started inside this phase aborts with the
        // experiment instead of outliving it on its own per-session budget.
        ...(config.signal === undefined ? {} : { signal: config.signal }),
    });
    if (!opened.ready) {
        return { completed: false, evidence: null, limitation: opened.limitation };
    }
    if (config.signal?.aborted) {
        // The session was established before the abort landed: close it without binding a lease so
        // the ledger never sees an unsettled entry for a phase that never observed anything.
        try {
            await opened.handle.close();
        } catch (error) {
            recordPreflightDiagnostic('cli_phase', {
                note: 'phase_close_failed',
                phase,
                error: describeDiagnosticError(error),
            });
        }
        return { completed: false, evidence: null, limitation: deadlineAbortLimitation() };
    }
    // The recorder is the one gate for the bound proof: `bindPhaseLease` parses it against the full
    // phase-proof contract (including the required application record) and throws on a mismatch, so
    // a bound handle here has already proved it — there is nothing left for this orchestrator to
    // refuse before observation.
    config.recorder.bindPhaseLease(token, opened.handle, config.adapter.snapshot());
    let evidence: EnvironmentPhaseEvidence | null = null;
    let observationFailed = false;
    let closeFailed = false;
    try {
        const completion = await racePhaseAbort(
            config.observe({
                phase,
                phaseTokenId: token.tokenId,
                session: opened.handle.session,
                proof: opened.handle.adapterProof,
                ...(config.signal === undefined ? {} : { signal: config.signal }),
            }),
            config.signal,
        );
        evidence = config.recorder.completePhase(token, completion);
    } catch (error) {
        observationFailed = true;
        // The public limitation is deliberately finite; without this record the run cannot say
        // what actually stopped the observation (a navigation timeout, a crashed session, …).
        recordPreflightDiagnostic('cli_phase', {
            note: 'phase_observation_failed',
            phase,
            error: describeDiagnosticError(error),
        });
        evidence = config.recorder.completePhase(token, {
            kind: 'failed',
            sessionId: opened.handle.adapterProof.sessionId,
            limitation: {
                code: EnvironmentAdapterLimitationCode.PhaseProofUnavailable,
                stage: EnvironmentLimitationStage.Phase,
                detail: 'The controlled browser observation did not complete.',
            },
        });
    } finally {
        try {
            await opened.handle.close();
        } catch (error) {
            closeFailed = true;
            recordPreflightDiagnostic('cli_phase', {
                note: 'phase_close_failed',
                phase,
                error: describeDiagnosticError(error),
            });
        }
    }
    if (closeFailed) {
        return {
            completed: false,
            evidence,
            limitation: {
                code: EnvironmentAdapterLimitationCode.CleanupFailed,
                stage: EnvironmentLimitationStage.Cleanup,
                detail: 'The phase browser handle did not close completely.',
            },
        };
    }
    if (observationFailed) {
        return {
            completed: false,
            evidence,
            limitation: {
                code: EnvironmentAdapterLimitationCode.PhaseProofUnavailable,
                stage: EnvironmentLimitationStage.Phase,
                detail: 'The controlled browser observation did not complete.',
            },
        };
    }
    return { completed: true, evidence: evidence!, closeLimitation: null };
}

/**
 * Run a true environment-backed Ads A/B/C experiment with one canonical recorder flow.
 *
 * @param config - Locked adapter, recorder, target, candidate, and browser observer.
 * @returns Intent-aware provisional verdict without performing outer adapter cleanup.
 */
export async function runAdsEnvironmentExperiment(
    config: AdsEnvironmentExperimentConfig,
): Promise<AdsEnvironmentExperimentResult> {
    const phases: EnvironmentPhaseEvidence[] = [];
    for (const phase of [PhaseLabel.A, PhaseLabel.B] as const) {
        if (config.signal?.aborted) {
            return {
                verdict: AdsEnvironmentExperimentVerdict.CapabilityLimited,
                phases,
                limitation: deadlineAbortLimitation(),
            };
        }
        const result = await executeEnvironmentPhase(config, phase);
        if (result.evidence) {
            phases.push(result.evidence);
        }
        if (!result.completed) {
            return {
                verdict:
                    result.limitation.stage === EnvironmentLimitationStage.Cleanup
                        ? AdsEnvironmentExperimentVerdict.Failed
                        : AdsEnvironmentExperimentVerdict.CapabilityLimited,
                phases,
                limitation: result.limitation,
            };
        }
        const navigationFailure = failedPhaseNavigation(result.evidence);
        if (navigationFailure) {
            // The next phase opens the same page from the same network: running it costs a phase
            // and its vision review and cannot rescue a comparison that has lost one side.
            return navigationFailedResult(phases, navigationFailure);
        }
    }
    const baseline = phases.find((phase) => phase.phase === PhaseLabel.B);
    if (
        baseline?.completion.kind !== 'observed' ||
        !baseline.completion.navigationVerified ||
        !baseline.completion.targetObservation.symptomPresent
    ) {
        // A cleanly observed baseline without the symptom is diagnosable evidence, not a fault:
        // the symptom description handed to the observer did not describe what actually differs.
        const diagnosable =
            baseline?.completion.kind === 'observed' &&
            baseline.completion.navigationVerified &&
            !baseline.completion.targetObservation.symptomPresent;
        return {
            verdict: AdsEnvironmentExperimentVerdict.Inconclusive,
            phases,
            limitation: null,
            ...(diagnosable
                ? { inconclusiveReason: ExperimentInconclusiveReason.BaselineSymptomAbsent }
                : { inconclusiveReason: undefined }),
        };
    }
    if (config.signal?.aborted) {
        return {
            verdict: AdsEnvironmentExperimentVerdict.CapabilityLimited,
            phases,
            limitation: deadlineAbortLimitation(),
        };
    }
    const candidate = await executeEnvironmentPhase(config, PhaseLabel.C);
    if (candidate.evidence) {
        phases.push(candidate.evidence);
    }
    if (!candidate.completed) {
        return {
            verdict:
                candidate.limitation.stage === EnvironmentLimitationStage.Cleanup
                    ? AdsEnvironmentExperimentVerdict.Failed
                    : AdsEnvironmentExperimentVerdict.CapabilityLimited,
            phases,
            limitation: candidate.limitation,
        };
    }
    const candidateNavigationFailure = failedPhaseNavigation(candidate.evidence);
    if (candidateNavigationFailure) {
        return navigationFailedResult(phases, candidateNavigationFailure);
    }
    const completion = candidate.evidence.completion;
    const verified =
        completion.kind === 'observed' &&
        completion.navigationVerified &&
        !completion.targetObservation.symptomPresent &&
        completion.targetObservation.pageUsable &&
        completion.candidateValidation?.verified === true &&
        completion.candidateValidation.candidateDigest === candidate.evidence.proof.candidateDigest;
    return {
        verdict: verified
            ? AdsEnvironmentExperimentVerdict.Verified
            : AdsEnvironmentExperimentVerdict.Inconclusive,
        phases,
        limitation: null,
    };
}
