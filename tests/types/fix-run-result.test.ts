import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
    FixRunResultSchema,
    RepositoryEditSchema,
    noPatchVerdictIsSessionBound,
    type FixRunResult,
} from '../../src/types/fix-run-result';
import { MAX_MISSING_INFORMATION_ENTRIES } from '../../src/types/missing-information';
import { EnvironmentSelectionHost } from '../../src/environment/environment-selection';
import {
    cliExecutorDescriptor,
    extensionExecutorDescriptor,
} from '../environment/test-filtering-environment-fixtures';
import type {
    EnvironmentPhaseEvidence,
    FilteringEnvironmentExecution,
} from '../../src/environment/filtering-environment';
import { BlockerVerificationMethod } from '../../src/environment/environment-proofs';
import { projectEnvironmentResult } from '../../src/environment/environment-result-projection';
import type { IssueFacts } from '../../src/types/issue-facts';
import type { UpstreamSourceDrift } from '../../src/types/upstream-source-drift';

const sessionProfile = {
    viewport: 'desktop' as const,
    locale: 'en-US',
    timezone: 'UTC',
    userAgentProfile: 'Chromium',
    consentStrategy: 'untouched' as const,
};

describe('RepositoryEditSchema', () => {
    it.each([
        {
            kind: 'replace',
            line: 2,
            originalRule: 'example.com##.old',
            replacementRule: 'example.com##.new',
        },
        {
            kind: 'remove',
            line: 2,
            originalRule: 'example.com##.old',
        },
    ])('accepts an exact $kind source edit', (edit) => {
        expect(v.parse(RepositoryEditSchema, edit)).toEqual(edit);
    });

    it('rejects multiline exact source edits', () => {
        expect(() =>
            v.parse(RepositoryEditSchema, {
                kind: 'remove',
                line: 1,
                originalRule: 'one\ntwo',
            }),
        ).toThrow();
    });
});

function readyExtensionSelection(productVersion: string) {
    const facts: IssueFacts = {
        issueNumber: 4,
        issueUrl: 'https://github.com/AdguardTeam/AdguardFilters/issues/4',
        reportedSiteUrls: ['https://example.com/article'],
        labels: ['T: Ads'],
        declaredIssueType: 'Ads',
        problemType: 'ads',
        product: 'AdGuard Browser Extension',
        browser: 'Chrome',
        enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
        screenshots: [],
    };
    const host = new EnvironmentSelectionHost(facts, [
        extensionExecutorDescriptor(),
        cliExecutorDescriptor(),
    ]);
    host.select({
        kind: 'browser_extension',
        requiredCapabilities: ['browser_navigation'],
        intent: {
            issueType: 'ads',
            rationale: 'The issue reports a visible advertisement.',
            confidence: 1,
            evidence: [{ source: 'issue_body', observation: 'An advertisement is visible.' }],
            conflicts: [],
        },
        rationale: 'Use the Browser Extension environment.',
        confidence: 1,
    });
    host.bindActualContext('browser_extension', {
        product: 'AdGuard Browser Extension',
        browser: 'CloakBrowser Chromium',
        productVersion,
    });
    return host.snapshot()!;
}

function cliSelection(state: 'ready' | 'limited') {
    const facts: IssueFacts = {
        issueNumber: 4,
        issueUrl: 'https://github.com/AdguardTeam/AdguardFilters/issues/4',
        reportedSiteUrls: ['https://example.com/article'],
        labels: ['T: Ads', 'N: AdGuard for Windows'],
        declaredIssueType: 'Ads',
        problemType: 'ads',
        product: 'AdGuard for Windows',
        browser: 'Edge',
        enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
        screenshots: [],
    };
    const host = new EnvironmentSelectionHost(facts, [
        extensionExecutorDescriptor(),
        cliExecutorDescriptor(),
    ]);
    host.select({
        kind: 'adguard_cli',
        requiredCapabilities: [],
        intent: {
            issueType: 'ads',
            rationale: 'The issue reports ordinary website filtering.',
            confidence: 1,
            evidence: [{ source: 'issue_body', observation: 'The desktop product is reported.' }],
            conflicts: [],
        },
        rationale: 'Use the CLI approximation selected by the agent.',
        confidence: 1,
    });
    if (state === 'limited') {
        host.attachExecutorPreparation({
            ready: false,
            limitation: {
                stage: 'provenance',
                code: 'version_provenance_unavailable',
                detail: 'The verified binary did not report exact build provenance.',
            },
        });
        return host.snapshot()!;
    }
    host.attachExecutorPreparation({
        ready: true,
        provenance: {
            source: 'official_release',
            product: 'AdGuard CLI',
            version: '1.4.13',
            digestB32: 'digestb32examplevalue0123456789abcdefghijklmnopqrstuvwxyz',
        },
    });
    return host.snapshot()!;
}

