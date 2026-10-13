import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import type { BrowserToolHandlers } from '../browser/browser-tools';
import type { TraceRecorder } from '../tracer/trace-recorder';
import { TraceEventType } from '../types/trace';
import {
    AdElementPresence,
    PhaseLabel,
    FullPageTileCoverageSchema,
    StructuralSnapshotSchema,
    ValidationViewportPositionSchema,
    type PhaseResult,
    type ElementGeometry,
    type FactualValidationResult,
    type StructuralSnapshot,
    type FullPageTileCoverage,
    type FullPageTileWindow,
    type RuleApplicationFact,
    type ValidationViewportPosition,
} from '../types/validation';
import {
    describeDiagnosticError,
    recordPreflightDiagnostic,
} from '../local/preflight-diagnostic-log';
import { checkAntiAdblock } from './anti-adblock-check';
import {
    applyRule,
    clearAppliedNetworkRules,
    extractAdSelector,
    type RuleApplicationResult,
} from './rule-applicator';
import { RuleKind, normalizeRule } from '../repo/rule-normalizer';
import {
    calculateTrustedBaselineHash,
    type TrustedValidationContext,
} from './trusted-validation-context';
import type { Page } from 'playwright-core';
import {
    createTrustedPageEvaluator,
    type TrustedPageEvaluator,
} from '../browser/trusted-page-evaluator';
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
 * Intent-aware provisional verdict of a shared Ads A/B/C environment experiment.
 */
export const AdsEnvironmentExperimentVerdict = {
    /**
     * The controlled baseline and candidate phases together confirmed the intended effect.
     */
    Verified: 'verified',

    /**
     * The experiment completed without establishing whether the intended effect held.
     */
    Inconclusive: 'inconclusive',

    /**
     * A required environment capability was not available to complete the experiment.
     */
    CapabilityLimited: 'capability_limited',

    /**
     * A phase stopped with an environment or cleanup failure rather than a limitation.
     */
    Failed: 'failed',
} as const;

/**
 * AdsEnvironmentExperimentVerdict value.
 */
export type AdsEnvironmentExperimentVerdict =
    (typeof AdsEnvironmentExperimentVerdict)[keyof typeof AdsEnvironmentExperimentVerdict];

/**
 * Result of a shared Ads A/B/C experiment before outer cleanup finalization.
 */
export interface AdsEnvironmentExperimentResult {
    /**
     * Intent-aware provisional verdict.
     */
    verdict: AdsEnvironmentExperimentVerdict;

    /**
     * Canonical recorder-owned phase evidence completed before the verdict.
     */
    phases: EnvironmentPhaseEvidence[];

    /**
     * Stable limitation when a phase could not be established or observed.
     */
    limitation: EnvironmentAdapterLimitation | null;

    /**
     * Why an inconclusive experiment stopped, when the cause is diagnosable evidence rather than an
     * environment fault.
     *
     * `baseline_symptom_absent` means every phase ran cleanly but the reporter symptom was not
     * observed in the controlled baseline, so phase C was never worth running.
     */
    inconclusiveReason?: 'baseline_symptom_absent';
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
            ...(diagnosable ? { inconclusiveReason: 'baseline_symptom_absent' as const } : {}),
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

/**
 * Configuration for a single phase of validation.
 */
export interface PhaseConfig {
    /**
     * The browser tool handlers to use for this phase.
     */
    handlers: BrowserToolHandlers;

    /**
     * The Playwright Page object to operate on.
     */
    page: Page;

    /**
     * Directory where artifacts (screenshots, HAR, DOM) are written.
     */
    artifactsDir: string;

    /**
     * The phase label (A, B, or C).
     */
    phase: PhaseLabel;

    /**
     * The URL to navigate to.
     */
    url: string;

    /**
     * The filter rules active during this phase.
     */
    rules: string[];

    /**
     * Runner-owned evaluator isolated from website main-world JavaScript.
     */
    trustedPageEvaluator: TrustedPageEvaluator;

    /**
     * Optional CSS selector of the ad element to probe.
     */
    adElementSelector?: string;

    /**
     * Optional document-space vertical span restricting original-resolution tile capture.
     *
     * Candidate validations localize the symptom element first, so capturing the whole document is
     * pure cost on tall pages; the span bounds the tile plan to the symptom neighborhood while the
     * full-page overview keeps the global context.
     */
    tileWindow?: FullPageTileWindow;

    /**
     * Optional reveal steps the host replays identically in every phase.
     *
     * Some symptoms exist only once the page has waited or been touched: a popup that opens a few
     * seconds after load, a player hidden behind an age dialog. A phase that never waits or
     * interacts observes a page the report is not about. The replay runs after this phase's rules
     * are applied and before any capture, which is the only point at which all three phases have
     * reached the same state by the same route.
     *
     * Must record its own failures rather than reject: a page that died mid-interaction still has
     * captures worth comparing, and rejecting here would discard them along with the evidence of
     * what the interaction did.
     */
    interact?: () => Promise<void>;

    /**
     * Optional cosmetic candidate applied after a full-page materialization capture.
     */
    deferredRule?: string;

    /**
     * Bounded lazy-content materialization required before a deferred rule is tested.
     */
    materialize?: () => Promise<boolean>;

    /**
     * Optional callback that scrolls the reported target to a deterministic viewport position.
     */
    createViewportAnchor?: () => Promise<ValidationViewportPosition | null>;

    /**
     * Optional callback that restores and verifies a previously recorded viewport position.
     */
    restoreViewportAnchor?: (
        anchor: ValidationViewportPosition,
    ) => Promise<ValidationViewportPosition | null>;

    /**
     * Optional same-document baseline probe run after materialization and before the deferred rule.
     */
    beforeDeferredRule?: () => Promise<void>;

    /**
     * Optional causal probe run immediately after the deferred rule is injected.
     */
    afterDeferredRule?: () => Promise<void>;

    /**
     * Optional raw structure probe run after screenshot, network, and DOM artifacts are captured.
     */
    afterArtifacts?: () => Promise<void>;

    /**
     * Optional restoration probe run after the deferred cosmetic style is removed.
     */
    afterDeferredRuleRemoved?: () => Promise<void>;

    /**
     * Whether this phase must capture overlapping original-resolution tiles for vision review.
     */
    captureVisualTiles?: boolean;

    /**
     * Trace recorder for logging phase events.
     */
    recorder: TraceRecorder;
}

/**
 * Configuration for the full three-phase validation run.
 */
export interface ValidationConfig {
    /**
     * The browser tool handlers.
     */
    handlers: BrowserToolHandlers;

    /**
     * The Playwright Page object.
     */
    page: Page;

    /**
     * Directory where artifacts are written.
     */
    artifactsDir: string;

    /**
     * Trace recorder for logging phase events and registering artifacts.
     */
    recorder: TraceRecorder;

    /**
     * The reported site URL to validate against.
     */
    url: string;

    /**
     * The candidate filter rule to validate.
     */
    candidateRule: string;

    /**
     * Existing repo filter rules for the reported domain (Phase B baseline).
     */
    existingRules: string[];

    /**
     * Exact first-parent rule that the candidate replaces in Phase C.
     *
     * This is reserved for the closed human oracle. Normal agent candidates omit it and retain the
     * standard additive Phase C behavior.
     */
    replacedRule?: string;

    /**
     * Runner-bound issue URL and canonical repository baseline. Direct unit callers may omit this;
     * production apply_rule calls must provide it.
     */
    trustedValidationContext?: TrustedValidationContext;

    /**
     * Explicit main-world fallback for unit tests. Production callers must leave this false or
     * undefined so every verdict-bearing probe uses a Chromium CDP isolated world.
     */
    testOnlyAllowMainWorldProbeFallback?: boolean;

