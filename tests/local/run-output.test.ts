import { AgentCandidateArtifactEvidenceSchema } from '../../src/types/fix-run-result';
import { createHash } from 'node:crypto';
import {
    BlockerVerificationMethod,
    PreparedExtensionProvenanceSchema,
} from '../../src/environment/environment-proofs';
import {
    existsSync,
    linkSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
    PreparedExtensionSource,
    ExtensionManifestVersion,
} from '../../src/environment/extension-preparation';
import { createRunUsageCollector } from '../../src/pi/usage-collector';
import { RunUsageSummarySchema, UsageSummaryVersion } from '../../src/types/usage-summary';
import { type EnvironmentSelectionSnapshot } from '../../src/environment/environment-selection-contract';
import { EnvironmentSelectionHost } from '../../src/environment/environment-selection';
import {
    cliExecutorDescriptor,
    extensionExecutorDescriptor,
} from '../environment/test-filtering-environment-fixtures';
import { projectEnvironmentResult } from '../../src/environment/environment-result-projection';
import type { FilteringEnvironmentExecution } from '../../src/environment/filtering-environment';
import type { AgentRunArtifacts } from '../../src/types/agent-run-artifacts';
import type { FixRunResult } from '../../src/types/fix-run-result';
import type { IssueFacts } from '../../src/types/issue-facts';
import { materializeLocalRunOutputDir } from '../../src/local/output-directory';
import { LocalRunManifestVersion, verifyLocalRunManifest } from '../../src/local/run-manifest';
import {
    LocalRunRecordSchema,
    readLocalRunOutput,
    renderLocalAgentReport,
    writeLocalRunOutput,
    type LocalRunRecord,
} from '../../src/local/run-output';

/**
 * Project root the run-output writer is bound to: a real directory, because the writer resolves it
 * on disk.
 */
const projectRoot = mkdtempSync(join(tmpdir(), 'local-run-project-'));
const extensionProvenance = v.parse(PreparedExtensionProvenanceSchema, {
    source: PreparedExtensionSource.PinnedRelease,
    extensionPath: '/tmp/cache/extensions/prebuilt/v5.5.2.3/unpacked',
    manifestVersion: ExtensionManifestVersion.Mv3,
    extensionSourceSha256: 'e'.repeat(64),
    extensionSourceTag: 'v5.5.2.3',
});
const settingsEvidence = {
    profileKind: 'report_exact' as const,
    // The phase read-back never observed the enabled set or the Stealth state: the record carries
    // null for both, never an empty list or a false boolean.
    enabledListKeys: null,
    activeRulesetListKeys: ['adguard:1'],
    stealthEnabled: null,
    limitsExceeded: false,
};
const browserSessionProfile = {
    viewport: 'desktop' as const,
    locale: 'en-US',
    timezone: 'UTC',
    userAgentProfile: 'Chromium',
    consentStrategy: 'untouched' as const,
};
const extensionEnvironmentSelection: EnvironmentSelectionSnapshot = {
    selectedKind: 'browser_extension',
    state: 'ready',
    rationale: 'The report describes ordinary website filtering in a browser.',
    confidence: 0.94,
    requiredCapabilities: ['browser_navigation', 'extension_filtering', 'candidate_application'],
    advertisedCapabilities: [
        'browser_navigation',
        'filtering_control',
        'extension_filtering',
        'candidate_application',
    ],
    missingCapabilities: [],
    descriptor: {
        kind: 'browser_extension',
        availability: 'available',
        preparationState: 'not_started',
        limitationCode: null,
        capabilities: [
            'browser_navigation',
            'filtering_control',
            'extension_filtering',
            'candidate_application',
        ],
    },
    lockedAt: '2026-07-23T10:00:00.000Z',
    declared: {
        issueFormType: 'Ads',
        labels: ['T: Ads'],
    },
    reported: {
        product: 'AdGuard Browser Extension',
        os: 'macOS',
        browser: 'Chrome',
    },
    observed: {
        issueType: 'ads',
        rationale: 'The page contains an advertising element that remains visible.',
        confidence: 0.92,
        evidence: [
            {
                source: 'issue_body',
                observation: 'The reporter identifies a visible ad on the article page.',
            },
        ],
        conflicts: [],
    },
    intentHistory: [
        {
            issueType: 'ads',
            rationale: 'The page contains an advertising element that remains visible.',
            confidence: 0.92,
            evidence: [
                {
                    source: 'issue_body',
                    observation: 'The reporter identifies a visible ad on the article page.',
                },
            ],
            conflicts: [],
        },
    ],
    rejectedRequests: [],
    actual: {
        kind: 'browser_extension',
        product: 'AdGuard Browser Extension',
        browser: 'CloakBrowser Chromium',
        productVersion: '5.5.2.3',
    },
    fidelityLimitations: [
        {
            code: 'browser_approximation',
            detail: 'The controlled Chromium browser differs from the reported Chrome browser.',
        },
    ],
    capabilityLimits: [],
    filterBaseline: {
        status: 'executable',
        officialFilters: [
            {
                filterId: 2,
                listKey: 'adguard:2',
                name: 'AdGuard Base filter',
                reportedName: 'AdGuard Base filter',
            },
        ],
        skippedSources: [],
    },
};

/**
 * Build one schema-valid ready CLI selection: no activation, no verified version claim.
 *
 * @returns Path-free locked executor selection snapshot for a locally built executor.
 */
function readyAdguardCliSelection(): EnvironmentSelectionSnapshot {
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
        cliExecutorDescriptor(),
        extensionExecutorDescriptor(),
    ]);
    host.select({
        kind: 'adguard_cli',
        requiredCapabilities: ['cli_activation'],
        intent: {
            issueType: 'ads',
            rationale: 'The desktop report describes ordinary website filtering.',
            confidence: 1,
            evidence: [{ source: 'issue_body', observation: 'A visible advertisement remains.' }],
            conflicts: [],
        },
        rationale: 'Use the isolated AdGuard CLI engine.',
        confidence: 1,
    });
    host.attachExecutorPreparation({
        ready: true,
        provenance: {
            source: 'local_build',
            product: 'AdGuard CLI',
            version: null,
            digestB32: 'digestb32examplevalue0123456789abcdefghijklmnopqrstuvwxyz',
        },
    });
    return host.snapshot()!;
}

function bindCandidateEvidence(result: FixRunResult): FixRunResult {
    const patch = result.candidatePatch!;
    const review = result.candidateVisualReview!;
    const screenshots = result.artifactPaths.verifiedCandidateScreenshots!;
    const candidateRuleHash = createHash('sha256').update(patch.rule).digest('hex');
    const candidateShortHash = candidateRuleHash.slice(0, 12);
    const validationArtifactId = `validation-${candidateShortHash}`;
    const boundReview = {
        ...review,
        validationArtifactId,
        candidateRuleHash,
    };
    return {
        ...result,
        environmentSelection: extensionEnvironmentSelection,
        extensionProvenance,
        settingsEvidence,
        browserSessions: [
            {
                sessionId: 'prepared-session',
                targetUrl: 'https://example.com/article',
                extensionMode: 'prepared',
                profile: browserSessionProfile,
                selectedSettingsProfileKind: 'report_exact',
                extensionProvenance,
                settingsEvidence,
                navigationVerified: true,
                fullVisionVerified: false,
                captures: [],
            },
        ],
        candidateVisualReview: boundReview,
        candidateValidationEvidence: {
            validationArtifactId,
            sessionId: 'prepared-session',
            extensionProvenance,
            settingsEvidence,
            validationArtifact: v.parse(AgentCandidateArtifactEvidenceSchema, {
                artifactId: validationArtifactId,
                path: `/tmp/run/factual-validation-${candidateShortHash}.json`,
            }),
            visualReviewArtifact: v.parse(AgentCandidateArtifactEvidenceSchema, {
                artifactId: `visual-review-${candidateShortHash}`,
                path: `/tmp/run/candidate-visual-review-${candidateShortHash}.json`,
            }),
            beforeViewport: v.parse(AgentCandidateArtifactEvidenceSchema, {
                artifactId: boundReview.beforeViewportArtifactId,
                path: screenshots.before,
            }),
            afterViewport: v.parse(AgentCandidateArtifactEvidenceSchema, {
                artifactId: boundReview.afterViewportArtifactId,
                path: screenshots.after,
            }),
            beforeFullPage: v.parse(AgentCandidateArtifactEvidenceSchema, {
                artifactId: boundReview.beforeFullPageArtifactId!,
                path: screenshots.beforeFullPage!,
            }),
            afterFullPage: v.parse(AgentCandidateArtifactEvidenceSchema, {
                artifactId: boundReview.afterFullPageArtifactId!,
                path: screenshots.afterFullPage!,
            }),
        },
        artifactPaths: {
            ...result.artifactPaths,
            screenshots: Object.values(screenshots),
            candidateVisualReview: `/tmp/run/candidate-visual-review-${candidateShortHash}.json`,
        },
    };
}

