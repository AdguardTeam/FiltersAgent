import { readFileSync } from 'node:fs';
import { createBrowserToolHandlers } from '../browser/browser-tools';
import { createTrustedPageEvaluator } from '../browser/trusted-page-evaluator';
import { inspectFullPageVisualCapture } from '../analyzer/full-page-capture-inspection';
import { resolveCandidateVisualEvidence } from '../validator/candidate-evidence-resolver';
import { reviewCandidateVisually } from '../validator/candidate-visual-verifier';
import { SymptomKind, isBreakageSymptom } from '../validator/symptom-rubric';
import {
    judgeableBlockedHost,
    phaseHostRequests,
    verifyCandidateNetwork,
    type CandidateNetworkVerification,
} from '../validator/candidate-network-verification';
import type { NetworkRequestEntry } from '../browser/browser-interfaces';
import { normalizeRule } from '../repo/rule-normalizer';
import { runPhase } from '../validator/phase-capture';
import type { AdsEnvironmentPhaseObservationInput } from '../validator/phase-orchestrator';
import {
    presenceFromStructuralSnapshot,
    probeStructuralSnapshot,
} from '../validator/structural-snapshot';
import type { SingleShotClient } from '../pi/single-shot-types';
import type { TraceRecorder } from '../tracer/trace-recorder';
import {
    CandidateVisualVerdict,
    isCandidateVisualPageUsable,
    type CandidateVisualReview,
} from '../types/candidate-visual-review';
import type { ReproProfile } from '../types/repro-profile';
import {
    AdElementPresence,
    PhaseLabel,
    type FactualValidationResult,
    type FullPageTileWindow,
    type PhaseResult,
    type StructuralSnapshot,
} from '../types/validation';
import { resolveValidatedSelector } from '../validator/candidate-selector';
import type { TrustedValidationContext } from '../validator/trusted-validation-context';
import { deriveCandidateArtifactExecutionSuffix } from '../types/candidate-artifact-identity';
import {
    EnvironmentAdapterLimitationCode,
    EnvironmentLimitationStage,
    type EnvironmentArtifactReference,
    type EnvironmentBrowserCapture,
    type ValidatorObservedPhaseCompletion,
    type ValidatorPhaseCompletion,
} from './filtering-environment';
import { ReporterSymptomPresence } from '../types/reporter-symptom-presence';
import { InteractionReplay, type InteractionReplayProjection } from './interaction-replay';
import type { NormalizedSafeInteractionPlan } from './safe-interaction';
import { measureDomChecks, pairDomCheckMeasurements } from './dom-check-runner';
import {
    candidateScreenshotArtifacts,
    environmentArtifact,
    phaseCaptureFailed,
    persistFactualValidation,
    phaseScreenshotIds,
    withExtensionRuleFacts,
} from './extension-phase-records';
import type { DomCheck, DomCheckMeasurement, DomCheckRecord } from '../types/dom-check';

/**
 * Runtime-owned inputs shared by all phases of one Extension candidate experiment.
 */
export interface BrowserExtensionAdsObserverOptions {
    /**
     * Exact candidate rule persisted by the Extension in phase C.
     */
    candidateRule: string;

    /**
     * Optional explicit selector for a network candidate.
     */
    adElementSelector?: string;

    /**
     * Runner-bound target and repository baseline.
     */
    trustedValidationContext: TrustedValidationContext;

    /**
     * Browser profile shared by every adapter-owned phase.
     */
    profile: ReproProfile;

    /**
     * Trace and artifact owner shared with the fix runtime.
     */
    recorder: TraceRecorder;

    /**
     * Directory containing all phase artifacts.
     */
    artifactsDir: string;

    /**
     * Single-shot client used for structured phase and candidate review.
     */
    vision: SingleShotClient;

    /**
     * Bounded description of the reporter-defined symptom.
     */
    reporterSymptom: string;

    /**
     * Problem class driving the visual review rubric; ads semantics when omitted.
     */
    symptomKind?: SymptomKind;

    /**
     * One-based semantic candidate attempt number.
     */
    attemptNumber: number;

    /**
     * Whether Chromium requires the CI no-sandbox flag.
     */
    noSandbox: boolean;

    /**
     * Reveal steps the model passed to apply_rule, replayed identically in every phase.
     */
    interactionPlan?: NormalizedSafeInteractionPlan;

