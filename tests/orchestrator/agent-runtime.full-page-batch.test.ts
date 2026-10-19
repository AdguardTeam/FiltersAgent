import { PROVIDER_CALL_CONCURRENCY } from '../../src/pi/call-limiter';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../src/agent/tool-registry';
import type { AgentRuntimeDependencies } from '../../src/orchestrator/agent-runtime';
import type { BrowserSession } from '../../src/browser/browser-session';
import {
    fakePreparedExtensionSurface,
    readBackStateFixture,
} from '../environment/test-filtering-environment-fixtures';
import type { PreparedExtension } from '../../src/local/prepared-extension';
import {
    ExtensionManifestVersion,
    PreparedExtensionSource,
} from '../../src/environment/extension-preparation';
import { SingleShotResultKind, type SingleShotClient } from '../../src/pi/single-shot-types';
import type { SingleShotMessage } from '../../src/pi/single-shot-input';
import type { PiRuntime } from '../../src/pi/runtime';

/**
 * A SingleShotClient stub whose structured call is the supplied recorder; text is never used here.
 *
 * @param structured - The structured recorder serving the replies.
 * @returns The stub client.
 */
function clientWith(structured: unknown): SingleShotClient {
    return {
        modelId: 'vision-model',
        structured: structured as never,
        text: async () => {
            throw new Error('not used by this suite');
        },
    };
}
import type { FixOutcome } from '../../src/types/fix-outcome';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import type { ReporterSymptomPresence } from '../../src/types/reporter-symptom-presence';
import { PageObstruction } from '../../src/types/page-obstruction';
import { AgentRuntime } from '../../src/orchestrator/agent-runtime';
import { VISION_TOOL_DEADLINE_MS } from '../../src/agent/vision-tool-deadline';
import { testCoreConfig } from '../config/test-core-config';

/**
 * A PiRuntime stub. Every launch in this suite injects its own `createPhaseApplicationModelRunner`
 * (see `launchReadBackDependencies`), so the runtime carried on `AgentRuntimeOptions` is never
 * dereferenced; it exists only to satisfy the required option.
 */
const piRuntimeStub = {} as unknown as PiRuntime;

/**
 * Validated LLM configuration `AgentRuntimeOptions` now requires. This suite never sends a real
 * completion through it (see `piRuntimeStub`), so the shared test fixture values stand in.
 */
const llmConfigStub = testCoreConfig().llm;

const profile = {
    viewport: 'desktop' as const,
    locale: 'en-US',
    timezone: 'UTC',
    consentStrategy: 'untouched' as const,
};

/**
 * Runtime dependencies serving the prepared-launch read-back gate without a browser or model: the
 * host read-back returns the shipped state fixture and the application session is a no-op runner.
 *
 * @param enabledFilterIds - Filter IDs the read-back reports enabled.
 * @returns Dependencies to spread into AgentRuntime dependencies.
 */
function launchReadBackDependencies(
    enabledFilterIds: readonly number[],
): Pick<
    AgentRuntimeDependencies,
    'readAdGuardExtensionState' | 'findExtensionRuntime' | 'createPhaseApplicationModelRunner'
> {
    return {
        readAdGuardExtensionState: vi.fn(async () =>
            readBackStateFixture(enabledFilterIds, { appVersion: '5.5.2.3' }),
        ),
        findExtensionRuntime: vi.fn(async () => ({
            extensionId: 'test-extension-id',
            manifestVersion: ExtensionManifestVersion.Mv3,
        })),
        createPhaseApplicationModelRunner: vi.fn(() => ({
            run: async () => ({ completed: true, actionLog: [] }),
        })),
    };
}

/**
 * Fake prepared-extension session whose only launch-relevant members are the persistent context the
 * host reads the blocker state over and the app-message surface it opens on that context: both the
 * settings-payload pre-read and the host-performed application itself drive that surface.
 *
 * @returns The session to hand createBrowserSession for a prepared launch.
 */
function fakePreparedSession(): BrowserSession {
    return {
        close: vi.fn(),
        extensionContext: fakePreparedExtensionSurface().context,
    } as unknown as BrowserSession;
}

const reporterImportUrl =
    'https://reports.adguard.com/settings/import.html?scheme_version=4&' +
    'product_version=5.4.3.55&regular_filters=2%2C238&stealth.enabled=0';

function cachedExtension(): PreparedExtension {
    return {
        extensionPath: '/tmp/cache/extension',
        manifestVersion: ExtensionManifestVersion.Mv3,
        source: PreparedExtensionSource.PinnedRelease,
        extensionSourceSha256: 'e'.repeat(64),
        extensionSourceTag: 'v5.5.2.3',
    };
}

async function lockExtensionEnvironment(runtime: AgentRuntime): Promise<void> {
    // The default run resolves a one-element executor set, so the extension is already locked at
    // construction; a sole-executor run never advertises the choice tool to call.
    if (runtime.registry.getToolNames().includes('select_environment')) {
        await runtime.registry.dispatch('select_environment', {
            kind: 'browser_extension',
            requiredCapabilities: ['browser_navigation', 'filtering_control'],
            intent: {
                issueType: 'anti_adblock',
                rationale: 'The report describes a browser-rendered page defect.',
                confidence: 0.9,
                evidence: [
                    {
                        source: 'issue_body',
                        observation: 'The reporter describes the page symptom.',
                    },
                ],
                conflicts: [],
            },
            rationale: 'The reported symptom is reproducible in the browser extension environment.',
            confidence: 0.9,
        });
    }
}