const fixRunResult: FixRunResult = bindCandidateEvidence({
    issueNumber: 4,
    domain: 'example.com',
    runStatus: 'patch_proposed',
    requestedBrowserMode: 'auto',
    effectiveMode: 'browser',
    verificationStatus: 'verified',
    reproductionSettingsStatus: 'applied',
    reproductionSettingsDetail: 'Profile matched.',
    fallbackReason: null,
    fallbackDetail: null,
    candidatePatch: {
        rule: 'example.com##.advert',
        ruleType: 'cosmetic',
        syntaxKind: 'element_hiding',
        filePath: 'BaseFilter/sections/foreign.txt',
        repositoryEdit: { kind: 'insert' },
    },
    candidateVisualReview: {
        verdict: 'verified',
        symptom: 'resolved',
        symptomScope: 'The complete reporter-defined page defect.',
        adLayoutResidue: 'absent',
        coverageComplete: true,
        beforeInstances: [
            {
                artifactId: 'before-viewport',
                landmark: 'Reported target area.',
                description: 'The reported defect is visible before the candidate.',
            },
        ],
        remainingInstances: [],
        pageIntegrity: 'intact',
        validationArtifactId: 'validation-000000000000',
        candidateRuleHash: '0'.repeat(64),
        beforeViewportArtifactId: 'before-viewport',
        afterViewportArtifactId: 'after-viewport',
        beforeFullPageArtifactId: 'before-full-page',
        afterFullPageArtifactId: 'after-full-page',
        model: 'gemini-3.5-flash',
        rationale: 'The reported overlay is gone and the underlying page remains visually intact.',
        observedDamage: [],
    },
    artifactPaths: {
        screenshots: [
            '/tmp/run/before.png',
            '/tmp/run/after.png',
            '/tmp/run/before-full-page.png',
            '/tmp/run/after-full-page.png',
        ],
        domSnapshot: '/tmp/run/page.html',
        har: '/tmp/run/page.har',
        trace: '/tmp/run/trace.json',
        settingsProof: '/tmp/run/settings.json',
        verifiedCandidateScreenshots: {
            before: '/tmp/run/before.png',
            after: '/tmp/run/after.png',
            beforeFullPage: '/tmp/run/before-full-page.png',
            afterFullPage: '/tmp/run/after-full-page.png',
        },
    },
    reasoning: 'The reported ad was reproduced and the vision review accepted the candidate.',
    repository: 'AdguardTeam/AdguardFilters',
    baseSha: '0123456789abcdef',
});

const record: LocalRunRecord = {
    result: fixRunResult,
    provenance: {
        environment: 'historical',
        headless: true,
        extension: extensionProvenance,
        settingsProfiles: [
            {
                name: 'report_exact',
                status: 'applied',
                detail: null,
                activationProof: 'dnr-rulesets',
                enabledFilters: [
                    {
                        id: 1,
                        name: 'AdGuard Base filter',
                        group: 'Ad blocking',
                        version: '2.0.0.0',
                        metadataEnabled: true,
                        runtimeEnabled: true,
                    },
                ],
            },
        ],
    },
    evidence: {
        summary: 'The issue screenshot matched the live top leaderboard.',
        userScreenshots: ['/tmp/run/issue.png'],
        unfilteredScreenshots: ['/tmp/run/unfiltered.png'],
        profileScreenshots: [
            {
                name: 'report_exact',
                screenshots: ['/tmp/run/report-exact.png'],
            },
        ],
        beforeScreenshots: ['/tmp/run/before.png'],
        afterScreenshots: ['/tmp/run/after.png'],
        beforeFullPageScreenshots: ['/tmp/run/before-full-page.png'],
        afterFullPageScreenshots: ['/tmp/run/after-full-page.png'],
        rejectedScreenshots: [],
        rejectedPairs: [],
    },
    artifacts: [
        { label: 'Trace', path: '/tmp/run/trace.json' },
        { label: 'HAR', path: '/tmp/run/page.har' },
    ],
};

const pendingPublicationBaseline = {
    environment: 'browser_extension' as const,
    acquiredAt: '2026-07-29T09:00:00.000Z',
    enabledListKeys: ['adguard:2', 'adguard:4'],
    resources: [
        {
            listKey: 'adguard:2',
            rulesetId: 'ruleset_2',
            path: 'filters/declarative/ruleset_2/ruleset_2.json',
            version: '1.0.1.2',
            byteCount: 4096,
            sha256: 'e'.repeat(64),
        },
        {
            listKey: 'adguard:4',
            rulesetId: 'ruleset_4',
            path: 'filters/declarative/ruleset_4/ruleset_4.json',
            version: null,
            byteCount: 2048,
            sha256: 'f'.repeat(64),
        },
    ],
    aggregateDigest: '7'.repeat(64),
};
const pendingPublicationSourceCommit = 'd'.repeat(40);
const upstreamSourceCommit = 'e'.repeat(40);

/**
 * Build one complete pending-publication run record whose evidence carries no local path.
 *
 * @returns Record accepted by the locked run schema.
 */
function pendingPublicationRecord(): LocalRunRecord {
    const actualContext = extensionEnvironmentSelection.actual!;
    /**
     * Exact single-line candidate rule the C phase applies, and its verified digest.
     */
    const candidateRule = 'example.test##.ad';
    const candidateDigest = createHash('sha256').update(candidateRule, 'utf8').digest('hex');
    const execution: FilteringEnvironmentExecution = {
        recorderVersion: 1,
        runId: 'run-4',
        kind: 'browser_extension',
        actualContext,
        capabilities: ['browser_navigation', 'filtering_control', 'phase_proof'],
        preparation: null,
        baseline: pendingPublicationBaseline,
        phases: (['A', 'B', 'C'] as const).map((phase) => {
            let filteringState: FilteringEnvironmentExecution['phases'][number]['proof']['filteringState'] =
                'disabled';
            if (phase === 'B') {
                filteringState = 'published_baseline';
            }
            if (phase === 'C') {
                filteringState = 'published_baseline_plus_candidate';
            }
            return {
                runId: 'run-4',
                experimentId: 'experiment-1',
                phase,
                proof: {
                    leaseId: `lease-${phase}`,
                    adapterStateDigest: '5'.repeat(64),
                    phase,
                    filteringState,
                    sessionId: `lag-session-${phase}`,
                    actualContext,
                    baselineDigest:
                        phase === 'A' ? null : pendingPublicationBaseline.aggregateDigest,
                    candidateDigest: phase === 'C' ? candidateDigest : null,
                    extension:
                        phase === 'A'
                            ? null
                            : {
                                  packageVersion: '5.5.2.3',
                                  manifestVersion: '5.5.2.3',
                                  profileKind: 'report_exact' as const,
                                  // File-backed phases cannot observe the enabled set, the
                                  // compiled DNR rulesets or the Stealth state; the projection
                                  // must carry null through for all three.
                                  enabledListKeys: null,
                                  activeRulesetListKeys: null,
                                  stealthEnabled: null,
                                  userRulesDigest: phase === 'C' ? candidateDigest : null,
                                  application: {
                                      method: BlockerVerificationMethod.ExtensionState,
                                      appliedRules: phase === 'C' ? [candidateRule] : [],
                                      actionLog: [],
                                  },
                                  provenance: extensionProvenance,
                              },
                },
                completion: {
                    kind: 'observed',
                    sessionId: `lag-session-${phase}`,
                    targetUrl: 'https://example.com/article',
                    targetObservation: { symptomPresent: phase !== 'C', pageUsable: true },
                    navigationVerified: true,
                    artifacts: [],
                    vision: null,
                    candidateValidation: null,
                    rejectedCandidates: [],
                    profile: browserSessionProfile,
                    captures: [],
                },
            };
        }),
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
        result: {
            issueNumber: 4,
            domain: 'example.com',
            runStatus: 'fixed_in_source_pending_publication',
            requestedBrowserMode: 'auto',
            effectiveMode: 'browser',
            verificationStatus: 'partial',
            fallbackReason: null,
            fallbackDetail: null,
            environmentSelection: extensionEnvironmentSelection,
            environmentExecution: execution,
            browserSessions: projected.browserSessions,
            extensionProvenance: projected.extensionProvenance,
            settingsEvidence: projected.settingsEvidence,
            ...(projected.candidateApplicationEvidence
                ? {
                      candidateApplicationEvidence: projected.candidateApplicationEvidence,
                  }
                : {}),
            candidatePatch: null,
            artifactPaths: projected.artifactPaths,
            reasoning:
                'The published lists still reproduce the report, and the pinned source already ' +
                'carries the rule that removed it.',
            repository: null,
            baseSha: null,
            filtersRepository: 'AdguardTeam/AdguardFilters',
            filtersBaseSha: pendingPublicationSourceCommit,
        },
        provenance: {
            environment: 'current',
            headless: true,
            extension: null,
            settingsProfiles: [],
        },
        evidence: {
            summary: 'The pinned source already carries the fix for the reproduced report.',
            userScreenshots: [],
            unfilteredScreenshots: [],
            profileScreenshots: [],
            beforeScreenshots: [],
            afterScreenshots: [],
            beforeFullPageScreenshots: [],
            afterFullPageScreenshots: [],
            rejectedScreenshots: [],
            rejectedPairs: [],
        },
        artifacts: [],
    };
}