    /**
     * Optional CSS selector of the ad element to probe for a network candidate. Cosmetic candidates
     * always use the selector extracted from the candidate rule.
     */
    adElementSelector?: string;
}

/**
 * Resolve and validate the runner-bound context recorded in a factual validation artifact.
 *
 * @param url - Exact URL that validation will navigate to.
 * @param existingRules - Phase B repository baseline.
 * @param supplied - Optional context created by the trusted runner.
 * @returns A context whose URL, rules, and hash agree with the validation inputs.
 */
function resolveTrustedValidationContext(
    url: string,
    existingRules: string[],
    supplied?: TrustedValidationContext,
): TrustedValidationContext {
    const baselineHash = calculateTrustedBaselineHash(url, existingRules);
    if (!supplied) {
        return {
            reportedUrl: url,
            existingRules: [...existingRules],
            baselineHash,
        };
    }
    const sameRules =
        supplied.existingRules.length === existingRules.length &&
        supplied.existingRules.every((rule, index) => rule === existingRules[index]);
    if (supplied.reportedUrl !== url || supplied.baselineHash !== baselineHash || !sameRules) {
        throw new Error('Trusted validation context does not match the A/B/C inputs.');
    }
    return supplied;
}

/**
 * Derive the Phase C baseline for an exact human-rule replacement.
 *
 * Phase B always retains the first-parent rule. Phase C removes exactly one canonical match before
 * adding the replacement candidate. Missing or ambiguous parents fail closed so a narrowed rule can
 * never be credited merely because it was layered over the broader parent behavior.
 *
 * @param existingRules - Trusted first-parent Phase B baseline.
 * @param candidateRule - Complete added replacement line.
 * @param replacedRule - Exact removed first-parent line, when this is a replacement experiment.
 * @returns Existing rules to apply before the candidate in Phase C.
 */
function resolvePhaseCExistingRules(
    existingRules: string[],
    candidateRule: string,
    replacedRule?: string,
): string[] {
    if (replacedRule === undefined) {
        return [...existingRules];
    }
    const parent = normalizeRule(replacedRule);
    const candidate = normalizeRule(candidateRule);
    if (
        !parent.syntaxKind ||
        !candidate.syntaxKind ||
        parent.kind !== candidate.kind ||
        parent.syntaxKind !== candidate.syntaxKind ||
        parent.canonical === candidate.canonical
    ) {
        throw new Error('Replacement parent rule is incompatible with the candidate rule.');
    }
    const parentIndexes = existingRules.flatMap((rule, index) =>
        normalizeRule(rule).canonical === parent.canonical ? [index] : [],
    );
    if (parentIndexes.length !== 1) {
        throw new Error(
            `Replacement parent rule must occur exactly once in the trusted baseline; found ` +
                `${parentIndexes.length}.`,
        );
    }
    return existingRules.filter((_rule, index) => index !== parentIndexes[0]);
}

/**
 * Create the explicit browser-tool evaluator used only by unit tests.
 *
 * @param handlers - Mock browser handlers supplying wrapped `{ result }` payloads.
 * @returns Test-only evaluator compatible with trusted probe functions.
 */
function createTestOnlyToolEvaluator(handlers: BrowserToolHandlers): TrustedPageEvaluator {
    return {
        evaluate: async (expression: string): Promise<unknown> => {
            const response = await handlers.evaluate_js({ expression });
            if (
                response === null ||
                typeof response !== 'object' ||
                !Object.prototype.hasOwnProperty.call(response, 'result')
            ) {
                throw new Error('Test-only page evaluation returned a malformed payload.');
            }
            return (response as Record<string, unknown>).result;
        },
    };
}

/**
 * Create the explicit Playwright evaluator used only by structural-probe unit tests.
 *
 * @param page - Mock Playwright page.
 * @returns Test-only evaluator that delegates to the mock page's main world.
 */
function createTestOnlyPageEvaluator(page: Page): TrustedPageEvaluator {
    return {
        evaluate: async (expression: string): Promise<unknown> => page.evaluate(expression),
    };
}

/**
 * JavaScript snippet that probes for an ad element's visibility in the DOM.
 *
 * Returns 'visible', 'hidden', or 'not_found' based on the element's computed display and
 * visibility styles and whether it occupies space in the viewport.
 */
const AD_ELEMENT_PROBE = `
(function () {
    var el = document.querySelector('__SELECTOR__');
    if (!el) return 'not_found';
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return 'hidden';
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return 'hidden';
    return 'visible';
})()
`;

/**
 * JavaScript snippet that measures the target element's current bounding box.
 */
const ELEMENT_GEOMETRY_PROBE = `
(function () {
    var el = document.querySelector('__SELECTOR__');
    if (!el) return { found: false, width: 0, height: 0 };
    var rect = el.getBoundingClientRect();
    return { found: true, width: rect.width, height: rect.height };
})()
`;

/**
 * JavaScript snippet that measures one element's document-space vertical span.
 *
 * Hidden or detached candidates report a zero span so callers fall back to full-document capture
 * instead of trusting a degenerate window.
 */
const ELEMENT_DOCUMENT_RECT_PROBE = `
(function () {
    var el = document.querySelector('__SELECTOR__');
    if (!el) return { found: false, top: 0, bottom: 0 };
    var rect = el.getBoundingClientRect();
    return {
        found: true,
        top: rect.top + (window.scrollY || 0),
        bottom: rect.bottom + (window.scrollY || 0),
    };
})()
`;

/**
 * Measure the document-space tile window around one localized element.
 *
 * The window spans the element plus one viewport above and below so the before/after comparison
 * sees the symptom and its immediate layout neighborhood instead of the whole document.
 *
 * @param evaluator - Runner-owned evaluator isolated from page JavaScript.
 * @param selector - Exact localized symptom selector.
 * @param viewportHeight - Current viewport height used as the context margin.
 * @returns Document-space span, or undefined when the element cannot bound one.
 */
async function measureElementTileWindow(
    evaluator: TrustedPageEvaluator,
    selector: string,
    viewportHeight: number,
): Promise<FullPageTileWindow | undefined> {
    if (viewportHeight <= 0) {
        return undefined;
    }
    const escaped = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    try {
        const result = await evaluator.evaluate(
            ELEMENT_DOCUMENT_RECT_PROBE.replace('__SELECTOR__', escaped),
        );
        if (result && typeof result === 'object') {
            const rect = result as Record<string, unknown>;
            if (
                rect.found === true &&
                typeof rect.top === 'number' &&
                Number.isFinite(rect.top) &&
                typeof rect.bottom === 'number' &&
                Number.isFinite(rect.bottom) &&
                rect.bottom > rect.top
            ) {
                return {
                    fromY: Math.max(0, rect.top - viewportHeight),
                    toY: rect.bottom + viewportHeight,
                };
            }
        }
    } catch {
        // A failed measurement falls back to full-document tile capture below.
    }
    return undefined;
}

/**
 * JavaScript snippet that measures selector scope and top-of-page semantic landmarks.
 *
 * The probe intentionally uses only DOM geometry and computed styles. It does not depend on the
 * reported site, candidate text, screenshot interpretation, or any benchmark reference.
 */
const STRUCTURAL_SNAPSHOT_PROBE = `
(function (targetSelector) {
    try {
        var emptyGeometry = function () {
            return {
                totalCount: 0,
                visibleCount: 0,
                visibleArea: 0,
                clippedCount: 0,
                occludedCount: 0,
                elementKeys: [],
                occlusionEvidence: [],
            };
        };
        var rectArea = function (rect) {
            return Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
        };
        var targetElements = targetSelector
            ? Array.prototype.slice.call(document.querySelectorAll(targetSelector))
            : [];
        var elementKey = function (element) {
            if (element.id) return 'id:' + element.id;
            var segments = [];
            var current = element;
            while (current && current.nodeType === 1 && segments.length < 12) {
                var parent = current.parentElement;
                var siblings = parent && parent.children
                    ? Array.prototype.slice.call(parent.children)
                    : [current];
                segments.unshift(
                    String(current.tagName || 'element').toLowerCase() +
                        ':' +
                        Math.max(0, siblings.indexOf(current)),
                );
                current = parent;
            }
            return 'path:' + segments.join('/');
        };
        var belongsToTarget = function (element) {
            return targetElements.some(function (target) {
                return target === element || target.contains(element);
            });
        };
        var colorHasVisibleAlpha = function (color) {
            if (!color) return false;
            var normalized = String(color).trim().toLowerCase();
            if (!normalized || normalized === 'transparent') return false;
            var open = normalized.indexOf('(');
            var close = normalized.lastIndexOf(')');
            if (open < 0 || close <= open) return true;
            var body = normalized.slice(open + 1, close);
            if (body.indexOf('/') >= 0) {
                var slashAlpha = Number(body.slice(body.lastIndexOf('/') + 1).trim());
                return !Number.isFinite(slashAlpha) || slashAlpha > 0.02;
            }
            var components = body.split(',').map(function (part) { return part.trim(); });
            if (components.length < 4) return true;
            var alpha = Number(components[components.length - 1]);
            return !Number.isFinite(alpha) || alpha > 0.02;
        };
        var styleHasMaterialSurface = function (style) {
            return Boolean(
                colorHasVisibleAlpha(style.backgroundColor) ||
                (style.backgroundImage && style.backgroundImage !== 'none') ||
                (style.maskImage && style.maskImage !== 'none') ||
                (style.backdropFilter && style.backdropFilter !== 'none'),
            );
        };
        var textPaintsPoint = function (element, x, y) {
            if (
                typeof document.createTreeWalker !== 'function' ||
                typeof document.createRange !== 'function'
            ) {
                return false;
            }
            var walker = document.createTreeWalker(element, 4);
            var node = walker.nextNode();
            var inspected = 0;
            while (node && inspected < 64) {
                if (String(node.nodeValue || '').trim()) {
                    var range = document.createRange();
                    range.selectNodeContents(node);
                    var rects = Array.prototype.slice.call(range.getClientRects());
                    if (rects.some(function (rect) {
                        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
                    })) {
                        return true;
                    }
                }
                inspected += 1;
                node = walker.nextNode();
            }
            return false;
        };
        var materiallyPaintsPoint = function (element, x, y) {
            var replacedTags = ['CANVAS', 'IFRAME', 'IMG', 'OBJECT', 'SVG', 'VIDEO'];
            if (replacedTags.indexOf(String(element.tagName || '').toUpperCase()) >= 0) {
                return true;
            }
            if (styleHasMaterialSurface(window.getComputedStyle(element))) return true;
            if (textPaintsPoint(element, x, y)) return true;
            return ['::before', '::after'].some(function (pseudo) {
                var style = window.getComputedStyle(element, pseudo);
                var content = String(style.content || '').trim();
                return content !== '' && content !== 'none' && content !== 'normal' &&
                    styleHasMaterialSurface(style);
            });
        };
        var inspectGeometry = function (element) {
            var rawRect = element.getBoundingClientRect();
            var visibleRect = {
                left: rawRect.left,
                right: rawRect.right,
                top: rawRect.top,
                bottom: rawRect.bottom,
            };
            var rawArea = Math.max(0, rawRect.width) * Math.max(0, rawRect.height);
            var ancestorHidden = false;
            var ancestor = element;
            while (ancestor && ancestor.nodeType === 1) {
                var style = window.getComputedStyle(ancestor);
                if (
                    ancestor.hidden ||
                    ancestor.getAttribute('aria-hidden') === 'true' ||
                    style.display === 'none' ||
                    style.visibility === 'hidden' ||
                    style.visibility === 'collapse' ||
                    style.contentVisibility === 'hidden' ||
                    Number(style.opacity) <= 0.01
                ) {
                    ancestorHidden = true;
                    break;
                }
                if (ancestor !== element) {
                    var ancestorRect = ancestor.getBoundingClientRect();
                    if (/hidden|clip|auto|scroll/.test(style.overflowX)) {
                        visibleRect.left = Math.max(visibleRect.left, ancestorRect.left);
                        visibleRect.right = Math.min(visibleRect.right, ancestorRect.right);
                    }
                    if (/hidden|clip|auto|scroll/.test(style.overflowY)) {
                        visibleRect.top = Math.max(visibleRect.top, ancestorRect.top);
                        visibleRect.bottom = Math.min(visibleRect.bottom, ancestorRect.bottom);
                    }
                }
                ancestor = ancestor.parentElement;
            }
            var visibleArea = ancestorHidden ? 0 : rectArea(visibleRect);
            var visible = rawArea > 0 && visibleArea > 0;
            var clipped = ancestorHidden || (rawArea > 0 && visibleArea < rawArea * 0.98);
            var occluded = false;
            var occlusionEvidence = null;
            var viewportRect = {
                left: Math.max(0, visibleRect.left),
                right: Math.min(window.innerWidth, visibleRect.right),
                top: Math.max(0, visibleRect.top),
                bottom: Math.min(window.innerHeight, visibleRect.bottom),
            };
            if (visible && rectArea(viewportRect) > 0 && !belongsToTarget(element)) {
                var sampleFractions = [
                    [0.5, 0.5],
                    [0.2, 0.2],
                    [0.8, 0.2],
                    [0.2, 0.8],
                    [0.8, 0.8],
                ];
                var blockerKeys = [];
                var occludedSampleCount = sampleFractions.reduce(function (count, fractions) {
                    var sampleX = viewportRect.left +
                        (viewportRect.right - viewportRect.left) * fractions[0];
                    var sampleY = viewportRect.top +
                        (viewportRect.bottom - viewportRect.top) * fractions[1];
                    var topElement = document.elementFromPoint(sampleX, sampleY);
                    var sampleOccluded = Boolean(
                        topElement &&
                            topElement !== element &&
                            !element.contains(topElement) &&
                            !topElement.contains(element) &&
                            materiallyPaintsPoint(topElement, sampleX, sampleY),
                    );
                    if (sampleOccluded) blockerKeys.push(elementKey(topElement));
                    return count + (sampleOccluded ? 1 : 0);
                }, 0);
                var requiredOccludedSamples = Math.floor(sampleFractions.length / 2) + 1;
                occluded = occludedSampleCount >= requiredOccludedSamples;
                if (occluded) {
                    occlusionEvidence = {
                        targetKey: elementKey(element),
                        blockerKeys: Array.from(new Set(blockerKeys)),
                        occludedSampleCount: occludedSampleCount,
                        sampleCount: sampleFractions.length,
                    };
                }
            }
            return {
                visible: visible,
                visibleArea: visibleArea,
                clipped: clipped,
                occluded: occluded,
                occlusionEvidence: occlusionEvidence,
                rawWidth: Math.max(0, rawRect.width),
                rawHeight: Math.max(0, rawRect.height),
                rawArea: rawArea,
            };
        };
        var summarizeGeometry = function (elements) {
            return elements.reduce(function (summary, element) {
                var geometry = inspectGeometry(element);
                summary.totalCount += 1;
                summary.elementKeys.push(elementKey(element));
                if (geometry.visible) {
                    summary.visibleCount += 1;
                    summary.visibleArea += geometry.visibleArea;
                }
                if (geometry.clipped) summary.clippedCount += 1;
                if (geometry.occluded) {
                    summary.occludedCount += 1;
                    summary.occlusionEvidence.push(geometry.occlusionEvidence);
                }
                return summary;
            }, emptyGeometry());
        };
        var isVisible = function (element) {
            var style = window.getComputedStyle(element);
            var rect = element.getBoundingClientRect();
            return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                Number(style.opacity) > 0.01 &&
                rect.width > 0 &&
                rect.height > 0
            );
        };
        var allElements = Array.prototype.slice.call(document.querySelectorAll('body *'));
        var topOverlays = allElements.filter(function (element) {
            if (!isVisible(element)) return false;
            var style = window.getComputedStyle(element);
            if (style.position !== 'fixed' && style.position !== 'sticky') return false;
            var rect = element.getBoundingClientRect();
            return (
                rect.top <= 1 &&
                rect.bottom > 0 &&
                rect.left <= window.innerWidth / 2 &&
                rect.right >= window.innerWidth / 2
            );
        });
        var fixedTopOverlayBottom = topOverlays.reduce(function (bottom, element) {
            return Math.max(bottom, element.getBoundingClientRect().bottom);
        }, 0);
        var uniqueElements = function (selector) {
            return Array.from(new Set(document.querySelectorAll(selector)));
        };
        var headings = uniqueElements('h1, [role="heading"][aria-level="1"]');
        var breadcrumbs = uniqueElements(
            '[itemtype$="/BreadcrumbList"], [aria-label*="breadcrumb" i], ' +
                '[class*="breadcrumb" i]',
        );
        var inspectLandmarks = function (elements) {
            var visible = elements.filter(function (element) {
                return inspectGeometry(element).visible;
            });
            var overlappedTops = [];
            visible.forEach(function (landmark) {
                var landmarkRect = landmark.getBoundingClientRect();
                var overlaps = topOverlays.some(function (overlay) {
                    if (
                        overlay === landmark ||
                        overlay.contains(landmark) ||
                        landmark.contains(overlay)
                    ) {
                        return false;
                    }
                    var overlayRect = overlay.getBoundingClientRect();
                    return (
                        overlayRect.left < landmarkRect.right &&
                        overlayRect.right > landmarkRect.left &&
                        overlayRect.top < landmarkRect.bottom &&
                        overlayRect.bottom > landmarkRect.top
                    );
                });
                if (overlaps) overlappedTops.push(landmarkRect.top);
            });
            return { visibleCount: visible.length, overlappedTops: overlappedTops };
        };
        var headingResult = inspectLandmarks(headings);
        var breadcrumbResult = inspectLandmarks(breadcrumbs);
        var allOverlappedTops = headingResult.overlappedTops.concat(
            breadcrumbResult.overlappedTops,
        );
        var targetGeometry = targetElements.map(inspectGeometry);
        var visibleTargetGeometry = targetGeometry.filter(function (geometry) {
            return geometry.visible;
        });
        var semanticFamilyClass = /(^|[-_])(ad|ads|advert|advertisement|slot|banner|sponsor)([-_]|$)/i;
        var isSemanticFamilyClass = function (className) {
            var normalizedClassName = className.replace(/([a-z0-9])([A-Z])/g, '$1-$2');
            return semanticFamilyClass.test(normalizedClassName);
        };
        var familyProbeLimit = 128;
        var allFamilyCandidates = targetElements.length > 0
            ? Array.prototype.slice
                .call(targetElements[0].classList || [])
                .map(function (className) {
                    var elements = Array.prototype.slice.call(
                        document.getElementsByClassName(className),
                    );
                    return {
                        className: className,
                        elements: elements,
                        semantic: isSemanticFamilyClass(className),
                    };
                })
                .filter(function (candidate) {
                    return (
                        candidate.elements.length >= targetElements.length &&
                        targetElements.every(function (target) {
                            return candidate.elements.indexOf(target) >= 0;
                        })
                    );
                })
                .sort(function (left, right) {
                    if (left.elements.length !== right.elements.length) {
                        return right.elements.length - left.elements.length;
                    }
                    return left.className < right.className
                        ? -1
                        : left.className > right.className
                            ? 1
                            : 0;
                })
            : [];
        var semanticFamilyCandidates = allFamilyCandidates.filter(function (candidate) {
            return candidate.semantic;
        });
        var selectorClassNames = [];
        var selectorClassPattern = /[.]([A-Za-z_-][A-Za-z0-9_-]*)/g;
        var selectorClassMatch;
        while (
            (selectorClassMatch = selectorClassPattern.exec(String(targetSelector || ''))) !== null
        ) {
            selectorClassNames.push(selectorClassMatch[1]);
        }
        var selectorSemanticFamilyCandidate = semanticFamilyCandidates.find(function (candidate) {
            return selectorClassNames.indexOf(candidate.className) >= 0;
        });
        var lockedSelectorSemanticFamilyCandidate =
            selectorSemanticFamilyCandidate &&
            !semanticFamilyCandidates.some(function (candidate) {
                return candidate.elements.length > selectorSemanticFamilyCandidate.elements.length;
            })
                ? selectorSemanticFamilyCandidate
                : null;
        var selectedFamilyCandidate = lockedSelectorSemanticFamilyCandidate ||
            (semanticFamilyCandidates.length > 0
                ? semanticFamilyCandidates[0]
                : allFamilyCandidates.length > 0
                    ? allFamilyCandidates[0]
                    : null);
        var broaderCoMemberCandidate =
            lockedSelectorSemanticFamilyCandidate
            ? null
            : allFamilyCandidates.find(function (candidate) {
                return (
                    !selectedFamilyCandidate ||
                    candidate.elements.length > selectedFamilyCandidate.elements.length
                );
            });
        if (broaderCoMemberCandidate) selectedFamilyCandidate = broaderCoMemberCandidate;
        var targetFamilyClass = selectedFamilyCandidate
            ? selectedFamilyCandidate.className
            : null;
        var familyProbeTruncated = Boolean(
            selectedFamilyCandidate && selectedFamilyCandidate.elements.length > familyProbeLimit,
        );
        var familyTargetCount = selectedFamilyCandidate
            ? selectedFamilyCandidate.elements.length
            : targetElements.length;
        var familyTargetElements = familyProbeTruncated
            ? []
            : selectedFamilyCandidate
                ? selectedFamilyCandidate.elements
                : targetElements;
        var familyTargetGeometry = familyTargetElements.map(inspectGeometry);
        var visibleFamilyTargetGeometry = familyTargetGeometry.filter(function (geometry) {
            return geometry.visible;
        });
        var buildTargetMeasurements = function (elements, geometries) {
            return elements.map(function (element, index) {
                return {
                    key: elementKey(element),
                    width: geometries[index].rawWidth,
                    height: geometries[index].rawHeight,
                };
            });
        };
        var textElements = Array.prototype.slice
            .call(document.querySelectorAll('h1, h2, h3, p, li, blockquote, figcaption'))
            .filter(function (element) {
                return (element.innerText || '').trim().length >= 20;
            });
        var mediaElements = Array.prototype.slice
            .call(document.querySelectorAll('img, video, audio'))
            .filter(function (element) {
                var rect = element.getBoundingClientRect();
                if (rect.width < 32 || rect.height < 32) return false;
                if (element.tagName !== 'IMG') return true;
                return Boolean(
                    (element.getAttribute('alt') || '').trim() ||
                        element.closest('main, article, [role="main"]'),
                );
            });
        var controlElements = Array.prototype.slice.call(
            document.querySelectorAll(
                'button, input:not([type="hidden"]), select, textarea, summary, [role="button"]',
            ),
        );
        return {
            probeSucceeded: true,
            targetCount: targetElements.length,
            targetVisibleCount: visibleTargetGeometry.length,
            targetTotalHeight: visibleTargetGeometry.reduce(function (total, geometry) {
                return total + geometry.rawHeight;
            }, 0),
            targetTotalArea: visibleTargetGeometry.reduce(function (total, geometry) {
                return total + geometry.rawArea;
            }, 0),
            targetMaximumHeight: visibleTargetGeometry.reduce(function (maximum, geometry) {
                return Math.max(maximum, geometry.rawHeight);
            }, 0),
            targetFamilyClass: targetFamilyClass,
            familyProbeTruncated: familyProbeTruncated,
            familyTargetCount: familyTargetCount,
            familyTargetVisibleCount: visibleFamilyTargetGeometry.length,
            familyTargetTotalHeight: visibleFamilyTargetGeometry.reduce(function (
                total,
                geometry,
            ) {
                return total + geometry.rawHeight;
            }, 0),
            familyTargetMaximumHeight: visibleFamilyTargetGeometry.reduce(function (
                maximum,
                geometry,
            ) {
                return Math.max(maximum, geometry.rawHeight);
            }, 0),
            targetMeasurements: buildTargetMeasurements(targetElements, targetGeometry),
            familyTargetMeasurements: buildTargetMeasurements(
                familyTargetElements,
                familyTargetGeometry,
            ),
            documentTimeOrigin:
                typeof performance === 'object' && Number.isFinite(performance.timeOrigin)
                    ? Math.max(0, performance.timeOrigin)
                    : 0,
            documentHeight: Math.max(
                document.documentElement.scrollHeight || 0,
                document.body ? document.body.scrollHeight || 0 : 0,
            ),
            fixedTopOverlayBottom: Math.max(0, fixedTopOverlayBottom),
            visibleHeadingCount: headingResult.visibleCount,
            visibleBreadcrumbCount: breadcrumbResult.visibleCount,
            overlappedHeadingCount: headingResult.overlappedTops.length,
            overlappedBreadcrumbCount: breadcrumbResult.overlappedTops.length,
            minimumOverlappedLandmarkTop:
                allOverlappedTops.length > 0 ? Math.min.apply(null, allOverlappedTops) : null,
            meaningfulTextLength: (document.body.innerText || '').trim().length,
            textGeometry: summarizeGeometry(textElements),
            mediaGeometry: summarizeGeometry(mediaElements),
            controlGeometry: summarizeGeometry(controlElements),
        };
    } catch (_error) {
        return {
            probeSucceeded: false,
            targetCount: 0,
            targetVisibleCount: 0,
            targetTotalHeight: 0,
            targetTotalArea: 0,
            targetMaximumHeight: 0,
            targetFamilyClass: null,
            familyProbeTruncated: false,
            familyTargetCount: 0,
            familyTargetVisibleCount: 0,
            familyTargetTotalHeight: 0,
            familyTargetMaximumHeight: 0,
            targetMeasurements: [],
            familyTargetMeasurements: [],
            documentTimeOrigin: 0,
            documentHeight: 0,
            fixedTopOverlayBottom: 0,
            visibleHeadingCount: 0,
            visibleBreadcrumbCount: 0,
            overlappedHeadingCount: 0,
            overlappedBreadcrumbCount: 0,
            minimumOverlappedLandmarkTop: null,
            meaningfulTextLength: 0,
            textGeometry: {
                totalCount: 0,
                visibleCount: 0,
                visibleArea: 0,
                clippedCount: 0,
                occludedCount: 0,
            },
            mediaGeometry: {
                totalCount: 0,
                visibleCount: 0,
                visibleArea: 0,
                clippedCount: 0,
                occludedCount: 0,
            },
            controlGeometry: {
                totalCount: 0,
                visibleCount: 0,
                visibleArea: 0,
                clippedCount: 0,
                occludedCount: 0,
            },
        };
    }
})(__SELECTOR__)
`;

/**
 * Bounded same-document scroll pass used to trigger and settle lazy page content.
 */
const PAGE_MATERIALIZATION_PROBE = `
(async function () {
    if (!document.body || !document.documentElement) {
        return { materialized: false, stable: false, height: 0 };
    }
    var originalX = window.scrollX || 0;
    var originalY = window.scrollY || 0;
    var readHeight = function () {
        return Math.max(
            document.documentElement.scrollHeight || 0,
            document.body.scrollHeight || 0,
        );
    };
    var wait = function (milliseconds) {
        return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
    };
    var maximumSupportedHeight = 50000;
    var maximumScrollSteps = 128;
    var previousHeight = readHeight();
    var stable = false;
    if (previousHeight > maximumSupportedHeight) {
        return {
            materialized: false,
            stable: false,
            height: previousHeight,
            reason: 'document_height_exceeds_materialization_limit',
        };
    }
    try {
        for (var pass = 0; pass < 3; pass += 1) {
            var viewportHeight = Math.max(1, window.innerHeight || 0);
            var boundedHeight = Math.max(viewportHeight, previousHeight);
            var maximumStepDistance = Math.max(1, Math.floor(viewportHeight * 0.75));
            var steps = Math.max(1, Math.ceil(boundedHeight / maximumStepDistance));
            if (steps > maximumScrollSteps) {
                return {
                    materialized: false,
                    stable: false,
                    height: previousHeight,
                    reason: 'materialization_step_limit_exceeded',
                };
            }
            for (var step = 0; step <= steps; step += 1) {
                window.scrollTo(0, Math.round((boundedHeight * step) / steps));
                await wait(75);
            }
            await wait(250);
            var nextHeight = readHeight();
            if (nextHeight > maximumSupportedHeight) {
                previousHeight = nextHeight;
                return {
                    materialized: false,
                    stable: false,
                    height: previousHeight,
                    reason: 'document_height_exceeds_materialization_limit',
                };
            }
            if (Math.abs(nextHeight - previousHeight) <= 4) {
                stable = true;
                previousHeight = nextHeight;
                break;
            }
            previousHeight = nextHeight;
        }
    } finally {
        window.scrollTo(originalX, originalY);
        await wait(250);
    }
    return { materialized: true, stable: stable, height: previousHeight };
})()
`;

/**
 * Materialize bounded lazy content and require document-height stability.
 *
 * @param evaluator - Trusted isolated-world evaluator for the current document.
 * @returns True only when a bounded scroll pass completed and page height stabilized.
 */
export async function materializePage(evaluator: TrustedPageEvaluator): Promise<boolean> {
    try {
        const result = await evaluator.evaluate(PAGE_MATERIALIZATION_PROBE);
        if (!result || typeof result !== 'object') {
            return false;
        }
        const record = result as Record<string, unknown>;
        return record.materialized === true && record.stable === true;
    } catch {
        return false;
    }
}

/**
 * Isolated-world probe that places the first reported target in a stable viewport context.
 */
const VALIDATION_VIEWPORT_ANCHOR_PROBE = `
(async function (selector) {
    if (!document.body || !document.documentElement) return null;
    var desiredY = 0;
    try {
        var targets = selector
            ? Array.prototype.slice.call(document.querySelectorAll(selector))
            : [];
        var target = targets.find(function (element) {
            var rect = element.getBoundingClientRect();
            return Number.isFinite(rect.top) && Number.isFinite(rect.width) && rect.width > 0;
        });
        if (target) {
            var rect = target.getBoundingClientRect();
            var absoluteTop = Math.max(0, (window.scrollY || 0) + rect.top);
            var context = Math.min(160, Math.max(32, (window.innerHeight || 0) * 0.1));
            desiredY = Math.max(0, Math.round(absoluteTop - context));
        }
    } catch (_error) {
        return null;
    }
    window.scrollTo({ left: 0, top: desiredY, behavior: 'instant' });
    await new Promise(function (resolve) { setTimeout(resolve, 150); });
    return {
        x: Math.max(0, window.scrollX || 0),
        y: Math.max(0, window.scrollY || 0),
    };
})(__SELECTOR__)
`;

/**
 * Isolated-world probe that restores an exact screenshot viewport position.
 */
const VALIDATION_VIEWPORT_RESTORE_PROBE = `
(async function (expectedX, expectedY) {
    if (!document.body || !document.documentElement) return null;
    window.scrollTo({ left: expectedX, top: expectedY, behavior: 'instant' });
    await new Promise(function (resolve) { setTimeout(resolve, 150); });
    return {
        x: Math.max(0, window.scrollX || 0),
        y: Math.max(0, window.scrollY || 0),
    };
})(__EXPECTED_X__, __EXPECTED_Y__)
`;

/**
 * Scroll the reported target to a deterministic position before control evidence is captured.
 *
 * @param evaluator - Runner-owned isolated-world evaluator for the current document.
 * @param selector - Runner-bound candidate selector whose first element anchors the viewport.
 * @returns The settled non-negative viewport position, or null when alignment cannot be proven.
 */
export async function createValidationViewportAnchor(
    evaluator: TrustedPageEvaluator,
    selector: string,
): Promise<ValidationViewportPosition | null> {
    try {
        const result = await evaluator.evaluate(
            VALIDATION_VIEWPORT_ANCHOR_PROBE.replace('__SELECTOR__', JSON.stringify(selector)),
        );
        if (!result || typeof result !== 'object') {
            return null;
        }
        const record = result as Record<string, unknown>;
        if (
            typeof record.x !== 'number' ||
            !Number.isFinite(record.x) ||
            record.x < 0 ||
            typeof record.y !== 'number' ||
            !Number.isFinite(record.y) ||
            record.y < 0
        ) {
            return null;
        }
        return { x: record.x, y: record.y };
    } catch {
        return null;
    }
}

/**
 * Restore a recorded viewport anchor and fail closed when the browser clamps or changes it.
 *
 * @param evaluator - Runner-owned isolated-world evaluator for the current document.
 * @param anchor - Exact control position that the candidate screenshot must reuse.
 * @returns The settled position when it matches within one pixel, or null otherwise.
 */
export async function restoreValidationViewportAnchor(
    evaluator: TrustedPageEvaluator,
    anchor: ValidationViewportPosition,
): Promise<ValidationViewportPosition | null> {
    try {
        const result = await evaluator.evaluate(
            VALIDATION_VIEWPORT_RESTORE_PROBE.replace(
                '__EXPECTED_X__',
                JSON.stringify(anchor.x),
            ).replace('__EXPECTED_Y__', JSON.stringify(anchor.y)),
        );
        if (!result || typeof result !== 'object') {
            return null;
        }
        const record = result as Record<string, unknown>;
        if (
            typeof record.x !== 'number' ||
            !Number.isFinite(record.x) ||
            record.x < 0 ||
            typeof record.y !== 'number' ||
            !Number.isFinite(record.y) ||
            record.y < 0 ||
            Math.abs(record.x - anchor.x) > 1 ||
            Math.abs(record.y - anchor.y) > 1
        ) {
            return null;
        }
        return { x: record.x, y: record.y };
    } catch {
        return null;
    }
}

/**
 * Parse an atomic viewport position returned by the screenshot handler.
 *
 * @param value - Unknown screenshot response field.
 * @returns Validated position, or undefined when the screenshot did not bind one.
 */
function parseValidationViewportPosition(value: unknown): ValidationViewportPosition | undefined {
    const parsed = v.safeParse(ValidationViewportPositionSchema, value);
    return parsed.success ? parsed.output : undefined;
}

/**
 * Determine whether an atomic control/candidate viewport pair is aligned.
 *
 * @param control - Position captured with the same-document control image.
 * @param candidate - Position captured with the candidate image.
 * @returns True when both coordinates remain within one pixel.
 */
function validationViewportPairMatches(
    control: ValidationViewportPosition,
    candidate: ValidationViewportPosition,
): boolean {
    return Math.abs(control.x - candidate.x) <= 1 && Math.abs(control.y - candidate.y) <= 1;
}

/**
 * Generate a stub PhaseResult for phases that were skipped due to an earlier error.
 *
 * @param phase - The phase label for the stub.
 * @param url - The URL that would have been used.
 * @param errorMessage - The reason the phase was skipped.
 * @returns A minimal PhaseResult representing the skipped phase.
 */
function stubPhase(phase: PhaseLabel, url: string, errorMessage: string): PhaseResult {
    return {
        phase,
        screenshotArtifactId: '',
        harArtifactId: '',
        domArtifactId: '',
        url,
        appliedRules: [],
        ruleApplications: [],
        antiAdblockDetected: false,
        error: errorMessage,
    };
}

/**
 * Bound one rule-application diagnostic to the validation schema's maximum reason length.
 *
 * @param reason - Raw safe-applicator explanation.
 * @returns Stable non-empty reason suitable for persisted factual evidence.
 */
function boundedRuleApplicationReason(reason: string | undefined): string {
    const normalized = reason?.trim().replace(/\s+/gu, ' ');
    return (normalized || 'Rule was not applied by the safe validator.').slice(0, 500);
}

/**
 * Create the fail-closed initial accounting entry for one phase input rule.
 *
 * @param rule - Exact rule supplied to the phase.
 * @returns Skipped entry that is replaced if the safe applicator dispatches the rule.
 */
function initialRuleApplicationFact(rule: string): RuleApplicationFact {
    const normalized = normalizeRule(rule);
    const reason = normalized.isException
        ? 'Exception rules are not applied by the safe validator.'
        : `Rule kind '${normalized.kind}' was not dispatched by the safe validator.`;
    return { rule, status: 'skipped', reason };
}

/**
 * Convert the actual safe-applicator result to one persisted phase accounting entry.
 *
 * @param rule - Exact rule submitted to the applicator.
 * @param result - Result returned by the safe applicator.
 * @returns Applied or explicitly skipped rule fact.
 */
function ruleApplicationFact(rule: string, result: RuleApplicationResult): RuleApplicationFact {
    return result.applied
        ? { rule, status: 'applied' }
        : { rule, status: 'skipped', reason: boundedRuleApplicationReason(result.error) };
}

/**
 * Probe the visibility of an ad element on the page.
 *
 * Evaluates a JavaScript snippet that checks for the element's presence and computed styles.
 * Escapes backslashes and single quotes in the selector before interpolation into the single-quoted
 * JS string literal.
 *
 * @param evaluator - Trusted isolated-world page evaluator.
 * @param selector - The CSS selector to probe.
 * @returns The ad element presence status.
 */
export async function probeAdElement(
    evaluator: TrustedPageEvaluator,
    selector: string,
): Promise<AdElementPresence> {
    // Escape backslashes and single quotes for safe interpolation
    const escaped = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const expression = AD_ELEMENT_PROBE.replace('__SELECTOR__', escaped);

    try {
        const result = await evaluator.evaluate(expression);
        if (result === 'visible' || result === 'hidden' || result === 'not_found') {
            return result;
        }
        return AdElementPresence.NotProbed;
    } catch {
        return AdElementPresence.NotProbed;
    }
}

/**
 * Measure an element's browser-rendered width and height.
 *
 * @param evaluator - Trusted isolated-world page evaluator.
 * @param selector - The CSS selector to measure.
 * @returns A bounded geometry result, or a missing-element result when measurement fails.
 */
export async function probeElementGeometry(
    evaluator: TrustedPageEvaluator,
    selector: string,
): Promise<ElementGeometry> {
    const escaped = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const expression = ELEMENT_GEOMETRY_PROBE.replace('__SELECTOR__', escaped);

    try {
        const result = await evaluator.evaluate(expression);
        if (result && typeof result === 'object') {
            const geometry = result as Record<string, unknown>;
            if (
                geometry.found === true &&
                typeof geometry.width === 'number' &&
                Number.isFinite(geometry.width) &&
                geometry.width >= 0 &&
                typeof geometry.height === 'number' &&
                Number.isFinite(geometry.height) &&
                geometry.height >= 0
            ) {
                return {
                    found: true,
                    width: geometry.width,
                    height: geometry.height,
                };
            }
        }
    } catch {
        // Return a conservative missing measurement below.
    }

    return { found: false, width: 0, height: 0 };
}

/**
 * Create the conservative result used when browser structure could not be measured.
 *
 * @returns A failed structural snapshot that can never authorize verification.
 */
function unavailableStructuralSnapshot(): StructuralSnapshot {
    return {
        probeSucceeded: false,
        targetCount: 0,
        targetVisibleCount: 0,
        targetTotalHeight: 0,
        targetTotalArea: 0,
        targetMaximumHeight: 0,
        targetFamilyClass: null,
        familyProbeTruncated: false,
        familyTargetCount: 0,
        familyTargetVisibleCount: 0,
        familyTargetTotalHeight: 0,
        familyTargetMaximumHeight: 0,
        targetMeasurements: [],
        familyTargetMeasurements: [],
        documentTimeOrigin: 0,
        documentHeight: 0,
        fixedTopOverlayBottom: 0,
        visibleHeadingCount: 0,
        visibleBreadcrumbCount: 0,
        overlappedHeadingCount: 0,
        overlappedBreadcrumbCount: 0,
        minimumOverlappedLandmarkTop: null,
        meaningfulTextLength: 0,
        textGeometry: {
            totalCount: 0,
            visibleCount: 0,
            visibleArea: 0,
            clippedCount: 0,
            occludedCount: 0,
        },
        mediaGeometry: {
            totalCount: 0,
            visibleCount: 0,
            visibleArea: 0,
            clippedCount: 0,
            occludedCount: 0,
        },
        controlGeometry: {
            totalCount: 0,
            visibleCount: 0,
            visibleArea: 0,
            clippedCount: 0,
            occludedCount: 0,
        },
    };
}

/**
 * Measure selector scope and semantic landmarks on the currently rendered page.
 *
 * @param evaluator - Trusted isolated-world page evaluator.
 * @param selector - Exact selector extracted from the candidate rule.
 * @returns A validated snapshot, or a conservative failed snapshot on any probe problem.
 */
export async function probeStructuralSnapshot(
    evaluator: TrustedPageEvaluator,
    selector: string,
): Promise<StructuralSnapshot> {
    const expression = STRUCTURAL_SNAPSHOT_PROBE.replace('__SELECTOR__', JSON.stringify(selector));
    try {
        const raw = await evaluator.evaluate(expression);
        const parsed = v.safeParse(StructuralSnapshotSchema, raw);
        return parsed.success ? parsed.output : unavailableStructuralSnapshot();
    } catch {
        return unavailableStructuralSnapshot();
    }
}

/**
 * Convert a trusted structural snapshot into the selector's rendered presence.
 *
 * @param snapshot - Runner-owned same-document structural measurements.
 * @returns A conservative ad-element presence classification.
 */
function presenceFromStructuralSnapshot(snapshot: StructuralSnapshot): AdElementPresence {
    if (!snapshot.probeSucceeded) {
        return AdElementPresence.NotProbed;
    }
    if (snapshot.targetCount === 0) {
        return AdElementPresence.NotFound;
    }
    if (snapshot.targetVisibleCount === snapshot.targetCount) {
        return AdElementPresence.Visible;
    }
    if (snapshot.targetVisibleCount === 0) {
        return AdElementPresence.Hidden;
    }
    return AdElementPresence.NotProbed;
}

/**
 * Convert the first bound target measurement into raw layout geometry.
 *
 * @param snapshot - Runner-owned same-document structural measurements.
 * @returns The first target's geometry, or a missing measurement when unavailable.
 */
function geometryFromStructuralSnapshot(snapshot: StructuralSnapshot): ElementGeometry {
    const firstMeasurement = snapshot.targetMeasurements?.[0];
    if (!snapshot.probeSucceeded || !firstMeasurement) {
        return { found: false, width: 0, height: 0 };
    }
    return {
        found: true,
        width: firstMeasurement.width,
        height: firstMeasurement.height,
    };
}

/**
 * Resolve the selector whose browser evidence may validate a candidate.
 *
 * Cosmetic candidates are bound to their own selector so a model-supplied selector cannot make one
 * rule appear validated by probing a different element. Network rules have no embedded CSS
 * selector, so they may use the model-supplied selector that identifies the affected page element.
 *
 * @param candidateRule - The candidate rule being validated.
 * @param adElementSelector - Optional model-supplied selector for a network candidate.
 * @returns The selector bound to validation evidence, or an empty string when none is safe.
 */
function resolveValidatedSelector(candidateRule: string, adElementSelector?: string): string {
    const normalizedCandidate = normalizeRule(candidateRule);
    if (normalizedCandidate.kind === RuleKind.Cosmetic) {
        return extractAdSelector(candidateRule)?.trim() || '';
    }
    if (normalizedCandidate.kind === RuleKind.Network) {
        return adElementSelector?.trim() || '';
    }
    return '';
}

/**
 * Execute a single validation phase.
 *
 * Applies network rules BEFORE navigation (persisted via route handlers) and cosmetic/scriptlet
 * rules AFTER navigation (lost on page load). Captures screenshot, HAR, and DOM artifacts, then
 * records whether an anti-adblock response is present.
 *
 * @param config - The phase configuration.
 * @returns The PhaseResult for this phase.
 */
export async function runPhase(config: PhaseConfig): Promise<PhaseResult> {
    config.recorder.record(TraceEventType.PhaseStart, { phase: config.phase, url: config.url });
    await config.handlers.reset_network_log({});
    await clearAppliedNetworkRules(config.page);
    const appliedRules: string[] = [];
    const accountedRules = config.deferredRule
        ? [...config.rules, config.deferredRule]
        : config.rules;
    const ruleApplications = accountedRules.map(initialRuleApplicationFact);

    // ── Apply network rules BEFORE navigation ────────────────────────────
    for (let index = 0; index < config.rules.length; index += 1) {
        const rule = config.rules[index];
        const normalized = normalizeRule(rule);
        if (normalized.kind === RuleKind.Network && !normalized.isException) {
            const application = await applyRule(config.page, rule);
            ruleApplications[index] = ruleApplicationFact(rule, application);
            if (application.applied) {
                appliedRules.push(rule);
            }
        }
    }

    // ── Navigate ─────────────────────────────────────────────────────────
    const openResult = await config.handlers.open_page({ url: config.url });

    if (openResult.error) {
        config.recorder.record(TraceEventType.PhaseEnd, {
            phase: config.phase,
            error: openResult.error,
        });
        return {
            phase: config.phase,
            screenshotArtifactId: '',
            harArtifactId: '',
            domArtifactId: '',
            url: config.url,
            appliedRules,
            ruleApplications,
            antiAdblockDetected: false,
            error: String(openResult.error),
        };
    }

    // ── Apply cosmetic/scriptlet rules AFTER navigation ──────────────────
    for (let index = 0; index < config.rules.length; index += 1) {
        const rule = config.rules[index];
        const normalized = normalizeRule(rule);
        if (normalized.kind === RuleKind.Cosmetic || normalized.kind === RuleKind.Scriptlet) {
            if (!normalized.isException) {
                const application = await applyRule(config.page, rule);
                ruleApplications[index] = ruleApplicationFact(rule, application);
                if (application.applied) {
                    appliedRules.push(rule);
                }
            }
        }
    }

    // ── Replay the reveal steps, after the rules and before every capture ──
    if (config.interact) {
        await config.interact();
    }

    let sameDocumentControlScreenshotArtifactId: string | undefined;
    let sameDocumentControlFullPageScreenshotArtifactId: string | undefined;
    let sameDocumentControlTileCoverage: FullPageTileCoverage | undefined;
    let sameDocumentControlViewport: ValidationViewportPosition | undefined;
    let candidateViewport: ValidationViewportPosition | undefined;
    let sameDocumentControlError: string | undefined;
    let deferredCleanup: (() => Promise<void>) | undefined;
    let viewportAnchor: ValidationViewportPosition | undefined;
    let tileWindow = config.tileWindow;
    /**
     * Resolve the capture window once per phase, measuring on the current document state.
     *
     * @returns Caller-supplied or measured document-space span bounding the tile plan.
     */
    const resolveTileWindow = async (): Promise<FullPageTileWindow | undefined> => {
        if (tileWindow || config.captureVisualTiles !== true || !config.adElementSelector) {
            return tileWindow;
        }
        const viewportHeight =
            typeof config.page.viewportSize === 'function'
                ? (config.page.viewportSize()?.height ?? 0)
                : 0;
        tileWindow = await measureElementTileWindow(
            config.trustedPageEvaluator,
            config.adElementSelector,
            viewportHeight,
        );
        return tileWindow;
    };
    if (config.deferredRule) {
        let materialized = false;
        try {
            materialized = (await config.materialize?.()) === true;
        } catch (error) {
            sameDocumentControlError = `materialization failed: ${(error as Error).message}`;
        }
        if (!materialized && !sameDocumentControlError) {
            sameDocumentControlError = 'materialization did not reach a stable page height';
        }
        if (materialized) {
            if (config.createViewportAnchor) {
                viewportAnchor = (await config.createViewportAnchor()) ?? undefined;
                if (!viewportAnchor || !config.restoreViewportAnchor) {
                    sameDocumentControlError =
                        'validation viewport could not be aligned to the reported target';
                }
            }
            const controlTileWindow = await resolveTileWindow();
            const controlScreenshotResult = await config.handlers.screenshot({
                captureTiles: config.captureVisualTiles === true,
                ...(controlTileWindow ? { tileWindow: controlTileWindow } : {}),
            });
            const controlScreenshotRecord = controlScreenshotResult as Record<string, unknown>;
            const controlScreenshotValue = controlScreenshotRecord.artifactId;
            const controlFullPageValue = controlScreenshotRecord.fullPageArtifactId;
            const controlFullPageError = controlScreenshotRecord.fullPageError;
            const parsedControlTileCoverage = v.safeParse(
                FullPageTileCoverageSchema,
                controlScreenshotRecord.tileCoverage,
            );
            sameDocumentControlTileCoverage = parsedControlTileCoverage.success
                ? parsedControlTileCoverage.output
                : undefined;
            sameDocumentControlViewport = parseValidationViewportPosition(
                controlScreenshotRecord.viewportPosition,
            );
            if (sameDocumentControlViewport) {
                viewportAnchor = sameDocumentControlViewport;
            }
            sameDocumentControlScreenshotArtifactId =
                typeof controlScreenshotValue === 'string' ? controlScreenshotValue : undefined;
            sameDocumentControlFullPageScreenshotArtifactId =
                typeof controlFullPageValue === 'string' ? controlFullPageValue : undefined;
            if (
                !sameDocumentControlScreenshotArtifactId ||
                !sameDocumentControlFullPageScreenshotArtifactId ||
                !sameDocumentControlViewport ||
                (typeof controlFullPageError === 'string' && controlFullPageError.length > 0)
            ) {
                sameDocumentControlError =
                    'materialization screenshot did not produce complete viewport and full-page evidence';
            } else {
                if (viewportAnchor && config.restoreViewportAnchor) {
                    const restoredViewport = await config.restoreViewportAnchor(viewportAnchor);
                    if (!restoredViewport) {
                        sameDocumentControlError =
                            'control screenshot changed the validation viewport position';
                    }
                }
                if (config.beforeDeferredRule) {
                    await config.beforeDeferredRule();
                }
                const normalizedDeferredRule = normalizeRule(config.deferredRule);
                if (
                    !sameDocumentControlError &&
                    normalizedDeferredRule.kind === RuleKind.Cosmetic &&
                    !normalizedDeferredRule.isException
                ) {
                    const application = await applyRule(config.page, config.deferredRule);
                    ruleApplications[ruleApplications.length - 1] = ruleApplicationFact(
                        config.deferredRule,
                        application,
                    );
                    if (application.applied) {
                        appliedRules.push(config.deferredRule);
                        deferredCleanup = application.cleanup;
                        if (config.afterDeferredRule) {
                            try {
                                await config.afterDeferredRule();
                            } catch (error) {
                                sameDocumentControlError = `immediate candidate probe failed: ${(error as Error).message}`;
                            }
                        }
                    }
                }
            }
        }
    }

    let screenshotArtifactId = '';
    let fullPageScreenshotArtifactId: string | undefined;
    let tileCoverage: FullPageTileCoverage | undefined;
    let harArtifactId = '';
    let domArtifactId = '';
    let antiAdblockDetected = false;
    try {
        if (
            config.deferredRule &&
            appliedRules.includes(config.deferredRule) &&
            viewportAnchor &&
            config.restoreViewportAnchor
        ) {
            const restoredCandidateViewport = await config.restoreViewportAnchor(viewportAnchor);
            if (!restoredCandidateViewport) {
                sameDocumentControlError =
                    'candidate screenshot could not restore the control viewport position';
            }
        }
        // ── Capture artifacts ────────────────────────────────────────────
        const phaseTileWindow = await resolveTileWindow();
        const screenshotResult = await config.handlers.screenshot({
            captureTiles: config.captureVisualTiles === true,
            ...(phaseTileWindow ? { tileWindow: phaseTileWindow } : {}),
        });
        const harResult = await config.handlers.get_network_log({});
        const domResult = await config.handlers.get_dom({});

        const screenshotRecord = screenshotResult as Record<string, unknown>;
        const harRecord = harResult as Record<string, unknown>;
        const domRecord = domResult as Record<string, unknown>;
        const screenshotArtifactValue = screenshotRecord.artifactId;
        const fullPageArtifactValue = screenshotRecord.fullPageArtifactId;
        const parsedTileCoverage = v.safeParse(
            FullPageTileCoverageSchema,
            screenshotRecord.tileCoverage,
        );
        tileCoverage = parsedTileCoverage.success ? parsedTileCoverage.output : undefined;
        candidateViewport = config.deferredRule
            ? parseValidationViewportPosition(screenshotRecord.viewportPosition)
            : undefined;
        const harArtifactValue = harRecord.artifactId;
        const domArtifactValue = domRecord.artifactId;
        screenshotArtifactId =
            typeof screenshotArtifactValue === 'string' ? screenshotArtifactValue : '';
        fullPageScreenshotArtifactId =
            typeof fullPageArtifactValue === 'string' ? fullPageArtifactValue : undefined;
        harArtifactId = typeof harArtifactValue === 'string' ? harArtifactValue : '';
        domArtifactId = typeof domArtifactValue === 'string' ? domArtifactValue : '';

        if (
            config.deferredRule &&
            (!sameDocumentControlViewport ||
                !candidateViewport ||
                !validationViewportPairMatches(sameDocumentControlViewport, candidateViewport))
        ) {
            sameDocumentControlError =
                'control and candidate screenshots were not captured at the same stable viewport position';
        }

        if (config.afterArtifacts) {
            await config.afterArtifacts();
        }

        // ── Collect the anti-adblock observation ─────────────────────────
        antiAdblockDetected = await checkAntiAdblock(config.trustedPageEvaluator);
    } finally {
        if (config.deferredRule && appliedRules.includes(config.deferredRule)) {
            if (!deferredCleanup) {
                sameDocumentControlError = 'deferred cosmetic style could not be removed';
            } else {
                try {
                    await deferredCleanup();
                    if (config.afterDeferredRuleRemoved) {
                        await config.afterDeferredRuleRemoved();
                    }
                } catch (error) {
                    sameDocumentControlError = `candidate restoration failed: ${(error as Error).message}`;
                }
            }
        }
    }

    config.recorder.record(TraceEventType.PhaseEnd, {
        phase: config.phase,
        url: openResult.url || config.url,
        antiAdblockDetected,
    });

    return {
        phase: config.phase,
        screenshotArtifactId: String(screenshotArtifactId),
        fullPageScreenshotArtifactId,
        tileCoverage,
        sameDocumentControlScreenshotArtifactId,
        sameDocumentControlFullPageScreenshotArtifactId,
        sameDocumentControlTileCoverage,
        sameDocumentControlViewport,
        candidateViewport,
        sameDocumentControlError,
        harArtifactId: String(harArtifactId),
        domArtifactId: String(domArtifactId),
        url: String(openResult.url || config.url),
        appliedRules,
        ruleApplications,
        antiAdblockDetected,
    };
}

/**
 * Run the full three-phase validation.
 *
 * Phase A: Clean baseline (no filters). Phase B: Current repo filters applied, ad expected visible.
 * Phase C: Current filters + candidate rule applied.
 *
 * If Phase A fails, B and C return stubs. If Phase B fails, C returns a stub. Ad-element probe runs
 * after Phase B and Phase C separately.
 *
 * @param config - The validation configuration.
 * @returns A factual validation result with no verdict (verdict is LLM-determined).
 */
export async function runValidation(config: ValidationConfig): Promise<FactualValidationResult> {
    const {
        handlers,
        page,
        artifactsDir,
        recorder,
        url,
        candidateRule,
        existingRules,
        replacedRule,
        adElementSelector,
        trustedValidationContext: suppliedTrustedValidationContext,
        testOnlyAllowMainWorldProbeFallback = false,
    } = config;
    const trustedValidationContext = resolveTrustedValidationContext(
        url,
        existingRules,
        suppliedTrustedValidationContext,
    );
    const trustedValidationEvidence = {
        reportedUrl: trustedValidationContext.reportedUrl,
        baselineHash: trustedValidationContext.baselineHash,
        existingRuleCount: trustedValidationContext.existingRules.length,
    };
    const phaseCExistingRules = resolvePhaseCExistingRules(
        existingRules,
        candidateRule,
        replacedRule,
    );
    const trustedPageEvaluator = testOnlyAllowMainWorldProbeFallback
        ? createTestOnlyToolEvaluator(handlers)
        : await createTrustedPageEvaluator(page);
    const structuralPageEvaluator = testOnlyAllowMainWorldProbeFallback
        ? createTestOnlyPageEvaluator(page)
        : trustedPageEvaluator;

    // Determine the ad element selector
    const normalizedCandidate = normalizeRule(candidateRule);
    const selector = resolveValidatedSelector(candidateRule, adElementSelector);
    const validatesLayout = normalizedCandidate.cssInjectionBody !== undefined;
    const deferCandidate =
        normalizedCandidate.kind === RuleKind.Cosmetic && !normalizedCandidate.isException;

    // ── Phase A: Clean baseline (no rules) ────────────────────────────────
    const phaseAResult = await runPhase({
        handlers,
        page,
        artifactsDir,
        recorder,
        phase: PhaseLabel.A,
        url,
        rules: [],
        trustedPageEvaluator,
        adElementSelector: selector || undefined,
    });

    // If Phase A failed (page unreachable), short-circuit
    if (phaseAResult.error) {
        return {
            trustedValidationContext: trustedValidationEvidence,
            phaseA: phaseAResult,
            phaseB: stubPhase('B', url, 'phase A failed — page unreachable'),
            phaseC: stubPhase('C', url, 'phase A failed — page unreachable'),
            validatedSelector: selector,
            adElementStatus: {
                selector,
                phaseB: AdElementPresence.NotProbed,
                phaseC: AdElementPresence.NotProbed,
            },
            structureFacts: {
                before: unavailableStructuralSnapshot(),
                after: unavailableStructuralSnapshot(),
            },
            summary: `Candidate experiment: Phase A navigation failed — ${phaseAResult.error}`,
        };
    }

    // ── Phase B: Existing repo filters ───────────────────────────────────
    let phaseBStructure = unavailableStructuralSnapshot();
    const phaseBResult = await runPhase({
        handlers,
        page,
        artifactsDir,
        recorder,
        phase: PhaseLabel.B,
        url,
        rules: existingRules,
        captureVisualTiles: !deferCandidate,
        trustedPageEvaluator,
        adElementSelector: selector || undefined,
        afterArtifacts: async () => {
            phaseBStructure = await probeStructuralSnapshot(structuralPageEvaluator, selector);
        },
    });

    if (phaseBResult.error) {
        return {
            trustedValidationContext: trustedValidationEvidence,
            phaseA: phaseAResult,
            phaseB: phaseBResult,
            phaseC: stubPhase('C', url, 'phase B failed — page unreachable'),
            validatedSelector: selector,
            adElementStatus: {
                selector,
                phaseB: AdElementPresence.NotProbed,
                phaseC: AdElementPresence.NotProbed,
            },
            structureFacts: {
                before: unavailableStructuralSnapshot(),
                after: unavailableStructuralSnapshot(),
            },
            summary: `Candidate experiment: Phase B navigation failed — ${phaseBResult.error}`,
        };
    }

    // Probe ad element after Phase B
    let phaseBPresence: AdElementPresence = AdElementPresence.NotProbed;
    if (selector) {
        phaseBPresence = await probeAdElement(trustedPageEvaluator, selector);
    }
    let phaseBGeometry =
        selector && validatesLayout
            ? await probeElementGeometry(trustedPageEvaluator, selector)
            : undefined;

    // ── Phase C: Existing + candidate rule ───────────────────────────────
    const allRules = [...phaseCExistingRules, candidateRule];
    let phaseCControlStructure = unavailableStructuralSnapshot();
    let phaseCImmediateStructure = unavailableStructuralSnapshot();
    let phaseCPostArtifactsStructure = unavailableStructuralSnapshot();
    let phaseCRestoredStructure = unavailableStructuralSnapshot();
    let beforeDeferredRule: PhaseConfig['beforeDeferredRule'];
    let afterDeferredRule: PhaseConfig['afterDeferredRule'];
    let afterDeferredRuleRemoved: PhaseConfig['afterDeferredRuleRemoved'];
    if (deferCandidate) {
        beforeDeferredRule = async () => {
            phaseCControlStructure = await probeStructuralSnapshot(
                structuralPageEvaluator,
                selector,
            );
        };
        afterDeferredRule = async () => {
            phaseCImmediateStructure = await probeStructuralSnapshot(
                structuralPageEvaluator,
                selector,
            );
        };
        afterDeferredRuleRemoved = async () => {
            phaseCRestoredStructure = await probeStructuralSnapshot(
                structuralPageEvaluator,
                selector,
            );
        };
    }
    const phaseCResult = await runPhase({
        handlers,
        page,
        artifactsDir,
        recorder,
        phase: PhaseLabel.C,
        url,
        rules: deferCandidate ? phaseCExistingRules : allRules,
        deferredRule: deferCandidate ? candidateRule : undefined,
        materialize: deferCandidate
            ? async () => materializePage(structuralPageEvaluator)
            : undefined,
        createViewportAnchor: deferCandidate
            ? async () => createValidationViewportAnchor(structuralPageEvaluator, selector)
            : undefined,
        restoreViewportAnchor: deferCandidate
            ? async (anchor) => restoreValidationViewportAnchor(structuralPageEvaluator, anchor)
            : undefined,
        beforeDeferredRule,
        afterDeferredRule,
        trustedPageEvaluator,
        adElementSelector: selector || undefined,
        afterArtifacts: async () => {
            phaseCPostArtifactsStructure = await probeStructuralSnapshot(
                structuralPageEvaluator,
                selector,
            );
        },
        afterDeferredRuleRemoved,
        captureVisualTiles: true,
    });

    let phaseCPresence: AdElementPresence = AdElementPresence.NotProbed;
    if (selector && !phaseCResult.error) {
        phaseCPresence = await probeAdElement(trustedPageEvaluator, selector);
    }
    let phaseCGeometry =
        selector && validatesLayout && !phaseCResult.error
            ? await probeElementGeometry(trustedPageEvaluator, selector)
            : undefined;

    if (selector && deferCandidate && !phaseCResult.error) {
        phaseBPresence = presenceFromStructuralSnapshot(phaseCControlStructure);
        phaseCPresence = presenceFromStructuralSnapshot(phaseCPostArtifactsStructure);
        if (validatesLayout) {
            phaseBGeometry = geometryFromStructuralSnapshot(phaseCControlStructure);
            phaseCGeometry = geometryFromStructuralSnapshot(phaseCImmediateStructure);
        }
    }

    const structureFacts = {
        before: deferCandidate ? phaseCControlStructure : phaseBStructure,
        after: deferCandidate ? phaseCImmediateStructure : phaseCPostArtifactsStructure,
        ...(deferCandidate ? { afterArtifacts: phaseCPostArtifactsStructure } : {}),
        ...(deferCandidate ? { restoredControl: phaseCRestoredStructure } : {}),
    };
    let layoutFacts: FactualValidationResult['layoutFacts'];
    if (phaseBGeometry && phaseCGeometry) {
        layoutFacts = {
            selector,
            before: phaseBGeometry,
            after: phaseCGeometry,
        };
    }
    const summary = [
        'Candidate experiment facts:',
        `Selector: ${selector || '(not available)'}.`,
        `Before target presence: ${phaseBPresence}.`,
        `After target presence: ${phaseCPresence}.`,
        layoutFacts
            ? `Target geometry: ${layoutFacts.before.width}x${layoutFacts.before.height}px -> ` +
              `${layoutFacts.after.width}x${layoutFacts.after.height}px.`
            : 'Target geometry: not collected.',
        'No page-safety verdict was computed by browser code.',
    ].join('\n');

    // Write the factual result as a trace artifact
    const factualResult: FactualValidationResult = {
        trustedValidationContext: trustedValidationEvidence,
        phaseA: phaseAResult,
        phaseB: phaseBResult,
        phaseC: phaseCResult,
        layoutFacts,
        validatedSelector: selector,
        adElementStatus: {
            selector,
            phaseB: phaseBPresence,
            phaseC: phaseCPresence,
        },
        structureFacts,
        summary,
    };

    const candidateHash = createHash('sha256').update(candidateRule).digest('hex').slice(0, 12);
    const artifactPath = join(artifactsDir, `factual-validation-${candidateHash}.json`);
    mkdirSync(artifactsDir, { recursive: true });
    const serializedResult = JSON.stringify(factualResult, null, 2);
    writeFileSync(artifactPath, serializedResult);
    recorder.addArtifact({
        id: `validation-${candidateHash}`,
        path: artifactPath,
        type: 'application/json',
        bytes: Buffer.byteLength(serializedResult),
    });

    return factualResult;
}