describe('FixRunResultSchema CLI installation provenance', () => {
    it('persists strict path-free ready and limited preparation results', () => {
        const base = {
            issueNumber: 4,
            domain: 'example.com',
            runStatus: 'analysis_only' as const,
            requestedBrowserMode: 'auto' as const,
            effectiveMode: 'reasoning' as const,
            verificationStatus: 'unavailable' as const,
            fallbackReason: null,
            fallbackDetail: null,
            candidatePatch: null,
            artifactPaths: {
                screenshots: [],
                domSnapshot: null,
                har: null,
                trace: null,
            },
            reasoning: 'The installation-only slice produced no filtering claim.',
            repository: null,
            baseSha: null,
        };
        const ready = v.parse(FixRunResultSchema, {
            ...base,
            environmentSelection: cliSelection('ready'),
        });
        expect(JSON.stringify(ready)).not.toContain('/private/tmp');
        expect(ready.environmentSelection?.cliPreparation).toMatchObject({
            state: 'ready',
            provenance: {
                source: 'official_release',
                product: 'AdGuard CLI',
                version: '1.4.13',
            },
        });

        const limited = v.parse(FixRunResultSchema, {
            ...base,
            runStatus: 'capability_limited',
            environmentSelection: cliSelection('limited'),
        });
        expect(limited.environmentSelection?.cliPreparation).toMatchObject({
            state: 'limited',
            limitation: { code: 'version_provenance_unavailable' },
        });

        const forged = structuredClone(ready);
        forged.environmentSelection!.actual!.productVersion = '9.9.9';
        expect(v.safeParse(FixRunResultSchema, forged).success).toBe(false);
    });

    it('keeps parsing an artifact whose limit codes carry the pre-registry literal', () => {
        const base = {
            issueNumber: 4,
            domain: 'example.com',
            runStatus: 'capability_limited' as const,
            requestedBrowserMode: 'auto' as const,
            effectiveMode: 'reasoning' as const,
            verificationStatus: 'unavailable' as const,
            fallbackReason: null,
            fallbackDetail: null,
            candidatePatch: null,
            artifactPaths: {
                screenshots: [],
                domSnapshot: null,
                har: null,
                trace: null,
            },
            reasoning: 'The locked executor could not execute for the run.',
            repository: null,
            baseSha: null,
        };
        // A persisted artifact written before the executor vocabulary renamed the unavailable
        // code must still parse; fresh writes carry only the renamed member.
        const historical = structuredClone(cliSelection('limited'));
        historical.capabilityLimits[0]!.code = 'adguard_cli_adapter_not_available';
        historical.descriptor!.limitationCode = 'adguard_cli_adapter_not_available';
        const parsed = v.parse(FixRunResultSchema, {
            ...base,
            environmentSelection: historical,
        });
        expect(parsed.environmentSelection?.capabilityLimits[0]?.code).toBe(
            'adguard_cli_adapter_not_available',
        );
        expect(parsed.environmentSelection?.descriptor?.limitationCode).toBe(
            'adguard_cli_adapter_not_available',
        );

        const fresh = structuredClone(cliSelection('limited'));
        fresh.capabilityLimits[0]!.code = 'executor_unavailable';
        fresh.descriptor!.limitationCode = 'executor_unavailable';
        expect(JSON.stringify(fresh)).not.toContain('adguard_cli_adapter_not_available');
        expect(
            v.parse(FixRunResultSchema, {
                ...base,
                environmentSelection: fresh,
            }).environmentSelection?.capabilityLimits[0]?.code,
        ).toBe('executor_unavailable');
    });
});

function resultWithSession(overrides: Partial<FixRunResult> = {}): FixRunResult {
    const viewport = '/tmp/run/control-viewport.png';
    const fullPage = '/tmp/run/control-full-page.png';
    const tile = '/tmp/run/control-tile.png';
    return {
        issueNumber: 4,
        domain: 'example.com',
        runStatus: 'not_reproduced',
        requestedBrowserMode: 'on',
        effectiveMode: 'browser',
        verificationStatus: 'verified',
        fallbackReason: null,
        fallbackDetail: null,
        candidatePatch: null,
        browserSessions: [
            {
                sessionId: 'control-session',
                targetUrl: 'https://example.com/article',
                extensionMode: 'none',
                profile: sessionProfile,
                navigationVerified: true,
                fullVisionVerified: true,
                captures: [
                    {
                        visionVerified: true,
                        viewportArtifactId: 'control-viewport',
                        viewport,
                        fullPageOverviewArtifactId: 'control-full-page',
                        fullPageOverview: fullPage,
                        tileArtifactIds: ['control-tile'],
                        tiles: [tile],
                        coverageComplete: true,
                    },
                ],
            },
        ],
        artifactPaths: {
            screenshots: [viewport, fullPage, tile],
            domSnapshot: null,
            har: null,
            trace: null,
        },
        reasoning: 'The inspected control did not reproduce the reported defect.',
        repository: null,
        baseSha: null,
        ...overrides,
    };
}

function alreadyFixedResult(
    controlPresence: 'present' | 'absent',
    preparedPresence: 'present' | 'absent',
): FixRunResult {
    const result = resultWithSession({
        runStatus: 'already_fixed_current',
        verificationStatus: 'partial',
        symptomObservation: 'reproduced',
    });
    result.browserSessions![0].captures[0].reporterSymptomPresence = controlPresence;
    const preparedViewport = '/tmp/run/prepared-viewport.png';
    const preparedFullPage = '/tmp/run/prepared-full-page.png';
    const preparedTile = '/tmp/run/prepared-tile.png';
    result.artifactPaths.screenshots.push(preparedViewport, preparedFullPage, preparedTile);
    const currentExtension = {
        source: 'pinned_release' as const,
        extensionPath: '/tmp/run/prepared-extension',
        manifestVersion: 3 as const,
        extensionSourceSha256: 'e'.repeat(64),
        extensionSourceTag: 'v5.5.2.3',
    };
    result.extensionProvenance = currentExtension;
    result.browserSessions!.push({
        sessionId: 'prepared-session',
        targetUrl: 'https://example.com/article',
        extensionMode: 'prepared',
        profile: sessionProfile,
        selectedSettingsProfileKind: 'agent_selected',
        extensionProvenance: currentExtension,
        settingsEvidence: {
            profileKind: 'agent_selected',
            enabledListKeys: ['adguard:2'],
            activeRulesetListKeys: ['adguard:2'],
            stealthEnabled: false,
            limitsExceeded: false,
        },
        navigationVerified: true,
        fullVisionVerified: true,
        captures: [
            {
                visionVerified: true,
                viewportArtifactId: 'prepared-viewport',
                viewport: preparedViewport,
                fullPageOverviewArtifactId: 'prepared-full-page',
                fullPageOverview: preparedFullPage,
                tileArtifactIds: ['prepared-tile'],
                tiles: [preparedTile],
                coverageComplete: true,
                reporterSymptomPresence: preparedPresence,
            },
        ],
    });
    return result;
}