async function runtimeWithSymptomMatrix(
    root: string,
    controlPresence: ReporterSymptomPresence,
    preparedPresence: ReporterSymptomPresence,
    pageObstruction: PageObstruction = PageObstruction.None,
): Promise<AgentRuntime> {
    const recorder = new TraceRecorder({ runId: 'matrix', issueNumber: 1, mode: 'fix' });
    const structured = vi.fn(async (options: { messages: SingleShotMessage[] }) => {
        const promptText = JSON.stringify(options.messages);
        const prepared = promptText.includes('artifact=prepared-');
        const presence = prepared ? preparedPresence : controlPresence;
        const artifactId = promptText.match(/artifact=([^;\\]+)/u)?.[1] ?? 'missing';
        return {
            kind: SingleShotResultKind.Parsed,
            value: {
                coverageObserved: true,
                reporterSymptomPresence: presence,
                symptomScope: 'The exact reporter-defined anti-adblock modal.',
                instances:
                    presence === 'present'
                        ? [
                              {
                                  artifactId,
                                  landmark: 'Centered over the page.',
                                  description: 'The reporter-defined modal is visible.',
                              },
                          ]
                        : [],
                rationale:
                    presence === 'present'
                        ? 'The exact modal is visible.'
                        : 'The exact modal is absent.',
                pageObstruction,
            },
            usages: [],
            attempts: 1,
            model: 'vision-model',
        };
    });
    const vision = clientWith(structured);
    let registryIndex = 0;
    const runtime = await AgentRuntime.create(
        {
            issue: {
                number: 1,
                url: 'https://github.com/example/repo/issues/1',
                title: 'Anti-adblock modal',
                body: [
                    'An anti-adblock modal blocks the comparison page.',
                    '',
                    '### System configuration',
                    'Filters: | AdGuard Base filter',
                ].join('\n'),
                state: 'open',
                labels: [],
                assignee: null,
                comments: [],
            },
            issueFacts: {
                issueNumber: 1,
                issueUrl: 'https://github.com/example/repo/issues/1',
                reportedSiteUrls: [],
                labels: [],
                problemType: 'unknown',
                product: 'Unknown',
                enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
                screenshots: [],
            },
            issueAttachmentArtifactIds: [],
            allowedTargetUrls: ['https://example.test/'],
            artifactsDir: root,
            filtersPath: root,
            headless: true,
            noSandbox: false,
            vision: vision,
            recorder,
            preparedExtension: cachedExtension(),
            llm: llmConfigStub,
            piRuntime: piRuntimeStub,
        },
        {
            ...launchReadBackDependencies([2]),
            createBaseRegistry: async () => new ToolRegistry(),
            createBrowserSession: async () => fakePreparedSession(),
            createBrowserRegistry: async () => {
                const prefix = registryIndex++ === 0 ? 'control' : 'prepared';
                const registry = new ToolRegistry();
                registry.register({
                    definition: {
                        type: 'function',
                        function: {
                            name: 'open_page',
                            description: 'Open the target page.',
                            parameters: { type: 'object', properties: {} },
                        },
                    },
                    handler: async (args) => ({ url: args.url, statusCode: 200 }),
                });
                registry.register({
                    definition: {
                        type: 'function',
                        function: {
                            name: 'screenshot',
                            description: 'Capture the complete page.',
                            parameters: { type: 'object', properties: {} },
                        },
                    },
                    handler: async () => {
                        for (const artifact of [
                            { id: `${prefix}-viewport`, type: 'screenshot' },
                            { id: `${prefix}-overview`, type: 'screenshot-full-page' },
                            { id: `${prefix}-tile`, type: 'screenshot-tile' },
                        ]) {
                            const path = join(root, `${artifact.id}.png`);
                            writeFileSync(path, Buffer.from(`png:${artifact.id}`));
                            recorder.addArtifact({ ...artifact, path, bytes: 10 });
                        }
                        return {
                            artifactId: `${prefix}-viewport`,
                            fullPageArtifactId: `${prefix}-overview`,
                            tileCoverage: {
                                complete: true,
                                documentWidth: 1_920,
                                documentHeight: 1_080,
                                viewportWidth: 1_920,
                                viewportHeight: 1_080,
                                overlapPx: 0,
                                tiles: [
                                    {
                                        artifactId: `${prefix}-tile`,
                                        index: 0,
                                        x: 0,
                                        y: 0,
                                        width: 1_920,
                                        height: 1_080,
                                        landmark: 'Complete page.',
                                    },
                                ],
                            },
                        };
                    },
                });
                return registry;
            },
        },
    );
    await runtime.registry.dispatch('fetch_issue', { issueNumber: 1 });
    await lockExtensionEnvironment(runtime);
    for (const extension of ['none', 'prepared'] as const) {
        await runtime.registry.dispatch('launch_browser', {
            extension,
            targetUrl: 'https://example.test/',
            profile,
            ...(extension === 'prepared'
                ? {
                      settings: {
                          kind: 'agent_selected',
                          filterIds: [2],
                          stealthEnabled: false,
                      },
                  }
                : {}),
        });
        await runtime.registry.dispatch('open_page', { url: 'https://example.test/' });
        await runtime.registry.dispatch('screenshot', { captureTiles: true });
        await runtime.registry.dispatch('inspect_full_page_capture', {});
        await runtime.registry.dispatch('close_browser', {});
    }
    return runtime;
}

