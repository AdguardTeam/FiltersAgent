import { describe, expect, it } from 'vitest';
import type { CandidateVisualReview } from '../../src/types/candidate-visual-review';
import type {
    EnvironmentArtifactReference,
    EnvironmentPhaseEvidence,
    FilteringEnvironmentExecution,
    ValidatorObservedPhaseCompletion,
} from '../../src/environment/filtering-environment';
import { BlockerVerificationMethod } from '../../src/environment/environment-proofs';
import { projectEnvironmentResult } from '../../src/environment/environment-result-projection';

const baselineDigest = 'd'.repeat(64);
const candidateDigest = 'c'.repeat(64);
const validationArtifactId = 'validation-cccccccccccc';

// A prepared release build records one version string — manifest.json's own.
const preparedManifestVersion = '5.5.2.3';

const actualContext = {
    kind: 'browser_extension' as const,
    product: 'AdGuard Browser Extension',
    browser: 'CloakBrowser Chromium',
    productVersion: preparedManifestVersion,
};

const cliActualContext = {
    kind: 'adguard_cli' as const,
    product: 'AdGuard CLI',
    browser: 'CloakBrowser Chromium',
    productVersion: '1.4.13',
};

const provenance = {
    source: 'pinned_release' as const,
    extensionPath: '/tmp/cache/extensions/prebuilt/v5.5.2.3/unpacked',
    manifestVersion: 3 as const,
    extensionSourceSha256: 'e'.repeat(64),
    extensionSourceTag: 'v5.5.2.3',
};

/**
 * Build a schema-valid visual decision bound to the canonical B/C screenshots.
 *
 * @param verified - Whether the candidate passed visual review.
 * @returns Complete visual decision.
 */
function visualReview(verified: boolean): CandidateVisualReview {
    const remainingInstances: CandidateVisualReview['remainingInstances'] = [];
    if (!verified) {
        remainingInstances.push({
            artifactId: 'viewport-C',
            landmark: 'Article body',
            description: 'The advertisement remains visible.',
        });
    }
    return {
        verdict: verified ? 'verified' : 'rejected',
        symptom: verified ? 'resolved' : 'not_resolved',
        symptomScope: 'The reported advertisement.',
        adLayoutResidue: verified ? 'absent' : 'present',
        coverageComplete: true,
        beforeInstances: [
            {
                artifactId: 'viewport-B',
                landmark: 'Article body',
                description: 'The advertisement is visible.',
            },
        ],
        remainingInstances,
        pageIntegrity: 'intact',
        validationArtifactId,
        candidateRuleHash: candidateDigest,
        beforeViewportArtifactId: 'viewport-B',
        afterViewportArtifactId: 'viewport-C',
        beforeFullPageArtifactId: 'full-B',
        afterFullPageArtifactId: 'full-C',
        model: 'vision-model',
        rationale: verified
            ? 'The advertisement disappeared without visible page damage.'
            : 'The advertisement remains visible.',
        observedDamage: [],
    };
}

/**
 * Build one phase with phase-owned browser artifacts.
 *
 * @param value - A/B/C phase identity.
 * @param experimentId - Candidate experiment identity.
 * @param options - Optional completion and candidate controls.
 * @returns Canonical phase evidence fixture.
 */
