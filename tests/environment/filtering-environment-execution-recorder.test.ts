import { createHash } from 'node:crypto';
import { BlockerVerificationMethod } from '../../src/environment/environment-proofs';
import { describe, expect, it } from 'vitest';
import { ConsoleCoverage, type IBrowserSession } from '../../src/browser/browser-interfaces';
import type { IssueFacts } from '../../src/types/issue-facts';
import { EnvironmentSelectionHost } from '../../src/environment/environment-selection';
import { extensionExecutorDescriptor } from './test-filtering-environment-fixtures';
import { FilteringEnvironmentExecutionRecorder } from '../../src/environment/filtering-environment-execution-recorder';
import type {
    AdapterPhaseLease,
    EnvironmentCleanupReceipt,
    FilteringEnvironmentAdapterState,
    ValidatorPhaseCompletion,
} from '../../src/environment/filtering-environment';

/**
 * Exact single-line candidate rule the C-phase fixtures apply and prove.
 */
const FIXTURE_CANDIDATE_RULE = 'example.test##.ad';

/**
 * SHA-256 of the fixture candidate rule; every C-phase digest in this file derives from it.
 */
const FIXTURE_CANDIDATE_DIGEST = createHash('sha256')
    .update(FIXTURE_CANDIDATE_RULE, 'utf8')
    .digest('hex');

const facts: IssueFacts = {
    issueNumber: 6,
    issueUrl: 'https://github.com/AdguardTeam/AdguardFilters/issues/6',
    reportedSiteUrls: ['https://example.test/'],
    labels: ['T: Ads'],
    declaredIssueType: 'Ads',
    problemType: 'ads',
    product: 'AdGuard Browser Extension',
    browser: 'Chrome',
    enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
    screenshots: [],
};

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
    capabilities: ['browser_navigation', 'filtering_control', 'baseline_integrity', 'phase_proof'],
    preparation: null,
    baseline: null,
    openLeaseIds: [],
    cleanup: null,
};

const session = {
    artifactsDir: '/tmp/artifacts',
    isClosed: false,
    getPage: () => {
        throw new Error('not used');
    },
    close: async () => undefined,
    getNetworkLog: () => [],
    resetNetworkLog: () => undefined,
    getConsoleLog: () => [],
    consoleCoverage: ConsoleCoverage.BrowserLogOnly,
} as IBrowserSession;

const successfulCleanup: EnvironmentCleanupReceipt = {
    attempted: true,
    completed: true,
    finalizerAttempts: 0,
    finalizerCompleted: 0,
    finalizerFailed: 0,
    failures: [],
};

function host(): EnvironmentSelectionHost {
    const environmentHost = new EnvironmentSelectionHost(facts, [extensionExecutorDescriptor()]);
    environmentHost.select({
        kind: 'browser_extension',
        requiredCapabilities: ['browser_navigation'],
        intent: {
            issueType: 'ads',
            rationale: 'The page visibly contains an advertisement.',
            confidence: 1,
            evidence: [{ source: 'issue_body', observation: 'Advertisement remains visible.' }],
            conflicts: [],
        },
        rationale: 'Use the extension for this extension report.',
        confidence: 1,
    });
    return environmentHost;
}

function lease(phase: 'A' | 'B' | 'C', sessionId = `session-${phase}`): AdapterPhaseLease {
    let filteringState: AdapterPhaseLease['adapterProof']['filteringState'];
    if (phase === 'A') {
        filteringState = 'disabled';
    } else if (phase === 'B') {
        filteringState = 'published_baseline';
    } else {
        filteringState = 'published_baseline_plus_candidate';
    }
    let extension: AdapterPhaseLease['adapterProof']['extension'] = null;
    if (phase !== 'A') {
        extension = {
            packageVersion: '5.0.0',
            manifestVersion: '5.0.0',
            profileKind: 'agent_selected',
            enabledListKeys: ['adguard:2'],
            activeRulesetListKeys: ['adguard:2'],
            stealthEnabled: false,
            userRulesDigest: phase === 'C' ? FIXTURE_CANDIDATE_DIGEST : null,
            application: {
                method: BlockerVerificationMethod.ExtensionState,
                appliedRules: phase === 'C' ? [FIXTURE_CANDIDATE_RULE] : [],
                actionLog: [],
            },
        };
    }
    return {
        session,
        adapterProof: {
            leaseId: `lease-${phase}`,
            adapterStateDigest: state.stateDigest,
            phase,
            filteringState,
            sessionId,
            actualContext,
            baselineDigest: phase === 'A' ? null : 'b'.repeat(64),
            candidateDigest: phase === 'C' ? FIXTURE_CANDIDATE_DIGEST : null,
            extension,
        },
        close: async () => undefined,
    };
}