function configurationSpecificResult(
    reporterKind: 'reported_on_current' | 'agent_selected' | 'report_exact' = 'reported_on_current',
): FixRunResult {
    // Verified configuration_specific binds both prepared sessions to the run's single
    // pinned-release provenance; only current-build profile kinds qualify on the reporter side.
    const extensionProvenance = {
        source: 'pinned_release' as const,
        extensionPath: '/tmp/run/prepared-extension',
        manifestVersion: 3 as const,
        extensionSourceSha256: 'e'.repeat(64),
        extensionSourceTag: 'v5.5.2.3',
    };
    const result = resultWithSession({
        runStatus: 'configuration_specific',
        verificationStatus: 'verified',
        symptomObservation: 'reproduced',
        extensionProvenance,
    });
    result.browserSessions = [
        {
            sessionId: 'reporter-session',
            targetUrl: 'https://example.com/article',
            extensionMode: 'prepared',
            profile: sessionProfile,
            selectedSettingsProfileKind: reporterKind,
            extensionProvenance,
            settingsEvidence: {
                profileKind: reporterKind,
                enabledListKeys: ['adguard:2', 'adguard:238'],
                activeRulesetListKeys: ['adguard:2', 'adguard:238'],
                stealthEnabled: false,
                limitsExceeded: false,
            },
            navigationVerified: true,
            fullVisionVerified: true,
            captures: [
                {
                    visionVerified: true,
                    viewportArtifactId: 'reporter-viewport',
                    viewport: '/tmp/run/reporter-viewport.png',
                    fullPageOverviewArtifactId: 'reporter-full-page',
                    fullPageOverview: '/tmp/run/reporter-full-page.png',
                    tileArtifactIds: ['reporter-tile'],
                    tiles: ['/tmp/run/reporter-tile.png'],
                    coverageComplete: true,
                    reporterSymptomPresence: 'present',
                },
            ],
        },
        {
            sessionId: 'controlled-session',
            targetUrl: 'https://example.com/article',
            extensionMode: 'prepared',
            profile: sessionProfile,
            selectedSettingsProfileKind: 'defaults_plus_required',
            extensionProvenance,
            settingsEvidence: {
                profileKind: 'defaults_plus_required',
                enabledListKeys: ['adguard:2', 'adguard:238'],
                activeRulesetListKeys: ['adguard:2', 'adguard:238'],
                stealthEnabled: false,
                limitsExceeded: false,
            },
            navigationVerified: true,
            fullVisionVerified: true,
            captures: [
                {
                    visionVerified: true,
                    viewportArtifactId: 'controlled-viewport',
                    viewport: '/tmp/run/controlled-viewport.png',
                    fullPageOverviewArtifactId: 'controlled-full-page',
                    fullPageOverview: '/tmp/run/controlled-full-page.png',
                    tileArtifactIds: ['controlled-tile'],
                    tiles: ['/tmp/run/controlled-tile.png'],
                    coverageComplete: true,
                    reporterSymptomPresence: 'absent',
                },
            ],
        },
    ];
    result.artifactPaths.screenshots = result.browserSessions.flatMap((session) =>
        session.captures.flatMap((capture) => [
            capture.viewport!,
            capture.fullPageOverview!,
            ...capture.tiles,
        ]),
    );
    result.settingsEvidence = result.browserSessions[0].settingsEvidence;
    result.configurationComparisonEvidence = {
        extensionProvenance,
        reporter: {
            sessionId: 'reporter-session',
            profileKind: reporterKind,
            reporterSymptomPresence: 'present',
            viewportArtifactId: 'reporter-viewport',
            fullPageOverviewArtifactId: 'reporter-full-page',
            tileArtifactIds: ['reporter-tile'],
        },
        controlled: {
            sessionId: 'controlled-session',
            profileKind: 'defaults_plus_required',
            reporterSymptomPresence: 'absent',
            viewportArtifactId: 'controlled-viewport',
            fullPageOverviewArtifactId: 'controlled-full-page',
            tileArtifactIds: ['controlled-tile'],
        },
    };
    return result;
}

function resultWithCandidateBinding(
    overrides: Partial<
        Pick<
            NonNullable<FixRunResult['candidatePatch']>,
            'rule' | 'ruleType' | 'syntaxKind' | 'filePath'
        >
    > = {},
): FixRunResult {
    const rule = overrides.rule ?? 'example.com##.ad-slot';
    const candidateRuleHash = createHash('sha256').update(rule).digest('hex');
    const validationHash = candidateRuleHash.slice(0, 12);
    const settingsEvidence = {
        profileKind: 'agent_selected' as const,
        enabledListKeys: ['adguard:2'],
        enabledFilters: [{ listKey: 'adguard:2', name: 'AdGuard Base filter' }],
        activeRulesetListKeys: ['adguard:2'],
        stealthEnabled: false,
        limitsExceeded: false,
    };
    const extensionProvenance = {
        source: 'pinned_release' as const,
        extensionPath: '/tmp/run/prepared-extension',
        manifestVersion: 3 as const,
        extensionSourceSha256: 'e'.repeat(64),
        extensionSourceTag: 'v5.5.2.3',
    };
    const paths = {
        before: '/tmp/run/candidate-before.png',
        after: '/tmp/run/candidate-after.png',
        beforeFullPage: '/tmp/run/candidate-before-full-page.png',
        afterFullPage: '/tmp/run/candidate-after-full-page.png',
    };
    const validationArtifactId = `validation-${validationHash}`;
    return {
        issueNumber: 4,
        domain: 'example.com',
        runStatus: 'patch_proposed',
        requestedBrowserMode: 'on',
        effectiveMode: 'browser',
        verificationStatus: 'verified',
        fallbackReason: null,
        fallbackDetail: null,
        environmentSelection: readyExtensionSelection('5.4.3.99'),
        extensionProvenance,
        settingsEvidence,
        browserSessions: [
            {
                sessionId: 'prepared-session',
                targetUrl: 'https://example.com/article',
                extensionMode: 'prepared',
                profile: sessionProfile,
                selectedSettingsProfileKind: 'agent_selected',
                extensionProvenance,
                settingsEvidence,
                navigationVerified: true,
                fullVisionVerified: false,
                captures: [],
            },
        ],
        candidatePatch: {
            rule,
            ruleType: overrides.ruleType ?? 'cosmetic',
            syntaxKind: overrides.syntaxKind ?? 'element_hiding',
            filePath: overrides.filePath ?? 'BaseFilter/sections/foreign.txt',
        },
        candidateVisualReview: {
            verdict: 'verified',
            symptom: 'resolved',
            symptomScope: 'The reporter-visible advertising placeholder.',
            adLayoutResidue: 'absent',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'candidate-before',
                    landmark: 'Article body',
                    description: 'Advertising placeholder is visible.',
                },
            ],
            remainingInstances: [],
            pageIntegrity: 'intact',
            validationArtifactId,
            candidateRuleHash,
            beforeViewportArtifactId: 'candidate-before',
            afterViewportArtifactId: 'candidate-after',
            beforeFullPageArtifactId: 'candidate-before-full-page',
            afterFullPageArtifactId: 'candidate-after-full-page',
            model: 'vision-model',
            rationale: 'The complete symptom disappeared and page integrity remained intact.',
            observedDamage: [],
        },
        candidateValidationEvidence: {
            validationArtifactId,
            sessionId: 'prepared-session',
            extensionProvenance,
            settingsEvidence,
            validationArtifact: {
                artifactId: validationArtifactId,
                path: `/tmp/run/factual-validation-${validationHash}.json`,
            },
            visualReviewArtifact: {
                artifactId: `visual-review-${validationHash}`,
                path: `/tmp/run/candidate-visual-review-${validationHash}.json`,
            },
            beforeViewport: { artifactId: 'candidate-before', path: paths.before },
            afterViewport: { artifactId: 'candidate-after', path: paths.after },
            beforeFullPage: {
                artifactId: 'candidate-before-full-page',
                path: paths.beforeFullPage,
            },
            afterFullPage: {
                artifactId: 'candidate-after-full-page',
                path: paths.afterFullPage,
            },
        },
        artifactPaths: {
            screenshots: Object.values(paths),
            domSnapshot: null,
            har: null,
            trace: null,
            candidateVisualReview: `/tmp/run/candidate-visual-review-${validationHash}.json`,
            verifiedCandidateScreenshots: paths,
        },
        reasoning: 'The prepared extension session verified the exact candidate.',
        repository: null,
        baseSha: null,
    };
}