describe('renderLocalAgentReport', () => {
    it('names the pinned source commit and the executed published baseline as separate facts', () => {
        const driftedRecord = pendingPublicationRecord();
        driftedRecord.result.sourceDrift = {
            status: 'upstream_ahead',
            pinnedCommit: pendingPublicationSourceCommit,
            upstreamCommit: upstreamSourceCommit,
            observedAt: '2026-07-29T10:00:00.000Z',
        };

        const report = renderLocalAgentReport(driftedRecord);
        const provenance = report.split('## Provenance')[1]!.split('##')[0]!;
        const lines = provenance.split('\n');

        expect(report).toContain(
            '- Status: `fixed_in_source_pending_publication` — fixed in source, pending publication',
        );
        // Source identity: the commit the run is bound to, where upstream stood at report time,
        // and the repository both name — never the location either was read from.
        expect(provenance).toContain('AdguardTeam/AdguardFilters');
        expect(provenance).toContain(pendingPublicationSourceCommit);
        expect(provenance).toContain('upstream_ahead');
        expect(provenance).toContain(upstreamSourceCommit);
        // Published identity: what the run actually executed against, kept apart from the source.
        // Each provenance line names the registry id the resource's list key resolves to.
        const resourceIds = ['2', '4'];
        for (const [index, resource] of pendingPublicationBaseline.resources.entries()) {
            expect(
                lines.some(
                    (line) =>
                        line.includes(`\`${resourceIds[index]}\``) &&
                        line.includes(resource.sha256),
                ),
            ).toBe(true);
        }
        expect(provenance).toContain(pendingPublicationBaseline.aggregateDigest);
        expect(provenance).toContain(pendingPublicationBaseline.acquiredAt);
        expect(report).toContain('No candidate patch');
        expect(report).toContain('review checkout');
        expect(report).not.toContain('https://example.test');
        expect(report).not.toMatch(/[\s`(<]\/[A-Za-z0-9._-]/u);
        for (const resource of pendingPublicationBaseline.resources) {
            expect(report).not.toContain(resource.path);
        }
    });

    it('renders no published-state lines for a result with no executed baseline', () => {
        const report = renderLocalAgentReport(record);

        expect(report).not.toContain('Pending publication');
        expect(report).not.toContain('Published filter');
    });

    it('renders a CLI build preparation without any release identity lines', () => {
        const {
            candidateVisualReview: _candidateVisualReview,
            candidateValidationEvidence: _candidateValidationEvidence,
            extensionProvenance: _extensionProvenance,
            settingsEvidence: _settingsEvidence,
            browserSessions: _browserSessions,
            ...candidateFreeResult
        } = fixRunResult;
        const {
            verifiedCandidateScreenshots: _verifiedCandidateScreenshots,
            candidateVisualReview: _candidateVisualReviewPath,
            ...diagnosticArtifactPaths
        } = fixRunResult.artifactPaths;
        const adguardCliRecord: LocalRunRecord = {
            ...record,
            result: {
                ...candidateFreeResult,
                runStatus: 'analysis_only',
                verificationStatus: 'unavailable',
                environmentSelection: readyAdguardCliSelection(),
                candidatePatch: null,
                artifactPaths: diagnosticArtifactPaths,
                reasoning: 'The locked engine reproduced the report; no candidate was verified.',
            },
            evidence: {
                ...record.evidence,
                beforeScreenshots: [],
                afterScreenshots: [],
                beforeFullPageScreenshots: [],
                afterFullPageScreenshots: [],
            },
            // A proxy-filtered run loads no extension build, so its record carries none.
            provenance: {
                ...record.provenance,
                extension: null,
            },
        };

        const report = renderLocalAgentReport(adguardCliRecord);

        expect(report).toContain('- Source: `local_build`');
        expect(report).toContain('- Product: `AdGuard CLI`');
        expect(report).toContain('- Version: `unknown (unavailable)`');
        expect(report).toContain(
            `- Digest: \`digestb32examplevalue0123456789abcdefghijklmnopqrstuvwxyz\``,
        );
        expect(report).not.toContain('release');
        expect(report).not.toContain('/private/tmp/cli');
    });

    it('explains that the target site, not Chromium, was unreachable', () => {
        const {
            candidateVisualReview: _candidateVisualReview,
            candidateValidationEvidence: _candidateValidationEvidence,
            ...resultWithoutCandidateEvidence
        } = fixRunResult;
        const {
            verifiedCandidateScreenshots: _verifiedCandidateScreenshots,
            candidateVisualReview: _candidateVisualReviewPath,
            ...artifactPathsWithoutCandidate
        } = fixRunResult.artifactPaths;
        const unavailableRecord: LocalRunRecord = {
            ...record,
            result: {
                ...resultWithoutCandidateEvidence,
                runStatus: 'target_url_unavailable',
                effectiveMode: 'reasoning',
                verificationStatus: 'unavailable',
                fallbackReason: 'target_unreachable',
                fallbackDetail:
                    'Target unreachable from this runner: https://sochi.camera/ ' +
                    '(ERR_CONNECTION_REFUSED in 3/3 browser profiles).',
                browserSessions: [],
                candidatePatch: null,
                artifactPaths: {
                    ...artifactPathsWithoutCandidate,
                    screenshots: [],
                },
                reasoning:
                    'Browser verification could not start because the target refused TCP connections.',
            },
            evidence: {
                ...record.evidence,
                beforeScreenshots: [],
                afterScreenshots: [],
                beforeFullPageScreenshots: [],
                afterFullPageScreenshots: [],
            },
        };

        const report = renderLocalAgentReport(unavailableRecord);

        expect(report).toContain(
            '- Status: `target_url_unavailable` — target URL unavailable from this runner',
        );
        expect(report).toContain('- Fallback reason: `target_unreachable`');
        expect(report).toContain(
            '- Browser failure: Target unreachable from this runner: https://sochi.camera/ ' +
                '(ERR_CONNECTION_REFUSED in 3/3 browser profiles).',
        );
    });

    it('renders agent output before provenance, evidence, and artifacts', () => {
        const report = renderLocalAgentReport(record);

        const agentIndex = report.indexOf('## Agent decision');
        const hostIndex = report.indexOf('## Host result');
        const environmentIndex = report.indexOf('## Environment selection');
        const provenanceIndex = report.indexOf('## Provenance');
        const evidenceIndex = report.indexOf('## Evidence');
        const artifactsIndex = report.indexOf('## Artifacts');

        expect(agentIndex).toBeGreaterThanOrEqual(0);
        expect(hostIndex).toBeGreaterThan(agentIndex);
        expect(environmentIndex).toBeGreaterThan(hostIndex);
        expect(provenanceIndex).toBeGreaterThan(environmentIndex);
        expect(evidenceIndex).toBeGreaterThan(provenanceIndex);
        expect(artifactsIndex).toBeGreaterThan(evidenceIndex);
        expect(report).toContain('example.com##.advert');
        expect(report).toContain('- Syntax kind: `element_hiding`');
        expect(report).toContain('- Repository edit: `insert`');
        expect(report).toContain('- Verdict: `verified`');
        expect(report).toContain('- Symptom: `resolved`');
        expect(report).toContain('- Full-page coverage: `complete`');
        expect(report).toContain('- Before instances:');
        expect(report).toContain('- Remaining instances:');
        expect(report).toContain('- Page integrity: `intact`');
        expect(report).toContain('- Model: `gemini-3.5-flash`');
        expect(report).toContain(
            'The reported overlay is gone and the underlying page remains visually intact.',
        );
        expect(report).toContain('![Verified before — viewport 1](</tmp/run/before.png>)');
        expect(report).toContain('![Verified after — viewport 1](</tmp/run/after.png>)');
        expect(report).toContain(
            '![Verified before — full page 1](</tmp/run/before-full-page.png>)',
        );
        expect(report).toContain('![Verified after — full page 1](</tmp/run/after-full-page.png>)');
        expect(report).not.toContain('deterministic page-safety');
        expect(report).not.toContain('structural validation');
        expect(report).toContain('### Profile — report_exact');
        expect(report).toContain('![Profile — report_exact 1](</tmp/run/report-exact.png>)');
        // The run records the single-source provenance of its pinned prebuilt build.
        expect(report).toContain('- Extension source: `pinned_release`');
        expect(report).toContain(
            '- Extension directory: `/tmp/cache/extensions/prebuilt/v5.5.2.3/unpacked`',
        );
        expect(report).toContain('- Extension tag: `v5.5.2.3`');
        expect(report).toContain(
            '- Extension source sha256: `eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee`',
        );
        expect(report).toContain('- Manifest generation: `3`');
        expect(report).toContain('- Browser support contract: `Chromium + MV3 only`');
        expect(report).toContain('does not verify branded Edge or Manifest V2 behavior');
        expect(report).toContain('- Source/extension horizon: `historical`');
        expect(report.endsWith('\n')).toBe(true);
    });

    it('does not claim full-page coverage when the overview was too tall to read', () => {
        // The coverage line is where a maintainer learns what the review looked at. A review whose
        // overview was withheld as unreadable saw only the tile window, however complete that
        // window's own proof is, so the line must say so and carry the range it did inspect.
        const review = record.result.candidateVisualReview!;
        const reason =
            'Original full-page overview is 375x10334 px (aspect 27.6:1) and is too tall for a ' +
            'vision model to read as one image, which the provider fits into a bounded square; ' +
            'original-resolution tiles from y=0 to y=4060 of 10334 px were inspected instead, ' +
            'and the rest of the page was not inspected.';
        const omitted = {
            mode: 'omitted_illegible' as const,
            originalBytes: 1_300_000,
            visionArtifactId: null,
            visionBytes: null,
            reason,
        };

        const report = renderLocalAgentReport({
            ...record,
            result: {
                ...record.result,
                candidateVisualReview: {
                    ...review,
                    fullPageOverviewEvidence: {
                        before: { ...omitted, originalArtifactId: review.beforeFullPageArtifactId },
                        after: { ...omitted, originalArtifactId: review.afterFullPageArtifactId },
                    },
                },
            },
        });

        expect(report).not.toContain('- Full-page coverage: `complete`');
        expect(report).toContain('- Full-page coverage: `tile window only` — Original full-page');
        expect(report).toContain('y=0 to y=4060 of 10334 px were inspected instead');
    });

    it('does not claim full-page coverage when the tiles cover only a window of the page', () => {
        // The overview is only a map, so a review whose tiles cover a window saw that window.
        const review = record.result.candidateVisualReview!;
        const reason =
            'The full-page overview was shown only as a map; original-resolution tiles from ' +
            'y=0 to y=1080 of 4000 px were inspected, and the rest of the page was not inspected.';
        const windowed = {
            mode: 'windowed_tiles' as const,
            originalBytes: 300_000,
            visionArtifactId: null,
            visionBytes: null,
            reason,
        };

        const report = renderLocalAgentReport({
            ...record,
            result: {
                ...record.result,
                candidateVisualReview: {
                    ...review,
                    fullPageOverviewEvidence: {
                        before: {
                            ...windowed,
                            originalArtifactId: review.beforeFullPageArtifactId,
                        },
                        after: { ...windowed, originalArtifactId: review.afterFullPageArtifactId },
                    },
                },
            },
        });

        expect(report).not.toContain('- Full-page coverage: `complete`');
        expect(report).toContain('- Full-page coverage: `tile window only`');
        expect(report).toContain('y=0 to y=1080 of 4000 px were inspected');
    });

    it('keeps declared, observed, reported, actual, and rejected-selection audit fields separate', () => {
        const refinedIntent = {
            issueType: 'incorrect_blocking' as const,
            rationale: 'Browser evidence shows that the declared ad report is a broken article.',
            confidence: 0.88,
            evidence: [
                {
                    source: 'browser' as const,
                    observation: 'The article body is missing while the reported ad is absent.',
                },
            ],
            conflicts: ['The issue-form type says Ads while browser evidence shows breakage.'],
        };
        const auditRecord: LocalRunRecord = {
            ...record,
            result: {
                ...record.result,
                environmentSelection: {
                    ...extensionEnvironmentSelection,
                    observed: refinedIntent,
                    intentHistory: [extensionEnvironmentSelection.observed, refinedIntent],
                    rejectedRequests: [
                        {
                            requestedKind: 'adguard_cli',
                            rationale: 'Try the desktop proxy after seeing the broken article.',
                            confidence: 0.51,
                            rejectedAt: '2026-07-23T10:01:00.000Z',
                            errorKind: 'environment_locked',
                        },
                    ],
                },
            },
        };

        const serialized = JSON.stringify(v.parse(LocalRunRecordSchema, auditRecord));
        const report = renderLocalAgentReport(auditRecord);

        expect(serialized).toContain('"issueFormType":"Ads"');
        expect(serialized).toContain('"issueType":"incorrect_blocking"');
        expect(serialized).toContain('"requestedKind":"adguard_cli"');
        expect(report).toContain('- Declared issue-form type: `Ads`');
        expect(report).toContain('- Observed issue type: `incorrect_blocking`');
        expect(report).toContain('- Reported browser: `Chrome`');
        expect(report).toContain('- Actual browser: `CloakBrowser Chromium`');
        expect(report).toContain('`browser_approximation`');
        expect(report).toContain('`adguard_cli` at `2026-07-23T10:01:00.000Z`');
    });

    it('states which reported filter sources the reproduction left out', () => {
        const skippedRecord: LocalRunRecord = {
            ...record,
            result: {
                ...record.result,
                environmentSelection: {
                    ...extensionEnvironmentSelection,
                    filterBaseline: {
                        status: 'executable',
                        officialFilters: [
                            {
                                filterId: 2,
                                listKey: 'adguard:2',
                                name: 'AdGuard Base filter',
                                reportedName: 'AdGuard Base filter',
                            },
                        ],
                        skippedSources: [
                            { kind: 'third_party_catalog', reportedName: 'EasyList' },
                            {
                                kind: 'custom_subscription',
                                reportedName: 'https://example.test/my.txt',
                            },
                        ],
                    },
                },
            },
        };

        const report = renderLocalAgentReport(skippedRecord);

        expect(report).toContain('EasyList');
        expect(report).toContain('https://example.test/my.txt');
        expect(report).toContain('third_party_catalog');
        expect(report).toContain('custom_subscription');
    });

    it('renders the runner-owned insertion point and adjacent rule anchor', () => {
        const anchoredRecord: LocalRunRecord = {
            ...record,
            result: bindCandidateEvidence({
                ...record.result,
                candidatePatch: {
                    rule: 'wpoznaniu.pl##div[class^="inner-ads-header"]',
                    ruleType: 'cosmetic',
                    syntaxKind: 'element_hiding',
                    filePath: 'BaseFilter/sections/foreign.txt',
                    repositoryEdit: {
                        kind: 'insert',
                        insertionPoint: 9235,
                        anchorRule: 'wpoznaniu.pl##.g-dyn',
                    },
                },
            }),
        };

        const report = renderLocalAgentReport(anchoredRecord);

        expect(report).toContain('- Insertion point: `9235`');
        expect(report).toContain('- Insert before rule: `wpoznaniu.pl##.g-dyn`');
    });

    it('renders the bound rejected viewport/full-page pair and typed vision verdict', () => {
        const rejectedReview = {
            ...fixRunResult.candidateVisualReview!,
            verdict: 'rejected' as const,
            symptom: 'not_resolved' as const,
            rationale: 'The reported target remains visible after applying the candidate.',
        };
        const rejectedShortHash = rejectedReview.validationArtifactId.replace('validation-', '');
        const rejectedReviewPath = `/tmp/run/candidate-visual-review-${rejectedShortHash}.json`;
        const { verifiedCandidateScreenshots: _verified, ...baseArtifactPaths } =
            fixRunResult.artifactPaths;
        const rejectedRecord: LocalRunRecord = {
            ...record,
            result: {
                ...fixRunResult,
                runStatus: 'analysis_only',
                verificationStatus: 'partial',
                candidatePatch: null,
                candidateVisualReview: rejectedReview,
                candidateValidationEvidence: undefined,
                artifactPaths: {
                    ...baseArtifactPaths,
                    candidateVisualReview: rejectedReviewPath,
                    rejectedCandidateScreenshots: {
                        before: '/tmp/run/rejected-before.png',
                        after: '/tmp/run/rejected-after.png',
                        beforeFullPage: '/tmp/run/rejected-before-full-page.png',
                        afterFullPage: '/tmp/run/rejected-after-full-page.png',
                        validationArtifactId: rejectedReview.validationArtifactId,
                        candidateRule: 'example.com##.advert',
                        rejectionReasons: [
                            'vision_rejected',
                            'The reported target remains visible after applying the candidate.',
                        ],
                        visualReview: rejectedReview,
                        visualReviewArtifactPath: rejectedReviewPath,
                    },
                },
            },
            evidence: {
                ...record.evidence,
                beforeScreenshots: [],
                afterScreenshots: [],
                beforeFullPageScreenshots: [],
                afterFullPageScreenshots: [],
                rejectedScreenshots: [
                    '/tmp/run/rejected-before.png',
                    '/tmp/run/rejected-after.png',
                    '/tmp/run/rejected-before-full-page.png',
                    '/tmp/run/rejected-after-full-page.png',
                ],
                rejectedPairs: [
                    {
                        reason: 'vision_rejected, The reported target remains visible after applying the candidate.',
                        beforeScreenshots: ['/tmp/run/rejected-before.png'],
                        afterScreenshots: ['/tmp/run/rejected-after.png'],
                        beforeFullPageScreenshots: ['/tmp/run/rejected-before-full-page.png'],
                        afterFullPageScreenshots: ['/tmp/run/rejected-after-full-page.png'],
                    },
                ],
            },
        };

        const report = renderLocalAgentReport(rejectedRecord);

        expect(report).toContain('- Verdict: `rejected`');
        expect(report).toContain('- Symptom: `not_resolved`');
        expect(report).toContain(rejectedReview.rationale);
        expect(report).toContain('![Rejected before — viewport 1](</tmp/run/rejected-before.png>)');
        expect(report).toContain('![Rejected after — viewport 1](</tmp/run/rejected-after.png>)');
        expect(report).toContain(
            '![Rejected before — full page 1](</tmp/run/rejected-before-full-page.png>)',
        );
        expect(report).toContain(
            '![Rejected after — full page 1](</tmp/run/rejected-after-full-page.png>)',
        );

        expect(() =>
            v.parse(LocalRunRecordSchema, {
                ...rejectedRecord,
                evidence: {
                    ...rejectedRecord.evidence,
                    rejectedPairs: [
                        {
                            ...rejectedRecord.evidence.rejectedPairs![0],
                            afterFullPageScreenshots: ['/tmp/run/foreign.png'],
                        },
                    ],
                },
            }),
        ).toThrow(/rejected visual evidence/i);
    });

    it('renders an unobserved enabled set as not observed instead of an empty table', () => {
        const fileBackedRecord: LocalRunRecord = {
            ...record,
            provenance: {
                ...record.provenance,
                settingsProfiles: [
                    {
                        name: 'agent_selected',
                        status: 'partial',
                        detail: 'The requested profile did not produce complete runtime proof.',
                        activationProof: 'unavailable',
                        enabledFilters: null,
                    },
                ],
            },
        };

        const parsed = v.parse(LocalRunRecordSchema, fileBackedRecord);
        const report = renderLocalAgentReport(fileBackedRecord);

        expect(parsed.provenance.settingsProfiles[0].enabledFilters).toBeNull();
        expect(report).toContain('- Enabled filters: not observed.');
        expect(report).not.toContain('No enabled filters were proven.');
    });
});

describe('unobserved settings evidence', () => {
    it('carries null through the projected run record and still parses', () => {
        const nullRecord = pendingPublicationRecord();

        // The file-backed phase proof observed no filter set, no active rulesets and no Stealth
        // state; the record's embedded settings evidence keeps all three as null and the locked
        // schema accepts it.
        expect(nullRecord.result.settingsEvidence).toMatchObject({
            enabledListKeys: null,
            activeRulesetListKeys: null,
            stealthEnabled: null,
        });

        const parsed = v.safeParse(LocalRunRecordSchema, nullRecord);

        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.output.result.settingsEvidence?.enabledListKeys).toBeNull();
            expect(parsed.output.result.settingsEvidence?.activeRulesetListKeys).toBeNull();
            expect(parsed.output.result.settingsEvidence?.stealthEnabled).toBeNull();
        }
    });
});

