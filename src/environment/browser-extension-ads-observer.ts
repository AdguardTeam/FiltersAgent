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
import { RuleKind, normalizeRule } from '../repo/rule-normalizer';
import { SelectorSource, type OverruledSelector } from '../types/overruled-selector';
import { materializePage } from '../validator/page-materialization';
import { describePhaseNavigationFailure } from '../validator/experiment-navigation-failure';
import { runPhase } from '../validator/phase-capture';
import type { AdsEnvironmentPhaseObservationInput } from '../validator/phase-orchestrator';
import {
    presenceFromStructuralSnapshot,
    probeStructuralSnapshot,
} from '../validator/structural-snapshot';
import {
    CandidateVisualVerdict,
    isCandidateVisualPageUsable,
    type CandidateVisualReview,
} from '../types/candidate-visual-review';
import {
    AdElementPresence,
    PhaseLabel,
    type FactualValidationResult,
    type FullPageTileWindow,
    type StructuralSnapshot,
} from '../types/validation';
import { resolveValidatedSelector } from '../validator/candidate-selector';
import { tileWindowStartsAtTop } from '../validator/element-tile-window';
import { deriveCandidateArtifactExecutionSuffix } from '../types/candidate-artifact-identity';
import {
    EnvironmentAdapterLimitationCode,
    EnvironmentLimitationStage,
    type EnvironmentArtifactReference,
    type ValidatorObservedPhaseCompletion,
    type ValidatorPhaseCompletion,
} from './filtering-environment';
import { ReporterSymptomPresence } from '../types/reporter-symptom-presence';
import { InteractionReplay, type InteractionReplayProjection } from './interaction-replay';
import { measureDomChecks, pairDomCheckMeasurements } from './dom-check-runner';
import type { BrowserExtensionAdsObserverOptions } from './browser-extension-ads-observer-options';
import { probedBreakageSymptomPresent } from './breakage-symptom-reading';
import {
    candidateScreenshotArtifacts,
    environmentArtifact,
    phaseCaptureFailed,
    persistFactualValidation,
    withExtensionRuleFacts,
} from './extension-phase-records';
import { assembleObservedPhase, type ObservedExtensionPhase } from './extension-phase-capture';
import {
    failedCandidateChecks,
    reviewedPhase,
    selectorMatchedNothing,
    withoutBaselineSymptom,
} from './candidate-phase-checks';
import type { DomCheckMeasurement, DomCheckRecord } from '../types/dom-check';

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
     * The bound selector whose geometry called the baseline healthy while vision saw the symptom
     * there, or null when the baseline verdict followed vision.
     */
    private baselineVisionOverruledBy: OverruledSelector | null = null;

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

    /**
     * The candidate's hiding selector when it matched nothing on the filtered baseline, else null.
     */
    private unmatchedSelector: string | null = null;

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
            logger: this.options.logger,
            allowedOrigin: this.options.trustedValidationContext.reportedUrl,
            consentStrategy: this.options.profile.consentStrategy,
        });
        const selector = resolveValidatedSelector(
            this.options.candidateRule,
            this.options.adElementSelector,
        );
        const rememberedWindow = this.tileWindows.get('B') ?? this.tileWindows.get('A');
        const trustedPageEvaluator = await createTrustedPageEvaluator(page);
        const phaseConfig: Parameters<typeof runPhase>[0] = {
            handlers,
            page,
            artifactsDir: this.options.artifactsDir,
            phase: input.phase,
            url: this.options.trustedValidationContext.reportedUrl,
            trustedPageEvaluator,
            materialize: async () => await materializePage(trustedPageEvaluator),
            ...(selector ? { adElementSelector: selector } : {}),
            ...(tileWindowStartsAtTop(
                this.options.candidateRule,
                this.options.trustedValidationContext.reportedUrl,
            )
                ? { tileWindowFromTop: true }
                : {}),
            ...(input.phase === PhaseLabel.C && rememberedWindow
                ? { tileWindow: rememberedWindow }
                : {}),
            captureVisualTiles: true,
            captureTileWindowMap: input.phase !== PhaseLabel.A,
            recorder: this.options.recorder,
            logger: this.options.logger,
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
        if (phaseResult.error !== undefined) {
            return {
                kind: 'failed',
                sessionId: input.proof.sessionId,
                limitation: {
                    code: EnvironmentAdapterLimitationCode.PhaseNavigationFailed,
                    stage: EnvironmentLimitationStage.Phase,
                    detail: describePhaseNavigationFailure(input.phase, phaseResult),
                },
                ...(phaseResult.navigationFallbackReason === undefined
                    ? {}
                    : { navigationFallbackReason: phaseResult.navigationFallbackReason }),
            };
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
        let observed = await assembleObservedPhase(
            {
                result: phaseResult,
                structure,
                structureBoundToSelector: selector.length > 0,
                interactionArtifact: this.interactionReplay?.artifactOf(input.phase),
            },
            {
                recorder: this.options.recorder,
                readNetworkLog:
                    this.blockedHost === undefined
                        ? null
                        : (har) => this.readPhaseNetworkLog(input, har),
                inspectCapture: (capture) => this.inspectPhaseCapture(input, capture),
            },
        );
        // An empty match on a page the reveal steps never prepared says nothing about the rule.
        if (
            input.phase === PhaseLabel.B &&
            (this.interactionReplay?.performedIn(PhaseLabel.B) ?? true) &&
            selectorMatchedNothing(
                this.options.candidateRule,
                this.options.symptomKind ?? SymptomKind.Ads,
                observed.structure,
                observed.structureBoundToSelector,
            )
        ) {
            // The rule has nothing to hide here, whatever the inventory read from the images.
            this.unmatchedSelector = selector;
            observed = withoutBaselineSymptom(observed);
        }
        this.phases.set(input.phase, observed);
        // The baseline phases complete on their own inventory; the candidate phase has none and
        // waits for the paired review.
        if (observed.inventoryVision !== null) {
            return this.phaseCompletion(input, observed, observed.inventoryVision, null, null);
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
     * Return the candidate's hiding selector when it matched nothing on the filtered baseline.
     *
     * @returns The selector, or null when the baseline measurement found it or did not decide.
     */
    unmatchedBaselineSelector(): string | null {
        return this.unmatchedSelector;
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
     * Name the selector whose geometry overruled vision in the filtered baseline.
     *
     * On a breakage report a bound selector decides the phase by whether its element is visible,
     * unless vision called the unfiltered control clean and the baseline broken. When vision did
     * not find the control clean — it saw the breakage there too or could not tell — the geometry
     * decides alone, and a broken state drawn inside an element that stays visible — a wall inside
     * an embedded player — reads as a healthy baseline: the model needs to know the selector, not
     * the description, decided.
     *
     * @returns The overruling selector and its source, or null when the baseline verdict followed
     *   vision.
     */
    baselineVisionOverruledSelector(): OverruledSelector | null {
        return this.baselineVisionOverruledBy;
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
     * Inspect one baseline phase's capture through the single-image inventory.
     *
     * @param input - The phase being observed.
     * @param capture - The phase's viewport, overview and tile identities.
     * @returns The phase's visual inventory.
     */
    private async inspectPhaseCapture(
        input: AdsEnvironmentPhaseObservationInput,
        capture: Parameters<typeof inspectFullPageVisualCapture>[1],
    ): ReturnType<typeof inspectFullPageVisualCapture> {
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
        return this.options.dependencies?.inspectFullPageVisualCapture
            ? await this.options.dependencies.inspectFullPageVisualCapture(
                  input,
                  inventoryOptions,
                  capture,
              )
            : await inspectFullPageVisualCapture(inventoryOptions, capture);
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
     * A breakage symptom whose named element the probe measured is read from that element's
     * geometry against the unfiltered control, unless vision separates the two ({@link
     * probedBreakageSymptomPresent}); every other symptom is vision's, or the requests' for a host
     * block.
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
        return probedBreakageSymptomPresent(observed, this.phases.get(PhaseLabel.A));
    }

    /**
     * Build a non-candidate or candidate phase completion from common evidence.
     *
     * @param input - Adapter phase and proof.
     * @param observed - Browser and vision material for this phase.
     * @param vision - The vision record deciding the phase: the inventory for A/B, the review for
     *   C.
     * @param visualReview - Candidate visual review for C.
     * @param candidateValidation - Candidate binding for C.
     * @returns Complete common phase outcome.
     */
    private phaseCompletion(
        input: AdsEnvironmentPhaseObservationInput,
        observed: ObservedExtensionPhase,
        vision: ValidatorObservedPhaseCompletion['vision'],
        visualReview: CandidateVisualReview | null,
        candidateValidation: ValidatorObservedPhaseCompletion['candidateValidation'],
    ): ValidatorPhaseCompletion {
        const symptomPresent = this.symptomPresentInPhase(observed);
        // Only the geometry branch can call a phase healthy that vision saw broken.
        if (
            input.phase === PhaseLabel.B &&
            !symptomPresent &&
            observed.symptomPresence === ReporterSymptomPresence.Present
        ) {
            this.baselineVisionOverruledBy = {
                selector: resolveValidatedSelector(
                    this.options.candidateRule,
                    this.options.adElementSelector,
                ),
                source:
                    normalizeRule(this.options.candidateRule).kind === RuleKind.Cosmetic
                        ? SelectorSource.Rule
                        : SelectorSource.AdElementSelector,
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
     * @param candidatePhase - Observed phase C material, its symptom undecided until the review.
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
        const judged = reviewedPhase(candidatePhase, visual.review);
        this.phases.set(PhaseLabel.C, judged);
        const reviewVerified = visual.review.verdict === CandidateVisualVerdict.Verified;
        const failedChecks = failedCandidateChecks({
            navigationVerified: judged.result.error === undefined,
            symptomPresent: this.symptomPresentInPhase(judged),
            pageUsable: isCandidateVisualPageUsable(visual.review),
            // Reveal steps that diverged left the two phases in different states, so whatever the
            // captures show is explained by that difference rather than by the candidate. The
            // divergence stays in the evidence; only the claim of proof is withdrawn.
            preparedAlike: this.interactionReplay?.preparedAlike() ?? true,
        });
        const screenshots = candidateScreenshotArtifacts(
            this.options.recorder,
            phaseBResult,
            phaseCResult,
        );
        // Every field is named: the binding lands in a strict schema, so a spread of a wider record
        // would compile and fail the phase-completion parse.
        const candidateValidation: ValidatorObservedPhaseCompletion['candidateValidation'] = {
            validationArtifactId: validationArtifact.artifactId,
            candidateDigest: input.proof.candidateDigest,
            candidateRule: this.options.candidateRule,
            verified: reviewVerified && failedChecks.length === 0,
            beforeViewport: screenshots.beforeViewport,
            afterViewport: screenshots.afterViewport,
            ...(screenshots.beforeFullPage === undefined
                ? {}
                : { beforeFullPage: screenshots.beforeFullPage }),
            ...(screenshots.afterFullPage === undefined
                ? {}
                : { afterFullPage: screenshots.afterFullPage }),
            screenshotArtifactIds: screenshots.screenshotArtifactIds,
            validationArtifact,
            visualReviewArtifact,
        };
        judged.artifacts.push(validationArtifact, visualReviewArtifact);
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
            // Only a verified review has its verdict withdrawn by a check. An undecided review
            // leaves the symptom and the page open, and naming those checks would tell the model
            // the symptom stayed and the page broke.
            failedCandidateChecks: reviewVerified ? failedChecks : [],
            ...(this.interactionReplay ? { revealSteps: this.interactionReplay.projection() } : {}),
        };
        return this.phaseCompletion(
            input,
            judged,
            { artifactId: visualReviewArtifact.artifactId, verdict: visual.review.verdict },
            visual.review,
            candidateValidation,
        );
    }
}
