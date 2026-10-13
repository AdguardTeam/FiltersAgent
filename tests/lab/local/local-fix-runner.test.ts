import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vitest from 'vitest';
import { createHash } from 'node:crypto';
import type { CoreConfig } from '../../../src/config/config';
import { EnvironmentSelectionHost } from '../../../src/environment/environment-selection';
import { extensionExecutorDescriptor } from '../../environment/test-filtering-environment-fixtures';
import { ToolRegistry } from '../../../src/agent/tool-registry';
import { ExtensionManifestVersion } from '../../../src/environment/extension-preparation';
import {
    GuidanceDocumentOrigin,
    GuidanceDocumentRole,
    RuleGuidanceSourceKind,
} from '../../../src/knowledge/guidance-source';
import { runFixCore } from '../../../src/orchestrator/fix-core';
import {
    type FixCoreDependencies,
    type FixCoreIssueInput,
    type FixCoreOptions,
} from '../../../src/orchestrator/fix-core-inputs';
import { type PiRuntime } from '../../../src/pi/runtime';
import type { SingleShotClient } from '../../../src/pi/single-shot-types';
import {
    HermeticScenario,
    type HermeticProvider,
    type ScriptedReply,
    ScriptedReplyKind,
    startHermeticProvider,
} from '../../pi/hermetic-provider';
import type { FixRunResult } from '../../../src/types/fix-run-result';
import type { UpstreamSourceDrift } from '../../../src/types/upstream-source-drift';
import type { RawIssue } from '../../../src/github/fetch-issue';
import { IntakeExtractionKind, type IntakeExtraction } from '../../../src/intake/extract-report';
import type { LocalFixRunnerDependencies } from '../../../lab/local/local-fix-runner';
import { createRuntimeTraceRecorder } from '../../../src/tracer/runtime-recorder';
import { buildLocalIssueSnapshot } from '../../../src/local/issue-snapshot';
import {
    renderLocalCandidatePatch,
    runLocalFix,
    runLocalFixFromRevision,
} from '../../../lab/local/local-fix-runner';
import {
    buildExportedIssueRevision,
    loadVerifiedExportedIssueRevision,
} from '../../../src/local/issue-revision';
import { materializeLocalRunOutputDir } from '../../../src/local/output-directory';
import { readLocalRunOutput } from '../../../src/local/run-output';
import type { PreparedFiltersCheckout } from '../../../src/local/filters-preparer';
import type { PreparedKnowledgeBase } from '../../../lab/local/knowledge-base-preparer';
import type {
    FiltersPreparationConfig,
    KnowledgeBasePreparationConfig,
} from '../../../src/local/run-config-types';
import { LocalExecutionInfrastructureError } from '../../../lab/local/cycle-outcome';
import { createTestPiRuntime } from '../../pi/test-runtime';
import { testCoreConfig } from '../../config/test-core-config';

const { describe, expect, it, vi, afterEach } = vitest;

let hermetic: HermeticProvider | undefined;

/**
 * Release tag the fixture unpacked build claims for the stubbed pinned-release seam.
 */
const PINNED_RELEASE_FIXTURE_TAG = 'v5.5.2.3';

/**
 * Digest the stubbed pinned-release seam records as the fixture build's source pin.
 */
const PINNED_RELEASE_FIXTURE_SHA256 = 'e'.repeat(64);

/**
 * Materialize one loadable unpacked extension directory for the stubbed pinned-release seam: the
 * run's pre-run preparation consumes it instead of reaching the release network.
 *
 * @param parentDir - Directory to place the unpacked build under.
 * @returns Absolute path of the unpacked directory.
 */
function writeUnpackedExtensionFixture(parentDir: string): string {
    const unpacked = join(parentDir, 'unpacked');
    mkdirSync(unpacked, { recursive: true });
    writeFileSync(
        join(unpacked, 'manifest.json'),
        JSON.stringify({ version: '5.5.2.3', manifest_version: 3 }),
        'utf8',
    );
    return unpacked;
}

afterEach(async () => {
    if (!hermetic) {
        return;
    }
    await hermetic.close();
    hermetic = undefined;
});

/**
 * A sealed vision client for fixtures whose runs never exercise the pre-agent vision pipeline:
 * every call is recorded and rejected, so a wiring regression fails loudly at the boundary.
 *
 * @returns The stub client and its recorded call log.
 */
function sealedVisionClient(): { vision: SingleShotClient; requests: unknown[] } {
    const requests: unknown[] = [];
    const refuse = async (signal: unknown): Promise<never> => {
        requests.push(signal);
        throw new Error('Vision provider must not be invoked by the local runner fixture.');
    };
    return {
        vision: {
            modelId: 'vision-stub',
            structured: (options) => refuse(options),
            text: (options) => refuse(options),
        },
        requests,
    };
}

/**
 * Scripted tool-call reply for the hermetic provider.
 *
 * @param name - The tool the scripted model calls.
 * @param args - JSON-encodable call arguments.
 * @returns The scripted reply.
 */
function toolCall(name: string, args: unknown): ScriptedReply {
    return {
        kind: ScriptedReplyKind.ToolCall,
        toolName: name,
        toolArguments: JSON.stringify(args),
    };
}

/**
 * Start a hermetic provider serving the script and wrap it into a pi runtime for the agentic loop.
 *
 * @param script - The tool-call/prose reply sequence the agent loop consumes.
 * @returns The pi runtime over the hermetic provider.
 */
async function scriptedPiRuntime(script: ScriptedReply[]): Promise<PiRuntime> {
    hermetic = await startHermeticProvider({ scenario: HermeticScenario.Scripted, script });
    return createTestPiRuntime({
        baseUrl: hermetic.baseUrl,
        model: 'test-model',
        visionModel: 'gemini-3.5-flash',
    });
}

const coreConfig: CoreConfig = testCoreConfig({
    llm: { apiKey: 'local-key', visionModel: 'gemini-3.5-flash' },
});

/**
 * The report a deterministic extraction of the shared fixture issues produces: the site URL comes
 * from the fixture body, so the runner derives the same domain the retired parser did. Every
 * runLocalFix suite injects this seam; no suite reaches the provider network.
 */
const extractionSeam = {
    extractReport: async (raw: RawIssue): Promise<IntakeExtraction> => {
        const siteUrl = raw.body?.match(/### Issue URL[^\n]*\n(https?:\/\/[^\s)\]]+)/)?.[1];
        return {
            kind: IntakeExtractionKind.Report,
            report: {
                siteUrls: siteUrl ? [siteUrl] : ['https://example.com/article'],
                problemType: 'ads',
                screenshots: [],
                environment: { product: 'AdGuard Browser Extension v5.4.3' },
                enabledLists: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
                userRules: [],
                reproductionSteps: [],
            },
        };
    },
} satisfies Partial<LocalFixRunnerDependencies>;

const browserSessionProfile = {
    viewport: 'desktop' as const,
    locale: 'en-US',
    timezone: 'UTC',
    userAgentProfile: 'Chromium',
    consentStrategy: 'untouched' as const,
};

function hasUnsafeControl(value: string): boolean {
    return Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return (
            (codePoint >= 0 && codePoint <= 8) ||
            (codePoint >= 11 && codePoint <= 31) ||
            (codePoint >= 127 && codePoint <= 159)
        );
    });
}

const rawIssue = {
    number: 4,
    url: 'https://github.com/example/lab/issues/4',
    title: 'Ad remains visible',
    body: [
        '### Issue URL (Ads)',
        'https://example.com/article',
        '',
        '### Issue configuration',
        '[Import settings](https://reports.adguard.com/en/new_issue.html?product_version=5.4.3.95&regular_filters=2.3.17&stealth.enabled=false)',
        '',
        '### System configuration',
        'AdGuard product: | AdGuard Browser Extension v5.4.3',
        'Filters: | AdGuard Base filter',
    ].join('\n'),
    state: 'closed' as const,
    labels: ['T: Ads', 'N: AdGuard Browser Extension'],
    assignee: null,
    comments: [],
};

const rawIssueWithoutImport = {
    ...rawIssue,
    body: [
        '### Issue URL (Ads)',
        'https://wpoznaniu.pl/article',
        '',
        '### System configuration',
        'AdGuard product: | AdGuard Browser Extension v5.4.3',
        'Filters: | **Ad blocking:** AdGuard Base filter v2.0.54.62<br>' +
            'AdGuard Polish filter v2.0.10.1<br>AdGuard Annoyances filter v2.0.20.1',
    ].join('\n'),
};

/**
 * Build a ready Extension selection for a newly produced agentic result.
 *
 * @returns Host-validated selection with adapter-owned actual context.
 */
function extensionEnvironmentSelection() {
    const host = new EnvironmentSelectionHost(
        {
            issueNumber: 4,
            issueUrl: 'https://github.com/example/lab/issues/4',
            reportedSiteUrls: ['https://example.com/article'],
            labels: ['T: Ads', 'N: AdGuard Browser Extension'],
            declaredIssueType: 'Ads',
            problemType: 'ads',
            product: 'AdGuard Browser Extension v5.4.3',
            enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
            settingsImportUrl:
                'https://reports.adguard.com/en/new_issue.html?product_version=5.4.3.95&regular_filters=2.3.17&stealth.enabled=false',
            screenshots: [],
        },
        [extensionExecutorDescriptor()],
    );
    host.select({
        kind: 'browser_extension',
        requiredCapabilities: ['browser_navigation'],
        intent: {
            issueType: 'ads',
            rationale: 'The report describes a visible advertisement on a website.',
            confidence: 0.95,
            evidence: [
                {
                    source: 'issue_body',
                    observation: 'The issue body identifies a page-level advertising symptom.',
                },
            ],
            conflicts: [],
        },
        rationale: 'Use the Browser Extension for this ordinary website-filtering report.',
        confidence: 0.95,
    });
    host.bindActualContext('browser_extension', {
        product: 'AdGuard Browser Extension',
        browser: 'CloakBrowser Chromium',
        productVersion: '5.4.3.95',
    });
    return host.snapshot()!;
}

/**
 * Build a stable core result for local-wrapper tests.
 *
 * @param overrides - Result fields that differ in the scenario.
 * @returns Complete local core result.
 */
function coreResult(overrides: Partial<FixRunResult> = {}): FixRunResult {
    return {
        issueNumber: 4,
        domain: 'example.com',
        runStatus: 'not_reproduced',
        requestedBrowserMode: 'auto',
        effectiveMode: 'browser',
        verificationStatus: 'verified',
        reproductionSettingsStatus: 'applied',
        reproductionSettingsDetail: 'Controlled profile verified.',
        environmentSelection: extensionEnvironmentSelection(),
        fallbackReason: null,
        fallbackDetail: null,
        candidatePatch: null,
        artifactPaths: {
            screenshots: [],
            domSnapshot: null,
            har: null,
            trace: '/tmp/trace.json',
            settingsProof: null,
        },
        reasoning: 'The reported symptom was absent.',
        repository: 'AdguardTeam/AdguardFilters',
        baseSha: 'a'.repeat(40),
        ...overrides,
    };
}