describe('LocalRunRecordSchema knowledge guidance citations', () => {
    const knowledgeBaseSha = 'c'.repeat(40);
    const recordWithCitation = (repository: string, url: string) => ({
        ...record,
        provenance: {
            ...record.provenance,
            knowledgeBase: {
                environment: 'current',
                source: 'remote',
                sourceLocation: 'https://kb.example.test/knowledge-base.git',
                requestedRevision: 'master',
                commit: knowledgeBaseSha,
                filtersCommit: 'a'.repeat(40),
                documents: ['docs/general/ad-filtering/create-own-filters.md'],
                citations: [
                    {
                        topic: 'element_hiding',
                        repository,
                        commit: knowledgeBaseSha,
                        filePath: 'docs/general/ad-filtering/create-own-filters.md',
                        anchor: 'cosmetic-elemhide-rules',
                        url,
                    },
                ],
            },
        },
    });

    it('parses citations that name fork repositories', () => {
        const forkRecord = v.parse(
            LocalRunRecordSchema,
            recordWithCitation(
                'fork-owner/knowledge-base',
                'https://github.com/fork-owner/knowledge-base/blob/' +
                    `${knowledgeBaseSha}/docs/general/ad-filtering/create-own-filters.md` +
                    '#cosmetic-elemhide-rules',
            ),
        );

        expect(forkRecord.provenance.knowledgeBase?.citations).toEqual([
            {
                topic: 'element_hiding',
                repository: 'fork-owner/knowledge-base',
                commit: knowledgeBaseSha,
                filePath: 'docs/general/ad-filtering/create-own-filters.md',
                anchor: 'cosmetic-elemhide-rules',
                url:
                    'https://github.com/fork-owner/knowledge-base/blob/' +
                    `${knowledgeBaseSha}/docs/general/ad-filtering/create-own-filters.md` +
                    '#cosmetic-elemhide-rules',
            },
        ]);
    });

    it.each([
        'owner//repo',
        '/fork-owner/knowledge-base',
        'https://github.com/fork-owner/knowledge-base.git',
        // A bare word is neither an owner/repo slug (no slash) nor a host (no dot).
        'knowledge-base',
    ])(
        'rejects a citation repository that is neither an owner/repo slug nor a host (%s)',
        (repository) => {
            expect(() =>
                v.parse(
                    LocalRunRecordSchema,
                    recordWithCitation(
                        repository,
                        'https://github.com/fork-owner/knowledge-base/blob/' +
                            `${knowledgeBaseSha}/docs/general/ad-filtering/create-own-filters.md` +
                            '#cosmetic-elemhide-rules',
                    ),
                ),
            ).toThrow();
        },
    );

    it('parses an instruction citation whose commit is absent', () => {
        const url =
            'https://raw.githubusercontent.com/uBlockOrigin/uAssets/' +
            'master/filters/filters.txt';
        const commitAbsentRecord = {
            ...record,
            provenance: {
                ...record.provenance,
                knowledgeBase: {
                    environment: 'current',
                    source: 'remote',
                    sourceLocation: 'https://kb.example.test/knowledge-base.git',
                    requestedRevision: 'master',
                    commit: knowledgeBaseSha,
                    filtersCommit: 'a'.repeat(40),
                    documents: ['docs/general/ad-filtering/create-own-filters.md'],
                    citations: [
                        {
                            topic: 'element_hiding',
                            repository: 'uBlockOrigin/uAssets',
                            filePath: 'filters/filters.txt',
                            anchor: 'whole-document',
                            url,
                        },
                    ],
                },
            },
        };

        const parsed = v.parse(LocalRunRecordSchema, commitAbsentRecord);

        expect(parsed.provenance.knowledgeBase?.citations).toEqual([
            {
                topic: 'element_hiding',
                repository: 'uBlockOrigin/uAssets',
                commit: undefined,
                filePath: 'filters/filters.txt',
                anchor: 'whole-document',
                url,
            },
        ]);
    });

    it.each(['shortcommit', 'c'.repeat(39), 'c'.repeat(41)])(
        'rejects a citation whose present commit is not a 40-hex digest (%s)',
        (commit) => {
            expect(() =>
                v.parse(LocalRunRecordSchema, {
                    ...record,
                    provenance: {
                        ...record.provenance,
                        knowledgeBase: {
                            environment: 'current',
                            source: 'remote',
                            sourceLocation: 'https://kb.example.test/knowledge-base.git',
                            requestedRevision: 'master',
                            commit: knowledgeBaseSha,
                            filtersCommit: 'a'.repeat(40),
                            documents: ['docs/general/ad-filtering/create-own-filters.md'],
                            citations: [
                                {
                                    topic: 'element_hiding',
                                    repository: 'uBlockOrigin/uAssets',
                                    commit,
                                    filePath: 'filters/filters.txt',
                                    anchor: 'whole-document',
                                    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters.txt',
                                },
                            ],
                        },
                    },
                }),
            ).toThrow();
        },
    );
});