describe('FixRunResultSchema browser session evidence', () => {
    it('accepts exact canonical projections and rejects an independently edited legacy copy', () => {
        const facts: IssueFacts = {
            issueNumber: 4,
            issueUrl: 'https://github.com/AdguardTeam/AdguardFilters/issues/4',
            reportedSiteUrls: ['https://example.com/article'],
            labels: ['T: Ads'],
            declaredIssueType: 'Ads',
            problemType: 'ads',
            product: 'AdGuard Browser Extension',
            browser: 'Chrome',
            enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
            screenshots: [],
        };
        const host = new EnvironmentSelectionHost(facts, [
            extensionExecutorDescriptor(),
            cliExecutorDescriptor(),
        ]);
        host.select({
            kind: 'browser_extension',
            requiredCapabilities: ['browser_navigation'],
            intent: {
                issueType: 'ads',
                rationale: 'The issue reports a visible advertisement.',
                confidence: 1,
                evidence: [{ source: 'issue_body', observation: 'An advertisement is visible.' }],
                conflicts: [],
            },
            rationale: 'Use the Browser Extension environment.',
            confidence: 1,
        });
        host.bindActualContext('browser_extension', {
            product: 'AdGuard Browser Extension',
            browser: 'CloakBrowser Chromium',
        });
        const source = resultWithSession();
        const capture = source.browserSessions![0].captures[0];
        const actualContext = host.snapshot()!.actual!;
        const execution: FilteringEnvironmentExecution = {
            recorderVersion: 1,
            runId: 'run-4',
            kind: 'browser_extension',
            actualContext,
            capabilities: ['browser_navigation', 'phase_proof'],
            preparation: null,
            baseline: null,
            phases: [
                {
                    runId: 'run-4',
                    experimentId: 'experiment-1',
                    phase: 'A',
                    proof: {
                        leaseId: 'lease-A',
                        adapterStateDigest: 'a'.repeat(64),
                        phase: 'A',
                        filteringState: 'disabled',
                        sessionId: 'control-session',
                        actualContext,
                        baselineDigest: null,
                        candidateDigest: null,
                        extension: null,
                    },
                    completion: {
                        kind: 'observed',
                        sessionId: 'control-session',
                        targetUrl: 'https://example.com/article',
                        targetObservation: { symptomPresent: false, pageUsable: true },
                        navigationVerified: true,
                        artifacts: [
                            {
                                artifactId: 'control-viewport',
                                kind: 'screenshot',
                                path: capture.viewport!,
                            },
                            {
                                artifactId: 'control-full-page',
                                kind: 'screenshot',
                                path: capture.fullPageOverview!,
                            },
                            {
                                artifactId: 'control-tile',
                                kind: 'screenshot',
                                path: capture.tiles[0],
                            },
                        ],
                        vision: null,
                        candidateValidation: null,
                        rejectedCandidates: [],
                        profile: source.browserSessions![0].profile,
                        captures: source.browserSessions![0].captures,
                    },
                },
            ],
            rejectedCandidates: [],
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
                status: 'inconclusive',
                candidateDigest: null,
                failure: null,
            },
            secondaryFailures: [],
            disposition: { status: 'inconclusive', candidateDigest: null, failure: null },
        };
        const projected = projectEnvironmentResult(execution)!;
        const result: FixRunResult = {
            ...source,
            environmentSelection: host.snapshot()!,
            environmentExecution: execution,
            browserSessions: projected.browserSessions,
            artifactPaths: projected.artifactPaths,
        };

        expect(v.safeParse(FixRunResultSchema, result).success).toBe(true);
        result.browserSessions![0].sessionId = 'independently-edited';
        expect(v.safeParse(FixRunResultSchema, result).success).toBe(false);
    });

    it('carries an unobserved settings set as null without disturbing observed arrays', () => {
        const result = resultWithSession();
        result.browserSessions![0].settingsEvidence = {
            profileKind: 'agent_selected',
            enabledListKeys: null,
            activeRulesetListKeys: [],
            stealthEnabled: null,
            limitsExceeded: false,
        };

        const parsed = v.safeParse(FixRunResultSchema, result);

        expect(parsed.success).toBe(true);
        if (!parsed.success) {
            return;
        }
        // The unobserved set round-trips as null; a record holding arrays keeps parsing too.
        expect(parsed.output.browserSessions?.[0]?.settingsEvidence).toEqual({
            profileKind: 'agent_selected',
            enabledListKeys: null,
            activeRulesetListKeys: [],
            stealthEnabled: null,
            limitsExceeded: false,
        });
    });

    it('accepts a typed agent termination only for a failed Host result', () => {
        const failed = resultWithSession({
            runStatus: 'failed',
            verificationStatus: 'partial',
            agentTerminationReason: 'max_iterations_exceeded',
        });
        const conflated = resultWithSession({
            runStatus: 'analysis_only',
            verificationStatus: 'partial',
            agentTerminationReason: 'max_iterations_exceeded',
        });

        expect(v.safeParse(FixRunResultSchema, failed).success).toBe(true);
        expect(v.safeParse(FixRunResultSchema, conflated).success).toBe(false);
    });

    it('locks the exact target and complete browser profile for post-lock replay', () => {
        const result = resultWithSession();
        Object.assign(result.browserSessions![0], {
            targetUrl: 'https://example.com/article?fixture=1',
            profile: {
                viewport: 'mobile',
                locale: 'pl-PL',
                timezone: 'Europe/Warsaw',
                geolocation: { latitude: 52.2297, longitude: 21.0122 },
                proxyRegion: 'PL',
                userAgentProfile: 'Android Chrome',
                consentStrategy: 'reject',
            },
            selectedSettingsProfileKind: 'report_exact',
        });

        const parsed = v.safeParse(FixRunResultSchema, result);

        expect(parsed.success).toBe(true);
        if (!parsed.success) {
            return;
        }
        expect(parsed.output.browserSessions?.[0]).toMatchObject({
            targetUrl: 'https://example.com/article?fixture=1',
            profile: {
                viewport: 'mobile',
                locale: 'pl-PL',
                timezone: 'Europe/Warsaw',
                geolocation: { latitude: 52.2297, longitude: 21.0122 },
                proxyRegion: 'PL',
                userAgentProfile: 'Android Chrome',
                consentStrategy: 'reject',
            },
            selectedSettingsProfileKind: 'report_exact',
        });
    });

    it('accepts a target-unreachable browser fallback separately from a timeout', () => {
        const result = resultWithSession({
            runStatus: 'browser_unavailable',
            effectiveMode: 'reasoning',
            verificationStatus: 'unavailable',
            fallbackReason: 'target_unreachable',
            fallbackDetail:
                'Target unreachable from this runner: https://example.com/ ' +
                '(ERR_CONNECTION_REFUSED in 3/3 browser profiles).',
            browserSessions: [],
        });

        expect(v.safeParse(FixRunResultSchema, result).success).toBe(true);
    });

    it.each(['targetUrl', 'profile'] as const)(
        'rejects legacy session evidence without required %s provenance',
        (field) => {
            const result = resultWithSession();
            delete (result.browserSessions![0] as unknown as Record<string, unknown>)[field];

            expect(v.safeParse(FixRunResultSchema, result).success).toBe(false);
        },
    );

    it.each([
        'ftp://example.com/article',
        'https://user:secret@example.com/article',
        'https://example.com/article#fragment with spaces',
    ])('rejects unsafe or non-canonical locked target URL %s', (targetUrl) => {
        const result = resultWithSession();
        result.browserSessions![0].targetUrl = targetUrl;

        expect(v.safeParse(FixRunResultSchema, result).success).toBe(false);
    });

    it('locks the fragment a single-page player needs into session evidence', () => {
        const result = resultWithSession();
        result.browserSessions![0].targetUrl = 'https://example.com/player#kr5qj';

        expect(v.safeParse(FixRunResultSchema, result).success).toBe(true);
    });

    it('publishes a no-patch verdict that lost its sessions as a lowered claim, not a failure', () => {
        // Canonical environment execution records only the sessions it conducted as phases, so a
        // run that never ran one hands the assembled record an empty list while the verdict still
        // claims proof. That record must not be publishable, and lowering the claim must make it
        // publishable — otherwise one such task fails the whole live run (#238829, 2026-08-22).
        const verified = resultWithSession();
        expect(v.safeParse(FixRunResultSchema, verified).success).toBe(true);

        const unbound: FixRunResult = { ...verified, browserSessions: [] };
        expect(noPatchVerdictIsSessionBound(unbound)).toBe(false);
        expect(v.safeParse(FixRunResultSchema, unbound).success).toBe(false);

        const lowered: FixRunResult = { ...unbound, verificationStatus: 'partial' };
        expect(noPatchVerdictIsSessionBound(lowered)).toBe(true);
        expect(v.safeParse(FixRunResultSchema, lowered).success).toBe(true);
    });

    it('accepts a fully inspected capture whose paths belong to the run artifact list', () => {
        expect(v.safeParse(FixRunResultSchema, resultWithSession()).success).toBe(true);
    });

    it('rejects a session screenshot path outside the locked run artifact list', () => {
        const result = resultWithSession();
        result.browserSessions![0].captures[0].fullPageOverview = '/tmp/foreign/page.png';

        expect(v.safeParse(FixRunResultSchema, result).success).toBe(false);
    });

    it('rejects a vision-verified capture without complete full-page tiles', () => {
        const result = resultWithSession();
        result.browserSessions![0].captures[0].coverageComplete = false;

        expect(v.safeParse(FixRunResultSchema, result).success).toBe(false);
    });

    it('requires both control and prepared visual proof for already_fixed_current', () => {
        const result = resultWithSession({ runStatus: 'already_fixed_current' });

        expect(v.safeParse(FixRunResultSchema, result).success).toBe(false);
    });

    it('accepts already_fixed_current only for unfiltered-present and prepared-absent vision', () => {
        expect(
            v.safeParse(FixRunResultSchema, alreadyFixedResult('present', 'absent')).success,
        ).toBe(true);
        expect(
            v.safeParse(FixRunResultSchema, alreadyFixedResult('absent', 'absent')).success,
        ).toBe(false);
    });

    it('rejects already_fixed_current when the prepared session carries no extension provenance', () => {
        const result = alreadyFixedResult('present', 'absent');
        result.browserSessions![1].extensionProvenance = undefined;

        expect(v.safeParse(FixRunResultSchema, result).success).toBe(false);
    });

    it('requires a same-provenance reporter and controlled matrix for verified configuration_specific', () => {
        expect(v.safeParse(FixRunResultSchema, configurationSpecificResult()).success).toBe(true);
        // The run's single pinned build admits only current-build profile kinds on the
        // reporter side; a report_exact session can never back a verified comparison.
        expect(
            v.safeParse(FixRunResultSchema, configurationSpecificResult('report_exact')).success,
        ).toBe(false);

        const missingControlled = configurationSpecificResult();
        missingControlled.browserSessions = missingControlled.browserSessions!.slice(0, 1);
        expect(v.safeParse(FixRunResultSchema, missingControlled).success).toBe(false);

        const mismatchedProvenance = configurationSpecificResult();
        mismatchedProvenance.browserSessions![1].extensionProvenance = {
            ...mismatchedProvenance.browserSessions![1].extensionProvenance!,
            extensionSourceSha256: 'f'.repeat(64),
        };
        expect(v.safeParse(FixRunResultSchema, mismatchedProvenance).success).toBe(false);

        const symptomRemains = configurationSpecificResult();
        symptomRemains.browserSessions![1].captures[0].reporterSymptomPresence = 'present';
        expect(v.safeParse(FixRunResultSchema, symptomRemains).success).toBe(false);

        const staleCaptureReference = configurationSpecificResult();
        staleCaptureReference.configurationComparisonEvidence!.reporter.fullPageOverviewArtifactId =
            'reporter-older-full-page';
        expect(v.safeParse(FixRunResultSchema, staleCaptureReference).success).toBe(false);

        const mismatchedUrl = configurationSpecificResult();
        mismatchedUrl.browserSessions![1].targetUrl = 'https://example.com/another-article';
        expect(v.safeParse(FixRunResultSchema, mismatchedUrl).success).toBe(false);

        const mismatchedProfile = configurationSpecificResult();
        mismatchedProfile.browserSessions![1].profile = {
            ...mismatchedProfile.browserSessions![1].profile,
            locale: 'pl-PL',
        };
        expect(v.safeParse(FixRunResultSchema, mismatchedProfile).success).toBe(false);

        const controlledPresentedAsReporter = configurationSpecificResult();
        controlledPresentedAsReporter.settingsEvidence =
            controlledPresentedAsReporter.browserSessions![1].settingsEvidence;
        expect(v.safeParse(FixRunResultSchema, controlledPresentedAsReporter).success).toBe(false);
    });

    it('accepts candidate proof bound to one prepared session and exact artifact pairs', () => {
        expect(v.safeParse(FixRunResultSchema, resultWithCandidateBinding()).success).toBe(true);
    });

    it('accepts a verified exception candidate bound to its prepared session', () => {
        // The incorrect-blocking path proposes exceptions; before this the only covered shape
        // was an additive ads candidate, so nothing pinned the success path for a fix that
        // restores content instead of removing it.
        const result = resultWithCandidateBinding({
            rule: 'deltaforcetools.gg#@#.ad-sidebar',
            ruleType: 'cosmetic',
            syntaxKind: 'element_hiding',
            filePath: 'BaseFilter/sections/allowlist.txt',
        });

        const parsed = v.safeParse(FixRunResultSchema, result);

        expect(parsed.issues?.map((issue) => issue.message).join(' | ')).toBeUndefined();
        expect(parsed.success).toBe(true);
    });

    it('binds candidate evidence when several sessions ran under redacted identifiers', () => {
        const result = resultWithCandidateBinding();
        // Redaction blanks every sessionId to one placeholder unless it pseudonymizes them; a
        // run with more than one session then has no single bound session at all.
        result.browserSessions!.push({
            ...result.browserSessions![0],
            sessionId: 'other-prepared-session',
        });
        result.browserSessions!.push({
            ...result.browserSessions![0],
            sessionId: 'control-session',
            extensionMode: 'none',
            extensionProvenance: undefined,
            settingsEvidence: undefined,
            selectedSettingsProfileKind: undefined,
        });

        expect(v.safeParse(FixRunResultSchema, result).success).toBe(true);
    });

    it('rejects candidate settings borrowed from another prepared session', () => {
        const result = resultWithCandidateBinding();
        result.candidateValidationEvidence!.sessionId = 'other-session';
        result.browserSessions!.push({
            ...result.browserSessions![0],
            sessionId: 'other-session',
            settingsEvidence: {
                ...result.browserSessions![0].settingsEvidence!,
                enabledListKeys: ['adguard:10'],
            },
        });

        expect(v.safeParse(FixRunResultSchema, result).success).toBe(false);
    });

    it('rejects candidate extension provenance borrowed from another prepared session', () => {
        const result = resultWithCandidateBinding();
        result.browserSessions![0].extensionProvenance = {
            ...result.browserSessions![0].extensionProvenance!,
            extensionSourceSha256: 'f'.repeat(64),
        };

        expect(v.safeParse(FixRunResultSchema, result).success).toBe(false);
    });

    it('rejects a screenshot path paired with an artifact ID from another validation', () => {
        const result = resultWithCandidateBinding();
        result.candidateValidationEvidence!.afterViewport.path =
            result.candidateValidationEvidence!.beforeViewport.path;

        expect(v.safeParse(FixRunResultSchema, result).success).toBe(false);
    });

    it('rejects a candidate validation identity from another candidate rule', () => {
        const result = resultWithCandidateBinding();
        result.candidateValidationEvidence!.validationArtifactId = 'validation-111111111111';
        result.candidateValidationEvidence!.validationArtifact.artifactId =
            'validation-111111111111';

        expect(v.safeParse(FixRunResultSchema, result).success).toBe(false);
    });

    it('rejects patch_proposed after removing its session binding', () => {
        const result = resultWithCandidateBinding();
        delete result.browserSessions;
        delete result.candidateValidationEvidence;

        expect(v.safeParse(FixRunResultSchema, result).success).toBe(false);
    });
});