/**
 * Build core-owned pinned-release provenance as the host-side preparation serializes it.
 *
 * @param tag - Release tag the downloaded and verified build came from.
 * @param commit - Stable record identity mixed into the fixture digest.
 * @returns Core-owned extension provenance consumed by the local report adapter.
 */
function agentExtensionProvenance(tag: string, commit: string) {
    return {
        source: 'pinned_release' as const,
        extensionPath: '/tmp/cache/extensions/prebuilt/v5.5.2.3/unpacked',
        manifestVersion: 3 as const,
        extensionSourceSha256: createHash('sha256').update(`${tag}@${commit}`).digest('hex'),
        extensionSourceTag: tag,
    };
}

/**
 * Build settings evidence returned after the agent launches its selected extension profile.
 *
 * @param enabledFilterIds - Filter IDs verified by the browser runtime.
 * @returns Core-owned settings summary consumed by the local report adapter.
 */
function agentSettingsEvidence(enabledListKeys: string[]) {
    return {
        profileKind: 'agent_selected' as const,
        enabledListKeys,
        activeRulesetListKeys: enabledListKeys,
        stealthEnabled: false,
        limitsExceeded: false,
    };
}

/**
 * Enumerate every regular file below one local run root.
 *
 * @param root - Directory whose persisted artifacts should be inspected.
 * @returns Absolute regular-file paths.
 */
function persistedFiles(root: string): string[] {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const path = join(root, entry.name);
        return entry.isDirectory() ? persistedFiles(path) : entry.isFile() ? [path] : [];
    });
}

/**
 * Selection arguments for the strict select_environment advertisement.
 *
 * @param kind - The environment kind the run locks.
 * @returns The parsed selection call arguments.
 */
function selectionArguments(kind: 'adguard_cli' | 'unsupported_product_case') {
    return {
        kind,
        requiredCapabilities: [],
        intent: {
            issueType: kind === 'adguard_cli' ? 'ads' : 'product_specific',
            rationale: 'The issue evidence determines this environment choice.',
            confidence: 0.9,
            evidence: [
                {
                    source: 'issue_body',
                    observation: 'The report identifies the affected product surface.',
                },
            ],
            conflicts: [],
        },
        rationale: 'The selected environment matches the reported capability.',
        confidence: 0.85,
    };
}

/**
 * Stand in for the upstream observation so no local test reaches the network to make one.
 *
 * @param request - Observation request carrying the commit the run is pinned to.
 * @returns Drift record reporting that upstream was never seen.
 */
async function observeNoUpstream(request: { pinnedCommit: string }): Promise<UpstreamSourceDrift> {
    return {
        status: 'unobserved',
        pinnedCommit: request.pinnedCommit,
        upstreamCommit: null,
        observedAt: '2026-07-29T10:00:00.000Z',
    };
}

async function prepareKnowledgeBase<T>(
    config: KnowledgeBasePreparationConfig,
    filters: PreparedFiltersCheckout,
    callback: (prepared: PreparedKnowledgeBase) => Promise<T>,
): Promise<T> {
    return await callback({
        checkoutPath: '/tmp/knowledge-base',
        guidanceSource: {
            kind: RuleGuidanceSourceKind.KnowledgeBase,
            knowledgeBaseCommit: 'c'.repeat(40),
            filtersCommit: filters.provenance.commit,
            knowledgeBaseRepository: config.knowledgeBaseRepository,
            filtersRepository: config.filtersRepository,
            syntaxPath: '/tmp/knowledge-base/create-own-filters.md',
            policyPath: '/tmp/knowledge-base/filter-policy.md',
            contributingPath: join(filters.filtersPath, 'CONTRIBUTING.md'),
        },
        provenance: {
            environment: 'current',
            source: 'local-shared-clone',
            sourceLocation: '/tmp/KnowledgeBase',
            requestedRevision: 'master',
            commit: 'c'.repeat(40),
            filtersCommit: filters.provenance.commit,
            documents: [
                'docs/general/ad-filtering/create-own-filters.md',
                'docs/general/ad-filtering/filter-policy.md',
                'CONTRIBUTING.md',
            ],
        },
    });
}

/**
 * A filters-preparation lifecycle stand-in that hands the callback one exact fixture checkout.
 *
 * @param checkoutPath - Absolute fixture filters checkout the runner treats as prepared.
 * @returns The injectable withPreparedFiltersCheckout seam.
 */
function preparedCheckoutStub(checkoutPath: string) {
    return async <T>(
        _config: FiltersPreparationConfig,
        callback: (prepared: PreparedFiltersCheckout) => Promise<T>,
    ): Promise<T> =>
        await callback({
            filtersPath: checkoutPath,
            checkoutPath,
            provenance: {
                environment: 'current',
                source: 'local-shared-clone',
                sourceLocation: '/tmp/AdguardFilters',
                requestedRevision: 'master',
                commit: 'a'.repeat(40),
            },
        });
}