function phase(
    value: 'A' | 'B' | 'C',
    experimentId = 'experiment-1',
    options: {
        candidateVerified?: boolean;
        failed?: boolean;
        kind?: 'browser_extension' | 'adguard_cli';
    } = {},
): EnvironmentPhaseEvidence {
    const kind = options.kind ?? 'browser_extension';
    let extension: EnvironmentPhaseEvidence['proof']['extension'] = null;
    if (kind === 'browser_extension' && value !== 'A') {
        extension = {
            packageVersion: preparedManifestVersion,
            manifestVersion: preparedManifestVersion,
            profileKind: 'agent_selected' as const,
            enabledListKeys: ['adguard:2'],
            activeRulesetListKeys: ['adguard:2'],
            stealthEnabled: false,
            userRulesDigest: value === 'C' ? candidateDigest : null,
            application: {
                method: BlockerVerificationMethod.ExtensionState,
                appliedRules: value === 'C' ? ['example.test##.ad'] : [],
                actionLog:
                    value === 'C'
                        ? [
                              {
                                  tool: 'read_user_rules',
                                  ok: true,
                                  summary: 'Read the user rules back after the steps.',
                              },
                          ]
                        : [
                              {
                                  tool: 'open_options_page',
                                  ok: true,
                                  summary: 'Plugged the prepared baseline lists.',
                              },
                          ],
            },
            provenance,
        };
    }
    let filteringState: EnvironmentPhaseEvidence['proof']['filteringState'];
    if (value === 'A') {
        filteringState = 'disabled';
    } else if (value === 'B') {
        filteringState = 'published_baseline';
    } else {
        filteringState = 'published_baseline_plus_candidate';
    }
    const proof = {
        leaseId: `lease-${experimentId}-${value}`,
        adapterStateDigest: 'a'.repeat(64),
        phase: value,
        filteringState,
        sessionId: `session-${experimentId}-${value}`,
        actualContext: kind === 'adguard_cli' ? { ...cliActualContext } : { ...actualContext },
        baselineDigest: value === 'A' ? null : baselineDigest,
        candidateDigest: value === 'C' ? candidateDigest : null,
        extension,
        ...(kind === 'adguard_cli'
            ? {
                  cli: {
                      cliVersion: '1.4.13',
                      enabledListKeys: value === 'A' ? [] : ['adguard:2'],
                      coenabledListKeys: [],
                      userFilterEnabled: value === 'C',
                  },
              }
            : {}),
    };
    if (options.failed) {
        return {
            runId: 'run-6',
            experimentId,
            phase: value,
            proof,
            completion: {
                kind: 'failed',
                sessionId: proof.sessionId,
                limitation: {
                    code: 'phase_proof_unavailable',
                    stage: 'phase',
                    detail: 'The phase could not collect browser evidence.',
                },
            },
        };
    }
    const candidateArtifacts: EnvironmentArtifactReference[] = [];
    let candidateValidation: ValidatorObservedPhaseCompletion['candidateValidation'] = null;
    if (value === 'C') {
        candidateArtifacts.push(
            {
                artifactId: validationArtifactId,
                kind: 'validation',
                path: '/artifacts/factual-validation-cccccccccccc.json',
            },
            {
                artifactId: 'visual-review-cccccccccccc',
                kind: 'vision',
                path: '/artifacts/candidate-visual-review-cccccccccccc.json',
            },
        );
        candidateValidation = {
            validationArtifactId,
            candidateDigest,
            candidateRule: 'example.test##.ad',
            verified: options.candidateVerified ?? true,
            screenshotArtifactIds: ['viewport-B', 'viewport-C', 'full-B', 'full-C'],
            validationArtifact: candidateArtifacts[0],
            visualReviewArtifact: candidateArtifacts[1],
            beforeViewport: {
                artifactId: 'viewport-B',
                kind: 'screenshot',
                path: '/artifacts/viewport-B.png',
            },
            afterViewport: {
                artifactId: 'viewport-C',
                kind: 'screenshot',
                path: '/artifacts/viewport-C.png',
            },
            beforeFullPage: {
                artifactId: 'full-B',
                kind: 'screenshot',
                path: '/artifacts/full-B.png',
            },
            afterFullPage: {
                artifactId: 'full-C',
                kind: 'screenshot',
                path: '/artifacts/full-C.png',
            },
        };
    }
    return {
        runId: 'run-6',
        experimentId,
        phase: value,
        proof,
        completion: {
            kind: 'observed',
            sessionId: proof.sessionId,
            targetUrl: 'https://example.test/',
            targetObservation: {
                symptomPresent: value !== 'C' || options.candidateVerified === false,
                pageUsable: true,
            },
            navigationVerified: true,
            artifacts: [
                {
                    artifactId: `viewport-${value}`,
                    kind: 'screenshot',
                    path: `/artifacts/viewport-${value}.png`,
                },
                {
                    artifactId: `full-${value}`,
                    kind: 'screenshot',
                    path: `/artifacts/full-${value}.png`,
                },
                {
                    artifactId: `tile-${value}`,
                    kind: 'screenshot',
                    path: `/artifacts/tile-${value}.png`,
                },
                ...candidateArtifacts,
            ],
            vision: null,
            candidateValidation,
            rejectedCandidates: [],
            profile: {
                viewport: 'desktop',
                locale: 'en-US',
                timezone: 'UTC',
                userAgentProfile: 'Chromium',
                consentStrategy: 'untouched',
            },
            captures: [
                {
                    visionVerified: true,
                    viewportArtifactId: `viewport-${value}`,
                    viewport: `/artifacts/viewport-${value}.png`,
                    fullPageOverviewArtifactId: `full-${value}`,
                    fullPageOverview: `/artifacts/full-${value}.png`,
                    tileArtifactIds: [`tile-${value}`],
                    tiles: [`/artifacts/tile-${value}.png`],
                    coverageComplete: true,
                    reporterSymptomPresence: value === 'C' ? 'absent' : 'present',
                },
            ],
            ...(value === 'C'
                ? { visualReview: visualReview(options.candidateVerified ?? true) }
                : {}),
        },
    };
}