describe('FixRunResultSchema missing information block', () => {
    /**
     * Build one schema-valid capped missing-information record list.
     *
     * @param count - How many entries to build.
     * @returns The entries array.
     */
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- Describe-local fixture.
    function missingInformation(count: number): { subject: string; detail: string }[] {
        return Array.from({ length: count }, (_entry, index) => ({
            subject: `The instruction links no syntax document for topic ${index}`,
            detail:
                `Every placement-relevant document is missing from the instruction roster ` +
                `${index}, so the run could not consult authoritative guidance.`,
        }));
    }

    it('accepts a capped missing-information array beside a normal result', () => {
        const result = resultWithSession({
            missingInformation: missingInformation(MAX_MISSING_INFORMATION_ENTRIES),
        });

        expect(v.safeParse(FixRunResultSchema, result).success).toBe(true);
    });

    it('accepts a result without a missing-information block', () => {
        expect(v.safeParse(FixRunResultSchema, resultWithSession()).success).toBe(true);
    });

    it.each([
        [
            'a subject above 200 characters',
            (result: FixRunResult) => {
                const block = result.missingInformation ?? [];
                block.push({
                    subject: 's'.repeat(201),
                    detail: 'The instruction links no document at all.',
                });
                result.missingInformation = block;
            },
        ],
        [
            'a detail above 2000 characters',
            (result: FixRunResult) => {
                result.missingInformation = [
                    { subject: 'No syntax document', detail: 'd'.repeat(2001) },
                ];
            },
        ],
        [
            'more entries than the report ceiling',
            (result: FixRunResult) => {
                result.missingInformation = missingInformation(MAX_MISSING_INFORMATION_ENTRIES + 1);
            },
        ],
        [
            'an entry with extra properties',
            (result: FixRunResult) => {
                result.missingInformation = [
                    {
                        subject: 'No syntax document',
                        detail: 'The instruction links no document at all.',
                        source: 'report_missing_information',
                    },
                ] as never;
            },
        ],
    ])('rejects %s', (_name, mutate) => {
        const result = resultWithSession();
        mutate(result);

        expect(v.safeParse(FixRunResultSchema, result).success).toBe(false);
    });
});

