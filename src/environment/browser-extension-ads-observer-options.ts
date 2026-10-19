/**
 * The inputs of one Extension candidate experiment's observer, and the seams behavioral fixtures
 * replace its browser and vision operations through.
 */
import type { Logger } from '../logger/logger';
import type { inspectFullPageVisualCapture } from '../analyzer/full-page-capture-inspection';
import type { NetworkRequestEntry } from '../browser/browser-interfaces';
import type { SingleShotClient } from '../pi/single-shot-types';
import type { TraceRecorder } from '../tracer/trace-recorder';
import type { DomCheck } from '../types/dom-check';
import type { ReproProfile } from '../types/repro-profile';
import type { resolveCandidateVisualEvidence } from '../validator/candidate-evidence-resolver';
import type { reviewCandidateVisually } from '../validator/candidate-visual-verifier';
import type { runPhase } from '../validator/phase-capture';
import type { AdsEnvironmentPhaseObservationInput } from '../validator/phase-orchestrator';
import type { probeStructuralSnapshot } from '../validator/structural-snapshot';
import type { SymptomKind } from '../validator/symptom-rubric';
import type { TrustedValidationContext } from '../validator/trusted-validation-context';
import type { EnvironmentArtifactReference } from './filtering-environment';
import type { NormalizedSafeInteractionPlan } from './safe-interaction';

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
     * Run logger receiving the phase browsers' navigation and capture failures.
     */
    logger: Logger;

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
