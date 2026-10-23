import type { runPhase } from '../../src/validator/phase-capture';
import { SelectorSource } from '../../src/types/overruled-selector';
import { BrowserFallbackReason } from '../../src/types/browser-fallback-reason';
import { EnvironmentAdapterLimitationCode } from '../../src/environment/filtering-environment';
import { pino } from 'pino';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleCoverage, type IBrowserSession } from '../../src/browser/browser-interfaces';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import { TraceEventType } from '../../src/types/trace';
import { SymptomKind } from '../../src/validator/symptom-rubric';
import { SingleShotResultKind, type SingleShotClient } from '../../src/pi/single-shot-types';

/**
 * A SingleShotClient stub; this suite injects dependency seams for every vision consumer.
 */
const visionStub = {
    modelId: 'stub-vision',
    structured: async () => {
        throw new Error('not used by this suite');
    },
    text: async () => {
        throw new Error('not used by this suite');
    },
} as unknown as SingleShotClient;
import type { ReproProfile } from '../../src/types/repro-profile';
import type { FullPageVisualCaptureResult } from '../../src/analyzer/full-page-capture-inspection';
import { PhaseLabel, type StructuralSnapshot } from '../../src/types/validation';
import { ReporterSymptomPresence } from '../../src/types/reporter-symptom-presence';
import { BrowserExtensionAdsObserver } from '../../src/environment/browser-extension-ads-observer';
import type { PageScrollMeasurement } from '../../src/environment/page-scroll-probe';
import { runAdsEnvironmentExperiment } from '../../src/validator/phase-orchestrator';
import { AdsEnvironmentExperimentVerdict } from '../../src/validator/ads-environment-experiment-result';
import { deriveCandidateNetworkScope } from '../../src/validator/candidate-network-scope';
import {
    CandidateVisualReviewSchema,
    deriveCandidateVisualIntegrityBasis,
    deriveCandidateVisualSymptomBasis,
    deriveCandidateVisualVerdict,
    type CandidateVisualReviewModelOutput,
} from '../../src/types/candidate-visual-review';
import type { NetworkRequestEntry } from '../../src/browser/browser-interfaces';
import type { ResolvedCandidateVisualEvidence } from '../../src/validator/candidate-evidence-resolver';
import type {
    AdapterPhaseLease,
    BoundEnvironmentPhaseHandle,
    EnvironmentPhaseEvidence,
    EnvironmentPhaseToken,
    FilteringEnvironmentAdapter,
    FilteringEnvironmentAdapterState,
    ValidatorPhaseCompletion,
} from '../../src/environment/filtering-environment';
import { BlockerVerificationMethod } from '../../src/environment/environment-proofs';
import type { NormalizedSafeInteractionPlan } from '../../src/environment/safe-interaction';
import {
    MAX_DOM_CHECK_RESULT_BYTES,
    type DomCheck,
    type DomCheckRecord,
} from '../../src/types/dom-check';
import {
    ageDialogRevealPlan,
    fakeInteractionSession,
    type InteractionPhaseScript,
} from './interaction-session-fixture';

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { force: true, recursive: true });
    }
});

const PROFILE: ReproProfile = {
    viewport: 'desktop',
    locale: 'en-US',
    timezone: 'UTC',
    userAgentProfile: 'Chrome',
    consentStrategy: 'untouched',
};

/**
 * One event the recorder stub kept.
 */
interface RecordedTraceEvent {
    /**
     * The event type.
     */
    type: string;

    /**
     * The event payload.
     */
    payload: Record<string, unknown>;
}

/**
 * Minimal recorder: the artifact registry environment artifact resolution reads, and the events.
 *
 * @param events - Where recorded events are kept.
 * @returns Recorder stub holding registered artifacts.
 */
function recorderStub(events: RecordedTraceEvent[] = []): TraceRecorder {
    const artifacts: Array<{ id: string; path: string; type: string; bytes: number }> = [];
    return {
        addArtifact: (artifact: { id: string; path: string; type: string; bytes: number }) => {
            artifacts.push(artifact);
        },
        getArtifacts: () => artifacts,
        record: (type: string, payload: Record<string, unknown> = {}) => {
            events.push({ type, payload });
        },
    } as unknown as TraceRecorder;
}

