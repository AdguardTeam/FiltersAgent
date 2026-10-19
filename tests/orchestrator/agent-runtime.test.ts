import { APPLY_RULE_TOOL_DEADLINE_MS } from '../../src/orchestrator/browser-tool-deadlines';
import { MAX_CANDIDATE_ATTEMPTS } from '../../src/orchestrator/agent-runtime-candidate-context';
import { MAX_DOM_CHECKS, type DomCheckRecord } from '../../src/types/dom-check';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as vitest from 'vitest';
import type { BrowserContext } from 'playwright-core';
import { ToolRegistry } from '../../src/agent/tool-registry';
import { normalizeRule } from '../../src/repo/rule-normalizer';
import { BlockerVerificationMethod } from '../../src/environment/environment-proofs';
import { AdGuardExtensionMessageType } from '../../src/browser/adguard-extension-message-types';
import {
    exceededRulesLimitsFixture,
    fakePreparedExtensionSurface,
    readBackStateFixture,
} from '../environment/test-filtering-environment-fixtures';
import { SettingsLimitation } from '../../src/environment/settings-limitation';
import {
    BrowserConfigurationError,
    BrowserLaunchError,
    SettingsFailureReason,
    type BrowserSessionConfig,
    type BrowserSession,
} from '../../src/browser/browser-session';
import { ConsoleCoverage, type IBrowserSession } from '../../src/browser/browser-interfaces';
import { ApplicationInstructionGap } from '../../src/environment/application-instruction-gap';
import { ApplicationRoute } from '../../src/knowledge/instruction-application-route';
import { loadInstruction, type LoadedInstruction } from '../../src/knowledge/instruction-loader';
import { PhaseLabel } from '../../src/types/validation';
import type { PreparedExtension } from '../../src/local/prepared-extension';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import type { SingleShotClient } from '../../src/pi/single-shot-types';
import { createRunUsageCollector } from '../../src/pi/usage-collector';
import type { IssueFacts } from '../../src/types/issue-facts';
import type { FixOutcome } from '../../src/types/fix-outcome';
import { deriveCandidateArtifactExecutionSuffix } from '../../src/types/candidate-artifact-identity';
import type { CandidateVisualReview } from '../../src/types/candidate-visual-review';
import type { PhaseResult, StructuralSnapshot } from '../../src/types/validation';
import type { CandidateVisualEvidence } from '../../src/validator/candidate-evidence-resolver';
import type { CandidateVisualVerifierResult } from '../../src/validator/candidate-visual-verifier';
import type { FullPageVisualCaptureResult } from '../../src/analyzer/full-page-capture-inspection';
import type { AgentEnvironmentSelectionRequest } from '../../src/environment/environment-selection-contract';
import type { EnvironmentSelectionHost } from '../../src/environment/environment-selection';
import { FidelityLimitationCode } from '../../src/environment/environment-selection-contract';
import { extensionFilteringExecutor } from '../../src/orchestrator/extension-filtering-executor';
import {
    FilteringExecutorRegistry,
    type ExecutorActivationContext,
    type ExecutorAdapterContext,
    type FilteringExecutor,
} from '../../src/orchestrator/filtering-executors';
import type { EvidenceRouteHost } from '../../src/local/evidence-route-contract';
import { projectEnvironmentResult } from '../../src/environment/environment-result-projection';
import {
    AgentRuntime,
    type AgentRuntimeDependencies,
    type AgentRuntimeOptions,
} from '../../src/orchestrator/agent-runtime';
import { finalizeFilteringEnvironmentExecution } from '../../src/orchestrator/filtering-environment-finalization';
import type {
    FilteringEnvironmentAdapter,
    FilteringEnvironmentAdapterState,
    FilteringEnvironmentExecution,
    ValidatorPhaseCompletion,
} from '../../src/environment/filtering-environment';
import {
    ExtensionManifestVersion,
    PreparedExtensionSource,
} from '../../src/environment/extension-preparation';
import {
    EnvironmentPhaseConfigurationOutcome,
    type BrowserExtensionEnvironmentOptions,
    type EnvironmentPhaseConfigurationRequest,
    type EnvironmentPhaseConfigurationResult,
} from '../../src/environment/browser-extension-environment';
import type {
    PhaseApplicationRunnerRequest,
    PhaseApplicationRunnerResult,
} from '../../src/validator/phase-application-contract';
import { BROWSER_LAUNCH_DEADLINE_MS } from '../../src/orchestrator/browser-tool-deadlines';
import type { AdsEnvironmentPhaseObservationInput } from '../../src/validator/phase-orchestrator';
import type { PiRuntime } from '../../src/pi/runtime';
import { testCoreConfig } from '../config/test-core-config';
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = fs;
const { describe, expect, it, vi } = vitest;

/**
 * A SingleShotClient stub; this suite never dispatches a vision call.
 */
const visionStub = {
    modelId: 'vision-model',
    structured: async () => {
        throw new Error('not used by this suite');
    },
    text: async () => {
        throw new Error('not used by this suite');
    },
} as unknown as SingleShotClient;

/**
 * A PiRuntime stub. Every test that reaches the between-phases application flow injects its own
 * `createPhaseApplicationModelRunner`, so the runtime carried on `AgentRuntimeOptions` is never
 * dereferenced; it exists only to satisfy the required option.
 */
const piRuntimeStub = {} as unknown as PiRuntime;

/**
 * Validated LLM configuration `AgentRuntimeOptions` now requires. This suite never sends a real
 * completion through it (see `piRuntimeStub`), so the shared test fixture values stand in.
 */
const llmConfigStub = testCoreConfig().llm;

const rawIssue = {
    number: 235988,
    url: 'https://github.com/AdguardTeam/AdguardFilters/issues/235988',
    title: 'Ad leftover',
    body: [
        'AdGuard Browser Extension v5.4.3.99 MV3',
        '',
        '### System configuration',
        'Filters: | AdGuard Base filter',
    ].join('\n'),
    state: 'open' as const,
    labels: ['T: Ads'],
    assignee: null,
    comments: [],
};

/**
 * The facts a deterministic intake of {@link rawIssue} produced — spelled literally now that the
 * parser is gone.
 */
const rawFacts: IssueFacts = {
    issueNumber: 235988,
    issueUrl: 'https://github.com/AdguardTeam/AdguardFilters/issues/235988',
    reportedSiteUrls: [],
    labels: ['T: Ads'],
    problemType: 'unknown',
    product: 'AdGuard Browser Extension v5.4.3.99 MV3',
    enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
    screenshots: [],
};

const browserProfile = {
    viewport: 'desktop' as const,
    locale: 'en-US',
    timezone: 'UTC',
    consentStrategy: 'untouched' as const,
};

describe('finalizeFilteringEnvironmentExecution', () => {
    it('awaits drain and adapter cleanup before recorder finalization', async () => {
        const calls: string[] = [];
        const actualContext = {
            kind: 'browser_extension' as const,
            product: 'AdGuard Browser Extension',
            browser: 'CloakBrowser Chromium',
            productVersion: '5.5.2.3',
        };
        const adapter: FilteringEnvironmentAdapter = {
            kind: 'browser_extension',
            capabilities: () => ['browser_navigation'],
            prepare: async () => ({
                ready: false,
                limitation: {
                    code: 'phase_open_failed',
                    stage: 'preparation',
                    detail: 'Not used by this lifecycle test.',
                },
            }),
            openPhase: async () => ({
                ready: false,
                limitation: {
                    code: 'phase_open_failed',
                    stage: 'phase',
                    detail: 'Not used by this lifecycle test.',
                },
            }),
            drainOpenHandles: async () => {
                calls.push('drain');
                return { attempted: 1, closed: 1, failed: 0, failures: [] };
            },
            cleanup: async () => {
                calls.push('cleanup');
                return {
                    attempted: true,
                    completed: true,
                    finalizerAttempts: 0,
                    finalizerCompleted: 0,
                    finalizerFailed: 0,
                    failures: [],
                };
            },
            snapshot: () => ({
                kind: 'browser_extension',
                lifecycle: 'ready',
                stateDigest: 'a'.repeat(64),
                actualContext,
                capabilities: ['browser_navigation'],
                preparation: null,
                baseline: null,
                openLeaseIds: [],
                cleanup: null,
            }),
        };
        const execution = {
            recorderVersion: 1 as const,
            runId: 'run-6',
            kind: 'browser_extension' as const,
            actualContext,
            capabilities: ['browser_navigation' as const],
            preparation: null,
            baseline: null,
            phases: [],
            rejectedCandidates: [],
            drain: { attempted: 1, closed: 1, failed: 0, failures: [] },
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
            disposition: { status: 'inconclusive' as const, candidateDigest: null, failure: null },
        } satisfies FilteringEnvironmentExecution;
        const recorder = {
            recordCleanup: () => calls.push('record-cleanup'),
            finalize: () => {
                calls.push('finalize');
                return execution;
            },
        };

        const result = await finalizeFilteringEnvironmentExecution(adapter, recorder, {
            status: 'inconclusive',
            candidateDigest: null,
            failure: null,
        });

        expect(result).toBe(execution);
        expect(calls).toEqual(['drain', 'cleanup', 'record-cleanup', 'finalize']);
    });
});

const reporterImportUrl =
    'https://reports.adguard.com/settings/import.html?scheme_version=4&' +
    'product_version=5.4.3.99&regular_filters=2%2C10&stealth.enabled=0';

function draftOutcome(
    rule = 'nettg.pl##.articleAdSlot',
): Extract<FixOutcome, { outcome: 'propose_rule' }> {
    return {
        outcome: 'propose_rule',
        ruleProposal: {
            rule,
            ruleType: 'cosmetic',
            risk: {
                level: 'low',
                reasons: [],
            },
            placement: {
                filter: 'BaseFilter',
                filePath: 'BaseFilter/sections/foreign.txt',
                confidence: 1,
                alternatives: [],
            },
            duplicateCheck: { classification: 'none', matches: [] },
            productCompatibility: { extension: true },
        },
        policyDecision: { decision: 'allow_rule_generation', reasons: [] },
        reasoning: 'The candidate is vision verified.',
        evidenceSummary: 'Bound before and after evidence.',
    };
}

/**
 * The same draft with its rule placed in another list file.
 *
 * @param draft - Draft to re-place.
 * @param filePath - Repository-relative list file the draft names.
 * @returns The draft naming that file.
 */
function placedIn(
    draft: Extract<FixOutcome, { outcome: 'propose_rule' }>,
    filePath: string,
): Extract<FixOutcome, { outcome: 'propose_rule' }> {
    return {
        ...draft,
        ruleProposal: {
            ...draft.ruleProposal,
            placement: { ...draft.ruleProposal.placement, filePath },
        },
    };
}

/**
 * The run's one host-prepared extension fixture, pinned-release provenance over the shared
 * unpacked-root path the launch wiring hands to injected browser-session factories.
 */
function preparedExtensionFixture(root = '/tmp/cache/extension'): PreparedExtension {
    return {
        extensionPath: root,
        manifestVersion: ExtensionManifestVersion.Mv3,
        source: PreparedExtensionSource.PinnedRelease,
        extensionSourceSha256: 'e'.repeat(64),
        extensionSourceTag: 'v5.5.2.3',
    };
}

/**
 * Build a prepared-extension fixture whose unpacked root carries a bundled filter catalog and the
 * loadable manifest an unpacked build always ships.
 *
 * @param filterIds - Catalog filter IDs listed by the prepared build.
 * @param root - Temporary directory used as the unpacked extension root.
 * @returns Prepared extension fixture with an on-disk bundled catalog.
 */
function preparedExtensionWithBundledCatalog(filterIds: number[], root: string): PreparedExtension {
    mkdirSync(join(root, 'filters'), { recursive: true });
    writeFileSync(
        join(root, 'filters', 'filters_i18n.json'),
        JSON.stringify({
            groups: {},
            tags: {},
            filters: Object.fromEntries(filterIds.map((filterId) => [String(filterId), {}])),
        }),
    );
    writeFileSync(
        join(root, 'manifest.json'),
        JSON.stringify({ manifest_version: 3, version: '5.5.2.3' }),
    );
    return preparedExtensionFixture(root);
}

function emptyRegistry(): ToolRegistry {
    return new ToolRegistry();
}

function registryWithScreenshotAnalysis(): ToolRegistry {
    const registry = emptyRegistry();
    registry.register({
        definition: {
            type: 'function',
            function: {
                name: 'analyze_screenshot',
                description: 'Inspect one screenshot.',
                parameters: { type: 'object', properties: {} },
            },
        },
        handler: async (args) => ({
            artifactId: args.artifactId,
            analysis: `Inspected ${String(args.artifactId)}.`,
        }),
    });
    return registry;
}

function selectionRequest(
    kind: AgentEnvironmentSelectionRequest['kind'],
): AgentEnvironmentSelectionRequest {
    return {
        kind,
        requiredCapabilities:
            kind === 'browser_extension' ? ['browser_navigation', 'filtering_control'] : [],
        intent: {
            issueType: kind === 'unsupported_product_case' ? 'product_specific' : 'ads',
            rationale: 'The issue evidence was classified by the agent.',
            confidence: 0.9,
            evidence: [{ source: 'issue_body', observation: 'The report describes the symptom.' }],
            conflicts: [],
        },
        rationale: 'This environment best matches the available evidence and capabilities.',
        confidence: 0.85,
    };
}

function toolNames(runtime: AgentRuntime): string[] {
    return runtime.registry.getDefinitions().map((definition) => definition.function.name);
}

/**
 * Build the Playwright-shaped error a browser launch crash surfaces as.
 *
 * @param signal - Fatal process signal the browser died with.
 * @returns Error carrying the launch failure and process-exit lines.
 */
function launchCrashError(signal: string): Error {
    return new Error(
        'browserType.launchPersistentContext: Target page, context or browser has ' +
            `been closed\n[pid=7] <process did exit: exitCode=null, signal=${signal}>`,
    );
}

/**
 * Build the browser-extension-shaped registration whose adapter construction a test replaces:
 * production activation behavior (lifecycle reveal on a ready lock), hermetic adapter.
 *
 * @param createAdapter - Adapter factory to install under the extension registration.
 * @returns The registration to place in a hermetic run registry.
 */
function extensionShapedExecutor(
    createAdapter: (context: ExecutorAdapterContext) => FilteringEnvironmentAdapter,
): FilteringExecutor {
    const { createAdapter: _production, ...rest } = extensionFilteringExecutor;
    void _production;
    return { ...rest, createAdapter };
}

/**
 * Build a hermetic run registry carrying the browser-extension-shaped registration.
 *
 * @param createAdapter - Adapter factory to install under the extension registration.
 * @returns The registry seeded for one runtime under test.
 */
function hermeticExtensionRegistry(
    createAdapter: (context: ExecutorAdapterContext) => FilteringEnvironmentAdapter,
): FilteringExecutorRegistry {
    const registry = new FilteringExecutorRegistry();
    registry.register(extensionShapedExecutor(createAdapter));
    return registry;
}

/**
 * The executor name this suite's probe registrations use — a stable bounded identifier distinct
 * from both runtime-owned registrations, so choice flows read honestly.
 */
const PREPARABLE_PROBE_NAME = 'preparable_probe';

/**
 * Build a preparable probe registration whose activation attaches the outcome the behavior returns
 * (when it does) and runs any effects it lined up.
 *
 * @param behavior - Outcome-shaped activation behavior: return the preparation outcome to attach
 *   and/or drive route adoption through the context.
 * @returns The registration to place in a two-element run registry.
 */
function prepareProbeExecutor(
    behavior: (context: ExecutorActivationContext) => unknown,
): FilteringExecutor {
    return {
        name: PREPARABLE_PROBE_NAME,
        descriptor: {
            kind: PREPARABLE_PROBE_NAME,
            availability: 'available',
            preparationState: 'preparable',
            limitationCode: null,
            capabilities: ['cli_installation', 'cli_activation'],
        },
        selectionGuidance: 'Probe desktop reports belong to preparable_probe.',
        activate: async (context) => {
            const outcome = behavior(context) as
                | {
                      ready: boolean;
                      provenance?: Record<string, unknown>;
                      limitation?: Record<string, unknown>;
                  }
                | undefined;
            if (outcome !== undefined) {
                context.environmentHost.attachExecutorPreparation(
                    outcome as Parameters<EnvironmentSelectionHost['attachExecutorPreparation']>[0],
                );
            }
        },
        createAdapter: () => {
            throw new Error('adapter construction is not part of this test.');
        },
    };
}

/**
 * Build a two-element hermetic registry from the given registrations, so the runtime advertises the
 * selection tool and every flow exercises the same choice surface production two-executor runs
 * use.
 *
 * @param executors - The two registrations in run-set order.
 * @returns The registry seeded for one runtime under test.
 */
function twoExecutorRegistry(
    ...executors: readonly FilteringExecutor[]
): FilteringExecutorRegistry {
    const registry = new FilteringExecutorRegistry();
    for (const executor of executors) {
        registry.register(executor);
    }
    return registry;
}

async function createUndecidedRuntime(
    options: AgentRuntimeOptions = runtimeOptions(),
    dependencies: AgentRuntimeDependencies = {},
): Promise<AgentRuntime> {
    return await AgentRuntime.create(options, dependencies);
}

async function createExtensionRuntime(
    options: AgentRuntimeOptions = runtimeOptions(),
    dependencies: AgentRuntimeDependencies = {},
): Promise<AgentRuntime> {
    // The default runtime resolves the public one-element registry and locks its sole executor
    // at construction, so the extension is already selected — with no model choice to make.
    return await createUndecidedRuntime(options, dependencies);
}

async function fetchRuntimeIssue(runtime: AgentRuntime): Promise<void> {
    await runtime.registry.dispatch('fetch_issue', { issueNumber: rawIssue.number });
}

/**
 * A runtime whose browser always lands on `landingUrl` and whose vision classifies every capture as
 * the given obstruction, for the withheld-page budget.
 *
 * @param runId - Trace identity of the run.
 * @param landingUrl - URL every open_page lands on.
 * @param pageObstruction - What vision reports in place of the page.
 * @param analysis - Vision's description of every capture.
 * @param options - Runtime options to start from.
 * @returns Runtime with the environment locked.
 */
async function walledPageRuntime(
    runId: string,
    landingUrl: string,
    pageObstruction: string,
    analysis: string,
    options: AgentRuntimeOptions = runtimeOptions(),
): Promise<AgentRuntime> {
    const recorder = new TraceRecorder({ runId, issueNumber: rawIssue.number, mode: 'fix' });
    let shot = 0;
    const baseRegistry = emptyRegistry();
    baseRegistry.register({
        definition: {
            type: 'function',
            function: {
                name: 'analyze_screenshot',
                description: 'Analyze a registered screenshot',
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
        handler: async (args: Record<string, unknown>) => ({
            artifactId: args.artifactId,
            analysis,
            pageObstruction,
        }),
    });
    return await createExtensionRuntime(
        { ...options, recorder },
        {
            createBaseRegistry: async () => baseRegistry,
            createBrowserSession: vi.fn(
                async () => ({ close: vi.fn() }) as unknown as BrowserSession,
            ),
            createBrowserRegistry: async () => {
                const registry = emptyRegistry();
                registry.register({
                    definition: {
                        type: 'function',
                        function: {
                            name: 'open_page',
                            description: 'Open page',
                            parameters: { type: 'object', properties: {} },
                        },
                    },
                    handler: async () => ({ url: landingUrl, statusCode: 200 }),
                });
                registry.register({
                    definition: {
                        type: 'function',
                        function: {
                            name: 'screenshot',
                            description: 'Capture the page',
                            parameters: { type: 'object', properties: {} },
                        },
                    },
                    handler: async () => {
                        shot += 1;
                        return { artifactId: `shot-${shot}` };
                    },
                });
                return registry;
            },
        },
    );
}

function runtimeOptions() {
    return {
        issue: rawIssue,
        issueFacts: rawFacts,
        issueAttachmentArtifactIds: ['issue-screenshot-a'],
        allowedTargetUrls: ['https://nettg.pl/', 'https://nettg.pl/article/123'],
        artifactsDir: '/tmp/artifacts',
        filtersPath: '/tmp/filters',
        headless: true,
        noSandbox: false,
        vision: visionStub,
        recorder: new TraceRecorder({
            runId: 'agent-runtime-test',
            issueNumber: rawIssue.number,
            mode: 'fix',
        }),
        preparedExtension: preparedExtensionFixture(),
        llm: llmConfigStub,
        piRuntime: piRuntimeStub,
    };
}

function verifiedCandidateToolResult(recorder: TraceRecorder, rule = 'nettg.pl##.articleAdSlot') {
    const candidateRuleHash = createHash('sha256').update(rule).digest('hex');
    const validationHash = candidateRuleHash.slice(0, 12);
    const validationArtifactId = `validation-${validationHash}`;
    const visualReviewArtifactId = `visual-review-${validationHash}`;
    const artifacts = [
        {
            id: validationArtifactId,
            path: `/tmp/artifacts/factual-validation-${validationHash}.json`,
            type: 'application/json',
        },
        {
            id: visualReviewArtifactId,
            path: `/tmp/artifacts/candidate-visual-review-${validationHash}.json`,
            type: 'candidate-visual-review',
        },
        {
            id: 'candidate-before-viewport',
            path: '/tmp/artifacts/candidate-before-viewport.png',
            type: 'screenshot',
        },
        {
            id: 'candidate-after-viewport',
            path: '/tmp/artifacts/candidate-after-viewport.png',
            type: 'screenshot',
        },
        {
            id: 'candidate-before-full-page',
            path: '/tmp/artifacts/candidate-before-full-page.png',
            type: 'screenshot-full-page',
        },
        {
            id: 'candidate-after-full-page',
            path: '/tmp/artifacts/candidate-after-full-page.png',
            type: 'screenshot-full-page',
        },
    ] as const;
    for (const artifact of artifacts) {
        recorder.addArtifact({ ...artifact, bytes: 100 });
    }
    return {
        validationArtifactId,
        visualReviewArtifactId,
        phaseA: { url: 'https://nettg.pl/' },
        phaseB: { url: 'https://nettg.pl/' },
        phaseC: { url: 'https://nettg.pl/' },
        visualReview: {
            verdict: 'verified',
            symptom: 'resolved',
            symptomScope: 'The reporter-visible advertising placeholder.',
            adLayoutResidue: 'absent',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'candidate-before-viewport',
                    landmark: 'Article body',
                    description: 'The advertising placeholder is visible.',
                },
            ],
            remainingInstances: [],
            pageIntegrity: 'intact',
            validationArtifactId,
            candidateRuleHash,
            beforeViewportArtifactId: 'candidate-before-viewport',
            afterViewportArtifactId: 'candidate-after-viewport',
            beforeFullPageArtifactId: 'candidate-before-full-page',
            afterFullPageArtifactId: 'candidate-after-full-page',
            model: 'vision-model',
            rationale: 'The complete symptom disappeared and page integrity remained intact.',
            observedDamage: [],
        },
    };
}

function completePageRegistry(
    prefix: string,
    applyRuleResult?: Record<string, unknown>,
): ToolRegistry {
    const registry = emptyRegistry();
    registry.register({
        definition: {
            type: 'function',
            function: {
                name: 'open_page',
                description: 'Open the page.',
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
        handler: async () => ({
            artifactId: `${prefix}-viewport`,
            fullPageArtifactId: `${prefix}-full`,
            tileCoverage: {
                complete: true,
                tiles: [{ artifactId: `${prefix}-tile` }],
            },
        }),
    });
    if (applyRuleResult) {
        registry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'apply_rule',
                    description: 'Validate a candidate.',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => applyRuleResult,
        });
    }
    return registry;
}

async function captureCompletePage(runtime: AgentRuntime, prefix: string): Promise<void> {
    await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' });
    await runtime.registry.dispatch('screenshot', { captureTiles: true });
    for (const artifactId of [`${prefix}-full`, `${prefix}-tile`]) {
        await runtime.registry.dispatch('analyze_screenshot', {
            artifactId,
            prompt: `Inspect ${artifactId}.`,
        });
    }
}

/**
 * Register the bounded screenshot-inspection handler an analyze dispatch needs, on a base registry
 * that otherwise serves intent-specific tools.
 *
 * @param registry - Base registry to extend.
 */
function registerAnalyzeScreenshotStub(registry: ToolRegistry): void {
    registry.register({
        definition: {
            type: 'function',
            function: {
                name: 'analyze_screenshot',
                description: 'Inspect one screenshot.',
                parameters: { type: 'object', properties: {} },
            },
        },
        handler: async (args) => ({
            artifactId: args.artifactId,
            analysis: `Inspected ${String(args.artifactId)}.`,
        }),
    });
}

/**
 * Board one complete verified prepared session's current-build page vision into the runtime, so
 * terminal validation passes the current-prepared prerequisite and reaches its intent-specific
 * checks. The base registry must carry an analyze_screenshot handler; the runtime must lock its
 * sole executor at construction.
 *
 * @param runtime - Runtime to load the current-build vision into.
 */
async function boardCurrentPreparedVision(runtime: AgentRuntime): Promise<void> {
    await runtime.registry.dispatch('launch_browser', {
        extension: 'prepared',
        targetUrl: 'https://nettg.pl/',
        profile: browserProfile,
        settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
    });
    await captureCompletePage(runtime, 'current');
}

/**
 * Browser seams serving one verified prepared session and one complete-page browser registry, for
 * tests whose terminal assertions run behind the current-prepared vision prerequisite.
 *
 * @returns The launch read-back and browser dependencies to spread into AgentRuntime dependencies.
 */
function verifiedPreparedVisionSeams(): {
    createBrowserSession: () => Promise<BrowserSession>;
    createBrowserRegistry: () => Promise<ToolRegistry>;
} & ReturnType<typeof launchReadBackDependencies> {
    return {
        ...launchReadBackDependencies(),
        createBrowserSession: async () => fakePreparedSession(),
        createBrowserRegistry: async () => completePageRegistry('current'),
    };
}

/**
 * A run instruction whose own `## Rule application` steps keep the application model-driven.
 *
 * The built-in AdGuard route is performed by the host in code and builds no session runner at all,
 * so a test that has to observe, delay or meter the bounded model session declares its own steps —
 * exactly as a repository does whose blocker has its own way to add a rule.
 *
 * @returns The loaded instruction to hand the runtime.
 */
function ownApplicationInstruction(): LoadedInstruction {
    return {
        path: 'issues/AGENTS.md',
        content: [
            '# The blocker',
            '',
            '## Rule application',
            '',
            "Open the blocker's options page and add the rule from the goal as one exact line.",
            '',
            '## State verification',
            '',
            'read: extension-state user-rules',
            '',
        ].join('\n'),
        sha256: 'a'.repeat(64),
        documents: [],
    };
}

/**
 * One runtime whose prepared launch reaches the application session and then aborts with the launch
 * deadline, with a browser registry that would merge tools on a verified settle.
 *
 * The run carries an own-application instruction: the deadline this harness exercises has to reach
 * a bounded model session, and only that shape of instruction builds one.
 *
 * @returns The runtime, the launched session's close spy, the model-runner signal, and the host
 *   pre-read counter.
 */
async function abortingLaunchHarness(): Promise<{
    runtime: AgentRuntime;
    closeSession: ReturnType<typeof vi.fn>;
    runnerSignal: () => AbortSignal | undefined;
    stateReads: () => number;
}> {
    const closeSession = vi.fn(async () => undefined);
    let runnerSignal: AbortSignal | undefined;
    let stateReads = 0;
    const runtime = await createExtensionRuntime(
        { ...runtimeOptions(), instruction: ownApplicationInstruction() },
        {
            createBaseRegistry: async () => emptyRegistry(),
            createBrowserSession: async () =>
                ({
                    close: closeSession,
                    extensionContext: fakePreparedExtensionSurface().context,
                }) as unknown as BrowserSession,
            createBrowserRegistry: async () => completePageRegistry('late-launch'),
            readAdGuardExtensionState: vi.fn(async () => {
                stateReads += 1;
                return readBackStateFixture([2]);
            }),
            findExtensionRuntime: vi.fn(async () => ({
                extensionId: 'test-extension-id',
                manifestVersion: ExtensionManifestVersion.Mv3,
            })),
            createPhaseApplicationModelRunner: vi.fn(() => ({
                run: (request: PhaseApplicationRunnerRequest) =>
                    new Promise<PhaseApplicationRunnerResult>((resolve) => {
                        runnerSignal = request.signal;
                        request.signal?.addEventListener('abort', () => {
                            resolve({
                                completed: false,
                                detail: 'The launch deadline aborted the application session.',
                                actionLog: [],
                            });
                        });
                    }),
            })),
        },
    );
    return {
        runtime,
        closeSession,
        runnerSignal: () => runnerSignal,
        stateReads: () => stateReads,
    };
}

