import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import * as v from 'valibot';
import { afterEach, describe, expect, it } from 'vitest';
import { ConsoleCoverage, type IBrowserSession } from '../../src/browser/browser-interfaces';
import type { TraceRecorder } from '../../src/tracer/trace-recorder';
import type { SingleShotClient } from '../../src/pi/single-shot-types';

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
import type { StructuralSnapshot } from '../../src/types/validation';
import { BrowserExtensionAdsObserver } from '../../src/environment/browser-extension-ads-observer';
import { runAdsEnvironmentExperiment } from '../../src/validator/phase-orchestrator';
import { deriveCandidateNetworkScope } from '../../src/validator/candidate-network-scope';
import {
    CandidateVisualReviewSchema,
    deriveCandidateVisualIntegrityBasis,
    deriveCandidateVisualSymptomBasis,
    deriveCandidateVisualVerdict,
    type CandidateVisualReviewModelOutput,
} from '../../src/types/candidate-visual-review';
import type { NetworkRequestEntry } from '../../src/browser/browser-interfaces';
import type { CandidateVisualEvidence as ResolvedCandidateVisualEvidence } from '../../src/validator/candidate-evidence-resolver';
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
 * Minimal artifact-registry recorder: exactly what environment artifact resolution reads.
 *
 * @returns Recorder stub holding registered artifacts.
 */
function recorderStub(): TraceRecorder {
    const artifacts: Array<{ id: string; path: string; type: string; bytes: number }> = [];
    return {
        addArtifact: (artifact: { id: string; path: string; type: string; bytes: number }) => {
            artifacts.push(artifact);
        },
        getArtifacts: () => artifacts,
    } as unknown as TraceRecorder;
}

describe('BrowserExtensionAdsObserver', () => {
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

    it('reads a breakage symptom from the probed element relative to the unfiltered control', async () => {
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
        // The site itself hides two of the five matches in every phase; only the three the
        // unfiltered control renders are content the candidate must restore.
        const visibleByPhase: Record<string, number> = { A: 3, B: 0, C: 3 };
        let probedPhase: 'A' | 'B' | 'C' = 'A';
        const observer = new BrowserExtensionAdsObserver({
            candidateRule: 'example.test#@#.ad-sidebar',
            trustedValidationContext: {
                reportedUrl: 'https://example.test/',
                existingRules: [],
                baselineHash: 'b'.repeat(64),
            },
            profile: PROFILE,
            recorder,
            artifactsDir,
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
                        // Vision inverts absence symptoms: it recognises the element the reporter
                        // named and calls the defect present in every state.
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

        const control = await observe('A');
        const baseline = await observe('B');

        // The control defines the healthy count, so its own partially hidden matches are not a
        // defect; the baseline rendering fewer of them is.
        expect(control).toMatchObject({ targetObservation: { symptomPresent: false } });
        expect(baseline).toMatchObject({ targetObservation: { symptomPresent: true } });
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
     * Vision's per-phase presence of the reporter symptom; present before C and absent in C when
     * omitted.
     */
    symptomPresence?: (phase: 'A' | 'B' | 'C') => 'present' | 'absent';

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
     * Reveal steps apply_rule received, with how each phase's page answers them; none when omitted.
     */
    reveal?: {
        plan: NormalizedSafeInteractionPlan;
        scripts: Partial<Record<'A' | 'B' | 'C', InteractionPhaseScript>>;
    };
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
    const symptomPresence =
        options.symptomPresence ?? ((phase) => (phase === 'C' ? 'absent' : 'present'));
    const networkLog = options.networkLog ?? (() => []);
    const modelOutput = options.modelOutput ?? CLEAN_UNCLEAR_OUTPUT;
    const artifactsDir = mkdtempSync(join(tmpdir(), 'ads-observer-experiment-'));
    roots.push(artifactsDir);
    const recorder = recorderStub();
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
        vision: visionStub,
        reporterSymptom: 'injected advertising banners above the lyrics',
        attemptNumber: 1,
        noSandbox: false,
        ...(options.reveal ? { interactionPlan: options.reveal.plan } : {}),
        dependencies: {
            runPhase: async (input, phaseConfig) => {
                await phaseConfig.interact?.();
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
                    url: REPORTED_URL,
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
            probeStructuralSnapshot: async () =>
                ({
                    probeSucceeded: options.probeSucceeded ?? true,
                    targetCount: 1,
                    targetVisibleCount: 1,
                }) as StructuralSnapshot,
            inspectFullPageVisualCapture: async (input, inventoryOptions) => {
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
                    beforeFullPage: { id: 'full-b', path: join(artifactsDir, 'full-b.bin') },
                    afterFullPage: { id: 'full-c', path: join(artifactsDir, 'full-c.bin') },
                    beforeTiles: [],
                    afterTiles: [],
                    beforeCoverageComplete: true,
                    afterCoverageComplete: true,
                }) as unknown as ResolvedCandidateVisualEvidence,
            reviewCandidateVisually: async (_input, reviewOptions) => {
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
                    beforeFullPageArtifactId: 'full-b',
                    afterFullPageArtifactId: 'full-c',
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

    return await runAdsEnvironmentExperiment({
        runId: 'run-1',
        experimentId: 'experiment-1',
        adapter,
        recorder: executionRecorder,
        targetUrl: REPORTED_URL,
        candidate: { operation: 'add', rule: candidateRule },
        observe: async (input) => await observer.observe(input),
    });
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
                modelOutput: { ...CLEAN_UNCLEAR_OUTPUT, pageIntegrity: 'intact' },
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
    const intact = { ...CLEAN_UNCLEAR_OUTPUT, pageIntegrity: 'intact' as const };

    it('verifies the candidate when every phase was prepared by the same steps', async () => {
        const experiment = await runExtensionExperiment(RULE, {
            modelOutput: intact,
            probeSucceeded: false,
            reveal: { plan: ageDialogRevealPlan(), scripts: {} },
        });

        expect(experiment.verdict).toBe('verified');
    });

    it('withholds the verdict when the candidate phase was not prepared like the baseline', async () => {
        const experiment = await runExtensionExperiment(RULE, {
            modelOutput: intact,
            probeSucceeded: false,
            reveal: { plan: ageDialogRevealPlan(), scripts: { C: { targetMissing: true } } },
        });

        expect(experiment.verdict).not.toBe('verified');
        const candidatePhase = experiment.phases.find((phase) => phase.phase === 'C');
        expect(candidatePhase?.completion).toMatchObject({
            candidateValidation: { verified: false },
        });
    });
});