describe('LocalRunRecordSchema instruction provenance', () => {
    // Instruction digests are SHA-256 over files (64 hex), unlike the 40-hex git commits the
    // KnowledgeBase provenance carries.
    const instructionProvenance = {
        path: 'AGENTS.md',
        sha256: 'b'.repeat(64),
        documents: [
            {
                role: 'syntax',
                origin: 'url',
                url: 'https://github.com/uBlockOrigin/uBlock/wiki/Static-filter-syntax',
                digest: 'd'.repeat(64),
            },
            {
                role: 'policy',
                origin: 'checkout_file',
                url: 'filter-policy.md',
                digest: 'e'.repeat(64),
            },
        ],
    };

    it('rides the run provenance as an optional instruction block', () => {
        const parsed = v.parse(LocalRunRecordSchema, {
            ...record,
            provenance: {
                ...record.provenance,
                instruction: instructionProvenance,
            },
        });

        expect(parsed.provenance.instruction).toEqual(instructionProvenance);
    });

    it('still parses a record without an instruction block', () => {
        const parsed = v.parse(LocalRunRecordSchema, record);

        expect(parsed.provenance.instruction).toBeUndefined();
    });

    it.each([
        ['path', { ...instructionProvenance, path: '' }],
        ['sha256', { ...instructionProvenance, sha256: 'short' }],
        ['sha256CommitLength', { ...instructionProvenance, sha256: 'b'.repeat(40) }],
        [
            'documentRole',
            {
                ...instructionProvenance,
                documents: [{ ...instructionProvenance.documents[0], role: 'reference' }],
            },
        ],
        [
            'documentOrigin',
            {
                ...instructionProvenance,
                documents: [{ ...instructionProvenance.documents[0], origin: 'issue' }],
            },
        ],
        [
            'documentUrl',
            {
                ...instructionProvenance,
                documents: [{ ...instructionProvenance.documents[0], url: '' }],
            },
        ],
        [
            'documentDigest',
            {
                ...instructionProvenance,
                documents: [
                    { ...instructionProvenance.documents[0], digest: 'd'.repeat(40) + 'x' },
                ],
            },
        ],
    ] as const)('rejects an instruction provenance with a broken %s', (_field, provenance) => {
        expect(() =>
            v.parse(LocalRunRecordSchema, {
                ...record,
                provenance: { ...record.provenance, instruction: provenance },
            }),
        ).toThrow();
    });
});