describe('runLocalFix', () => {
    it.each([
        {
            name: 'AdGuard CLI capability limitation',
            kind: 'adguard_cli' as const,
            status: 'capability_limited' as const,
            state: 'capability_limited' as const,
            issue: {
                ...rawIssue,
                body: [
                    '### Issue URL (Ads)',
                    'https://example.com/article',
                    '',
                    '### System configuration',
                    'AdGuard product: | AdGuard for Windows',
                    'System version: | Windows 11',
                    'Browser: | Edge',
                    'Filters: | AdGuard Base filter',
                ].join('\n'),
                labels: ['T: Ads', 'N: AdGuard for Windows'],
            },
            reportEvidence: '`module_not_provided`',
        },
        {
            name: 'unsupported product capability',
            kind: 'unsupported_product_case' as const,
            status: 'unsupported_product_case' as const,
            state: 'unsupported' as const,
            issue: {
                ...rawIssue,
                title: 'Browser Assistant does not open',
                body: [
                    '### Issue URL (Other)',
                    'https://example.com/article',
                    '',
                    '### System configuration',
                    'AdGuard product: | AdGuard for Windows',
                    'Browser: | Edge',
                    '',
                    'Browser Assistant does not open from the toolbar.',
                ].join('\n'),
                labels: ['N: AdGuard for Windows'],
            },
            reportEvidence: '- State: `unsupported`',
        },
    ])(
        'persists and reads back the actual $name core outcome',
        async ({ kind, status, state, issue, reportEvidence }) => {
            const caseDir = mkdtempSync(join(tmpdir(), `local-fix-${kind}-case-`));
            const outputDir = mkdtempSync(join(tmpdir(), `local-fix-${kind}-output-`));
            const issueFile = join(caseDir, 'issue.json');
            const filtersPath = join(caseDir, 'filters');
            mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
            writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '', 'utf8');
            writeFileSync(issueFile, JSON.stringify(buildLocalIssueSnapshot(issue, [])), 'utf8');
            const piRuntime = await scriptedPiRuntime([
                toolCall('fetch_issue', { issueNumber: 4 }),
                toolCall('select_environment', selectionArguments(kind)),
                toolCall('finish_fix', {
                    outcome: 'analysis_only',
                    reasoning:
                        kind === 'adguard_cli'
                            ? 'The selected CLI route could not be prepared.'
                            : 'The report concerns an unsupported product capability.',
                }),
            ]);
            const vision = sealedVisionClient().vision;
            const unpackedExtension = writeUnpackedExtensionFixture(caseDir);

            const paths = await runLocalFix(
                coreConfig,
                {
                    issueNumber: 4,
                    issueFile,
                    environment: 'current',
                    outputDir,
                    keepTemporaryFiles: false,
                    browserMode: 'auto',
                    verbose: false,
                },
                {
                    ...extractionSeam,
                    runFixCore: async (config, input, options, dependencies) =>
                        await runFixCore(config, input, options, {
                            ...dependencies,
                            vision,
                            piRuntime,
                            // The run's pre-run extension preparation is stubbed: this suite
                            // exercises desktop-route outcomes, never the release network.
                            downloadPinnedExtensionRelease: async () => ({
                                extensionDir: unpackedExtension,
                                manifestVersion: ExtensionManifestVersion.Mv3,
                                sha256: PINNED_RELEASE_FIXTURE_SHA256,
                                tag: PINNED_RELEASE_FIXTURE_TAG,
                                fromCache: false,
                            }),
                            agentRuntime: {
                                createBaseRegistry: async () => new ToolRegistry(),
                            },
                        }),
                    withPreparedKnowledgeBase: prepareKnowledgeBase,
                    observeUpstreamDrift: observeNoUpstream,
                    withPreparedFiltersCheckout: async (_config, callback) =>
                        await callback({
                            filtersPath,
                            checkoutPath: filtersPath,
                            provenance: {
                                environment: 'current',
                                source: 'local-shared-clone',
                                sourceLocation: '/tmp/AdguardFilters',
                                requestedRevision: 'master',
                                commit: 'a'.repeat(40),
                            },
                        }),
                },
            );

            const serialized = JSON.parse(readFileSync(paths.runResultPath, 'utf8'));
            expect(serialized.result).toMatchObject({
                runStatus: status,
                effectiveMode: 'reasoning',
                candidatePatch: null,
                environmentSelection: {
                    selectedKind: kind,
                    state,
                },
            });
            const report = readFileSync(paths.agentReportPath, 'utf8');
            expect(report).toContain(`- Status: \`${status}\``);
            expect(report).toContain(`- Selected kind: \`${kind}\``);
            expect(report).toContain(reportEvidence);
            const readBack = readLocalRunOutput(paths.runResultPath);
            expect(readBack.result.runStatus).toBe(status);
            expect(readBack.result.environmentSelection?.state).toBe(state);
            expect(readBack.result.candidatePatch).toBeNull();
        },
    );

    it('uses captured prompt data and owned attachment copies after source mutation', async () => {
        const caseDir = mkdtempSync(join(tmpdir(), 'verified-local-fix-case-'));
        const outputDir = mkdtempSync(join(tmpdir(), 'verified-local-fix-output-'));
        const issueFile = join(caseDir, 'issue.json');
        const attachmentPath = join(caseDir, 'report.png');
        const originalBytes = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64',
        );
        writeFileSync(attachmentPath, originalBytes);
        const snapshot = buildLocalIssueSnapshot(
            rawIssue,
            [
                {
                    kind: 'issue_screenshot',
                    sourceUrl: 'https://github.com/user-attachments/assets/report',
                    localPath: 'report.png',
                    sha256: createHash('sha256').update(originalBytes).digest('hex'),
                    promptVisible: true,
                    source: 'body',
                },
            ],
            { reporterAuthorOnly: 'reporter' },
        );
        const envelope = buildExportedIssueRevision({
            repository: 'example/lab',
            issueNumber: 4,
            sourceUpdatedAt: '2026-07-23T10:02:00.000Z',
            capturedAt: '2026-07-23T10:03:00.000Z',
            snapshot,
        });
        writeFileSync(issueFile, JSON.stringify(envelope));
        const revision = loadVerifiedExportedIssueRevision(issueFile);
        writeFileSync(issueFile, JSON.stringify({ tampered: true }));
        writeFileSync(attachmentPath, 'replacement bytes');
        let receivedIssue: FixCoreIssueInput | null = null;
        let receivedAttachmentBytes: Buffer | null = null;

        const paths = await runLocalFixFromRevision(
            coreConfig,
            revision,
            {
                issueNumber: 4,
                environment: 'current',
                outputDir,
                keepTemporaryFiles: false,
                browserMode: 'auto',
                verbose: false,
            },
            {
                ...extractionSeam,
                runFixCore: async (_config, issue) => {
                    receivedIssue = issue;
                    receivedAttachmentBytes = readFileSync(issue.attachments?.[0]?.localPath ?? '');
                    return coreResult();
                },
                withPreparedKnowledgeBase: prepareKnowledgeBase,
                withPreparedFiltersCheckout: async (_config, callback) =>
                    await callback({
                        filtersPath: '/tmp/filters',
                        checkoutPath: '/tmp/filters',
                        provenance: {
                            environment: 'current',
                            source: 'local-shared-clone',
                            sourceLocation: '/tmp/AdguardFilters',
                            requestedRevision: 'master',
                            commit: 'a'.repeat(40),
                        },
                    }),
            },
        );

        const capturedIssue = receivedIssue as FixCoreIssueInput | null;
        if (!capturedIssue) {
            throw new Error('Core did not receive the verified issue.');
        }
        expect(capturedIssue).toMatchObject({ title: rawIssue.title });
        const ownedPath = capturedIssue.attachments?.[0]?.localPath;
        expect(ownedPath).toContain(join(outputDir, 'collections'));
        expect(ownedPath).toContain(join('raw', 'artifacts', 'input'));
        expect(ownedPath).not.toBe(attachmentPath);
        expect(receivedAttachmentBytes).toEqual(originalBytes);
        expect(existsSync(ownedPath!)).toBe(false);
        expect(JSON.parse(readFileSync(paths.manifestPath, 'utf8')).candidate).toEqual({
            kind: 'not_applicable',
            disposition: 'not_verified',
        });
    });

    it('passes a magic-verified PNG through the production core without leaking its API key', async () => {
        const caseDir = mkdtempSync(join(tmpdir(), 'verified-png-production-core-'));
        const outputDir = mkdtempSync(join(tmpdir(), 'verified-png-production-output-'));
        const issueFile = join(caseDir, 'issue.json');
        const attachmentPath = join(caseDir, 'report.bin');
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64',
        );
        writeFileSync(attachmentPath, png);
        const snapshot = buildLocalIssueSnapshot(rawIssue, [
            {
                kind: 'issue_screenshot',
                sourceUrl: 'https://github.com/user-attachments/assets/real-png',
                localPath: 'report.bin',
                sha256: createHash('sha256').update(png).digest('hex'),
                promptVisible: true,
                source: 'body',
            },
        ]);
        const envelope = buildExportedIssueRevision({
            repository: 'example/lab',
            issueNumber: 4,
            sourceUpdatedAt: '2026-07-23T10:02:00.000Z',
            capturedAt: '2026-07-23T10:03:00.000Z',
            snapshot,
        });
        writeFileSync(issueFile, JSON.stringify(envelope));
        const revision = loadVerifiedExportedIssueRevision(issueFile);
        const { vision, requests: visionRequests } = sealedVisionClient();
        const unpackedExtension = writeUnpackedExtensionFixture(caseDir);
        const piRuntime = await scriptedPiRuntime([
            toolCall('fetch_issue', { issueNumber: 4 }),
            toolCall('select_environment', selectionArguments('adguard_cli')),
            toolCall('finish_fix', {
                outcome: 'analysis_only',
                reasoning: 'The selected AdGuard CLI adapter is not available yet.',
            }),
        ]);

        const paths = await runLocalFixFromRevision(
            coreConfig,
            revision,
            {
                issueNumber: 4,
                environment: 'current',
                outputDir,
                keepTemporaryFiles: false,
                browserMode: 'auto',
                verbose: false,
            },
            {
                ...extractionSeam,
                runFixCore: async (config, issue, options, dependencies) =>
                    await runFixCore(config, issue, options, {
                        ...dependencies,
                        vision,
                        piRuntime,
                        // The run's pre-run extension preparation is stubbed: this suite
                        // exercises the production core's plumbing, never the release network.
                        downloadPinnedExtensionRelease: async () => ({
                            extensionDir: unpackedExtension,
                            manifestVersion: ExtensionManifestVersion.Mv3,
                            sha256: PINNED_RELEASE_FIXTURE_SHA256,
                            tag: PINNED_RELEASE_FIXTURE_TAG,
                            fromCache: false,
                        }),
                        agentRuntime: {
                            createBaseRegistry: async () => new ToolRegistry(),
                        },
                    }),
                withPreparedKnowledgeBase: prepareKnowledgeBase,
                observeUpstreamDrift: observeNoUpstream,
                withPreparedFiltersCheckout: async (_config, callback) =>
                    await callback({
                        filtersPath: '/tmp/filters',
                        checkoutPath: '/tmp/filters',
                        provenance: {
                            environment: 'current',
                            source: 'local-shared-clone',
                            sourceLocation: '/tmp/AdguardFilters',
                            requestedRevision: 'master',
                            commit: 'a'.repeat(40),
                        },
                    }),
            },
        );

        // The pi loop consumed the scripted session; the vision client itself was never called.
        expect(visionRequests).toHaveLength(0);
        expect(hermetic!.requests.length).toBeGreaterThan(0);
        // The run-scoped collector is real-wired through the production core: the persisted
        // summary must be FILLED from the scripted pi session. An unfed collector — the exact
        // failure this slice exists to eliminate — turns this assertion red.
        const persistedUsageSummary = JSON.parse(readFileSync(paths.llmUsageSummaryPath!, 'utf8'));
        expect(persistedUsageSummary).toMatchObject({
            usageCompleteness: 'complete',
        });
        expect(persistedUsageSummary.requests).toBeGreaterThanOrEqual(1);
        expect(persistedUsageSummary.completions).toBeGreaterThanOrEqual(1);
        expect(persistedUsageSummary.bySource.loop.completions).toBeGreaterThanOrEqual(1);
        expect(readdirSync(join(outputDir, 'collections'))).toEqual([]);
        const manifest = JSON.parse(readFileSync(paths.manifestPath, 'utf8'));
        expect(manifest.images).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'omitted',
                    reason: 'untrusted_image_without_pixel_redaction_proof',
                }),
            ]),
        );
        expect(readFileSync(paths.agentReportPath, 'utf8')).not.toContain(
            'Unsupported issue screenshot extension',
        );
        for (const path of persistedFiles(outputDir)) {
            expect(readFileSync(path).includes(Buffer.from(coreConfig.llm.apiKey)), path).toBe(
                false,
            );
        }
    });

    it('redacts credentials from every persisted interrupted-run artifact', async () => {
        const caseDir = mkdtempSync(join(tmpdir(), 'verified-secret-failure-case-'));
        const outputDir = mkdtempSync(join(tmpdir(), 'verified-secret-failure-output-'));
        const issueFile = join(caseDir, 'issue.json');
        const snapshot = buildLocalIssueSnapshot(rawIssue, []);
        const envelope = buildExportedIssueRevision({
            repository: 'example/lab',
            issueNumber: 4,
            sourceUpdatedAt: '2026-07-23T10:02:00.000Z',
            capturedAt: '2026-07-23T10:03:00.000Z',
            snapshot,
        });
        writeFileSync(issueFile, JSON.stringify(envelope));

        const paths = await runLocalFixFromRevision(
            coreConfig,
            loadVerifiedExportedIssueRevision(issueFile),
            {
                issueNumber: 4,
                environment: 'current',
                outputDir,
                keepTemporaryFiles: false,
                browserMode: 'auto',
                verbose: false,
            },
            {
                ...extractionSeam,
                runFixCore: async () => {
                    throw new LocalExecutionInfrastructureError(
                        'interrupted',
                        `Lease lost after provider used ${coreConfig.llm.apiKey}`,
                    );
                },
                withPreparedKnowledgeBase: prepareKnowledgeBase,
                withPreparedFiltersCheckout: async (_config, callback) =>
                    await callback({
                        filtersPath: '/tmp/filters',
                        checkoutPath: '/tmp/filters',
                        provenance: {
                            environment: 'current',
                            source: 'local-shared-clone',
                            sourceLocation: '/tmp/AdguardFilters',
                            requestedRevision: 'master',
                            commit: 'a'.repeat(40),
                        },
                    }),
            },
        );

        expect(readFileSync(paths.runResultPath, 'utf8')).toContain('[redacted]');
        expect(readFileSync(paths.agentReportPath, 'utf8')).toContain('[redacted]');
        expect(JSON.parse(readFileSync(paths.manifestPath, 'utf8')).candidate).toEqual({
            kind: 'not_applicable',
            disposition: 'inconclusive',
        });
        for (const path of persistedFiles(outputDir)) {
            expect(readFileSync(path).includes(Buffer.from(coreConfig.llm.apiKey)), path).toBe(
                false,
            );
        }
    });

    it('rejects a nonowned nonempty output directory before clearing it', async () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'local-fix-unowned-output-'));
        const keepPath = join(outputDir, 'keep.txt');
        writeFileSync(keepPath, 'keep', 'utf8');

        await expect(
            runLocalFix(coreConfig, {
                issueNumber: 4,
                issueFile: join(outputDir, 'unused-issue.json'),
                environment: 'current',
                outputDir,
                keepTemporaryFiles: false,
                browserMode: 'auto',
                verbose: false,
            }),
        ).rejects.toThrow(/not owned|nonempty/i);
        expect(readFileSync(keepPath, 'utf8')).toBe('keep');
    });

    it('runs current locally without GitHub config and writes only the external output', async () => {
        const caseDir = mkdtempSync(join(tmpdir(), 'local-fix-case-'));
        const outputDir = mkdtempSync(join(tmpdir(), 'local-fix-output-'));
        const issueFile = join(caseDir, 'issue.json');
        const sourceScreenshotPath = join(caseDir, 'issue.png');
        const screenshotBytes = Buffer.from('local issue screenshot');
        const screenshotSha256 = createHash('sha256').update(screenshotBytes).digest('hex');
        const copiedScreenshotPath = join(
            outputDir,
            'artifacts',
            'unfiltered',
            'issue-screenshots',
            `${screenshotSha256}.png`,
        );
        const artifactRoot = join(outputDir, 'artifacts');
        const controlViewportPath = join(artifactRoot, 'control-viewport.png');
        const controlFullPagePath = join(artifactRoot, 'control-full-page.png');
        const controlTilePath = join(artifactRoot, 'control-tile.png');
        const preflightViewportPath = join(artifactRoot, 'preflight-viewport.png');
        const preflightFullPagePath = join(artifactRoot, 'preflight-full-page.png');
        const preflightTilePath = join(artifactRoot, 'preflight-tile.png');
        const validationDebugPath = join(artifactRoot, 'validation-debug.png');
        const guidanceTracePath = join(artifactRoot, 'guidance-trace.json');
        const settingsProofPath = join(artifactRoot, 'settings-proof.json');
        const tokenLikeSecret = 'sk-model-authored-token-1234567890';
        const unsafeControl = '\u0001';
        writeFileSync(sourceScreenshotPath, screenshotBytes);
        materializeLocalRunOutputDir(outputDir, process.cwd());
        mkdirSync(join(outputDir, 'artifacts'), { recursive: true });
        writeFileSync(join(outputDir, 'artifacts', 'stale.txt'), 'stale', 'utf8');
        const traceRecorder = createRuntimeTraceRecorder({
            runId: 'local-persistence-redaction',
            issueNumber: 4,
            mode: 'fix',
            now: () => '2026-07-23T10:00:00.000Z',
            exactSecrets: [coreConfig.llm.apiKey],
        });
        traceRecorder.record('tool_result', {
            tool: 'lookup_rule_guidance',
            result: {
                topic: 'element_hiding',
                diagnostic: `Trace ${coreConfig.llm.apiKey} ${tokenLikeSecret}` + unsafeControl,
                citations: [
                    {
                        repository: 'AdguardTeam/KnowledgeBase',
                        commit: 'c'.repeat(40),
                        filePath: 'docs/general/ad-filtering/create-own-filters.md',
                        anchor: 'cosmetic-elemhide-rules',
                        url:
                            'https://github.com/AdguardTeam/KnowledgeBase/blob/' +
                            `${'c'.repeat(40)}/docs/general/ad-filtering/` +
                            'create-own-filters.md#cosmetic-elemhide-rules',
                    },
                ],
            },
        });
        writeFileSync(
            guidanceTracePath,
            JSON.stringify(traceRecorder.end('not_reproduced')),
            'utf8',
        );
        writeFileSync(
            settingsProofPath,
            JSON.stringify({
                profileKind: 'agent_selected',
                manifestVersion: 3,
                filterEngine: 'declarative-net-request',
                optionsEnabledFilterIds: [2, 3, 17],
                activeRulesetFilterIds: [2, 3, 17],
                runtimeEnabledFilterIds: [2, 3, 17],
                enabledFilters: [
                    { filterId: 2, name: 'AdGuard Base filter', version: '2.0.54.62' },
                    { filterId: 3, name: 'AdGuard Tracking Protection filter' },
                    { filterId: 17, name: 'AdGuard Annoyances filter' },
                ],
            }),
            'utf8',
        );
        const guidanceTraceBytes = readFileSync(guidanceTracePath);
        const settingsProofBytes = readFileSync(settingsProofPath);
        writeFileSync(
            issueFile,
            JSON.stringify(
                buildLocalIssueSnapshot(rawIssue, [
                    {
                        kind: 'issue_screenshot',
                        sourceUrl: 'https://user-images.example.test/issue.png',
                        localPath: sourceScreenshotPath,
                        sha256: screenshotSha256,
                        promptVisible: true,
                        source: 'body',
                    },
                ]),
            ),
            'utf8',
        );
        const unsafeSelection = extensionEnvironmentSelection();
        const refinedIntent = {
            issueType: 'ads' as const,
            rationale: `Refined ${coreConfig.llm.apiKey} ${tokenLikeSecret}` + unsafeControl,
            confidence: 0.9,
            evidence: [
                {
                    source: 'tool' as const,
                    observation: `Observed ${tokenLikeSecret}` + unsafeControl,
                },
            ],
            conflicts: [`Conflicting declaration ${unsafeControl}`],
        };
        unsafeSelection.rationale = `Selected with ${coreConfig.llm.apiKey}` + unsafeControl;
        unsafeSelection.observed = refinedIntent;
        unsafeSelection.intentHistory = [unsafeSelection.intentHistory[0], refinedIntent];
        unsafeSelection.rejectedRequests = [
            {
                requestedKind: 'adguard_cli',
                rationale: `Rejected ${tokenLikeSecret}` + unsafeControl,
                confidence: 0.4,
                rejectedAt: '2026-07-23T10:01:00.000Z',
                errorKind: 'environment_locked',
            },
        ];
        const resolvedCoreResult = coreResult({
            environmentSelection: unsafeSelection,
            extensionProvenance: agentExtensionProvenance('v5.5.2.3', 'b'.repeat(40)),
            settingsEvidence: agentSettingsEvidence(['adguard:2', 'adguard:3', 'adguard:17']),
            browserSessions: [
                {
                    sessionId: 'control-session',
                    targetUrl: 'https://example.com/article',
                    extensionMode: 'none',
                    profile: browserSessionProfile,
                    navigationVerified: true,
                    fullVisionVerified: true,
                    captures: [
                        {
                            visionVerified: true,
                            viewportArtifactId: 'control-viewport',
                            viewport: controlViewportPath,
                            fullPageOverviewArtifactId: 'control-full-page',
                            fullPageOverview: controlFullPagePath,
                            tileArtifactIds: ['control-tile'],
                            tiles: [controlTilePath],
                            coverageComplete: true,
                        },
                    ],
                },
                {
                    sessionId: 'prepared-session',
                    targetUrl: 'https://example.com/article',
                    extensionMode: 'prepared',
                    profile: browserSessionProfile,
                    selectedSettingsProfileKind: 'agent_selected',
                    settingsEvidence: agentSettingsEvidence([
                        'adguard:2',
                        'adguard:3',
                        'adguard:17',
                    ]),
                    navigationVerified: true,
                    fullVisionVerified: true,
                    captures: [
                        {
                            visionVerified: true,
                            viewportArtifactId: 'prepared-viewport',
                            viewport: preflightViewportPath,
                            fullPageOverviewArtifactId: 'prepared-full-page',
                            fullPageOverview: preflightFullPagePath,
                            tileArtifactIds: ['prepared-tile'],
                            tiles: [preflightTilePath],
                            coverageComplete: true,
                        },
                    ],
                },
            ],
            artifactPaths: {
                ...coreResult().artifactPaths,
                trace: guidanceTracePath,
                settingsProof: settingsProofPath,
                screenshots: [
                    copiedScreenshotPath,
                    controlViewportPath,
                    controlFullPagePath,
                    controlTilePath,
                    preflightViewportPath,
                    preflightFullPagePath,
                    preflightTilePath,
                    validationDebugPath,
                ],
            },
        });
        const runCore = vi
            .fn()
            .mockImplementation(
                async (
                    _config: CoreConfig,
                    _issue: FixCoreIssueInput,
                    _options: FixCoreOptions,
                    deps: FixCoreDependencies = {},
                ) => {
                    mkdirSync(join(artifactRoot, 'unfiltered', 'issue-screenshots'), {
                        recursive: true,
                    });
                    writeFileSync(copiedScreenshotPath, screenshotBytes);
                    writeFileSync(guidanceTracePath, guidanceTraceBytes);
                    writeFileSync(settingsProofPath, settingsProofBytes);
                    for (const path of [
                        controlViewportPath,
                        controlFullPagePath,
                        controlTilePath,
                        preflightViewportPath,
                        preflightFullPagePath,
                        preflightTilePath,
                        validationDebugPath,
                    ]) {
                        writeFileSync(path, Buffer.from(`artifact:${path}`));
                    }
                    deps.onAgentRunArtifacts?.({
                        decision: {
                            outcome: 'resolve_without_patch',
                            runStatus: 'not_reproduced',
                            reasoning:
                                `The model did not reproduce ${coreConfig.llm.apiKey}.` +
                                unsafeControl,
                            evidenceSummary: 'The inspected screenshot coverage was complete.',
                        },
                        observations: [
                            {
                                sequence: 0,
                                toolCallId: 'issue-1',
                                tool: 'fetch_issue',
                                result: {
                                    issueNumber: 4,
                                    diagnostic:
                                        `Tool ${coreConfig.llm.apiKey} ${tokenLikeSecret}` +
                                        unsafeControl,
                                },
                            },
                        ],
                    });
                    return resolvedCoreResult;
                },
            );
        let preparedKnowledgeBaseConfig: KnowledgeBasePreparationConfig | null = null;

        const paths = await runLocalFix(
            coreConfig,
            {
                issueNumber: 4,
                issueFile,
                environment: 'current',
                outputDir,
                keepTemporaryFiles: false,
                browserMode: 'auto',
                verbose: false,
                knowledgeBaseSha: 'c'.repeat(40),
            },
            {
                ...extractionSeam,
                runFixCore: runCore,
                withPreparedKnowledgeBase: async (config, filters, callback) => {
                    preparedKnowledgeBaseConfig = config;
                    return await prepareKnowledgeBase(config, filters, callback);
                },
                withPreparedFiltersCheckout: async (_config, callback) =>
                    callback({
                        filtersPath: '/tmp/filters',
                        checkoutPath: '/tmp/filters',
                        provenance: {
                            environment: 'current',
                            source: 'local-shared-clone',
                            sourceLocation: '/tmp/AdguardFilters',
                            requestedRevision: 'master',
                            commit: 'a'.repeat(40),
                        },
                    }),
            },
        );

        expect(preparedKnowledgeBaseConfig).toEqual(
            expect.objectContaining({
                environment: { kind: 'pinned', commit: 'c'.repeat(40) },
            }),
        );
        expect(runCore).toHaveBeenCalledOnce();
        expect(runCore).toHaveBeenCalledWith(
            expect.objectContaining({
                headless: true,
                adguardExtensionManifestVersion: undefined,
                repositoryPath: '/tmp/filters',
            }),
            expect.objectContaining({
                number: 4,
                attachments: [expect.objectContaining({ localPath: sourceScreenshotPath })],
            }),
            expect.objectContaining({
                filtersRepository: 'AdguardTeam/AdguardFilters',
                filtersBaseSha: 'a'.repeat(40),
                knowledgeGuidanceSource: expect.objectContaining({
                    knowledgeBaseCommit: 'c'.repeat(40),
                    filtersCommit: 'a'.repeat(40),
                }),
                // Extension preparation is the shared core's own business: the lab cycle locks
                // only its executor set. No cache or selection policy crosses this boundary. The
                // AdGuard CLI proxy dependencies are an incidental wiring detail, not part
                // of this contract, so they stay unasserted here.
                agentRuntime: expect.objectContaining({
                    executors: ['browser_extension', 'adguard_cli'],
                }),
            }),
            expect.objectContaining({
                onAgentRunArtifacts: expect.any(Function),
            }),
        );
        expect(readFileSync(paths.agentReportPath, 'utf8')).toContain('## Host result');
        expect(JSON.parse(readFileSync(paths.agentDecisionPath!, 'utf8'))).toMatchObject({
            outcome: 'resolve_without_patch',
        });
        expect(JSON.parse(readFileSync(paths.agentObservationsPath!, 'utf8'))).toEqual([
            expect.objectContaining({
                tool: 'fetch_issue',
                result: expect.objectContaining({ issueNumber: 4 }),
            }),
        ]);
        for (const path of [
            paths.runResultPath,
            paths.agentReportPath,
            paths.agentObservationsPath,
            guidanceTracePath,
        ]) {
            const persisted = readFileSync(path, 'utf8');
            expect(persisted).not.toContain(coreConfig.llm.apiKey);
            expect(persisted).not.toContain(tokenLikeSecret);
            expect(hasUnsafeControl(persisted)).toBe(false);
            expect(persisted).toContain('[redacted]');
        }
        expect(readFileSync(paths.runResultPath!, 'utf8')).toBe(
            readFileSync(paths.runResultPath, 'utf8'),
        );
        // The record republishes the locked result's single-source provenance verbatim.
        expect(JSON.parse(readFileSync(paths.runResultPath, 'utf8')).provenance.extension).toEqual(
            JSON.parse(readFileSync(paths.runResultPath, 'utf8')).result.extensionProvenance,
        );
        expect(
            JSON.parse(readFileSync(paths.runResultPath, 'utf8')).provenance.knowledgeBase,
        ).toMatchObject({
            source: 'local',
            requestedRevision: 'master',
            commit: 'c'.repeat(40),
            filtersCommit: 'a'.repeat(40),
            citations: [
                expect.objectContaining({
                    topic: 'element_hiding',
                    anchor: 'cosmetic-elemhide-rules',
                    commit: 'c'.repeat(40),
                }),
            ],
        });
        expect(paths.candidatePatchPath).toBeNull();
        expect(
            JSON.parse(readFileSync(paths.runResultPath, 'utf8')).evidence.userScreenshots,
        ).toEqual([copiedScreenshotPath]);
        const evidence = JSON.parse(readFileSync(paths.runResultPath, 'utf8')).evidence;
        expect(evidence.unfilteredScreenshots).toEqual([controlViewportPath, controlFullPagePath]);
        expect(evidence.profileScreenshots[0].name).toBe('agent_selected');
        expect(evidence.profileScreenshots[0].screenshots).toEqual([
            preflightViewportPath,
            preflightFullPagePath,
        ]);
        expect(
            JSON.parse(readFileSync(paths.runResultPath, 'utf8')).provenance.settingsProfiles,
        ).toContainEqual(
            expect.objectContaining({
                name: 'agent_selected',
                status: 'applied',
                activationProof: 'dnr-rulesets',
            }),
        );
        expect(() => readFileSync(join(outputDir, 'artifacts', 'stale.txt'), 'utf8')).toThrow();
    });

    it('keeps its own pinned commit apart from an upstream that moved', async () => {
        const caseDir = mkdtempSync(join(tmpdir(), 'local-fix-publication-'));
        const outputDir = mkdtempSync(join(tmpdir(), 'local-fix-publication-output-'));
        const issueFile = join(caseDir, 'issue.json');
        const filtersBaseSha = 'a'.repeat(40);
        const upstreamCommit = 'e'.repeat(40);
        writeFileSync(issueFile, JSON.stringify(buildLocalIssueSnapshot(rawIssue, [])), 'utf8');
        const runCore = vi.fn().mockImplementation(async (_config, _issue, options) =>
            coreResult({
                repository: options.repository ?? null,
                baseSha: options.baseSha ?? null,
                filtersRepository: options.filtersRepository ?? null,
                filtersBaseSha: options.filtersBaseSha ?? null,
                extensionProvenance: agentExtensionProvenance('v5.5.2.3', 'b'.repeat(40)),
            }),
        );

        const paths = await runLocalFix(
            coreConfig,
            {
                issueNumber: 4,
                issueFile,
                environment: 'current',
                outputDir,
                keepTemporaryFiles: false,
                browserMode: 'auto',
                verbose: false,
            },
            {
                ...extractionSeam,
                runFixCore: runCore,
                withPreparedKnowledgeBase: prepareKnowledgeBase,
                withPreparedFiltersCheckout: async (_config, callback) =>
                    callback({
                        filtersPath: '/tmp/filters',
                        checkoutPath: '/tmp/filters',
                        provenance: {
                            environment: 'current',
                            source: 'local-shared-clone',
                            sourceLocation: '/tmp/AdguardFilters',
                            requestedRevision: 'master',
                            commit: filtersBaseSha,
                        },
                    }),
                observeUpstreamDrift: async (request) => ({
                    status: 'upstream_ahead',
                    pinnedCommit: request.pinnedCommit,
                    upstreamCommit: upstreamCommit,
                    observedAt: '2026-07-29T10:00:00.000Z',
                }),
            },
        );

        expect(runCore.mock.calls[0]?.[2]).toMatchObject({
            filtersRepository: 'AdguardTeam/AdguardFilters',
            filtersBaseSha,
        });
        // The commit the run is bound to is unchanged by an upstream that moved past it; the newer
        // state is recorded beside it as external drift rather than adopted.
        expect(JSON.parse(readFileSync(paths.runResultPath, 'utf8')).result).toMatchObject({
            repository: null,
            baseSha: null,
            filtersRepository: 'AdguardTeam/AdguardFilters',
            filtersBaseSha,
            sourceDrift: {
                status: 'upstream_ahead',
                pinnedCommit: filtersBaseSha,
                upstreamCommit,
            },
        });
    });

    it('brands provenance with the repository of the run-configured filters remote', async () => {
        const caseDir = mkdtempSync(join(tmpdir(), 'local-fix-fork-'));
        const outputDir = mkdtempSync(join(tmpdir(), 'local-fix-fork-output-'));
        const issueFile = join(caseDir, 'issue.json');
        const runConfigPath = join(caseDir, 'fork.json');
        const forkFiltersUrl = 'https://github.com/fork-owner/AdguardFilters.git';
        writeFileSync(issueFile, JSON.stringify(buildLocalIssueSnapshot(rawIssue, [])), 'utf8');
        writeFileSync(runConfigPath, JSON.stringify({ filtersRemoteUrl: forkFiltersUrl }), 'utf8');
        const runCore = vi.fn().mockImplementation(async (_config, _issue, options) =>
            coreResult({
                repository: options.repository ?? null,
                filtersRepository: options.filtersRepository ?? null,
                filtersBaseSha: options.filtersBaseSha ?? null,
            }),
        );
        let preparedKnowledgeBaseConfig: KnowledgeBasePreparationConfig | null = null;

        const paths = await runLocalFix(
            coreConfig,
            {
                issueNumber: 4,
                issueFile,
                environment: 'current',
                outputDir,
                runConfig: runConfigPath,
                keepTemporaryFiles: false,
                browserMode: 'auto',
                verbose: false,
            },
            {
                ...extractionSeam,
                runFixCore: runCore,
                withPreparedKnowledgeBase: async (config, filters, callback) => {
                    preparedKnowledgeBaseConfig = config;
                    return await prepareKnowledgeBase(config, filters, callback);
                },
                withPreparedFiltersCheckout: async (_config, callback) =>
                    await callback({
                        filtersPath: '/tmp/filters',
                        checkoutPath: '/tmp/filters',
                        provenance: {
                            environment: 'current',
                            source: 'local-shared-clone',
                            sourceLocation: forkFiltersUrl,
                            requestedRevision: 'master',
                            commit: 'a'.repeat(40),
                        },
                    }),
            },
        );

        expect(preparedKnowledgeBaseConfig).toEqual(
            expect.objectContaining({
                knowledgeBaseRepository: 'AdguardTeam/KnowledgeBase',
                filtersRepository: 'fork-owner/AdguardFilters',
                localSourcePath: undefined,
            }),
        );
        expect(runCore.mock.calls[0]?.[2]).toMatchObject({
            filtersRepository: 'fork-owner/AdguardFilters',
            knowledgeGuidanceSource: expect.objectContaining({
                knowledgeBaseRepository: 'AdguardTeam/KnowledgeBase',
                filtersRepository: 'fork-owner/AdguardFilters',
            }),
        });
        expect(JSON.parse(readFileSync(paths.runResultPath, 'utf8')).result).toMatchObject({
            filtersRepository: 'fork-owner/AdguardFilters',
        });
    });

    it('keeps human references outside an ordinary historical fix run', async () => {
        const caseDir = mkdtempSync(join(tmpdir(), 'local-fix-historical-'));
        const outputDir = mkdtempSync(join(tmpdir(), 'local-fix-historical-output-'));
        const filtersPath = join(caseDir, 'filters');
        const targetFile = 'BaseFilter/sections/foreign.txt';
        mkdirSync(join(filtersPath, 'BaseFilter/sections'), { recursive: true });
        writeFileSync(join(filtersPath, targetFile), '! Existing\n', 'utf8');
        const issueFile = join(caseDir, 'issue.json');
        const runConfig = join(caseDir, 'historical.json');
        writeFileSync(issueFile, JSON.stringify(buildLocalIssueSnapshot(rawIssue, [])), 'utf8');
        writeFileSync(
            runConfig,
            JSON.stringify({
                extension: {
                    localSourcePath: '/local/browser-extension',
                    remoteUrl: 'https://extensions.example.test/repository.git',
                    stableRef: 'stable/v5.4',
                },
                filtersBaseSha: '4e28093e719cbb2bab819b6d3a84c12f441343c6',
            }),
            'utf8',
        );
        const candidateRule = 'example.com##.agent-ad';
        const candidateRuleHash = createHash('sha256').update(candidateRule).digest('hex');
        const candidateShortHash = candidateRuleHash.slice(0, 12);
        const validationArtifactId = `validation-${candidateShortHash}`;
        const extensionProvenance = agentExtensionProvenance(
            'autobuild-v5.4.3.95',
            '04144e653cfc25411b8b07f800d3b933b313606c',
        );
        const settingsEvidence = {
            ...agentSettingsEvidence(['adguard:2', 'adguard:3', 'adguard:17']),
            profileKind: 'report_exact' as const,
        };
        const verifiedScreenshots = {
            before: '/tmp/before-viewport.png',
            after: '/tmp/after-viewport.png',
            beforeFullPage: '/tmp/before-full-page.png',
            afterFullPage: '/tmp/after-full-page.png',
        };
        const result = coreResult({
            runStatus: 'patch_proposed',
            repository: null,
            baseSha: null,
            filtersRepository: 'AdguardTeam/AdguardFilters',
            filtersBaseSha: '4e28093e719cbb2bab819b6d3a84c12f441343c6',
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
            candidateValidationEvidence: {
                validationArtifactId,
                sessionId: 'prepared-session',
                extensionProvenance,
                settingsEvidence,
                validationArtifact: {
                    artifactId: validationArtifactId,
                    path: `/tmp/factual-validation-${candidateShortHash}.json`,
                },
                visualReviewArtifact: {
                    artifactId: `visual-review-${candidateShortHash}`,
                    path: `/tmp/candidate-visual-review-${candidateShortHash}.json`,
                },
                beforeViewport: {
                    artifactId: 'before-viewport',
                    path: verifiedScreenshots.before,
                },
                afterViewport: {
                    artifactId: 'after-viewport',
                    path: verifiedScreenshots.after,
                },
                beforeFullPage: {
                    artifactId: 'before-full-page',
                    path: verifiedScreenshots.beforeFullPage,
                },
                afterFullPage: {
                    artifactId: 'after-full-page',
                    path: verifiedScreenshots.afterFullPage,
                },
            },
            candidatePatch: {
                rule: candidateRule,
                ruleType: 'cosmetic',
                filePath: targetFile,
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
                validationArtifactId,
                candidateRuleHash,
                beforeViewportArtifactId: 'before-viewport',
                afterViewportArtifactId: 'after-viewport',
                beforeFullPageArtifactId: 'before-full-page',
                afterFullPageArtifactId: 'after-full-page',
                model: 'gemini-3.5-flash',
                rationale: 'The issue is resolved and the page remains visually intact.',
                observedDamage: [],
            },
            artifactPaths: {
                ...coreResult().artifactPaths,
                screenshots: Object.values(verifiedScreenshots),
                candidateVisualReview: `/tmp/candidate-visual-review-${candidateShortHash}.json`,
                verifiedCandidateScreenshots: verifiedScreenshots,
            },
        });
        const runCore = vi
            .fn()
            .mockImplementation(
                async (_config, issue, coreOptions, _coreDependencies: FixCoreDependencies) => {
                    expect(issue.body).toContain('product_version=5.4.3.95');
                    expect(coreOptions).not.toHaveProperty('humanReference');
                    return result;
                },
            );

        const paths = await runLocalFix(
            coreConfig,
            {
                issueNumber: 4,
                issueFile,
                environment: 'historical',
                outputDir,
                runConfig,
                keepTemporaryFiles: false,
                browserMode: 'auto',
                verbose: false,
            },
            {
                ...extractionSeam,
                runFixCore: runCore,
                withPreparedKnowledgeBase: prepareKnowledgeBase,
                withPreparedFiltersCheckout: async (_config, callback) =>
                    callback({
                        filtersPath,
                        checkoutPath: filtersPath,
                        provenance: {
                            environment: 'historical',
                            source: 'local-shared-clone',
                            sourceLocation: '/tmp/AdguardFilters',
                            requestedRevision: result.filtersBaseSha!,
                            commit: result.filtersBaseSha!,
                        },
                    }),
            },
        );

        expect(runCore).toHaveBeenCalledOnce();
        expect(runCore).toHaveBeenCalledWith(
            expect.objectContaining({
                adguardExtensionManifestVersion: undefined,
                repositoryPath: filtersPath,
            }),
            expect.objectContaining({ number: 4 }),
            expect.objectContaining({
                filtersRepository: 'AdguardTeam/AdguardFilters',
                filtersBaseSha: '4e28093e719cbb2bab819b6d3a84c12f441343c6',
                // Extension preparation is the shared core's own business: the lab cycle locks
                // only its executor set, and the historical filters pinning stays run-config
                // territory. The AdGuard CLI proxy dependencies are an incidental wiring
                // detail, not part of this contract, so they stay unasserted here.
                agentRuntime: expect.objectContaining({
                    executors: ['browser_extension', 'adguard_cli'],
                }),
            }),
            expect.objectContaining({
                onAgentRunArtifacts: expect.any(Function),
                usageCollector: expect.objectContaining({
                    summary: expect.any(Function),
                }),
            }),
        );
        const report = readFileSync(paths.agentReportPath, 'utf8');
        expect(report).toContain('## Agent decision');
        expect(report).not.toContain('## Human comparison');
        expect(readFileSync(paths.candidatePatchPath!, 'utf8')).toContain(
            '+example.com##.agent-ad',
        );
        expect(existsSync(join(outputDir, 'reviewer-report.md'))).toBe(false);
        // The mocked runFixCore feeds nothing: the collector is threaded through the
        // FixCoreDependencies argument, and only a real core run feeds it. The empty
        // schema-valid summary (`requests: 0`) is exactly this path's contract.
        expect(JSON.parse(readFileSync(paths.llmUsageSummaryPath!, 'utf8'))).toMatchObject({
            requests: 0,
            usageCompleteness: 'unreported',
            costUsd: null,
        });
    });

    it('writes the historical agent-selected profile when the issue has no import URL', async () => {
        const caseDir = mkdtempSync(join(tmpdir(), 'local-fix-historical-defaults-'));
        const outputDir = mkdtempSync(join(tmpdir(), 'local-fix-historical-defaults-output-'));
        const issueFile = join(caseDir, 'issue.json');
        const runConfig = join(caseDir, 'historical.json');
        writeFileSync(
            issueFile,
            JSON.stringify(buildLocalIssueSnapshot(rawIssueWithoutImport, [])),
            'utf8',
        );
        writeFileSync(
            runConfig,
            JSON.stringify({
                extension: {
                    localSourcePath: '/historical/browser-extension',
                    remoteUrl: 'https://extensions.example.test/repository.git',
                    stableRef: 'stable/v5.4',
                },
                filtersBaseSha: 'd39891819f266ffb17d31a1329d0b323dac6ee53',
            }),
            'utf8',
        );
        const runCore = vi.fn().mockResolvedValue(
            coreResult({
                domain: 'wpoznaniu.pl',
                baseSha: 'd39891819f266ffb17d31a1329d0b323dac6ee53',
                extensionProvenance: agentExtensionProvenance(
                    'autobuild-v5.4.3.91',
                    'abc2ca544734957f5d58d8125f53eaef21d4d989',
                ),
                settingsEvidence: agentSettingsEvidence(['adguard:2', 'adguard:216']),
            }),
        );

        const paths = await runLocalFix(
            coreConfig,
            {
                issueNumber: 4,
                issueFile,
                environment: 'historical',
                outputDir,
                runConfig,
                keepTemporaryFiles: false,
                browserMode: 'auto',
                verbose: false,
            },
            {
                ...extractionSeam,
                runFixCore: runCore,
                withPreparedKnowledgeBase: prepareKnowledgeBase,
                withPreparedFiltersCheckout: async (_config, callback) =>
                    callback({
                        filtersPath: '/tmp/historical-filters-91',
                        checkoutPath: '/tmp/historical-filters-source-91',
                        provenance: {
                            environment: 'historical',
                            source: 'local-shared-clone',
                            sourceLocation: '/tmp/AdguardFilters',
                            requestedRevision: 'd39891819f266ffb17d31a1329d0b323dac6ee53',
                            commit: 'd39891819f266ffb17d31a1329d0b323dac6ee53',
                        },
                    }),
            },
        );

        expect(runCore).toHaveBeenCalledOnce();
        expect(runCore).toHaveBeenCalledWith(
            expect.objectContaining({
                adguardExtensionManifestVersion: undefined,
                repositoryPath: '/tmp/historical-filters-91',
            }),
            expect.objectContaining({
                body: expect.stringContaining('AdGuard Polish filter v2.0.10.1'),
            }),
            expect.objectContaining({
                // Extension preparation is the shared core's own business: the lab cycle locks
                // only its executor set, and the historical filters pinning stays run-config
                // territory. The AdGuard CLI proxy dependencies are an incidental wiring
                // detail, not part of this contract, so they stay unasserted here.
                agentRuntime: expect.objectContaining({
                    executors: ['browser_extension', 'adguard_cli'],
                }),
            }),
            expect.objectContaining({
                onAgentRunArtifacts: expect.any(Function),
            }),
        );
        const record = JSON.parse(readFileSync(paths.runResultPath, 'utf8'));
        expect(record.result.runStatus).not.toBe('failed');
        expect(record.provenance.settingsProfiles).toContainEqual(
            expect.objectContaining({ name: 'agent_selected' }),
        );
        expect(readFileSync(paths.agentReportPath, 'utf8')).toContain('agent_selected');
    });

    it('writes a failed lifecycle report when historical provenance is unavailable', async () => {
        const caseDir = mkdtempSync(join(tmpdir(), 'local-fix-historical-no-config-'));
        const outputDir = mkdtempSync(join(tmpdir(), 'local-fix-historical-no-config-output-'));
        const issueFile = join(caseDir, 'issue.json');
        writeFileSync(
            issueFile,
            JSON.stringify(buildLocalIssueSnapshot(rawIssueWithoutImport, [])),
            'utf8',
        );

        const paths = await runLocalFix(
            coreConfig,
            {
                issueNumber: 4,
                issueFile,
                environment: 'historical',
                outputDir,
                keepTemporaryFiles: false,
                browserMode: 'auto',
                verbose: false,
            },
            { ...extractionSeam },
        );

        expect(JSON.parse(readFileSync(paths.runResultPath, 'utf8')).result).toMatchObject({
            runStatus: 'failed',
            domain: 'wpoznaniu.pl',
            infrastructureFailureReason: 'input_unavailable',
            fallbackDetail: expect.stringMatching(/require --run-config/i),
        });
        expect(readFileSync(paths.agentReportPath, 'utf8')).toContain(
            'Local input validation failed',
        );
    });

    it('writes a failed local report when disposable source preparation fails', async () => {
        const caseDir = mkdtempSync(join(tmpdir(), 'local-fix-preparation-failure-'));
        const outputDir = mkdtempSync(join(tmpdir(), 'local-fix-preparation-output-'));
        const issueFile = join(caseDir, 'issue.json');
        writeFileSync(issueFile, JSON.stringify(buildLocalIssueSnapshot(rawIssue, [])), 'utf8');

        const paths = await runLocalFix(
            coreConfig,
            {
                issueNumber: 4,
                issueFile,
                environment: 'current',
                outputDir,
                keepTemporaryFiles: false,
                browserMode: 'auto',
                verbose: false,
            },
            {
                ...extractionSeam,
                withPreparedFiltersCheckout: async () => {
                    throw new Error('unable to resolve filters revision');
                },
            },
        );

        expect(JSON.parse(readFileSync(paths.runResultPath, 'utf8')).result).toMatchObject({
            runStatus: 'failed',
            candidatePatch: null,
            infrastructureFailureReason: 'environment_unavailable',
            fallbackDetail: 'unable to resolve filters revision',
        });
        expect(readFileSync(paths.agentReportPath, 'utf8')).toContain(
            'Local environment preparation failed',
        );
    });

    it('preserves a typed provider-boundary exception without message matching', async () => {
        const caseDir = mkdtempSync(join(tmpdir(), 'local-fix-provider-failure-'));
        const outputDir = mkdtempSync(join(tmpdir(), 'local-fix-provider-output-'));
        const issueFile = join(caseDir, 'issue.json');
        writeFileSync(issueFile, JSON.stringify(buildLocalIssueSnapshot(rawIssue, [])), 'utf8');

        const paths = await runLocalFix(
            coreConfig,
            {
                issueNumber: 4,
                issueFile,
                environment: 'current',
                outputDir,
                keepTemporaryFiles: false,
                browserMode: 'auto',
                verbose: false,
            },
            {
                ...extractionSeam,
                runFixCore: async () => {
                    throw new LocalExecutionInfrastructureError(
                        'provider',
                        'opaque transport failure',
                    );
                },
                withPreparedKnowledgeBase: prepareKnowledgeBase,
                withPreparedFiltersCheckout: async (_config, callback) =>
                    callback({
                        filtersPath: '/tmp/filters',
                        checkoutPath: '/tmp/filters',
                        provenance: {
                            environment: 'current',
                            source: 'local-shared-clone',
                            sourceLocation: '/tmp/AdguardFilters',
                            requestedRevision: 'master',
                            commit: 'a'.repeat(40),
                        },
                    }),
            },
        );

        expect(JSON.parse(readFileSync(paths.runResultPath, 'utf8')).result).toMatchObject({
            runStatus: 'failed',
            infrastructureFailureReason: 'llm_unavailable',
            fallbackDetail: 'opaque transport failure',
        });
    });

    it('delegates extension preparation to the core and threads its pinned-release provenance through', async () => {
        const caseDir = mkdtempSync(join(tmpdir(), 'local-fix-agent-extension-'));
        const outputDir = mkdtempSync(join(tmpdir(), 'local-fix-agent-extension-output-'));
        const issueFile = join(caseDir, 'issue.json');
        writeFileSync(issueFile, JSON.stringify(buildLocalIssueSnapshot(rawIssue, [])), 'utf8');
        const runCore = vi.fn().mockResolvedValue(
            coreResult({
                extensionProvenance: agentExtensionProvenance('v5.5.2.3', 'b'.repeat(40)),
                settingsEvidence: agentSettingsEvidence(['adguard:2', 'adguard:3', 'adguard:17']),
            }),
        );
        const paths = await runLocalFix(
            coreConfig,
            {
                issueNumber: 4,
                issueFile,
                environment: 'current',
                outputDir,
                keepTemporaryFiles: false,
                browserMode: 'auto',
                verbose: false,
            },
            {
                ...extractionSeam,
                runFixCore: runCore,
                withPreparedKnowledgeBase: prepareKnowledgeBase,
                withPreparedFiltersCheckout: async (_config, callback) =>
                    callback({
                        filtersPath: '/tmp/filters',
                        checkoutPath: '/tmp/filters-source',
                        provenance: {
                            environment: 'current',
                            source: 'local-shared-clone',
                            sourceLocation: '/tmp/filters-source',
                            requestedRevision: 'master',
                            commit: 'a'.repeat(40),
                        },
                    }),
            },
        );

        expect(runCore).toHaveBeenCalledOnce();
        expect(runCore.mock.calls[0]?.[0]).toMatchObject({
            adguardExtensionManifestVersion: undefined,
        });
        // Only the executor set crosses; the core prepares the pinned prebuilt release host-side.
        expect(runCore.mock.calls[0]?.[2]).toMatchObject({
            agentRuntime: {
                executors: ['browser_extension', 'adguard_cli'],
            },
        });
        // The core-owned pinned-release provenance boards the run record and the report verbatim.
        const record = JSON.parse(readFileSync(paths.runResultPath, 'utf8'));
        expect(record.result.extensionProvenance).toMatchObject({
            source: 'pinned_release',
            extensionSourceTag: 'v5.5.2.3',
            manifestVersion: 3,
        });
        expect(record.provenance.extension).toEqual(record.result.extensionProvenance);
        expect(JSON.parse(readFileSync(paths.runResultPath, 'utf8')).result.runStatus).toBe(
            'not_reproduced',
        );
    });

    it('distinguishes a core execution failure from environment preparation', async () => {
        const caseDir = mkdtempSync(join(tmpdir(), 'local-fix-core-failure-'));
        const outputDir = mkdtempSync(join(tmpdir(), 'local-fix-core-failure-output-'));
        const issueFile = join(caseDir, 'issue.json');
        writeFileSync(issueFile, JSON.stringify(buildLocalIssueSnapshot(rawIssue, [])), 'utf8');

        const paths = await runLocalFix(
            coreConfig,
            {
                issueNumber: 4,
                issueFile,
                environment: 'current',
                outputDir,
                keepTemporaryFiles: false,
                browserMode: 'auto',
                verbose: false,
            },
            {
                ...extractionSeam,
                runFixCore: async () => {
                    throw new Error('model response was malformed');
                },
                withPreparedKnowledgeBase: prepareKnowledgeBase,
                withPreparedFiltersCheckout: async (_config, callback) =>
                    callback({
                        filtersPath: '/tmp/filters',
                        checkoutPath: '/tmp/filters',
                        provenance: {
                            environment: 'current',
                            source: 'local-shared-clone',
                            sourceLocation: '/tmp/AdguardFilters',
                            requestedRevision: 'master',
                            commit: 'a'.repeat(40),
                        },
                    }),
            },
        );

        const record = JSON.parse(readFileSync(paths.runResultPath, 'utf8'));
        expect(record.result.infrastructureFailureReason).toBeUndefined();
        expect(readFileSync(paths.agentReportPath, 'utf8')).toContain(
            'Local core execution failed',
        );
        expect(readFileSync(paths.agentReportPath, 'utf8')).not.toContain(
            'Local environment preparation failed',
        );
    });

    it('preserves the model decision and delivered observations after an output failure', async () => {
        const caseDir = mkdtempSync(join(tmpdir(), 'local-fix-output-failure-'));
        const outputDir = mkdtempSync(join(tmpdir(), 'local-fix-output-failure-result-'));
        const issueFile = join(caseDir, 'issue.json');
        writeFileSync(issueFile, JSON.stringify(buildLocalIssueSnapshot(rawIssue, [])), 'utf8');

        const paths = await runLocalFix(
            coreConfig,
            {
                issueNumber: 4,
                issueFile,
                environment: 'current',
                outputDir,
                keepTemporaryFiles: false,
                browserMode: 'auto',
                verbose: false,
            },
            {
                ...extractionSeam,
                runFixCore: async (_config, _issue, _options, coreDependencies) => {
                    coreDependencies?.onAgentRunArtifacts?.({
                        decision: {
                            outcome: 'analysis_only',
                            reasoning: 'The model stopped after inspecting the target.',
                        },
                        observations: [
                            {
                                sequence: 0,
                                toolCallId: 'inspect-1',
                                tool: 'inspect_dom',
                                result: { selector: '.advert' },
                            },
                        ],
                    });
                    return {
                        ...coreResult(),
                        reasoning: undefined as unknown as string,
                    };
                },
                withPreparedKnowledgeBase: prepareKnowledgeBase,
                withPreparedFiltersCheckout: async (_config, callback) =>
                    callback({
                        filtersPath: '/tmp/filters',
                        checkoutPath: '/tmp/filters',
                        provenance: {
                            environment: 'current',
                            source: 'local-shared-clone',
                            sourceLocation: '/tmp/AdguardFilters',
                            requestedRevision: 'master',
                            commit: 'a'.repeat(40),
                        },
                    }),
            },
        );

        expect(JSON.parse(readFileSync(paths.runResultPath, 'utf8')).result).toMatchObject({
            runStatus: 'failed',
            infrastructureFailureReason: 'output_unavailable',
        });
        expect(JSON.parse(readFileSync(paths.agentDecisionPath!, 'utf8'))).toMatchObject({
            outcome: 'analysis_only',
        });
        expect(JSON.parse(readFileSync(paths.agentObservationsPath, 'utf8'))).toEqual([
            expect.objectContaining({ tool: 'inspect_dom' }),
        ]);
    });
});