describe('BrowserExtensionAdsObserver', () => {
    it('reports a page the phase browser could not load as a navigation failure', async () => {
        const artifactsDir = mkdtempSync(join(tmpdir(), 'ads-observer-navigation-'));
        roots.push(artifactsDir);
        const session = {
            artifactsDir,
            isClosed: false,
            getPage: () => ({}) as Page,
            close: async () => undefined,
            getNetworkLog: () => [],
            resetNetworkLog: () => undefined,
            getConsoleLog: () => [],
            consoleCoverage: ConsoleCoverage.BrowserLogOnly,
        } as unknown as IBrowserSession;
        const observer = new BrowserExtensionAdsObserver({
            candidateRule: 'example.test##.ad',
            trustedValidationContext: {
                reportedUrl: 'https://example.test/',
                existingRules: [],
                baselineHash: 'b'.repeat(64),
            },
            profile: PROFILE,
            recorder: recorderStub(),
            artifactsDir,
            logger: pino({ level: 'silent' }),
            vision: visionStub,
            reporterSymptom: 'an ad banner',
            attemptNumber: 1,
            noSandbox: false,
            dependencies: {
                runPhase: async () => ({
                    phase: 'A' as const,
                    url: 'https://example.test/',
                    screenshotArtifactId: '',
                    harArtifactId: '',
                    domArtifactId: '',
                    appliedRules: [],
                    ruleApplications: [],
                    antiAdblockDetected: false,
                    error: 'main document returned HTTP 403',
                    navigationFallbackReason: BrowserFallbackReason.HttpBlocked,
                }),
            },
        });

        const completion = await observer.observe({
            phase: 'A',
            phaseTokenId: 'token-a',
            session,
            proof: {
                leaseId: 'lease-a',
                adapterStateDigest: 'a'.repeat(64),
                phase: 'A',
                filteringState: 'disabled',
                sessionId: 'session-a',
                actualContext: {
                    kind: 'browser_extension',
                    product: 'AdGuard Browser Extension',
                    browser: 'CloakBrowser Chromium',
                    productVersion: '5.0.0',
                },
                baselineDigest: null,
                candidateDigest: null,
                extension: null,
            },
        });

        expect(completion).toMatchObject({
            kind: 'failed',
            limitation: {
                code: EnvironmentAdapterLimitationCode.PhaseNavigationFailed,
                detail: expect.stringContaining('HTTP 403'),
            },
            navigationFallbackReason: BrowserFallbackReason.HttpBlocked,
        });
    });
    it('hands every phase a lazy-content pass to run before its captures', async () => {
        const artifactsDir = mkdtempSync(join(tmpdir(), 'ads-observer-materialize-'));
        roots.push(artifactsDir);
        const phaseConfigs: Parameters<typeof runPhase>[0][] = [];
        const session = {
            artifactsDir,
            isClosed: false,
            getPage: () => ({}) as Page,
            close: async () => undefined,
            getNetworkLog: () => [],
            resetNetworkLog: () => undefined,
            getConsoleLog: () => [],
            consoleCoverage: ConsoleCoverage.BrowserLogOnly,
        } as unknown as IBrowserSession;
        const observer = new BrowserExtensionAdsObserver({
            candidateRule: 'example.test##.ad',
            trustedValidationContext: {
                reportedUrl: 'https://example.test/',
                existingRules: [],
                baselineHash: 'b'.repeat(64),
            },
            profile: PROFILE,
            recorder: recorderStub(),
            artifactsDir,
            logger: pino({ level: 'silent' }),
            vision: visionStub,
            reporterSymptom: 'an ad banner',
            attemptNumber: 1,
            noSandbox: false,
            dependencies: {
                runPhase: async (_input, config) => {
                    phaseConfigs.push(config);
                    return {
                        phase: 'A' as const,
                        url: 'https://example.test/',
                        screenshotArtifactId: '',
                        harArtifactId: '',
                        domArtifactId: '',
                        appliedRules: [],
                        ruleApplications: [],
                        antiAdblockDetected: false,
                        error: 'main document returned HTTP 403',
                        navigationFallbackReason: BrowserFallbackReason.HttpBlocked,
                    };
                },
            },
        });

        const completion = await observer.observe({
            phase: 'A',
            phaseTokenId: 'token-a',
            session,
            proof: {
                leaseId: 'lease-a',
                adapterStateDigest: 'a'.repeat(64),
                phase: 'A',
                filteringState: 'disabled',
                sessionId: 'session-a',
                actualContext: {
                    kind: 'browser_extension',
                    product: 'AdGuard Browser Extension',
                    browser: 'CloakBrowser Chromium',
                    productVersion: '5.0.0',
                },
                baselineDigest: null,
                candidateDigest: null,
                extension: null,
            },
        });

        // Without the pass the phases are captured wherever the site's lazy loading happened to be.
        expect(completion.kind).toBe('failed');
        expect(phaseConfigs).toHaveLength(1);
        expect(phaseConfigs[0]!.materialize).toBeTypeOf('function');
        await expect(phaseConfigs[0]!.materialize!()).resolves.toHaveProperty('settled');
    });

    it.each([
        { rule: '||example.test/ads/banner.js^', fromTop: true },
        { rule: '||ads.example.org^', fromTop: false },
        { rule: 'example.test##.ad', fromTop: false },
    ])('asks for a window from the top of the page for $rule: $fromTop', async (row) => {
        // A block of the reported site's own requests can break the page away from its ad, so its
        // capture takes in the first screens too; a third-party host block and a cosmetic rule
        // keep the window around their target.
        const artifactsDir = mkdtempSync(join(tmpdir(), 'ads-observer-window-top-'));
        roots.push(artifactsDir);
        const phaseConfigs: Parameters<typeof runPhase>[0][] = [];
        const session = {
            artifactsDir,
            isClosed: false,
            getPage: () => ({}) as Page,
            close: async () => undefined,
            getNetworkLog: () => [],
            resetNetworkLog: () => undefined,
            getConsoleLog: () => [],
            consoleCoverage: ConsoleCoverage.BrowserLogOnly,
        } as unknown as IBrowserSession;
        const observer = new BrowserExtensionAdsObserver({
            candidateRule: row.rule,
            adElementSelector: '.ad',
            trustedValidationContext: {
                reportedUrl: 'https://example.test/',
                existingRules: [],
                baselineHash: 'b'.repeat(64),
            },
            profile: PROFILE,
            recorder: recorderStub(),
            artifactsDir,
            logger: pino({ level: 'silent' }),
            vision: visionStub,
            reporterSymptom: 'an ad banner',
            attemptNumber: 1,
            noSandbox: false,
            dependencies: {
                runPhase: async (_input, config) => {
                    phaseConfigs.push(config);
                    return {
                        phase: 'A' as const,
                        url: 'https://example.test/',
                        screenshotArtifactId: '',
                        harArtifactId: '',
                        domArtifactId: '',
                        appliedRules: [],
                        ruleApplications: [],
                        antiAdblockDetected: false,
                        error: 'stop after config capture',
                    };
                },
            },
        });

        await observer.observe({
            phase: 'A',
            phaseTokenId: 'token-a',
            session,
            proof: {
                leaseId: 'lease-a',
                adapterStateDigest: 'a'.repeat(64),
                phase: 'A',
                filteringState: 'disabled',
                sessionId: 'session-a',
                actualContext: {
                    kind: 'browser_extension',
                    product: 'AdGuard Browser Extension',
                    browser: 'CloakBrowser Chromium',
                    productVersion: '5.0.0',
                },
                baselineDigest: null,
                candidateDigest: null,
                extension: null,
            },
        });

        expect(phaseConfigs).toHaveLength(1);
        expect(phaseConfigs[0]!.tileWindowFromTop === true).toBe(row.fromTop);
    });

    it('hands the inventory a capture carrying all three screenshot identities', async () => {
        const artifactsDir = mkdtempSync(join(tmpdir(), 'ads-observer-'));
        roots.push(artifactsDir);
        const recorder = recorderStub();
        const captures: unknown[] = [];
        const session = {
            artifactsDir,
            isClosed: false,
            getPage: () => ({}) as Page,
            close: async () => undefined,
            getNetworkLog: () => [],
            resetNetworkLog: () => undefined,
            getConsoleLog: () => [],
            consoleCoverage: ConsoleCoverage.BrowserLogOnly,
        } as unknown as IBrowserSession;
        const observer = new BrowserExtensionAdsObserver({
            candidateRule: 'example.test##.ad',
            trustedValidationContext: {
                reportedUrl: 'https://example.test/',
                existingRules: [],
                baselineHash: 'b'.repeat(64),
            },
            profile: PROFILE,
            recorder,
            artifactsDir,
            logger: pino({ level: 'silent' }),
            vision: visionStub,
            reporterSymptom: 'an ad banner',
            attemptNumber: 1,
            noSandbox: false,
            dependencies: {
                runPhase: async () => {
                    for (const id of ['shot-a', 'full-a', 'tile-a', 'har-a', 'dom-a']) {
                        recorder.addArtifact({
                            id,
                            path: join(artifactsDir, `${id}.bin`),
                            type: 'application/octet-stream',
                            bytes: 1,
                        });
                    }
                    return {
                        phase: 'A' as const,
                        url: 'https://example.test/',
                        screenshotArtifactId: 'shot-a',
                        fullPageScreenshotArtifactId: 'full-a',
                        tileCoverage: {
                            complete: true,
                            documentWidth: 1_000,
                            documentHeight: 1_000,
                            viewportWidth: 1_000,
                            viewportHeight: 1_000,
                            overlapPx: 0,
                            tiles: [
                                {
                                    artifactId: 'tile-a',
                                    index: 0,
                                    x: 0,
                                    y: 0,
                                    width: 1_000,
                                    height: 1_000,
                                    landmark: 'Article body',
                                },
                            ],
                        },
                        harArtifactId: 'har-a',
                        domArtifactId: 'dom-a',
                        appliedRules: [],
                        ruleApplications: [],
                        antiAdblockDetected: false,
                    };
                },
                probeStructuralSnapshot: async () => ({}) as StructuralSnapshot,
                inspectFullPageVisualCapture: async (_input, options, capture) => {
                    captures.push(capture);
                    const artifactId = 'inventory-a';
                    options.recorder.addArtifact({
                        id: artifactId,
                        path: join(artifactsDir, `${artifactId}.json`),
                        type: 'application/json',
                        bytes: 2,
                    });
                    return {
                        inventory: {
                            reporterSymptomPresence: 'present',
                        } as FullPageVisualCaptureResult['inventory'],
                        artifactId,
                        artifactPath: join(artifactsDir, `${artifactId}.json`),
                        coverageComplete: true,
                        inspectedArtifactIds: [],
                        missingArtifactIds: [],
                        batchFailures: [],
                    };
                },
            },
        });

        const completion = await observer.observe({
            phase: 'A',
            phaseTokenId: 'token-a',
            session,
            proof: {
                leaseId: 'lease-a',
                adapterStateDigest: 'a'.repeat(64),
                phase: 'A',
                filteringState: 'disabled',
                sessionId: 'session-a',
                actualContext: {
                    kind: 'browser_extension',
                    product: 'AdGuard Browser Extension',
                    browser: 'CloakBrowser Chromium',
                    productVersion: '5.0.0',
                },
                baselineDigest: null,
                candidateDigest: null,
                extension: null,
            },
        });

        expect(completion.kind).toBe('observed');
        // The inventory contract requires the viewport identity too; a capture without it fails
        // the whole phase observation at the schema before any vision call.
        expect(captures).toEqual([
            {
                artifactId: 'shot-a',
                fullPageArtifactId: 'full-a',
                tileCoverage: expect.objectContaining({
                    tiles: [expect.objectContaining({ artifactId: 'tile-a' })],
                }),
            },
        ]);
    });

    it('leaves a selector-less breakage candidate to vision instead of probing the document', async () => {
        const artifactsDir = mkdtempSync(join(tmpdir(), 'ads-observer-networkfp-'));
        roots.push(artifactsDir);
        const session = {
            artifactsDir,
            isClosed: false,
            getPage: () => ({}) as Page,
            close: async () => undefined,
            getNetworkLog: () => [],
            resetNetworkLog: () => undefined,
            getConsoleLog: () => [],
            consoleCoverage: ConsoleCoverage.BrowserLogOnly,
        } as unknown as IBrowserSession;
        const recorder = recorderStub();
        // A network exception names no element, so the probe falls back to `body`: its presence
        // proves nothing about the content the reporter lost, and letting it decide would make
        // every network false positive unprovable.
        const observer = new BrowserExtensionAdsObserver({
            candidateRule: '@@||cdn.example.test^$domain=example.test',
            trustedValidationContext: {
                reportedUrl: 'https://example.test/',
                existingRules: [],
                baselineHash: 'b'.repeat(64),
            },
            profile: PROFILE,
            recorder,
            artifactsDir,
            logger: pino({ level: 'silent' }),
            vision: visionStub,
            reporterSymptom: 'the video player never loads',
            symptomKind: 'incorrect_blocking',
            attemptNumber: 1,
            noSandbox: false,
            dependencies: {
                runPhase: async () => {
                    for (const id of ['shot-a', 'full-a', 'tile-a', 'har-a', 'dom-a']) {
                        recorder.addArtifact({
                            id,
                            path: join(artifactsDir, `${id}.bin`),
                            type: 'application/octet-stream',
                            bytes: 1,
                        });
                    }
                    return {
                        phase: 'A' as const,
                        url: 'https://example.test/',
                        screenshotArtifactId: 'shot-a',
                        fullPageScreenshotArtifactId: 'full-a',
                        tileCoverage: {
                            complete: true,
                            documentWidth: 1_000,
                            documentHeight: 1_000,
                            viewportWidth: 1_000,
                            viewportHeight: 1_000,
                            overlapPx: 0,
                            tiles: [
                                {
                                    artifactId: 'tile-a',
                                    index: 0,
                                    x: 0,
                                    y: 0,
                                    width: 1_000,
                                    height: 1_000,
                                    landmark: 'Player region',
                                },
                            ],
                        },
                        harArtifactId: 'har-a',
                        domArtifactId: 'dom-a',
                        appliedRules: [],
                        ruleApplications: [],
                        antiAdblockDetected: false,
                    };
                },
                // `body` always renders, so an absolute reading would report a healthy page.
                probeStructuralSnapshot: async () =>
                    ({
                        probeSucceeded: true,
                        targetCount: 1,
                        targetVisibleCount: 1,
                    }) as StructuralSnapshot,
                inspectFullPageVisualCapture: async (_input, options) => {
                    const artifactId = 'inventory-a';
                    options.recorder.addArtifact({
                        id: artifactId,
                        path: join(artifactsDir, `${artifactId}.json`),
                        type: 'application/json',
                        bytes: 2,
                    });
                    return {
                        inventory: {
                            reporterSymptomPresence: 'present',
                        } as FullPageVisualCaptureResult['inventory'],
                        artifactId,
                        artifactPath: join(artifactsDir, `${artifactId}.json`),
                        coverageComplete: true,
                        inspectedArtifactIds: [],
                        missingArtifactIds: [],
                        batchFailures: [],
                    };
                },
            },
        });

        const completion = await observer.observe({
            phase: 'A',
            phaseTokenId: 'token-a',
            session,
            proof: {
                leaseId: 'lease-a',
                adapterStateDigest: 'a'.repeat(64),
                phase: 'A',
                filteringState: 'disabled',
                sessionId: 'session-a',
                actualContext: {
                    kind: 'browser_extension',
                    product: 'AdGuard Browser Extension',
                    browser: 'CloakBrowser Chromium',
                    productVersion: '5.0.0',
                },
                baselineDigest: null,
                candidateDigest: null,
                extension: null,
            },
        });

        expect(completion).toMatchObject({ targetObservation: { symptomPresent: true } });
    });

    /**
     * Build an observer for an incorrect-blocking candidate whose bound element renders the given
     * number of its five matches per phase.
     *
     * @param visibleByPhase - Visible matches the structural probe reports in each phase.
     * @param candidate - Candidate rule and, for a network rule, the element it is about.
     * @param visionByPhase - What vision reads of the defect in each phase. By default it calls the
     *   defect present in every phase: vision inverts absence symptoms, recognising the element the
     *   reporter named.
     * @returns The observer and a function observing one of its phases.
     */
    function breakageObserver(
        visibleByPhase: Record<string, number>,
        candidate: { candidateRule: string; adElementSelector?: string } = {
            candidateRule: 'example.test#@#.ad-sidebar',
        },
        visionByPhase: Record<string, ReporterSymptomPresence> = {
            [PhaseLabel.A]: ReporterSymptomPresence.Present,
            [PhaseLabel.B]: ReporterSymptomPresence.Present,
        },
    ) {
        const artifactsDir = mkdtempSync(join(tmpdir(), 'ads-observer-breakage-'));
        roots.push(artifactsDir);
        const recorder = recorderStub();
        const session = {
            artifactsDir,
            isClosed: false,
            getPage: () => ({}) as Page,
            close: async () => undefined,
            getNetworkLog: () => [],
            resetNetworkLog: () => undefined,
            getConsoleLog: () => [],
            consoleCoverage: ConsoleCoverage.BrowserLogOnly,
        } as unknown as IBrowserSession;
        let probedPhase: 'A' | 'B' | 'C' = 'A';
        const observer = new BrowserExtensionAdsObserver({
            ...candidate,
            trustedValidationContext: {
                reportedUrl: 'https://example.test/',
                existingRules: [],
                baselineHash: 'b'.repeat(64),
            },
            profile: PROFILE,
            recorder,
            artifactsDir,
            logger: pino({ level: 'silent' }),
            vision: visionStub,
            reporterSymptom: 'the left navigation rail is missing',
            symptomKind: 'incorrect_blocking',
            attemptNumber: 1,
            noSandbox: false,
            dependencies: {
                runPhase: async (input) => {
                    probedPhase = input.phase;
                    const suffix = input.phase.toLowerCase();
                    for (const kind of ['shot', 'full', 'tile', 'har', 'dom']) {
                        recorder.addArtifact({
                            id: `${kind}-${suffix}`,
                            path: join(artifactsDir, `${kind}-${suffix}.bin`),
                            type: 'application/octet-stream',
                            bytes: 1,
                        });
                    }
                    return {
                        phase: input.phase,
                        url: 'https://example.test/',
                        screenshotArtifactId: `shot-${suffix}`,
                        fullPageScreenshotArtifactId: `full-${suffix}`,
                        tileCoverage: {
                            complete: true,
                            documentWidth: 1_000,
                            documentHeight: 1_000,
                            viewportWidth: 1_000,
                            viewportHeight: 1_000,
                            overlapPx: 0,
                            tiles: [
                                {
                                    artifactId: `tile-${suffix}`,
                                    index: 0,
                                    x: 0,
                                    y: 0,
                                    width: 1_000,
                                    height: 1_000,
                                    landmark: 'Article body',
                                },
                            ],
                        },
                        harArtifactId: `har-${suffix}`,
                        domArtifactId: `dom-${suffix}`,
                        appliedRules: [],
                        ruleApplications: [],
                        antiAdblockDetected: false,
                    };
                },
                probeStructuralSnapshot: async () =>
                    ({
                        probeSucceeded: true,
                        targetCount: 5,
                        targetVisibleCount: visibleByPhase[probedPhase]!,
                    }) as StructuralSnapshot,
                inspectFullPageVisualCapture: async (input, options) => {
                    const artifactId = `inventory-${input.phase.toLowerCase()}`;
                    options.recorder.addArtifact({
                        id: artifactId,
                        path: join(artifactsDir, `${artifactId}.json`),
                        type: 'application/json',
                        bytes: 2,
                    });
                    return {
                        inventory: {
                            reporterSymptomPresence: visionByPhase[input.phase]!,
                        } as FullPageVisualCaptureResult['inventory'],
                        artifactId,
                        artifactPath: join(artifactsDir, `${artifactId}.json`),
                        coverageComplete: true,
                        inspectedArtifactIds: [],
                        missingArtifactIds: [],
                        batchFailures: [],
                    };
                },
            },
        });

        /**
         * Observe one phase of the shared experiment.
         *
         * @param phase - Phase to observe.
         * @returns The recorded phase completion.
         */
        const observe = (phase: 'A' | 'B') =>
            observer.observe({
                phase,
                phaseTokenId: `token-${phase}`,
                session,
                proof: {
                    leaseId: `lease-${phase}`,
                    adapterStateDigest: 'a'.repeat(64),
                    phase,
                    filteringState: phase === 'A' ? 'disabled' : 'published_baseline',
                    sessionId: `session-${phase}`,
                    actualContext: {
                        kind: 'browser_extension',
                        product: 'AdGuard Browser Extension',
                        browser: 'CloakBrowser Chromium',
                        productVersion: '5.0.0',
                    },
                    baselineDigest: phase === 'A' ? null : 'b'.repeat(64),
                    candidateDigest: null,
                    extension: null,
                },
            });

        return { observer, observe };
    }

    it('reads a breakage symptom from the probed element relative to the unfiltered control', async () => {
        // The site itself hides two of the five matches in every phase; only the three the
        // unfiltered control renders are content the candidate must restore.
        const { observer, observe } = breakageObserver({ A: 3, B: 0, C: 3 });

        const control = await observe('A');
        const baseline = await observe('B');

        // The control defines the healthy count, so its own partially hidden matches are not a
        // defect; the baseline rendering fewer of them is.
        expect(control).toMatchObject({ targetObservation: { symptomPresent: false } });
        expect(baseline).toMatchObject({ targetObservation: { symptomPresent: true } });
        expect(observer.baselineVisionOverruledSelector()).toBeNull();
    });

    it.each([
        {
            candidate: { candidateRule: 'example.test#@#.ad-sidebar' },
            expected: { selector: '.ad-sidebar', source: SelectorSource.Rule },
        },
        {
            candidate: {
                candidateRule: '@@||player.example.org^$domain=example.test',
                adElementSelector: 'iframe.player',
            },
            expected: { selector: 'iframe.player', source: SelectorSource.AdElementSelector },
        },
    ])(
        'names the selector whose geometry called a broken baseline healthy: $expected.source',
        async ({ candidate, expected }) => {
            // okteve.com: the anti-adblock wall drew inside an embedded player the selector named,
            // and the player stayed as visible as on the unfiltered page.
            const { observer, observe } = breakageObserver({ A: 3, B: 3, C: 3 }, candidate);

            await observe('A');
            const baseline = await observe('B');

            expect(baseline).toMatchObject({ targetObservation: { symptomPresent: false } });
            expect(observer.baselineVisionOverruledSelector()).toEqual(expected);
        },
    );

    it('reads a breakage symptom vision separates from the control even when the element renders', async () => {
        // An anti-adblock wall drawn inside a player iframe: the iframe renders in both phases,
        // and only vision sees the wall that filtering brought.
        const { observer, observe } = breakageObserver(
            { [PhaseLabel.A]: 3, [PhaseLabel.B]: 3, [PhaseLabel.C]: 3 },
            { candidateRule: 'example.test#@#.ad-sidebar' },
            {
                [PhaseLabel.A]: ReporterSymptomPresence.Absent,
                [PhaseLabel.B]: ReporterSymptomPresence.Present,
            },
        );

        const control = await observe(PhaseLabel.A);
        const baseline = await observe(PhaseLabel.B);

        expect(control).toMatchObject({ targetObservation: { symptomPresent: false } });
        expect(baseline).toMatchObject({ targetObservation: { symptomPresent: true } });
        expect(observer.baselineVisionOverruledSelector()).toBeNull();
    });

    it('bounds phase C tile capture to the window measured while the symptom was visible', async () => {
        const artifactsDir = mkdtempSync(join(tmpdir(), 'ads-observer-window-'));
        roots.push(artifactsDir);
        const recorder = recorderStub();
        const phaseConfigs: Array<Record<string, unknown>> = [];
        const session = {
            artifactsDir,
            isClosed: false,
            getPage: () => ({}) as Page,
            close: async () => undefined,
            getNetworkLog: () => [],
            resetNetworkLog: () => undefined,
            getConsoleLog: () => [],
            consoleCoverage: ConsoleCoverage.BrowserLogOnly,
        } as unknown as IBrowserSession;
        const windowByPhase = {
            A: { fromY: 100, toY: 600 },
            B: { fromY: 200, toY: 700 },
        } as const;
        const observer = new BrowserExtensionAdsObserver({
            candidateRule: 'example.test##.ad',
            trustedValidationContext: {
                reportedUrl: 'https://example.test/',
                existingRules: [],
                baselineHash: 'b'.repeat(64),
            },
            profile: PROFILE,
            recorder,
            artifactsDir,
            logger: pino({ level: 'silent' }),
            vision: visionStub,
            reporterSymptom: 'an ad banner',
            attemptNumber: 1,
            noSandbox: false,
            dependencies: {
                runPhase: async (input, phaseConfig) => {
                    phaseConfigs.push(phaseConfig as unknown as Record<string, unknown>);
                    const phase = input.phase;
                    if (phase === 'C') {
                        return {
                            phase: 'C' as const,
                            url: 'https://example.test/',
                            screenshotArtifactId: '',
                            harArtifactId: '',
                            domArtifactId: '',
                            appliedRules: [],
                            ruleApplications: [],
                            antiAdblockDetected: false,
                            error: 'stop after config capture',
                        };
                    }
                    const window = windowByPhase[phase];
                    for (const id of [
                        `shot-${phase}`,
                        `full-${phase}`,
                        `tile-${phase}`,
                        `har-${phase}`,
                        `dom-${phase}`,
                    ]) {
                        recorder.addArtifact({
                            id,
                            path: join(artifactsDir, `${id}.bin`),
                            type: 'application/octet-stream',
                            bytes: 1,
                        });
                    }
                    return {
                        phase,
                        url: 'https://example.test/',
                        screenshotArtifactId: `shot-${phase}`,
                        fullPageScreenshotArtifactId: `full-${phase}`,
                        tileCoverage: {
                            complete: true,
                            documentWidth: 1_000,
                            documentHeight: 9_000,
                            viewportWidth: 1_000,
                            viewportHeight: 1_000,
                            overlapPx: 0,
                            window,
                            tiles: [
                                {
                                    artifactId: `tile-${phase}`,
                                    index: 0,
                                    x: 0,
                                    y: window.fromY,
                                    width: 1_000,
                                    height: 1_000,
                                    landmark: 'Article body',
                                },
                            ],
                        },
                        harArtifactId: `har-${phase}`,
                        domArtifactId: `dom-${phase}`,
                        appliedRules: [],
                        ruleApplications: [],
                        antiAdblockDetected: false,
                    };
                },
                probeStructuralSnapshot: async () => ({}) as StructuralSnapshot,
                inspectFullPageVisualCapture: async (_input, options) => {
                    const artifactId = `inventory-${options.recorder.getArtifacts().length}`;
                    options.recorder.addArtifact({
                        id: artifactId,
                        path: join(artifactsDir, `${artifactId}.json`),
                        type: 'application/json',
                        bytes: 2,
                    });
                    return {
                        inventory: {
                            reporterSymptomPresence: 'present',
                        } as FullPageVisualCaptureResult['inventory'],
                        artifactId,
                        artifactPath: join(artifactsDir, `${artifactId}.json`),
                        coverageComplete: true,
                        inspectedArtifactIds: [],
                        missingArtifactIds: [],
                        batchFailures: [],
                    };
                },
            },
        });
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- Scenario-local fixture.
        const proof = (phase: 'A' | 'B' | 'C') => ({
            leaseId: `lease-${phase}`,
            adapterStateDigest: 'a'.repeat(64),
            phase,
            filteringState: 'disabled' as const,
            sessionId: `session-${phase}`,
            actualContext: {
                kind: 'browser_extension' as const,
                product: 'AdGuard Browser Extension',
                browser: 'CloakBrowser Chromium',
                productVersion: '5.0.0',
            },
            baselineDigest: null,
            candidateDigest: null,
            extension: null,
        });

        await observer.observe({ phase: 'A', phaseTokenId: 'token-a', session, proof: proof('A') });
        await observer.observe({ phase: 'B', phaseTokenId: 'token-b', session, proof: proof('B') });
        const completionC = await observer.observe({
            phase: 'C',
            phaseTokenId: 'token-c',
            session,
            proof: proof('C'),
        });

        expect(completionC.kind).toBe('failed');
        expect(phaseConfigs[0]).not.toHaveProperty('tileWindow');
        expect(phaseConfigs[1]).not.toHaveProperty('tileWindow');
        // Phase C cannot measure its own window (the candidate hides the element), so the latest
        // visible-state measurement — phase B's — bounds its capture for B/C comparability.
        expect(phaseConfigs[2]?.['tileWindow']).toEqual({ fromY: 200, toY: 700 });
    });
});