describe('writeLocalRunOutput', () => {
    it('does not clear an existing nonowned output directory', () => {
        const root = mkdtempSync(join(tmpdir(), 'local-agent-unowned-output-'));
        const outputDir = join(root, 'run');
        mkdirSync(outputDir);
        writeFileSync(join(outputDir, 'keep.txt'), 'keep', 'utf8');

        try {
            expect(() =>
                writeLocalRunOutput(record, {
                    outputDir,
                    workspaceRoot: process.cwd(),
                    candidatePatchText: '+example.com##.advert',
                }),
            ).toThrow(/not owned|nonempty/i);
            expect(readFileSync(join(outputDir, 'keep.txt'), 'utf8')).toBe('keep');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('separates the exact model decision, observations, Host result, and agent report', () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'local-agent-split-output-'));
        const agentRunArtifacts: AgentRunArtifacts = {
            decision: {
                outcome: 'analysis_only',
                reasoning: 'The model could not find a safe candidate.',
            },
            observations: [
                {
                    sequence: 0,
                    toolCallId: 'issue-1',
                    tool: 'fetch_issue',
                    result: { issueNumber: 4, title: 'Ad remains visible' },
                },
            ],
        };

        const paths = writeLocalRunOutput(record, {
            outputDir,
            workspaceRoot: projectRoot,
            candidatePatchText: '+example.com##.advert',
            agentRunArtifacts,
        });

        expect(JSON.parse(readFileSync(paths.agentDecisionPath!, 'utf8'))).toEqual(
            agentRunArtifacts.decision,
        );
        expect(JSON.parse(readFileSync(paths.agentObservationsPath!, 'utf8'))).toEqual(
            agentRunArtifacts.observations,
        );
        expect(JSON.parse(readFileSync(paths.runResultPath!, 'utf8'))).toEqual(record);
        expect(readFileSync(paths.agentReportPath!, 'utf8')).toBe(
            renderLocalAgentReport(record, agentRunArtifacts.decision),
        );
        const canonicalOutputDir = realpathSync(outputDir);
        expect(paths.runResultPath).toBe(join(canonicalOutputDir, 'run-result.json'));
        expect(paths.agentReportPath).toBe(join(canonicalOutputDir, 'agent-report.md'));
        expect(paths.agentDecisionPath).toBe(join(canonicalOutputDir, 'agent-decision.json'));
        expect(paths.agentObservationsPath).toBe(
            join(canonicalOutputDir, 'agent-observations.json'),
        );
        expect(JSON.parse(readFileSync(paths.llmUsageSummaryPath!, 'utf8'))).toMatchObject({
            requests: 0,
            completions: 0,
            usageCompleteness: 'unreported',
            costUsd: null,
        });
        expect(paths.manifestPath).toBe(join(canonicalOutputDir, 'agent-run-manifest.json'));
        expect(verifyLocalRunManifest(outputDir).runId).toMatch(/^[0-9a-f]{64}$/u);
        expect(existsSync(join(outputDir, 'report.md'))).toBe(false);
        expect(existsSync(join(outputDir, 'result.json'))).toBe(false);
    });

    it('writes and digest-locks the provider-level usage summary and rejects a changed file', () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'local-agent-usage-output-'));
        const collector = createRunUsageCollector({
            rates: {
                'deepseek-v4-flash': {
                    inputUsdPerMillionTokens: 0.14,
                    outputUsdPerMillionTokens: 0.28,
                },
            },
        });
        collector.addSession({
            completions: [
                {
                    model: 'deepseek-v4-flash',
                    reported: true,
                    input: 100,
                    output: 20,
                    cacheRead: 10,
                    cacheWrite: 0,
                    reasoningTokens: 5,
                },
            ],
            durationMs: 1_000,
        });
        const summary = collector.summary();

        const paths = writeLocalRunOutput(record, {
            outputDir,
            workspaceRoot: projectRoot,
            candidatePatchText: '+example.com##.advert',
            llmUsage: summary,
        });

        expect(JSON.parse(readFileSync(paths.llmUsageSummaryPath!, 'utf8'))).toEqual(summary);
        expect(
            v.parse(
                RunUsageSummarySchema,
                JSON.parse(readFileSync(paths.llmUsageSummaryPath!, 'utf8')),
            ),
        ).toMatchObject({
            requests: 1,
            completions: 1,
            tokens: { input: 100, output: 20, cacheRead: 10, cacheWrite: 0, reasoningTokens: 5 },
        });
        const manifest = verifyLocalRunManifest(outputDir);
        expect(manifest.artifacts).toMatchObject({
            llmUsageSummary: expect.objectContaining({ path: 'llm-usage-summary.json' }),
        });
        // A run written now declares the version whose artifact set it actually has, and stores
        // the usage summary shape that version pairs with.
        expect(manifest.schemaVersion).toBe(LocalRunManifestVersion.UsageSummary);
        expect(summary.schemaVersion).toBe(UsageSummaryVersion.Run);

        // No JSONL ledger artifact exists — the per-attempt contract is retired.
        expect(existsSync(join(outputDir, 'llm-usage.jsonl'))).toBe(false);

        writeFileSync(paths.llmUsageSummaryPath!, '{}\n', 'utf8');
        expect(() => verifyLocalRunManifest(outputDir)).toThrow(/digest mismatch/i);
    });

    it('rejects a canonical artifact changed after the manifest lock', () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'local-agent-tampered-output-'));
        const paths = writeLocalRunOutput(record, {
            outputDir,
            workspaceRoot: projectRoot,
            candidatePatchText: '+example.com##.advert',
        });

        writeFileSync(paths.agentReportPath, 'tampered\n', 'utf8');

        expect(() => verifyLocalRunManifest(outputDir)).toThrow(/digest mismatch/i);
    });

    it('rejects foreign top-level files and symlinked canonical files inside a locked run', () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'local-agent-boundary-output-'));
        const paths = writeLocalRunOutput(record, {
            outputDir,
            workspaceRoot: projectRoot,
            candidatePatchText: '+example.com##.advert',
        });
        writeFileSync(join(outputDir, 'benchmark-record.json'), '{}\n', 'utf8');

        expect(() => verifyLocalRunManifest(outputDir)).toThrow(/foreign artifact/i);

        rmSync(join(outputDir, 'benchmark-record.json'));
        rmSync(paths.agentReportPath);
        symlinkSync('run-result.json', paths.agentReportPath);
        expect(() => verifyLocalRunManifest(outputDir)).toThrow(/immutable run artifact/i);
    });

    it('binds every evidence file and rejects evidence changed after the manifest lock', () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'local-agent-evidence-output-'));
        materializeLocalRunOutputDir(outputDir, process.cwd());
        const evidenceDirectory = join(outputDir, 'artifacts', 'vision');
        const evidencePath = join(evidenceDirectory, 'full-page.png');
        mkdirSync(evidenceDirectory, { recursive: true });
        writeFileSync(evidencePath, Buffer.from('original screenshot'));

        writeLocalRunOutput(record, {
            outputDir,
            workspaceRoot: projectRoot,
            candidatePatchText: '+example.com##.advert',
        });

        const manifest = verifyLocalRunManifest(outputDir);
        expect(manifest.evidence).toEqual([
            expect.objectContaining({
                path: 'artifacts/vision/full-page.png',
                sha256: createHash('sha256').update('original screenshot').digest('hex'),
            }),
        ]);

        writeFileSync(evidencePath, Buffer.from('tampered screenshot'));
        expect(() => verifyLocalRunManifest(outputDir)).toThrow(/evidence digest set/i);
    });

    it('rejects hardlinked canonical and evidence artifacts', () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'local-agent-hardlink-output-'));
        materializeLocalRunOutputDir(outputDir, process.cwd());
        const evidenceDirectory = join(outputDir, 'artifacts');
        const evidencePath = join(evidenceDirectory, 'trace.json');
        mkdirSync(evidenceDirectory);
        writeFileSync(evidencePath, '{}\n', 'utf8');
        const paths = writeLocalRunOutput(record, {
            outputDir,
            workspaceRoot: projectRoot,
            candidatePatchText: '+example.com##.advert',
        });

        linkSync(paths.runResultPath, join(outputDir, 'run-result-hardlink'));
        expect(() => verifyLocalRunManifest(outputDir)).toThrow(/unlinked regular file/i);

        rmSync(join(outputDir, 'run-result-hardlink'));
        linkSync(evidencePath, join(outputDir, 'evidence-hardlink'));
        expect(() => verifyLocalRunManifest(outputDir)).toThrow(/unlinked regular file/i);
    });

    it('writes the validated record, report, and exact candidate patch outside the workspace', () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'local-agent-output-'));
        const patch = [
            '--- a/BaseFilter/sections/foreign.txt',
            '+++ b/BaseFilter/sections/foreign.txt',
            '@@ -1,0 +2 @@',
            '+example.com##.advert',
        ].join('\n');

        const paths = writeLocalRunOutput(record, {
            outputDir,
            workspaceRoot: projectRoot,
            candidatePatchText: patch,
        });

        expect(JSON.parse(readFileSync(paths.runResultPath, 'utf8'))).toEqual(record);
        expect(readLocalRunOutput(paths.runResultPath)).toEqual(record);
        expect(readFileSync(paths.agentReportPath, 'utf8')).toBe(renderLocalAgentReport(record));
        expect(readFileSync(paths.candidatePatchPath!, 'utf8')).toBe(`${patch}\n`);
    });

    it('names every other affected domain and never presents them as verified', () => {
        const extensionRecord: LocalRunRecord = {
            ...record,
            result: bindCandidateEvidence({
                ...record.result,
                candidatePatch: {
                    rule: 'nettg.pl##.banner',
                    ruleType: 'cosmetic',
                    syntaxKind: 'element_hiding',
                    filePath: 'BaseFilter/sections/foreign.txt',
                    repositoryEdit: {
                        kind: 'extend_domains',
                        line: 7383,
                        originalRule: 'one.pl,two.pl##.banner',
                        replacementRule: 'nettg.pl,one.pl,two.pl##.banner',
                    },
                },
            }),
        };

        const report = renderLocalAgentReport(extensionRecord);

        expect(report).toContain('- Verified scope: `nettg.pl`');
        expect(report).toContain('- Also affected, not verified by this run: `one.pl`, `two.pl`');
        expect(report).toContain('- Regression risk: `elevated`');
    });

    it('names every domain a culprit correction also affects and verifies none of them', () => {
        const correctionRecord: LocalRunRecord = {
            ...record,
            result: bindCandidateEvidence({
                ...record.result,
                candidatePatch: {
                    rule: 'one.pl,two.pl##.banner.ad',
                    ruleType: 'cosmetic',
                    syntaxKind: 'element_hiding',
                    filePath: 'BaseFilter/sections/foreign.txt',
                    repositoryEdit: {
                        kind: 'replace',
                        line: 7383,
                        originalRule: 'one.pl,two.pl##.banner',
                        replacementRule: 'one.pl,two.pl##.banner.ad',
                    },
                },
            }),
        };

        const report = renderLocalAgentReport(correctionRecord);

        expect(report).toContain('- Replaced source line: `7383`');
        expect(report).toContain('- Original rule: `one.pl,two.pl##.banner`');
        expect(report).toContain('- Also affected, not verified by this run: `one.pl`, `two.pl`');
        expect(report).toContain(
            '- Regression risk: `elevated` — only the reported site was validated experimentally',
        );
    });

    it('names every domain a removal stops filtering and never presents them as verified', () => {
        const removalRecord: LocalRunRecord = {
            ...record,
            result: bindCandidateEvidence({
                ...record.result,
                candidatePatch: {
                    rule: 'one.pl,two.pl##.banner',
                    ruleType: 'cosmetic',
                    syntaxKind: 'element_hiding',
                    filePath: 'BaseFilter/sections/foreign.txt',
                    repositoryEdit: {
                        kind: 'remove',
                        line: 7383,
                        originalRule: 'one.pl,two.pl##.banner',
                    },
                },
            }),
        };

        const report = renderLocalAgentReport(removalRecord);

        expect(report).toContain('- Removed source line: `7383`');
        expect(report).toContain('- Removed rule: `one.pl,two.pl##.banner`');
        expect(report).toContain('- Also affected, not verified by this run: `one.pl`, `two.pl`');
        expect(report).toContain(
            '- Regression risk: `elevated` — only the reported site was validated experimentally',
        );
    });

    it.each([
        [
            'a correction',
            {
                rule: 'example.com##.banner.ad',
                repositoryEdit: {
                    kind: 'replace' as const,
                    line: 7383,
                    originalRule: '##.banner',
                    replacementRule: 'example.com##.banner.ad',
                },
            },
        ],
        [
            'a removal',
            {
                rule: '##.banner',
                repositoryEdit: {
                    kind: 'remove' as const,
                    line: 7383,
                    originalRule: '##.banner',
                },
            },
        ],
    ])('discloses the widest blast radius %s of a global culprit can have', (_name, patch) => {
        const globalRecord: LocalRunRecord = {
            ...record,
            result: bindCandidateEvidence({
                ...record.result,
                candidatePatch: {
                    ...patch,
                    ruleType: 'cosmetic',
                    syntaxKind: 'element_hiding',
                    filePath: 'BaseFilter/sections/foreign.txt',
                },
            }),
        };

        const report = renderLocalAgentReport(globalRecord);

        expect(report).toContain(
            '- Also affected, not verified by this run: every site this rule matches',
        );
    });

    it('refuses a removal diff unless the line left and did not come back', () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'local-agent-removal-output-'));
        const removalRecord: LocalRunRecord = {
            ...record,
            result: bindCandidateEvidence({
                ...record.result,
                candidatePatch: {
                    rule: 'one.pl,two.pl##.banner',
                    ruleType: 'cosmetic',
                    syntaxKind: 'element_hiding',
                    filePath: 'BaseFilter/sections/foreign.txt',
                    repositoryEdit: {
                        kind: 'remove',
                        line: 7383,
                        originalRule: 'one.pl,two.pl##.banner',
                    },
                },
            }),
        };

        for (const candidatePatchText of [
            '+one.pl,two.pl##.banner.ad',
            ['-one.pl,two.pl##.banner', '+one.pl,two.pl##.banner'].join('\n'),
        ]) {
            expect(() =>
                writeLocalRunOutput(removalRecord, {
                    outputDir,
                    workspaceRoot: projectRoot,
                    candidatePatchText,
                }),
            ).toThrow(/locked repository edit/i);
        }

        const paths = writeLocalRunOutput(removalRecord, {
            outputDir,
            workspaceRoot: projectRoot,
            candidatePatchText: '-one.pl,two.pl##.banner',
        });
        expect(existsSync(paths.candidatePatchPath!)).toBe(true);
    });

    it('refuses a culprit-correction diff that is not the exact locked replacement', () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'local-agent-correction-output-'));
        const correctionRecord: LocalRunRecord = {
            ...record,
            result: bindCandidateEvidence({
                ...record.result,
                candidatePatch: {
                    rule: 'one.pl,two.pl##.banner.ad',
                    ruleType: 'cosmetic',
                    syntaxKind: 'element_hiding',
                    filePath: 'BaseFilter/sections/foreign.txt',
                    repositoryEdit: {
                        kind: 'replace',
                        line: 7383,
                        originalRule: 'one.pl,two.pl##.banner',
                        replacementRule: 'one.pl,two.pl##.banner.ad',
                    },
                },
            }),
        };

        expect(() =>
            writeLocalRunOutput(correctionRecord, {
                outputDir,
                workspaceRoot: projectRoot,
                candidatePatchText: '+one.pl,two.pl##.banner.ad',
            }),
        ).toThrow(/locked repository edit/i);

        const paths = writeLocalRunOutput(correctionRecord, {
            outputDir,
            workspaceRoot: projectRoot,
            candidatePatchText: ['-one.pl,two.pl##.banner', '+one.pl,two.pl##.banner.ad'].join(
                '\n',
            ),
        });
        expect(existsSync(paths.candidatePatchPath!)).toBe(true);
    });

    it('accepts an exact domain-extension diff that replaces a shared rule', () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'local-agent-extension-output-'));
        const extensionRecord: LocalRunRecord = {
            ...record,
            result: bindCandidateEvidence({
                ...record.result,
                candidatePatch: {
                    rule: 'nettg.pl##.banner',
                    ruleType: 'cosmetic',
                    syntaxKind: 'element_hiding',
                    filePath: 'BaseFilter/sections/foreign.txt',
                    repositoryEdit: {
                        kind: 'extend_domains',
                        line: 7383,
                        originalRule: 'one.pl,two.pl##.banner',
                        replacementRule: 'nettg.pl,one.pl,two.pl##.banner',
                    },
                },
            }),
        };
        const patch = ['-one.pl,two.pl##.banner', '+nettg.pl,one.pl,two.pl##.banner'].join('\n');

        const paths = writeLocalRunOutput(extensionRecord, {
            outputDir,
            workspaceRoot: projectRoot,
            candidatePatchText: patch,
        });

        expect(readFileSync(paths.candidatePatchPath!, 'utf8')).toBe(`${patch}\n`);
    });

    it('allows output under the project-local tmp tree', () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'local-agent-workspace-'));
        const outputDir = join(workspaceRoot, 'tmp', 'adguard-agent-runs', 'issue-4-historical');
        try {
            const paths = writeLocalRunOutput(record, {
                outputDir,
                workspaceRoot,
                candidatePatchText: '+example.com##.advert',
            });

            expect(paths.agentReportPath).toBe(join(realpathSync(outputDir), 'agent-report.md'));
            expect(existsSync(paths.runResultPath)).toBe(true);
        } finally {
            rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('rejects arbitrary output directories inside the repository', () => {
        expect(() =>
            writeLocalRunOutput(record, {
                outputDir: join(projectRoot, '.benchmark', 'results'),
                workspaceRoot: projectRoot,
                candidatePatchText: '+example.com##.advert',
            }),
        ).toThrow(/project tmp/i);
    });

    it('rejects report evidence that is not the exact runner-bound four-image pair', () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'local-agent-mismatched-evidence-'));

        expect(() =>
            writeLocalRunOutput(
                {
                    ...record,
                    evidence: {
                        ...record.evidence,
                        afterFullPageScreenshots: ['/tmp/run/unrelated-full-page.png'],
                    },
                },
                {
                    outputDir,
                    workspaceRoot: projectRoot,
                    candidatePatchText: '+example.com##.advert',
                },
            ),
        ).toThrow(/visual evidence/i);
    });

    it('removes a stale candidate patch when a rerun has no candidate', () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'local-agent-no-candidate-'));
        writeLocalRunOutput(record, {
            outputDir,
            workspaceRoot: projectRoot,
            candidatePatchText: '+example.com##.advert',
        });
        writeFileSync(join(outputDir, 'reviewer-report.md'), 'stale review\n', 'utf8');
        writeFileSync(join(outputDir, 'reviewer-result.json'), '{}\n', 'utf8');

        const noCandidateRecord: LocalRunRecord = {
            ...record,
            result: {
                ...record.result,
                runStatus: 'not_reproduced',
                verificationStatus: 'not_attempted',
                candidatePatch: null,
                candidateVisualReview: undefined,
                candidateValidationEvidence: undefined,
                artifactPaths: {
                    ...record.result.artifactPaths,
                    candidateVisualReview: null,
                    verifiedCandidateScreenshots: undefined,
                },
            },
            evidence: {
                ...record.evidence,
                beforeScreenshots: [],
                afterScreenshots: [],
                beforeFullPageScreenshots: [],
                afterFullPageScreenshots: [],
            },
        };
        const paths = writeLocalRunOutput(noCandidateRecord, {
            outputDir,
            workspaceRoot: projectRoot,
        });

        expect(paths.candidatePatchPath).toBeNull();
        expect(existsSync(join(outputDir, 'candidate.patch'))).toBe(false);
        expect(existsSync(join(outputDir, 'reviewer-report.md'))).toBe(false);
        expect(existsSync(join(outputDir, 'reviewer-result.json'))).toBe(false);
    });
});