describe('the instruction-driven local run', () => {
    const INSTRUCTION_MARKER = 'Ask for the syntax document whenever a rule form is unclear.';

    /**
     * One disposable case bundle: a filters checkout carrying the named instruction file, the
     * linked syntax document (except in failure scenarios), and the case file naming them.
     *
     * @param options - Bundle variant: whether the case file names the instruction and whether the
     *   linked syntax document exists.
     * @returns Case file, issue file, output, checkout, and trace fixture paths.
     */
    function instructionCase(options: {
        namesInstruction: boolean;
        linkedDocumentExists: boolean;
    }): {
        configPath: string;
        issueFile: string;
        outputDir: string;
        checkoutPath: string;
        guidanceTracePath: string;
    } {
        const tag = options.namesInstruction ? 'named' : 'unnamed';
        const presence = options.linkedDocumentExists ? 'present' : 'missing';
        const caseDir = mkdtempSync(join(tmpdir(), `local-fix-instruction-${tag}-${presence}-`));
        const outputDir = mkdtempSync(
            join(tmpdir(), `local-fix-instruction-out-${tag}-${presence}-`),
        );
        const checkoutPath = join(caseDir, 'checkout');
        const issueFile = join(caseDir, 'issue.json');
        mkdirSync(join(checkoutPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(checkoutPath, 'BaseFilter/sections/foreign.txt'), '', 'utf8');
        writeFileSync(
            join(checkoutPath, 'AGENT-INSTRUCTION.md'),
            [
                '# Agent instruction',
                '',
                INSTRUCTION_MARKER,
                '',
                `Follow [the uBO syntax guide](docs/syntax-guide.md) when you build candidate rules.`,
                '',
            ].join('\n'),
            'utf8',
        );
        if (options.linkedDocumentExists) {
            mkdirSync(join(checkoutPath, 'docs'), { recursive: true });
            writeFileSync(
                join(checkoutPath, 'docs/syntax-guide.md'),
                'uBO static filter syntax reference: element hiding basics.',
                'utf8',
            );
        }
        const guidanceTracePath = join(caseDir, 'guidance-trace.json');
        const recorder = createRuntimeTraceRecorder({
            runId: 'instruction-guidance-trace',
            issueNumber: 4,
            mode: 'fix',
        });
        recorder.record('tool_result', {
            tool: 'lookup_rule_guidance',
            result: {
                topic: 'element_hiding',
                citations: [
                    {
                        repository: 'wiki.example.test',
                        filePath: 'root/syntax-guide.md',
                        anchor: 'whole-document',
                        url: 'https://wiki.example.test/syntax-guide.md',
                    },
                ],
            },
        });
        writeFileSync(guidanceTracePath, JSON.stringify(recorder.end('not_reproduced')), 'utf8');
        writeFileSync(issueFile, JSON.stringify(buildLocalIssueSnapshot(rawIssue, [])), 'utf8');
        const configPath = join(caseDir, 'run.json');
        const caseConfig: Record<string, string> = {};
        if (options.namesInstruction) {
            caseConfig.instructionPath = 'AGENT-INSTRUCTION.md';
        }
        writeFileSync(configPath, JSON.stringify(caseConfig), 'utf8');
        return { configPath, issueFile, outputDir, checkoutPath, guidanceTracePath };
    }

    it('threads the loaded instruction into the core and skips the KnowledgeBase preparer', async () => {
        const bundle = instructionCase({ namesInstruction: true, linkedDocumentExists: true });
        let receivedOptions: FixCoreOptions | null = null;
        const runCore = vi.fn(
            async (_config: CoreConfig, _issue: FixCoreIssueInput, coreOptions: FixCoreOptions) => {
                receivedOptions = coreOptions;
                return coreResult({
                    artifactPaths: {
                        ...coreResult().artifactPaths,
                        trace: bundle.guidanceTracePath,
                    },
                });
            },
        );
        const prepareKnowledgeBaseSpy = vi.fn(prepareKnowledgeBase);

        const paths = await runLocalFix(
            coreConfig,
            {
                issueNumber: 4,
                issueFile: bundle.issueFile,
                environment: 'current',
                outputDir: bundle.outputDir,
                runConfig: bundle.configPath,
                keepTemporaryFiles: false,
                browserMode: 'auto',
                verbose: false,
            },
            {
                ...extractionSeam,
                runFixCore: runCore,
                withPreparedKnowledgeBase:
                    prepareKnowledgeBaseSpy as LocalFixRunnerDependencies['withPreparedKnowledgeBase'],
                withPreparedFiltersCheckout: preparedCheckoutStub(bundle.checkoutPath),
                observeUpstreamDrift: observeNoUpstream,
            },
        );

        const capturedOptions = receivedOptions as FixCoreOptions | null;
        if (!capturedOptions) {
            throw new Error('Core did not receive its options.');
        }
        expect(prepareKnowledgeBaseSpy).not.toHaveBeenCalled();
        expect(capturedOptions.instruction).toMatchObject({
            path: 'AGENT-INSTRUCTION.md',
            content: expect.stringContaining(INSTRUCTION_MARKER),
        });
        expect(capturedOptions.instruction?.documents).toEqual([
            expect.objectContaining({
                role: GuidanceDocumentRole.Syntax,
                origin: GuidanceDocumentOrigin.CheckoutFile,
                url: 'docs/syntax-guide.md',
            }),
        ]);
        expect(capturedOptions.knowledgeGuidanceSource).toBeUndefined();

        const record = readLocalRunOutput(paths.runResultPath);
        expect(record.provenance.instruction).toMatchObject({
            path: 'AGENT-INSTRUCTION.md',
            documents: [
                {
                    role: GuidanceDocumentRole.Syntax,
                    origin: GuidanceDocumentOrigin.CheckoutFile,
                    url: 'docs/syntax-guide.md',
                },
            ],
        });
        // The commit-absent instruction citation shape rides the run record beside the roster.
        expect(record.provenance.instruction?.citations).toEqual([
            {
                topic: 'element_hiding',
                repository: 'wiki.example.test',
                commit: undefined,
                filePath: 'root/syntax-guide.md',
                anchor: 'whole-document',
                url: 'https://wiki.example.test/syntax-guide.md',
            },
        ]);
        expect(record.provenance.knowledgeBase).toBeUndefined();
    });

    it('refuses an instruction with a file-backed verification method before the core runs', async () => {
        const bundle = instructionCase({ namesInstruction: true, linkedDocumentExists: false });
        writeFileSync(
            join(bundle.checkoutPath, 'AGENT-INSTRUCTION.md'),
            [
                '# Agent instruction',
                '',
                '## Rule application',
                '',
                'Write the candidate rule into the user rules file.',
                '',
                '## State verification',
                '',
                'read: user-rules-file filters-agent/ubol/custom-filters.txt',
                '',
            ].join('\n'),
            'utf8',
        );
        const runCore = vi.fn(async () => coreResult());

        const paths = await runLocalFix(
            coreConfig,
            {
                issueNumber: 4,
                issueFile: bundle.issueFile,
                environment: 'current',
                outputDir: bundle.outputDir,
                runConfig: bundle.configPath,
                keepTemporaryFiles: false,
                browserMode: 'auto',
                verbose: false,
            },
            {
                ...extractionSeam,
                runFixCore: runCore,
                withPreparedFiltersCheckout: preparedCheckoutStub(bundle.checkoutPath),
                observeUpstreamDrift: observeNoUpstream,
            },
        );

        expect(runCore).not.toHaveBeenCalled();
        expect(JSON.parse(readFileSync(paths.runResultPath, 'utf8')).result).toMatchObject({
            runStatus: 'failed',
            infrastructureFailureReason: 'file_backed_application_unsupported',
            fallbackDetail: expect.stringContaining('user-rules-file'),
        });
    });

    it('keeps the built-in KnowledgeBase path for a run whose case file names no instruction', async () => {
        const bundle = instructionCase({ namesInstruction: false, linkedDocumentExists: true });
        const runCore = vi.fn(async () => coreResult());
        const prepareKnowledgeBaseSpy = vi.fn(prepareKnowledgeBase);

        const paths = await runLocalFix(
            coreConfig,
            {
                issueNumber: 4,
                issueFile: bundle.issueFile,
                environment: 'current',
                outputDir: bundle.outputDir,
                runConfig: bundle.configPath,
                keepTemporaryFiles: false,
                browserMode: 'auto',
                verbose: false,
            },
            {
                ...extractionSeam,
                runFixCore: runCore,
                withPreparedKnowledgeBase:
                    prepareKnowledgeBaseSpy as LocalFixRunnerDependencies['withPreparedKnowledgeBase'],
                withPreparedFiltersCheckout: preparedCheckoutStub(bundle.checkoutPath),
                observeUpstreamDrift: observeNoUpstream,
            },
        );

        expect(prepareKnowledgeBaseSpy).toHaveBeenCalledTimes(1);
        const record = readLocalRunOutput(paths.runResultPath);
        expect(record.provenance.knowledgeBase).toMatchObject({
            commit: 'c'.repeat(40),
        });
        expect(record.provenance.instruction).toBeUndefined();
    });

    it('fails the run naming an explicitly supplied instruction path that is missing', async () => {
        const bundle = instructionCase({ namesInstruction: false, linkedDocumentExists: true });
        writeFileSync(
            bundle.configPath,
            JSON.stringify({ instructionPath: 'missing-instruction.md' }),
            'utf8',
        );
        const runCore = vi.fn(async () => coreResult());

        const paths = await runLocalFix(
            coreConfig,
            {
                issueNumber: 4,
                issueFile: bundle.issueFile,
                environment: 'current',
                outputDir: bundle.outputDir,
                runConfig: bundle.configPath,
                keepTemporaryFiles: false,
                browserMode: 'auto',
                verbose: false,
            },
            {
                ...extractionSeam,
                runFixCore: runCore,
                withPreparedKnowledgeBase: prepareKnowledgeBase,
                withPreparedFiltersCheckout: preparedCheckoutStub(bundle.checkoutPath),
                observeUpstreamDrift: observeNoUpstream,
            },
        );

        const record = readLocalRunOutput(paths.runResultPath);
        expect(record.result.runStatus).toBe('failed');
        expect(record.result.fallbackDetail).toContain('missing-instruction.md');
        expect(runCore).not.toHaveBeenCalled();
    });

    it('fails the run naming a linked document it cannot reach', async () => {
        const bundle = instructionCase({ namesInstruction: true, linkedDocumentExists: false });
        const runCore = vi.fn(async () => coreResult());

        const paths = await runLocalFix(
            coreConfig,
            {
                issueNumber: 4,
                issueFile: bundle.issueFile,
                environment: 'current',
                outputDir: bundle.outputDir,
                runConfig: bundle.configPath,
                keepTemporaryFiles: false,
                browserMode: 'auto',
                verbose: false,
            },
            {
                ...extractionSeam,
                runFixCore: runCore,
                withPreparedKnowledgeBase: prepareKnowledgeBase,
                withPreparedFiltersCheckout: preparedCheckoutStub(bundle.checkoutPath),
                observeUpstreamDrift: observeNoUpstream,
            },
        );

        const record = readLocalRunOutput(paths.runResultPath);
        expect(record.result.runStatus).toBe('failed');
        expect(record.result.fallbackDetail).toContain('docs/syntax-guide.md');
        expect(runCore).not.toHaveBeenCalled();
    });
});

describe('renderLocalCandidatePatch', () => {
    it('renders an exact replacement for a runner-derived domain extension', () => {
        const checkout = mkdtempSync(join(tmpdir(), 'local-domain-extension-'));
        const filePath = 'BaseFilter/sections/foreign.txt';
        mkdirSync(join(checkout, 'BaseFilter/sections'), { recursive: true });
        writeFileSync(
            join(checkout, filePath),
            ['before', 'one.pl,two.pl##.banner', 'after', ''].join('\n'),
        );

        const patch = renderLocalCandidatePatch(checkout, {
            rule: 'nettg.pl##.banner',
            ruleType: 'cosmetic',
            syntaxKind: 'element_hiding',
            filePath,
            repositoryEdit: {
                kind: 'extend_domains',
                line: 2,
                originalRule: 'one.pl,two.pl##.banner',
                replacementRule: 'nettg.pl,one.pl,two.pl##.banner',
            },
        });

        expect(patch).toContain('-one.pl,two.pl##.banner');
        expect(patch).toContain('+nettg.pl,one.pl,two.pl##.banner');
        expect(patch).not.toContain('+nettg.pl##.banner\n');
    });

    it('renders a new selector at its locked reported-domain block instead of EOF', () => {
        const checkout = mkdtempSync(join(tmpdir(), 'local-domain-insert-'));
        const filePath = 'BaseFilter/sections/foreign.txt';
        const anchorRule = 'wpoznaniu.pl##.g-dyn';
        mkdirSync(join(checkout, 'BaseFilter/sections'), { recursive: true });
        writeFileSync(
            join(checkout, filePath),
            ['! issue', anchorRule, 'wpoznaniu.pl##.g-single', '! Footer', ''].join('\n'),
        );

        const patch = renderLocalCandidatePatch(checkout, {
            rule: 'wpoznaniu.pl##div[class^="inner-ads-header"]',
            ruleType: 'cosmetic',
            syntaxKind: 'element_hiding',
            filePath,
            repositoryEdit: {
                kind: 'insert',
                insertionPoint: 1,
                anchorRule,
            },
        });

        expect(patch).toContain(
            '+wpoznaniu.pl##div[class^="inner-ads-header"]\n wpoznaniu.pl##.g-dyn',
        );
        expect(patch).toContain(' ! Footer');
    });
});