    /**
     * DOM checks the model attached to apply_rule, measured after capture in phases B and C.
     */
    domChecks?: readonly DomCheck[];

    /**
     * Optional bounded browser and vision seams used by behavioral fixtures.
     */
    dependencies?: BrowserExtensionAdsObserverDependencies;
}

/**
 * Bounded seams around browser and vision operations while retaining the production observer.
 */
export interface BrowserExtensionAdsObserverDependencies {
    /**
     * Execute one browser phase through a deterministic fixture boundary.
     */
    runPhase?: (
        input: AdsEnvironmentPhaseObservationInput,
        config: Parameters<typeof runPhase>[0],
    ) => ReturnType<typeof runPhase>;

    /**
     * Probe the candidate target through a deterministic fixture boundary.
     */
    probeStructuralSnapshot?: (
        input: AdsEnvironmentPhaseObservationInput,
        evaluator: Parameters<typeof probeStructuralSnapshot>[0],
        selector: string,
    ) => ReturnType<typeof probeStructuralSnapshot>;

    /**
     * Inspect one captured page through a deterministic fixture boundary.
     */
    inspectFullPageVisualCapture?: (
        input: AdsEnvironmentPhaseObservationInput,
        options: Parameters<typeof inspectFullPageVisualCapture>[0],
        capture: Parameters<typeof inspectFullPageVisualCapture>[1],
    ) => ReturnType<typeof inspectFullPageVisualCapture>;

    /**
     * Read one phase's recorded network log through a deterministic fixture boundary. Production
     * reads the phase's own HAR artifact back from disk; a fixture that registers no HAR file
     * supplies the entries directly.
     */
    readPhaseNetworkLog?: (
        input: AdsEnvironmentPhaseObservationInput,
        har: EnvironmentArtifactReference,
    ) => NetworkRequestEntry[];

    /**
     * Resolve the exact before/after artifact pairing for candidate review.
     */
    resolveCandidateVisualEvidence?: (
        input: AdsEnvironmentPhaseObservationInput,
        options: Parameters<typeof resolveCandidateVisualEvidence>[0],
    ) => ReturnType<typeof resolveCandidateVisualEvidence>;

    /**
     * Review one exact candidate pairing through a deterministic fixture boundary.
     */
    reviewCandidateVisually?: (
        input: AdsEnvironmentPhaseObservationInput,
        options: Parameters<typeof reviewCandidateVisually>[0],
    ) => ReturnType<typeof reviewCandidateVisually>;
}

/**
 * Complete phase material retained until phase C can bind before/after evidence.
 */
interface ObservedExtensionPhase {
    /**
     * Browser facts and artifact identities emitted by the shared phase runner.
     */
    result: PhaseResult;

    /**
     * Trusted structural snapshot for the candidate target.
     */
    structure: StructuralSnapshot;

    /**
     * Whether the probe measured a selector derived from the candidate rather than the whole
     * document. A network candidate names no element, so its probe falls back to `body`, whose
     * presence proves nothing about the content the reporter lost.
     */
    structureBoundToSelector: boolean;

    /**
     * Semantic presence of the reporter-defined symptom.
     */
    symptomPresence: ReporterSymptomPresence;

    /**
     * Whether the complete screenshot inventory was inspected.
     */
    visionVerified: boolean;

    /**
     * Persisted full-page visual inventory artifact.
     */
    inventoryArtifact: EnvironmentArtifactReference;

    /**
     * Canonical screenshot/HAR/DOM/vision references owned by this phase.
     */
    artifacts: EnvironmentArtifactReference[];

    /**
     * The phase's recorded requests, read back from its HAR artifact when the candidate is a host
     * block the runner judges by them; empty otherwise.
     */
    network: NetworkRequestEntry[];

    /**
     * Compatibility capture projected from the canonical phase.
     */
    capture: EnvironmentBrowserCapture;
}

/**
 * The candidate target's presence in one phase, as the factual record states it.
 *
 * A candidate that names no element — a scriptlet, a network rule without `adElementSelector` —
 * leaves the probe measuring `body`, which says nothing about the target: reporting it `visible`
 * would tell the review and the model the target survived the candidate.
 *
 * @param observed - The phase's probe and whether it was bound to the candidate's selector.
 * @returns The presence, `not_probed` for an unbound probe.
 */