describe('FixRunResultSchema candidate carried for review', () => {
    const candidateForReview = {
        rule: '||increase-rev.cv3-ecf.workers.dev^$domain=sarkisozleri.bbs.tr',
        placement: { filePath: 'filters/2026/general_extensions.txt' },
        unverifiedReason:
            'The bound visual review returned inconclusive: the symptom resolved but page ' +
            'integrity stayed unclear, which images cannot settle for a network rule.',
    };

    it('keeps the rule an analysis-only run could not verify, beside a null patch', () => {
        // The rule used to survive only inside the reasoning prose, so the report said
        // "Analysis-only findings, no verified change" and the reader had nothing to act on.
        const parsed = v.parse(
            FixRunResultSchema,
            resultWithSession({
                runStatus: 'analysis_only',
                verificationStatus: 'partial',
                candidateForReview,
            }),
        );

        expect(parsed.candidateForReview).toEqual(candidateForReview);
        expect(parsed.candidatePatch).toBeNull();
    });

    it('refuses an unverified candidate beside a published patch', () => {
        const verified = resultWithCandidateBinding();
        expect(v.safeParse(FixRunResultSchema, verified).success).toBe(true);

        verified.candidateForReview = candidateForReview;

        expect(v.safeParse(FixRunResultSchema, verified).success).toBe(false);
    });

    it('refuses a candidate spanning two filter-file lines', () => {
        // Two lines are two rules, and only the first ever passed lint and risk scoring.
        const result = resultWithSession({
            runStatus: 'analysis_only',
            verificationStatus: 'partial',
            candidateForReview: {
                ...candidateForReview,
                rule: `${candidateForReview.rule}\nexample.com##.ad`,
            },
        });

        expect(v.safeParse(FixRunResultSchema, result).success).toBe(false);
    });
});