/**
 * The reported page of a live benchmark run, whose network candidate's review returned
 * `pageIntegrity: unclear` because images cannot exercise first-party interactive functions.
 */
const REPORTED_URL = 'https://www.sarkisozleri.bbs.tr/85';

/**
 * What the reviewer said about that candidate: the symptom gone, nothing left, nothing damaged, and
 * a page integrity it could not call intact.
 */
const CLEAN_UNCLEAR_OUTPUT: CandidateVisualReviewModelOutput = {
    symptom: 'resolved',
    symptomScope: 'Every injected advertising banner on the lyrics page.',
    adLayoutResidue: 'absent',
    coverageComplete: true,
    beforeInstances: [
        {
            artifactId: 'shot-b',
            landmark: 'Above the lyrics body.',
            description: 'An injected advertising banner.',
        },
    ],
    remainingInstances: [],
    pageIntegrity: 'unclear',
    rationale: 'The banners are gone; images cannot prove first-party functions still work.',
    observedDamage: [],
};

/**
 * The same review once it could call the page intact: it verifies the candidate.
 */
const CLEAN_INTACT_OUTPUT: CandidateVisualReviewModelOutput = {
    ...CLEAN_UNCLEAR_OUTPUT,
    pageIntegrity: 'intact',
};

/**
 * Filtering state each phase of the additive experiment is opened in.
 *
 * @param phase - Phase being opened.
 * @returns The adapter filtering state for that phase.
 */