function boundPresence(observed: ObservedExtensionPhase): AdElementPresence {
    return observed.structureBoundToSelector
        ? presenceFromStructuralSnapshot(observed.structure)
        : AdElementPresence.NotProbed;
}

/**
 * Common single-phase observer and compatibility response builder for Extension Ads.
 */
export class BrowserExtensionAdsObserver {
    /**
     * Completed phase material indexed by A/B/C.
     */
    private readonly phases = new Map<PhaseLabel, ObservedExtensionPhase>();

    /**
     * Existing model-visible apply_rule response built during phase C.
     */
    private applyRuleResult: Record<string, unknown> | null = null;

    /**
     * Document-space tile windows measured while the symptom element was still visible.
     *
     * Phase C applies the candidate so the element is hidden and cannot bound its own window; the
     * latest visible-state measurement keeps its capture comparable to the before state.
     */
    private readonly tileWindows = new Map<
        typeof PhaseLabel.A | typeof PhaseLabel.B,
        FullPageTileWindow
    >();

    /**
     * Create one observer for a single candidate experiment.
     *
     * @param options - Trusted candidate, browser, vision, and artifact inputs.
     */
    /**
     * The host the candidate blocks, when it is a third-party host block the phase network logs can
     * judge; undefined leaves every decision to vision and the structural probe.
     */
    private readonly blockedHost: string | undefined;

    /**
     * Coordinator replaying the reveal steps, or null when apply_rule received none.
     */
    private readonly interactionReplay: InteractionReplay | null;

    /**
     * What the DOM checks returned on the baseline page, kept until phase C pairs them.
     */
    private baselineDomChecks: DomCheckMeasurement[] = [];

    constructor(private readonly options: BrowserExtensionAdsObserverOptions) {
        this.blockedHost = judgeableBlockedHost(
            options.candidateRule,
            options.trustedValidationContext.reportedUrl,
        );
        this.interactionReplay = options.interactionPlan
            ? new InteractionReplay({
                  plan: options.interactionPlan,
                  allowedOrigin: options.trustedValidationContext.reportedUrl,
                  artifactsDir: options.artifactsDir,
                  recorder: options.recorder,
              })
            : null;
    }