async function runtimeWithCurrentConfigurationMatrix(
    root: string,
    reporterPresence: ReporterSymptomPresence,
    controlledPresence?: ReporterSymptomPresence,
    withReporterImport = true,
    controlledEnvironment?: {
        targetUrl?: string;
        profile?: typeof profile;
    },
): Promise<AgentRuntime> {
    const recorder = new TraceRecorder({
        runId: 'configuration-matrix',
        issueNumber: 1,
        mode: 'fix',
    });
    const structured = vi.fn(async (options: { messages: SingleShotMessage[] }) => {
        const promptText = JSON.stringify(options.messages);
        const controlled = promptText.includes('artifact=controlled-');
        const presence = controlled ? controlledPresence : reporterPresence;
        const artifactId = promptText.match(/artifact=([^;\\]+)/u)?.[1] ?? 'missing';
        return {
            kind: SingleShotResultKind.Parsed,
            value: {
                coverageObserved: true,
                reporterSymptomPresence: presence ?? 'indeterminate',
                symptomScope: 'The exact reporter-defined anti-adblock wall.',
                instances:
                    presence === 'present'
                        ? [
                              {
                                  artifactId,
                                  landmark: 'Centered over the article.',
                                  description: 'The exact anti-adblock wall is visible.',
                              },
                          ]
                        : [],
                rationale:
                    presence === 'present'
                        ? 'The exact wall is visible.'
                        : 'The exact wall is absent.',
            },
            usages: [],
            attempts: 1,
            model: 'vision-model',
        };
    });
    const vision = clientWith(structured);
    let nextPrefix = 'reporter';
    let launchCounter = 0;
    const runtime = await AgentRuntime.create(
        {
            issue: {
                number: 1,
                url: 'https://github.com/example/repo/issues/1',
                title: 'Anti-adblock wall',
                body: [
                    withReporterImport
                        ? `The anti-adblock wall appears with these settings: ${reporterImportUrl}`
                        : 'The anti-adblock wall appears with filters 2 and 238 enabled.',
                    '',
                    '### System configuration',
                    'Filters: | AdGuard Base filter',
                ].join('\n'),
                state: 'open',
                labels: ['T: Anti Adblock Script'],
                assignee: null,
                comments: [],
            },
            issueFacts: {
                issueNumber: 1,
                issueUrl: 'https://github.com/example/repo/issues/1',
                reportedSiteUrls: [],
                labels: ['T: Anti Adblock Script'],
                problemType: 'unknown',
                product: 'Unknown',
                enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
                screenshots: [],
            },
            issueAttachmentArtifactIds: [],
            allowedTargetUrls: [
                'https://example.test/',
                ...(controlledEnvironment?.targetUrl ? [controlledEnvironment.targetUrl] : []),
            ],
            artifactsDir: root,
            filtersPath: root,
            headless: true,
            noSandbox: false,
            vision: vision,
            recorder,
            preparedExtension: cachedExtension(),
            llm: llmConfigStub,
            piRuntime: piRuntimeStub,
        },
        {
            // Session order matches the launched settings order: the reporter-profile session
            // first, then the controlled defaults session when this matrix runs one.
            ...launchReadBackDependencies([2, 238]),
            createBaseRegistry: async () => new ToolRegistry(),
            createBrowserSession: async () => {
                launchCounter += 1;
                nextPrefix = launchCounter === 1 ? 'reporter' : 'controlled';
                return fakePreparedSession();
            },
            createBrowserRegistry: async () => {
                const prefix = nextPrefix;
                const registry = new ToolRegistry();
                registry.register({
                    definition: {
                        type: 'function',
                        function: {
                            name: 'open_page',
                            description: 'Open the target page.',
                            parameters: { type: 'object', properties: {} },
                        },
                    },
                    handler: async (args) => ({ url: args.url, statusCode: 200 }),
                });
                registry.register({
                    definition: {
                        type: 'function',
                        function: {
                            name: 'screenshot',
                            description: 'Capture the complete page.',
                            parameters: { type: 'object', properties: {} },
                        },
                    },
                    handler: async () => {
                        for (const artifact of [
                            { id: `${prefix}-viewport`, type: 'screenshot' },
                            { id: `${prefix}-overview`, type: 'screenshot-full-page' },
                            { id: `${prefix}-tile`, type: 'screenshot-tile' },
                        ]) {
                            const path = join(root, `${artifact.id}.png`);
                            writeFileSync(path, Buffer.from(`png:${artifact.id}`));
                            recorder.addArtifact({ ...artifact, path, bytes: 10 });
                        }
                        return {
                            artifactId: `${prefix}-viewport`,
                            fullPageArtifactId: `${prefix}-overview`,
                            tileCoverage: {
                                complete: true,
                                documentWidth: 1_920,
                                documentHeight: 1_080,
                                viewportWidth: 1_920,
                                viewportHeight: 1_080,
                                overlapPx: 0,
                                tiles: [
                                    {
                                        artifactId: `${prefix}-tile`,
                                        index: 0,
                                        x: 0,
                                        y: 0,
                                        width: 1_920,
                                        height: 1_080,
                                        landmark: 'Complete page.',
                                    },
                                ],
                            },
                        };
                    },
                });
                return registry;
            },
        },
    );
    await runtime.registry.dispatch('fetch_issue', { issueNumber: 1 });
    await lockExtensionEnvironment(runtime);
    const settingsProfiles = [
        withReporterImport
            ? { kind: 'reported_on_current' as const, importUrl: reporterImportUrl }
            : {
                  kind: 'agent_selected' as const,
                  filterIds: [2, 238],
                  stealthEnabled: false,
              },
        ...(controlledPresence === undefined
            ? []
            : [
                  {
                      kind: 'defaults_plus_required' as const,
                      requiredFilterIds: [],
                      reporterImportUrl,
                      siteHostname: 'example.test',
                      reportedFilterNames: ['Polish Anti Adblock Filters'],
                      issueLabels: ['T: Anti Adblock Script'],
                  },
              ]),
    ];
    for (const settings of settingsProfiles) {
        const controlled = settings.kind === 'defaults_plus_required';
        const targetUrl = controlled
            ? (controlledEnvironment?.targetUrl ?? 'https://example.test/')
            : 'https://example.test/';
        await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl,
            profile: controlled ? (controlledEnvironment?.profile ?? profile) : profile,
            settings,
        });
        await runtime.registry.dispatch('open_page', { url: targetUrl });
        await runtime.registry.dispatch('screenshot', { captureTiles: true });
        await runtime.registry.dispatch('inspect_full_page_capture', {});
        await runtime.registry.dispatch('close_browser', {});
    }
    return runtime;
}