function filteringStateFor(phase: 'A' | 'B' | 'C') {
    if (phase === 'A') {
        return 'disabled' as const;
    }
    return phase === 'B'
        ? ('published_baseline' as const)
        : ('published_baseline_plus_candidate' as const);
}

/**
 * The fixture leaves of one experiment: what vision reported per phase, what the phase network logs
 * recorded, and what the reviewer said about the candidate.
 */
interface ExtensionExperimentOptions {
    /**
     * Vision's presence of the reporter symptom in each baseline phase; present when omitted. The
     * candidate phase has no single-image inventory: the paired review judges it.
     */
    symptomPresence?: (phase: 'A' | 'B') => 'present' | 'absent';

    /**
     * The phase network logs; empty when omitted.
     */
    networkLog?: (phase: 'A' | 'B' | 'C') => NetworkRequestEntry[];

    /**
     * The reviewer's observations; the clean unclear output when omitted.
     */
    modelOutput?: CandidateVisualReviewModelOutput;

    /**
     * Whether the structural probe could measure the page; it can when omitted.
     */
    probeSucceeded?: boolean;

    /**
     * How many elements the structural probe matches in each phase; one when omitted.
     */
    targetCount?: (phase: 'A' | 'B' | 'C') => number;

    /**
     * Matches of the candidate's selector the probe finds rendered in each phase; one when omitted.
     */
    visibleMatches?: (phase: PhaseLabel) => number;

    /**
     * The problem class the run judges; advertising when omitted.
     */
    symptomKind?: SymptomKind;

    /**
     * Reveal steps apply_rule received, with how each phase's page answers them; none when omitted.
     */
    reveal?: {
        plan: NormalizedSafeInteractionPlan;
        scripts: Partial<Record<'A' | 'B' | 'C', InteractionPhaseScript>>;
    };

    /**
     * DOM checks apply_rule received, with what each phase's page answers to an expression; none
     * when omitted.
     */
    domChecks?: {
        checks: DomCheck[];
        answer: (phase: 'A' | 'B' | 'C', expression: string) => unknown;
    };

    /**
     * Collects what the observer handed its seams and the model, for assertions; ignored when
     * omitted.
     */
    seen?: ExperimentSeams;

    /**
     * Whether the browser captured a full-page overview in every phase; it did when omitted.
     */
    overviewCaptured?: boolean;

    /**
     * What the mouse wheel did to each phase's page; unmeasured when omitted.
     */
    pageScroll?: (phase: PhaseLabel) => PageScrollMeasurement | null;
}

/**
 * What one fixture experiment's observer handed its seams and returned to the model.
 */
interface ExperimentSeams {
    /**
     * Selector of every structural probe, in phase order.
     */
    probedSelectors: string[];

    /**
     * Phase of every single-image inventory, in the order it ran.
     */
    inventoryPhases: string[];

    /**
     * DOM checks the visual review received, when it ran.
     */
    reviewDomChecks?: readonly DomCheckRecord[];

    /**
     * The apply_rule answer the observer built in phase C.
     */
    applyRuleResult?: Record<string, unknown> | null;

    /**
     * Whether the paired candidate review ran.
     */
    reviewCalled?: boolean;

    /**
     * The hiding selector the observer reported as matching nothing on the baseline.
     */
    unmatchedBaselineSelector?: string | null;

    /**
     * Every event the experiment recorded in the run's trace.
     */
    traceEvents?: RecordedTraceEvent[];
}

/**
 * Run a complete A/B/C extension experiment through the production observer.
 *
 * Only the browser and vision leaves are fixtures: the phase runner, the structural probe, the
 * per-phase inventory, the evidence pairing, and the visual model. The observer's own
 * page-usability and candidate-verification decisions, and the experiment's verdict over them, are
 * the real ones.
 *
 * @param candidateRule - Exact candidate the experiment applies in phase C.
 * @returns The experiment result the run's outcome is read from.
 */