    /**
     * Observe one adapter-established phase without applying any browser-emulated rules.
     *
     * @param input - Common session and exact adapter phase proof.
     * @returns Complete validator-owned phase outcome.
     */
    async observe(input: AdsEnvironmentPhaseObservationInput): Promise<ValidatorPhaseCompletion> {
        const page = input.session.getPage();
        const handlers = createBrowserToolHandlers({
            session: input.session,
            recorder: this.options.recorder,
            artifactsDir: this.options.artifactsDir,
            allowedOrigin: this.options.trustedValidationContext.reportedUrl,
            consentStrategy: this.options.profile.consentStrategy,
        });
        const selector = resolveValidatedSelector(
            this.options.candidateRule,
            this.options.adElementSelector,
        );
        const rememberedWindow = this.tileWindows.get('B') ?? this.tileWindows.get('A');
        const phaseConfig: Parameters<typeof runPhase>[0] = {
            handlers,
            page,
            artifactsDir: this.options.artifactsDir,
            phase: input.phase,
            url: this.options.trustedValidationContext.reportedUrl,
            trustedPageEvaluator: await createTrustedPageEvaluator(page),
            ...(selector ? { adElementSelector: selector } : {}),
            ...(input.phase === PhaseLabel.C && rememberedWindow
                ? { tileWindow: rememberedWindow }
                : {}),
            captureVisualTiles: true,
            recorder: this.options.recorder,
            ...(this.interactionReplay
                ? {
                      interact: this.interactionReplay.replayFor(
                          input.phase,
                          input.session,
                          deriveCandidateArtifactExecutionSuffix(input.phaseTokenId),
                      ),
                  }
                : {}),
        };
        const phaseResult = this.options.dependencies?.runPhase
            ? await this.options.dependencies.runPhase(input, phaseConfig)
            : await runPhase(phaseConfig);
        if (input.phase !== PhaseLabel.C && phaseResult.tileCoverage?.window) {
            this.tileWindows.set(input.phase, phaseResult.tileCoverage.window);
        }
        if (phaseCaptureFailed(phaseResult, this.options.recorder, input.phase)) {
            return {
                kind: 'failed',
                sessionId: input.proof.sessionId,
                limitation: {
                    code: EnvironmentAdapterLimitationCode.PhaseProofUnavailable,
                    stage: EnvironmentLimitationStage.Phase,
                    detail: 'The Extension phase could not collect complete browser evidence.',
                },
            };
        }
        const evaluator = await createTrustedPageEvaluator(page);
        const targetSelector = selector || 'body';
        let structure: StructuralSnapshot;
        if (this.options.dependencies?.probeStructuralSnapshot) {
            structure = await this.options.dependencies.probeStructuralSnapshot(
                input,
                evaluator,
                targetSelector,
            );
        } else {
            structure = await probeStructuralSnapshot(evaluator, targetSelector);
        }
        // Measured on the load the screenshots captured, and after every other read of the page: a
        // check that holds the main thread can then cost only the checks after it.
        const domChecks =
            input.phase === PhaseLabel.A || !this.options.domChecks
                ? []
                : await measureDomChecks(page, this.options.domChecks, {
                      phase: input.phase,
                      artifactsDir: this.options.artifactsDir,
                      recorder: this.options.recorder,
                  });
        if (input.phase === PhaseLabel.B) {
            this.baselineDomChecks = domChecks;
        }
        const inventoryOptions: Parameters<typeof inspectFullPageVisualCapture>[0] = {
            vision: this.options.vision,
            reporterSymptom: this.options.reporterSymptom,
            symptomKind: this.options.symptomKind ?? SymptomKind.Ads,
            artifactsDir: this.options.artifactsDir,
            recorder: this.options.recorder,
            // The experiment's cancellation, so an expired apply_rule deadline cancels the batch's
            // in-flight vision completion instead of paying out the rest of the images.
            ...(input.signal === undefined ? {} : { signal: input.signal }),
        };
        const inventoryCapture: Parameters<typeof inspectFullPageVisualCapture>[1] = {
            // Omitting the viewport screenshot fails the whole phase observation at the schema, not
            // at the vision call; an overview the browser could not capture is simply absent.
            artifactId: phaseResult.screenshotArtifactId,
            fullPageArtifactId: phaseResult.fullPageScreenshotArtifactId,
            tileCoverage: phaseResult.tileCoverage,
        };
        let visualInventory: Awaited<ReturnType<typeof inspectFullPageVisualCapture>>;
        if (this.options.dependencies?.inspectFullPageVisualCapture) {
            visualInventory = await this.options.dependencies.inspectFullPageVisualCapture(
                input,
                inventoryOptions,
                inventoryCapture,
            );
        } else {
            visualInventory = await inspectFullPageVisualCapture(
                inventoryOptions,
                inventoryCapture,
            );
        }
        const inventoryArtifact = environmentArtifact(
            this.options.recorder,
            visualInventory.artifactId,
            'vision',
        );
        const screenshots = phaseScreenshotIds(phaseResult).map((artifactId) =>
            environmentArtifact(this.options.recorder, artifactId, 'screenshot'),
        );
        const har = environmentArtifact(this.options.recorder, phaseResult.harArtifactId, 'har');
        const dom = environmentArtifact(this.options.recorder, phaseResult.domArtifactId, 'dom');
        const network = this.blockedHost === undefined ? [] : this.readPhaseNetworkLog(input, har);
        const interactionArtifact = this.interactionReplay?.artifactOf(input.phase);
        const viewport = screenshots.find(
            (artifact) => artifact.artifactId === phaseResult.screenshotArtifactId,
        );
        const fullPage = screenshots.find(
            (artifact) => artifact.artifactId === phaseResult.fullPageScreenshotArtifactId,
        );
        const tileArtifacts =
            phaseResult.tileCoverage?.tiles.map((tile) =>
                environmentArtifact(this.options.recorder, tile.artifactId, 'screenshot'),
            ) ?? [];
        const observed: ObservedExtensionPhase = {
            result: phaseResult,
            structure,
            structureBoundToSelector: selector.length > 0,
            symptomPresence: visualInventory.inventory.reporterSymptomPresence,
            visionVerified: visualInventory.coverageComplete,
            inventoryArtifact,
            artifacts: [
                ...screenshots,
                har,
                dom,
                inventoryArtifact,
                ...(interactionArtifact ? [interactionArtifact] : []),
            ],
            network,
            capture: {
                visionVerified: visualInventory.coverageComplete,
                viewportArtifactId: viewport?.artifactId ?? null,
                viewport: viewport?.path ?? null,
                fullPageOverviewArtifactId: fullPage?.artifactId ?? null,
                fullPageOverview: fullPage?.path ?? null,
                tileArtifactIds: tileArtifacts.map((artifact) => artifact.artifactId),
                tiles: tileArtifacts.map((artifact) => artifact.path),
                coverageComplete: visualInventory.coverageComplete,
                reporterSymptomPresence: visualInventory.inventory.reporterSymptomPresence,
            },
        };
        this.phases.set(input.phase, observed);
        if (input.phase !== PhaseLabel.C) {
            return this.phaseCompletion(input, observed, null, null);
        }
        return await this.candidateCompletion(
            input,
            observed,
            pairDomCheckMeasurements(
                this.options.domChecks ?? [],
                this.baselineDomChecks,
                domChecks,
            ),
        );
    }