function completion(sessionId: string): Extract<ValidatorPhaseCompletion, { kind: 'observed' }> {
    return {
        kind: 'observed',
        sessionId,
        targetUrl: 'https://example.test/',
        targetObservation: { symptomPresent: true, pageUsable: true },
        navigationVerified: true,
        artifacts: [
            { artifactId: `${sessionId}-viewport`, kind: 'screenshot', path: 'viewport.png' },
        ],
        vision: null,
        candidateValidation: null,
        rejectedCandidates: [],
    };
}

describe('FilteringEnvironmentExecutionRecorder', () => {
    it('binds actual context and completes each phase token exactly once', () => {
        const environmentHost = host();
        const recorder = new FilteringEnvironmentExecutionRecorder('run-6', environmentHost);
        recorder.registerAdapter(state);
        const token = recorder.beginPhase({
            runId: 'run-6',
            experimentId: 'experiment-1',
            phase: 'A',
        });
        recorder.bindPhaseLease(token, lease('A'), state);

        const evidence = recorder.completePhase(token, completion('session-A'));

        expect(evidence.phase).toBe('A');
        expect(environmentHost.snapshot()?.actual).toEqual(actualContext);
        expect(() => recorder.completePhase(token, completion('session-A'))).toThrow(
            /already completed/u,
        );
    });

    it('binds a matching proof and refuses one that does not match the recorder boundary', () => {
        // bindPhaseLease is the one gate for the bound proof: it parses the full phase-proof
        // contract and separately compares the proof's own boundary fields against the recorder's
        // registered adapter state, so nothing downstream needs to check either again.
        const recorder = new FilteringEnvironmentExecutionRecorder('run-6', host());
        recorder.registerAdapter(state);

        const matchedToken = recorder.beginPhase({
            runId: 'run-6',
            experimentId: 'experiment-1',
            phase: 'A',
        });
        expect(() => recorder.bindPhaseLease(matchedToken, lease('A'), state)).not.toThrow();

        const mismatchedToken = recorder.beginPhase({
            runId: 'run-6',
            experimentId: 'experiment-1',
            phase: 'B',
        });
        const mismatchedLease = lease('B');
        const mismatchedProofLease: AdapterPhaseLease = {
            ...mismatchedLease,
            adapterProof: { ...mismatchedLease.adapterProof, adapterStateDigest: 'f'.repeat(64) },
        };
        expect(() => recorder.bindPhaseLease(mismatchedToken, mismatchedProofLease, state)).toThrow(
            /does not match its recorder boundary/u,
        );
    });

    it('rejects cross-boundary input and reused artifacts', () => {
        const recorder = new FilteringEnvironmentExecutionRecorder('run-6', host());
        recorder.registerAdapter(state);
        expect(() =>
            recorder.beginPhase({ runId: 'another-run', experimentId: 'experiment-1', phase: 'A' }),
        ).toThrow(/run/u);

        const first = recorder.beginPhase({
            runId: 'run-6',
            experimentId: 'experiment-1',
            phase: 'A',
        });
        recorder.bindPhaseLease(first, lease('A'), state);
        recorder.completePhase(first, completion('session-A'));
        const second = recorder.beginPhase({
            runId: 'run-6',
            experimentId: 'experiment-1',
            phase: 'B',
        });
        recorder.bindPhaseLease(second, lease('B'), state);
        const reused = completion('session-B');
        reused.artifacts[0] = {
            artifactId: 'session-A-viewport',
            kind: 'screenshot',
            path: 'another.png',
        };
        expect(() => recorder.completePhase(second, reused)).toThrow(/artifact/u);
    });

    it('validates every inline reference against unique artifacts owned by that phase', () => {
        const recorder = new FilteringEnvironmentExecutionRecorder('run-6', host());
        recorder.registerAdapter(state);
        const first = recorder.beginPhase({
            runId: 'run-6',
            experimentId: 'experiment-inline',
            phase: 'A',
        });
        recorder.bindPhaseLease(first, lease('A'), state);
        const invalidVision = completion('session-A');
        invalidVision.vision = { artifactId: 'unowned-vision', verdict: 'verified' };
        expect(() => recorder.completePhase(first, invalidVision)).toThrow(/artifact/u);

        const secondRecorder = new FilteringEnvironmentExecutionRecorder('run-6', host());
        secondRecorder.registerAdapter(state);
        const second = secondRecorder.beginPhase({
            runId: 'run-6',
            experimentId: 'experiment-inline',
            phase: 'A',
        });
        secondRecorder.bindPhaseLease(second, lease('A'), state);
        const invalidCapture = completion('session-A');
        invalidCapture.captures = [
            {
                visionVerified: true,
                viewportArtifactId: 'unowned-viewport',
                viewport: 'viewport.png',
                fullPageOverviewArtifactId: null,
                fullPageOverview: null,
                tileArtifactIds: [],
                tiles: [],
                coverageComplete: true,
            },
        ];
        expect(() => secondRecorder.completePhase(second, invalidCapture)).toThrow(/artifact/u);

        const duplicateRecorder = new FilteringEnvironmentExecutionRecorder('run-6', host());
        duplicateRecorder.registerAdapter(state);
        const duplicateToken = duplicateRecorder.beginPhase({
            runId: 'run-6',
            experimentId: 'experiment-inline',
            phase: 'A',
        });
        duplicateRecorder.bindPhaseLease(duplicateToken, lease('A'), state);
        const duplicate = completion('session-A');
        duplicate.artifacts.push({ ...duplicate.artifacts[0] });
        expect(() => duplicateRecorder.completePhase(duplicateToken, duplicate)).toThrow(
            /artifact/u,
        );
    });

    it('rejects candidate, visual-review, and rejected records outside their phase boundary', () => {
        const recorder = new FilteringEnvironmentExecutionRecorder('run-6', host());
        recorder.registerAdapter(state);
        const token = recorder.beginPhase({
            runId: 'run-6',
            experimentId: 'experiment-candidate',
            phase: 'C',
        });
        recorder.bindPhaseLease(token, lease('C'), state);
        const candidate = completion('session-C');
        candidate.artifacts.push(
            { artifactId: 'validation-C', kind: 'validation', path: 'validation.json' },
            { artifactId: 'vision-C', kind: 'vision', path: 'vision.json' },
            { artifactId: 'after-full-C', kind: 'screenshot', path: 'after-full.png' },
        );
        candidate.vision = { artifactId: 'vision-C', verdict: 'verified' };
        candidate.candidateValidation = {
            validationArtifactId: 'validation-C',
            candidateDigest: FIXTURE_CANDIDATE_DIGEST,
            verified: false,
            screenshotArtifactIds: [
                'session-C-viewport',
                'session-C-viewport',
                'after-full-C',
                'unowned-after-full',
            ],
            validationArtifact: candidate.artifacts[1],
            visualReviewArtifact: candidate.artifacts[2],
            beforeViewport: candidate.artifacts[0],
            afterViewport: candidate.artifacts[0],
            beforeFullPage: candidate.artifacts[3],
            afterFullPage: {
                artifactId: 'unowned-after-full',
                kind: 'screenshot',
                path: 'unowned.png',
            },
        };
        candidate.rejectedCandidates = [
            {
                experimentId: 'another-experiment',
                phase: 'B',
                candidateDigest: FIXTURE_CANDIDATE_DIGEST,
                reasonCodes: ['visual_rejected'],
            },
        ];

        expect(() => recorder.completePhase(token, candidate)).toThrow(/artifact|boundary/u);
    });

    it('records a candidate binding whose baseline and candidate phases have no overview', () => {
        // The browser cannot capture an overview of a very tall document; the tiles carry the
        // proof, so the binding names both viewports and no overview.
        const recorder = new FilteringEnvironmentExecutionRecorder('run-6', host());
        recorder.registerAdapter(state);
        for (const phase of ['A', 'B'] as const) {
            const token = recorder.beginPhase({
                runId: 'run-6',
                experimentId: 'experiment-tall',
                phase,
            });
            recorder.bindPhaseLease(token, lease(phase), state);
            recorder.completePhase(token, completion(`session-${phase}`));
        }
        const token = recorder.beginPhase({
            runId: 'run-6',
            experimentId: 'experiment-tall',
            phase: 'C',
        });
        recorder.bindPhaseLease(token, lease('C'), state);
        const validationArtifactId = `validation-${FIXTURE_CANDIDATE_DIGEST.slice(0, 12)}`;
        const candidate = completion('session-C');
        candidate.artifacts.push(
            { artifactId: validationArtifactId, kind: 'validation', path: 'validation.json' },
            { artifactId: 'vision-C', kind: 'vision', path: 'vision.json' },
        );
        const beforeViewport = {
            artifactId: 'session-B-viewport',
            kind: 'screenshot' as const,
            path: 'viewport.png',
        };
        candidate.vision = { artifactId: 'vision-C', verdict: 'verified' };
        candidate.candidateValidation = {
            validationArtifactId,
            candidateDigest: FIXTURE_CANDIDATE_DIGEST,
            verified: true,
            screenshotArtifactIds: ['session-B-viewport', 'session-C-viewport'],
            validationArtifact: candidate.artifacts[1],
            visualReviewArtifact: candidate.artifacts[2],
            beforeViewport,
            afterViewport: candidate.artifacts[0],
        };
        candidate.visualReview = {
            verdict: 'verified',
            symptom: 'resolved',
            symptomScope: 'The reported advertisement.',
            adLayoutResidue: 'absent',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'session-B-viewport',
                    landmark: 'Article body',
                    description: 'The advertisement is visible.',
                },
            ],
            remainingInstances: [],
            pageIntegrity: 'intact',
            validationArtifactId,
            candidateRuleHash: FIXTURE_CANDIDATE_DIGEST,
            beforeViewportArtifactId: 'session-B-viewport',
            afterViewportArtifactId: 'session-C-viewport',
            beforeFullPageArtifactId: null,
            afterFullPageArtifactId: null,
            model: 'vision-model',
            rationale: 'The advertisement disappeared without visible page damage.',
            observedDamage: [],
        };

        const evidence = recorder.completePhase(token, candidate);

        expect(evidence.completion).toMatchObject({
            kind: 'observed',
            candidateValidation: { verified: true, beforeViewport, afterViewport: {} },
        });
    });

    it('cannot finalize before cleanup and emits one immutable canonical execution afterward', () => {
        const recorder = new FilteringEnvironmentExecutionRecorder('run-6', host());
        recorder.registerAdapter(state);
        expect(() =>
            recorder.finalize({ status: 'inconclusive', candidateDigest: null, failure: null }),
        ).toThrow(/cleanup/u);

        recorder.recordCleanup({
            adapterState: { ...state, lifecycle: 'cleaned', cleanup: successfulCleanup },
            drain: { attempted: 0, closed: 0, failed: 0, failures: [] },
            cleanup: successfulCleanup,
        });
        const execution = recorder.finalize({
            status: 'inconclusive',
            candidateDigest: null,
            failure: null,
        });

        expect(execution).toMatchObject({
            recorderVersion: 1,
            runId: 'run-6',
            kind: 'browser_extension',
            cleanup: { completed: true },
        });
        expect(() =>
            recorder.finalize({ status: 'inconclusive', candidateDigest: null, failure: null }),
        ).toThrow(/finalized/u);
    });

    it('requires an exact post-cleanup adapter snapshot and preserves combined failures', () => {
        const mismatched = new FilteringEnvironmentExecutionRecorder('run-6', host());
        mismatched.registerAdapter(state);
        expect(() =>
            mismatched.recordCleanup({
                adapterState: { ...state, lifecycle: 'cleaned', cleanup: null },
                drain: { attempted: 0, closed: 0, failed: 0, failures: [] },
                cleanup: successfulCleanup,
            }),
        ).toThrow(/snapshot|receipt|state/u);

        const recorder = new FilteringEnvironmentExecutionRecorder('run-6', host());
        recorder.registerAdapter(state);
        const investigationFailure = {
            code: 'phase_proof_unavailable' as const,
            stage: 'phase' as const,
            detail: 'The reported symptom could not be bound to complete phase evidence.',
        };
        const cleanupFailure = {
            code: 'cleanup_failed' as const,
            stage: 'cleanup' as const,
            detail: 'The Extension adapter finalizer did not complete.',
        };
        const failedCleanup: EnvironmentCleanupReceipt = {
            attempted: true,
            completed: false,
            finalizerAttempts: 1,
            finalizerCompleted: 0,
            finalizerFailed: 1,
            failures: [cleanupFailure],
        };
        recorder.recordCleanup({
            adapterState: {
                ...state,
                lifecycle: 'cleanup_failed',
                cleanup: failedCleanup,
            },
            drain: { attempted: 2, closed: 1, failed: 1, failures: [cleanupFailure] },
            cleanup: failedCleanup,
        });

        const execution = recorder.finalize({
            status: 'capability_limited',
            candidateDigest: null,
            failure: investigationFailure,
        });

        expect(execution.investigationDisposition).toEqual({
            status: 'capability_limited',
            candidateDigest: null,
            failure: investigationFailure,
        });
        expect(execution.disposition).toMatchObject({ status: 'failed' });
        expect(execution.secondaryFailures).toEqual([investigationFailure, cleanupFailure]);
        expect(execution.drain).toMatchObject({ attempted: 2, closed: 1, failed: 1 });
        expect(execution.cleanup).toMatchObject({
            finalizerAttempts: 1,
            finalizerCompleted: 0,
            finalizerFailed: 1,
        });
    });
});