describe('AgentRuntime', () => {
    it('gives repeated semantic candidates unique physical environment experiment identities', async () => {
        const filtersPath = mkdtempSync(join(tmpdir(), 'agent-runtime-environment-retry-'));
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'lookup_rule_guidance',
                    description: 'Read rule guidance.',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ topic: 'element_hiding' }),
        });
        const actualContext = {
            kind: 'browser_extension' as const,
            product: 'AdGuard Browser Extension',
            browser: 'CloakBrowser Chromium',
            productVersion: '5.5.2.3',
        };
        const baselineDigest = 'd'.repeat(64);
        let lifecycle: FilteringEnvironmentAdapterState['lifecycle'] = 'ready';
        let cleanupReceipt: FilteringEnvironmentAdapterState['cleanup'] = null;
        const adapterState = (): FilteringEnvironmentAdapterState => ({
            kind: 'browser_extension',
            lifecycle,
            stateDigest: 'e'.repeat(64),
            actualContext,
            capabilities: ['browser_navigation', 'filtering_control'],
            preparation: {
                preparedAt: '2026-07-24T00:00:00.000Z',
                buildDigest: 'f'.repeat(64),
                extensionRootDigest: null,
            },
            baseline: {
                environment: 'browser_extension',
                acquiredAt: '2026-07-24T00:00:00.000Z',
                enabledListKeys: ['adguard:2'],
                resources: [
                    {
                        listKey: 'adguard:2',
                        rulesetId: 'ruleset_2',
                        path: 'filters/ruleset_2.json',
                        version: '2.0.0',
                        byteCount: 2,
                        sha256: 'a'.repeat(64),
                    },
                ],
                aggregateDigest: baselineDigest,
            },
            openLeaseIds: [],
            cleanup: cleanupReceipt,
        });
        const openedExperimentIds: string[] = [];
        const adapter: FilteringEnvironmentAdapter = {
            kind: 'browser_extension',
            capabilities: () => ['browser_navigation', 'filtering_control'],
            prepare: async () => ({ ready: true, state: adapterState() }),
            openPhase: async (request) => {
                if (request.phase === 'A') {
                    openedExperimentIds.push(request.experimentId);
                }
                const candidateDigest =
                    request.phase === 'C'
                        ? createHash('sha256').update(request.candidate!.rule).digest('hex')
                        : null;
                const sessionId = `${request.experimentId}-${request.phase}`;
                let filteringState:
                    | 'disabled'
                    | 'published_baseline'
                    | 'published_baseline_plus_candidate' = 'disabled';
                if (request.phase === 'B') {
                    filteringState = 'published_baseline';
                }
                if (request.phase === 'C') {
                    filteringState = 'published_baseline_plus_candidate';
                }
                const extensionProof = {
                    packageVersion: '5.5.2.3',
                    manifestVersion: '5.5.2.3',
                    profileKind: 'agent_selected' as const,
                    enabledListKeys: ['adguard:2'],
                    activeRulesetListKeys: ['adguard:2'],
                    stealthEnabled: false,
                    userRulesDigest: candidateDigest,
                    application: {
                        method: BlockerVerificationMethod.ExtensionState,
                        appliedRules: request.phase === 'C' ? [request.candidate!.rule] : [],
                        actionLog: [],
                    },
                    provenance: {
                        source: PreparedExtensionSource.PinnedRelease,
                        extensionPath: '/tmp/cache/extension',
                        manifestVersion: 3 as const,
                        extensionSourceSha256: 'e'.repeat(64),
                        extensionSourceTag: 'v5.5.2.3',
                    },
                };
                return {
                    ready: true,
                    handle: {
                        session: {
                            artifactsDir: '/tmp/artifacts',
                            isClosed: false,
                            getPage: () => ({}) as never,
                            close: async () => undefined,
                            getNetworkLog: () => [],
                            resetNetworkLog: () => undefined,
                            getConsoleLog: () => [],
                            consoleCoverage: ConsoleCoverage.BrowserLogOnly,
                        } as IBrowserSession,
                        adapterProof: {
                            leaseId: sessionId,
                            adapterStateDigest: 'e'.repeat(64),
                            phase: request.phase,
                            filteringState,
                            sessionId,
                            actualContext,
                            baselineDigest: request.phase === 'A' ? null : baselineDigest,
                            candidateDigest,
                            extension: request.phase === 'A' ? null : extensionProof,
                        },
                        close: async () => undefined,
                    },
                };
            },
            drainOpenHandles: async () => ({
                attempted: 0,
                closed: 0,
                failed: 0,
                failures: [],
            }),
            cleanup: async () => {
                lifecycle = 'cleaned';
                cleanupReceipt = {
                    attempted: true,
                    completed: true,
                    finalizerAttempts: 0,
                    finalizerCompleted: 0,
                    finalizerFailed: 0,
                    failures: [],
                };
                return cleanupReceipt;
            },
            snapshot: adapterState,
        };
        const legacyApplyRule = vi.fn(async () => ({ legacy: true }));
        let candidateObservation = 0;
        let fixtureAttempt = 0;
        const validationArtifactIds: string[] = [];
        const reviewedDomChecks: Array<readonly DomCheckRecord[] | undefined> = [];
        const candidateRule = 'nettg.pl##.articleAdSlot';
        const candidateRuleHash = createHash('sha256').update(candidateRule).digest('hex');
        const artifactsDir = join(filtersPath, 'artifacts');
        mkdirSync(artifactsDir, { recursive: true });
        const fixtureArtifacts = new Map<
            number,
            Map<
                'A' | 'B' | 'C',
                {
                    viewport: { id: string; path: string };
                    fullPage: { id: string; path: string };
                    tile: { id: string; path: string };
                }
            >
        >();
        const verificationByToken = new Map<string, boolean>();
        const registerArtifact = (
            recorder: TraceRecorder,
            id: string,
            path: string,
            type: string,
        ): void => {
            writeFileSync(path, '{}');
            recorder.addArtifact({ id, path, type, bytes: 2 });
        };
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- Scenario-local fixture.
        const structuralSnapshot = (targetPresent: boolean): StructuralSnapshot => ({
            probeSucceeded: true,
            targetCount: targetPresent ? 1 : 0,
            targetVisibleCount: targetPresent ? 1 : 0,
            targetTotalHeight: targetPresent ? 100 : 0,
            targetTotalArea: targetPresent ? 10_000 : 0,
            documentHeight: 1_000,
            fixedTopOverlayBottom: 0,
            visibleHeadingCount: 1,
            visibleBreadcrumbCount: 0,
            overlappedHeadingCount: 0,
            overlappedBreadcrumbCount: 0,
            minimumOverlappedLandmarkTop: null,
            meaningfulTextLength: 1_000,
            textGeometry: {
                totalCount: 1,
                visibleCount: 1,
                visibleArea: 10_000,
                clippedCount: 0,
                occludedCount: 0,
            },
            mediaGeometry: {
                totalCount: 0,
                visibleCount: 0,
                visibleArea: 0,
                clippedCount: 0,
                occludedCount: 0,
            },
            controlGeometry: {
                totalCount: 0,
                visibleCount: 0,
                visibleArea: 0,
                clippedCount: 0,
                occludedCount: 0,
            },
        });
        const runtime = await createExtensionRuntime(
            {
                ...runtimeOptions(),
                filtersPath,
                artifactsDir,
                issueAttachmentArtifactIds: [],
            },
            {
                createBaseRegistry: async () => baseRegistry,
                ...launchReadBackDependencies(),
                createBrowserSession: async () => fakePreparedSession(),
                createBrowserRegistry: async () => {
                    const registry = emptyRegistry();
                    registry.register({
                        definition: {
                            type: 'function',
                            function: {
                                name: 'apply_rule',
                                description: 'Legacy candidate validation.',
                                parameters: { type: 'object', properties: {} },
                            },
                        },
                        handler: legacyApplyRule,
                    });
                    return registry;
                },
                filteringExecutors: hermeticExtensionRegistry(() => adapter),
                browserExtensionAdsObserverDependencies: {
                    runPhase: async (input, config): Promise<PhaseResult> => {
                        if (input.phase === 'A') {
                            fixtureAttempt += 1;
                        }
                        if (input.phase === 'C') {
                            candidateObservation += 1;
                        }
                        const verified = input.phase === 'C' && candidateObservation === 2;
                        verificationByToken.set(input.phaseTokenId, verified);
                        const suffix = deriveCandidateArtifactExecutionSuffix(input.phaseTokenId);
                        const phaseArtifacts = {
                            viewport: {
                                id: `viewport-${suffix}`,
                                path: join(artifactsDir, `viewport-${suffix}.png`),
                            },
                            fullPage: {
                                id: `full-${suffix}`,
                                path: join(artifactsDir, `full-${suffix}.png`),
                            },
                            tile: {
                                id: `tile-${suffix}`,
                                path: join(artifactsDir, `tile-${suffix}.png`),
                            },
                        };
                        const attemptArtifacts = fixtureArtifacts.get(fixtureAttempt) ?? new Map();
                        attemptArtifacts.set(input.phase, phaseArtifacts);
                        fixtureArtifacts.set(fixtureAttempt, attemptArtifacts);
                        for (const artifact of Object.values(phaseArtifacts)) {
                            registerArtifact(
                                config.recorder,
                                artifact.id,
                                artifact.path,
                                'image/png',
                            );
                        }
                        const harId = `har-${suffix}`;
                        const harPath = join(artifactsDir, `${harId}.json`);
                        const domId = `dom-${suffix}`;
                        const domPath = join(artifactsDir, `${domId}.html`);
                        registerArtifact(config.recorder, harId, harPath, 'application/json');
                        registerArtifact(config.recorder, domId, domPath, 'text/html');
                        return {
                            phase: input.phase,
                            screenshotArtifactId: phaseArtifacts.viewport.id,
                            fullPageScreenshotArtifactId: phaseArtifacts.fullPage.id,
                            tileCoverage: {
                                complete: true,
                                documentWidth: 1_000,
                                documentHeight: 1_000,
                                viewportWidth: 1_000,
                                viewportHeight: 1_000,
                                overlapPx: 0,
                                tiles: [
                                    {
                                        artifactId: phaseArtifacts.tile.id,
                                        index: 0,
                                        x: 0,
                                        y: 0,
                                        width: 1_000,
                                        height: 1_000,
                                        landmark: 'Article body',
                                    },
                                ],
                            },
                            harArtifactId: harId,
                            domArtifactId: domId,
                            url: 'https://nettg.pl/',
                            appliedRules: [],
                            ruleApplications: [],
                            antiAdblockDetected: false,
                        };
                    },
                    probeStructuralSnapshot: async (input): Promise<StructuralSnapshot> =>
                        structuralSnapshot(
                            input.phase !== 'C' || !verificationByToken.get(input.phaseTokenId),
                        ),
                    inspectFullPageVisualCapture: async (
                        input,
                        options,
                    ): Promise<FullPageVisualCaptureResult> => {
                        const suffix = deriveCandidateArtifactExecutionSuffix(input.phaseTokenId);
                        const artifactId = `inventory-${suffix}`;
                        const artifactPath = join(artifactsDir, `${artifactId}.json`);
                        registerArtifact(
                            options.recorder,
                            artifactId,
                            artifactPath,
                            'application/json',
                        );
                        return {
                            inventory: {
                                reporterSymptomPresence:
                                    input.phase === 'C' &&
                                    verificationByToken.get(input.phaseTokenId)
                                        ? 'absent'
                                        : 'present',
                            } as FullPageVisualCaptureResult['inventory'],
                            artifactId,
                            artifactPath,
                            coverageComplete: true,
                            inspectedArtifactIds: [],
                            missingArtifactIds: [],
                            batchFailures: [],
                        };
                    },
                    resolveCandidateVisualEvidence: (_input, options): CandidateVisualEvidence => {
                        validationArtifactIds.push(options.validationArtifactId);
                        const attempt = fixtureArtifacts.get(fixtureAttempt)!;
                        const before = attempt.get('B')!;
                        const after = attempt.get('C')!;
                        return {
                            factualValidation: {} as CandidateVisualEvidence['factualValidation'],
                            beforeViewport: before.viewport,
                            beforeFullPage: before.fullPage,
                            afterViewport: after.viewport,
                            afterFullPage: after.fullPage,
                            beforeTiles: [],
                            afterTiles: [],
                            beforeCoverageComplete: true,
                            afterCoverageComplete: true,
                            beforeDocumentCoverageComplete: true,
                            afterDocumentCoverageComplete: true,
                        };
                    },
                    reviewCandidateVisually: async (
                        input,
                        options,
                    ): Promise<CandidateVisualVerifierResult> => {
                        reviewedDomChecks.push(options.domChecks);
                        const verified = verificationByToken.get(input.phaseTokenId) === true;
                        const suffix = deriveCandidateArtifactExecutionSuffix(input.phaseTokenId);
                        const artifactId =
                            `visual-review-${candidateRuleHash.slice(0, 12)}` +
                            `-execution-${suffix}`;
                        const artifactPath = join(artifactsDir, `${artifactId}.json`);
                        registerArtifact(
                            options.recorder,
                            artifactId,
                            artifactPath,
                            'application/json',
                        );
                        const unresolvedInstance = {
                            artifactId: options.evidence.afterViewport.id,
                            landmark: 'Article body',
                            description: 'The advertisement remains visible.',
                        };
                        const review: CandidateVisualReview = {
                            verdict: verified ? 'verified' : 'rejected',
                            symptom: verified ? 'resolved' : 'not_resolved',
                            symptomScope: 'The reported advertisement.',
                            adLayoutResidue: verified ? 'absent' : 'present',
                            coverageComplete: true,
                            beforeInstances: [
                                {
                                    artifactId: options.evidence.beforeViewport.id,
                                    landmark: 'Article body',
                                    description: 'The advertisement is visible.',
                                },
                            ],
                            remainingInstances: verified ? [] : [unresolvedInstance],
                            pageIntegrity: 'intact',
                            validationArtifactId: options.validationArtifactId,
                            candidateRuleHash,
                            beforeViewportArtifactId: options.evidence.beforeViewport.id,
                            afterViewportArtifactId: options.evidence.afterViewport.id,
                            beforeFullPageArtifactId: options.evidence.beforeFullPage?.id ?? null,
                            afterFullPageArtifactId: options.evidence.afterFullPage?.id ?? null,
                            model: 'vision-model',
                            rationale: verified
                                ? 'The advertisement disappeared without page damage.'
                                : 'The advertisement remains visible.',
                            observedDamage: [],
                        };
                        return { review, artifactId, artifactPath };
                    },
                },
            },
        );
        await runtime.registry.dispatch('lookup_rule_guidance', { topic: 'element_hiding' });

        const candidateResults: Record<string, unknown>[] = [];
        const slotCheck = {
            expression: "document.querySelector('.articleAdSlot').offsetHeight",
            claim: 'The emptied slot keeps no reserved height.',
        };
        for (let attempt = 0; attempt < 2; attempt += 1) {
            await runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
                settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
            });
            if (attempt === 0) {
                expect(runtime.getEnvironmentSelection()?.actual).toBeNull();
            }
            const candidateResult = await runtime.registry.dispatch('apply_rule', {
                candidateRule,
                // The second experiment measures the slot the first review called residue.
                ...(attempt === 1 ? { domChecks: [slotCheck] } : {}),
            });
            candidateResults.push(candidateResult);
            expect(candidateResult).toMatchObject({
                visualReview: {
                    verdict: attempt === 0 ? 'rejected' : 'verified',
                },
            });
            expect(runtime.getEnvironmentSelection()?.actual).toEqual(actualContext);
            await runtime.registry.dispatch('close_browser', {});
        }

        const expectedDigest = candidateRuleHash;
        expect(openedExperimentIds).toEqual([
            `candidate-1-execution-1-${expectedDigest.slice(0, 12)}`,
            `candidate-1-execution-2-${expectedDigest.slice(0, 12)}`,
        ]);
        expect(runtime.getFilteringEnvironmentLifecycle()?.disposition).toEqual({
            status: 'verified',
            candidateDigest: expectedDigest,
            failure: null,
        });
        const lifecycleEvidence = runtime.getFilteringEnvironmentLifecycle()!;
        const execution = await finalizeFilteringEnvironmentExecution(
            lifecycleEvidence.adapter,
            lifecycleEvidence.recorder,
            lifecycleEvidence.disposition,
        );
        const artifactIds = execution.phases.flatMap((phase) =>
            phase.completion.kind === 'observed'
                ? phase.completion.artifacts.map((artifact) => artifact.artifactId)
                : [],
        );
        const artifactPaths = execution.phases.flatMap((phase) =>
            phase.completion.kind === 'observed'
                ? phase.completion.artifacts.map((artifact) => artifact.path)
                : [],
        );
        expect(new Set(artifactIds).size).toBe(artifactIds.length);
        expect(new Set(artifactPaths).size).toBe(artifactPaths.length);
        expect(new Set(validationArtifactIds).size).toBe(2);
        expect(reviewedDomChecks[0]).toBeUndefined();
        expect(reviewedDomChecks[1]).toEqual([
            expect.objectContaining({ expression: slotCheck.expression, claim: slotCheck.claim }),
        ]);
        expect(projectEnvironmentResult(execution)?.candidateValidationEvidence).toMatchObject({
            validationArtifactId: validationArtifactIds[1],
            sessionId: expect.stringContaining('execution-2'),
        });
        expect(legacyApplyRule).not.toHaveBeenCalled();
        rmSync(filtersPath, { recursive: true, force: true });
    });

    it('lets the agent select Extension before exposing its lifecycle tools', async () => {
        const runtime = await createUndecidedRuntime(
            {
                ...runtimeOptions(),
                issueAttachmentArtifactIds: [],
                issueFacts: {
                    issueNumber: rawIssue.number,
                    issueUrl: rawIssue.url,
                    reportedSiteUrls: ['https://nettg.pl/'],
                    labels: ['T: Ads', 'N: AdGuard for Windows'],
                    declaredIssueType: 'Ads',
                    problemType: 'ads',
                    product: 'AdGuard for Windows',
                    os: 'Windows 11',
                    browser: 'Edge',
                    enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
                    screenshots: [],
                },
            },
            {
                createBaseRegistry: async () => emptyRegistry(),
                filteringExecutors: twoExecutorRegistry(
                    extensionShapedExecutor(() => {
                        throw new Error('adapter construction is not part of this test.');
                    }),
                    prepareProbeExecutor(() => ({ ready: true }) as never),
                ),
            },
        );

        expect(toolNames(runtime)).toContain('select_environment');
        const fetched = await runtime.registry.dispatch('fetch_issue', {
            issueNumber: rawIssue.number,
        });
        expect(fetched.capabilities).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'browser_extension', availability: 'available' }),
                expect.objectContaining({
                    kind: PREPARABLE_PROBE_NAME,
                    availability: 'available',
                    preparationState: 'preparable',
                }),
            ]),
        );

        await expect(
            runtime.registry.dispatch('select_environment', selectionRequest('browser_extension')),
        ).resolves.toMatchObject({ accepted: true, state: 'ready' });
        // The run's build is host-prepared; the accepted selection reveals the browser lifecycle.
        expect(toolNames(runtime)).toContain('launch_browser');
        expect(toolNames(runtime)).toContain('close_browser');
        expect(runtime.getEnvironmentSelection()).toMatchObject({
            selectedKind: 'browser_extension',
            reported: { product: 'AdGuard for Windows', browser: 'Edge' },
        });
    });

    it('keeps a preparation-failed lock limited, records a rejected switch, and prepares once', async () => {
        const activations: number[] = [];
        const probe = prepareProbeExecutor(() => {
            activations.push(1);
            return {
                ready: false,
                limitation: {
                    stage: 'prepare',
                    code: 'probe_preparation_failed',
                    detail: 'The probe executor never became ready.',
                },
            };
        });
        const runtime = await createUndecidedRuntime(
            { ...runtimeOptions(), issueAttachmentArtifactIds: [] },
            {
                createBaseRegistry: async () => emptyRegistry(),
                filteringExecutors: twoExecutorRegistry(
                    extensionShapedExecutor(() => {
                        throw new Error('adapter construction is not part of this test.');
                    }),
                    probe,
                ),
            },
        );

        await expect(
            runtime.registry.dispatch(
                'select_environment',
                selectionRequest(PREPARABLE_PROBE_NAME),
            ),
        ).resolves.toMatchObject({
            accepted: true,
            state: 'capability_limited',
            limitationCode: 'environment_preparation_failed',
        });
        expect(activations).toHaveLength(1);
        await expect(
            runtime.registry.dispatch('select_environment', selectionRequest('browser_extension')),
        ).resolves.toMatchObject({
            accepted: false,
            errorKind: 'environment_locked',
            selectedKind: PREPARABLE_PROBE_NAME,
        });
        expect(runtime.getEnvironmentSelection()?.rejectedRequests).toHaveLength(1);
        expect(activations).toHaveLength(1);
    });

    it('binds a ready preparation from the chosen registration and exposes no extension tools', async () => {
        const probe = prepareProbeExecutor(() => ({
            ready: true,
            provenance: {
                source: 'official_release',
                product: 'Probe product',
                version: '1.0.0',
                digestB32: 'digestb32examplevalue0123456789abcdefghijklmnopqrstuvwxyz',
            },
        }));
        const runtime = await createUndecidedRuntime(
            { ...runtimeOptions(), issueAttachmentArtifactIds: [] },
            {
                createBaseRegistry: async () => emptyRegistry(),
                filteringExecutors: twoExecutorRegistry(
                    extensionShapedExecutor(() => {
                        throw new Error('adapter construction is not part of this test.');
                    }),
                    probe,
                ),
            },
        );

        await expect(
            runtime.registry.dispatch(
                'select_environment',
                selectionRequest(PREPARABLE_PROBE_NAME),
            ),
        ).resolves.toMatchObject({ accepted: true, state: 'ready' });
        expect(runtime.getEnvironmentSelection()).toMatchObject({
            selectedKind: PREPARABLE_PROBE_NAME,
            cliPreparation: {
                state: 'ready',
                provenance: { product: 'Probe product', version: '1.0.0' },
            },
        });
        expect(toolNames(runtime)).not.toContain('launch_browser');
    });

    it('never activates preparation for a report with no executable official baseline', async () => {
        const activations: number[] = [];
        // The probe guards itself exactly as a real preparable registration does: an activation
        // against a lock whose report baseline cannot execute prepares nothing.
        const probe = prepareProbeExecutor((context) => {
            if (context.environmentHost.snapshot()?.filterBaseline?.status !== 'executable') {
                return undefined;
            }
            activations.push(1);
            return { ready: true } as never;
        });
        const runtime = await createUndecidedRuntime(
            {
                ...runtimeOptions(),
                issueAttachmentArtifactIds: [],
                issueFacts: { ...rawFacts, enabledFilters: [{ name: 'EasyList' }] },
            },
            {
                createBaseRegistry: async () => emptyRegistry(),
                filteringExecutors: twoExecutorRegistry(
                    extensionShapedExecutor(() => {
                        throw new Error('adapter construction is not part of this test.');
                    }),
                    probe,
                ),
            },
        );

        await expect(
            runtime.registry.dispatch(
                'select_environment',
                selectionRequest(PREPARABLE_PROBE_NAME),
            ),
        ).resolves.toMatchObject({
            accepted: true,
            state: 'capability_limited',
            limitationCode: 'filter_selection_not_executable',
            filterBaseline: { status: 'not_executable', code: 'no_official_filter_baseline' },
        });
        expect(activations).toHaveLength(0);
        expect(toolNames(runtime)).not.toContain('launch_browser');
    });

    it('requires selection before terminal completion and allows limited report-only completion', async () => {
        const probe = prepareProbeExecutor(() => ({
            ready: false,
            limitation: {
                stage: 'prepare',
                code: 'probe_preparation_failed',
                detail: 'The probe executor never became ready.',
            },
        }));
        const runtime = await createUndecidedRuntime(
            { ...runtimeOptions(), issueAttachmentArtifactIds: [] },
            {
                createBaseRegistry: async () => emptyRegistry(),
                filteringExecutors: twoExecutorRegistry(
                    extensionShapedExecutor(() => {
                        throw new Error('adapter construction is not part of this test.');
                    }),
                    probe,
                ),
            },
        );
        await fetchRuntimeIssue(runtime);
        const analysisOnly: FixOutcome = {
            outcome: 'analysis_only',
            reasoning: 'The selected adapter is unavailable.',
        };

        expect(runtime.validateTerminalOutcome(analysisOnly)).toMatchObject({
            errorKind: 'environment_selection_required',
            requiredTool: 'select_environment',
        });
        await runtime.registry.dispatch(
            'select_environment',
            selectionRequest(PREPARABLE_PROBE_NAME),
        );
        expect(runtime.validateTerminalOutcome(analysisOnly)).toBeUndefined();
        expect(runtime.validateTerminalOutcome(draftOutcome())).toMatchObject({
            errorKind: 'environment_report_only_required',
        });
    });

    it('asks an activated route for its own full-page vision instead of a prepared extension', async () => {
        const evidenceRoute = {
            prepareConfiguration: vi.fn(async () => undefined),
            launchEvidenceSession: vi.fn(),
            environmentPorts: vi.fn(() => {
                throw new Error('not used by this test.');
            }),
            snapshot: vi.fn(() => ({
                state: 'configured' as const,
                port: null,
                baseFilterEnabled: false,
                reproducedFilterIds: [],
                unavailableFilterIds: [],
                failureCode: null,
            })),
        };
        const probe = prepareProbeExecutor((context) => {
            context.environmentHost.attachExecutorPreparation({
                ready: true,
                provenance: {
                    source: 'official_release',
                    product: 'Probe product',
                    version: '1.0.0',
                    digestB32: 'digestb32examplevalue0123456789abcdefghijklmnopqrstuvwxyz',
                },
            });
            // The route is adopted only after its pinned configuration exists — the activation
            // pipeline a proxy executor owns.
            void evidenceRoute.prepareConfiguration();
            context.runtime.activateEvidenceRoute(
                evidenceRoute as unknown as EvidenceRouteHost,
                [2],
            );
        });
        const runtime = await createUndecidedRuntime(
            { ...runtimeOptions(), issueAttachmentArtifactIds: [] },
            {
                createBaseRegistry: async () => emptyRegistry(),
                filteringExecutors: twoExecutorRegistry(
                    extensionShapedExecutor(() => {
                        throw new Error('adapter construction is not part of this test.');
                    }),
                    probe,
                ),
            },
        );
        await fetchRuntimeIssue(runtime);
        const selection = await runtime.registry.dispatch(
            'select_environment',
            selectionRequest(PREPARABLE_PROBE_NAME),
        );
        expect(selection).toMatchObject({ accepted: true, state: 'ready' });

        expect(evidenceRoute.prepareConfiguration).toHaveBeenCalledOnce();
        // The proxied evidence browser replaces the extension lifecycle for this environment.
        expect(toolNames(runtime)).toContain('launch_browser');

        // Whatever prerequisite the Host still wants, it must never be one this environment
        // cannot satisfy: a route-executed environment has no extension to prepare.
        const rejection = runtime.validateTerminalOutcome({
            outcome: 'analysis_only',
            reasoning: 'The reported overlay was inspected through the proxy.',
        });
        expect(rejection?.requiredAction).not.toBe('inspect_current_extension_full_page');
    });

    it('binds offline selector search to the reported browser hostname', async () => {
        const checkout = mkdtempSync(join(tmpdir(), 'agent-runtime-rule-search-'));
        try {
            mkdirSync(join(checkout, 'BaseFilter', 'sections'), { recursive: true });
            writeFileSync(
                join(checkout, 'BaseFilter', 'sections', 'foreign.txt'),
                ['unrelated.com##.banner', 'morizon.pl,prawo.pl,telepolis.pl##.banner', ''].join(
                    '\n',
                ),
            );
            const runtime = await createExtensionRuntime({
                ...runtimeOptions(),
                filtersPath: checkout,
                artifactsDir: checkout,
                issueAttachmentArtifactIds: [],
            });
            await fetchRuntimeIssue(runtime);

            const result = await runtime.registry.dispatch('search_rules', {
                selector: '.banner',
            });
            const matches = result.matches as Array<Record<string, unknown>>;

            expect(result.effectiveDomain).toBe('nettg.pl');
            expect(matches[0]).toMatchObject({
                rule: 'morizon.pl,prawo.pl,telepolis.pl##.banner',
                filePath: 'BaseFilter/sections/foreign.txt',
            });
        } finally {
            rmSync(checkout, { recursive: true, force: true });
        }
    });

    it('returns a draft naming a file the rule cannot go into, with the reason', async () => {
        const checkout = mkdtempSync(join(tmpdir(), 'agent-runtime-placement-'));
        try {
            mkdirSync(join(checkout, 'BaseFilter', 'sections'), { recursive: true });
            writeFileSync(
                join(checkout, 'BaseFilter', 'sections', 'foreign.txt'),
                ['first.example##.a', 'last.example##.z', ''].join('\n'),
            );
            const runtime = await AgentRuntime.create(
                { ...runtimeOptions(), filtersPath: checkout, issueAttachmentArtifactIds: [] },
                {
                    createBaseRegistry: async () => registryWithScreenshotAnalysis(),
                    ...verifiedPreparedVisionSeams(),
                },
            );
            await fetchRuntimeIssue(runtime);
            await boardCurrentPreparedVision(runtime);
            const draft = draftOutcome();
            const absentFile = 'BaseFilter/sections/specific.txt';

            expect(runtime.validateTerminalOutcome(placedIn(draft, absentFile))).toMatchObject({
                errorKind: 'candidate_placement_not_insertable',
                retryable: true,
                filePath: absentFile,
                error: expect.stringContaining(absentFile),
            });
            // The file the agent chose is the whole placement decision: once the rule can go
            // there, the judgement moves on to the evidence.
            expect(runtime.validateTerminalOutcome(draft)).toMatchObject({
                errorKind: 'candidate_visual_confirmation_required',
            });
        } finally {
            rmSync(checkout, { recursive: true, force: true });
        }
    });

    it('holds a draft to the file the run instruction declares for its kind', async () => {
        // The live run this guards named a cookie-notice list for an ad rule in a repository whose
        // instruction declares the current year's file.
        const checkout = mkdtempSync(join(tmpdir(), 'agent-runtime-declared-placement-'));
        const declaredFile = 'filters/filters-2026.txt';
        try {
            mkdirSync(join(checkout, 'filters'), { recursive: true });
            writeFileSync(join(checkout, declaredFile), '! Title: uBlock filters 2026\n');
            writeFileSync(
                join(checkout, 'filters', 'annoyances-cookies.txt'),
                '! Title: uBlock filters - Cookie notices\n',
            );
            const runtime = await AgentRuntime.create(
                {
                    ...runtimeOptions(),
                    filtersPath: checkout,
                    issueAttachmentArtifactIds: [],
                    declaredPlacement: {
                        byRuleType: {},
                        unqualified: { filePath: declaredFile, commentLine: `! ${rawIssue.url}` },
                    },
                },
                {
                    createBaseRegistry: async () => registryWithScreenshotAnalysis(),
                    ...verifiedPreparedVisionSeams(),
                },
            );
            await fetchRuntimeIssue(runtime);
            await boardCurrentPreparedVision(runtime);
            const draft = draftOutcome();

            expect(
                runtime.validateTerminalOutcome(placedIn(draft, 'filters/annoyances-cookies.txt')),
            ).toMatchObject({
                errorKind: 'candidate_placement_not_insertable',
                error: expect.stringContaining(declaredFile),
            });
            expect(runtime.validateTerminalOutcome(placedIn(draft, declaredFile))).toMatchObject({
                errorKind: 'candidate_visual_confirmation_required',
            });
        } finally {
            rmSync(checkout, { recursive: true, force: true });
        }
    });

    it('returns a draft scoped beyond the reported domain to the model', async () => {
        // The merged line of an extension plan: the existing rule's domains plus the reported one.
        // The candidate safety gate refuses it after the run has sealed; here the model can still
        // resubmit the rule for the reported domain alone.
        const runtime = await AgentRuntime.create(
            { ...runtimeOptions(), issueAttachmentArtifactIds: [] },
            {
                createBaseRegistry: async () => registryWithScreenshotAnalysis(),
                ...verifiedPreparedVisionSeams(),
            },
        );
        await fetchRuntimeIssue(runtime);
        await boardCurrentPreparedVision(runtime);

        expect(
            runtime.validateTerminalOutcome(
                draftOutcome('nettg.pl,another-site.example##.articleAdSlot'),
            ),
        ).toMatchObject({
            errorKind: 'candidate_scope_invalid',
            retryable: true,
            requiredTool: 'apply_rule',
            expectedTargetDomain: 'nettg.pl',
        });
    });

    it.each([
        {
            name: 'analysis-only',
            outcome: {
                outcome: 'analysis_only',
                reasoning: 'No safe candidate was found.',
            } satisfies FixOutcome,
        },
        {
            name: 'report-only',
            outcome: {
                outcome: 'resolve_without_patch',
                runStatus: 'not_reproduced',
                reasoning: 'The reporter symptom is absent.',
                evidenceSummary: 'No matching symptom was observed.',
            } satisfies FixOutcome,
        },
        {
            name: 'draft',
            outcome: draftOutcome(),
        },
    ])('requires an exact successful fetch_issue before $name completion', async ({ outcome }) => {
        const runtime = await createExtensionRuntime(
            { ...runtimeOptions(), issueAttachmentArtifactIds: [] },
            { createBaseRegistry: async () => emptyRegistry() },
        );

        expect(runtime.validateTerminalOutcome(outcome)).toMatchObject({
            errorKind: 'issue_fetch_required',
            retryable: true,
            requiredAction: 'fetch_issue',
            requiredTool: 'fetch_issue',
            issueNumber: rawIssue.number,
        });
        await expect(
            runtime.registry.dispatch('fetch_issue', { issueNumber: rawIssue.number + 1 }),
        ).resolves.toMatchObject({ errorKind: 'issue_mismatch' });
        expect(runtime.validateTerminalOutcome(outcome)).toMatchObject({
            errorKind: 'issue_fetch_required',
        });

        await fetchRuntimeIssue(runtime);

        expect(runtime.validateTerminalOutcome(outcome)).not.toMatchObject({
            errorKind: 'issue_fetch_required',
        });
    });

    it('exposes stable reporter screenshot indices without opaque artifact IDs', async () => {
        const runtime = await createExtensionRuntime(runtimeOptions(), {
            createBaseRegistry: async () => emptyRegistry(),
        });

        const result = await runtime.registry.dispatch('fetch_issue', {
            issueNumber: rawIssue.number,
        });

        expect(result).toMatchObject({
            issue: rawIssue,
            issueScreenshots: [{ issueScreenshotIndex: 1 }],
            // The run's executor set carries the one registration src/ owns; no closed
            // two-executor default is advertised any more.
            capabilities: expect.arrayContaining([
                expect.objectContaining({
                    kind: 'browser_extension',
                    availability: 'available',
                }),
            ]),
        });
        expect(result).not.toHaveProperty('facts');
        expect(JSON.stringify(result)).not.toContain('issue-screenshot-a');
    });

    it('resolves a reporter screenshot index before dispatching the vision tool', async () => {
        const analyzeScreenshot = vi.fn(async (args: Record<string, unknown>) => ({
            artifactId: args.artifactId,
            analysis: 'The reporter screenshot shows a large empty advertising slot.',
        }));
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'analyze_screenshot',
                    description: 'Analyze a registered screenshot',
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
            handler: analyzeScreenshot,
        });
        const runtime = await createExtensionRuntime(runtimeOptions(), {
            createBaseRegistry: async () => baseRegistry,
        });

        const definition = runtime.registry
            .getDefinitions()
            .find((item) => item.function.name === 'analyze_screenshot');
        expect(definition?.function.parameters).toMatchObject({
            properties: {
                issueScreenshotIndex: { type: 'number', minimum: 1, maximum: 1 },
            },
            required: ['prompt'],
        });
        await expect(
            runtime.registry.dispatch('analyze_screenshot', {
                issueScreenshotIndex: 1,
                prompt: 'Describe the reporter-visible defect.',
            }),
        ).resolves.toEqual({
            issueScreenshotIndex: 1,
            analysis: 'The reporter screenshot shows a large empty advertising slot.',
        });
        expect(analyzeScreenshot).toHaveBeenCalledWith({
            artifactId: 'issue-screenshot-a',
            prompt: 'Describe the reporter-visible defect.',
        });
    });

    it('reuses the first successful reporter screenshot observation within one run', async () => {
        const analyzeScreenshot = vi.fn(async (args: Record<string, unknown>) => ({
            artifactId: args.artifactId,
            model: 'vision-model',
            analysis: 'A red arrow identifies the yellow sponsored link as the reported target.',
        }));
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'analyze_screenshot',
                    description: 'Analyze a registered screenshot',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: analyzeScreenshot,
        });
        const runtime = await createExtensionRuntime(runtimeOptions(), {
            createBaseRegistry: async () => baseRegistry,
        });

        const first = await runtime.registry.dispatch('analyze_screenshot', {
            issueScreenshotIndex: 1,
            prompt: 'Identify annotations and the exact reporter-defined target.',
        });
        const repeated = await runtime.registry.dispatch('analyze_screenshot', {
            issueScreenshotIndex: 1,
            prompt: 'Inspect the same reporter screenshot again.',
        });

        expect(first).toEqual({
            issueScreenshotIndex: 1,
            model: 'vision-model',
            analysis: 'A red arrow identifies the yellow sponsored link as the reported target.',
        });
        expect(repeated).toEqual({ ...first, cached: true });
        expect(analyzeScreenshot).toHaveBeenCalledTimes(1);
    });

    it('returns bounded reporter screenshot references for an invalid index', async () => {
        const analyzeScreenshot = vi.fn(async () => ({ analysis: 'should not run' }));
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'analyze_screenshot',
                    description: 'Analyze a registered screenshot',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: analyzeScreenshot,
        });
        const runtime = await createExtensionRuntime(runtimeOptions(), {
            createBaseRegistry: async () => baseRegistry,
        });

        await expect(
            runtime.registry.dispatch('analyze_screenshot', {
                issueScreenshotIndex: 7,
                prompt: 'Describe the reporter-visible defect.',
            }),
        ).resolves.toEqual({
            error: 'Reporter screenshot index 7 is unavailable.',
            errorKind: 'issue_screenshot_index_out_of_range',
            retryable: true,
            availableIssueScreenshotIndices: [1],
        });
        expect(analyzeScreenshot).not.toHaveBeenCalled();
    });

    it('keeps a base tool registered from the first turn across a browser-session merge', async () => {
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'base_probe',
                    description: 'A base tool',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({
                decision: 'propose_close',
                reasons: ['the site shows its own advertising'],
            }),
        });
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'search_rules',
                    description: 'Repository facts',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ matches: [] }),
        });

        const runtime = await createUndecidedRuntime(runtimeOptions(), {
            createBaseRegistry: async () => baseRegistry,
            createBrowserSession: async () => ({ close: vi.fn() }) as unknown as BrowserSession,
            createBrowserRegistry: async () => baseRegistry,
        });
        expect(toolNames(runtime)).toContain('base_probe');
        const before = await runtime.registry.dispatch('base_probe', {
            firstPartyAd: true,
            paywall: false,
            antiAdblockWall: false,
            germanAntiAdblock: false,
            evidenceRefs: [],
            problemType: 'ads',
        });
        expect(before).toMatchObject({ decision: 'propose_close' });

        // A browser-session merge must not clobber the base registration with a per-session copy
        // (mergeBrowserTools skips every base tool name), so the same handler keeps serving.
        await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });
        expect(toolNames(runtime)).toContain('base_probe');
        const after = await runtime.registry.dispatch('base_probe', {
            firstPartyAd: true,
            paywall: false,
            antiAdblockWall: false,
            germanAntiAdblock: false,
            evidenceRefs: [],
            problemType: 'ads',
        });
        expect(after).toEqual(before);
    });

    it('bounds a browser tool that never returns instead of hanging the run', async () => {
        vi.useFakeTimers();
        try {
            const browserRegistry = emptyRegistry();
            browserRegistry.register({
                definition: {
                    type: 'function',
                    function: {
                        name: 'get_dom',
                        description: 'stub',
                        parameters: { type: 'object', properties: {} },
                    },
                },
                // A tool that never settles: the loop's between-turn budget cannot end this.
                handler: () => new Promise<Record<string, unknown>>(() => {}),
            });
            const runtime = await createExtensionRuntime(runtimeOptions(), {
                createBaseRegistry: async () => emptyRegistry(),
                createBrowserSession: async () => ({ close: vi.fn() }) as unknown as BrowserSession,
                createBrowserRegistry: async () => browserRegistry,
            });
            await runtime.registry.dispatch('launch_browser', {
                extension: 'none',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
            });

            const pending = runtime.registry.dispatch('get_dom', {});
            // The deadline aborts the call, then a bounded grace lets its cleanup settle.
            await vi.advanceTimersByTimeAsync(3 * 60_000 + 90_000 + 1_000);

            await expect(pending).resolves.toMatchObject({
                errorKind: 'tool_deadline_exceeded',
                retryable: true,
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('leaves a candidate retryable when apply_rule exceeds the tool deadline', async () => {
        vi.useFakeTimers();
        try {
            const baseRegistry = emptyRegistry();
            baseRegistry.register({
                definition: {
                    type: 'function',
                    function: {
                        name: 'lookup_rule_guidance',
                        description: 'Read pinned guidance',
                        parameters: { type: 'object', properties: {} },
                    },
                },
                handler: async () => ({ topic: 'element_hiding', citations: [] }),
            });
            baseRegistry.register({
                definition: {
                    type: 'function',
                    function: {
                        name: 'analyze_screenshot',
                        description: 'Analyze a registered screenshot',
                        parameters: { type: 'object', properties: {} },
                    },
                },
                handler: async () => ({ analysis: 'An advertising block is visible.' }),
            });
            const browserRegistry = emptyRegistry();
            let applyCalls = 0;
            browserRegistry.register({
                definition: {
                    type: 'function',
                    function: {
                        name: 'apply_rule',
                        description: 'Collect candidate browser and vision evidence',
                        parameters: { type: 'object', properties: {} },
                    },
                },
                // A validation that never settles: the deadline must fire without consuming the
                // candidate, because no verdict was ever produced.
                handler: () => {
                    applyCalls += 1;
                    return new Promise<Record<string, unknown>>(() => {});
                },
            });
            const runtime = await createExtensionRuntime(runtimeOptions(), {
                createBaseRegistry: async () => baseRegistry,
                createBrowserSession: async () => ({ close: vi.fn() }) as unknown as BrowserSession,
                createBrowserRegistry: async () => browserRegistry,
            });
            await runtime.registry.dispatch('launch_browser', {
                extension: 'none',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
            });
            await runtime.registry.dispatch('lookup_rule_guidance', {
                topic: 'element_hiding',
            });
            await runtime.registry.dispatch('analyze_screenshot', {
                issueScreenshotIndex: 1,
                prompt: 'Describe the reporter-visible defect.',
            });

            const first = runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl##.banner',
            });
            await vi.advanceTimersByTimeAsync(APPLY_RULE_TOOL_DEADLINE_MS + 90_000 + 1_000);
            await expect(first).resolves.toMatchObject({
                errorKind: 'tool_deadline_exceeded',
                retryable: true,
            });

            const second = runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl##.banner',
            });
            await vi.advanceTimersByTimeAsync(APPLY_RULE_TOOL_DEADLINE_MS + 90_000 + 1_000);
            await expect(second).resolves.toMatchObject({
                errorKind: 'tool_deadline_exceeded',
            });
            expect(applyCalls).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('ends free-form page evaluation on its budget and resets it for the next session', async () => {
        const evaluate = vi.fn(async () => ({ value: 'ok' }));
        const browserRegistry = emptyRegistry();
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'evaluate_js',
                    description: 'stub',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: evaluate,
        });
        const runtime = await createExtensionRuntime(runtimeOptions(), {
            createBaseRegistry: async () => emptyRegistry(),
            createBrowserSession: async () => ({ close: vi.fn() }) as unknown as BrowserSession,
            createBrowserRegistry: async () => browserRegistry,
        });
        const launch = async (): Promise<void> => {
            await runtime.registry.dispatch('launch_browser', {
                extension: 'none',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
            });
        };

        await launch();
        for (let call = 0; call < 25; call += 1) {
            await expect(runtime.registry.dispatch('evaluate_js', {})).resolves.toMatchObject({
                value: 'ok',
            });
        }
        await expect(runtime.registry.dispatch('evaluate_js', {})).resolves.toMatchObject({
            errorKind: 'evaluate_js_budget_exhausted',
            retryable: false,
        });
        expect(evaluate).toHaveBeenCalledTimes(25);

        // A materially different environment starts with its own budget.
        await launch();
        await expect(runtime.registry.dispatch('evaluate_js', {})).resolves.toMatchObject({
            value: 'ok',
        });
    });

    it('launches the host-prepared extension from turn one without a preparation tool', async () => {
        const createBrowserSession = vi.fn(async (_config: BrowserSessionConfig) =>
            fakePreparedSession(),
        );
        const browserRegistry = emptyRegistry();
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'open_page',
                    description: 'Open page',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ opened: true }),
        });
        const createBrowserRegistry = vi.fn(async () => browserRegistry);
        const runtime = await createExtensionRuntime(runtimeOptions(), {
            ...launchReadBackDependencies([2, 216]),
            createBaseRegistry: async () => emptyRegistry(),
            createBrowserSession,
            createBrowserRegistry,
        });

        // The prepared extension is a launch-time option: the browser lifecycle loads the build
        // from the first turn.
        expect(runtime.registry.getDefinitions().map((tool) => tool.function.name)).not.toContain(
            'open_page',
        );
        const launched = await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/article/123',
            profile: browserProfile,
            settings: {
                kind: 'agent_selected',
                filterIds: [2, 216],
                stealthEnabled: false,
            },
        });

        // The launch is the plain unpacked-extension route — the exact
        // prepared build with no host-applied settings profile.
        expect(createBrowserSession).toHaveBeenCalledWith(
            expect.objectContaining({
                headless: true,
                reproProfile: { ...browserProfile, userAgentProfile: 'Chromium' },
                adguardExtensionPath: preparedExtensionFixture().extensionPath,
                adguardExtensionManifestVersion: ExtensionManifestVersion.Mv3,
            }),
        );
        expect(createBrowserRegistry).toHaveBeenCalledWith(
            expect.objectContaining({ consentStrategy: 'untouched' }),
        );
        expect(launched).toMatchObject({
            launched: true,
            extensionSource: PreparedExtensionSource.PinnedRelease,
            extensionTag: 'v5.5.2.3',
            extensionSourceSha256: 'e'.repeat(64),
            settingsVerified: true,
        });
        expect(runtime.registry.getDefinitions().map((tool) => tool.function.name)).toContain(
            'open_page',
        );

        await runtime.registry.dispatch('close_browser', {});
        expect(runtime.registry.getDefinitions().map((tool) => tool.function.name)).not.toContain(
            'open_page',
        );
    });

    it('verifies a defaults_plus_required launch only on the union read-back', async () => {
        const preRead = readBackStateFixture([2, 3]);
        const afterApplication = readBackStateFixture([2, 3, 122]);
        let reads = 0;
        const surface = fakePreparedExtensionSurface();
        const runtime = await createExtensionRuntime(runtimeOptions(), {
            readAdGuardExtensionState: vi.fn(async () => {
                reads += 1;
                return reads === 1 ? preRead : afterApplication;
            }),
            findExtensionRuntime: vi.fn(async () => ({
                extensionId: 'test-extension-id',
                manifestVersion: ExtensionManifestVersion.Mv3,
            })),
            createBaseRegistry: async () => emptyRegistry(),
            createBrowserSession: async () =>
                ({
                    close: vi.fn(),
                    extensionContext: surface.context,
                }) as unknown as BrowserSession,
            createBrowserRegistry: async () => emptyRegistry(),
        });

        await fetchRuntimeIssue(runtime);
        const launched = await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: { kind: 'defaults_plus_required', requiredFilterIds: [122] },
        });

        // The expected set is the fresh-install defaults the pre-read observed plus the required
        // filter, so only a read-back carrying both verifies the launch.
        expect(launched).toMatchObject({ launched: true, settingsVerified: true });
        expect(reads).toBe(2);
        // The document the host imported carries the exact required filter set on top of the
        // fresh-install defaults the pre-read observed, plus that install's stealth state.
        const imported = surface.messages.find(
            (message) => message.type === AdGuardExtensionMessageType.ApplySettingsJson,
        );
        expect(String(imported?.data?.json)).toContain('"enabled-filters":[2,3,122]');
        expect(String(imported?.data?.json)).toContain('"stealth-disable-stealth-mode":true');
        await runtime.dispose();
    });

    it('leaves a defaults_plus_required launch unverified on a defaults-only read-back', async () => {
        const runtime = await createExtensionRuntime(runtimeOptions(), {
            ...launchReadBackDependencies([2, 3]),
            createBaseRegistry: async () => emptyRegistry(),
            createBrowserSession: async () => fakePreparedSession(),
            createBrowserRegistry: async () => emptyRegistry(),
        });

        await fetchRuntimeIssue(runtime);
        const launched = await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: { kind: 'defaults_plus_required', requiredFilterIds: [122] },
        });

        expect(launched).toMatchObject({ launched: true, settingsVerified: false });
        await runtime.dispose();
    });

    it('maps a live settings-apply failure at launch to retryable typed guidance', async () => {
        const createBrowserSession = vi.fn(async () => {
            throw new BrowserConfigurationError(
                'Failed to apply AdGuard settings: the extension rejected the payload.',
                new Error('the extension rejected the payload'),
            );
        });
        const runtime = await createExtensionRuntime(runtimeOptions(), {
            createBaseRegistry: async () => emptyRegistry(),
            createBrowserSession,
            createBrowserRegistry: async () => emptyRegistry(),
        });

        const result = await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });

        expect(result).toMatchObject({
            errorKind: 'extension_settings_failed',
            retryable: true,
            technicalFailure: { attempt: 1, exhausted: false },
        });
        await runtime.dispose();
    });

    it('discards a timed-out launch read-back and tools once its application session settles', async () => {
        vi.useFakeTimers();
        try {
            const { runtime, closeSession, runnerSignal, stateReads } =
                await abortingLaunchHarness();

            const pending = runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
                settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
            });
            await vi.advanceTimersByTimeAsync(BROWSER_LAUNCH_DEADLINE_MS + 1_000);

            await expect(pending).resolves.toMatchObject({
                errorKind: 'tool_deadline_exceeded',
                retryable: true,
            });
            // The deadline reached the session, and its late settle neither read the state back
            // again nor merged the session's tools nor stored a settings record for the model.
            expect(runnerSignal()?.aborted).toBe(true);
            expect(stateReads()).toBe(1);
            expect(closeSession).toHaveBeenCalledTimes(1);
            expect(toolNames(runtime)).not.toContain('open_page');
            expect(runtime.getLatestVerifiedSettingsEnvironment()).toBeUndefined();
            await runtime.dispose();
        } finally {
            vi.useRealTimers();
        }
    });

    it('seals a launch Baseline application unverified when the launch deadline aborts its session', async () => {
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        vi.useFakeTimers();
        try {
            const { runtime, runnerSignal } = await abortingLaunchHarness();

            const pending = runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
                settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
            });
            await vi.advanceTimersByTimeAsync(BROWSER_LAUNCH_DEADLINE_MS + 1_000);
            await expect(pending).resolves.toMatchObject({ errorKind: 'tool_deadline_exceeded' });
            expect(runnerSignal()?.aborted).toBe(true);

            vi.useRealTimers();
            await vi.waitFor(() => {
                const logged = stdout.mock.calls.map((call) => String(call[0])).join('');
                expect(logged).toContain(
                    'the launch Baseline application did not verify the prepared settings',
                );
                expect(logged).toContain('aborted before the blocker state read-back');
            });
            await runtime.dispose();
        } finally {
            vi.useRealTimers();
            stdout.mockRestore();
        }
    });

    it.each([
        {
            name: 'a missing rule-application section',
            content:
                '## Scope\n\nBlock the banner on the reported page with any supported rule kind.\n',
            gap: ApplicationInstructionGap.NoApplicationMethod,
            detailFragment: 'no rule-application section',
        },
        {
            name: 'an unknown read method',
            content: [
                '# The blocker',
                '',
                '## Rule application',
                '',
                'Perform the declared steps exactly, inventing none.',
                '',
                '## State verification',
                '',
                'read: telepathy ublock-user-filters.txt',
                '',
            ].join('\n'),
            gap: ApplicationInstructionGap.UnknownVerificationMethod,
            detailFragment: 'telepathy',
        },
    ])('returns a refused launch Baseline gap and detail for $name', async (scenario) => {
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const runtime = await createExtensionRuntime(
            {
                ...runtimeOptions(),
                issueAttachmentArtifactIds: [],
                instruction: {
                    path: 'issues/AGENTS.md',
                    content: scenario.content,
                    sha256: 'a'.repeat(64),
                    documents: [],
                },
            },
            {
                ...launchReadBackDependencies([2]),
                createBaseRegistry: async () => emptyRegistry(),
                createBrowserSession: async () => fakePreparedSession(),
                createBrowserRegistry: async () => emptyRegistry(),
            },
        );
        try {
            await fetchRuntimeIssue(runtime);
            const launched = await runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
                settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
            });

            // The refusal reaches the model as named fields beside settingsVerified: false ...
            expect(launched).toMatchObject({
                launched: true,
                settingsVerified: false,
                settingsGap: scenario.gap,
                settingsDetail: expect.stringContaining(scenario.detailFragment),
            });
            // ... and the run log keeps both the gap and the detail.
            await vi.waitFor(() => {
                const logged = stdout.mock.calls.map((call) => String(call[0])).join('');
                expect(logged).toContain(`"gap":"${scenario.gap}"`);
                expect(logged).toContain(scenario.detailFragment);
            });
        } finally {
            stdout.mockRestore();
            await runtime.dispose();
        }
    });

    it('keeps an Edge reporter on the default engine and records the fidelity limitation', async () => {
        // An Edge report's run drives the stealth Chromium engine, and the substituted browser
        // surfaces as the environment selection's browser-approximation fidelity limitation.
        const extensionRoot = mkdtempSync(join(tmpdir(), 'edge-reporter-extension-'));
        writeFileSync(
            join(extensionRoot, 'manifest.json'),
            JSON.stringify({ version: '5.5.2.3', manifest_version: 3 }),
        );
        const createBrowserSession = vi.fn(
            async () => ({ close: vi.fn() }) as unknown as BrowserSession,
        );
        const runtime = await createExtensionRuntime(
            {
                ...runtimeOptions(),
                issueFacts: { ...rawFacts, browser: 'Edge' },
                preparedExtension: preparedExtensionFixture(extensionRoot),
            },
            {
                createBaseRegistry: async () => emptyRegistry(),
                createBrowserSession,
                createBrowserRegistry: async () => emptyRegistry(),
            },
        );

        const result = await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });

        expect(result).toMatchObject({ launched: true });

        runtime.bindPreparedExtensionActualContextForResult();
        const selection = runtime.getEnvironmentSelection();
        expect(selection?.actual).toEqual({
            kind: 'browser_extension',
            product: 'AdGuard Browser Extension',
            browser: 'CloakBrowser Chromium',
            productVersion: '5.5.2.3',
        });
        expect(selection?.fidelityLimitations).toContainEqual(
            expect.objectContaining({ code: FidelityLimitationCode.BrowserApproximation }),
        );
        rmSync(extensionRoot, { recursive: true, force: true });
        await runtime.dispose();
    });

    it('keeps reporter sessions on CloakBrowser when the issue reporter used Chrome', async () => {
        const createBrowserSession = vi.fn(
            async () => ({ close: vi.fn() }) as unknown as BrowserSession,
        );
        const runtime = await createExtensionRuntime(
            {
                ...runtimeOptions(),
                issueFacts: { ...rawFacts, browser: 'Chrome 143' },
            },
            {
                createBaseRegistry: async () => emptyRegistry(),
                createBrowserSession,
                createBrowserRegistry: async () => emptyRegistry(),
            },
        );

        const result = await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });

        expect(result).toMatchObject({ launched: true });
        expect(createBrowserSession).toHaveBeenCalledWith(
            expect.objectContaining({
                engine: expect.objectContaining({ browserType: 'cloakbrowser' }),
            }),
        );
        await runtime.dispose();
    });

    it('binds the reported fragment even when the model echoes the bare document URL', async () => {
        const runtime = await createExtensionRuntime(
            {
                ...runtimeOptions(),
                allowedTargetUrls: ['https://mntest.seeks.cloud/#kr5qj'],
            },
            {
                createBaseRegistry: async () => emptyRegistry(),
                createBrowserSession: async () => ({ close: vi.fn() }) as unknown as BrowserSession,
                createBrowserRegistry: async () => emptyRegistry(),
            },
        );

        const result = await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://mntest.seeks.cloud/',
            profile: browserProfile,
        });

        expect(result).toMatchObject({
            launched: true,
            targetUrl: 'https://mntest.seeks.cloud/#kr5qj',
        });
        await runtime.dispose();
    });

    it('offers the rehearsal tool once a real browser session is open', async () => {
        const filtersPath = mkdtempSync(join(tmpdir(), 'agent-runtime-filters-'));
        const runtime = await createExtensionRuntime(
            { ...runtimeOptions(), filtersPath },
            {
                createBaseRegistry: async () => emptyRegistry(),
                createBrowserSession: async () => ({ close: vi.fn() }) as unknown as BrowserSession,
            },
        );

        expect(toolNames(runtime)).not.toContain('interact_page');
        const launched = await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });

        expect(launched).toMatchObject({ launched: true });
        expect(toolNames(runtime)).toContain('interact_page');
        await runtime.dispose();
        expect(toolNames(runtime)).not.toContain('interact_page');
        rmSync(filtersPath, { force: true, recursive: true });
    });

    it('stops funding interaction rehearsals once the session budget is spent', async () => {
        const rehearsal = { steps: [{ kind: 'click', selector: '#play' }] };
        const browserRegistry = new ToolRegistry();
        browserRegistry.register({
            definition: {
                type: 'function',
                function: { name: 'interact_page', description: 'stub', parameters: {} },
            },
            handler: async () => ({ status: 'completed' }),
        });
        const runtime = await createExtensionRuntime(runtimeOptions(), {
            createBaseRegistry: async () => emptyRegistry(),
            createBrowserSession: async () => ({ close: vi.fn() }) as unknown as BrowserSession,
            createBrowserRegistry: async () => browserRegistry,
        });
        await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });

        const results = [];
        for (let attempt = 0; attempt < 9; attempt += 1) {
            results.push(await runtime.registry.dispatch('interact_page', rehearsal));
        }

        expect(results.slice(0, 8).every((result) => result.status === 'completed')).toBe(true);
        expect(results[8]).toMatchObject({
            errorKind: 'interact_page_budget_exhausted',
            retryable: false,
        });
        await runtime.dispose();
    });

    it('refuses a bare echo whose document matches several reported fragments', async () => {
        const runtime = await createExtensionRuntime(
            {
                ...runtimeOptions(),
                allowedTargetUrls: [
                    'https://mntest.seeks.cloud/#kr5qj',
                    'https://mntest.seeks.cloud/#zx1aa',
                ],
            },
            {
                createBaseRegistry: async () => emptyRegistry(),
                createBrowserSession: async () => ({ close: vi.fn() }) as unknown as BrowserSession,
                createBrowserRegistry: async () => emptyRegistry(),
            },
        );

        const result = await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://mntest.seeks.cloud/',
            profile: browserProfile,
        });

        expect(result).toMatchObject({ errorKind: 'target_url_not_allowed' });
        await runtime.dispose();
    });

    /**
     * Build a runtime whose fake adapter drives real phase-session creation per an explicit plan.
     *
     * Each plan entry governs one apply_rule experiment: 'create_throw' opens the phase through the
     * runtime's createSession seam (whose createBrowserSession fake throws), mirroring the real
     * adapter's request shape with extensionRoot null for phase A; 'guard_limitation' returns the
     * adapter lifecycle-guard phase_open_failed without touching createSession.
     *
     * @param plan - Per-experiment adapter behavior.
     * @param phaseError - Error thrown by phase-session creation attempts.
     * @param phaseExtensionRoot - Extension root the fake adapter requests for non-A phases.
     * @returns Prepared runtime with an active analysis session, plus the session fake.
     */
    async function phaseBootstrapHarness(
        plan: Array<'create_throw' | 'guard_limitation'>,
        phaseError: () => Error,
        phaseExtensionRoot: string | null = null,
    ) {
        const filtersPath = mkdtempSync(join(tmpdir(), 'agent-runtime-phase-bootstrap-'));
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'lookup_rule_guidance',
                    description: 'Provide rule guidance.',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ topic: 'element_hiding' }),
        });
        let sessions = 0;
        const createBrowserSession = vi.fn(async (_config: BrowserSessionConfig) => {
            sessions += 1;
            if (sessions === 1) {
                return fakePreparedSession();
            }
            throw phaseError();
        });
        let environmentOptions: BrowserExtensionEnvironmentOptions | undefined;
        let experimentIndex = -1;
        const actualContext = {
            kind: 'browser_extension' as const,
            product: 'AdGuard Browser Extension',
            browser: 'CloakBrowser Chromium',
            productVersion: '5.4.3.99',
        };
        const adapterState = (): FilteringEnvironmentAdapterState => ({
            kind: 'browser_extension',
            lifecycle: 'ready',
            stateDigest: 'e'.repeat(64),
            actualContext,
            capabilities: ['browser_navigation', 'filtering_control'],
            preparation: {
                preparedAt: '2026-07-24T00:00:00.000Z',
                buildDigest: 'f'.repeat(64),
                extensionRootDigest: null,
            },
            baseline: null,
            openLeaseIds: [],
            cleanup: null,
        });
        const adapter: FilteringEnvironmentAdapter = {
            kind: 'browser_extension',
            capabilities: () => ['browser_navigation', 'filtering_control'],
            prepare: async () => ({ ready: true, state: adapterState() }),
            openPhase: async (request) => {
                if (request.phase === 'A') {
                    experimentIndex += 1;
                }
                const behavior = plan[experimentIndex] ?? 'create_throw';
                if (behavior === 'guard_limitation') {
                    return {
                        ready: false,
                        limitation: {
                            code: 'phase_open_failed',
                            stage: 'phase',
                            detail: 'The Extension environment is not ready for phase execution.',
                        },
                    };
                }
                try {
                    await environmentOptions!.createSession({
                        phase: request.phase,
                        targetUrl: request.targetUrl,
                        extensionRoot: request.phase === 'A' ? null : phaseExtensionRoot,
                    });
                } catch (error) {
                    return {
                        ready: false,
                        limitation: {
                            code: 'phase_open_failed',
                            stage: 'phase',
                            detail:
                                'The controlled browser session could not be established: ' +
                                (error as Error).message,
                        },
                    };
                }
                throw new Error('The phase session was expected to fail in this test.');
            },
            drainOpenHandles: async () => ({ attempted: 0, closed: 0, failed: 0, failures: [] }),
            cleanup: async () => ({
                attempted: true,
                completed: true,
                finalizerAttempts: 0,
                finalizerCompleted: 0,
                finalizerFailed: 0,
                failures: [],
            }),
            snapshot: adapterState,
        };
        const runtime = await createExtensionRuntime(
            { ...runtimeOptions(), filtersPath, issueAttachmentArtifactIds: [] },
            {
                ...launchReadBackDependencies(),
                createBaseRegistry: async () => baseRegistry,
                createBrowserSession,
                createBrowserRegistry: async () => {
                    const registry = emptyRegistry();
                    registry.register({
                        definition: {
                            type: 'function',
                            function: {
                                name: 'apply_rule',
                                description: 'Legacy candidate validation.',
                                parameters: { type: 'object', properties: {} },
                            },
                        },
                        handler: async () => ({ legacy: true }),
                    });
                    return registry;
                },
                filteringExecutors: hermeticExtensionRegistry((context) => {
                    // The adapter context is captured rather than a bare options record: the
                    // contract under test is what the runtime hands the executor.
                    environmentOptions = context.extensionOptions!;
                    return adapter;
                }),
            },
        );
        await fetchRuntimeIssue(runtime);
        await runtime.registry.dispatch('lookup_rule_guidance', {});
        await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
        });
        const cleanupFixture = () => rmSync(filtersPath, { recursive: true, force: true });
        return { runtime, createBrowserSession, cleanupFixture };
    }

    it('reports a bootstrap-dead phase session honestly as the capability that died', async () => {
        const { runtime, createBrowserSession, cleanupFixture } = await phaseBootstrapHarness(
            ['create_throw', 'create_throw'],
            () =>
                new BrowserLaunchError(
                    'Failed to launch cloakbrowser with AdGuard: browser process died.',
                    new Error('browser process died'),
                ),
        );
        try {
            expect(
                createBrowserSession.mock.calls[0]![0].extensionReadinessBudgetMs,
            ).toBeUndefined();

            const first = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl##.articleAdSlot',
            });

            expect(first).toMatchObject({
                validationSkipped: true,
                errorKind: 'environment_capability_limited',
                retryable: false,
                limitation: { code: 'phase_open_failed', stage: 'phase' },
            });
            // A dead browser process demotes the environment like any lifecycle limit, but the
            // infrastructure signature stays recorded for the run-result's typed failure.
            expect(runtime.getEnvironmentSelection()?.state).toBe('capability_limited');

            const second = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl##.articleAdSlot',
            });

            expect(second).toMatchObject({
                errorKind: 'environment_capability_limited',
                retryable: false,
            });
            expect(runtime.getEnvironmentSelection()?.state).toBe('capability_limited');
            // The demote supersedes the infrastructure record: the stale signature is cleared
            // instead of masking the typed capability verdict with an older cause.
            expect(runtime.getPhaseBootstrapInfrastructureFailure()).toBeUndefined();
        } finally {
            cleanupFixture();
        }
    });

    it('accepts a scriptlet candidate into the environment path without a kind refusal', async () => {
        const { runtime, cleanupFixture } = await phaseBootstrapHarness(
            ['create_throw'],
            () =>
                new BrowserLaunchError(
                    'Failed to launch cloakbrowser with AdGuard: browser process died.',
                    new Error('browser process died'),
                ),
        );
        try {
            const result = await runtime.registry.dispatch('apply_rule', {
                candidateRule: "nettg.pl#%#//scriptlet('prevent-window-open')",
            });

            // Reaching the phase bootstrap proves every candidate acceptance gate passed:
            // a kind-based refusal would return a candidate_shape error before any phase opened.
            expect(result).toMatchObject({
                validationSkipped: true,
                errorKind: 'environment_capability_limited',
            });
        } finally {
            cleanupFixture();
        }
    });

    it('still demotes to capability_limited when a phase settings failure is not infrastructure-shaped', async () => {
        const { runtime, cleanupFixture } = await phaseBootstrapHarness(
            ['create_throw'],
            () =>
                new BrowserConfigurationError(
                    'Failed to apply AdGuard settings: the build exceeded its filter limits.',
                    new Error('the build exceeded its filter limits'),
                    SettingsFailureReason.SettingsLimitsExceeded,
                ),
        );
        try {
            const result = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl##.articleAdSlot',
            });

            expect(result).toMatchObject({
                validationSkipped: true,
                errorKind: 'environment_capability_limited',
                retryable: false,
                limitation: { code: 'phase_open_failed', stage: 'phase' },
            });
            expect(runtime.getPhaseBootstrapInfrastructureFailure()).toBeUndefined();
            expect(runtime.getEnvironmentSelection()?.state).toBe('capability_limited');
        } finally {
            cleanupFixture();
        }
    });

    it('validates candidate operation shapes and refuses baseline mutation on the extension route', async () => {
        const { runtime, createBrowserSession, cleanupFixture } = await phaseBootstrapHarness(
            [],
            () => new Error('phase sessions must not be reached in this test'),
        );
        try {
            const phaseSessionsBefore = createBrowserSession.mock.calls.length;

            const editWithoutOriginal = await runtime.registry.dispatch('apply_rule', {
                candidateRule: '@@||cdn.example.net^$domain=nettg.pl',
                operation: 'edit',
            });
            expect(editWithoutOriginal).toMatchObject({
                errorKind: 'candidate_shape_invalid',
                retryable: true,
            });

            const addWithOriginal = await runtime.registry.dispatch('apply_rule', {
                candidateRule: '@@||cdn.example.net^$domain=nettg.pl',
                operation: 'add',
                originalRule: '||cdn.example.net^',
            });
            expect(addWithOriginal).toMatchObject({
                errorKind: 'candidate_shape_invalid',
                retryable: true,
            });

            const unknownOperation = await runtime.registry.dispatch('apply_rule', {
                candidateRule: '@@||cdn.example.net^$domain=nettg.pl',
                operation: 'replace',
            });
            expect(unknownOperation).toMatchObject({
                errorKind: 'candidate_shape_invalid',
                retryable: true,
            });

            const editOnExtensionRoute = await runtime.registry.dispatch('apply_rule', {
                candidateRule: '@@||cdn.example.net^$domain=nettg.pl',
                operation: 'edit',
                originalRule: '||cdn.example.net^',
            });
            expect(editOnExtensionRoute).toMatchObject({
                validationSkipped: true,
                errorKind: 'candidate_operation_unsupported',
                retryable: false,
            });
            // The refusal is typed guidance, not an experiment: no phase session was opened and
            // the environment lock stays ready for an added exception instead.
            expect(createBrowserSession.mock.calls.length).toBe(phaseSessionsBefore);
            expect(runtime.getEnvironmentSelection()?.state).toBe('ready');

            // Operation-capability refusals judge the request shape, not the candidate: three
            // more distinct refused mutations must not exhaust the three semantic attempt slots.
            for (const host of ['a', 'b', 'c']) {
                const refused = await runtime.registry.dispatch('apply_rule', {
                    candidateRule: `@@||${host}.example.net^$domain=nettg.pl`,
                    operation: 'edit',
                    originalRule: `||${host}.example.net^`,
                });
                expect(refused).toMatchObject({
                    errorKind: 'candidate_operation_unsupported',
                });
            }
            const afterRefusals = await runtime.registry.dispatch('apply_rule', {
                candidateRule: '@@||d.example.net^$domain=nettg.pl',
                operation: 'remove',
                originalRule: '||d.example.net^',
            });
            expect(afterRefusals).toMatchObject({
                errorKind: 'candidate_operation_unsupported',
                remainingCandidateAttempts: MAX_CANDIDATE_ATTEMPTS,
            });
            expect(afterRefusals).not.toMatchObject({
                errorKind: 'candidate_limit_reached',
            });
        } finally {
            cleanupFixture();
        }
    });

    it('does not let a stale bootstrap record soften a later lifecycle-guard failure', async () => {
        const { runtime, cleanupFixture } = await phaseBootstrapHarness(
            ['create_throw', 'guard_limitation'],
            () =>
                new BrowserLaunchError(
                    'Failed to launch cloakbrowser with AdGuard: browser process died.',
                    new Error('browser process died'),
                ),
        );
        try {
            const first = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl##.articleAdSlot',
            });
            expect(first).toMatchObject({
                errorKind: 'environment_capability_limited',
                retryable: false,
            });

            const second = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl##.articleAdSlot',
            });

            expect(second).toMatchObject({
                validationSkipped: true,
                errorKind: 'environment_capability_limited',
                retryable: false,
                limitation: { code: 'phase_open_failed', stage: 'phase' },
            });
            // The guard experiment never reached session bootstrap, so the stale record is
            // cleared instead of masking the genuine lifecycle verdict with an older cause.
            expect(runtime.getPhaseBootstrapInfrastructureFailure()).toBeUndefined();
            expect(runtime.getEnvironmentSelection()?.state).toBe('capability_limited');
        } finally {
            cleanupFixture();
        }
    });

    /**
     * Build a runtime whose fake adapter completes real phase A/B sessions through the
     * `observeEnvironmentPhase` seam, so an experiment can conclude `baseline_symptom_absent`
     * without the heavier `browserExtensionAdsObserverDependencies` vision fixture.
     *
     * @param observeEnvironmentPhase - Stubbed single-phase observer shared by every experiment.
     * @returns Prepared runtime with an active analysis session, plus a disposable filters path.
     */
    async function baselineSymptomAbsentHarness(
        observeEnvironmentPhase: (
            input: AdsEnvironmentPhaseObservationInput,
        ) => Promise<ValidatorPhaseCompletion>,
    ) {
        const filtersPath = mkdtempSync(join(tmpdir(), 'agent-runtime-baseline-absent-'));
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'lookup_rule_guidance',
                    description: 'Provide rule guidance.',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ topic: 'element_hiding' }),
        });
        const actualContext = {
            kind: 'browser_extension' as const,
            product: 'AdGuard Browser Extension',
            browser: 'CloakBrowser Chromium',
            productVersion: '5.4.3.99',
        };
        const baselineDigest = 'd'.repeat(64);
        const adapterState = (): FilteringEnvironmentAdapterState => ({
            kind: 'browser_extension',
            lifecycle: 'ready',
            stateDigest: 'e'.repeat(64),
            actualContext,
            capabilities: ['browser_navigation', 'filtering_control'],
            preparation: {
                preparedAt: '2026-07-24T00:00:00.000Z',
                buildDigest: 'f'.repeat(64),
                extensionRootDigest: null,
            },
            baseline: {
                environment: 'browser_extension',
                acquiredAt: '2026-07-24T00:00:00.000Z',
                enabledListKeys: ['adguard:2'],
                resources: [],
                aggregateDigest: baselineDigest,
            },
            openLeaseIds: [],
            cleanup: null,
        });
        // Only phases A and B are ever opened by this fixture: a baseline_symptom_absent verdict
        // stops the experiment before phase C, exactly as it did for the doomed tradingview.com
        // attempts.
        const adapter: FilteringEnvironmentAdapter = {
            kind: 'browser_extension',
            capabilities: () => ['browser_navigation', 'filtering_control'],
            prepare: async () => ({ ready: true, state: adapterState() }),
            openPhase: async (request) => {
                const sessionId = `${request.experimentId}-${request.phase}`;
                const filteringState =
                    request.phase === 'A' ? ('disabled' as const) : ('published_baseline' as const);
                return {
                    ready: true,
                    handle: {
                        session: {
                            artifactsDir: '/tmp/artifacts',
                            isClosed: false,
                            getPage: () => ({}) as never,
                            close: async () => undefined,
                            getNetworkLog: () => [],
                            resetNetworkLog: () => undefined,
                            getConsoleLog: () => [],
                            consoleCoverage: ConsoleCoverage.BrowserLogOnly,
                        } as IBrowserSession,
                        adapterProof: {
                            leaseId: sessionId,
                            adapterStateDigest: 'e'.repeat(64),
                            phase: request.phase,
                            filteringState,
                            sessionId,
                            actualContext,
                            baselineDigest: request.phase === 'A' ? null : baselineDigest,
                            candidateDigest: null,
                            extension:
                                request.phase === 'A'
                                    ? null
                                    : {
                                          packageVersion: '5.4.3.99',
                                          manifestVersion: '5.4.3.99',
                                          profileKind: 'agent_selected' as const,
                                          enabledListKeys: ['adguard:2'],
                                          activeRulesetListKeys: ['adguard:2'],
                                          stealthEnabled: false,
                                          userRulesDigest: null,
                                          application: {
                                              method: BlockerVerificationMethod.ExtensionState,
                                              appliedRules: [],
                                              actionLog: [],
                                          },
                                      },
                        },
                        close: async () => undefined,
                    },
                };
            },
            drainOpenHandles: async () => ({ attempted: 0, closed: 0, failed: 0, failures: [] }),
            cleanup: async () => ({
                attempted: true,
                completed: true,
                finalizerAttempts: 0,
                finalizerCompleted: 0,
                finalizerFailed: 0,
                failures: [],
            }),
            snapshot: adapterState,
        };
        const runtime = await createExtensionRuntime(
            { ...runtimeOptions(), filtersPath, issueAttachmentArtifactIds: [] },
            {
                ...launchReadBackDependencies(),
                createBaseRegistry: async () => baseRegistry,
                createBrowserSession: async () => fakePreparedSession(),
                createBrowserRegistry: async () => {
                    const registry = emptyRegistry();
                    registry.register({
                        definition: {
                            type: 'function',
                            function: {
                                name: 'apply_rule',
                                description: 'Legacy candidate validation.',
                                parameters: { type: 'object', properties: {} },
                            },
                        },
                        handler: async () => ({ legacy: true }),
                    });
                    return registry;
                },
                filteringExecutors: hermeticExtensionRegistry(() => adapter),
                observeEnvironmentPhase,
            },
        );
        await fetchRuntimeIssue(runtime);
        await runtime.registry.dispatch('lookup_rule_guidance', {});
        await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
        });
        const cleanupFixture = () => rmSync(filtersPath, { recursive: true, force: true });
        return { runtime, cleanupFixture };
    }

    it('refuses a third identical experiment after two baseline_symptom_absent verdicts', async () => {
        // Phase B is the controlled baseline: reporting no symptom there is exactly what
        // once stalled a tradingview.com run for three identical experiments in a row.
        const observeEnvironmentPhase = vi.fn(
            async (
                input: AdsEnvironmentPhaseObservationInput,
            ): Promise<ValidatorPhaseCompletion> => ({
                kind: 'observed',
                sessionId: input.proof.sessionId,
                targetUrl: 'https://nettg.pl/',
                targetObservation: { symptomPresent: input.phase !== 'B', pageUsable: true },
                navigationVerified: true,
                artifacts: [],
                vision: null,
                candidateValidation: null,
                rejectedCandidates: [],
            }),
        );
        const { runtime, cleanupFixture } =
            await baselineSymptomAbsentHarness(observeEnvironmentPhase);
        try {
            const candidateRule = 'nettg.pl##.symptom-that-never-differs';

            const first = await runtime.registry.dispatch('apply_rule', { candidateRule });
            expect(first).toMatchObject({
                errorKind: 'baseline_symptom_absent',
                retryable: true,
            });

            const second = await runtime.registry.dispatch('apply_rule', { candidateRule });
            expect(second).toMatchObject({
                errorKind: 'baseline_symptom_absent',
                retryable: false,
                requiredAction: 'finish_fix_analysis_only',
            });

            const callsAfterTwoExperiments = observeEnvironmentPhase.mock.calls.length;
            // One phase A plus one phase B call per experiment, twice.
            expect(callsAfterTwoExperiments).toBe(4);

            const third = await runtime.registry.dispatch('apply_rule', { candidateRule });
            expect(third).toMatchObject({
                validationSkipped: true,
                errorKind: 'baseline_symptom_absent_exhausted',
                retryable: false,
                requiredAction: 'finish_fix_analysis_only',
            });
            // The hard stop refuses before any phase can open: no new observation call.
            expect(observeEnvironmentPhase.mock.calls.length).toBe(callsAfterTwoExperiments);

            const differentCandidate = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl##.a-genuinely-different-selector',
            });
            expect(differentCandidate).toMatchObject({ errorKind: 'baseline_symptom_absent' });
            // A distinct candidate rule keys separately and still opens its own experiment.
            expect(observeEnvironmentPhase.mock.calls.length).toBeGreaterThan(
                callsAfterTwoExperiments,
            );
        } finally {
            cleanupFixture();
        }
    });

    it('answers a repeated apply_rule after an environment failure as that failure, unrun', async () => {
        // money.pl: the baseline phase failed its observation, and the second identical call got
        // the same sticky limitation without any phase running, in an answer that read as a fresh
        // failure — so the agent spent a turn retrying.
        const observeEnvironmentPhase = vi.fn(
            async (
                input: AdsEnvironmentPhaseObservationInput,
            ): Promise<ValidatorPhaseCompletion> => {
                if (input.phase === 'B') {
                    throw new Error('the baseline capture could not be inspected');
                }
                return {
                    kind: 'observed',
                    sessionId: input.proof.sessionId,
                    targetUrl: 'https://nettg.pl/',
                    targetObservation: { symptomPresent: true, pageUsable: true },
                    navigationVerified: true,
                    artifacts: [],
                    vision: null,
                    candidateValidation: null,
                    rejectedCandidates: [],
                };
            },
        );
        const { runtime, cleanupFixture } =
            await baselineSymptomAbsentHarness(observeEnvironmentPhase);
        try {
            const candidateRule = 'nettg.pl##.money-ecommerce-container';

            const first = await runtime.registry.dispatch('apply_rule', { candidateRule });
            expect(first).toMatchObject({
                errorKind: 'environment_capability_limited',
                retryable: false,
                limitation: { code: 'phase_proof_unavailable' },
            });
            expect(first).not.toHaveProperty('repeatedFailure');
            const observedPhases = observeEnvironmentPhase.mock.calls.length;

            const second = await runtime.registry.dispatch('apply_rule', { candidateRule });

            expect(second).toMatchObject({
                errorKind: 'environment_capability_limited',
                retryable: false,
                repeatedFailure: true,
                limitation: (first as { limitation: unknown }).limitation,
            });
            expect(observeEnvironmentPhase.mock.calls.length).toBe(observedPhases);
        } finally {
            cleanupFixture();
        }
    });

    it('validates the exact rule text the model proposed, not its normalized form', async () => {
        // The experiment once applied the normalized rule, which sorts a
        // network rule's modifiers, so its review bound a hash the verdict never recomputes from
        // the proposed rule and the verified candidate was refused.
        const observeEnvironmentPhase = vi.fn(
            async (
                input: AdsEnvironmentPhaseObservationInput,
            ): Promise<ValidatorPhaseCompletion> => ({
                kind: 'observed',
                sessionId: input.proof.sessionId,
                targetUrl: 'https://nettg.pl/',
                targetObservation: { symptomPresent: input.phase !== 'B', pageUsable: true },
                navigationVerified: true,
                artifacts: [],
                vision: null,
                candidateValidation: null,
                rejectedCandidates: [],
            }),
        );
        const { runtime, cleanupFixture } =
            await baselineSymptomAbsentHarness(observeEnvironmentPhase);
        try {
            const candidateRule = '||ads.example^$script,domain=nettg.pl';
            const canonicalRule = normalizeRule(candidateRule).canonical;
            expect(canonicalRule).not.toBe(candidateRule);
            const exactDigest = createHash('sha256').update(candidateRule).digest('hex');
            const canonicalDigest = createHash('sha256').update(canonicalRule).digest('hex');

            await runtime.registry.dispatch('apply_rule', { candidateRule });

            const sessionIds = observeEnvironmentPhase.mock.calls.map(
                ([input]) => input.proof.sessionId,
            );
            expect(sessionIds.length).toBeGreaterThan(0);
            for (const sessionId of sessionIds) {
                expect(sessionId).toContain(exactDigest.slice(0, 12));
                expect(sessionId).not.toContain(canonicalDigest.slice(0, 12));
            }
        } finally {
            cleanupFixture();
        }
    });

    it('does not let reporter-extension full vision replace current-first terminal evidence', async () => {
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'analyze_screenshot',
                    description: 'Inspect one screenshot.',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async (args) => ({
                artifactId: args.artifactId,
                analysis: `Inspected ${String(args.artifactId)}.`,
            }),
        });
        let launchIndex = 0;
        const runtime = await createExtensionRuntime(
            {
                ...runtimeOptions(),
                issueAttachmentArtifactIds: [],
            },
            {
                // The read-back state carries filter 2 only: the [122] settings request can never
                // verify against it, so that launch stays an unverified environment.
                ...launchReadBackDependencies([2]),
                createBaseRegistry: async () => baseRegistry,
                createBrowserSession: async () => fakePreparedSession(),
                createBrowserRegistry: async () =>
                    completePageRegistry(launchIndex++ === 0 ? 'reported' : 'current'),
            },
        );
        await fetchRuntimeIssue(runtime);
        await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: { kind: 'agent_selected', filterIds: [122], stealthEnabled: false },
        });
        await captureCompletePage(runtime, 'reported');

        expect(runtime.getPreparedExtension()).toMatchObject({
            source: PreparedExtensionSource.PinnedRelease,
            manifestVersion: ExtensionManifestVersion.Mv3,
            extensionSourceTag: 'v5.5.2.3',
        });
        expect(runtime.getLatestCompleteVisionEnvironment()).toBeUndefined();
        expect(runtime.getLatestVerifiedSettingsEnvironment()).toBeUndefined();

        const terminalOutcomes: FixOutcome[] = [
            {
                outcome: 'analysis_only',
                reasoning: 'No safe candidate was found.',
            },
            {
                outcome: 'resolve_without_patch',
                runStatus: 'not_reproduced',
                reasoning: 'The symptom was not reproduced.',
                evidenceSummary: 'Reporter-version evidence only.',
            },
            {
                outcome: 'resolve_without_patch',
                runStatus: 'already_fixed_current',
                reasoning: 'Current filtering removed the symptom.',
                evidenceSummary: 'Reporter-version evidence only.',
            },
            {
                outcome: 'resolve_without_patch',
                runStatus: 'fixed_upstream_pending_extension',
                reasoning: 'The fix is pending an extension update.',
                evidenceSummary: 'Reporter-version evidence only.',
            },
            {
                outcome: 'resolve_without_patch',
                runStatus: 'configuration_specific',
                reasoning: 'The symptom depends on reporter configuration.',
                evidenceSummary: 'Reporter-version evidence only.',
            },
        ];
        for (const outcome of terminalOutcomes) {
            expect(runtime.validateTerminalOutcome(outcome)).toMatchObject({
                errorKind: 'current_extension_full_vision_required',
                requiredAction: 'inspect_current_extension_full_page',
                currentVisionRequirement: expect.objectContaining({
                    environment: 'current_prepared_extension',
                    status: 'missing',
                }),
            });
        }

        await runtime.registry.dispatch('close_browser', {});
        await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
        });
        await captureCompletePage(runtime, 'current');

        expect(runtime.validateTerminalOutcome(terminalOutcomes[0]!)).toBeUndefined();
        expect(runtime.getLatestCompleteVisionEnvironment()).toMatchObject({
            extension: {
                source: PreparedExtensionSource.PinnedRelease,
                manifestVersion: ExtensionManifestVersion.Mv3,
                extensionSourceTag: 'v5.5.2.3',
            },
        });
        expect(runtime.getPreparedExtension()).toMatchObject({
            source: PreparedExtensionSource.PinnedRelease,
            manifestVersion: ExtensionManifestVersion.Mv3,
            extensionSourceTag: 'v5.5.2.3',
        });
    });

    it('requires exact reporter settings on current extension when the issue has an import URL', async () => {
        const issue = {
            ...rawIssue,
            body:
                `${rawIssue.body}\n\n### Issue configuration\n[Import](` +
                `${reporterImportUrl.replaceAll('&', '&amp;')})`,
        };
        const options = {
            ...runtimeOptions(),
            issue,
            issueAttachmentArtifactIds: [],
        };
        const result = verifiedCandidateToolResult(options.recorder);
        const baseRegistry = emptyRegistry();
        for (const name of ['analyze_screenshot', 'lookup_rule_guidance']) {
            baseRegistry.register({
                definition: {
                    type: 'function',
                    function: {
                        name,
                        description: `Provide ${name}.`,
                        parameters: { type: 'object', properties: {} },
                    },
                },
                handler: async (args) => {
                    if (name === 'analyze_screenshot') {
                        return {
                            artifactId: args.artifactId,
                            analysis: `Inspected ${String(args.artifactId)}.`,
                        };
                    }
                    return { topic: 'element_hiding' };
                },
            });
        }
        let launchIndex = 0;
        // Launch order: defaults_plus_required, then the semantically equivalent reporter import
        // (filters=2,10). A reported_on_current launch with an edited import is refused before
        // any browser starts. The host read-back verifies each launch against its own filter set.
        const { findExtensionRuntime, createPhaseApplicationModelRunner } =
            launchReadBackDependencies();
        const runtime = await createExtensionRuntime(options, {
            findExtensionRuntime,
            createPhaseApplicationModelRunner,
            readAdGuardExtensionState: vi.fn(async () =>
                readBackStateFixture(launchIndex === 2 ? [2, 10] : [2]),
            ),
            createBaseRegistry: async () => baseRegistry,
            createBrowserSession: vi.fn(async () => {
                launchIndex += 1;
                return fakePreparedSession();
            }),
            createBrowserRegistry: async () =>
                completePageRegistry(launchIndex === 1 ? 'controlled' : 'reporter', result),
        });
        await fetchRuntimeIssue(runtime);
        await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: {
                kind: 'defaults_plus_required',
                requiredFilterIds: [2],
                reporterImportUrl,
            },
        });
        await captureCompletePage(runtime, 'controlled');
        await runtime.registry.dispatch('lookup_rule_guidance', { topic: 'element_hiding' });
        await runtime.registry.dispatch('apply_rule', {
            candidateRule: 'nettg.pl##.articleAdSlot',
        });

        for (const outcome of [
            { outcome: 'analysis_only', reasoning: 'No safer rule exists.' } as const,
            draftOutcome(),
        ]) {
            expect(runtime.validateTerminalOutcome(outcome)).toMatchObject({
                errorKind: 'current_reporter_settings_required',
                requiredAction: 'launch_current_extension_with_reported_on_current',
                actualProfileKinds: ['defaults_plus_required'],
                retryable: true,
            });
        }

        await runtime.registry.dispatch('close_browser', {});
        const differentReporterImportUrl = reporterImportUrl.replace(
            'regular_filters=2%2C10',
            'regular_filters=2',
        );
        // AdguardFilters#242716: the model dropped two filter IDs from the reporter import in
        // every launch, and learned it only from finish_fix, which named no difference.
        expect(
            await runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
                settings: {
                    kind: 'reported_on_current',
                    importUrl: differentReporterImportUrl,
                },
            }),
        ).toMatchObject({
            errorKind: 'reporter_import_url_mismatch',
            reporterImportUrl,
            differences: [{ parameter: 'regular_filters', reporter: '2,10', requested: '2' }],
        });
        const semanticallyEquivalentReporterImportUrl = reporterImportUrl.replace(
            'regular_filters=2%2C10',
            'regular_filters=2,10',
        );
        await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: {
                kind: 'reported_on_current',
                importUrl: semanticallyEquivalentReporterImportUrl,
            },
        });
        // Once the reporter settings match, an unfinished capture must be named as the capture:
        // telling the model its settings are wrong here sent live runs into a relaunch loop.
        await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' });
        expect(runtime.validateTerminalOutcome(draftOutcome())).toMatchObject({
            errorKind: 'current_extension_full_vision_required',
            currentVisionRequirement: {
                status: 'incomplete',
                selectedSettingsProfileKind: 'reported_on_current',
                nextAction: 'capture_complete_page',
            },
            guidance: expect.arrayContaining([expect.stringContaining('Do not relaunch')]),
        });
        await captureCompletePage(runtime, 'reporter');
        await runtime.registry.dispatch('apply_rule', {
            candidateRule: 'nettg.pl##.articleAdSlot',
        });

        expect(runtime.validateTerminalOutcome(draftOutcome())).toBeUndefined();
        expect(runtime.getVerifiedCandidateBinding(result.validationArtifactId)).toMatchObject({
            environment: {
                selectedSettingsProfileKind: 'reported_on_current',
                extensionBaselineReadBack: { optionsEnabledFilterIds: [2, 10] },
                extension: {
                    source: PreparedExtensionSource.PinnedRelease,
                    manifestVersion: ExtensionManifestVersion.Mv3,
                    extensionSourceTag: 'v5.5.2.3',
                },
            },
        });
    });

    it('asks to relaunch the reporter profile once the comparison launch closed its unfinished session', async () => {
        const options = {
            ...runtimeOptions(),
            issue: {
                ...rawIssue,
                body: `${rawIssue.body}\n\n### Issue configuration\n[Import](${reporterImportUrl})`,
            },
            issueAttachmentArtifactIds: [],
        };
        const reporterSettings = { kind: 'reported_on_current', importUrl: reporterImportUrl };
        // The reporter profile, the controlled comparison the fix task asks for, then the reporter
        // profile again; the host read-back proves each launch's own filter set.
        const launchedProfiles: string[] = [];
        const runtime = await createExtensionRuntime(options, {
            ...launchReadBackDependencies(),
            readAdGuardExtensionState: vi.fn(async () =>
                readBackStateFixture(launchedProfiles.at(-1) === 'reporter' ? [2, 10] : [2]),
            ),
            createBaseRegistry: async () => registryWithScreenshotAnalysis(),
            createBrowserSession: async () => fakePreparedSession(),
            createBrowserRegistry: async () => completePageRegistry(launchedProfiles.at(-1)!),
        });
        const launch = async (profile: string, settings: Record<string, unknown>) => {
            launchedProfiles.push(profile);
            return await runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
                settings,
            });
        };
        const outcome: FixOutcome = {
            outcome: 'analysis_only',
            reasoning: 'The existing rules do not remove the symptom.',
        };
        await fetchRuntimeIssue(runtime);
        expect(await launch('reporter', reporterSettings)).toMatchObject({ launched: true });
        await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' });
        expect(
            await launch('controlled', {
                kind: 'defaults_plus_required',
                requiredFilterIds: [2],
                reporterImportUrl,
            }),
        ).toMatchObject({ launched: true });
        await captureCompletePage(runtime, 'controlled');

        // The comparison launch closed the reporter session: nothing can capture its page any
        // more, so the requirement must ask for that environment again, not for a capture there.
        expect(runtime.validateTerminalOutcome(outcome)).toMatchObject({
            errorKind: 'current_extension_full_vision_required',
            currentVisionRequirement: {
                sessionOrdinal: 1,
                selectedSettingsProfileKind: 'reported_on_current',
                nextAction: 'relaunch_closed_session',
            },
        });

        expect(await launch('reporter', reporterSettings)).toMatchObject({ launched: true });
        await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' });
        expect(runtime.validateTerminalOutcome(outcome)).toMatchObject({
            currentVisionRequirement: {
                sessionOrdinal: 3,
                selectedSettingsProfileKind: 'reported_on_current',
                nextAction: 'capture_complete_page',
            },
        });
        await captureCompletePage(runtime, 'reporter');
        expect(runtime.validateTerminalOutcome(outcome)).toBeUndefined();
    });

    it('asks for a fresh reporter launch once the relaunched reporter environment failed navigation', async () => {
        const options = {
            ...runtimeOptions(),
            issue: {
                ...rawIssue,
                body: `${rawIssue.body}\n\n### Issue configuration\n[Import](${reporterImportUrl})`,
            },
            issueAttachmentArtifactIds: [],
        };
        const reporterSettings = { kind: 'reported_on_current', importUrl: reporterImportUrl };
        const launchedProfiles: string[] = [];
        let registries = 0;
        const runtime = await createExtensionRuntime(options, {
            ...launchReadBackDependencies(),
            readAdGuardExtensionState: vi.fn(async () =>
                readBackStateFixture(launchedProfiles.at(-1) === 'reporter' ? [2, 10] : [2]),
            ),
            createBaseRegistry: async () => registryWithScreenshotAnalysis(),
            createBrowserSession: async () => fakePreparedSession(),
            createBrowserRegistry: async () => {
                registries += 1;
                if (registries !== 3) {
                    return completePageRegistry(launchedProfiles.at(-1)!);
                }
                // The relaunched reporter session never reaches the page.
                const registry = emptyRegistry();
                registry.register({
                    definition: {
                        type: 'function',
                        function: {
                            name: 'open_page',
                            description: 'Open page',
                            parameters: { type: 'object', properties: {} },
                        },
                    },
                    handler: async () => ({
                        error: 'Timeout 15000ms exceeded',
                        fallbackReason: 'navigation_timeout',
                    }),
                });
                return registry;
            },
        });
        const launch = async (
            profile: string,
            settings: Record<string, unknown>,
            reproProfile: Record<string, unknown> = browserProfile,
        ) => {
            launchedProfiles.push(profile);
            return await runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://nettg.pl/',
                profile: reproProfile,
                settings,
            });
        };
        const outcome: FixOutcome = {
            outcome: 'analysis_only',
            reasoning: 'The existing rules do not remove the symptom.',
        };
        await fetchRuntimeIssue(runtime);
        await launch('reporter', reporterSettings);
        await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' });
        await launch('controlled', {
            kind: 'defaults_plus_required',
            requiredFilterIds: [2],
            reporterImportUrl,
        });
        await captureCompletePage(runtime, 'controlled');
        expect(runtime.validateTerminalOutcome(outcome)).toMatchObject({
            currentVisionRequirement: { sessionOrdinal: 1, nextAction: 'relaunch_closed_session' },
        });
        await launch('reporter', reporterSettings);
        expect(
            await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' }),
        ).toMatchObject({ requiredAction: 'close_browser_then_launch_materially_different' });
        // Still active but retired: the failure took its page tools, so the requirement must not
        // ask for open_page in it.
        expect(runtime.validateTerminalOutcome(outcome)).toMatchObject({
            currentVisionRequirement: {
                status: 'missing',
                nextAction: 'launch_browser_and_open_page',
            },
        });
        await runtime.registry.dispatch('close_browser', {});

        // The reporter environment failed navigation, so launch_browser refuses it: neither the
        // failed session nor the earlier closed one in the same environment may be named for a
        // relaunch. The requirement asks for a fresh reporter launch instead.
        expect(runtime.validateTerminalOutcome(outcome)).toMatchObject({
            errorKind: 'current_extension_full_vision_required',
            currentVisionRequirement: {
                status: 'missing',
                nextAction: 'launch_browser_and_open_page',
            },
        });
        expect(await launch('reporter', reporterSettings)).toMatchObject({
            errorKind: 'failed_browser_environment_reused',
        });
        expect(
            await launch('reporter', reporterSettings, { ...browserProfile, locale: 'pl-PL' }),
        ).toMatchObject({ launched: true });
        await captureCompletePage(runtime, 'reporter');
        expect(runtime.validateTerminalOutcome(outcome)).toBeUndefined();
    });

    it('keeps the batch inspection for the active session retired after a later navigation failure', async () => {
        let opened = 0;
        const registry = completePageRegistry('current');
        registry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'open_page',
                    description: 'Open page',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async (args) =>
                ++opened === 1
                    ? { url: args.url, statusCode: 200 }
                    : { error: 'Timeout 15000ms exceeded', fallbackReason: 'navigation_timeout' },
        });
        const runtime = await createExtensionRuntime(
            { ...runtimeOptions(), issueAttachmentArtifactIds: [] },
            {
                ...launchReadBackDependencies(),
                createBaseRegistry: async () => registryWithScreenshotAnalysis(),
                createBrowserSession: async () => fakePreparedSession(),
                createBrowserRegistry: async () => registry,
            },
        );
        await fetchRuntimeIssue(runtime);
        await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
        });
        await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' });
        await runtime.registry.dispatch('screenshot', { captureTiles: true });
        expect(
            await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' }),
        ).toMatchObject({ requiredAction: 'close_browser_then_launch_materially_different' });

        // The failure retired the page tools, not the capture: inspect_full_page_capture still
        // covers it in one call instead of one analyze_screenshot per tile.
        expect(
            runtime.validateTerminalOutcome({
                outcome: 'analysis_only',
                reasoning: 'The existing rules do not remove the symptom.',
            }),
        ).toMatchObject({
            currentVisionRequirement: {
                sessionOrdinal: 1,
                nextAction: 'inspect_full_page_capture',
            },
        });
    });

    it('asks to relaunch the unfiltered control once the prepared launch closed it uncaptured', async () => {
        let launches = 0;
        const runtime = await createExtensionRuntime(
            { ...runtimeOptions(), issueAttachmentArtifactIds: [] },
            {
                ...launchReadBackDependencies(),
                createBaseRegistry: async () => registryWithScreenshotAnalysis(),
                createBrowserSession: async () => fakePreparedSession(),
                createBrowserRegistry: async () => completePageRegistry(`launch-${++launches}`),
            },
        );
        const launchControl = async () =>
            await runtime.registry.dispatch('launch_browser', {
                extension: 'none',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
            });
        const alreadyFixed: FixOutcome = {
            outcome: 'resolve_without_patch',
            runStatus: 'already_fixed_current',
            reasoning: 'The reporter symptom is visible without filtering and absent with it.',
            evidenceSummary: 'Unfiltered control and prepared-extension comparison.',
        };
        await fetchRuntimeIssue(runtime);
        await launchControl();
        await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' });
        await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
        });
        await captureCompletePage(runtime, 'launch-2');

        // The prepared launch closed the control before its capture: the rejection must offer
        // the launch that brings the control back, not only tools that act in a live session.
        expect(runtime.validateTerminalOutcome(alreadyFixed)).toMatchObject({
            errorKind: 'report_only_full_vision_required',
            requiredTools: expect.arrayContaining(['launch_browser']),
            visionRequirements: expect.arrayContaining([
                expect.objectContaining({
                    environment: 'unfiltered_control',
                    sessionOrdinal: 1,
                    nextAction: 'relaunch_closed_session',
                }),
            ]),
        });

        expect(await launchControl()).toMatchObject({ launched: true });
        await captureCompletePage(runtime, 'launch-3');
        // Both sessions now carry complete vision; what remains is the symptom classification.
        expect(runtime.validateTerminalOutcome(alreadyFixed)).toMatchObject({
            errorKind: 'report_only_status_evidence_mismatch',
        });
    });

    it('keeps controlled current settings terminal-eligible when no import URL exists', async () => {
        const options = {
            ...runtimeOptions(),
            issueAttachmentArtifactIds: [],
        };
        const result = verifiedCandidateToolResult(options.recorder);
        const baseRegistry = emptyRegistry();
        for (const name of ['analyze_screenshot', 'lookup_rule_guidance']) {
            baseRegistry.register({
                definition: {
                    type: 'function',
                    function: {
                        name,
                        description: `Provide ${name}.`,
                        parameters: { type: 'object', properties: {} },
                    },
                },
                handler: async (args) => {
                    if (name === 'analyze_screenshot') {
                        return {
                            artifactId: args.artifactId,
                            analysis: `Inspected ${String(args.artifactId)}.`,
                        };
                    }
                    return { topic: 'element_hiding' };
                },
            });
        }
        const runtime = await createExtensionRuntime(options, {
            ...launchReadBackDependencies(),
            createBaseRegistry: async () => baseRegistry,
            createBrowserSession: async () => fakePreparedSession(),
            createBrowserRegistry: async () => completePageRegistry('controlled', result),
        });
        await fetchRuntimeIssue(runtime);
        await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: {
                kind: 'defaults_plus_required',
                requiredFilterIds: [2],
            },
        });
        await captureCompletePage(runtime, 'controlled');
        await runtime.registry.dispatch('lookup_rule_guidance', { topic: 'element_hiding' });
        await runtime.registry.dispatch('apply_rule', {
            candidateRule: 'nettg.pl##.articleAdSlot',
        });

        expect(runtime.validateTerminalOutcome(draftOutcome())).toBeUndefined();
    });

    // AdguardFilters#242720: the reporter's import URL enabled 52 filters, Chrome allows 50
    // static rulesets, so the reported_on_current launch could never verify and every finish_fix
    // was rejected until the run sealed. The contract: a reported_on_current launch with the
    // reporter's own URL whose read-back reports the MV3 limits exceeded answers with the typed
    // limitation and its guidance, and from then on a verified controlled session with complete
    // page vision carries the terminal decision. A read-back that merely mismatches proves
    // nothing about the limits and keeps reporter parity required.
    it('waives reporter parity once the reporter filter set is proven to exceed the MV3 limits', async () => {
        const runFlow = async (limitsExceeded: boolean) => {
            // A loadable manifest, so the run can bind the prepared build's actual context and
            // the snapshot exposes the fidelity limitations; the catalog carries both reporter
            // filters, so nothing else degrades the requested set.
            const root = mkdtempSync(join(tmpdir(), 'agent-runtime-mv3-limits-'));
            const options = {
                ...runtimeOptions(),
                preparedExtension: preparedExtensionWithBundledCatalog([2, 10], root),
                issue: {
                    ...rawIssue,
                    body:
                        `${rawIssue.body}\n\n### Issue configuration\n[Import](` +
                        `${reporterImportUrl.replaceAll('&', '&amp;')})`,
                },
                issueAttachmentArtifactIds: [],
            };
            const result = verifiedCandidateToolResult(options.recorder);
            const baseRegistry = emptyRegistry();
            registerAnalyzeScreenshotStub(baseRegistry);
            let launchIndex = 0;
            // Launch order: reported_on_current with the reporter URL (filters 2,10), whose
            // read-back keeps only filter 2; then defaults_plus_required on filter 2 alone.
            const { findExtensionRuntime, createPhaseApplicationModelRunner } =
                launchReadBackDependencies();
            const runtime = await createExtensionRuntime(options, {
                findExtensionRuntime,
                createPhaseApplicationModelRunner,
                readAdGuardExtensionState: vi.fn(async () =>
                    launchIndex === 1 && limitsExceeded
                        ? readBackStateFixture([2], {
                              rulesLimits: exceededRulesLimitsFixture([2, 10], [2]),
                          })
                        : readBackStateFixture([2]),
                ),
                createBaseRegistry: async () => baseRegistry,
                createBrowserSession: vi.fn(async () => {
                    launchIndex += 1;
                    return fakePreparedSession();
                }),
                createBrowserRegistry: async () =>
                    completePageRegistry(launchIndex === 1 ? 'reporter' : 'controlled', result),
            });
            try {
                await fetchRuntimeIssue(runtime);
                const reporterLaunch = await runtime.registry.dispatch('launch_browser', {
                    extension: 'prepared',
                    targetUrl: 'https://nettg.pl/',
                    profile: browserProfile,
                    settings: { kind: 'reported_on_current', importUrl: reporterImportUrl },
                });
                await runtime.registry.dispatch('close_browser', {});
                await runtime.registry.dispatch('launch_browser', {
                    extension: 'prepared',
                    targetUrl: 'https://nettg.pl/',
                    profile: browserProfile,
                    settings: {
                        kind: 'defaults_plus_required',
                        requiredFilterIds: [2],
                        reporterImportUrl,
                    },
                });
                await captureCompletePage(runtime, 'controlled');
                await runtime.registry.dispatch('apply_rule', {
                    candidateRule: 'nettg.pl##.articleAdSlot',
                });
                runtime.bindPreparedExtensionActualContextForResult();
                return {
                    reporterLaunch,
                    verdict: runtime.validateTerminalOutcome(draftOutcome()),
                    fidelityLimitations: runtime.getEnvironmentSelection()?.fidelityLimitations,
                };
            } finally {
                await runtime.dispose();
                rmSync(root, { recursive: true, force: true });
            }
        };

        const proven = await runFlow(true);
        expect(proven.reporterLaunch).toMatchObject({
            launched: true,
            settingsVerified: false,
            settingsLimitation: SettingsLimitation.Mv3LimitsExceeded,
            settingsDetail: expect.stringContaining('MV3'),
            guidance: expect.arrayContaining([expect.stringContaining('defaults_plus_required')]),
        });
        expect(proven.verdict).toBeUndefined();
        expect(proven.fidelityLimitations).toContainEqual(
            expect.objectContaining({
                code: FidelityLimitationCode.Mv3LimitsApproximation,
                detail: expect.stringContaining('2 filter'),
            }),
        );

        const unproven = await runFlow(false);
        expect(unproven.reporterLaunch).toMatchObject({ launched: true, settingsVerified: false });
        expect(unproven.reporterLaunch).not.toHaveProperty('settingsLimitation');
        expect(unproven.verdict).toMatchObject({
            errorKind: 'current_reporter_settings_required',
            actualProfileKinds: ['defaults_plus_required'],
        });
    });

    it('returns a typed prerequisite error instead of inventing a prepared extension', async () => {
        // A direct construction without the host-prepared build (a non-run caller) must refuse
        // the prepared launch with the typed prerequisite instead of inventing a build.
        const runtime = await createExtensionRuntime(
            { ...runtimeOptions(), preparedExtension: undefined },
            {
                createBaseRegistry: async () => emptyRegistry(),
            },
        );

        const result = await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: { kind: 'report_exact', importUrl: 'https://reports.adguard.com/' },
        });

        expect(result).toEqual({
            error: 'No extension has been prepared for this run.',
            errorKind: 'extension_not_prepared',
            retryable: true,
        });
    });

    it('publishes every settings kind and explains malformed profiles', async () => {
        const runtime = await createExtensionRuntime(runtimeOptions(), {
            createBaseRegistry: async () => emptyRegistry(),
        });
        const launchDefinition = runtime.registry
            .getDefinitions()
            .find((definition) => definition.function.name === 'launch_browser');
        const parameters = launchDefinition?.function.parameters as {
            additionalProperties?: boolean;
            properties?: {
                profile?: {
                    additionalProperties?: boolean;
                    properties?: {
                        geolocation?: { additionalProperties?: boolean };
                        proxyRegion?: unknown;
                    };
                };
                settings?: {
                    additionalProperties?: boolean;
                    properties?: { kind?: Record<string, unknown> };
                };
            };
        };
        const settingsShapes = parameters.properties?.settings?.properties?.kind;

        expect(parameters.properties?.settings?.additionalProperties).toBe(false);
        expect(parameters.additionalProperties).toBe(false);
        expect(parameters.properties?.profile?.additionalProperties).toBe(false);
        expect(parameters.properties?.profile?.properties?.geolocation?.additionalProperties).toBe(
            false,
        );
        expect(parameters.properties?.profile?.properties?.proxyRegion).toBeUndefined();
        expect(JSON.stringify(settingsShapes)).toContain('agent_selected');
        expect(JSON.stringify(settingsShapes)).toContain('defaults_plus_required');
        expect(JSON.stringify(settingsShapes)).toContain('report_exact');
        expect(JSON.stringify(settingsShapes)).toContain('reported_on_current');

        const result = await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: { report_exact: true },
        });

        expect(result).toMatchObject({
            errorKind: 'invalid_browser_request',
            retryable: true,
        });
        expect(result.error).toMatch(/accepted settings shapes/i);
        expect(result.error).toMatch(/kind.*report_exact.*importUrl/i);
        expect(result.error).not.toBe('Expected Object but received Object');
    });

    it.each([
        ['object profile', { ...browserProfile, proxyRegion: 'KR' }],
        ['JSON-encoded profile', JSON.stringify({ ...browserProfile, proxyRegion: 'KR' })],
    ])(
        'rejects geographic proxy selection as an unavailable capability for a %s',
        async (_name, profile) => {
            const createBrowserSession = vi.fn();
            const runtime = await createUndecidedRuntime(runtimeOptions(), {
                createBaseRegistry: async () => emptyRegistry(),
                createBrowserSession,
            });
            await fetchRuntimeIssue(runtime);

            const result = await runtime.registry.dispatch('launch_browser', {
                extension: 'none',
                targetUrl: 'https://nettg.pl/',
                profile,
            });

            expect(result).toEqual({
                error:
                    'Geographic proxy routing is unavailable. No proxy was attempted and network ' +
                    'egress did not change. Remove profile.proxyRegion; locale, timezone, and ' +
                    'geolocation affect only the browser context and do not change network egress.',
                errorKind: 'unsupported_browser_capability',
                retryable: true,
                requiredAction: 'remove_proxy_region_and_retry',
                unsupportedCapability: 'geographic_proxy',
                proxyAttempted: false,
                networkEgressChanged: false,
            });
            expect(createBrowserSession).not.toHaveBeenCalled();
        },
    );

    it('normalizes a JSON-encoded browser profile before strict launch validation', async () => {
        const createBrowserSession = vi.fn(
            async () => ({ close: vi.fn() }) as unknown as BrowserSession,
        );
        const runtime = await createExtensionRuntime(runtimeOptions(), {
            createBaseRegistry: async () => emptyRegistry(),
            createBrowserSession,
            createBrowserRegistry: async () => emptyRegistry(),
        });

        const result = await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: JSON.stringify(browserProfile),
        });

        expect(result).toMatchObject({ launched: true });
        expect(createBrowserSession).toHaveBeenCalledWith(
            expect.objectContaining({
                reproProfile: { ...browserProfile, userAgentProfile: 'Chromium' },
            }),
        );
        await runtime.dispose();
    });

    it.each([
        ['malformed JSON', '{'],
        ['array', JSON.stringify([browserProfile])],
        ['null', 'null'],
        ['boolean', 'true'],
        ['number', '1'],
        ['scalar', JSON.stringify('desktop')],
        ['double encoded object', JSON.stringify(JSON.stringify(browserProfile))],
        ['unknown field', JSON.stringify({ ...browserProfile, unexpected: true })],
        [
            'prototype-like profile key',
            '{"viewport":"desktop","locale":"en-US","timezone":"UTC",' +
                '"consentStrategy":"untouched","__proto__":{"polluted":true}}',
        ],
        [
            'prototype-like geolocation key',
            '{"viewport":"desktop","locale":"en-US","timezone":"UTC",' +
                '"consentStrategy":"untouched","geolocation":{"latitude":1,' +
                '"longitude":2,"constructor":{"prototype":{"polluted":true}}}}',
        ],
        [
            'Object.prototype-named profile key',
            '{"viewport":"desktop","locale":"en-US","timezone":"UTC",' +
                '"consentStrategy":"untouched","toString":"unexpected"}',
        ],
        [
            'native prototype-like profile key',
            JSON.parse(
                '{"viewport":"desktop","locale":"en-US","timezone":"UTC",' +
                    '"consentStrategy":"untouched","__proto__":{"polluted":true}}',
            ),
        ],
        ['oversized profile', JSON.stringify({ ...browserProfile, locale: 'x'.repeat(5_000) })],
    ])('rejects a JSON-encoded browser profile with %s', async (_name, profile) => {
        const createBrowserSession = vi.fn();
        const runtime = await createExtensionRuntime(runtimeOptions(), {
            createBaseRegistry: async () => emptyRegistry(),
            createBrowserSession,
        });

        const result = await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile,
        });

        expect(result).toMatchObject({
            errorKind: 'invalid_browser_request',
            retryable: true,
        });
        expect(createBrowserSession).not.toHaveBeenCalled();
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('closes an active session before switching profiles and again at disposal', async () => {
        const firstClose = vi.fn();
        const secondClose = vi.fn();
        const sessions = [firstClose, secondClose].map((close) => ({
            close,
        })) as unknown as BrowserSession[];
        const runtime = await createExtensionRuntime(runtimeOptions(), {
            createBaseRegistry: async () => emptyRegistry(),
            createBrowserSession: vi
                .fn()
                .mockResolvedValueOnce(sessions[0])
                .mockResolvedValueOnce(sessions[1]),
            createBrowserRegistry: async () => emptyRegistry(),
        });

        await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });
        await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });
        await runtime.dispose();

        expect(firstClose).toHaveBeenCalledTimes(1);
        expect(secondClose).toHaveBeenCalledTimes(1);
    });

    it('counts vision-classified challenge captures once per session, even at the original URL', async () => {
        // The provider keeps the original URL — no redirect signature to recognize — so only
        // the vision verdict over the captured pixels can spend the budget.
        const runtime = await walledPageRuntime(
            'vision-challenge-budget-run',
            'https://nettg.pl/',
            'anti_bot_challenge',
            'A full-viewport bot-verification checkbox replaces the page content.',
        );

        const analyses: Array<Record<string, unknown>> = [];
        for (const locale of ['ru-RU', 'en-US', 'pl-PL']) {
            if (analyses.length > 0) {
                await runtime.registry.dispatch('close_browser', {});
            }
            await runtime.registry.dispatch('launch_browser', {
                extension: 'none',
                targetUrl: 'https://nettg.pl/',
                profile: { ...browserProfile, locale },
            });
            await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' });
            const captured = await runtime.registry.dispatch('screenshot', {});
            analyses.push(
                await runtime.registry.dispatch('analyze_screenshot', {
                    artifactId: captured.artifactId,
                    prompt: 'What occupies the page?',
                }),
            );
            if (analyses.length === 2) {
                // A second classified capture inside the same session must not double-charge.
                const repeat = await runtime.registry.dispatch('screenshot', {});
                const repeatAnalysis = await runtime.registry.dispatch('analyze_screenshot', {
                    artifactId: repeat.artifactId,
                    prompt: 'Still the challenge?',
                });
                expect(repeatAnalysis).toMatchObject({ withheldPage: { attempts: 2 } });
            }
        }

        expect(analyses[0]).toMatchObject({
            withheldPage: {
                obstruction: 'anti_bot_challenge',
                attempts: 1,
                analysisOnlyAvailable: false,
            },
        });
        expect(analyses[1]).toMatchObject({ withheldPage: { attempts: 2 } });
        expect(analyses[2]).toMatchObject({
            withheldPage: { attempts: 3, analysisOnlyAvailable: true },
        });

        expect(runtime.getExhaustedTechnicalBrowserFailure()).toEqual({
            fallbackReason: 'bot_challenge',
            detail: expect.stringContaining('vision classified capture'),
        });

        // Exhaustion opens the same bounded-exhaustion path as hard technical failures: a
        // further launch against the challenge-walled target is refused with terminal guidance.
        const blockedRelaunch = await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: { ...browserProfile, locale: 'de-DE' },
        });
        expect(blockedRelaunch).toMatchObject({
            errorKind: 'technical_attempt_budget_exhausted',
            requiredAction: 'finish_fix_analysis_only',
        });
    });

    it('lets a run behind a sign-in redirect finish once vision confirms the wall in each session', async () => {
        // A Yahoo Mail link (#242315) redirects to a sign-in page on its own site. Nothing fails
        // technically, so finish_fix refused every ending until the run was sealed. The wall has
        // to be provable from the pixels.
        const runtime = await walledPageRuntime(
            'sign-in-wall-budget-run',
            'https://login.nettg.pl/account/challenge',
            'sign_in_wall',
            'A sign-in form asks for an account before the mailbox opens.',
            { ...runtimeOptions(), issueAttachmentArtifactIds: [] },
        );
        await fetchRuntimeIssue(runtime);
        const analysisOnly: FixOutcome = {
            outcome: 'analysis_only',
            reasoning: 'The reported mailbox is behind a sign-in wall.',
        };

        for (const [index, locale] of ['en-US', 'el-GR', 'de-DE'].entries()) {
            if (index > 0) {
                await runtime.registry.dispatch('close_browser', {});
            }
            await runtime.registry.dispatch('launch_browser', {
                extension: 'none',
                targetUrl: 'https://nettg.pl/',
                profile: { ...browserProfile, locale },
            });
            await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' });
            // Not before vision has seen the wall in this session.
            expect(runtime.validateTerminalOutcome(analysisOnly)).toBeDefined();
            const captured = await runtime.registry.dispatch('screenshot', {});
            await runtime.registry.dispatch('analyze_screenshot', {
                artifactId: captured.artifactId,
                prompt: 'What occupies the page?',
            });
        }

        expect(runtime.validateTerminalOutcome(analysisOnly)).toBeUndefined();
        expect(runtime.getExhaustedTechnicalBrowserFailure()).toEqual({
            fallbackReason: 'sign_in_required',
            detail: expect.stringContaining('sign-in wall'),
        });
    });

    it.each([
        ["the site's own host", 'https://nettg.pl/', 'https://www.nettg.pl/', true],
        ['another domain', 'https://nettg.pl/', 'https://nettg-login.com/', false],
        ['a sibling host', 'https://www.nettg.pl/', 'https://shop.nettg.pl/', false],
        ['another tenant of a shared host', 'https://a.github.io/', 'https://b.github.io/', false],
    ] as const)(
        'counts a landing on %s as navigation only when it stays on the site',
        async (_name, targetUrl, landingUrl, sameSite) => {
            // AdguardFilters#241312: google.com loads as www.google.com. Comparing origins refused
            // the landing, so the run could neither inspect the page it had loaded nor finish.
            const analysisOnly: FixOutcome = {
                outcome: 'analysis_only',
                reasoning: 'The reported card is absent from the loaded page.',
            };
            const runtime = await walledPageRuntime(
                `landing-${landingUrl}`,
                landingUrl,
                'none',
                'The reported page is fully visible.',
                {
                    ...runtimeOptions(),
                    allowedTargetUrls: [targetUrl],
                    issueAttachmentArtifactIds: [],
                },
            );
            await fetchRuntimeIssue(runtime);
            await runtime.registry.dispatch('launch_browser', {
                extension: 'none',
                targetUrl,
                profile: browserProfile,
            });

            const opened = await runtime.registry.dispatch('open_page', { url: targetUrl });

            const errorKind = runtime.validateTerminalOutcome(analysisOnly)?.errorKind;
            if (sameSite) {
                expect(opened).not.toHaveProperty('redirectedTo');
                expect(errorKind).not.toBe('browser_first_evidence_required');
            } else {
                expect(opened).toMatchObject({ redirectedTo: landingUrl });
                expect(errorKind).toBe('browser_first_evidence_required');
            }
        },
    );

    it('lets the run launch on the page a reported URL redirected to on another site', async () => {
        // A dco.ink short link landed on the article on another site.
        // No session counted as reaching the reported page, finish_fix was refused three times and
        // the run was sealed with nothing but an empty report.
        const analysisOnly: FixOutcome = {
            outcome: 'analysis_only',
            reasoning: 'The reported box is absent from the article.',
        };
        const landingUrl = 'https://article-site.com/news/1';
        const runtime = await walledPageRuntime(
            'redirect-landing',
            landingUrl,
            'none',
            'The reported page is fully visible.',
            { ...runtimeOptions(), issueAttachmentArtifactIds: [] },
        );
        await fetchRuntimeIssue(runtime);
        await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });

        const opened = await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' });

        expect(opened).toMatchObject({
            redirectedTo: landingUrl,
            guidance: expect.stringContaining('Launch a new session'),
        });
        expect(runtime.validateTerminalOutcome(analysisOnly)?.errorKind).toBe(
            'browser_first_evidence_required',
        );
        const relaunched = await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: landingUrl,
            profile: browserProfile,
        });
        expect(relaunched).not.toHaveProperty('errorKind');
        await runtime.registry.dispatch('open_page', { url: landingUrl });
        expect(runtime.validateTerminalOutcome(analysisOnly)?.errorKind).not.toBe(
            'browser_first_evidence_required',
        );
    });

    it('caps technical target failures across browser profile changes', async () => {
        const recorder = new TraceRecorder({
            runId: 'technical-budget-run',
            issueNumber: rawIssue.number,
            mode: 'fix',
        });
        const createBrowserSession = vi.fn(
            async () => ({ close: vi.fn() }) as unknown as BrowserSession,
        );
        const openPage = vi.fn(async () => ({
            error: 'unreachable after 3 retries: Timeout 15000ms exceeded',
            fallbackReason: 'navigation_timeout',
        }));
        const getDom = vi.fn(async () => ({ artifactId: 'must-not-run' }));
        const runtime = await createExtensionRuntime(
            { ...runtimeOptions(), recorder },
            {
                createBaseRegistry: async () => emptyRegistry(),
                createBrowserSession,
                createBrowserRegistry: async () => {
                    const registry = emptyRegistry();
                    registry.register({
                        definition: {
                            type: 'function',
                            function: {
                                name: 'open_page',
                                description: 'Open page',
                                parameters: { type: 'object', properties: {} },
                            },
                        },
                        handler: openPage,
                    });
                    registry.register({
                        definition: {
                            type: 'function',
                            function: {
                                name: 'get_dom',
                                description: 'Capture DOM',
                                parameters: { type: 'object', properties: {} },
                            },
                        },
                        handler: getDom,
                    });
                    return registry;
                },
            },
        );

        const failures: Array<Record<string, unknown>> = [];
        for (const locale of ['ru-RU', 'en-US', 'pl-PL']) {
            if (failures.length > 0) {
                await runtime.registry.dispatch('close_browser', {});
            }
            await runtime.registry.dispatch('launch_browser', {
                extension: 'none',
                targetUrl: 'https://nettg.pl/',
                profile: { ...browserProfile, locale },
            });
            failures.push(
                await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' }),
            );
        }

        expect(failures[0]).toMatchObject({
            retryable: true,
            technicalFailure: { attempt: 1, maximumAttempts: 3, exhausted: false },
        });
        expect(failures[1]).toMatchObject({
            retryable: true,
            technicalFailure: { attempt: 2, maximumAttempts: 3, exhausted: false },
        });
        expect(failures[2]).toMatchObject({
            errorKind: 'technical_attempt_budget_exhausted',
            retryable: false,
            requiredAction: 'finish_fix_analysis_only',
            technicalFailure: {
                logicalOperation: 'browser_access',
                targetUrl: 'https://nettg.pl/',
                attempt: 3,
                maximumAttempts: 3,
                exhausted: true,
            },
        });

        const blockedProfileChange = await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: { ...browserProfile, locale: 'de-DE', consentStrategy: 'accept' },
        });

        expect(blockedProfileChange).toMatchObject({
            errorKind: 'technical_attempt_budget_exhausted',
            retryable: false,
            requiredAction: 'finish_fix_analysis_only',
            technicalFailure: { attempt: 3, exhausted: true },
        });
        expect(createBrowserSession).toHaveBeenCalledTimes(3);
        expect(openPage).toHaveBeenCalledTimes(3);
        await expect(runtime.registry.dispatch('get_dom', {})).rejects.toThrow(
            'Tool not found: get_dom',
        );
        expect(getDom).not.toHaveBeenCalled();
        expect(runtime.getLastBrowserError()).toMatchObject({
            kind: 'navigation_timeout',
            fallbackReason: 'navigation_timeout',
        });
        expect(
            recorder
                .toJSON()
                .events.filter(
                    (event) =>
                        event.type === 'decision' &&
                        event.payload.phase === 'technical_attempt_budget_exhausted',
                ),
        ).toHaveLength(1);
    });

    it('fails fast when the identical launch crash repeats instead of burning the budget', async () => {
        const recorder = new TraceRecorder({
            runId: 'launch-crash-fail-fast-run',
            issueNumber: rawIssue.number,
            mode: 'fix',
        });
        const createBrowserSession = vi.fn(async () => {
            throw launchCrashError('SIGTRAP');
        });
        const runtime = await createExtensionRuntime(
            { ...runtimeOptions(), recorder },
            {
                createBaseRegistry: async () => emptyRegistry(),
                createBrowserSession,
            },
        );

        const first = await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });
        expect(first).toMatchObject({
            retryable: true,
            technicalFailure: { attempt: 1, maximumAttempts: 3, exhausted: false },
        });

        const second = await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });
        expect(second).toMatchObject({
            errorKind: 'technical_attempt_budget_exhausted',
            fallbackReason: 'launch_failed',
            retryable: false,
            requiredAction: 'finish_fix_analysis_only',
            technicalFailure: { attempt: 2, maximumAttempts: 3, exhausted: true },
        });

        const blocked = await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: { ...browserProfile, locale: 'de-DE' },
        });
        expect(blocked).toMatchObject({
            errorKind: 'technical_attempt_budget_exhausted',
            retryable: false,
        });
        expect(createBrowserSession).toHaveBeenCalledTimes(2);
        expect(
            recorder
                .toJSON()
                .events.filter(
                    (event) =>
                        event.type === 'decision' &&
                        event.payload.failFast === 'identical_launch_signal',
                ),
        ).toHaveLength(1);
        expect(runtime.getLastBrowserError()).toMatchObject({
            fallbackReason: 'launch_failed',
        });
    });

    it('keeps the full attempt budget when launch crash signals differ', async () => {
        const createBrowserSession = vi
            .fn()
            .mockRejectedValueOnce(launchCrashError('SIGTRAP'))
            .mockRejectedValueOnce(launchCrashError('SIGABRT'))
            .mockRejectedValueOnce(launchCrashError('SIGTRAP'));
        const runtime = await createExtensionRuntime(runtimeOptions(), {
            createBaseRegistry: async () => emptyRegistry(),
            createBrowserSession,
        });

        const first = await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });
        const second = await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });
        const third = await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });

        expect(first).toMatchObject({ retryable: true, technicalFailure: { attempt: 1 } });
        expect(second).toMatchObject({
            retryable: true,
            technicalFailure: { attempt: 2, exhausted: false },
        });
        expect(third).toMatchObject({
            errorKind: 'technical_attempt_budget_exhausted',
            retryable: false,
            technicalFailure: { attempt: 3, exhausted: true },
        });
        expect(createBrowserSession).toHaveBeenCalledTimes(3);
    });

    it.each([
        'navigation_timeout',
        'target_unreachable',
        'http_blocked',
        'bot_challenge',
        'geo_blocked',
        'empty_dom',
    ] as const)(
        'preserves the exact %s fallback after budget exhaustion',
        async (fallbackReason) => {
            const runtime = await createExtensionRuntime(runtimeOptions(), {
                createBaseRegistry: async () => emptyRegistry(),
                createBrowserSession: async () => ({ close: vi.fn() }) as unknown as BrowserSession,
                createBrowserRegistry: async () => {
                    const registry = emptyRegistry();
                    registry.register({
                        definition: {
                            type: 'function',
                            function: {
                                name: 'open_page',
                                description: 'Open page',
                                parameters: { type: 'object', properties: {} },
                            },
                        },
                        handler: async () => ({
                            error: `Technical navigation failed: ${fallbackReason}`,
                            fallbackReason,
                        }),
                    });
                    return registry;
                },
            });

            let exhausted: Record<string, unknown> = {};
            for (const locale of ['ru-RU', 'en-US', 'pl-PL']) {
                if (locale !== 'ru-RU') {
                    await runtime.registry.dispatch('close_browser', {});
                }
                await runtime.registry.dispatch('launch_browser', {
                    extension: 'none',
                    targetUrl: 'https://nettg.pl/',
                    profile: { ...browserProfile, locale },
                });
                exhausted = await runtime.registry.dispatch('open_page', {
                    url: 'https://nettg.pl/',
                });
            }

            expect(exhausted).toMatchObject({
                errorKind: 'technical_attempt_budget_exhausted',
                fallbackReason,
                retryable: false,
            });
            expect(runtime.getLastBrowserError()).toMatchObject({
                kind: fallbackReason,
                fallbackReason,
            });
        },
    );

    it('accepts analysis_only after technical exhaustion when only control vision is complete', async () => {
        const analyzeScreenshot = vi.fn(async () => ({ analysis: 'Inspected the capture.' }));
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'analyze_screenshot',
                    description: 'Analyze screenshot',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: analyzeScreenshot,
        });
        let failNavigation = false;
        const browserRegistry = emptyRegistry();
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'open_page',
                    description: 'Open page',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async (args) =>
                failNavigation
                    ? {
                          error: 'page.evaluate: Execution context was destroyed',
                          fallbackReason: 'navigation_timeout',
                      }
                    : { url: args.url, statusCode: 200 },
        });
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'screenshot',
                    description: 'Capture complete page',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({
                artifactId: 'viewport-a',
                fullPageArtifactId: 'full-a',
                tileCoverage: { complete: true, tiles: [{ artifactId: 'tile-a' }] },
            }),
        });
        const runtime = await createExtensionRuntime(
            {
                ...runtimeOptions(),
                issueAttachmentArtifactIds: [],
            },
            {
                createBaseRegistry: async () => baseRegistry,
                createBrowserSession: async () => ({ close: vi.fn() }) as unknown as BrowserSession,
                createBrowserRegistry: async () => browserRegistry,
            },
        );
        await fetchRuntimeIssue(runtime);
        const analysisOnly: FixOutcome = {
            outcome: 'analysis_only',
            reasoning: 'Browser access to the target is technically exhausted.',
        };

        await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });
        await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' });
        await runtime.registry.dispatch('screenshot', { captureTiles: true });
        await runtime.registry.dispatch('analyze_screenshot', {
            artifactId: 'full-a',
            prompt: 'Inspect the full-page overview.',
        });
        await runtime.registry.dispatch('analyze_screenshot', {
            artifactId: 'tile-a',
            prompt: 'Inspect this original-resolution tile.',
        });
        expect(runtime.validateTerminalOutcome(analysisOnly)).toMatchObject({
            errorKind: 'current_extension_full_vision_required',
        });

        failNavigation = true;
        for (const locale of ['ru-RU', 'en-US', 'pl-PL']) {
            await runtime.registry.dispatch('close_browser', {});
            await runtime.registry.dispatch('launch_browser', {
                extension: 'none',
                targetUrl: 'https://nettg.pl/',
                profile: { ...browserProfile, locale },
            });
            await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' });
        }

        expect(runtime.validateTerminalOutcome(analysisOnly)).toBeUndefined();
    });

    it('rejects settings outside the bundled catalog without consuming the technical budget', async () => {
        const root = mkdtempSync(join(tmpdir(), 'agent-runtime-catalog-'));
        try {
            const createBrowserSession = vi.fn(
                async () => ({ close: vi.fn() }) as unknown as BrowserSession,
            );
            const openPage = vi.fn(async () => ({
                error: 'Timeout 15000ms exceeded',
                fallbackReason: 'navigation_timeout',
            }));
            const runtime = await createExtensionRuntime(
                {
                    ...runtimeOptions(),
                    preparedExtension: preparedExtensionWithBundledCatalog([2, 3, 6], root),
                },
                {
                    createBaseRegistry: async () => emptyRegistry(),
                    createBrowserSession,
                    createBrowserRegistry: async () => {
                        const registry = emptyRegistry();
                        registry.register({
                            definition: {
                                type: 'function',
                                function: {
                                    name: 'open_page',
                                    description: 'Open page',
                                    parameters: { type: 'object', properties: {} },
                                },
                            },
                            handler: openPage,
                        });
                        return registry;
                    },
                },
            );

            const rejected = await runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
                settings: { kind: 'agent_selected', filterIds: [2, 122], stealthEnabled: true },
            });

            expect(rejected).toMatchObject({
                errorKind: 'extension_settings_unsupported',
                retryable: true,
                requiredAction: 'adjust_settings_filter_ids',
                unsupportedFilterIds: [122],
            });
            expect(createBrowserSession).not.toHaveBeenCalled();

            const control = await runtime.registry.dispatch('launch_browser', {
                extension: 'none',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
            });
            expect(control).toMatchObject({ launched: true });
            const navFailure = await runtime.registry.dispatch('open_page', {
                url: 'https://nettg.pl/',
            });
            expect(navFailure).toMatchObject({
                retryable: true,
                technicalFailure: { attempt: 1, exhausted: false },
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('lets reporter-owned settings past the catalog gate for degraded convergence', async () => {
        const createBrowserSession = vi.fn(
            async () => ({ close: vi.fn() }) as unknown as BrowserSession,
        );
        const runtime = await createExtensionRuntime(runtimeOptions(), {
            createBaseRegistry: async () => emptyRegistry(),
            createBrowserSession,
            createBrowserRegistry: async () => emptyRegistry(),
        });

        // Reporter settings are never rejected at the model-owned gate: the launch baseline
        // converges them onto the filters the bundled build catalog carries.
        const launched = await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: {
                kind: 'reported_on_current',
                importUrl:
                    'https://reports.adguard.com/settings/import.html?scheme_version=4' +
                    '&product_type=ext&product_version=5.4.3.1' +
                    '&regular_filters=2%2C122%2C207&stealth.enabled=1',
            },
        });

        expect(launched).toMatchObject({ launched: true });
        expect(createBrowserSession).toHaveBeenCalledOnce();
    });

    it('degrades a reporter filter set onto the bundled catalog subset with a classified conflict', async () => {
        const root = mkdtempSync(join(tmpdir(), 'agent-runtime-catalog-'));
        try {
            const runtime = await createExtensionRuntime(
                {
                    ...runtimeOptions(),
                    preparedExtension: preparedExtensionWithBundledCatalog([2], root),
                },
                {
                    ...launchReadBackDependencies([2]),
                    createBaseRegistry: async () => emptyRegistry(),
                    createBrowserSession: async () => fakePreparedSession(),
                    createBrowserRegistry: async () => emptyRegistry(),
                },
            );

            const launched = await runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
                settings: { kind: 'reported_on_current', importUrl: reporterImportUrl },
            });

            // The reporter named filters 2 and 10; the build carries only 2, so the launch
            // converges on 2 and verifies on that subset read-back instead of never matching.
            expect(launched).toMatchObject({ launched: true, settingsVerified: true });

            runtime.bindPreparedExtensionActualContextForResult();
            expect(runtime.getEnvironmentSelection()?.fidelityLimitations).toContainEqual(
                expect.objectContaining({
                    code: FidelityLimitationCode.FilterSelectionApproximation,
                    detail: expect.stringContaining('10'),
                }),
            );
            await runtime.dispose();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('escalates repeated non-convergent settings to a terminal rejection', async () => {
        const root = mkdtempSync(join(tmpdir(), 'agent-runtime-catalog-'));
        try {
            const runtime = await createExtensionRuntime(runtimeOptions(), {
                createBaseRegistry: async () => emptyRegistry(),
                createBrowserSession: async () => ({ close: vi.fn() }) as unknown as BrowserSession,
                createBrowserRegistry: async () => emptyRegistry(),
            });
            const launch = (filterIds: number[]) =>
                runtime.registry.dispatch('launch_browser', {
                    extension: 'prepared',
                    targetUrl: 'https://nettg.pl/',
                    profile: browserProfile,
                    settings: { kind: 'agent_selected', filterIds, stealthEnabled: false },
                });

            // Catalog-unsupported settings no longer refuse the launch: the run's one prepared
            // build boards, the model reports which filter IDs it asked for, and the browser
            // proof decides. The unverified session can never satisfy a live terminal decision.
            expect(await launch([122])).toMatchObject({
                launched: true,
                settingsVerified: false,
                extensionSource: 'pinned_release',
                extensionTag: 'v5.5.2.3',
            });
            await runtime.registry.dispatch('close_browser', {});
            expect(await launch([207])).toMatchObject({
                launched: true,
                settingsVerified: false,
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('stops recommending the reporter import URL after a recorded non-convergence', async () => {
        const root = mkdtempSync(join(tmpdir(), 'agent-runtime-catalog-'));
        try {
            const openPage = vi.fn(async () => ({
                error: 'Timeout 15000ms exceeded',
                fallbackReason: 'navigation_timeout',
            }));
            const runtime = await createExtensionRuntime(
                {
                    ...runtimeOptions(),
                    preparedExtension: preparedExtensionWithBundledCatalog([2, 10], root),
                },
                {
                    createBaseRegistry: async () => emptyRegistry(),
                    createBrowserSession: async () =>
                        ({ close: vi.fn() }) as unknown as BrowserSession,
                    createBrowserRegistry: async () => {
                        const registry = emptyRegistry();
                        registry.register({
                            definition: {
                                type: 'function',
                                function: {
                                    name: 'open_page',
                                    description: 'Open page',
                                    parameters: { type: 'object', properties: {} },
                                },
                            },
                            handler: openPage,
                        });
                        return registry;
                    },
                },
            );
            await runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
                settings: { kind: 'agent_selected', filterIds: [122], stealthEnabled: false },
            });

            await runtime.registry.dispatch('launch_browser', {
                extension: 'none',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
            });
            const navFailure = await runtime.registry.dispatch('open_page', {
                url: 'https://nettg.pl/',
            });

            expect(navFailure.guidance).toMatch(/agent_selected/);
            expect(navFailure.guidance).not.toMatch(/import URL/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('keeps the session and the target budget when open_page refuses an excursion off the issue origins', async () => {
        // The guard's own refusal says nothing about the site: it used to retire the session and
        // charge the budget, so three excursions declared a reachable site unavailable
        // (AdguardFilters #242110).
        const createBrowserSession = vi.fn(
            async () => ({ close: vi.fn() }) as unknown as BrowserSession,
        );
        const openPage = vi
            .fn()
            .mockResolvedValueOnce({
                error: "navigation blocked: URL must remain on configured issue origin 'https://nettg.pl'.",
                fallbackReason: 'navigation_off_origin',
            })
            .mockResolvedValue({ url: 'https://nettg.pl/', title: 'nettg', statusCode: 200 });
        const runtime = await createExtensionRuntime(runtimeOptions(), {
            createBaseRegistry: async () => emptyRegistry(),
            createBrowserSession,
            createBrowserRegistry: async () => {
                const registry = emptyRegistry();
                registry.register({
                    definition: {
                        type: 'function',
                        function: {
                            name: 'open_page',
                            description: 'Open page',
                            parameters: { type: 'object', properties: {} },
                        },
                    },
                    handler: openPage,
                });
                return registry;
            },
        });
        await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });

        const refusal = await runtime.registry.dispatch('open_page', {
            url: 'https://player.example/embed',
        });

        expect(refusal).toMatchObject({
            fallbackReason: 'navigation_off_origin',
            errorKind: 'navigation_refused',
            retryable: true,
            requiredAction: 'stay_on_issue_origin',
        });
        expect(refusal.technicalFailure).toBeUndefined();
        expect(
            runtime.registry.getDefinitions().map((definition) => definition.function.name),
        ).toContain('open_page');
        await expect(
            runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' }),
        ).resolves.toMatchObject({ url: 'https://nettg.pl/', statusCode: 200 });
        expect(openPage).toHaveBeenCalledTimes(2);
    });

    it('retires a failed control session and requires a materially different reporter session', async () => {
        const createBrowserSession = vi.fn(
            async () => ({ close: vi.fn() }) as unknown as BrowserSession,
        );
        const openPage = vi.fn(async () => ({
            error: 'Timeout 15000ms exceeded',
            fallbackReason: 'navigation_timeout',
        }));
        const browserRegistryContexts: Array<{ openPageRetries?: number }> = [];
        const runtime = await createExtensionRuntime(runtimeOptions(), {
            createBaseRegistry: async () => emptyRegistry(),
            createBrowserSession,
            createBrowserRegistry: async (context) => {
                browserRegistryContexts.push(context);
                const registry = emptyRegistry();
                registry.register({
                    definition: {
                        type: 'function',
                        function: {
                            name: 'open_page',
                            description: 'Open page',
                            parameters: { type: 'object', properties: {} },
                        },
                    },
                    handler: openPage,
                });
                return registry;
            },
        });
        await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });
        const controlFailure = await runtime.registry.dispatch('open_page', {
            url: 'https://nettg.pl/',
        });

        expect(controlFailure).toMatchObject({
            fallbackReason: 'navigation_timeout',
            retryable: true,
            requiredAction: 'close_browser_then_launch_materially_different',
            technicalFailure: { attempt: 1, exhausted: false },
        });
        expect(controlFailure.guidance).toMatch(/prepared extension.*reporter settings/i);
        expect(
            runtime.registry.getDefinitions().map((definition) => definition.function.name),
        ).not.toContain('open_page');
        await expect(runtime.registry.dispatch('open_page', {})).rejects.toThrow(
            'Tool not found: open_page',
        );
        expect(openPage).toHaveBeenCalledTimes(1);

        await expect(
            runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
                settings: {
                    kind: 'agent_selected',
                    filterIds: [2, 10],
                    stealthEnabled: false,
                },
            }),
        ).resolves.toMatchObject({
            errorKind: 'failed_browser_session_must_close',
            retryable: true,
            requiredAction: 'close_browser',
        });

        await runtime.registry.dispatch('close_browser', {});
        await expect(
            runtime.registry.dispatch('launch_browser', {
                extension: 'none',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
            }),
        ).resolves.toMatchObject({
            errorKind: 'failed_browser_environment_reused',
            retryable: true,
            requiredAction: 'launch_materially_different_browser',
        });

        await expect(
            runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
                settings: {
                    kind: 'agent_selected',
                    filterIds: [2, 10],
                    stealthEnabled: false,
                },
            }),
        ).resolves.toMatchObject({
            launched: true,
            extensionSource: 'pinned_release',
            extensionTag: 'v5.5.2.3',
        });
        expect(createBrowserSession).toHaveBeenCalledTimes(2);
        expect(browserRegistryContexts).toHaveLength(2);
        expect(browserRegistryContexts.every((context) => context.openPageRetries === 1)).toBe(
            true,
        );
        expect(
            runtime.registry.getDefinitions().map((definition) => definition.function.name),
        ).toContain('open_page');
    });

    it('does not demand guidance before a candidate when the run has no rule-guidance session', async () => {
        // The built-in AdGuard route registers no lookup_rule_guidance tool (the session
        // advertises a gated stub for it); a precondition that demanded the call anyway left
        // every candidate unvalidated on a live run.
        const baseRegistry = emptyRegistry();
        const browserRegistry = emptyRegistry();
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'apply_rule',
                    description: 'Collect candidate browser and vision evidence',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async (args) => ({ accepted: true, candidateRule: args.candidateRule }),
        });
        const runtime = await createExtensionRuntime(
            { ...runtimeOptions(), issueAttachmentArtifactIds: [] },
            {
                createBaseRegistry: async () => baseRegistry,
                createBrowserSession: async () => ({ close: vi.fn() }) as unknown as BrowserSession,
                createBrowserRegistry: async () => browserRegistry,
            },
        );
        await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });

        const result = await runtime.registry.dispatch('apply_rule', {
            candidateRule: 'nettg.pl##.banner',
        });

        expect(result).not.toMatchObject({ errorKind: 'guidance_required' });
        expect(result).toMatchObject({ accepted: true, candidateRule: 'nettg.pl##.banner' });
    });

    it('judges a rejected candidate again only under reveal steps it was not judged under', async () => {
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'lookup_rule_guidance',
                    description: 'Read pinned guidance',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ topic: 'element_hiding', citations: [] }),
        });
        const applyRule = vi.fn(async () => ({
            accepted: true,
            visualReview: { verdict: 'rejected' },
        }));
        const browserRegistry = emptyRegistry();
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'apply_rule',
                    description: 'Collect candidate browser and vision evidence',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: applyRule,
        });
        const runtime = await createExtensionRuntime(
            { ...runtimeOptions(), issueAttachmentArtifactIds: [] },
            {
                createBaseRegistry: async () => baseRegistry,
                createBrowserSession: async () => ({ close: vi.fn() }) as unknown as BrowserSession,
                createBrowserRegistry: async () => browserRegistry,
            },
        );
        await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });
        await runtime.registry.dispatch('lookup_rule_guidance', { topic: 'element_hiding' });
        const rule = 'nettg.pl##.subscription-popup';
        const waitForPopup = [{ kind: 'wait', quietMs: 5_000 }];

        await expect(
            runtime.registry.dispatch('apply_rule', {
                candidateRule: rule,
                revealSteps: [{ kind: 'teleport' }],
            }),
        ).resolves.toMatchObject({ errorKind: 'unsupported_step', retryable: true });
        expect(applyRule).not.toHaveBeenCalled();
        await runtime.registry.dispatch('apply_rule', { candidateRule: rule });
        expect(applyRule).toHaveBeenCalledTimes(1);
        await expect(
            runtime.registry.dispatch('apply_rule', { candidateRule: rule }),
        ).resolves.toMatchObject({ errorKind: 'duplicate_candidate' });
        // A popup that opens seconds after load was absent from the captures that rejected the
        // rule, so waiting for it is a different experiment, not a repeat.
        await runtime.registry.dispatch('apply_rule', {
            candidateRule: rule,
            revealSteps: waitForPopup,
        });
        expect(applyRule).toHaveBeenCalledTimes(2);
        await expect(
            runtime.registry.dispatch('apply_rule', {
                candidateRule: rule,
                revealSteps: waitForPopup,
            }),
        ).resolves.toMatchObject({ errorKind: 'duplicate_candidate' });
    });

    it('judges a residue rejection again only under DOM checks it was not judged under', async () => {
        const applyRule = vi.fn(async () => ({
            accepted: true,
            visualReview: { verdict: 'rejected', adLayoutResidue: 'present' },
        }));
        const browserRegistry = emptyRegistry();
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'apply_rule',
                    description: 'Collect candidate browser and vision evidence',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: applyRule,
        });
        const runtime = await createExtensionRuntime(runtimeOptions(), {
            createBaseRegistry: async () => registryWithScreenshotAnalysis(),
            createBrowserSession: async () => ({ close: vi.fn() }) as unknown as BrowserSession,
            createBrowserRegistry: async () => browserRegistry,
        });
        await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });
        await runtime.registry.dispatch('analyze_screenshot', {
            issueScreenshotIndex: 1,
            prompt: 'Describe the reporter-visible defect.',
        });
        const candidateRule = 'nettg.pl##.banner';
        const track = {
            expression: "getComputedStyle(document.querySelector('.grid')).backgroundColor",
            claim: 'The blank column is a transparent grid track.',
        };
        const apply = (domChecks?: unknown) =>
            runtime.registry.dispatch('apply_rule', {
                candidateRule,
                ...(domChecks === undefined ? {} : { domChecks }),
            });

        await expect(apply()).resolves.toMatchObject({
            remainingCandidateAttempts: MAX_CANDIDATE_ATTEMPTS - 1,
        });
        // A check that writes to the page is refused before anything runs or is spent.
        await expect(
            apply([{ expression: "document.body.style.display = 'none'", claim: 'Hidden.' }]),
        ).resolves.toMatchObject({
            errorKind: 'dom_check_rejected',
            checkIndex: 0,
            remainingCandidateAttempts: MAX_CANDIDATE_ATTEMPTS - 1,
        });
        await expect(
            apply(Array.from({ length: MAX_DOM_CHECKS + 1 }, () => track)),
        ).resolves.toMatchObject({ errorKind: 'dom_checks_invalid' });
        // A blank check measures nothing, so it cannot buy the candidate another run.
        await expect(apply([{ expression: '   ', claim: track.claim }])).resolves.toMatchObject({
            errorKind: 'dom_checks_invalid',
        });
        await expect(apply([{ expression: track.expression, claim: ' ' }])).resolves.toMatchObject({
            errorKind: 'dom_checks_invalid',
        });
        expect(applyRule).toHaveBeenCalledTimes(1);

        // Measuring the space the review called residue is a new experiment of the same
        // candidate, and spends no candidate attempt.
        await expect(apply([track])).resolves.toMatchObject({
            accepted: true,
            remainingCandidateAttempts: MAX_CANDIDATE_ATTEMPTS - 1,
        });
        expect(applyRule).toHaveBeenCalledTimes(2);
        // Rewording a claim measures nothing new.
        await expect(
            apply([{ ...track, claim: 'The column is page layout, not residue.' }]),
        ).resolves.toMatchObject({ errorKind: 'duplicate_candidate' });
        expect(applyRule).toHaveBeenCalledTimes(2);
    });

    it('requires every unique screenshot and guidance evidence before candidate attempts', async () => {
        const baseRegistry = emptyRegistry();
        const analyzeScreenshot = vi.fn(async () => ({
            analysis: 'A repeating empty advertising slot is visible.',
        }));
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'lookup_rule_guidance',
                    description: 'Read pinned guidance',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ topic: 'element_hiding', citations: [] }),
        });
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'analyze_screenshot',
                    description: 'Analyze a registered screenshot',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: analyzeScreenshot,
        });
        const browserRegistry = emptyRegistry();
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'apply_rule',
                    description: 'Collect candidate browser and vision evidence',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async (args) => ({ accepted: true, candidateRule: args.candidateRule }),
        });
        const runtime = await createExtensionRuntime(
            {
                ...runtimeOptions(),
                issueAttachmentArtifactIds: [
                    'issue-screenshot-a',
                    'issue-screenshot-b',
                    'issue-screenshot-a',
                ],
            },
            {
                createBaseRegistry: async () => baseRegistry,
                createBrowserSession: async () => ({ close: vi.fn() }) as unknown as BrowserSession,
                createBrowserRegistry: async () => browserRegistry,
            },
        );
        await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });

        await expect(
            runtime.registry.dispatch('apply_rule', { candidateRule: 'nettg.pl##.banner' }),
        ).resolves.toMatchObject({ errorKind: 'guidance_required' });
        await runtime.registry.dispatch('lookup_rule_guidance', { topic: 'element_hiding' });
        await expect(
            runtime.registry.dispatch('apply_rule', { candidateRule: 'nettg.pl##.banner' }),
        ).resolves.toMatchObject({
            errorKind: 'issue_screenshot_analysis_required',
            requiredTool: 'analyze_screenshot',
            availableIssueScreenshotIndices: [1, 2, 3],
        });
        await runtime.registry.dispatch('analyze_screenshot', {
            issueScreenshotIndex: 1,
            prompt: 'Describe the reporter-visible defect.',
        });
        expect(analyzeScreenshot).toHaveBeenCalledWith({
            artifactId: 'issue-screenshot-a',
            prompt: 'Describe the reporter-visible defect.',
        });
        await expect(
            runtime.registry.dispatch('apply_rule', { candidateRule: 'nettg.pl##.banner' }),
        ).resolves.toMatchObject({
            errorKind: 'issue_screenshot_analysis_required',
            remainingIssueScreenshotIndices: [2],
        });
        await runtime.registry.dispatch('analyze_screenshot', {
            issueScreenshotIndex: 2,
            prompt: 'Describe the second reporter-visible view.',
        });
        await expect(
            runtime.registry.dispatch('apply_rule', { candidateRule: 'nettg.pl##.banner' }),
        ).resolves.toMatchObject({ accepted: true });
        await expect(
            runtime.registry.dispatch('apply_rule', { candidateRule: ' nettg.pl##.banner ' }),
        ).resolves.toMatchObject({ errorKind: 'duplicate_candidate', attemptNumber: 1 });
        await runtime.registry.dispatch('apply_rule', { candidateRule: 'nettg.pl##.banner2' });
        await runtime.registry.dispatch('apply_rule', { candidateRule: 'nettg.pl##.banner3' });
        await expect(
            runtime.registry.dispatch('apply_rule', { candidateRule: 'nettg.pl##.banner4' }),
        ).resolves.toMatchObject({
            errorKind: 'candidate_limit_reached',
            maximumAttempts: MAX_CANDIDATE_ATTEMPTS,
        });
    });

    it('tells the model how many distinct candidates it may still validate', async () => {
        // A model that is never told the budget stops early: a run rejected its first two
        // candidates and finished with the third idea left as advice in its reasoning.
        const browserRegistry = emptyRegistry();
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'apply_rule',
                    description: 'Collect candidate browser and vision evidence',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ visualReview: { verdict: 'rejected' } }),
        });
        const runtime = await createExtensionRuntime(runtimeOptions(), {
            createBaseRegistry: async () => registryWithScreenshotAnalysis(),
            createBrowserSession: async () => ({ close: vi.fn() }) as unknown as BrowserSession,
            createBrowserRegistry: async () => browserRegistry,
        });
        await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });
        await runtime.registry.dispatch('analyze_screenshot', {
            issueScreenshotIndex: 1,
            prompt: 'Describe the reporter-visible defect.',
        });
        const apply = (candidateRule: string) =>
            runtime.registry.dispatch('apply_rule', { candidateRule });

        // A call refused before the candidate reaches the ledger states the count too.
        await expect(
            runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl##.banner',
                operation: 'rewrite',
            }),
        ).resolves.toMatchObject({
            errorKind: 'candidate_shape_invalid',
            remainingCandidateAttempts: MAX_CANDIDATE_ATTEMPTS,
        });
        await expect(apply('nettg.pl##.banner')).resolves.toMatchObject({
            visualReview: { verdict: 'rejected' },
            remainingCandidateAttempts: MAX_CANDIDATE_ATTEMPTS - 1,
        });
        // Sending a validated candidate again spends nothing.
        await expect(apply('nettg.pl##.banner')).resolves.toMatchObject({
            errorKind: 'duplicate_candidate',
            remainingCandidateAttempts: MAX_CANDIDATE_ATTEMPTS - 1,
        });
        await expect(apply('nettg.pl##.banner2')).resolves.toMatchObject({
            remainingCandidateAttempts: MAX_CANDIDATE_ATTEMPTS - 2,
        });
        await expect(apply('nettg.pl##.banner3')).resolves.toMatchObject({
            remainingCandidateAttempts: 0,
        });
        await expect(apply('nettg.pl##.banner4')).resolves.toMatchObject({
            errorKind: 'candidate_limit_reached',
            remainingCandidateAttempts: 0,
        });
    });

    it('requires every unique reporter screenshot before a no-patch terminal decision', async () => {
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'analyze_screenshot',
                    description: 'Analyze a registered screenshot',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ analysis: 'The reporter-visible defect is an empty ad slot.' }),
        });
        const runtime = await createExtensionRuntime(
            {
                ...runtimeOptions(),
                issueAttachmentArtifactIds: ['issue-screenshot-a'],
            },
            {
                createBaseRegistry: async () => baseRegistry,
            },
        );
        await fetchRuntimeIssue(runtime);
        const analysisOnly: FixOutcome = {
            outcome: 'analysis_only',
            reasoning: 'No safe candidate was found.',
        };

        expect(runtime.validateTerminalOutcome(analysisOnly)).toMatchObject({
            errorKind: 'issue_screenshot_analysis_required',
            requiredAction: 'analyze_issue_screenshots',
            requiredTool: 'analyze_screenshot',
            remainingIssueScreenshotIndices: [1],
        });
        await runtime.registry.dispatch('analyze_screenshot', {
            issueScreenshotIndex: 1,
            prompt: 'Describe the reporter-visible defect.',
        });
        expect(runtime.validateTerminalOutcome(analysisOnly)).toMatchObject({
            errorKind: 'browser_first_evidence_required',
            requiredAction: 'fetch_issue_and_run_browser',
        });
    });

    it('allows report-only completion only after bounded technical browser exhaustion', async () => {
        const runtime = await createExtensionRuntime(
            {
                ...runtimeOptions(),
                issueAttachmentArtifactIds: [],
            },
            {
                createBaseRegistry: async () => emptyRegistry(),
                createBrowserSession: async () => {
                    throw new Error('Chromium is unavailable');
                },
            },
        );
        await fetchRuntimeIssue(runtime);
        const analysisOnly: FixOutcome = {
            outcome: 'analysis_only',
            reasoning: 'Browser access is unavailable after bounded retries.',
        };

        expect(runtime.validateTerminalOutcome(analysisOnly)).toMatchObject({
            errorKind: 'browser_first_evidence_required',
        });
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            await runtime.registry.dispatch('launch_browser', {
                extension: 'none',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
            });
        }
        expect(runtime.validateTerminalOutcome(analysisOnly)).toBeUndefined();
    });
    it('still requires bound vision proof when the raw issue has no reporter import', async () => {
        const baseRegistry = emptyRegistry();
        registerAnalyzeScreenshotStub(baseRegistry);
        const runtime = await createExtensionRuntime(
            { ...runtimeOptions(), issueAttachmentArtifactIds: [] },
            {
                createBaseRegistry: async () => baseRegistry,
                ...verifiedPreparedVisionSeams(),
            },
        );
        await fetchRuntimeIssue(runtime);
        await boardCurrentPreparedVision(runtime);

        expect(runtime.validateTerminalOutcome(draftOutcome())).toMatchObject({
            errorKind: 'candidate_visual_confirmation_required',
            requiredAction: 'apply_candidate_rule',
            candidateRule: 'nettg.pl##.articleAdSlot',
        });
    });

    it('rejects a verified control candidate despite settings proof from another session', async () => {
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'lookup_rule_guidance',
                    description: 'Read pinned guidance',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ topic: 'element_hiding' }),
        });
        registerAnalyzeScreenshotStub(baseRegistry);
        const validationArtifactId = 'validation-123456abcdef';
        const browserRegistry = emptyRegistry();
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'open_page',
                    description: 'Open page',
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
            handler: async () => ({
                artifactId: 'prepared-viewport',
                fullPageArtifactId: 'prepared-full',
                tileCoverage: {
                    complete: true,
                    tiles: [{ artifactId: 'prepared-tile' }],
                },
            }),
        });
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'apply_rule',
                    description: 'Collect candidate evidence',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({
                validationArtifactId,
                visualReview: {
                    verdict: 'verified',
                    symptom: 'resolved',
                    remainingInstances: [],
                    pageIntegrity: 'intact',
                },
            }),
        });
        const runtime = await createExtensionRuntime(
            { ...runtimeOptions(), issueAttachmentArtifactIds: [] },
            {
                ...launchReadBackDependencies(),
                createBaseRegistry: async () => baseRegistry,
                createBrowserSession: async (config: BrowserSessionConfig) =>
                    config.adguardExtensionPath
                        ? fakePreparedSession()
                        : ({ close: vi.fn() } as unknown as BrowserSession),
                createBrowserRegistry: async () => browserRegistry,
            },
        );
        await fetchRuntimeIssue(runtime);
        await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });
        await runtime.registry.dispatch('lookup_rule_guidance', { topic: 'element_hiding' });
        await runtime.registry.dispatch('apply_rule', {
            candidateRule: 'nettg.pl##.articleAdSlot',
        });
        await runtime.registry.dispatch('close_browser', {});
        await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
        });
        await captureCompletePage(runtime, 'prepared');

        expect(runtime.getLatestVerifiedSettingsEnvironment()).toMatchObject({
            extensionMode: 'prepared',
            extensionBaselineReadBack: { optionsEnabledFilterIds: [2] },
        });
        expect(runtime.getValidationEnvironment(validationArtifactId)).toMatchObject({
            extensionMode: 'none',
        });
        expect(
            runtime.getValidationEnvironment(validationArtifactId)?.extensionBaselineReadBack,
        ).toBeUndefined();
        expect(runtime.validateTerminalOutcome(draftOutcome())).toMatchObject({
            errorKind: 'candidate_current_extension_evidence_required',
            requiredAction: 'revalidate_candidate_in_current_extension_session',
            currentValidationArtifactId: validationArtifactId,
        });
        expect(runtime.getVerifiedCandidateBinding(validationArtifactId)).toBeUndefined();
    });

    it('binds candidate artifacts to the exact prepared session that produced them', async () => {
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'lookup_rule_guidance',
                    description: 'Read pinned guidance',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ topic: 'element_hiding' }),
        });
        const options = { ...runtimeOptions(), issueAttachmentArtifactIds: [] };
        const result = verifiedCandidateToolResult(options.recorder);
        const browserRegistry = emptyRegistry();
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'apply_rule',
                    description: 'Collect candidate evidence',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => result,
        });
        const runtime = await createExtensionRuntime(options, {
            ...launchReadBackDependencies(),
            createBaseRegistry: async () => baseRegistry,
            createBrowserSession: async () => fakePreparedSession(),
            createBrowserRegistry: async () => browserRegistry,
        });
        await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
        });
        await runtime.registry.dispatch('lookup_rule_guidance', { topic: 'element_hiding' });
        await runtime.registry.dispatch('apply_rule', {
            candidateRule: 'nettg.pl##.articleAdSlot',
        });

        expect(runtime.getVerifiedCandidateBinding(result.validationArtifactId)).toMatchObject({
            validationArtifactId: result.validationArtifactId,
            sessionId: expect.any(String),
            environment: {
                extensionBaselineReadBack: { optionsEnabledFilterIds: [2] },
            },
            validationArtifact: {
                artifactId: result.validationArtifactId,
                path: expect.stringContaining('factual-validation-'),
            },
            visualReviewArtifact: {
                artifactId: result.visualReviewArtifactId,
                path: expect.stringContaining('candidate-visual-review-'),
            },
            beforeViewport: {
                artifactId: 'candidate-before-viewport',
                path: '/tmp/artifacts/candidate-before-viewport.png',
            },
            afterFullPage: {
                artifactId: 'candidate-after-full-page',
                path: '/tmp/artifacts/candidate-after-full-page.png',
            },
        });

        options.recorder.addArtifact({
            id: 'candidate-after-full-page',
            path: '/tmp/artifacts/foreign-session-after-full-page.png',
            type: 'screenshot-full-page',
            bytes: 100,
        });
        expect(runtime.getVerifiedCandidateBinding(result.validationArtifactId)).toBeUndefined();
    });

    it('retries the same semantic candidate after an inconclusive comparison obstruction', async () => {
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'lookup_rule_guidance',
                    description: 'Read pinned guidance',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ topic: 'element_hiding' }),
        });
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'analyze_screenshot',
                    description: 'Inspect one screenshot.',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async (args) => ({
                artifactId: args.artifactId,
                analysis: `Inspected ${String(args.artifactId)}.`,
            }),
        });
        const validationArtifactId = 'validation-123456abcdef';
        const applyRule = vi
            .fn()
            .mockResolvedValueOnce({
                validationArtifactId,
                visualReview: {
                    verdict: 'inconclusive',
                    symptom: 'unclear',
                    remainingInstances: [],
                    pageIntegrity: 'unclear',
                    rationale:
                        'A cookie consent dialog obscures both aligned states, so the comparison is inconclusive.',
                },
            })
            .mockResolvedValueOnce({
                validationArtifactId,
                visualReview: {
                    verdict: 'verified',
                    symptom: 'resolved',
                    remainingInstances: [],
                    pageIntegrity: 'intact',
                    rationale: 'Complete bound coverage verified the candidate.',
                },
            });
        const browserRegistry = emptyRegistry();
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'open_page',
                    description: 'Open page',
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
            handler: async () => ({
                artifactId: 'prepared-viewport',
                fullPageArtifactId: 'prepared-full',
                tileCoverage: {
                    complete: true,
                    tiles: [{ artifactId: 'prepared-tile' }],
                },
            }),
        });
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'apply_rule',
                    description: 'Collect candidate browser and vision evidence',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: applyRule,
        });
        const runtime = await createExtensionRuntime(
            { ...runtimeOptions(), issueAttachmentArtifactIds: [] },
            {
                ...launchReadBackDependencies(),
                createBaseRegistry: async () => baseRegistry,
                createBrowserSession: async () => fakePreparedSession(),
                createBrowserRegistry: async () => browserRegistry,
            },
        );
        await fetchRuntimeIssue(runtime);
        await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
        });
        await captureCompletePage(runtime, 'prepared');
        await runtime.registry.dispatch('lookup_rule_guidance', { topic: 'element_hiding' });

        await runtime.registry.dispatch('apply_rule', {
            candidateRule: 'nettg.pl##.articleAdSlot',
        });
        expect(runtime.validateTerminalOutcome(draftOutcome())).toMatchObject({
            errorKind: 'candidate_visual_confirmation_required',
            retryable: true,
            requiredAction: 'retry_same_candidate_validation',
            sameCandidateRetryAllowed: true,
            validationAttemptCount: 1,
        });

        await expect(
            runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl##.articleAdSlot',
            }),
        ).resolves.toMatchObject({
            validationArtifactId,
            visualReview: { verdict: 'verified' },
        });
        expect(applyRule).toHaveBeenCalledTimes(2);
        expect(runtime.validateTerminalOutcome(draftOutcome())).toBeUndefined();
        await expect(
            runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl##.articleAdSlot',
            }),
        ).resolves.toMatchObject({ errorKind: 'duplicate_candidate', attemptNumber: 1 });
    });

    it('does not parse reporter settings as a terminal draft oracle', async () => {
        const issue = {
            ...rawIssue,
            body: `${rawIssue.body}\n\n### Issue configuration\n[Import](${reporterImportUrl})`,
        };
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'lookup_rule_guidance',
                    description: 'Read pinned guidance',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ topic: 'element_hiding' }),
        });
        const validationArtifactId = 'validation-123456abcdef';
        const browserRegistry = emptyRegistry();
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'apply_rule',
                    description: 'Collect candidate evidence',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({
                validationArtifactId,
                visualReview: {
                    verdict: 'verified',
                    symptom: 'resolved',
                    remainingInstances: [],
                    pageIntegrity: 'intact',
                },
            }),
        });
        const runtime = await createExtensionRuntime(
            { ...runtimeOptions(), issue, issueAttachmentArtifactIds: [] },
            {
                ...launchReadBackDependencies(),
                createBaseRegistry: async () => baseRegistry,
                createBrowserSession: async () => fakePreparedSession(),
                createBrowserRegistry: async () => browserRegistry,
            },
        );
        await fetchRuntimeIssue(runtime);
        await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: {
                kind: 'defaults_plus_required',
                requiredFilterIds: [2],
                reporterImportUrl,
            },
        });
        await runtime.registry.dispatch('lookup_rule_guidance', { topic: 'element_hiding' });
        await runtime.registry.dispatch('apply_rule', {
            candidateRule: 'nettg.pl##.articleAdSlot',
        });

        // The reporter settings text is never a draft oracle: a diagnostic defaults session
        // cannot support a terminal decision — only the reporter's own import proves one.
        expect(runtime.validateTerminalOutcome(draftOutcome())).toMatchObject({
            errorKind: 'current_reporter_settings_required',
            requiredAction: 'launch_current_extension_with_reported_on_current',
        });
        expect(runtime.getValidationEnvironment(validationArtifactId)).toMatchObject({
            selectedSettingsProfileKind: 'defaults_plus_required',
        });
    });
    it('requires the model to select one prompt-safe target URL', async () => {
        const createBrowserSession = vi.fn(
            async () => ({ close: vi.fn() }) as unknown as BrowserSession,
        );
        const runtime = await createExtensionRuntime(runtimeOptions(), {
            createBaseRegistry: async () => emptyRegistry(),
            createBrowserSession,
            createBrowserRegistry: async () => emptyRegistry(),
        });

        await expect(
            runtime.registry.dispatch('launch_browser', {
                extension: 'none',
                targetUrl: 'https://unrelated.example/',
                profile: browserProfile,
            }),
        ).resolves.toMatchObject({ errorKind: 'target_url_not_allowed', retryable: true });
        expect(createBrowserSession).not.toHaveBeenCalled();

        await expect(
            runtime.registry.dispatch('launch_browser', {
                extension: 'none',
                targetUrl: 'https://nettg.pl/article/123',
                profile: browserProfile,
            }),
        ).resolves.toMatchObject({ launched: true, targetUrl: 'https://nettg.pl/article/123' });
        expect(createBrowserSession).toHaveBeenCalledTimes(1);
    });

    it('requires successful navigation and complete analyzed page coverage for no-patch evidence', async () => {
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'analyze_screenshot',
                    description: 'Analyze screenshot',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ analysis: 'The complete page was inspected.' }),
        });
        const browserRegistry = emptyRegistry();
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'open_page',
                    description: 'Open page',
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
                    description: 'Capture complete page',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({
                artifactId: 'viewport-a',
                fullPageArtifactId: 'full-a',
                tileCoverage: {
                    complete: true,
                    tiles: [{ artifactId: 'tile-a' }],
                },
            }),
        });
        const runtime = await createExtensionRuntime(
            { ...runtimeOptions(), issueAttachmentArtifactIds: [] },
            {
                ...launchReadBackDependencies(),
                createBaseRegistry: async () => baseRegistry,
                createBrowserSession: async () => fakePreparedSession(),
                createBrowserRegistry: async () => browserRegistry,
            },
        );
        await fetchRuntimeIssue(runtime);
        const noPatch: FixOutcome = {
            outcome: 'resolve_without_patch',
            runStatus: 'not_reproduced',
            reasoning: 'The reporter symptom is absent.',
            evidenceSummary: 'Complete page vision found no matching symptom.',
        };
        const analysisOnly: FixOutcome = {
            outcome: 'analysis_only',
            reasoning: 'No safe candidate was found after complete visual inspection.',
        };

        await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });
        expect(runtime.hasBrowserEvidence()).toBe(false);

        await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' });
        expect(runtime.hasBrowserEvidence()).toBe(true);
        // The current build's own evidence gate outranks everything: no prepared session exists.
        expect(runtime.validateTerminalOutcome(noPatch)).toMatchObject({
            errorKind: 'current_extension_full_vision_required',
        });
        expect(runtime.validateTerminalOutcome(analysisOnly)).toMatchObject({
            errorKind: 'current_extension_full_vision_required',
        });
        await runtime.registry.dispatch('close_browser', {});

        // The prepared session's coverage is captured but its tile analysis is missing: the
        // current-build requirement now discriminates the exact missing artifacts.
        await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
        });
        await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' });
        await runtime.registry.dispatch('screenshot', { captureTiles: true });
        await runtime.registry.dispatch('analyze_screenshot', {
            artifactId: 'full-a',
            prompt: 'Inspect the full-page overview.',
        });
        const incompleteCurrent = runtime.validateTerminalOutcome(noPatch);
        expect(incompleteCurrent).toMatchObject({
            errorKind: 'current_extension_full_vision_required',
            currentVisionRequirement: expect.objectContaining({
                environment: 'current_prepared_extension',
                status: 'incomplete',
                missingArtifactIds: ['tile-a'],
            }),
        });
        await runtime.registry.dispatch('analyze_screenshot', {
            artifactId: 'tile-a',
            prompt: 'Inspect this original-resolution tile.',
        });

        expect(runtime.getLatestCompleteVisionEnvironment()).toMatchObject({
            targetUrl: 'https://nettg.pl/',
            extensionMode: 'prepared',
            navigationVerified: true,
            fullVisionVerified: true,
            pageCaptures: [{ visionVerified: true }],
        });
        expect(runtime.validateTerminalOutcome(noPatch)).toMatchObject({
            errorKind: 'report_only_status_evidence_mismatch',
            reporterSymptomEvidence: {
                unfilteredControl: 'missing',
                preparedExtension: 'missing',
            },
        });
        expect(runtime.validateTerminalOutcome(analysisOnly)).toBeUndefined();
    });

    it('does not count an empty vision response as complete page inspection', async () => {
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'analyze_screenshot',
                    description: 'Analyze screenshot',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ analysis: '   ' }),
        });
        const browserRegistry = emptyRegistry();
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'open_page',
                    description: 'Open page',
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
                    description: 'Capture complete page',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({
                artifactId: 'viewport-empty',
                fullPageArtifactId: 'full-empty',
                tileCoverage: {
                    complete: true,
                    tiles: [{ artifactId: 'tile-empty' }],
                },
            }),
        });
        const runtime = await createExtensionRuntime(
            { ...runtimeOptions(), issueAttachmentArtifactIds: [] },
            {
                createBaseRegistry: async () => baseRegistry,
                createBrowserSession: async () => ({ close: vi.fn() }) as unknown as BrowserSession,
                createBrowserRegistry: async () => browserRegistry,
            },
        );
        await fetchRuntimeIssue(runtime);
        const noPatch: FixOutcome = {
            outcome: 'resolve_without_patch',
            runStatus: 'not_reproduced',
            reasoning: 'The reporter symptom is absent.',
            evidenceSummary: 'The model returned no actual visual observation.',
        };

        await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });
        await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' });
        await runtime.registry.dispatch('screenshot', { captureTiles: true });
        const emptyAnalysis = await runtime.registry.dispatch('analyze_screenshot', {
            artifactId: 'full-empty',
            prompt: 'Inspect the full-page overview.',
        });
        await runtime.registry.dispatch('analyze_screenshot', {
            artifactId: 'tile-empty',
            prompt: 'Inspect this original-resolution tile.',
        });

        expect(emptyAnalysis).toMatchObject({
            errorKind: 'screenshot_analysis_empty',
            retryable: true,
            requiredAction: 'retry_screenshot_analysis',
            artifactId: 'full-empty',
        });
        expect(runtime.getLatestCompleteVisionEnvironment()).toBeUndefined();
        // The empty response left the capture unanalyzed, so the current-build requirement —
        // and every terminal decision behind it — stays unmet.
        expect(runtime.validateTerminalOutcome(noPatch)).toMatchObject({
            errorKind: 'current_extension_full_vision_required',
        });
    });

    it('identifies the exact incomplete environment and recovers by analyzing only its missing tile', async () => {
        const analysisAttempts = new Map<string, number>();
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'analyze_screenshot',
                    description: 'Analyze screenshot',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async (args) => {
                const artifactId = String(args.artifactId);
                const attempt = (analysisAttempts.get(artifactId) ?? 0) + 1;
                analysisAttempts.set(artifactId, attempt);
                return {
                    artifactId,
                    analysis:
                        artifactId === 'prepared-tile-b' && attempt === 1
                            ? ''
                            : `Inspected ${artifactId}.`,
                };
            },
        });
        let launchIndex = 0;
        const runtime = await createExtensionRuntime(
            { ...runtimeOptions(), issueAttachmentArtifactIds: [] },
            {
                ...launchReadBackDependencies(),
                createBaseRegistry: async () => baseRegistry,
                createBrowserSession: async () => fakePreparedSession(),
                createBrowserRegistry: async () => {
                    const prefix = launchIndex++ === 0 ? 'prepared' : 'control';
                    const registry = emptyRegistry();
                    registry.register({
                        definition: {
                            type: 'function',
                            function: {
                                name: 'open_page',
                                description: 'Open page',
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
                                description: 'Capture complete page',
                                parameters: { type: 'object', properties: {} },
                            },
                        },
                        handler: async () => ({
                            artifactId: `${prefix}-viewport`,
                            fullPageArtifactId: `${prefix}-full`,
                            tileCoverage: {
                                complete: true,
                                tiles: [
                                    { artifactId: `${prefix}-tile-a` },
                                    { artifactId: `${prefix}-tile-b` },
                                ],
                            },
                        }),
                    });
                    return registry;
                },
            },
        );
        await fetchRuntimeIssue(runtime);

        await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
        });
        await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' });
        await runtime.registry.dispatch('screenshot', { captureTiles: true });
        for (const artifactId of ['prepared-full', 'prepared-tile-a', 'prepared-tile-b']) {
            await runtime.registry.dispatch('analyze_screenshot', {
                artifactId,
                prompt: `Inspect ${artifactId}.`,
            });
        }
        await runtime.registry.dispatch('close_browser', {});

        await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });
        await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' });
        await runtime.registry.dispatch('screenshot', { captureTiles: true });
        for (const artifactId of ['control-full', 'control-tile-a', 'control-tile-b']) {
            await runtime.registry.dispatch('analyze_screenshot', {
                artifactId,
                prompt: `Inspect ${artifactId}.`,
            });
        }

        const alreadyFixed: FixOutcome = {
            outcome: 'resolve_without_patch',
            runStatus: 'already_fixed_current',
            reasoning: 'The reporter symptom is visible without filtering and absent with it.',
            evidenceSummary: 'Complete control and prepared-extension comparisons.',
        };
        const rejection = runtime.validateTerminalOutcome(alreadyFixed);

        // The current-build requirement carries the exact unmet artifacts of the one prepared
        // session, so the model retakes only that tile.
        expect(rejection).toMatchObject({
            errorKind: 'current_extension_full_vision_required',
            currentVisionRequirement: expect.objectContaining({
                environment: 'current_prepared_extension',
                status: 'incomplete',
                missingArtifactIds: ['prepared-tile-b'],
            }),
        });

        await runtime.registry.dispatch('analyze_screenshot', {
            artifactId: 'prepared-tile-b',
            prompt: 'Retry the one missing prepared-extension tile.',
        });

        expect(runtime.validateTerminalOutcome(alreadyFixed)).toMatchObject({
            errorKind: 'report_only_status_evidence_mismatch',
            reporterSymptomEvidence: {
                unfilteredControl: 'missing',
                preparedExtension: 'missing',
            },
        });
        expect(runtime.getCompletedEnvironments()).toEqual([
            expect.objectContaining({ extensionMode: 'prepared', fullVisionVerified: true }),
            expect.objectContaining({ extensionMode: 'none', fullVisionVerified: true }),
        ]);
    });

    it('returns session-bound screenshot IDs and paths in browser launch order', async () => {
        const options = { ...runtimeOptions(), issueAttachmentArtifactIds: [] };
        let launchIndex = 0;
        const runtime = await createExtensionRuntime(options, {
            ...launchReadBackDependencies(),
            createBaseRegistry: async () => emptyRegistry(),
            createBrowserSession: async () => fakePreparedSession(),
            createBrowserRegistry: async () => {
                const prefix = launchIndex++ === 0 ? 'control' : 'prepared';
                const registry = emptyRegistry();
                registry.register({
                    definition: {
                        type: 'function',
                        function: {
                            name: 'open_page',
                            description: 'Open page',
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
                            description: 'Capture page',
                            parameters: { type: 'object', properties: {} },
                        },
                    },
                    handler: async () => {
                        const artifacts = [
                            {
                                id: `${prefix}-viewport`,
                                path: `/tmp/${prefix}-viewport.png`,
                                type: 'screenshot',
                                bytes: 10,
                            },
                            {
                                id: `${prefix}-full-page`,
                                path: `/tmp/${prefix}-full-page.png`,
                                type: 'screenshot-full-page',
                                bytes: 20,
                            },
                            {
                                id: `${prefix}-tile`,
                                path: `/tmp/${prefix}-tile.png`,
                                type: 'screenshot-tile',
                                bytes: 10,
                            },
                        ];
                        for (const artifact of artifacts) {
                            options.recorder.addArtifact(artifact);
                        }
                        return {
                            artifactId: `${prefix}-viewport`,
                            fullPageArtifactId: `${prefix}-full-page`,
                            tileCoverage: {
                                complete: true,
                                tiles: [{ artifactId: `${prefix}-tile` }],
                            },
                        };
                    },
                });
                return registry;
            },
        });
        await runtime.registry.dispatch('launch_browser', {
            extension: 'none',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
        });
        await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' });
        await runtime.registry.dispatch('screenshot', { captureTiles: true });
        await runtime.registry.dispatch('close_browser', {});
        await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
        });
        await runtime.registry.dispatch('open_page', { url: 'https://nettg.pl/' });
        await runtime.registry.dispatch('screenshot', { captureTiles: true });

        expect(runtime.getCompletedEnvironments()).toMatchObject([
            {
                extensionMode: 'none',
                pageCaptures: [
                    {
                        visionVerified: false,
                        viewport: {
                            artifactId: 'control-viewport',
                            path: '/tmp/control-viewport.png',
                        },
                        fullPageOverview: {
                            artifactId: 'control-full-page',
                            path: '/tmp/control-full-page.png',
                        },
                        tiles: [
                            {
                                artifactId: 'control-tile',
                                path: '/tmp/control-tile.png',
                            },
                        ],
                    },
                ],
            },
            {
                extensionMode: 'prepared',
                selectedSettingsProfileKind: 'agent_selected',
                extensionBaselineReadBack: { optionsEnabledFilterIds: [2] },
                pageCaptures: [
                    {
                        visionVerified: false,
                        viewport: {
                            artifactId: 'prepared-viewport',
                            path: '/tmp/prepared-viewport.png',
                        },
                        fullPageOverview: {
                            artifactId: 'prepared-full-page',
                            path: '/tmp/prepared-full-page.png',
                        },
                        tiles: [
                            {
                                artifactId: 'prepared-tile',
                                path: '/tmp/prepared-tile.png',
                            },
                        ],
                    },
                ],
            },
        ]);
    });

    it('passes the run usage collector to the application model runner factory', async () => {
        const usageCollector = createRunUsageCollector();
        // The factory exists for the model-driven path only, so the run declares its own
        // application steps; the built-in AdGuard route never builds a session at all.
        const createRunner = vi.fn(
            (
                _depends: Parameters<
                    NonNullable<AgentRuntimeDependencies['createPhaseApplicationModelRunner']>
                >[0],
            ) => ({
                run: async () => ({ completed: true, actionLog: [] }),
            }),
        );
        const runtime = await createExtensionRuntime(
            {
                ...runtimeOptions(),
                issueAttachmentArtifactIds: [],
                usageCollector,
                instruction: ownApplicationInstruction(),
            },
            {
                ...launchReadBackDependencies(),
                createBaseRegistry: async () => emptyRegistry(),
                createBrowserSession: async () => fakePreparedSession(),
                createBrowserRegistry: async () => emptyRegistry(),
                createPhaseApplicationModelRunner: createRunner,
            },
        );
        const launched = await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
        });
        expect(launched).toMatchObject({ launched: true, settingsVerified: true });

        // The runner factory is the launch's one application-session seam: it receives the run's
        // collector, so the session it builds charges the same usage summary as every other
        // session of the run.
        expect(createRunner).toHaveBeenCalledTimes(1);
        expect(createRunner.mock.calls[0]![0].usageCollector).toBe(usageCollector);
        await runtime.dispose();
    });

    it('binds candidate validation to its exact prepared environment', async () => {
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'lookup_rule_guidance',
                    description: 'Read rule guidance',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ topic: 'element_hiding' }),
        });
        const browserRegistry = emptyRegistry();
        browserRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'apply_rule',
                    description: 'Validate rule',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ validationArtifactId: 'validation-123456abcdef' }),
        });
        const runtime = await createExtensionRuntime(
            { ...runtimeOptions(), issueAttachmentArtifactIds: [] },
            {
                ...launchReadBackDependencies(),
                createBaseRegistry: async () => baseRegistry,
                createBrowserSession: async () => fakePreparedSession(),
                createBrowserRegistry: async () => browserRegistry,
            },
        );

        const preparedFixture = runtimeOptions().preparedExtension!;
        await runtime.registry.dispatch('fetch_issue', { issueNumber: rawIssue.number });
        await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
        });

        await runtime.registry.dispatch('lookup_rule_guidance', { topic: 'element_hiding' });
        await runtime.registry.dispatch('apply_rule', {
            candidateRule: 'nettg.pl##.banner',
        });
        await runtime.registry.dispatch('close_browser', {});

        expect(runtime.getPreparedExtension()?.extensionSourceSha256).toBe(
            preparedFixture.extensionSourceSha256,
        );
        expect(
            runtime.getLatestVerifiedSettingsEnvironment()?.extension?.extensionSourceSha256,
        ).toBe(preparedFixture.extensionSourceSha256);
        expect(
            runtime.getLatestVerifiedSettingsEnvironment()?.extensionBaselineReadBack
                ?.optionsEnabledFilterIds,
        ).toEqual([2]);
        expect(
            runtime.getValidationEnvironment('validation-123456abcdef')?.extension
                ?.extensionSourceSha256,
        ).toBe(preparedFixture.extensionSourceSha256);
        expect(
            runtime.getValidationEnvironment('validation-123456abcdef')?.extensionBaselineReadBack
                ?.optionsEnabledFilterIds,
        ).toEqual([2]);
    });
});