    /**
     * Return the compatibility apply_rule response produced by phase C.
     *
     * @returns Existing model-visible response or null before phase C completes.
     */
    result(): Record<string, unknown> | null {
        return this.applyRuleResult ? structuredClone(this.applyRuleResult) : null;
    }

    /**
     * Return what the reveal steps did in each phase that ran.
     *
     * Available before phase C, so an experiment that stopped early can still state whether its
     * pages were ever put into the state the symptom needs.
     *
     * @returns Per-phase replay projection, or null when apply_rule received no reveal steps.
     */
    revealStepsProjection(): InteractionReplayProjection | null {
        return this.interactionReplay?.projection() ?? null;
    }

    /**
     * Read one phase's requests back from its HAR artifact.
     *
     * The HAR is the run's own redacted record, written by the phase runner moments earlier, so it
     * is parsed and trusted; a file that does not parse is a producer fault and fails loudly.
     *
     * @param input - The phase being observed.
     * @param har - The phase's HAR artifact reference.
     * @returns The phase's recorded requests.
     */
    private readPhaseNetworkLog(
        input: AdsEnvironmentPhaseObservationInput,
        har: EnvironmentArtifactReference,
    ): NetworkRequestEntry[] {
        if (this.options.dependencies?.readPhaseNetworkLog) {
            return this.options.dependencies.readPhaseNetworkLog(input, har);
        }
        return JSON.parse(readFileSync(har.path, 'utf8')) as NetworkRequestEntry[];
    }

    /**
     * Judge a host-block candidate by the three phases' requests to the blocked host.
     *
     * @param phaseA - Observed unfiltered control.
     * @param control - Observed published baseline.
     * @param candidatePhase - Observed candidate phase.
     * @returns The verification, or undefined when the candidate is not one requests can judge.
     */
    private candidateNetworkVerification(
        phaseA: ObservedExtensionPhase,
        control: ObservedExtensionPhase,
        candidatePhase: ObservedExtensionPhase,
    ): CandidateNetworkVerification | undefined {
        if (this.blockedHost === undefined) {
            return undefined;
        }
        return verifyCandidateNetwork({
            candidateRule: this.options.candidateRule,
            reportedUrl: this.options.trustedValidationContext.reportedUrl,
            phases: { A: phaseA.network, B: control.network, C: candidatePhase.network },
        });
    }

    /**
     * Decide whether the reporter symptom is present in one observed phase.
     *
     * A breakage symptom is the ABSENCE of content, which single-state vision judges badly: it
     * recognises the element the reporter named and reports the symptom present even when that
     * element is intact. When the structural probe measured the named element, its geometry is the
     * objective answer — hidden means broken, visible means restored.
     *
     * @param observed - Browser and vision material collected for the phase.
     * @returns Whether the phase still shows the reporter-defined symptom.
     */
    private symptomPresentInPhase(observed: ObservedExtensionPhase): boolean {
        if (
            !isBreakageSymptom(this.options.symptomKind) ||
            !observed.structureBoundToSelector ||
            !observed.structure.probeSucceeded ||
            observed.structure.targetCount === 0
        ) {
            // A tracker has no picture: for a host block the runner can judge by requests, an
            // allowed request to the blocked host is the symptom, present whatever vision saw.
            const requestsAllowed =
                this.blockedHost !== undefined &&
                phaseHostRequests(observed.network, this.blockedHost).allowed > 0;
            return requestsAllowed || observed.symptomPresence !== ReporterSymptomPresence.Absent;
        }
        // The unfiltered control defines how much of the named content a healthy page renders.
        // Judging visibility absolutely would call a page broken whenever the site itself hides
        // some matches — a state no exception can repair, so no candidate could ever verify.
        const control = this.phases.get('A');
        const referenceIsComparable =
            control !== undefined &&
            control.structureBoundToSelector &&
            control.structure.probeSucceeded &&
            control.structure.targetCount === observed.structure.targetCount;
        if (referenceIsComparable) {
            return observed.structure.targetVisibleCount < control.structure.targetVisibleCount;
        }
        // Without a comparable control, any match the page does not render is missing content.
        return observed.structure.targetVisibleCount < observed.structure.targetCount;
    }