describe('AgentRuntime full-page batch vision', () => {
    it('binds no-patch statuses to the exact control/prepared symptom matrix', async () => {
        const root = mkdtempSync(join(tmpdir(), 'agent-runtime-status-matrix-'));
        const alreadyFixed: FixOutcome = {
            outcome: 'resolve_without_patch',
            runStatus: 'already_fixed_current',
            reasoning: 'Current filtering removes the exact symptom.',
            evidenceSummary: 'Complete control and prepared visual evidence.',
        };
        const notReproduced: FixOutcome = {
            outcome: 'resolve_without_patch',
            runStatus: 'not_reproduced',
            reasoning: 'The exact symptom is absent in both environments.',
            evidenceSummary: 'Complete control and prepared visual evidence.',
        };
        try {
            const absentBoth = await runtimeWithSymptomMatrix(root, 'absent', 'absent');
            expect(absentBoth.validateTerminalOutcome(alreadyFixed)).toMatchObject({
                errorKind: 'report_only_status_evidence_mismatch',
                requiredAction: 'finish_fix_not_reproduced',
                reporterSymptomEvidence: {
                    unfilteredControl: 'absent',
                    preparedExtension: 'absent',
                },
            });
            expect(absentBoth.validateTerminalOutcome(notReproduced)).toBeUndefined();
            expect(absentBoth.getTerminalSymptomObservation()).toBe('not_reproduced');

            const fixed = await runtimeWithSymptomMatrix(root, 'present', 'absent');
            expect(fixed.validateTerminalOutcome(alreadyFixed)).toBeUndefined();
            expect(fixed.validateTerminalOutcome(notReproduced)).toMatchObject({
                errorKind: 'report_only_status_evidence_mismatch',
                reporterSymptomEvidence: {
                    unfilteredControl: 'present',
                    preparedExtension: 'absent',
                },
            });
            expect(fixed.getTerminalSymptomObservation()).toBe('reproduced');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('refuses a no-patch status when vision sees a regional block in place of the page', async () => {
        // pluto.tv (#241958): both sessions loaded a same-origin "not available in your location"
        // page, the reported player was nowhere, and not_reproduced passed as verified because
        // page-text patterns missed the wording.
        const root = mkdtempSync(join(tmpdir(), 'agent-runtime-region-block-'));
        const notReproduced: FixOutcome = {
            outcome: 'resolve_without_patch',
            runStatus: 'not_reproduced',
            reasoning: 'The reported volume defect is absent in both environments.',
            evidenceSummary: 'Complete control and prepared visual evidence.',
        };
        const analysisOnly: FixOutcome = {
            outcome: 'analysis_only',
            reasoning: 'The reported page is not available in this region.',
        };
        try {
            const walled = await runtimeWithSymptomMatrix(
                root,
                'absent',
                'absent',
                PageObstruction.RegionBlock,
            );
            expect(walled.validateTerminalOutcome(notReproduced)).toMatchObject({
                errorKind: 'no_patch_target_not_observable',
                requiredAction: 'finish_fix_analysis_only',
                targetAccess: {
                    unfilteredControl: 'region_restricted',
                    preparedExtension: 'region_restricted',
                },
            });
            expect(walled.validateTerminalOutcome(analysisOnly)).toBeUndefined();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('requires reporter-present and controlled-absent current evidence for configuration-specific', async () => {
        const root = mkdtempSync(join(tmpdir(), 'agent-runtime-configuration-matrix-'));
        const outcome: FixOutcome = {
            outcome: 'resolve_without_patch',
            runStatus: 'configuration_specific',
            reasoning: 'The exact symptom appears only under the reporter configuration.',
            evidenceSummary: 'Complete reporter and controlled current-extension evidence.',
        };
        try {
            const proven = await runtimeWithCurrentConfigurationMatrix(root, 'present', 'absent');
            expect(proven.validateTerminalOutcome(outcome)).toBeUndefined();

            const agentSelectedReporter = await runtimeWithCurrentConfigurationMatrix(
                root,
                'present',
                'absent',
                false,
            );
            expect(agentSelectedReporter.validateTerminalOutcome(outcome)).toBeUndefined();

            const mismatchedUrl = await runtimeWithCurrentConfigurationMatrix(
                root,
                'present',
                'absent',
                true,
                { targetUrl: 'https://example.test/another-article' },
            );
            expect(mismatchedUrl.validateTerminalOutcome(outcome)).toMatchObject({
                errorKind: 'configuration_specific_environment_mismatch',
                retryable: true,
                requiredAction: 'rerun_controlled_with_reporter_environment',
            });

            const mismatchedProfile = await runtimeWithCurrentConfigurationMatrix(
                root,
                'present',
                'absent',
                true,
                {
                    profile: {
                        ...profile,
                        locale: 'pl-PL',
                    },
                },
            );
            expect(mismatchedProfile.validateTerminalOutcome(outcome)).toMatchObject({
                errorKind: 'configuration_specific_environment_mismatch',
                retryable: true,
                requiredAction: 'rerun_controlled_with_reporter_environment',
            });

            const missingControlledWithoutImport = await runtimeWithCurrentConfigurationMatrix(
                root,
                'present',
                undefined,
                false,
            );
            const noImportRejection =
                missingControlledWithoutImport.validateTerminalOutcome(outcome);
            expect(noImportRejection).toMatchObject({
                errorKind: 'configuration_specific_evidence_required',
                reporterProfile: expect.objectContaining({
                    expectedSettingsProfileKind: 'agent_selected',
                }),
            });
            expect(JSON.stringify(noImportRejection)).not.toContain('exact trusted import URL');

            const missingControlled = await runtimeWithCurrentConfigurationMatrix(root, 'present');
            expect(missingControlled.validateTerminalOutcome(outcome)).toMatchObject({
                errorKind: 'configuration_specific_evidence_required',
                retryable: true,
                requiredAction: 'launch_controlled_current_profile',
                reporterProfile: expect.objectContaining({
                    status: 'complete',
                    reporterSymptomPresence: 'present',
                }),
                controlledProfile: expect.objectContaining({ status: 'missing' }),
            });

            const absentBoth = await runtimeWithCurrentConfigurationMatrix(
                root,
                'absent',
                'absent',
            );
            expect(absentBoth.validateTerminalOutcome(outcome)).toMatchObject({
                errorKind: 'configuration_specific_evidence_mismatch',
                retryable: true,
                requiredAction: 'choose_status_consistent_with_configuration_evidence',
                reporterProfile: expect.objectContaining({ reporterSymptomPresence: 'absent' }),
                controlledProfile: expect.objectContaining({ reporterSymptomPresence: 'absent' }),
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('credits successful batches atomically and leaves only an unreadable batch retryable', async () => {
        const root = mkdtempSync(join(tmpdir(), 'agent-runtime-full-page-batch-'));
        const recorder = new TraceRecorder({
            runId: 'full-page-batch',
            issueNumber: 1,
            mode: 'fix',
        });
        const baseRegistry = new ToolRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'analyze_screenshot',
                    description: 'Inspect one exact screenshot.',
                    parameters: {
                        type: 'object',
                        properties: {
                            artifactId: { type: 'string' },
                            prompt: { type: 'string' },
                        },
                        required: ['artifactId', 'prompt'],
                    },
                },
            },
            handler: async (args) => ({
                artifactId: args.artifactId,
                analysis: `Inspected ${String(args.artifactId)}.`,
            }),
        });
        const browserRegistry = new ToolRegistry();
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'open_page',
                    description: 'Open the target page.',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async (args) => ({ url: args.url, statusCode: 200 }),
        });
        const artifactDefinitions = [
            { id: 'viewport', type: 'screenshot' },
            { id: 'overview', type: 'screenshot-full-page' },
            ...Array.from({ length: 4 }, (_, index) => ({
                id: `tile-${index + 1}`,
                type: 'screenshot-tile',
            })),
        ];
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'screenshot',
                    description: 'Capture the complete page.',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => {
                for (const artifact of artifactDefinitions) {
                    const path = join(root, `${artifact.id}.png`);
                    writeFileSync(path, Buffer.from(`png:${artifact.id}`));
                    recorder.addArtifact({ ...artifact, path, bytes: 10 });
                }
                return {
                    artifactId: 'viewport',
                    fullPageArtifactId: 'overview',
                    tileCoverage: {
                        complete: true,
                        documentWidth: 1_920,
                        documentHeight: 4_000,
                        viewportWidth: 1_920,
                        viewportHeight: 1_080,
                        overlapPx: 160,
                        tiles: Array.from({ length: 4 }, (_, index) => ({
                            artifactId: `tile-${index + 1}`,
                            index,
                            x: 0,
                            y: index * 920,
                            width: 1_920,
                            height: 1_080,
                            landmark: `Section ${index + 1}`,
                        })),
                    },
                };
            },
        });
        const chat = vi.fn(async (options: { messages: SingleShotMessage[] }) => {
            const prompt = JSON.stringify(options.messages);
            return {
                kind: SingleShotResultKind.Parsed,
                value: {
                    coverageObserved: !prompt.includes('artifact=tile-1;'),
                    reporterSymptomPresence: prompt.includes('artifact=tile-1;')
                        ? 'indeterminate'
                        : 'absent',
                    symptomScope: 'The reporter-defined advertising leftover.',
                    instances: [],
                    rationale: prompt.includes('artifact=tile-1;')
                        ? 'This tile batch was unreadable.'
                        : 'Every supplied image was inspected.',
                },
                usages: [],
                attempts: 1,
                model: 'vision-model',
            };
        });
        const vision = clientWith(chat);

        try {
            const runtime = await AgentRuntime.create(
                {
                    issue: {
                        number: 1,
                        url: 'https://github.com/example/repo/issues/1',
                        title: 'Advertising leftover',
                        body: [
                            'A large advertising leftover is visible.',
                            '',
                            '### System configuration',
                            'Filters: | AdGuard Base filter',
                        ].join('\n'),
                        state: 'open',
                        labels: [],
                        assignee: null,
                        comments: [],
                    },
                    issueFacts: {
                        issueNumber: 1,
                        issueUrl: 'https://github.com/example/repo/issues/1',
                        reportedSiteUrls: [],
                        labels: [],
                        problemType: 'unknown',
                        product: 'Unknown',
                        enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
                        screenshots: [],
                    },
                    issueAttachmentArtifactIds: [],
                    allowedTargetUrls: ['https://example.test/'],
                    artifactsDir: root,
                    filtersPath: root,
                    headless: true,
                    noSandbox: false,
                    vision: vision,
                    recorder,
                    preparedExtension: cachedExtension(),
                    llm: llmConfigStub,
                    piRuntime: piRuntimeStub,
                },
                {
                    ...launchReadBackDependencies([2]),
                    createBaseRegistry: async () => baseRegistry,
                    createBrowserSession: async () => fakePreparedSession(),
                    createBrowserRegistry: async () => browserRegistry,
                },
            );
            await runtime.registry.dispatch('fetch_issue', { issueNumber: 1 });
            await lockExtensionEnvironment(runtime);
            await runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://example.test/',
                profile: {
                    viewport: 'desktop',
                    locale: 'en-US',
                    timezone: 'UTC',
                    consentStrategy: 'untouched',
                },
                settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
            });
            await runtime.registry.dispatch('open_page', { url: 'https://example.test/' });
            await runtime.registry.dispatch('screenshot', { captureTiles: true });

            const batchResult = await runtime.registry.dispatch('inspect_full_page_capture', {});

            expect(chat).toHaveBeenCalledTimes(3);
            expect(batchResult).toMatchObject({
                errorKind: 'full_page_vision_incomplete',
                retryable: true,
                captureArtifactId: 'viewport',
                coverageComplete: false,
                inspectedArtifactIds: ['overview', 'tile-4'],
                missingArtifactIds: ['tile-1', 'tile-2', 'tile-3'],
            });
            expect(runtime.getLatestCompleteVisionEnvironment()).toBeUndefined();

            for (const artifactId of ['tile-1', 'tile-2', 'tile-3']) {
                await runtime.registry.dispatch('analyze_screenshot', {
                    artifactId,
                    prompt: 'Retry this exact unreadable tile.',
                });
            }

            expect(runtime.getLatestCompleteVisionEnvironment()).toMatchObject({
                fullVisionVerified: true,
                pageCaptures: [{ visionVerified: true }],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it.each([
        {
            overviewCaptured: true,
            behavior:
                'never sends a full page too tall to read, and never waits for its inspection',
        },
        {
            overviewCaptured: false,
            behavior: 'inspects a tall page from its tiles when the browser captured no overview',
        },
    ])('$behavior', async ({ overviewCaptured }) => {
        // A 375x10334 px overview reaches the model about 74 px wide, where it answers from the
        // prompt rather than from the pixels (seen on a live run). It is excluded from vision,
        // and the run must not then demand the inspection of an artifact the inventory never sent:
        // the terminal vision requirement and the inventory read the same eligibility rule.
        // Chromium cannot capture such a page at all past about 17,500 px; the tiles carry the
        // same proof then.
        const root = mkdtempSync(join(tmpdir(), 'agent-runtime-tall-overview-'));
        const recorder = new TraceRecorder({
            runId: 'tall-overview',
            issueNumber: 1,
            mode: 'fix',
        });
        const browserRegistry = new ToolRegistry();
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'open_page',
                    description: 'Open the target page.',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async (args) => ({ url: args.url, statusCode: 200 }),
        });
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'screenshot',
                    description: 'Capture the complete page.',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => {
                for (const artifact of [
                    { id: 'viewport', type: 'screenshot' },
                    ...(overviewCaptured ? [{ id: 'overview', type: 'screenshot-full-page' }] : []),
                    ...Array.from({ length: 5 }, (_, index) => ({
                        id: `tile-${index + 1}`,
                        type: 'screenshot-tile',
                    })),
                ]) {
                    const path = join(root, `${artifact.id}.png`);
                    writeFileSync(path, Buffer.from(`png:${artifact.id}`));
                    recorder.addArtifact({ ...artifact, path, bytes: 10 });
                }
                return {
                    artifactId: 'viewport',
                    ...(overviewCaptured ? { fullPageArtifactId: 'overview' } : {}),
                    tileCoverage: {
                        complete: true,
                        documentWidth: 375,
                        documentHeight: 10_334,
                        viewportWidth: 375,
                        viewportHeight: 812,
                        overlapPx: 0,
                        tiles: Array.from({ length: 5 }, (_, index) => ({
                            artifactId: `tile-${index + 1}`,
                            index,
                            x: 0,
                            y: index * 812,
                            width: 375,
                            height: 812,
                            landmark: `Screen ${index + 1}`,
                        })),
                    },
                };
            },
        });
        const chat = vi.fn(async () => ({
            kind: SingleShotResultKind.Parsed,
            value: {
                coverageObserved: true,
                reporterSymptomPresence: 'absent',
                symptomScope: 'The reporter-defined advertising leftover.',
                instances: [],
                rationale: 'Every supplied image was inspected.',
            },
            usages: [],
            attempts: 1,
            model: 'vision-model',
        }));
        const vision = clientWith(chat);

        try {
            const runtime = await AgentRuntime.create(
                {
                    issue: {
                        number: 1,
                        url: 'https://github.com/example/repo/issues/1',
                        title: 'Advertising leftover',
                        body: [
                            'A large advertising leftover is visible.',
                            '',
                            '### System configuration',
                            'Filters: | AdGuard Base filter',
                        ].join('\n'),
                        state: 'open',
                        labels: [],
                        assignee: null,
                        comments: [],
                    },
                    issueFacts: {
                        issueNumber: 1,
                        issueUrl: 'https://github.com/example/repo/issues/1',
                        reportedSiteUrls: [],
                        labels: [],
                        problemType: 'unknown',
                        product: 'Unknown',
                        enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
                        screenshots: [],
                    },
                    issueAttachmentArtifactIds: [],
                    allowedTargetUrls: ['https://example.test/'],
                    artifactsDir: root,
                    filtersPath: root,
                    headless: true,
                    noSandbox: false,
                    vision: vision,
                    recorder,
                    preparedExtension: cachedExtension(),
                    llm: llmConfigStub,
                    piRuntime: piRuntimeStub,
                },
                {
                    ...launchReadBackDependencies([2]),
                    createBaseRegistry: async () => new ToolRegistry(),
                    createBrowserSession: async () => fakePreparedSession(),
                    createBrowserRegistry: async () => browserRegistry,
                },
            );
            await runtime.registry.dispatch('fetch_issue', { issueNumber: 1 });
            await lockExtensionEnvironment(runtime);
            await runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://example.test/',
                profile,
                settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
            });
            await runtime.registry.dispatch('open_page', { url: 'https://example.test/' });
            await runtime.registry.dispatch('screenshot', { captureTiles: true });

            const batchResult = await runtime.registry.dispatch('inspect_full_page_capture', {});

            expect(JSON.stringify(chat.mock.calls)).not.toContain('artifact=overview');
            expect(batchResult).toMatchObject({
                coverageComplete: true,
                inspectedArtifactIds: ['tile-1', 'tile-2', 'tile-3', 'tile-4', 'tile-5'],
                missingArtifactIds: [],
            });
            const inventoryPath = recorder
                .getArtifacts()
                .find(
                    (artifact) =>
                        artifact.id === (batchResult as Record<string, unknown>).evidenceArtifactId,
                )?.path;
            expect(
                JSON.parse(readFileSync(inventoryPath!, 'utf8')) as {
                    excludedOversizedArtifactIds?: string[];
                },
            ).toMatchObject(
                overviewCaptured
                    ? { excludedOversizedArtifactIds: ['overview'] }
                    : { overviewArtifactId: null },
            );
            // The withheld overview is not in the required set, so the tiles alone complete the
            // run's vision evidence and nothing is left waiting for an image nobody can read.
            expect(runtime.getLatestCompleteVisionEnvironment()).toMatchObject({
                fullVisionVerified: true,
                pageCaptures: [{ visionVerified: true }],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('degrades non-retryable when the latest tile capture is provably incomplete', async () => {
        const root = mkdtempSync(join(tmpdir(), 'agent-runtime-incomplete-capture-'));
        const recorder = new TraceRecorder({
            runId: 'incomplete-capture',
            issueNumber: 1,
            mode: 'fix',
        });
        const browserRegistry = new ToolRegistry();
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'open_page',
                    description: 'Open the target page.',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async (args) => ({ url: args.url, statusCode: 200 }),
        });
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'screenshot',
                    description: 'Capture the complete page.',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => {
                for (const artifact of [
                    { id: 'viewport', type: 'screenshot' },
                    { id: 'overview', type: 'screenshot-full-page' },
                ]) {
                    const path = join(root, `${artifact.id}.png`);
                    writeFileSync(path, Buffer.from(`png:${artifact.id}`));
                    recorder.addArtifact({ ...artifact, path, bytes: 10 });
                }
                return {
                    artifactId: 'viewport',
                    fullPageArtifactId: 'overview',
                    tileCoverage: {
                        complete: false,
                        documentWidth: 1_920,
                        documentHeight: 39_881,
                        viewportWidth: 1_920,
                        viewportHeight: 1_080,
                        overlapPx: 160,
                        tiles: [],
                        error: 'Tile capture required 44 images but was bounded to 48.',
                    },
                };
            },
        });
        const vision = clientWith(vi.fn());

        try {
            const runtime = await AgentRuntime.create(
                {
                    issue: {
                        number: 1,
                        url: 'https://github.com/example/repo/issues/1',
                        title: 'Advertising leftover',
                        body: [
                            'A large advertising leftover is visible.',
                            '',
                            '### System configuration',
                            'Filters: | AdGuard Base filter',
                        ].join('\n'),
                        state: 'open',
                        labels: [],
                        assignee: null,
                        comments: [],
                    },
                    issueFacts: {
                        issueNumber: 1,
                        issueUrl: 'https://github.com/example/repo/issues/1',
                        reportedSiteUrls: [],
                        labels: [],
                        problemType: 'unknown',
                        product: 'Unknown',
                        enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
                        screenshots: [],
                    },
                    issueAttachmentArtifactIds: [],
                    allowedTargetUrls: ['https://example.test/'],
                    artifactsDir: root,
                    filtersPath: root,
                    headless: true,
                    noSandbox: false,
                    vision: vision,
                    recorder,
                    preparedExtension: cachedExtension(),
                    llm: llmConfigStub,
                    piRuntime: piRuntimeStub,
                },
                {
                    createBaseRegistry: async () => new ToolRegistry(),
                    createBrowserSession: async () =>
                        ({ close: vi.fn() }) as unknown as BrowserSession,
                    createBrowserRegistry: async () => browserRegistry,
                },
            );
            await runtime.registry.dispatch('fetch_issue', { issueNumber: 1 });
            await lockExtensionEnvironment(runtime);
            await runtime.registry.dispatch('launch_browser', {
                extension: 'none',
                targetUrl: 'https://example.test/',
                profile,
            });
            await runtime.registry.dispatch('open_page', { url: 'https://example.test/' });
            await runtime.registry.dispatch('screenshot', { captureTiles: true });

            const batchResult = await runtime.registry.dispatch('inspect_full_page_capture', {});

            expect(batchResult).toMatchObject({
                errorKind: 'full_page_capture_incomplete',
                retryable: false,
            });
            expect(String((batchResult as Record<string, unknown>).error)).toContain(
                'bounded to 48',
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('returns the deadline envelope when a batch vision call never answers', async () => {
        // The failure this bounds: the batch awaits out-of-loop vision completions, which no
        // agent-loop guard can end. In one live run such a call stalled from 18:33:36Z
        // to 19:17:29Z and the job ran 90 minutes against a 60-minute budget. The hanging client
        // stands in for that gateway at the seam the tool actually uses; that a stalled STREAM
        // becomes an aborted completion is the single-shot suite's contract, not this one's.
        const root = mkdtempSync(join(tmpdir(), 'agent-runtime-vision-deadline-'));
        // Twelve tiles make four tile batches beside the overview: one batch more than there are
        // slots, which is what lets the test see that the waiting one is never sent.
        const DEADLINE_TILES = Array.from({ length: 12 }, (_, index) => index + 1);
        const recorder = new TraceRecorder({
            runId: 'vision-deadline',
            issueNumber: 1,
            mode: 'fix',
        });
        const browserRegistry = new ToolRegistry();
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'open_page',
                    description: 'Open the target page.',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async (args) => ({ url: args.url, statusCode: 200 }),
        });
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'screenshot',
                    description: 'Capture the complete page.',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => {
                for (const artifact of [
                    { id: 'viewport', type: 'screenshot' },
                    { id: 'overview', type: 'screenshot-full-page' },
                    ...DEADLINE_TILES.map((tile) => ({
                        id: `tile-${tile}`,
                        type: 'screenshot-tile',
                    })),
                ]) {
                    const path = join(root, `${artifact.id}.png`);
                    writeFileSync(path, Buffer.from(`png:${artifact.id}`));
                    recorder.addArtifact({ ...artifact, path, bytes: 10 });
                }
                return {
                    artifactId: 'viewport',
                    fullPageArtifactId: 'overview',
                    tileCoverage: {
                        complete: true,
                        documentWidth: 1_920,
                        documentHeight: 2_000,
                        viewportWidth: 1_920,
                        viewportHeight: 1_080,
                        overlapPx: 160,
                        tiles: DEADLINE_TILES.map((tile) => ({
                            artifactId: `tile-${tile}`,
                            index: tile - 1,
                            x: 0,
                            y: (tile - 1) * 920,
                            width: 1_920,
                            height: 1_080,
                            landmark: `Section ${tile}`,
                        })),
                    },
                };
            },
        });
        // A gateway that accepted the request and never answered: the call settles only once
        // something aborts it, so a tool with no deadline — or one whose deadline never reaches
        // the vision request — hangs here forever.
        const visionSignals: (AbortSignal | undefined)[] = [];
        const chat = vi.fn(async (options: { signal?: AbortSignal }) => {
            visionSignals.push(options.signal);
            await new Promise<void>((resolve) => {
                options.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            return {
                kind: SingleShotResultKind.ProviderFailure,
                stopReason: 'aborted',
                message: 'Request was aborted',
                usages: [],
                model: 'vision-model',
            };
        });

        try {
            const runtime = await AgentRuntime.create(
                {
                    issue: {
                        number: 1,
                        url: 'https://github.com/example/repo/issues/1',
                        title: 'Advertising leftover',
                        body: [
                            'A large advertising leftover is visible.',
                            '',
                            '### System configuration',
                            'Filters: | AdGuard Base filter',
                        ].join('\n'),
                        state: 'open',
                        labels: [],
                        assignee: null,
                        comments: [],
                    },
                    issueFacts: {
                        issueNumber: 1,
                        issueUrl: 'https://github.com/example/repo/issues/1',
                        reportedSiteUrls: [],
                        labels: [],
                        problemType: 'unknown',
                        product: 'Unknown',
                        enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
                        screenshots: [],
                    },
                    issueAttachmentArtifactIds: [],
                    allowedTargetUrls: ['https://example.test/'],
                    artifactsDir: root,
                    filtersPath: root,
                    headless: true,
                    noSandbox: false,
                    vision: clientWith(chat),
                    recorder,
                    preparedExtension: cachedExtension(),
                    llm: llmConfigStub,
                    piRuntime: piRuntimeStub,
                },
                {
                    createBaseRegistry: async () => new ToolRegistry(),
                    createBrowserSession: async () =>
                        ({ close: vi.fn() }) as unknown as BrowserSession,
                    createBrowserRegistry: async () => browserRegistry,
                },
            );
            await runtime.registry.dispatch('fetch_issue', { issueNumber: 1 });
            await lockExtensionEnvironment(runtime);
            await runtime.registry.dispatch('launch_browser', {
                extension: 'none',
                targetUrl: 'https://example.test/',
                profile,
            });
            await runtime.registry.dispatch('open_page', { url: 'https://example.test/' });
            await runtime.registry.dispatch('screenshot', { captureTiles: true });

            vi.useFakeTimers();
            try {
                const pending = runtime.registry.dispatch('inspect_full_page_capture', {});
                await vi.advanceTimersByTimeAsync(VISION_TOOL_DEADLINE_MS + 1_000);

                await expect(pending).resolves.toMatchObject({
                    errorKind: 'tool_deadline_exceeded',
                    retryable: true,
                    requiredAction: 'choose_a_different_action',
                });
            } finally {
                vi.useRealTimers();
            }
            // The batches run side by side, so the deadline met one call per slot in flight: its
            // abort reached every one of them, and the batch still waiting for a slot was never
            // sent — nobody pays for a completion whose answer the aborted tool cannot return.
            expect(visionSignals).toHaveLength(PROVIDER_CALL_CONCURRENCY);
            expect(visionSignals.every((signal) => signal?.aborted === true)).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