/**
 * Runtime dependencies serving the prepared-launch read-back gate: the host read-back returns the
 * shipped state fixture and the application session is a no-op bounded runner, so the Baseline
 * application verifies without a model or a browser.
 *
 * @param enabledFilterIds - Filter IDs the read-back reports enabled; it must equal the filter set
 *   the launched settings request resolves to, or the launch read-back refuses to verify.
 * @returns Dependencies to spread into AgentRuntime dependencies.
 */
function launchReadBackDependencies(
    enabledFilterIds: readonly number[] = [2],
): Pick<
    AgentRuntimeDependencies,
    'readAdGuardExtensionState' | 'findExtensionRuntime' | 'createPhaseApplicationModelRunner'
> {
    return {
        readAdGuardExtensionState: vi.fn(async () => readBackStateFixture(enabledFilterIds)),
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

/**
 * The ready adapter state one hermetic run-adapter carries in the instruction-application tests.
 */
function verifyReadyAdapterState(): FilteringEnvironmentAdapterState {
    return {
        kind: 'browser_extension',
        lifecycle: 'ready',
        stateDigest: 'e'.repeat(64),
        actualContext: {
            kind: 'browser_extension',
            product: 'AdGuard Browser Extension',
            browser: 'CloakBrowser Chromium',
            productVersion: '5.4.3.99',
        },
        capabilities: ['browser_navigation', 'filtering_control'],
        preparation: {
            preparedAt: '2026-07-24T00:00:00.000Z',
            buildDigest: 'f'.repeat(64),
            extensionRootDigest: null,
        },
        baseline: null,
        openLeaseIds: [],
        cleanup: null,
    };
}

/**
 * The application-contract content of a foreign file-backed blocker run: the bounded application
 * steps plus the state-verification `read:` declaration whose exact target text the host resolves
 * and reads. Mirrors the section shape the shipped foreign example instruction carries.
 *
 * @param method - The file-backed verification method the declaration names.
 * @param target - The declared `read:` target exactly as the instruction writes it.
 * @returns Instruction content binding both sections the application parser requires.
 */
function fileBackedApplicationContent(method: BlockerVerificationMethod, target: string): string {
    return [
        '# The blocker',
        '',
        '## Rule application',
        '',
        'Append the candidate rule as one exact line to the declared user-filters file, then ' +
            'put its exact contents into the blocker and restart the session.',
        '',
        '## State verification',
        '',
        `read: ${method} ${target}`,
        '',
    ].join('\n');
}

describe('AgentRuntime instruction application', () => {
    /**
     * Create the pinned-filter checkout directory the launch flow reads allowed list keys from.
     *
     * @returns Fresh empty directory path for one test run.
     */
    function filtersCheckout(): string {
        return mkdtempSync(join(tmpdir(), 'agent-runtime-instruction-application-'));
    }

    /**
     * One verified prepared launch whose hermetic executor capture exposes the runtime's real
     * phase-configuration option — the same seam the production browser-extension adapter consumes
     * to configure every B/C phase.
     *
     * The launch runs the built-in extension-state contract over the shipped read-back, so the
     * session is settings-verified and a throwaway apply_rule experiment locks the environment and
     * captures the options; the experiment itself stops at its first phase open.
     *
     * @param options - An own-application instruction to run instead of the built-in route, for a
     *   test that has to reach the bounded model session the built-in route never builds.
     * @returns The phase-configuration seam bound to the launched session, the prompts every
     *   application session received, the checkout path, the run's host-state root, and the
     *   disposal that releases the runtime, its checkout, and the fixture extension root.
     */
    async function capturedPhaseConfigurationHarness(
        options: {
            instruction?: LoadedInstruction;
        } = {},
    ): Promise<{
        phaseConfiguration: (
            request: EnvironmentPhaseConfigurationRequest,
        ) => Promise<EnvironmentPhaseConfigurationResult>;
        applicationPrompts: () => string[];
        filtersPath: string;
        hostStateRoot: string;
        dispose: () => Promise<void>;
    }> {
        const filtersPath = filtersCheckout();
        // The adapter options construction reads the prepared build's own manifest, so the fixture
        // unpacked root must carry one on disk.
        const extensionRoot = mkdtempSync(join(tmpdir(), 'agent-runtime-prepared-extension-'));
        writeFileSync(
            join(extensionRoot, 'manifest.json'),
            JSON.stringify({ manifest_version: 3, version: '5.5.2.3' }),
        );
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'lookup_rule_guidance',
                    description: 'Provide rule guidance.',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ topic: 'element_hiding' }),
        });
        let launchedSession: IBrowserSession | undefined;
        let capturedOptions: BrowserExtensionEnvironmentOptions | undefined;
        const applicationPrompts: string[] = [];
        const createBrowserSession = vi.fn(async () => {
            const session = fakePreparedSession();
            launchedSession = session;
            return session;
        });
        const adapter: FilteringEnvironmentAdapter = {
            kind: 'browser_extension',
            capabilities: () => ['browser_navigation', 'filtering_control'],
            prepare: async () => ({ ready: true, state: verifyReadyAdapterState() }),
            openPhase: async () => ({
                ready: false,
                limitation: {
                    code: 'phase_open_failed',
                    stage: 'phase',
                    detail: 'This harness stops the experiment after the environment lock.',
                },
            }),
            drainOpenHandles: async () => ({ attempted: 0, closed: 0, failed: 0, failures: [] }),
            cleanup: async () => ({
                attempted: true,
                completed: true,
                finalizerAttempts: 0,
                finalizerCompleted: 0,
                finalizerFailed: 0,
                failures: [],
            }),
            snapshot: verifyReadyAdapterState,
        };
        const runtime = await createExtensionRuntime(
            {
                ...runtimeOptions(),
                issueAttachmentArtifactIds: [],
                filtersPath,
                preparedExtension: preparedExtensionFixture(extensionRoot),
                ...(options.instruction === undefined ? {} : { instruction: options.instruction }),
            },
            {
                ...launchReadBackDependencies(),
                createBaseRegistry: async () => baseRegistry,
                createBrowserSession,
                createPhaseApplicationModelRunner: vi.fn(() => ({
                    run: async (request: PhaseApplicationRunnerRequest) => {
                        applicationPrompts.push(request.prompt);
                        return { completed: true, actionLog: [] };
                    },
                })),
                filteringExecutors: hermeticExtensionRegistry((context) => {
                    capturedOptions = context.extensionOptions!;
                    return adapter;
                }),
            },
        );
        await fetchRuntimeIssue(runtime);
        await runtime.registry.dispatch('lookup_rule_guidance', {});
        const launched = await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://nettg.pl/',
            profile: browserProfile,
            settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
        });
        expect(launched).toMatchObject({ launched: true, settingsVerified: true });
        // One throwaway experiment locks the environment: the executor factory captures the
        // runtime's real phase-configuration option while the experiment stops at its open.
        await runtime.registry.dispatch('apply_rule', {
            candidateRule: 'nettg.pl##.articleAdSlot',
        });
        if (!capturedOptions || !launchedSession) {
            throw new Error('the hermetic executor never captured the environment options.');
        }
        const phaseConfiguration = async (
            request: EnvironmentPhaseConfigurationRequest,
        ): Promise<EnvironmentPhaseConfigurationResult> =>
            capturedOptions!.phaseConfiguration(launchedSession!, request);
        return {
            phaseConfiguration,
            applicationPrompts: () => applicationPrompts,
            filtersPath,
            hostStateRoot: runtime.getHostStateRoot(),
            dispose: async () => {
                await runtime.dispose();
                await runtime.releaseHostState();
                rmSync(filtersPath, { recursive: true, force: true });
                rmSync(extensionRoot, { recursive: true, force: true });
            },
        };
    }

    it('tells the baseline application session that it brings the blocker to the prepared state', async () => {
        // The notes are a fill only a model session reads, so the run declares its own application
        // steps; the built-in route performs the same baseline on the host, with no prompt at all.
        const harness = await capturedPhaseConfigurationHarness({
            instruction: ownApplicationInstruction(),
        });
        try {
            const prompt = harness.applicationPrompts()[0];
            if (prompt === undefined) {
                throw new Error('the launch Baseline application session never ran.');
            }
            // The launch applies nothing; the prompt is the single place the model hears what
            // actually brings the blocker to the prepared state, and it must say so truthfully.
            expect(prompt).toContain('brings the blocker to the prepared state');
            expect(prompt).toContain('the launch applies nothing');
            expect(prompt).not.toContain('applied at launch');
        } finally {
            await harness.dispose();
        }
    });

    it('refuses verification entry when the run instruction describes no application, before any phase opens', async () => {
        const observeEnvironmentPhase = vi.fn();
        const gapsInstruction = {
            path: 'issues/AGENTS.md',
            content:
                '## Scope\n\nBlock the banner on the reported page with any supported rule kind.\n',
            sha256: 'a'.repeat(64),
            documents: [],
        };
        const recorder = new TraceRecorder({
            runId: 'instruction-gap-run',
            issueNumber: rawIssue.number,
            mode: 'fix',
        });
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'lookup_rule_guidance',
                    description: 'Provide rule guidance.',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ topic: 'element_hiding' }),
        });
        const filtersPath = filtersCheckout();
        try {
            const runtime = await createExtensionRuntime(
                {
                    ...runtimeOptions(),
                    issueAttachmentArtifactIds: [],
                    instruction: gapsInstruction,
                    recorder,
                    filtersPath,
                },
                {
                    createBaseRegistry: async () => baseRegistry,
                    // The session's read-back never runs: the verification-entry refusal fires
                    // from the gap instruction before the prepared settings gate could matter.
                    createBrowserSession: vi.fn(
                        async () => ({ close: vi.fn() }) as unknown as BrowserSession,
                    ),
                    observeEnvironmentPhase,
                },
            );
            await fetchRuntimeIssue(runtime);
            await runtime.registry.dispatch('lookup_rule_guidance', {});
            await runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
                settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
            });

            const result = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl##.articleAdSlot',
            });

            expect(result).toMatchObject({
                validationSkipped: true,
                errorKind: 'instruction_application_gap',
                gap: 'no-application-method',
                retryable: false,
            });
            // No phase may open behind this refusal: the run cannot spend observations on a
            // candidate its own instruction cannot apply.
            expect(observeEnvironmentPhase).not.toHaveBeenCalled();
            // The refusal is written to run evidence, not only to the tool response.
            expect(
                recorder
                    .toJSON()
                    .events.filter(
                        (event) =>
                            event.type === 'decision' &&
                            event.payload.phase === 'instruction_application_refused' &&
                            event.payload.gap === 'no-application-method',
                    ),
            ).toHaveLength(1);
            await runtime.dispose();
        } finally {
            rmSync(filtersPath, { recursive: true, force: true });
        }
    });

    it('opens phases for a guidance-only instruction that declares the built-in application route', async () => {
        // Companion to the refusal above. An instruction written only to link its repository's
        // guidance documents carries no application contract of its own, yet it used to replace the
        // built-in one wholesale: the early gate saw no contract to refuse, the run paid its whole
        // budget, and apply_rule then answered no-application-method. Declaring the route keeps the
        // built-in contract, so such a run verifies instead of ending analysis-only.
        const recorder = new TraceRecorder({
            runId: 'guidance-only-route-run',
            issueNumber: rawIssue.number,
            mode: 'fix',
        });
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'lookup_rule_guidance',
                    description: 'Provide rule guidance.',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ topic: 'element_hiding' }),
        });
        const openPhaseCalls: string[] = [];
        const hermeticAdapter: FilteringEnvironmentAdapter = {
            kind: 'browser_extension',
            capabilities: () => ['browser_navigation', 'filtering_control'],
            prepare: async () => ({ ready: true, state: verifyReadyAdapterState() }),
            openPhase: async (request) => {
                openPhaseCalls.push(request.phase);
                return {
                    ready: false,
                    limitation: {
                        code: 'phase_open_failed',
                        stage: 'phase',
                        detail: 'This hermetic adapter stops the experiment after the gate.',
                    },
                };
            },
            drainOpenHandles: async () => ({ attempted: 0, closed: 0, failed: 0, failures: [] }),
            cleanup: async () => ({
                attempted: true,
                completed: true,
                finalizerAttempts: 0,
                finalizerCompleted: 0,
                finalizerFailed: 0,
                failures: [],
            }),
            snapshot: verifyReadyAdapterState,
        };
        const filtersPath = filtersCheckout();
        try {
            // The declaration is read from instruction text through the real loader, so this
            // exercises the grammar the repository writes, not a hand-built loaded instruction.
            writeFileSync(
                join(filtersPath, 'AGENTS.md'),
                [
                    '# Run instruction: AdguardFilters',
                    '',
                    `application: ${ApplicationRoute.AdguardExtension}`,
                    '',
                    'The run loads its filter guidance at start from these role documents:',
                    '',
                    '- [AdGuard filter syntax](https://guidance.test/create-own-filters.md)',
                    '',
                ].join('\n'),
            );
            const instruction = await loadInstruction({
                checkoutRoot: filtersPath,
                instructionPath: 'AGENTS.md',
                fetchImpl: (async () =>
                    new Response('Syntax reference body.', { status: 200 })) as typeof fetch,
            });
            expect(instruction?.applicationRoute).toBe(ApplicationRoute.AdguardExtension);
            const createPhaseApplicationModelRunner = vi.fn(() => ({
                run: async () => ({ completed: true, actionLog: [] }),
            }));

            const runtime = await createExtensionRuntime(
                {
                    ...runtimeOptions(),
                    issueAttachmentArtifactIds: [],
                    instruction: instruction ?? undefined,
                    recorder,
                    filtersPath,
                },
                {
                    createBaseRegistry: async () => baseRegistry,
                    createBrowserSession: vi.fn(
                        async () =>
                            ({
                                close: vi.fn(),
                                extensionContext: fakePreparedExtensionSurface().context,
                            }) as unknown as BrowserSession,
                    ),
                    readAdGuardExtensionState: vi.fn(async () => readBackStateFixture()),
                    findExtensionRuntime: vi.fn(async () => ({
                        extensionId: 'test-extension-id',
                        manifestVersion: ExtensionManifestVersion.Mv3,
                    })),
                    createPhaseApplicationModelRunner,
                    filteringExecutors: hermeticExtensionRegistry(() => hermeticAdapter),
                },
            );
            await fetchRuntimeIssue(runtime);
            await runtime.registry.dispatch('lookup_rule_guidance', {});
            await runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
                settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
            });

            const applied = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl##.articleAdSlot',
            });

            // Verification is entered: the experiment reaches the hermetic adapter's phase open and
            // stops on that adapter's own limitation, not on a missing application method.
            expect(applied).not.toMatchObject({ errorKind: 'instruction_application_gap' });
            // A declared route is the built-in route: the host applied it and built no session.
            expect(createPhaseApplicationModelRunner).not.toHaveBeenCalled();
            expect(openPhaseCalls).toEqual([PhaseLabel.A]);
            expect(
                recorder
                    .toJSON()
                    .events.filter(
                        (event) =>
                            event.type === 'decision' &&
                            event.payload.phase === 'instruction_application_refused',
                    ),
            ).toHaveLength(0);
            await runtime.dispose();
        } finally {
            rmSync(filtersPath, { recursive: true, force: true });
        }
    });

    it('satisfies the prepared analysis gate and settingsVerified through the launch read-back', async () => {
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'lookup_rule_guidance',
                    description: 'Provide rule guidance.',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ topic: 'element_hiding' }),
        });
        const openPhaseCalls: string[] = [];
        const hermeticAdapter: FilteringEnvironmentAdapter = {
            kind: 'browser_extension',
            capabilities: () => ['browser_navigation', 'filtering_control'],
            prepare: async () => ({ ready: true, state: verifyReadyAdapterState() }),
            openPhase: async (request) => {
                openPhaseCalls.push(request.phase);
                return {
                    ready: false,
                    limitation: {
                        code: 'phase_open_failed',
                        stage: 'phase',
                        detail: 'This hermetic adapter stops the experiment after the gate.',
                    },
                };
            },
            drainOpenHandles: async () => ({ attempted: 0, closed: 0, failed: 0, failures: [] }),
            cleanup: async () => ({
                attempted: true,
                completed: true,
                finalizerAttempts: 0,
                finalizerCompleted: 0,
                finalizerFailed: 0,
                failures: [],
            }),
            snapshot: verifyReadyAdapterState,
        };
        const surface = fakePreparedExtensionSurface();
        const createBrowserSession = vi.fn(async () => {
            // No launch-time settings evidence: the launch route must gate on the host read-back.
            return {
                close: vi.fn(),
                extensionContext: surface.context,
            } as unknown as BrowserSession;
        });
        const readAdGuardExtensionState = vi.fn(async () => readBackStateFixture());
        const findExtensionRuntime = vi.fn(async () => ({
            extensionId: 'test-extension-id',
            manifestVersion: ExtensionManifestVersion.Mv3,
        }));
        const createPhaseApplicationModelRunner = vi.fn(() => ({
            run: async () => ({ completed: true, actionLog: [] }),
        }));
        const filtersPath = filtersCheckout();
        try {
            const runtime = await createExtensionRuntime(
                { ...runtimeOptions(), issueAttachmentArtifactIds: [], filtersPath },
                {
                    createBaseRegistry: async () => baseRegistry,
                    createBrowserSession,
                    readAdGuardExtensionState,
                    findExtensionRuntime,
                    createPhaseApplicationModelRunner,
                    filteringExecutors: hermeticExtensionRegistry(() => hermeticAdapter),
                },
            );
            await fetchRuntimeIssue(runtime);
            await runtime.registry.dispatch('lookup_rule_guidance', {});

            const launched = await runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
                settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
            });

            expect(launched).toMatchObject({ launched: true, settingsVerified: true });
            // The goal is the Baseline plug exactly like phase B in the environment route: no
            // candidate rule, and the host read-back provides the credit. This run carries no
            // instruction, so it is on the built-in AdGuard route: the host sent the import itself
            // and no application session was ever built.
            expect(
                surface.messages.filter(
                    (message) => message.type === AdGuardExtensionMessageType.ApplySettingsJson,
                ),
            ).toHaveLength(1);
            expect(surface.savedUserRules()).toBeUndefined();
            expect(createPhaseApplicationModelRunner).not.toHaveBeenCalled();

            const applied = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl##.articleAdSlot',
            });

            // Reaching the hermetic adapter's phase open proves the prepared gate was satisfied by
            // the read-back record instead of launch settings evidence.
            expect(applied).toMatchObject({
                validationSkipped: true,
                errorKind: 'environment_capability_limited',
            });
            expect(openPhaseCalls).toEqual(['A']);
            await runtime.dispose();
        } finally {
            rmSync(filtersPath, { recursive: true, force: true });
        }
    });

    it('keeps the prepared analysis gate closed when the launch read-back never verifies', async () => {
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'lookup_rule_guidance',
                    description: 'Provide rule guidance.',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ topic: 'element_hiding' }),
        });
        const openPhaseCalls: string[] = [];
        const hermeticAdapter: FilteringEnvironmentAdapter = {
            kind: 'browser_extension',
            capabilities: () => ['browser_navigation', 'filtering_control'],
            prepare: async () => ({
                ready: true,
                state: {
                    kind: 'browser_extension',
                    lifecycle: 'ready',
                    stateDigest: 'e'.repeat(64),
                    actualContext: {
                        kind: 'browser_extension',
                        product: 'AdGuard Browser Extension',
                        browser: 'CloakBrowser Chromium',
                        productVersion: '5.4.3.99',
                    },
                    capabilities: ['browser_navigation', 'filtering_control'],
                    preparation: null,
                    baseline: null,
                    openLeaseIds: [],
                    cleanup: null,
                },
            }),
            openPhase: async (request) => {
                openPhaseCalls.push(request.phase);
                return {
                    ready: false,
                    limitation: {
                        code: 'phase_open_failed',
                        stage: 'phase',
                        detail: 'Unreachable: the gate must refuse first.',
                    },
                };
            },
            drainOpenHandles: async () => ({ attempted: 0, closed: 0, failed: 0, failures: [] }),
            cleanup: async () => ({
                attempted: true,
                completed: true,
                finalizerAttempts: 0,
                finalizerCompleted: 0,
                finalizerFailed: 0,
                failures: [],
            }),
            snapshot: () => {
                throw new Error('not reached');
            },
        };
        const createBrowserSession = vi.fn(
            async () =>
                ({
                    close: vi.fn(),
                    extensionContext: {} as unknown as BrowserContext,
                }) as unknown as BrowserSession,
        );
        const filtersPath = filtersCheckout();
        try {
            const runtime = await createExtensionRuntime(
                { ...runtimeOptions(), issueAttachmentArtifactIds: [], filtersPath },
                {
                    createBaseRegistry: async () => baseRegistry,
                    createBrowserSession,
                    readAdGuardExtensionState: vi.fn(async () => {
                        throw new Error('options app never became ready.');
                    }),
                    findExtensionRuntime: vi.fn(async () => ({
                        extensionId: 'test-extension-id',
                        manifestVersion: ExtensionManifestVersion.Mv3,
                    })),
                    createPhaseApplicationModelRunner: () => ({
                        run: async () => ({ completed: true, actionLog: [] }),
                    }),
                    filteringExecutors: hermeticExtensionRegistry(() => hermeticAdapter),
                },
            );
            await fetchRuntimeIssue(runtime);
            await runtime.registry.dispatch('lookup_rule_guidance', {});

            const launched = await runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
                settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
            });
            expect(launched).toMatchObject({ launched: true, settingsVerified: false });

            const refused = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl##.articleAdSlot',
            });
            expect(refused).toMatchObject({
                validationSkipped: true,
                errorKind: 'prepared_extension_environment_required',
                retryable: true,
            });
            expect(openPhaseCalls).toEqual([]);
            await runtime.dispose();
        } finally {
            rmSync(filtersPath, { recursive: true, force: true });
        }
    });

    it('credits a file-declared managed-storage application whose relative target resolves against the run host-state root', async () => {
        const candidateRule = 'example.org##.promo-banner';
        const candidateDigest = createHash('sha256').update(candidateRule).digest('hex');
        const harness = await capturedPhaseConfigurationHarness();
        try {
            // The target as the instruction writes it: a relative user-filters file the host
            // maintains in the run's own host-state directory.
            writeFileSync(
                join(harness.hostStateRoot, 'ublock-user-filters.txt'),
                `${candidateRule}\n`,
            );

            const configured = await harness.phaseConfiguration({
                phase: PhaseLabel.C,
                targetUrl: 'https://nettg.pl/',
                candidateRule,
                application: fileBackedApplicationContent(
                    BlockerVerificationMethod.ManagedStorageFile,
                    'ublock-user-filters.txt',
                ),
                baselineEnabledFilterIds: ['adguard:2'],
            });

            // The bounded session ran once, and the host's own read-back of the resolved file
            // carries exactly the candidate line — the decision-1 credit through the declared
            // method, not the session's self-report.
            // eslint-disable-next-line no-console
            expect(configured).toMatchObject({
                kind: EnvironmentPhaseConfigurationOutcome.Applied,
                method: BlockerVerificationMethod.ManagedStorageFile,
                readBack: { rulesContent: candidateRule, rulesContentSha256: candidateDigest },
            });
        } finally {
            await harness.dispose();
        }
    });

    it('credits a file-declared user-rules-file application whose relative target resolves against the run host-state root', async () => {
        const candidateRule = 'example.org##.promo-banner';
        const candidateDigest = createHash('sha256').update(candidateRule).digest('hex');
        const harness = await capturedPhaseConfigurationHarness();
        try {
            // The target exactly as the shipped uBOL instruction writes it: a relative
            // custom-filters file the run maintains in its own host-state directory.
            writeFileSync(
                join(harness.hostStateRoot, 'ubol-custom-filters.txt'),
                `${candidateRule}\n`,
            );

            const configured = await harness.phaseConfiguration({
                phase: PhaseLabel.C,
                targetUrl: 'https://nettg.pl/',
                candidateRule,
                application: fileBackedApplicationContent(
                    BlockerVerificationMethod.UserRulesFile,
                    'ubol-custom-filters.txt',
                ),
                baselineEnabledFilterIds: ['adguard:2'],
            });

            // The credit for the method the shipped uBOL document declares runs through the same
            // host read-back of the resolved file: no extension-state reader, and the digest is
            // over the candidate exactly.
            expect(configured).toMatchObject({
                kind: EnvironmentPhaseConfigurationOutcome.Applied,
                method: BlockerVerificationMethod.UserRulesFile,
                readBack: { rulesContent: candidateRule, rulesContentSha256: candidateDigest },
            });
        } finally {
            await harness.dispose();
        }
    });

    it('credits a file-declared managed-storage application whose absolute target is read as-is', async () => {
        const candidateRule = 'example.net##.sticky-offer';
        const candidateDigest = createHash('sha256').update(candidateRule).digest('hex');
        const outsideHostState = mkdtempSync(join(tmpdir(), 'agent-runtime-declared-file-'));
        const storagePath = join(outsideHostState, 'ublock-user-filters.txt');
        writeFileSync(storagePath, `${candidateRule}\n`);
        const harness = await capturedPhaseConfigurationHarness();
        try {
            const configured = await harness.phaseConfiguration({
                phase: PhaseLabel.C,
                targetUrl: 'https://nettg.pl/',
                candidateRule,
                application: fileBackedApplicationContent(
                    BlockerVerificationMethod.ManagedStorageFile,
                    storagePath,
                ),
                baselineEnabledFilterIds: ['adguard:2'],
            });

            expect(configured).toMatchObject({
                kind: EnvironmentPhaseConfigurationOutcome.Applied,
                method: BlockerVerificationMethod.ManagedStorageFile,
                readBack: { rulesContent: candidateRule, rulesContentSha256: candidateDigest },
            });
        } finally {
            await harness.dispose();
            rmSync(outsideHostState, { recursive: true, force: true });
        }
    });

    it('does not credit a file-backed application whose resolved file does not contain the candidate', async () => {
        const candidateRule = 'example.org##.promo-banner';
        const staleContent = 'example.org##.leftover-from-an-earlier-pass';
        const harness = await capturedPhaseConfigurationHarness();
        try {
            // The file the resolved target names is real but holds other content: the runtime's
            // resolve+read wire-up must refuse to credit a stale read-back as the candidate
            // application.
            writeFileSync(
                join(harness.hostStateRoot, 'ublock-user-filters.txt'),
                `${staleContent}\n`,
            );

            const configured = await harness.phaseConfiguration({
                phase: PhaseLabel.C,
                targetUrl: 'https://nettg.pl/',
                candidateRule,
                application: fileBackedApplicationContent(
                    BlockerVerificationMethod.ManagedStorageFile,
                    'ublock-user-filters.txt',
                ),
                baselineEnabledFilterIds: ['adguard:2'],
            });

            // The generic procedure's refused-credit outcome: unverified, with the mismatch
            // surfaced exactly as its contract writes it — never Applied with a matching digest.
            expect(configured).toMatchObject({
                kind: EnvironmentPhaseConfigurationOutcome.Unverified,
                detail: expect.stringContaining('does not contain exactly the candidate rule'),
            });
        } finally {
            await harness.dispose();
        }
    });

    it('refuses a file-declared managed-storage application whose relative target escapes the run host-state root', async () => {
        const candidateRule = 'example.org##.promo-banner';
        const harness = await capturedPhaseConfigurationHarness();
        try {
            // Nothing is written and nothing exists at the resolved location: the refusal must
            // fire on the target's resolution alone and the file must never be read.
            const configured = await harness.phaseConfiguration({
                phase: PhaseLabel.C,
                targetUrl: 'https://nettg.pl/',
                candidateRule,
                application: fileBackedApplicationContent(
                    BlockerVerificationMethod.ManagedStorageFile,
                    '../../outside-the-host-state-root.txt',
                ),
                baselineEnabledFilterIds: ['adguard:2'],
            });

            expect(configured).toMatchObject({
                kind: EnvironmentPhaseConfigurationOutcome.Refused,
                gap: ApplicationInstructionGap.VerificationTargetOutsideHostState,
            });
        } finally {
            await harness.dispose();
        }
    });

    it('resolves a relative declared target outside the run checkout, where no checkout walk sees it', async () => {
        // The contract this guards: the candidate the host writes into its blocker-state file must
        // never come back as repository content. When that file sat inside the checkout, the safety
        // gate's duplicate scan rejected a verified candidate as "already exists in the checkout"
        // and the verdict's recomputed hostname baseline drifted from the apply-time hash.
        const candidateRule = 'example.org##.promo-banner';
        const candidateDigest = createHash('sha256').update(candidateRule).digest('hex');
        // The exact relative target the shipped uBlock Origin instruction declares.
        const declaredTarget = join('filters-agent', 'ublock', 'user-filters.txt');
        const decoyContent = 'example.org##.a-rule-the-repository-already-ships\n';
        const harness = await capturedPhaseConfigurationHarness();
        try {
            mkdirSync(dirname(join(harness.hostStateRoot, declaredTarget)), { recursive: true });
            writeFileSync(
                join(harness.hostStateRoot, declaredTarget),
                `${candidateRule}\n`,
                'utf8',
            );
            // A decoy at the very same relative path inside the checkout: if the resolution base
            // were the checkout again, the read-back would credit this content instead.
            mkdirSync(dirname(join(harness.filtersPath, declaredTarget)), { recursive: true });
            writeFileSync(join(harness.filtersPath, declaredTarget), decoyContent, 'utf8');

            const configured = await harness.phaseConfiguration({
                phase: PhaseLabel.C,
                targetUrl: 'https://nettg.pl/',
                candidateRule,
                application: fileBackedApplicationContent(
                    BlockerVerificationMethod.ManagedStorageFile,
                    declaredTarget,
                ),
                baselineEnabledFilterIds: ['adguard:2'],
            });

            expect(configured).toMatchObject({
                kind: EnvironmentPhaseConfigurationOutcome.Applied,
                readBack: { rulesContent: candidateRule, rulesContentSha256: candidateDigest },
            });
            // The checkout every later walk reads is exactly as it was: the run put nothing there.
            expect(readFileSync(join(harness.filtersPath, declaredTarget), 'utf8')).toBe(
                decoyContent,
            );
        } finally {
            await harness.dispose();
        }
    });

    it('refuses an application declaring a genuinely unknown verification method before any model turn', async () => {
        const unknownMethodInstruction = {
            path: 'issues/AGENTS.md',
            content: [
                '# The blocker',
                '',
                '## Rule application',
                '',
                'Perform the declared steps exactly, inventing none.',
                '',
                '## State verification',
                '',
                'read: telepathy ublock-user-filters.txt',
                '',
            ].join('\n'),
            sha256: 'a'.repeat(64),
            documents: [],
        };
        const recorder = new TraceRecorder({
            runId: 'instruction-unknown-method-run',
            issueNumber: rawIssue.number,
            mode: 'fix',
        });
        const observeEnvironmentPhase = vi.fn();
        const createPhaseApplicationModelRunner = vi.fn(() => ({
            run: vi.fn(async () => ({ completed: true, actionLog: [] })),
        }));
        const baseRegistry = emptyRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'lookup_rule_guidance',
                    description: 'Provide rule guidance.',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ topic: 'element_hiding' }),
        });
        const filtersPath = filtersCheckout();
        try {
            const runtime = await createExtensionRuntime(
                {
                    ...runtimeOptions(),
                    issueAttachmentArtifactIds: [],
                    instruction: unknownMethodInstruction,
                    recorder,
                    filtersPath,
                },
                {
                    createBaseRegistry: async () => baseRegistry,
                    createBrowserSession: vi.fn(
                        async () => ({ close: vi.fn() }) as unknown as BrowserSession,
                    ),
                    observeEnvironmentPhase,
                    createPhaseApplicationModelRunner,
                },
            );
            await fetchRuntimeIssue(runtime);
            await runtime.registry.dispatch('lookup_rule_guidance', {});
            await runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://nettg.pl/',
                profile: browserProfile,
                settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
            });

            const result = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'nettg.pl##.articleAdSlot',
            });

            // The parse-level refusal stays: a method outside the known set is recorded with its
            // own gap before any phase opens, and no application session is ever constructed.
            expect(result).toMatchObject({
                validationSkipped: true,
                errorKind: 'instruction_application_gap',
                gap: ApplicationInstructionGap.UnknownVerificationMethod,
                retryable: false,
            });
            expect(observeEnvironmentPhase).not.toHaveBeenCalled();
            expect(createPhaseApplicationModelRunner).not.toHaveBeenCalled();
            expect(
                recorder
                    .toJSON()
                    .events.filter(
                        (event) =>
                            event.type === 'decision' &&
                            event.payload.phase === 'instruction_application_refused' &&
                            event.payload.gap ===
                                ApplicationInstructionGap.UnknownVerificationMethod,
                    ),
            ).toHaveLength(1);
            await runtime.dispose();
        } finally {
            rmSync(filtersPath, { recursive: true, force: true });
        }
    });
});