    /**
     * Build a non-candidate or candidate phase completion from common evidence.
     *
     * @param input - Adapter phase and proof.
     * @param observed - Browser and vision material for this phase.
     * @param visualReview - Candidate visual review for C.
     * @param candidateValidation - Candidate binding for C.
     * @returns Complete common phase outcome.
     */
    private phaseCompletion(
        input: AdsEnvironmentPhaseObservationInput,
        observed: ObservedExtensionPhase,
        visualReview: CandidateVisualReview | null,
        candidateValidation: ValidatorObservedPhaseCompletion['candidateValidation'],
    ): ValidatorPhaseCompletion {
        const symptomPresent = this.symptomPresentInPhase(observed);
        let vision: ValidatorObservedPhaseCompletion['vision'];
        if (visualReview === null) {
            vision = {
                artifactId: observed.inventoryArtifact.artifactId,
                verdict: observed.visionVerified ? 'verified' : 'inconclusive',
            };
        } else {
            vision = {
                artifactId: candidateValidation!.visualReviewArtifact!.artifactId,
                verdict: visualReview.verdict,
            };
        }
        return {
            kind: 'observed',
            sessionId: input.proof.sessionId,
            targetUrl: observed.result.url,
            targetObservation: {
                symptomPresent,
                // Page safety is the review's call. The structural probe measures the candidate's
                // selector, and an extended-CSS selector (`:contains`) makes the page's
                // querySelectorAll throw, so a failed probe says nothing about the page.
                pageUsable: visualReview === null || isCandidateVisualPageUsable(visualReview),
            },
            navigationVerified: observed.result.error === undefined,
            artifacts: observed.artifacts,
            vision,
            candidateValidation,
            rejectedCandidates: [],
            profile: this.options.profile,
            captures: [observed.capture],
            ...(visualReview ? { visualReview } : {}),
        };
    }