const pendingPublicationBaselineDigest = '7'.repeat(64);
/**
 * Exact single-line candidate rule the pending-publication C phase applies, with its digest.
 */
const pendingPublicationCandidateRule = 'example.test##.ad';
const pendingPublicationCandidateDigest = createHash('sha256')
    .update(pendingPublicationCandidateRule, 'utf8')
    .digest('hex');
// A prepared release build records one version string — manifest.json's own.
const pendingPublicationPackageVersion = '5.5.2.3';

const pendingPublicationExtension = {
    source: 'pinned_release' as const,
    extensionPath: '/tmp/run/prepared-extension',
    manifestVersion: 3 as const,
    extensionSourceSha256: 'e'.repeat(64),
    extensionSourceTag: 'v5.5.2.3',
};

function pendingPublicationPhase(
    value: 'A' | 'B' | 'C',
    actualContext: FilteringEnvironmentExecution['actualContext'],
): EnvironmentPhaseEvidence {
    const viewport = `/tmp/run/lag-viewport-${value}.png`;
    const fullPage = `/tmp/run/lag-full-page-${value}.png`;
    const tile = `/tmp/run/lag-tile-${value}.png`;
    let filteringState: EnvironmentPhaseEvidence['proof']['filteringState'] = 'disabled';
    if (value === 'B') {
        filteringState = 'published_baseline';
    }
    if (value === 'C') {
        filteringState = 'published_baseline_plus_candidate';
    }
    return {
        runId: 'run-22',
        experimentId: 'experiment-1',
        phase: value,
        proof: {
            leaseId: `lease-${value}`,
            adapterStateDigest: '5'.repeat(64),
            phase: value,
            filteringState,
            sessionId: `lag-session-${value}`,
            actualContext,
            baselineDigest: value === 'A' ? null : pendingPublicationBaselineDigest,
            candidateDigest: value === 'C' ? pendingPublicationCandidateDigest : null,
            extension:
                value === 'A'
                    ? null
                    : {
                          packageVersion: pendingPublicationPackageVersion,
                          manifestVersion: pendingPublicationPackageVersion,
                          profileKind: 'agent_selected',
                          enabledListKeys: ['adguard:2'],
                          activeRulesetListKeys: ['adguard:2'],
                          stealthEnabled: false,
                          userRulesDigest: value === 'C' ? pendingPublicationCandidateDigest : null,
                          application: {
                              method: BlockerVerificationMethod.ExtensionState,
                              appliedRules: value === 'C' ? [pendingPublicationCandidateRule] : [],
                              actionLog: [],
                          },
                          provenance: pendingPublicationExtension,
                      },
        },
        completion: {
            kind: 'observed',
            sessionId: `lag-session-${value}`,
            targetUrl: 'https://example.com/article',
            targetObservation: { symptomPresent: value !== 'C', pageUsable: true },
            navigationVerified: true,
            artifacts: [
                { artifactId: `lag-viewport-${value}`, kind: 'screenshot', path: viewport },
                { artifactId: `lag-full-page-${value}`, kind: 'screenshot', path: fullPage },
                { artifactId: `lag-tile-${value}`, kind: 'screenshot', path: tile },
            ],
            vision: null,
            candidateValidation: null,
            rejectedCandidates: [],
            profile: sessionProfile,
            captures: [
                {
                    visionVerified: true,
                    viewportArtifactId: `lag-viewport-${value}`,
                    viewport,
                    fullPageOverviewArtifactId: `lag-full-page-${value}`,
                    fullPageOverview: fullPage,
                    tileArtifactIds: [`lag-tile-${value}`],
                    tiles: [tile],
                    coverageComplete: true,
                    reporterSymptomPresence: value === 'C' ? 'absent' : 'present',
                },
            ],
        },
    };
}