async function runExtensionExperiment(
    candidateRule: string,
    options: ExtensionExperimentOptions = {},
): Promise<Awaited<ReturnType<typeof runAdsEnvironmentExperiment>>> {
    const symptomPresence = options.symptomPresence ?? (() => 'present');
    const networkLog = options.networkLog ?? (() => []);
    const modelOutput = options.modelOutput ?? CLEAN_UNCLEAR_OUTPUT;
    const overviewCaptured = options.overviewCaptured ?? true;
    const artifactsDir = mkdtempSync(join(tmpdir(), 'ads-observer-experiment-'));
    roots.push(artifactsDir);
    const recorder = recorderStub(options.seen?.traceEvents);
    const candidateDigest = createHash('sha256').update(candidateRule).digest('hex');
    const actualContext = {
        kind: 'browser_extension' as const,
        product: 'AdGuard Browser Extension',
        browser: 'CloakBrowser Chromium',
        productVersion: '5.0.0',
    };
    const session = {
        artifactsDir,
        isClosed: false,
        getPage: () => ({}) as Page,
        close: async () => undefined,
        getNetworkLog: () => [],
        resetNetworkLog: () => undefined,
        getConsoleLog: () => [],
        consoleCoverage: ConsoleCoverage.BrowserLogOnly,
    } as unknown as IBrowserSession;
    const observer = new BrowserExtensionAdsObserver({
        candidateRule,
        trustedValidationContext: {
            reportedUrl: REPORTED_URL,
            existingRules: [],
            baselineHash: 'b'.repeat(64),
        },
        profile: PROFILE,
        recorder,
        artifactsDir,
        logger: pino({ level: 'silent' }),
        vision: visionStub,
        reporterSymptom: 'injected advertising banners above the lyrics',
        ...(options.symptomKind ? { symptomKind: options.symptomKind } : {}),
        attemptNumber: 1,
        noSandbox: false,
        ...(options.reveal ? { interactionPlan: options.reveal.plan } : {}),
        ...(options.domChecks ? { domChecks: options.domChecks.checks } : {}),
        dependencies: {
            runPhase: async (input, phaseConfig) => {
                await phaseConfig.interact?.();
                const suffix = input.phase.toLowerCase();
                const kinds = ['shot', ...(overviewCaptured ? ['full'] : []), 'tile', 'har', 'dom'];
                for (const kind of kinds) {
                    recorder.addArtifact({
                        id: `${kind}-${suffix}`,
                        path: join(artifactsDir, `${kind}-${suffix}.bin`),
                        type: 'application/octet-stream',
                        bytes: 1,
                    });
                }
                return {
                    phase: input.phase,
                    url: REPORTED_URL,
                    screenshotArtifactId: `shot-${suffix}`,
                    ...(overviewCaptured ? { fullPageScreenshotArtifactId: `full-${suffix}` } : {}),
                    tileCoverage: {
                        complete: true,
                        documentWidth: 1_000,
                        documentHeight: 1_000,
                        viewportWidth: 1_000,
                        viewportHeight: 1_000,
                        overlapPx: 0,
                        tiles: [
                            {
                                artifactId: `tile-${suffix}`,
                                index: 0,
                                x: 0,
                                y: 0,
                                width: 1_000,
                                height: 1_000,
                                landmark: 'Lyrics body',
                            },
                        ],
                    },
                    harArtifactId: `har-${suffix}`,
                    domArtifactId: `dom-${suffix}`,
                    appliedRules: input.phase === 'C' ? [candidateRule] : [],
                    ruleApplications: [],
                    antiAdblockDetected: false,
                };
            },
            measurePageScroll: async (input) => options.pageScroll?.(input.phase) ?? null,
            probeStructuralSnapshot: async (input, _evaluator, selector) => {
                options.seen?.probedSelectors.push(selector);
                return {
                    probeSucceeded: options.probeSucceeded ?? true,
                    targetCount: options.targetCount?.(input.phase) ?? 1,
                    targetVisibleCount: options.visibleMatches?.(input.phase) ?? 1,
                } as StructuralSnapshot;
            },
            inspectFullPageVisualCapture: async (input, inventoryOptions) => {
                options.seen?.inventoryPhases.push(input.phase);
                if (input.phase === 'C') {
                    throw new Error('The paired review judges the candidate phase.');
                }
                const artifactId = `inventory-${input.phase.toLowerCase()}`;
                inventoryOptions.recorder.addArtifact({
                    id: artifactId,
                    path: join(artifactsDir, `${artifactId}.json`),
                    type: 'application/json',
                    bytes: 2,
                });
                return {
                    inventory: {
                        reporterSymptomPresence: symptomPresence(input.phase),
                    } as FullPageVisualCaptureResult['inventory'],
                    artifactId,
                    artifactPath: join(artifactsDir, `${artifactId}.json`),
                    coverageComplete: true,
                    inspectedArtifactIds: [],
                    missingArtifactIds: [],
                    batchFailures: [],
                };
            },
            readPhaseNetworkLog: (input) => networkLog(input.phase),
            // The observer only forwards the resolved pairing into the review; the parsed factual
            // record the real resolver also returns is never read on this path.
            resolveCandidateVisualEvidence: () =>
                ({
                    beforeViewport: { id: 'shot-b', path: join(artifactsDir, 'shot-b.bin') },
                    afterViewport: { id: 'shot-c', path: join(artifactsDir, 'shot-c.bin') },
                    ...(overviewCaptured
                        ? {
                              beforeFullPage: {
                                  id: 'full-b',
                                  path: join(artifactsDir, 'full-b.bin'),
                              },
                              afterFullPage: {
                                  id: 'full-c',
                                  path: join(artifactsDir, 'full-c.bin'),
                              },
                          }
                        : {}),
                    beforeTiles: [],
                    afterTiles: [],
                    beforeCoverageComplete: true,
                    afterCoverageComplete: true,
                }) as unknown as ResolvedCandidateVisualEvidence,
            reviewCandidateVisually: async (_input, reviewOptions) => {
                if (options.seen) {
                    options.seen.reviewCalled = true;
                    options.seen.reviewDomChecks = reviewOptions.domChecks;
                }
                // The scope, verdict and bases come from the production derivations, so this
                // fixture supplies the model's observations and nothing the runner owns.
                const scope = deriveCandidateNetworkScope(
                    reviewOptions.candidateRule,
                    REPORTED_URL,
                );
                const network = reviewOptions.networkVerification;
                const integrityBasis = deriveCandidateVisualIntegrityBasis(
                    modelOutput,
                    scope,
                    network,
                );
                const symptomBasis = deriveCandidateVisualSymptomBasis(modelOutput, scope, network);
                const review = v.parse(CandidateVisualReviewSchema, {
                    ...modelOutput,
                    verdict: deriveCandidateVisualVerdict(modelOutput, scope, network),
                    candidateNetworkScope: scope,
                    ...(integrityBasis === undefined ? {} : { integrityBasis }),
                    ...(network === undefined ? {} : { networkVerification: network }),
                    ...(symptomBasis === undefined ? {} : { symptomBasis }),
                    validationArtifactId: reviewOptions.validationArtifactId,
                    candidateRuleHash: candidateDigest,
                    beforeViewportArtifactId: 'shot-b',
                    afterViewportArtifactId: 'shot-c',
                    beforeFullPageArtifactId: reviewOptions.evidence.beforeFullPage?.id ?? null,
                    afterFullPageArtifactId: reviewOptions.evidence.afterFullPage?.id ?? null,
                    model: 'vision-stub',
                });
                const artifactId = 'visual-review-candidate';
                recorder.addArtifact({
                    id: artifactId,
                    path: join(artifactsDir, `${artifactId}.json`),
                    type: 'application/json',
                    bytes: 3,
                });
                return {
                    review,
                    artifactId,
                    artifactPath: join(artifactsDir, `${artifactId}.json`),
                };
            },
        },
    });

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
    const adapter: FilteringEnvironmentAdapter = {
        kind: 'browser_extension',
        capabilities: () => state.capabilities,
        prepare: async () => ({ ready: true, state }),
        openPhase: async (request) => ({
            ready: true,
            handle: {
                session: options.reveal
                    ? fakeInteractionSession(
                          options.reveal.scripts[request.phase],
                          new URL(REPORTED_URL).origin,
                      )
                    : options.domChecks
                      ? checkedSession(request.phase, options.domChecks.answer)
                      : session,
                adapterProof: {
                    leaseId: `lease-${request.phase}`,
                    adapterStateDigest: state.stateDigest,
                    phase: request.phase,
                    filteringState: filteringStateFor(request.phase),
                    sessionId: `session-${request.phase}`,
                    actualContext,
                    baselineDigest: request.phase === 'A' ? null : 'b'.repeat(64),
                    candidateDigest: request.phase === 'C' ? candidateDigest : null,
                    extension:
                        request.phase === 'A'
                            ? null
                            : {
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
                              },
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
    const executionRecorder = {
        beginPhase: (request: { phase: string }) => ({
            tokenId: `token-${request.phase}`,
            runId: 'run-1',
            experimentId: 'experiment-1',
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
            runId: 'run-1',
            experimentId: 'experiment-1',
            phase: token.phase as 'A' | 'B' | 'C',
            proof: {
                leaseId: `lease-${token.phase}`,
                adapterStateDigest: state.stateDigest,
                phase: token.phase as 'A' | 'B' | 'C',
                filteringState: filteringStateFor(token.phase as 'A' | 'B' | 'C'),
                sessionId: `session-${token.phase}`,
                actualContext,
                baselineDigest: token.phase === 'A' ? null : 'b'.repeat(64),
                candidateDigest: token.phase === 'C' ? candidateDigest : null,
                extension: null,
            },
            completion,
        }),
    };

    const experiment = await runAdsEnvironmentExperiment({
        runId: 'run-1',
        experimentId: 'experiment-1',
        adapter,
        recorder: executionRecorder,
        targetUrl: REPORTED_URL,
        candidate: { operation: 'add', rule: candidateRule },
        observe: async (input) => await observer.observe(input),
    });
    if (options.seen) {
        options.seen.applyRuleResult = observer.result();
        options.seen.unmatchedBaselineSelector = observer.unmatchedBaselineSelector();
    }
    return experiment;
}

/**
 * A phase session whose page answers evaluate_js expressions the way the fixture says.
 *
 * @param phase - Phase the session belongs to.
 * @param answer - What the page returns for an expression in that phase; a throw is a page error.
 * @returns The phase session.
 */
function checkedSession(
    phase: 'A' | 'B' | 'C',
    answer: (phase: 'A' | 'B' | 'C', expression: string) => unknown,
): IBrowserSession {
    return {
        artifactsDir: tmpdir(),
        isClosed: false,
        getPage: () =>
            ({
                evaluate: async (expression: string) => answer(phase, expression),
            }) as unknown as Page,
        close: async () => undefined,
        getNetworkLog: () => [],
        resetNetworkLog: () => undefined,
        getConsoleLog: () => [],
        consoleCoverage: ConsoleCoverage.BrowserLogOnly,
    } as unknown as IBrowserSession;
}

/**
 * One recorded script request.
 *
 * @param url - Request URL.
 * @param statusCode - Response status, 0 when the blocker stopped the request.
 * @returns The network log entry.
 */
function scriptRequest(url: string, statusCode = 200): NetworkRequestEntry {
    return {
        url,
        method: 'GET',
        resourceType: 'script',
        statusCode,
        requestHeaders: {},
        responseHeaders: {},
    };
}

describe('an extension experiment over a breakage the named element renders through', () => {
    /**
     * The paired review once the wall inside the player is gone from the candidate phase.
     */
    const wallGone: CandidateVisualReviewModelOutput = {
        ...CLEAN_UNCLEAR_OUTPUT,
        pageIntegrity: 'intact',
    };

    /**
     * The paired review while the candidate phase still shows the wall inside the player.
     */
    const wallStays: CandidateVisualReviewModelOutput = {
        ...wallGone,
        symptom: 'not_resolved',
        remainingInstances: [
            {
                artifactId: 'shot-c',
                landmark: 'Inside the player.',
                description: 'The anti-adblock wall still covers the player.',
            },
        ],
    };

    it.each([
        { review: 'wall gone', modelOutput: wallGone, verified: true },
        { review: 'wall stays', modelOutput: wallStays, verified: false },
    ])(
        'holds the candidate to the review, however the named element renders: $review',
        async ({ modelOutput, verified }) => {
            // A wall inside a player the selector names: the player renders in every phase but
            // the filtered baseline, so its geometry calls the candidate restored. The candidate
            // phase has no inventory of its own; the paired review seeing the wall still there
            // keeps the candidate unverified.
            const seen: ExperimentSeams = { probedSelectors: [], inventoryPhases: [] };
            const experiment = await runExtensionExperiment('sarkisozleri.bbs.tr#@#.player', {
                symptomKind: SymptomKind.Breakage,
                symptomPresence: (phase) =>
                    phase === PhaseLabel.A
                        ? ReporterSymptomPresence.Absent
                        : ReporterSymptomPresence.Present,
                visibleMatches: (phase) => (phase === PhaseLabel.B ? 0 : 1),
                modelOutput,
                seen,
            });

            expect(experiment.verdict === AdsEnvironmentExperimentVerdict.Verified).toBe(verified);
            expect(phaseCapture(experiment, 'C')).toMatchObject({
                reporterSymptomPresence: verified ? 'absent' : 'present',
            });
        },
    );
});

describe('an extension experiment over a tracker nothing shows', () => {
    const TRACKER_RULE = '||alaphoid.com^$domain=sarkisozleri.bbs.tr';
    const tracker = [
        scriptRequest('https://alaphoid.com/14/abc'),
        scriptRequest('https://alaphoid.com/3/'),
    ];
    // What the reviewer says when there is nothing to see: no instance before, none after, and a
    // page it cannot call intact for a network candidate.
    const nothingSeen: CandidateVisualReviewModelOutput = {
        ...CLEAN_UNCLEAR_OUTPUT,
        symptom: 'unclear',
        beforeInstances: [],
        rationale: 'No advertising element was visible in either state.',
    };

    it('verifies the block by the requests the baseline let through and the candidate stopped', async () => {
        // AdguardFilters #242153: vision found nothing before the rule, and the experiment ended
        // baseline_symptom_absent without ever judging the candidate.
        const verified = await runExtensionExperiment(TRACKER_RULE, {
            symptomPresence: () => 'absent',
            networkLog: (phase) =>
                phase === 'C' ? tracker.map((entry) => ({ ...entry, statusCode: 0 })) : tracker,
            modelOutput: nothingSeen,
        });
        expect(verified.verdict).toBe('verified');

        const candidatePhase = verified.phases.find((phase) => phase.phase === 'C');
        expect(candidatePhase?.completion).toMatchObject({
            kind: 'observed',
            candidateValidation: { verified: true },
            visualReview: {
                verdict: 'verified',
                symptomBasis: 'network_requests_blocked',
                networkVerification: { verdict: 'verified', blockedHost: 'alaphoid.com' },
            },
        });
    });

    it('rejects the block when the page reaches for a fresh third party in its place', async () => {
        const fallback = await runExtensionExperiment(TRACKER_RULE, {
            symptomPresence: () => 'absent',
            networkLog: (phase) =>
                phase === 'C'
                    ? [
                          ...tracker.map((entry) => ({ ...entry, statusCode: 0 })),
                          scriptRequest('https://alaphoid-cdn.net/14/abc'),
                      ]
                    : tracker,
            modelOutput: nothingSeen,
        });
        expect(fallback.verdict).toBe('inconclusive');
        expect(fallback.phases.find((phase) => phase.phase === 'C')?.completion).toMatchObject({
            visualReview: {
                verdict: 'rejected',
                networkVerification: {
                    verdict: 'new_third_party_hosts',
                    newThirdPartyHosts: ['alaphoid-cdn.net'],
                },
            },
        });
    });

    it('still ends before the candidate when the baseline never reached the host', async () => {
        const absent = await runExtensionExperiment(TRACKER_RULE, {
            symptomPresence: () => 'absent',
            networkLog: () => [],
            modelOutput: nothingSeen,
        });
        expect(absent).toMatchObject({
            verdict: 'inconclusive',
            inconclusiveReason: 'baseline_symptom_absent',
        });
        expect(absent.phases.map((phase) => phase.phase)).toEqual(['A', 'B']);
    });
});

describe('an extension experiment over a review that could not call the page intact', () => {
    it('verifies a third-party network block and refuses the same review for first-party scope', async () => {
        const thirdParty = await runExtensionExperiment(
            '||increase-rev.cv3-ecf.workers.dev^$domain=sarkisozleri.bbs.tr',
        );
        // The very evidence of that benchmark run: symptom gone, nothing damaged, page
        // integrity unclear. The run may now build a patch on it.
        expect(thirdParty.verdict).toBe('verified');

        const firstParty = await runExtensionExperiment('||sarkisozleri.bbs.tr/ads^');
        // Identical observations on the reported site's own host prove nothing about the
        // first-party functions the blocked request served.
        expect(firstParty.verdict).toBe('inconclusive');
    });
});

describe('an extension experiment over a selector the page cannot query', () => {
    it('verifies the candidate on the review alone', async () => {
        // AdguardFilters #242669: `:contains` is extended CSS, so the structural probe's
        // querySelectorAll threw in every phase. The review verified the candidate, yet the
        // experiment called the page unusable and the AdGuard CLI run could never finish with it.
        const verified = await runExtensionExperiment(
            'sarkisozleri.bbs.tr#?#div[class]:has(> span:contains(Download))',
            {
                modelOutput: CLEAN_INTACT_OUTPUT,
                probeSucceeded: false,
            },
        );
        expect(verified.verdict).toBe('verified');
    });
});

describe('an extension experiment behind reveal steps', () => {
    // hogtiehub.com (AdguardFilters #243399): the player sits behind an 18+ dialog, so every
    // phase must dismiss it before capturing or the review compares two dialogs.
    const RULE = 'sarkisozleri.bbs.tr#?#div[class]:has(> span:contains(Download))';

    it('verifies the candidate when every phase was prepared by the same steps', async () => {
        const experiment = await runExtensionExperiment(RULE, {
            modelOutput: CLEAN_INTACT_OUTPUT,
            probeSucceeded: false,
            reveal: { plan: ageDialogRevealPlan(), scripts: {} },
        });

        expect(experiment.verdict).toBe('verified');
    });

    it('withholds the verdict when the candidate phase was not prepared like the baseline', async () => {
        const seen: ExperimentSeams = { probedSelectors: [], inventoryPhases: [] };
        const experiment = await runExtensionExperiment(RULE, {
            modelOutput: CLEAN_INTACT_OUTPUT,
            probeSucceeded: false,
            reveal: { plan: ageDialogRevealPlan(), scripts: { C: { targetMissing: true } } },
            seen,
        });

        expect(experiment.verdict).not.toBe('verified');
        const candidatePhase = experiment.phases.find((phase) => phase.phase === 'C');
        expect(candidatePhase?.completion).toMatchObject({
            candidateValidation: { verified: false },
            visualReview: { verdict: 'verified' },
        });
        // The review alone would verify; the model must learn which check withdrew the proof.
        expect(seen.applyRuleResult).toMatchObject({
            failedCandidateChecks: ['reveal_steps_prepared_alike'],
        });
    });
});

/**
 * One wheel measurement of a page whose content is taller than the viewport.
 *
 * @param wheelScrolledPx - How far the wheel moved the document.
 * @param bodyClass - The class attribute of body; a non-empty one holds an overflow lock.
 * @param contentHeight - Height of the page's content.
 * @returns The measurement.
 */
function wheelMeasurement(
    wheelScrolledPx: number,
    bodyClass = '',
    contentHeight = 5_000,
): PageScrollMeasurement {
    return {
        wheelScrolledPx,
        innerContainerScrolled: false,
        contentHeight,
        viewportHeight: 800,
        html: { className: '', style: '', overflowY: 'visible', position: 'static' },
        body: {
            className: bodyClass,
            style: '',
            overflowY: bodyClass ? 'hidden' : 'visible',
            position: 'static',
        },
    };
}

describe('an extension experiment over a gate that locks the page scroll', () => {
    // An anti-adblock gate adds a class to body that sets overflow: hidden. Hiding only the modal
    // leaves the lock, and the screenshots of the locked page look clean, so the review verifies.
    const RULE = 'example.org##.ad-access-gate';

    it('withholds the verdict from a rule that hides the gate and leaves the lock', async () => {
        const seen: ExperimentSeams = { probedSelectors: [], inventoryPhases: [], traceEvents: [] };
        const experiment = await runExtensionExperiment(RULE, {
            modelOutput: CLEAN_INTACT_OUTPUT,
            pageScroll: (phase) =>
                phase === PhaseLabel.A ? wheelMeasurement(400) : wheelMeasurement(0, 'gate-open'),
            seen,
        });

        expect(experiment.verdict).not.toBe('verified');
        expect(experiment.phases.find((phase) => phase.phase === 'C')?.completion).toMatchObject({
            candidateValidation: { verified: false },
            visualReview: { verdict: 'verified' },
        });
        // The agent learns which check refused the rule, which class holds the lock, and that the
        // published lists left the same lock before the candidate.
        expect(seen.applyRuleResult).toMatchObject({
            failedCandidateChecks: ['page_scroll_preserved'],
            pageScroll: {
                unfiltered: { wheelScrolledPx: 400 },
                baseline: { wheelScrolledPx: 0, body: { className: 'gate-open' } },
                candidate: {
                    wheelScrolledPx: 0,
                    body: { className: 'gate-open', overflowY: 'hidden' },
                },
            },
        });
    });

    it('keeps every phase measurement in the trace, an unmeasured one included', async () => {
        const seen: ExperimentSeams = { probedSelectors: [], inventoryPhases: [], traceEvents: [] };
        await runExtensionExperiment(RULE, {
            modelOutput: CLEAN_INTACT_OUTPUT,
            pageScroll: (phase) => (phase === PhaseLabel.B ? null : wheelMeasurement(400)),
            seen,
        });

        const scrollEvents = seen.traceEvents?.filter(
            (event) => event.payload.check === 'page_scroll_preserved',
        );
        expect(scrollEvents).toEqual([
            {
                type: 'decision',
                payload: {
                    phase: 'A',
                    check: 'page_scroll_preserved',
                    pageScroll: wheelMeasurement(400),
                },
            },
            {
                type: 'decision',
                payload: { phase: 'B', check: 'page_scroll_preserved', pageScroll: null },
            },
            {
                type: 'decision',
                payload: {
                    phase: 'C',
                    check: 'page_scroll_preserved',
                    pageScroll: wheelMeasurement(400),
                },
            },
            {
                type: 'decision',
                payload: { phase: 'C', check: 'page_scroll_preserved', passed: true },
            },
        ]);
    });

    it('verifies a rule that also removes the lock', async () => {
        const seen: ExperimentSeams = { probedSelectors: [], inventoryPhases: [] };
        const experiment = await runExtensionExperiment(RULE, {
            modelOutput: CLEAN_INTACT_OUTPUT,
            pageScroll: () => wheelMeasurement(400),
            seen,
        });

        expect(experiment.verdict).toBe('verified');
        expect(seen.applyRuleResult).not.toHaveProperty('pageScroll');
    });

    it('verifies a page the wheel cannot scroll even without filtering', async () => {
        // A page shorter than the viewport, or one that takes the wheel for itself, has no scroll
        // the candidate could have taken away.
        const experiment = await runExtensionExperiment(RULE, {
            modelOutput: CLEAN_INTACT_OUTPUT,
            pageScroll: () => wheelMeasurement(0),
        });

        expect(experiment.verdict).toBe('verified');
    });

    it('verifies a candidate page with nothing left to scroll', async () => {
        // Filtering removed the height that made the unfiltered page scroll: nothing is locked.
        const experiment = await runExtensionExperiment(RULE, {
            modelOutput: CLEAN_INTACT_OUTPUT,
            pageScroll: (phase) =>
                phase === PhaseLabel.A ? wheelMeasurement(400) : wheelMeasurement(0, '', 300),
        });

        expect(experiment.verdict).toBe('verified');
    });
});

/**
 * The capture one phase completed with.
 *
 * @param experiment - The finished experiment.
 * @param label - The phase to read.
 * @returns The phase's only capture.
 */
function phaseCapture(
    experiment: Awaited<ReturnType<typeof runExtensionExperiment>>,
    label: 'A' | 'B' | 'C',
) {
    const completion = experiment.phases.find((phase) => phase.phase === label)?.completion;
    return completion?.kind === 'observed' ? completion.captures?.[0] : undefined;
}

describe('an extension experiment judged by its paired review', () => {
    const RULE = 'sarkisozleri.bbs.tr##.banner';

    it('inventories only the baseline phases one image at a time', async () => {
        // A lone after image has no before to compare and no DOM measurements: its "too small to
        // tell" once outvoted the review that saw every tile clean.
        const seen: ExperimentSeams = { probedSelectors: [], inventoryPhases: [] };
        await runExtensionExperiment(RULE, { modelOutput: CLEAN_INTACT_OUTPUT, seen });

        expect(seen.inventoryPhases).toEqual(['A', 'B']);
    });

    it("reads the candidate phase's symptom and capture from the paired review", async () => {
        const clean = await runExtensionExperiment(RULE, { modelOutput: CLEAN_INTACT_OUTPUT });

        expect(clean.verdict).toBe('verified');
        expect(phaseCapture(clean, 'C')).toMatchObject({
            visionVerified: true,
            coverageComplete: true,
            reporterSymptomPresence: 'absent',
        });

        const remaining = await runExtensionExperiment(RULE, {
            modelOutput: {
                ...CLEAN_INTACT_OUTPUT,
                symptom: 'not_resolved',
                remainingInstances: [
                    {
                        artifactId: 'shot-c',
                        landmark: 'Above the lyrics body.',
                        description: 'The advertising banner is still shown.',
                    },
                ],
            },
        });

        expect(remaining.verdict).not.toBe('verified');
        expect(phaseCapture(remaining, 'C')).toMatchObject({ reporterSymptomPresence: 'present' });
    });

    it('names no failed check when the review itself could not decide', async () => {
        // An undecided review says nothing about the symptom or the page; naming the checks it
        // leaves open would tell the model the advertising stayed and the page broke.
        const seen: ExperimentSeams = { probedSelectors: [], inventoryPhases: [] };
        const undecided = await runExtensionExperiment(RULE, {
            modelOutput: { ...CLEAN_UNCLEAR_OUTPUT, symptom: 'unclear' },
            seen,
        });

        expect(undecided.verdict).toBe('inconclusive');
        expect(seen.applyRuleResult).toMatchObject({
            visualReview: { verdict: 'inconclusive' },
            failedCandidateChecks: [],
        });
    });
});

/**
 * How many elements a selector matches per phase when the filtered baseline does not render them.
 *
 * The selector finds nothing on the filtered baseline, while its inventory still reports the
 * advertising: a vision reading copied from the reporter's screenshot once verified a rule that hid
 * nothing.
 *
 * @param phase - The phase being probed.
 * @returns No match in phase B, one elsewhere.
 */
function unmatchedOnBaseline(phase: 'A' | 'B' | 'C'): number {
    return phase === 'B' ? 0 : 1;
}

describe('an extension experiment over a hiding selector the baseline does not match', () => {
    it('ends at the baseline when the hiding selector matches nothing there', async () => {
        const seen: ExperimentSeams = { probedSelectors: [], inventoryPhases: [] };
        const experiment = await runExtensionExperiment('sarkisozleri.bbs.tr##.banner', {
            modelOutput: CLEAN_INTACT_OUTPUT,
            targetCount: unmatchedOnBaseline,
            seen,
        });

        expect(experiment).toMatchObject({
            verdict: 'inconclusive',
            inconclusiveReason: 'baseline_symptom_absent',
        });
        expect(experiment.phases.map((phase) => phase.phase)).toEqual(['A', 'B']);
        expect(phaseCapture(experiment, 'B')).toMatchObject({ reporterSymptomPresence: 'absent' });
        expect(seen.reviewCalled).toBeUndefined();
        expect(seen.unmatchedBaselineSelector).toBe('.banner');
    });

    it('judges a selector the probe cannot measure as before', async () => {
        const seen: ExperimentSeams = { probedSelectors: [], inventoryPhases: [] };
        const experiment = await runExtensionExperiment(
            'sarkisozleri.bbs.tr#?#div[class]:has(> span:contains(Download))',
            {
                modelOutput: CLEAN_INTACT_OUTPUT,
                probeSucceeded: false,
                targetCount: unmatchedOnBaseline,
                seen,
            },
        );

        expect(experiment.verdict).toBe('verified');
        expect(experiment.phases.map((phase) => phase.phase)).toEqual(['A', 'B', 'C']);
        expect(seen.reviewCalled).toBe(true);
        expect(seen.unmatchedBaselineSelector).toBeNull();
    });

    it('leaves an exception rule to the review', async () => {
        const seen: ExperimentSeams = { probedSelectors: [], inventoryPhases: [] };
        const experiment = await runExtensionExperiment('sarkisozleri.bbs.tr#@#.banner', {
            modelOutput: CLEAN_INTACT_OUTPUT,
            targetCount: unmatchedOnBaseline,
            seen,
        });

        expect(experiment.phases.map((phase) => phase.phase)).toEqual(['A', 'B', 'C']);
        expect(seen.reviewCalled).toBe(true);
        expect(seen.unmatchedBaselineSelector).toBeNull();
    });
    it.each([
        {
            case: 'a pseudo-element the page cannot query',
            rule: 'sarkisozleri.bbs.tr#$#.ad-label::before { content: none !important; }',
        },
        {
            case: 'a legacy pseudo-element',
            rule: 'sarkisozleri.bbs.tr##.ad-label:after',
        },
        {
            case: 'a legacy Extended CSS attribute',
            rule: 'sarkisozleri.bbs.tr##div[-ext-has=".ad"]',
        },
    ])('judges a selector with $case as before', async ({ rule }) => {
        // The page's querySelectorAll returns nothing for these without throwing, so an empty
        // match says nothing about the rule.
        const seen: ExperimentSeams = { probedSelectors: [], inventoryPhases: [] };
        const experiment = await runExtensionExperiment(rule, {
            modelOutput: CLEAN_INTACT_OUTPUT,
            targetCount: unmatchedOnBaseline,
            seen,
        });

        expect(experiment.phases.map((phase) => phase.phase)).toEqual(['A', 'B', 'C']);
        expect(seen.reviewCalled).toBe(true);
        expect(seen.unmatchedBaselineSelector).toBeNull();
    });

    it('leaves an incorrect-blocking report to the review', async () => {
        const seen: ExperimentSeams = { probedSelectors: [], inventoryPhases: [] };
        const experiment = await runExtensionExperiment('sarkisozleri.bbs.tr##.banner', {
            modelOutput: CLEAN_INTACT_OUTPUT,
            targetCount: unmatchedOnBaseline,
            symptomKind: SymptomKind.Breakage,
            seen,
        });

        expect(experiment.phases.map((phase) => phase.phase)).toEqual(['A', 'B', 'C']);
        expect(seen.reviewCalled).toBe(true);
        expect(seen.unmatchedBaselineSelector).toBeNull();
    });

    it('trusts no empty match on a baseline its reveal steps did not prepare', async () => {
        const seen: ExperimentSeams = { probedSelectors: [], inventoryPhases: [] };
        const experiment = await runExtensionExperiment('sarkisozleri.bbs.tr##.banner', {
            modelOutput: CLEAN_INTACT_OUTPUT,
            targetCount: unmatchedOnBaseline,
            reveal: { plan: ageDialogRevealPlan(), scripts: { B: { targetMissing: true } } },
            seen,
        });

        expect(experiment.phases.map((phase) => phase.phase)).toEqual(['A', 'B', 'C']);
        expect(seen.unmatchedBaselineSelector).toBeNull();
    });
});

describe('an extension experiment carrying DOM checks', () => {
    // nettg.pl: two reviewers split on the same pixels over a white column where a sidebar had
    // been. The page answers it, so the checks must run on the very loads the review compares.
    const RULE = 'sarkisozleri.bbs.tr##.banner, .sidebar';
    const BACKGROUND = "getComputedStyle(document.querySelector('.sidebar-track')).backgroundColor";
    const HEIGHT = "document.querySelector('.sidebar').offsetHeight";
    const checks: DomCheck[] = [
        { expression: BACKGROUND, claim: 'The blank column is a transparent grid track.' },
        { expression: HEIGHT, claim: 'The sidebar keeps no reserved height.' },
    ];

    it('measures the checks on the baseline and candidate pages the review compares', async () => {
        const evaluated: string[] = [];
        const seen: ExperimentSeams = { probedSelectors: [], inventoryPhases: [] };
        await runExtensionExperiment(RULE, {
            modelOutput: CLEAN_INTACT_OUTPUT,
            seen,
            domChecks: {
                checks,
                answer: (phase, expression) => {
                    evaluated.push(phase);
                    if (expression === BACKGROUND) {
                        return phase === 'B' ? 'rgb(249, 249, 249)' : 'rgba(0, 0, 0, 0)';
                    }
                    if (phase === 'C') {
                        throw new Error("Cannot read properties of null (reading 'offsetHeight')");
                    }
                    return 1_250;
                },
            },
        });

        // The unfiltered control never reaches the review, so the checks do not run there.
        expect(evaluated).toEqual(['B', 'B', 'C', 'C']);
        const expected = [
            {
                expression: BACKGROUND,
                claim: checks[0].claim,
                before: { status: 'measured', result: '"rgb(249, 249, 249)"', truncated: false },
                after: { status: 'measured', result: '"rgba(0, 0, 0, 0)"', truncated: false },
            },
            {
                expression: HEIGHT,
                claim: checks[1].claim,
                before: { status: 'measured', result: '1250', truncated: false },
                after: {
                    status: 'failed',
                    error: expect.stringContaining('offsetHeight') as unknown as string,
                },
            },
        ];
        expect(seen.reviewDomChecks).toEqual(expected);
        // The model reads the same answers, so its next attempt can ask the page differently.
        expect(seen.applyRuleResult).toMatchObject({ domChecks: expected });
    });

    it('bounds an answer too large for the review', async () => {
        const seen: ExperimentSeams = { probedSelectors: [], inventoryPhases: [] };
        await runExtensionExperiment(RULE, {
            modelOutput: CLEAN_INTACT_OUTPUT,
            seen,
            domChecks: {
                checks: [checks[0]],
                answer: () => 'x'.repeat(MAX_DOM_CHECK_RESULT_BYTES * 4),
            },
        });

        const [record] = seen.reviewDomChecks ?? [];
        // Cut for the review, kept whole as an artifact the agent can read back.
        expect(record?.after).toMatchObject({
            status: 'measured',
            truncated: true,
            artifactId: expect.any(String) as unknown as string,
        });
        expect(
            Buffer.byteLength(record?.after.status === 'measured' ? record.after.result : ''),
        ).toBeLessThanOrEqual(MAX_DOM_CHECK_RESULT_BYTES);
    });

    it('leaves the review without checks when apply_rule attached none', async () => {
        const seen: ExperimentSeams = { probedSelectors: [], inventoryPhases: [] };
        await runExtensionExperiment(RULE, { seen });

        expect(seen.reviewDomChecks).toBeUndefined();
        expect(seen.applyRuleResult).not.toHaveProperty('domChecks');
    });
});

describe('an extension experiment over a CSS injection candidate', () => {
    it("probes the rule's selector without its style block", async () => {
        // The probe used to receive `.banner { display: none !important; }`, which
        // querySelectorAll refuses, so CSS injection candidates carried no structural facts.
        const seen: ExperimentSeams = { probedSelectors: [], inventoryPhases: [] };
        await runExtensionExperiment(
            'sarkisozleri.bbs.tr#$#.banner { display: none !important; }',
            {
                seen,
            },
        );

        expect(seen.probedSelectors).toEqual(['.banner', '.banner', '.banner']);
        expect(seen.applyRuleResult).toMatchObject({ validatedSelector: '.banner' });
    });
});

describe('an extension experiment over a candidate that names no element', () => {
    it('reports the target as not probed instead of visible', async () => {
        // A scriptlet leaves the probe measuring `body`; calling that the target would tell the
        // review and the model the target survived the candidate.
        const seen: ExperimentSeams = { probedSelectors: [], inventoryPhases: [] };
        await runExtensionExperiment(
            "sarkisozleri.bbs.tr#%#//scriptlet('set-constant', 'ads', 'false')",
            {
                seen,
            },
        );

        expect(seen.applyRuleResult).toMatchObject({
            adElementStatus: { phaseB: 'not_probed', phaseC: 'not_probed' },
        });
    });
});

describe('an extension experiment on a page too tall for one full-page capture', () => {
    // money.pl and pb.pl: Chromium refused the filtered baseline's full-page capture of a page about
    // 17,500 px tall, the tiles of the same state were complete, and the phase died at the capture
    // schema before any vision call, so a candidate equal to the maintainer's fix got no verdict.
    const DOCUMENT_HEIGHT = 17_811;
    const VIEWPORT_HEIGHT = 1_080;

    /**
     * Observe one baseline phase whose browser captured no overview, through the real inventory.
     *
     * @param tilesComplete - Whether the tile capture covered its window.
     * @param documentHeight - Height of the captured document.
     * @returns The phase completion and the run trace.
     */
    async function observeWithoutOverview(
        tilesComplete: boolean,
        documentHeight = DOCUMENT_HEIGHT,
    ) {
        const artifactsDir = mkdtempSync(join(tmpdir(), 'ads-observer-no-overview-'));
        roots.push(artifactsDir);
        const recorder = new TraceRecorder({ runId: 'no-overview', issueNumber: 1, mode: 'fix' });
        const register = (id: string, type: string) => {
            const path = join(artifactsDir, `${id}.png`);
            writeFileSync(path, Buffer.from(`png:${id}`));
            recorder.addArtifact({ id, path, type, bytes: 8 });
        };
        const tileIds = tilesComplete ? ['tile-0', 'tile-1'] : [];
        const structured = vi.fn(async () => ({
            kind: SingleShotResultKind.Parsed,
            value: {
                coverageObserved: true,
                reporterSymptomPresence: 'absent',
                symptomScope: 'The advertising placeholder.',
                instances: [],
                rationale: 'Every supplied tile was inspected.',
                pageObstruction: 'none',
            },
            usages: [],
            attempts: 1,
            model: 'vision-model',
        }));
        const observer = new BrowserExtensionAdsObserver({
            candidateRule: 'example.test##.ad',
            trustedValidationContext: {
                reportedUrl: 'https://example.test/',
                existingRules: [],
                baselineHash: 'b'.repeat(64),
            },
            profile: PROFILE,
            recorder,
            artifactsDir,
            logger: pino({ level: 'silent' }),
            vision: { ...visionStub, structured } as unknown as SingleShotClient,
            reporterSymptom: 'an empty advertising placeholder',
            attemptNumber: 1,
            noSandbox: false,
            dependencies: {
                runPhase: async () => {
                    register('shot-b', 'screenshot');
                    tileIds.forEach((id) => register(id, 'screenshot-tile'));
                    register('har-b', 'har');
                    register('dom-b', 'dom');
                    return {
                        phase: 'B' as const,
                        url: 'https://example.test/',
                        screenshotArtifactId: 'shot-b',
                        tileCoverage: {
                            window: { fromY: 0, toY: 2 * VIEWPORT_HEIGHT },
                            complete: tilesComplete,
                            documentWidth: 1_920,
                            documentHeight,
                            viewportWidth: 1_920,
                            viewportHeight: VIEWPORT_HEIGHT,
                            overlapPx: 0,
                            tiles: tileIds.map((artifactId, index) => ({
                                artifactId,
                                index,
                                x: 0,
                                y: index * VIEWPORT_HEIGHT,
                                width: 1_920,
                                height: VIEWPORT_HEIGHT,
                                landmark: `Screen ${index + 1}`,
                            })),
                            ...(tilesComplete
                                ? {}
                                : { error: 'Document dimensions changed before tile capture.' }),
                        },
                        harArtifactId: 'har-b',
                        domArtifactId: 'dom-b',
                        appliedRules: [],
                        ruleApplications: [],
                        antiAdblockDetected: false,
                    };
                },
                probeStructuralSnapshot: async () =>
                    ({
                        probeSucceeded: true,
                        targetCount: 1,
                        targetVisibleCount: 1,
                    }) as StructuralSnapshot,
            },
        });
        const completion = await observer.observe({
            phase: 'B',
            phaseTokenId: 'token-b',
            session: {
                artifactsDir,
                isClosed: false,
                getPage: () => ({}) as Page,
                close: async () => undefined,
                getNetworkLog: () => [],
                resetNetworkLog: () => undefined,
                getConsoleLog: () => [],
                consoleCoverage: ConsoleCoverage.BrowserLogOnly,
            } as unknown as IBrowserSession,
            proof: {
                leaseId: 'lease-b',
                adapterStateDigest: 'a'.repeat(64),
                phase: 'B',
                filteringState: 'published_baseline',
                sessionId: 'session-b',
                actualContext: {
                    kind: 'browser_extension',
                    product: 'AdGuard Browser Extension',
                    browser: 'CloakBrowser Chromium',
                    productVersion: '5.0.0',
                },
                baselineDigest: 'b'.repeat(64),
                candidateDigest: null,
                extension: null,
            },
        });
        return { completion, trace: recorder.toJSON() };
    }

    it('inspects a phase from its complete tiles when the browser captured no overview', async () => {
        const { completion } = await observeWithoutOverview(true);

        expect(completion).toMatchObject({
            kind: 'observed',
            captures: [
                {
                    visionVerified: true,
                    coverageComplete: true,
                    fullPageOverviewArtifactId: null,
                    tileArtifactIds: ['tile-0', 'tile-1'],
                },
            ],
        });
    });

    it('fails a phase with neither an overview nor complete tiles, and traces why', async () => {
        const { completion, trace } = await observeWithoutOverview(false);

        expect(completion).toMatchObject({
            kind: 'failed',
            limitation: { code: 'phase_proof_unavailable' },
        });
        expect(
            trace.events
                .filter((event) => event.type === TraceEventType.Error)
                .map((event) => event.payload.error),
        ).toEqual([expect.stringContaining('Document dimensions changed before tile capture.')]);
    });

    it('fails a phase whose tiles cover only a window of a page short enough to read whole', async () => {
        // A page of 8,000 px fits one readable overview, and the tiles cover its first screens
        // only: without that overview the rest of the page went unseen, so the phase proves
        // nothing the candidate review could judge.
        const { completion, trace } = await observeWithoutOverview(true, 8_000);

        expect(completion).toMatchObject({
            kind: 'failed',
            limitation: { code: 'phase_proof_unavailable' },
        });
        expect(
            trace.events
                .filter((event) => event.type === TraceEventType.Error)
                .map((event) => event.payload.error),
        ).toEqual([expect.stringContaining(`y=0..${2 * VIEWPORT_HEIGHT}`)]);
    });

    it('verifies a candidate whose baseline and candidate phases have no overview', async () => {
        const seen: ExperimentSeams = { probedSelectors: [], inventoryPhases: [] };
        const experiment = await runExtensionExperiment(
            '||increase-rev.cv3-ecf.workers.dev^$domain=sarkisozleri.bbs.tr',
            { overviewCaptured: false, seen },
        );

        expect(experiment.verdict).toBe('verified');
        const candidate = experiment.phases.at(-1)?.completion;
        expect(candidate?.kind === 'observed' && candidate.candidateValidation).toMatchObject({
            verified: true,
            screenshotArtifactIds: ['shot-b', 'shot-c'],
        });
        expect(seen.applyRuleResult).toMatchObject({
            visualReview: { beforeFullPageArtifactId: null, afterFullPageArtifactId: null },
        });
    });
});