    /**
     * Build factual compatibility data and the semantic candidate binding for phase C.
     *
     * @param input - Adapter phase C proof and session.
     * @param candidatePhase - Observed phase C material.
     * @param domChecks - The attached DOM checks with what they returned in B and C; empty for
     *   none.
     * @returns Complete phase C outcome.
     */
    private async candidateCompletion(
        input: AdsEnvironmentPhaseObservationInput,
        candidatePhase: ObservedExtensionPhase,
        domChecks: DomCheckRecord[],
    ): Promise<ValidatorPhaseCompletion> {
        const control = this.phases.get('B');
        const phaseA = this.phases.get('A');
        if (!control || !phaseA || !input.proof.candidateDigest) {
            throw new Error('Candidate phase requires complete A/B evidence and proof.');
        }
        const existingRules = this.options.trustedValidationContext.existingRules;
        const phaseAResult = withExtensionRuleFacts(phaseA.result, []);
        const phaseBResult = withExtensionRuleFacts(control.result, existingRules);
        const phaseCResult = withExtensionRuleFacts(candidatePhase.result, [
            ...existingRules,
            this.options.candidateRule,
        ]);
        const selector = resolveValidatedSelector(
            this.options.candidateRule,
            this.options.adElementSelector,
        );
        const factual: FactualValidationResult = {
            trustedValidationContext: {
                reportedUrl: this.options.trustedValidationContext.reportedUrl,
                baselineHash: this.options.trustedValidationContext.baselineHash,
                existingRuleCount: existingRules.length,
            },
            phaseA: phaseAResult,
            phaseB: phaseBResult,
            phaseC: phaseCResult,
            validatedSelector: selector,
            adElementStatus: {
                selector,
                phaseB: boundPresence(control),
                phaseC: boundPresence(candidatePhase),
            },
            structureFacts: {
                before: control.structure,
                after: candidatePhase.structure,
            },
            ...(domChecks.length > 0 ? { domChecks } : {}),
            summary: [
                'Candidate experiment used adapter-owned Extension filtering states.',
                `Before target presence: ${boundPresence(control)}.`,
                `After target presence: ${boundPresence(candidatePhase)}.`,
                'Page safety remains a vision-owned decision.',
            ].join('\n'),
        };
        const executionSuffix = deriveCandidateArtifactExecutionSuffix(input.phaseTokenId);
        const validationArtifact = persistFactualValidation(
            factual,
            this.options.candidateRule,
            executionSuffix,
            this.options.artifactsDir,
            this.options.recorder,
        );
        const evidenceOptions: Parameters<typeof resolveCandidateVisualEvidence>[0] = {
            artifactsDir: this.options.artifactsDir,
            recorder: this.options.recorder,
            validationArtifactId: validationArtifact.artifactId,
        };
        const evidence = this.options.dependencies?.resolveCandidateVisualEvidence
            ? this.options.dependencies.resolveCandidateVisualEvidence(input, evidenceOptions)
            : resolveCandidateVisualEvidence(evidenceOptions);
        const networkVerification = this.candidateNetworkVerification(
            phaseA,
            control,
            candidatePhase,
        );
        const reviewOptions: Parameters<typeof reviewCandidateVisually>[0] = {
            candidateRule: this.options.candidateRule,
            validationArtifactId: validationArtifact.artifactId,
            evidence,
            ...(networkVerification === undefined ? {} : { networkVerification }),
            reporterSymptom: this.options.reporterSymptom,
            symptomKind: this.options.symptomKind ?? SymptomKind.Ads,
            reportedPageUrl: this.options.trustedValidationContext.reportedUrl,
            browserFacts: JSON.stringify({
                validatedSelector: selector,
                ruleKind: normalizeRule(this.options.candidateRule).kind,
                adElementStatus: factual.adElementStatus,
                captureCoverage: {
                    before: control.visionVerified,
                    after: candidatePhase.visionVerified,
                },
            }),
            ...(domChecks.length > 0 ? { domChecks } : {}),
            artifactsDir: this.options.artifactsDir,
            vision: this.options.vision,
            recorder: this.options.recorder,
            artifactIdentitySuffix: executionSuffix,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
        };
        const visual = this.options.dependencies?.reviewCandidateVisually
            ? await this.options.dependencies.reviewCandidateVisually(input, reviewOptions)
            : await reviewCandidateVisually(reviewOptions);
        const visualReviewArtifact = environmentArtifact(
            this.options.recorder,
            visual.artifactId,
            'vision',
        );
        const screenshots = candidateScreenshotArtifacts(
            this.options.recorder,
            phaseBResult,
            phaseCResult,
        );
        const candidateValidation = {
            validationArtifactId: validationArtifact.artifactId,
            candidateDigest: input.proof.candidateDigest,
            candidateRule: this.options.candidateRule,
            verified:
                visual.review.verdict === CandidateVisualVerdict.Verified &&
                !this.symptomPresentInPhase(candidatePhase) &&
                isCandidateVisualPageUsable(visual.review) &&
                // Reveal steps that diverged left the two phases in different states, so whatever
                // the captures show is explained by that difference rather than by the candidate.
                // The divergence stays in the evidence; only the claim of proof is withdrawn.
                (this.interactionReplay?.preparedAlike() ?? true),
            ...screenshots,
            validationArtifact,
            visualReviewArtifact,
        };
        candidatePhase.artifacts.push(validationArtifact, visualReviewArtifact);
        this.applyRuleResult = {
            ...factual,
            evidenceMode: 'collect_only',
            validationAttempt: {
                accepted: true,
                attemptNumber: this.options.attemptNumber,
            },
            validationArtifactId: validationArtifact.artifactId,
            visualReview: visual.review,
            visualReviewArtifactId: visual.artifactId,
            ...(this.interactionReplay ? { revealSteps: this.interactionReplay.projection() } : {}),
        };
        return this.phaseCompletion(input, candidatePhase, visual.review, candidateValidation);
    }
}