/**
 * Build one finalized canonical execution fixture.
 *
 * @param phases - Ordered canonical phases.
 * @param disposition - Final disposition override.
 * @returns Environment execution fixture.
 */
function execution(
    phases: EnvironmentPhaseEvidence[] = [phase('A'), phase('B'), phase('C')],
    disposition: FilteringEnvironmentExecution['disposition'] = {
        status: 'verified',
        candidateDigest,
        failure: null,
    },
    kind: 'browser_extension' | 'adguard_cli' = 'browser_extension',
): FilteringEnvironmentExecution {
    return structuredClone({
        recorderVersion: 1,
        runId: 'run-6',
        kind,
        actualContext: kind === 'adguard_cli' ? { ...cliActualContext } : { ...actualContext },
        capabilities: [
            'browser_navigation',
            'filtering_control',
            'baseline_integrity',
            'phase_proof',
        ],
        preparation: null,
        baseline: {
            environment: kind,
            acquiredAt: '2026-07-24T00:00:00.000Z',
            enabledListKeys: ['adguard:2'],
            resources: [
                {
                    listKey: 'adguard:2',
                    rulesetId: 'ruleset_2',
                    path: 'filters/declarative/ruleset_2/ruleset_2.json',
                    version: null,
                    byteCount: 42,
                    sha256: 'e'.repeat(64),
                },
            ],
            aggregateDigest: baselineDigest,
        },
        phases,
        rejectedCandidates: phases.flatMap((item) =>
            item.completion.kind === 'observed' ? item.completion.rejectedCandidates : [],
        ),
        drain: { attempted: 0, closed: 0, failed: 0, failures: [] },
        cleanup: {
            attempted: true,
            completed: true,
            finalizerAttempts: 0,
            finalizerCompleted: 0,
            finalizerFailed: 0,
            failures: [],
        },
        investigationDisposition: {
            status: 'verified',
            candidateDigest,
            failure: null,
        },
        secondaryFailures: [],
        disposition,
    });
}