function pendingPublicationResult(): FixRunResult {
    const selection = readyExtensionSelection(pendingPublicationPackageVersion);
    const actualContext = selection.actual!;
    const execution: FilteringEnvironmentExecution = {
        recorderVersion: 1,
        runId: 'run-22',
        kind: 'browser_extension',
        actualContext,
        capabilities: [
            'browser_navigation',
            'filtering_control',
            'baseline_integrity',
            'phase_proof',
        ],
        preparation: null,
        baseline: {
            environment: 'browser_extension',
            acquiredAt: '2026-07-29T09:00:00.000Z',
            enabledListKeys: ['adguard:2'],
            resources: [
                {
                    listKey: 'adguard:2',
                    rulesetId: 'ruleset_2',
                    path: 'filters/declarative/ruleset_2/ruleset_2.json',
                    version: '1.0.1.2',
                    byteCount: 4096,
                    sha256: 'e'.repeat(64),
                },
            ],
            aggregateDigest: pendingPublicationBaselineDigest,
        },
        phases: (['A', 'B', 'C'] as const).map((value) =>
            pendingPublicationPhase(value, actualContext),
        ),
        rejectedCandidates: [],
        drain: { attempted: 0, closed: 0, failed: 0, failures: [] },
        cleanup: {
            attempted: true,
            completed: true,
            finalizerAttempts: 0,
            finalizerCompleted: 0,
            finalizerFailed: 0,
            failures: [],
        },
        investigationDisposition: { status: 'inconclusive', candidateDigest: null, failure: null },
        secondaryFailures: [],
        disposition: { status: 'inconclusive', candidateDigest: null, failure: null },
    };
    const projected = projectEnvironmentResult(execution)!;
    return {
        issueNumber: 4,
        domain: 'example.com',
        runStatus: 'fixed_in_source_pending_publication',
        requestedBrowserMode: 'on',
        effectiveMode: 'browser',
        verificationStatus: 'partial',
        fallbackReason: null,
        fallbackDetail: null,
        environmentSelection: selection,
        environmentExecution: execution,
        browserSessions: projected.browserSessions,
        ...(projected.extensionProvenance
            ? { extensionProvenance: projected.extensionProvenance }
            : {}),
        ...(projected.settingsEvidence ? { settingsEvidence: projected.settingsEvidence } : {}),
        ...(projected.candidateApplicationEvidence
            ? { candidateApplicationEvidence: projected.candidateApplicationEvidence }
            : {}),
        candidatePatch: null,
        artifactPaths: projected.artifactPaths,
        reasoning: 'The pinned source already carries the rule that removed the reported symptom.',
        repository: null,
        baseSha: null,
        filtersRepository: 'AdguardTeam/AdguardFilters',
        filtersBaseSha: 'd'.repeat(40),
    };
}

describe('FixRunResultSchema distribution lag', () => {
    it('persists a pending-publication claim carrying its reproduction and both provenances', () => {
        expect(v.safeParse(FixRunResultSchema, pendingPublicationResult()).success).toBe(true);
    });

    it('binds the candidate application record to the phase C application proof', () => {
        const result = pendingPublicationResult();
        expect(v.safeParse(FixRunResultSchema, result).success).toBe(true);

        // The retained record's application evidence is the canonical phase C projection, so an
        // assembled record that edits the recorded steps no longer describes the run's own proof.
        result.candidateApplicationEvidence!.actionLog = [
            { tool: 'invented_tool', ok: true, summary: 'The model never ran this step.' },
        ];
        expect(v.safeParse(FixRunResultSchema, result).success).toBe(false);
    });

    it.each([
        [
            'a candidate patch',
            (result: FixRunResult) => {
                result.candidatePatch = {
                    rule: 'example.com##.ad',
                    ruleType: 'cosmetic',
                    filePath: 'BaseFilter/sections/general.txt',
                };
            },
        ],
        [
            'no pinned source commit',
            (result: FixRunResult) => {
                delete result.filtersBaseSha;
            },
        ],
        [
            'no pinned source repository',
            (result: FixRunResult) => {
                delete result.filtersRepository;
            },
        ],
        [
            'no executed published checksums',
            (result: FixRunResult) => {
                result.environmentExecution!.baseline = null;
            },
        ],
        [
            'no candidate phase',
            (result: FixRunResult) => {
                result.environmentExecution!.phases = result.environmentExecution!.phases.filter(
                    (phase) => phase.phase !== 'C',
                );
            },
        ],
        [
            'a baseline phase bound to other published content',
            (result: FixRunResult) => {
                result.environmentExecution!.phases.find(
                    (phase) => phase.phase === 'B',
                )!.proof.baselineDigest = '6'.repeat(64);
            },
        ],
    ])('cannot persist a pending-publication claim with %s', (_name, mutate) => {
        const result = pendingPublicationResult();
        mutate(result);

        expect(v.safeParse(FixRunResultSchema, result).success).toBe(false);
    });
});

describe('FixRunResultSchema source drift', () => {
    const PINNED = 'd'.repeat(40);
    const UPSTREAM = 'e'.repeat(40);
    const OBSERVED_AT = '2026-07-29T12:00:00.000Z';

    it('persists an upstream that moved after the run pinned its source commit', () => {
        const result = pendingPublicationResult();
        result.sourceDrift = {
            status: 'upstream_ahead',
            pinnedCommit: PINNED,
            upstreamCommit: UPSTREAM,
            observedAt: OBSERVED_AT,
        };

        expect(result.filtersBaseSha).toBe(PINNED);
        expect(v.safeParse(FixRunResultSchema, result).success).toBe(true);
    });

    it.each<[string, UpstreamSourceDrift]>([
        [
            'naming a commit the run is not bound to',
            {
                status: 'upstream_ahead',
                pinnedCommit: UPSTREAM,
                upstreamCommit: PINNED,
                observedAt: OBSERVED_AT,
            },
        ],
        [
            'claiming to be in sync with a different upstream commit',
            {
                status: 'in_sync',
                pinnedCommit: PINNED,
                upstreamCommit: UPSTREAM,
                observedAt: OBSERVED_AT,
            },
        ],
        [
            'claiming upstream moved without naming where it moved to',
            {
                status: 'upstream_ahead',
                pinnedCommit: PINNED,
                upstreamCommit: null,
                observedAt: OBSERVED_AT,
            },
        ],
    ])('cannot persist a drift record %s', (_name, sourceDrift) => {
        const result = pendingPublicationResult();
        result.sourceDrift = sourceDrift;

        expect(v.safeParse(FixRunResultSchema, result).success).toBe(false);
    });
});