describe('projectEnvironmentResult', () => {
    it('selects the latest matching verified A/B/C experiment and binds canonical artifacts', () => {
        const older = ['A', 'B', 'C'].map((value) =>
            phase(value as 'A' | 'B' | 'C', 'older', { failed: true }),
        );
        const selected = ['A', 'B', 'C'].map((value) =>
            phase(value as 'A' | 'B' | 'C', 'selected'),
        );

        const projected = projectEnvironmentResult(execution([...older, ...selected]));

        expect(projected?.browserSessions.map((session) => session.sessionId)).toEqual([
            'session-selected-A',
            'session-selected-B',
            'session-selected-C',
        ]);
        expect(projected?.candidateValidationEvidence).toMatchObject({
            validationArtifactId,
            sessionId: 'session-selected-C',
            beforeViewport: { artifactId: 'viewport-B' },
            afterViewport: { artifactId: 'viewport-C' },
        });
        expect(projected?.candidateApplicationEvidence).toEqual({
            method: BlockerVerificationMethod.ExtensionState,
            appliedRules: ['example.test##.ad'],
            actionLog: [
                {
                    tool: 'read_user_rules',
                    ok: true,
                    summary: 'Read the user rules back after the steps.',
                },
            ],
        });
        expect(projected?.artifactPaths.verifiedCandidateScreenshots).toEqual({
            before: '/artifacts/viewport-B.png',
            after: '/artifacts/viewport-C.png',
            beforeFullPage: '/artifacts/full-B.png',
            afterFullPage: '/artifacts/full-C.png',
        });
    });

    it('binds a verified candidate whose baseline and candidate phases have no overview', () => {
        // The browser cannot capture an overview of a very tall document; the tiles carry the
        // proof, so the verified candidate publishes both viewports and no overview.
        const phases = (['A', 'B', 'C'] as const).map((value) => {
            const evidence = phase(value);
            if (evidence.completion.kind !== 'observed') {
                throw new Error('the fixture phase is observed');
            }
            const completion = evidence.completion;
            completion.artifacts = completion.artifacts.filter(
                (artifact) => !artifact.artifactId.startsWith('full-'),
            );
            for (const capture of completion.captures ?? []) {
                capture.fullPageOverviewArtifactId = null;
                capture.fullPageOverview = null;
            }
            if (completion.candidateValidation && completion.visualReview) {
                delete completion.candidateValidation.beforeFullPage;
                delete completion.candidateValidation.afterFullPage;
                completion.candidateValidation.screenshotArtifactIds = ['viewport-B', 'viewport-C'];
                completion.visualReview.beforeFullPageArtifactId = null;
                completion.visualReview.afterFullPageArtifactId = null;
            }
            return evidence;
        });

        const projected = projectEnvironmentResult(execution(phases));

        expect(projected?.candidateValidationEvidence).toMatchObject({
            beforeViewport: { artifactId: 'viewport-B' },
            afterViewport: { artifactId: 'viewport-C' },
        });
        expect(projected?.candidateValidationEvidence).not.toHaveProperty('beforeFullPage');
        expect(projected?.artifactPaths.verifiedCandidateScreenshots).toEqual({
            before: '/artifacts/viewport-B.png',
            after: '/artifacts/viewport-C.png',
        });
    });

    it('keeps the accepted candidate when a later experiment ended inconclusive', () => {
        // Run 237885 (2026-08-10): the verified candidate experiment was followed by two
        // honest baseline_symptom_absent attempts for another reported element. The finalize
        // step pins the disposition to the accepted candidate's digest; the projection must
        // then answer for that experiment, not for the inconclusive one that ran last.
        const verified = ['A', 'B', 'C'].map((value) =>
            phase(value as 'A' | 'B' | 'C', 'accepted'),
        );
        // The later experiment observed its own artifacts; rename them so both experiments
        // coexist in one execution the way the recorder produces them.
        const laterInconclusive = ['A', 'B'].map(
            (value) =>
                JSON.parse(
                    JSON.stringify(phase(value as 'A' | 'B', 'later-absent')).replaceAll(
                        /(viewport-|full-|tile-)/gu,
                        'later-$1',
                    ),
                ) as EnvironmentPhaseEvidence,
        );

        const projected = projectEnvironmentResult(
            execution([...verified, ...laterInconclusive], {
                status: 'verified',
                candidateDigest,
                failure: null,
            }),
        );

        expect(projected?.browserSessions.map((session) => session.sessionId)).toEqual([
            'session-accepted-A',
            'session-accepted-B',
            'session-accepted-C',
        ]);
        expect(projected?.candidateValidationEvidence).toMatchObject({
            sessionId: 'session-accepted-C',
        });
    });

    it('rejects baseline, experiment, artifact ownership, and global identity divergence', () => {
        const mismatches: Array<(input: FilteringEnvironmentExecution) => void> = [
            (input) => {
                input.baseline!.aggregateDigest = 'e'.repeat(64);
            },
            (input) => {
                input.phases.splice(0, 1);
            },
            (input) => {
                const completion = input.phases[2].completion;
                if (completion.kind === 'observed') {
                    completion.candidateValidation!.beforeViewport!.artifactId = 'viewport-C';
                    completion.candidateValidation!.screenshotArtifactIds[0] = 'viewport-C';
                }
            },
            (input) => {
                const completion = input.phases[2].completion;
                if (completion.kind === 'observed') {
                    completion.artifacts[0].artifactId = 'viewport-B';
                }
            },
            (input) => {
                const baseline = input.phases[1].completion;
                const candidate = input.phases[2].completion;
                if (baseline.kind === 'observed' && candidate.kind === 'observed') {
                    const validation = candidate.artifacts.splice(3, 1)[0];
                    baseline.artifacts.push(validation);
                }
            },
        ];
        for (const mutate of mismatches) {
            const input = execution();
            mutate(input);
            expect(projectEnvironmentResult(input)).toBeNull();
        }
    });

    it('keeps a failed canonical phase while omitting it from compatibility sessions', () => {
        const projected = projectEnvironmentResult(
            execution([phase('A'), phase('B', 'experiment-1', { failed: true })], {
                status: 'capability_limited',
                candidateDigest: null,
                failure: {
                    code: 'phase_proof_unavailable',
                    stage: 'phase',
                    detail: 'The phase could not collect browser evidence.',
                },
            }),
        );

        expect(projected?.browserSessions.map((session) => session.sessionId)).toEqual([
            'session-experiment-1-A',
        ]);
        expect(projected?.candidateValidationEvidence).toBeUndefined();
    });

    it('projects an adguard_cli experiment without any extension fields', () => {
        const cli = { kind: 'adguard_cli' as const };
        const phases = [
            phase('A', 'experiment-1', cli),
            phase('B', 'experiment-1', cli),
            phase('C', 'experiment-1', { ...cli, candidateVerified: false }),
        ];

        const projected = projectEnvironmentResult(
            execution(
                phases,
                { status: 'inconclusive', candidateDigest: null, failure: null },
                'adguard_cli',
            ),
        );

        expect(projected?.browserSessions.map((session) => session.sessionId)).toEqual([
            'session-experiment-1-A',
            'session-experiment-1-B',
            'session-experiment-1-C',
        ]);
        // No extension ever runs in this environment, so no session may claim one.
        expect(
            projected?.browserSessions.every((session) => session.extensionMode === 'none'),
        ).toBe(true);
        expect(
            projected?.browserSessions.every(
                (session) =>
                    session.extensionProvenance === undefined &&
                    session.settingsEvidence === undefined,
            ),
        ).toBe(true);
        expect(projected?.extensionProvenance).toBeUndefined();
        expect(projected?.settingsEvidence).toBeUndefined();
        // The proxy environment applies no rule for the model, so no phase ever records an
        // application and neither may the projection.
        expect(projected?.candidateApplicationEvidence).toBeUndefined();
        expect(projected?.candidateVisualReview?.verdict).toBe('rejected');
    });

    it('binds a verified adguard_cli candidate through its CLI proof', () => {
        const cli = { kind: 'adguard_cli' as const };
        const phases = [
            phase('A', 'experiment-1', cli),
            phase('B', 'experiment-1', cli),
            phase('C', 'experiment-1', cli),
        ];

        const projected = projectEnvironmentResult(execution(phases, undefined, 'adguard_cli'));

        expect(projected?.candidateValidationEvidence).toMatchObject({
            validationArtifactId,
            sessionId: 'session-experiment-1-C',
            cli: {
                cliVersion: '1.4.13',
                enabledListKeys: ['adguard:2'],
                userFilterEnabled: true,
            },
            beforeViewport: { artifactId: 'viewport-B' },
            afterViewport: { artifactId: 'viewport-C' },
        });
        expect(projected?.candidateValidationEvidence?.extensionProvenance).toBeUndefined();
        expect(projected?.candidateValidationEvidence?.settingsEvidence).toBeUndefined();
        expect(projected?.artifactPaths.verifiedCandidateScreenshots).toEqual({
            before: '/artifacts/viewport-B.png',
            after: '/artifacts/viewport-C.png',
            beforeFullPage: '/artifacts/full-B.png',
            afterFullPage: '/artifacts/full-C.png',
        });
    });

    it('rejects a CLI experiment whose proof version diverges from the actual context', () => {
        const cli = { kind: 'adguard_cli' as const };
        const input = execution(
            [
                phase('A', 'experiment-1', cli),
                phase('B', 'experiment-1', cli),
                phase('C', 'experiment-1', { ...cli, candidateVerified: false }),
            ],
            { status: 'inconclusive', candidateDigest: null, failure: null },
            'adguard_cli',
        );
        for (const item of input.phases) {
            if (item.phase !== 'A') {
                item.proof.cli!.cliVersion = '9.9.9';
            }
        }

        expect(projectEnvironmentResult(input)).toBeNull();
    });

    it('projects rejected visual evidence only from a complete canonical C binding', () => {
        const rejectedC = phase('C', 'experiment-1', { candidateVerified: false });
        const projected = projectEnvironmentResult(
            execution([phase('A'), phase('B'), rejectedC], {
                status: 'inconclusive',
                candidateDigest: null,
                failure: null,
            }),
        );

        expect(projected?.candidateValidationEvidence).toBeUndefined();
        expect(projected?.candidateVisualReview?.verdict).toBe('rejected');
        // An attempt the vision review rejected still applied its rule through the instruction's
        // steps; the recorded what-was-done evidence belongs to that attempt either way.
        expect(projected?.candidateApplicationEvidence).toEqual({
            method: BlockerVerificationMethod.ExtensionState,
            appliedRules: ['example.test##.ad'],
            actionLog: [
                {
                    tool: 'read_user_rules',
                    ok: true,
                    summary: 'Read the user rules back after the steps.',
                },
            ],
        });
        expect(projected?.artifactPaths.rejectedCandidateScreenshots).toMatchObject({
            candidateRule: 'example.test##.ad',
            validationArtifactId,
            rejectionReasons: ['candidate_validation_not_verified'],
            visualReviewArtifactPath: '/artifacts/candidate-visual-review-cccccccccccc.json',
        });

        const incomplete = execution([phase('A'), phase('B'), rejectedC], {
            status: 'inconclusive',
            candidateDigest: null,
            failure: null,
        });
        const completion = incomplete.phases[2].completion;
        if (completion.kind === 'observed') {
            delete completion.candidateValidation!.candidateRule;
        }
        expect(
            projectEnvironmentResult(incomplete)?.artifactPaths.rejectedCandidateScreenshots,
        ).toBeUndefined();
    });
});
