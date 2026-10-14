import { createHash } from 'node:crypto';
import { type PiRuntime } from '../../src/pi/runtime';
import {
    HermeticScenario,
    type HermeticProvider,
    type ScriptedReply,
    ScriptedReplyKind,
    startHermeticProvider,
} from '../pi/hermetic-provider';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as vitest from 'vitest';
import { vi } from 'vitest';
import type { BrowserContext } from 'playwright-core';
import type { CoreConfig } from '../../src/config/config';
import type { RawIssue } from '../../src/github/fetch-issue';
import type { IssueFacts } from '../../src/types/issue-facts';
import type {
    AdGuardExtensionSettingsEvidence,
    AdGuardExtensionStateRead,
} from '../../src/browser/adguard-extension-state-shapes';
import { DISABLE_STEALTH_SETTING } from '../../src/browser/adguard-extension-settings';
import type { AgentRuntimeDependencies } from '../../src/orchestrator/agent-runtime';
import { FilterEngine } from '../../src/types/filter-engine';
import { settingsEvidenceFromReadBack } from '../../src/orchestrator/agent-runtime-session-evidence';
import {
    fakePreparedExtensionSurface,
    readBackStateFixture,
} from '../environment/test-filtering-environment-fixtures';
import { readSettingsProof } from '../../src/local/settings-proof';
import * as fixCore from '../../src/orchestrator/fix-core';
import * as fixCoreContext from '../../src/orchestrator/fix-core-context';
import type * as fixCoreInputs from '../../src/orchestrator/fix-core-inputs';
import * as agenticRunEvidence from '../../src/orchestrator/agentic-run-evidence';
import { candidatePatchVerificationRefusal } from '../../src/orchestrator/candidate-verdict';
import type { CandidatePatch } from '../../src/types/fix-run-result';
import { calculateTrustedBaselineHash } from '../../src/validator/trusted-validation-context';
import * as fixEnvironmentLifecycle from '../../src/orchestrator/fix-environment-lifecycle';
import { BrowserConfigurationError } from '../../src/browser/browser-session';
import type { BrowserSession, BrowserSessionConfig } from '../../src/browser/browser-session';
import { ToolRegistry } from '../../src/agent/tool-registry';
import { ToolName } from '../../src/agent/tool-names';
import { SealKind } from '../../src/pi/seal-types';
import type { PreparedExtension } from '../../src/local/prepared-extension';
import type { TraceRecorder } from '../../src/tracer/trace-recorder';
import {
    ExtensionManifestVersion,
    PreparedExtensionSource,
} from '../../src/environment/extension-preparation';
import type { CandidateValidationSelection } from '../../src/orchestrator/candidate-validation-selection';
import type {
    AgentRuntimeCandidateValidationBinding,
    AgentRuntimeEnvironmentEvidence,
} from '../../src/orchestrator/agent-runtime-session-evidence';
import type { AgentRunArtifacts } from '../../src/types/agent-run-artifacts';
import { RuleGuidanceSourceKind } from '../../src/knowledge/guidance-source';
import { GuidanceDocumentOrigin, GuidanceDocumentRole } from '../../src/knowledge/guidance-source';
import type { LoadedInstruction } from '../../src/knowledge/instruction-loader';
import { extractPreparationSection } from '../../src/knowledge/instruction-preparation';
import type { PreparationSessionResult } from '../../src/orchestrator/preparation-session';
import type { KnowledgeGuidanceSource } from '../../src/knowledge/rule-guidance';
import { resolveRuleGuidanceSource } from '../../src/orchestrator/fix-core-inputs';
import type {
    FilteringEnvironmentAdapter,
    FilteringEnvironmentAdapterState,
} from '../../src/environment/filtering-environment';
import { extensionFilteringExecutor } from '../../src/orchestrator/extension-filtering-executor';
import {
    FilteringExecutorRegistry,
    type ExecutorAdapterContext,
    type FilteringExecutor,
} from '../../src/orchestrator/filtering-executors';
import type { ExecutorPreparationOutcome } from '../../src/environment/executor-preparation';

const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = fs;
const { describe, expect, it, afterEach, beforeEach, afterAll } = vitest;

/**
 * The pinned-release seam every agentic core run crosses before its runtime exists. The file mock
 * replaces the network boundary for the whole suite: a run without an injected seam resolves the
 * shared fixture build instead of downloading the real release, and the dedicated preparation tests
 * either inspect this mock or override it with their own injected seam.
 */
const { pinnedReleaseSeamMock } = vi.hoisted(() => ({
    pinnedReleaseSeamMock: vi.fn(),
}));

vi.mock('../../src/local/pinned-extension-release', () => ({
    downloadPinnedExtensionRelease: pinnedReleaseSeamMock,
}));

/**
 * Release tag the shared fixture build claims, aligned with the cached-provenance fixtures.
 */
const PINNED_RELEASE_FIXTURE_TAG = 'v5.5.2.3';

/**
 * The manifest the shared fixture build ships: one loadable Chromium MV3 build.
 */
const PINNED_RELEASE_FIXTURE_MANIFEST = { version: '5.5.2.3', manifest_version: 3 };

/**
 * Materialize one loadable unpacked extension directory for the preparation seams.
 *
 * @param parentDir - Directory to place the unpacked build under.
 * @param manifest - The manifest the fixture build ships; defaults to the pinned MV3 build.
 * @returns Absolute path of the unpacked directory.
 */
function writeUnpackedExtensionFixture(
    parentDir: string,
    manifest: Record<string, unknown> = PINNED_RELEASE_FIXTURE_MANIFEST,
): string {
    const unpacked = join(parentDir, 'unpacked');
    mkdirSync(unpacked, { recursive: true });
    writeFileSync(join(unpacked, 'manifest.json'), JSON.stringify(manifest));
    return unpacked;
}

/**
 * The shared fixture build the default seam resolves to, and its disposable root.
 */
const PINNED_RELEASE_FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'fix-core-pinned-release-'));
const PINNED_RELEASE_FIXTURE_DIR = writeUnpackedExtensionFixture(PINNED_RELEASE_FIXTURE_ROOT);

afterAll(() => {
    rmSync(PINNED_RELEASE_FIXTURE_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
    pinnedReleaseSeamMock.mockReset();
    pinnedReleaseSeamMock.mockResolvedValue({
        extensionDir: PINNED_RELEASE_FIXTURE_DIR,
        manifestVersion: ExtensionManifestVersion.Mv3,
        sha256: 'e'.repeat(64),
        tag: PINNED_RELEASE_FIXTURE_TAG,
        fromCache: false,
    });
});
/**
 * Build a hermetic run registry carrying the browser-extension-shaped registration whose adapter
 * construction the test replaces: production activation behavior, hermetic adapter.
 *
 * @param createAdapter - Adapter factory to install under the extension registration.
 * @returns The registry seeded for one core run.
 */
/**
 * The probe executor name for the two-element core runs: a preparable, activation-scriptable
 * registration distinct from runtime-owned executor classes.
 */
const CORE_PROBE_NAME = 'probe_proxy';

/**
 * Build a two-element hermetic core registry: the probe registration beside the production
 * extension registration, so the run promises the model a real choice.
 *
 * @param probe - The probe registration to run beside the extension.
 * @returns The registry seeded for one core run.
 */
function twoCoreExecutorRegistry(probe: FilteringExecutor): FilteringExecutorRegistry {
    const registry = new FilteringExecutorRegistry();
    registry.register(probe);
    registry.register(extensionFilteringExecutor);
    return registry;
}

/**
 * Build a preparable probe registration whose activation attaches the given preparation outcome,
 * exactly as a desktop executor activation seals its preparation.
 *
 * @param outcome - The durable preparation outcome the activation binds.
 * @returns The probe registration.
 */
function preparableProbeExecutor(outcome: ExecutorPreparationOutcome): FilteringExecutor {
    return {
        name: CORE_PROBE_NAME,
        descriptor: {
            kind: CORE_PROBE_NAME,
            availability: 'available',
            preparationState: 'preparable',
            limitationCode: null,
            capabilities: ['cli_installation', 'cli_activation'],
        },
        selectionGuidance: 'Probe desktop reports belong to probe_proxy.',
        activate: async (context) => {
            context.environmentHost.attachExecutorPreparation(outcome);
        },
        createAdapter: () => {
            throw new Error('adapter construction is not part of this suite.');
        },
    };
}

function hermeticExtensionRegistry(
    createAdapter: (context: ExecutorAdapterContext) => FilteringEnvironmentAdapter,
): FilteringExecutorRegistry {
    const registry = new FilteringExecutorRegistry();
    const { createAdapter: _production, ...rest } = extensionFilteringExecutor;
    void _production;
    registry.register({ ...rest, createAdapter });
    return registry;
}

/**
 * Runtime dependencies serving the prepared-launch read-back gate without a browser or model: the
 * host read-back returns the shipped state fixture and the application session is a no-op runner.
 *
 * @param enabledFilterIds - Filter IDs the read-back reports enabled.
 * @returns Dependencies to spread into the core's agent-runtime dependencies.
 */
function launchReadBackDependencies(
    enabledFilterIds: readonly number[],
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

const { runFixCore } = fixCore;
const { deriveAgenticVerificationStatus } = fixCoreContext;
const { completeFixResultAfterEnvironmentCleanup } = fixEnvironmentLifecycle;
const { serializeVerifiedCandidateBinding } = agenticRunEvidence;

import { createTestPiRuntime } from '../pi/test-runtime';
import { testCoreConfig } from '../config/test-core-config';
import { ConsoleCoverage } from '../../src/browser/browser-interfaces';
type FixCoreDependencies = fixCoreInputs.FixCoreDependencies;
type FixCoreOptions = fixCoreInputs.FixCoreOptions;
type FixCoreIssueInput = fixCoreInputs.FixCoreIssueInput;

let hermetic: HermeticProvider | undefined;

afterEach(async () => {
    if (!hermetic) {
        return;
    }
    await hermetic.close();
    hermetic = undefined;
});

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

const browserProfile = {
    viewport: 'desktop' as const,
    locale: 'en-US',
    timezone: 'UTC',
    consentStrategy: 'untouched' as const,
};

describe('acceptedCandidateDisposition', () => {
    const rule = 'example.test##.ad';
    const digest = createHash('sha256').update(rule).digest('hex');
    const proposedResult = (overrides: Record<string, unknown> = {}) =>
        ({
            runStatus: 'patch_proposed',
            candidatePatch: { rule },
            candidateValidationEvidence: {
                validationArtifactId: `validation-${digest.slice(0, 12)}-execution-${'a'.repeat(16)}`,
            },
            ...overrides,
        }) as never;

    it('pins the finalize-time disposition to the accepted candidate', () => {
        // Run 237885 (2026-08-10): later inconclusive experiments overwrote the runtime
        // disposition and the projection stripped the verified candidate's evidence.
        expect(fixCoreContext.acceptedCandidateDisposition(proposedResult())).toEqual({
            status: 'verified',
            candidateDigest: digest,
            failure: null,
        });
    });

    it('falls back to the runtime disposition when identity or status do not match', () => {
        expect(
            fixCoreContext.acceptedCandidateDisposition(
                proposedResult({ candidatePatch: { rule: 'other.test##.ad' } }),
            ),
        ).toBeUndefined();
        expect(
            fixCoreContext.acceptedCandidateDisposition(
                proposedResult({ candidateValidationEvidence: undefined }),
            ),
        ).toBeUndefined();
        expect(
            fixCoreContext.acceptedCandidateDisposition(
                proposedResult({ runStatus: 'analysis_only' }),
            ),
        ).toBeUndefined();
    });
});

describe('completeFixResultAfterEnvironmentCleanup', () => {
    it('does not expose the provisional result until environment cleanup and finalization complete', async () => {
        const calls: string[] = [];
        const actualContext = {
            kind: 'browser_extension' as const,
            product: 'AdGuard Browser Extension',
            browser: 'CloakBrowser Chromium',
            productVersion: '5.0.0',
        };
        const cleanupReceipt = {
            attempted: true,
            completed: true,
            finalizerAttempts: 0,
            finalizerCompleted: 0,
            finalizerFailed: 0,
            failures: [],
        };
        let adapterSnapshot: FilteringEnvironmentAdapterState = {
            kind: 'browser_extension' as const,
            lifecycle: 'ready',
            stateDigest: 'a'.repeat(64),
            actualContext,
            capabilities: [],
            preparation: null,
            baseline: null,
            openLeaseIds: [] as string[],
            cleanup: null,
        };
        const adapter: FilteringEnvironmentAdapter = {
            kind: 'browser_extension',
            capabilities: () => [],
            prepare: async () => ({
                ready: false,
                limitation: {
                    code: 'phase_open_failed',
                    stage: 'preparation',
                    detail: 'Not used.',
                },
            }),
            openPhase: async () => ({
                ready: false,
                limitation: { code: 'phase_open_failed', stage: 'phase', detail: 'Not used.' },
            }),
            drainOpenHandles: async () => {
                calls.push('drain');
                return { attempted: 0, closed: 0, failed: 0, failures: [] };
            },
            cleanup: async () => {
                calls.push('cleanup');
                adapterSnapshot = {
                    ...adapterSnapshot,
                    lifecycle: 'cleaned',
                    cleanup: cleanupReceipt,
                };
                return cleanupReceipt;
            },
            snapshot: () => adapterSnapshot,
        };
        let recordedAdapterState: unknown;
        const recorder = {
            recordCleanup: (input: { adapterState: unknown }) => {
                calls.push('record-cleanup');
                recordedAdapterState = input.adapterState;
            },
            finalize: () => {
                calls.push('finalize');
                return {
                    recorderVersion: 1 as const,
                    runId: 'run-6',
                    kind: 'browser_extension' as const,
                    actualContext,
                    capabilities: [],
                    preparation: null,
                    baseline: null,
                    phases: [],
                    rejectedCandidates: [],
                    drain: { attempted: 0, closed: 0, failed: 0, failures: [] },
                    cleanup: cleanupReceipt,
                    investigationDisposition: {
                        status: 'inconclusive' as const,
                        candidateDigest: null,
                        failure: null,
                    },
                    secondaryFailures: [],
                    disposition: {
                        status: 'inconclusive' as const,
                        candidateDigest: null,
                        failure: null,
                    },
                };
            },
        };

        const result = await completeFixResultAfterEnvironmentCleanup(
            { runStatus: 'analysis_only' },
            {
                adapter,
                recorder,
                disposition: { status: 'inconclusive', candidateDigest: null, failure: null },
            },
        );

        expect(result.environmentExecution?.cleanup.completed).toBe(true);
        expect(recordedAdapterState).toBe(adapterSnapshot);
        expect(calls).toEqual(['drain', 'cleanup', 'record-cleanup', 'finalize']);
    });

    it('keeps a proven patch when canonical execution refuses to project, and names the refusal', async () => {
        // A verified candidate died here once: the projection answered only `null` and the caller
        // threw, discarding a run that had already proven its rule through A/B/C
        // (mlekovitka.pl #238941, 2026-08-23).
        const cleanupReceipt = {
            attempted: true,
            completed: true,
            finalizerAttempts: 0,
            finalizerCompleted: 0,
            finalizerFailed: 0,
            failures: [],
        };
        const actualContext = {
            kind: 'browser_extension' as const,
            product: 'AdGuard Browser Extension',
            browser: 'CloakBrowser Chromium',
            productVersion: '5.0.0',
        };
        const adapterSnapshot: FilteringEnvironmentAdapterState = {
            kind: 'browser_extension' as const,
            lifecycle: 'cleaned',
            stateDigest: 'a'.repeat(64),
            actualContext,
            capabilities: [],
            preparation: null,
            baseline: null,
            openLeaseIds: [],
            cleanup: cleanupReceipt,
        };
        const adapter = {
            kind: 'browser_extension' as const,
            capabilities: () => [],
            prepare: async () => ({
                ready: false as const,
                limitation: {
                    code: 'phase_open_failed' as const,
                    stage: 'preparation' as const,
                    detail: 'Not used.',
                },
            }),
            openPhase: async () => ({
                ready: false as const,
                limitation: {
                    code: 'phase_open_failed' as const,
                    stage: 'phase' as const,
                    detail: 'Not used.',
                },
            }),
            drainOpenHandles: async () => ({
                attempted: 0,
                closed: 0,
                failed: 0,
                failures: [],
            }),
            cleanup: async () => cleanupReceipt,
            snapshot: () => adapterSnapshot,
        } as unknown as FilteringEnvironmentAdapter;
        // A verified disposition with no phase evidence cannot be an exact A/B/C experiment, so
        // the projection refuses this execution by name.
        const verified = {
            status: 'verified' as const,
            candidateDigest: 'd'.repeat(64),
            failure: null,
        };
        const recorder = {
            recordCleanup: () => undefined,
            finalize: () => ({
                recorderVersion: 1 as const,
                runId: 'run-refused',
                kind: 'browser_extension' as const,
                actualContext,
                capabilities: [],
                preparation: null,
                baseline: null,
                phases: [],
                rejectedCandidates: [],
                drain: { attempted: 0, closed: 0, failed: 0, failures: [] },
                cleanup: cleanupReceipt,
                investigationDisposition: verified,
                secondaryFailures: [],
                disposition: verified,
            }),
        } as unknown as Parameters<typeof completeFixResultAfterEnvironmentCleanup>[1]['recorder'];

        const provisional = {
            runStatus: 'patch_proposed',
            verificationStatus: 'verified',
            candidatePatch: { rule: 'example.test##.ad' },
        };
        const refusals: string[] = [];

        const result = await completeFixResultAfterEnvironmentCleanup(provisional, {
            adapter,
            recorder,
            disposition: verified,
            onProjectionRefused: (refusal) => refusals.push(refusal),
        });

        expect(refusals).toEqual(['verified_without_exact_abc']);
        // The patch survives, and the record simply carries no canonical execution rather than
        // claiming one it could not project.
        expect(result.candidatePatch).toEqual({ rule: 'example.test##.ad' });
        expect(result.runStatus).toBe('patch_proposed');
        expect(result.environmentExecution).toBeUndefined();
    });

    it('keeps run artifacts while drain failure suppresses success after completed cleanup', async () => {
        const actualContext = {
            kind: 'browser_extension' as const,
            product: 'AdGuard Browser Extension',
            browser: 'CloakBrowser Chromium',
            productVersion: '5.0.0',
        };
        const recordCleanup = vi.fn();
        const cleanupReceipt = {
            attempted: true,
            completed: true,
            finalizerAttempts: 0,
            finalizerCompleted: 0,
            finalizerFailed: 0,
            failures: [],
        };
        let adapterSnapshot: FilteringEnvironmentAdapterState = {
            kind: 'browser_extension',
            lifecycle: 'ready',
            stateDigest: 'a'.repeat(64),
            actualContext,
            capabilities: [],
            preparation: null,
            baseline: null,
            openLeaseIds: [],
            cleanup: null,
        };
        const adapter: FilteringEnvironmentAdapter = {
            kind: 'browser_extension',
            capabilities: () => [],
            prepare: async () => ({
                ready: false,
                limitation: {
                    code: 'phase_open_failed',
                    stage: 'preparation',
                    detail: 'Not used.',
                },
            }),
            openPhase: async () => ({
                ready: false,
                limitation: { code: 'phase_open_failed', stage: 'phase', detail: 'Not used.' },
            }),
            drainOpenHandles: async () => ({
                attempted: 1,
                closed: 0,
                failed: 1,
                failures: [
                    {
                        code: 'cleanup_failed',
                        stage: 'cleanup',
                        detail: 'A phase handle could not be closed.',
                    },
                ],
            }),
            cleanup: async () => {
                adapterSnapshot = {
                    ...adapterSnapshot,
                    lifecycle: 'cleaned',
                    cleanup: cleanupReceipt,
                };
                return cleanupReceipt;
            },
            snapshot: () => adapterSnapshot,
        };
        const recorder = {
            recordCleanup,
            finalize: vi.fn().mockReturnValue({
                recorderVersion: 1 as const,
                runId: 'run-drain-failure',
                kind: 'browser_extension' as const,
                actualContext,
                capabilities: [],
                preparation: null,
                baseline: null,
                phases: [],
                rejectedCandidates: [],
                drain: {
                    attempted: 1,
                    closed: 0,
                    failed: 1,
                    failures: [
                        {
                            code: 'cleanup_failed' as const,
                            stage: 'cleanup' as const,
                            detail: 'A phase handle could not be closed.',
                        },
                    ],
                },
                cleanup: {
                    attempted: true,
                    completed: true,
                    finalizerAttempts: 0,
                    finalizerCompleted: 0,
                    finalizerFailed: 0,
                    failures: [],
                },
                investigationDisposition: {
                    status: 'verified' as const,
                    candidateDigest: 'c'.repeat(64),
                    failure: null,
                },
                secondaryFailures: [],
                disposition: {
                    status: 'failed' as const,
                    candidateDigest: null,
                    failure: {
                        code: 'cleanup_failed' as const,
                        stage: 'cleanup' as const,
                        detail: 'The filtering environment did not clean up completely.',
                    },
                },
            }),
        };

        const result = await completeFixResultAfterEnvironmentCleanup(
            {
                runStatus: 'patch_proposed',
                verificationStatus: 'verified',
                candidatePatch: { rule: 'example.test##.ad' },
                artifactPaths: {
                    screenshots: ['/artifacts/issue.png', '/artifacts/legacy-environment.png'],
                    domSnapshot: '/artifacts/legacy-dom.html',
                    har: '/artifacts/legacy.har.json',
                    trace: '/artifacts/trace.json',
                    settingsProof: '/artifacts/settings.json',
                    browserLog: '/artifacts/browser.log',
                },
                browserSessions: [
                    {
                        captures: [
                            {
                                viewport: '/artifacts/legacy-environment.png',
                                fullPageOverview: null,
                                tiles: [],
                            },
                        ],
                    },
                ],
            },
            {
                adapter,
                recorder,
                disposition: { status: 'verified', candidateDigest: 'c'.repeat(64), failure: null },
            },
        );

        expect(recordCleanup).toHaveBeenCalledWith(
            expect.objectContaining({
                adapterState: expect.objectContaining({ lifecycle: 'cleaned' }),
                drain: expect.objectContaining({ failed: 1 }),
            }),
        );
        expect(result).toMatchObject({
            runStatus: 'failed',
            verificationStatus: 'unavailable',
            candidatePatch: null,
            artifactPaths: {
                screenshots: ['/artifacts/issue.png'],
                domSnapshot: null,
                har: null,
                trace: '/artifacts/trace.json',
                settingsProof: '/artifacts/settings.json',
                browserLog: '/artifacts/browser.log',
            },
        });
    });
});

/**
 * The arguments of the standard environment-selection call fixture.
 *
 * @param kind - The environment kind selected.
 * @returns The parsed selection arguments.
 */
function environmentSelectionArgs(
    kind:
        | 'browser_extension'
        | 'adguard_cli'
        | 'unsupported_product_case'
        | typeof CORE_PROBE_NAME = 'browser_extension',
): Record<string, unknown> {
    const call = environmentSelectionCall(kind) as { function: { arguments: string } };
    return JSON.parse(call.function.arguments) as Record<string, unknown>;
}

function environmentSelectionCall(
    kind:
        | 'browser_extension'
        | 'adguard_cli'
        | 'unsupported_product_case'
        | typeof CORE_PROBE_NAME = 'browser_extension',
) {
    return {
        id: `select-${kind}`,
        function: {
            name: 'select_environment',
            arguments: JSON.stringify({
                kind,
                requiredCapabilities:
                    kind === 'browser_extension' ? ['browser_navigation', 'filtering_control'] : [],
                intent: {
                    issueType: kind === 'unsupported_product_case' ? 'product_specific' : 'ads',
                    rationale: 'The agent classified the issue from its prompt-safe evidence.',
                    confidence: 0.9,
                    evidence: [
                        {
                            source: 'issue_body',
                            observation: 'The report describes a website-filtering symptom.',
                        },
                    ],
                    conflicts: [],
                },
                rationale: 'The selected environment best fits the issue and host capabilities.',
                confidence: 0.85,
            }),
        },
    };
}

/**
 * Provider that drives one complete model-selected environment lifecycle.
 */

/**
 * Build cached extension provenance for the agentic core fixture.
 *
 * @returns Exact model-selected Chromium MV3 extension.
 */
function cachedExtension(): PreparedExtension {
    return {
        extensionPath: '/tmp/extension-cache/extension',
        manifestVersion: ExtensionManifestVersion.Mv3,
        source: PreparedExtensionSource.PinnedRelease,
        extensionSourceSha256: 'e'.repeat(64),
        extensionSourceTag: 'v5.5.2.3',
    };
}

/**
 * The scripted replies of one run that locks the browser extension, launches one prepared
 * settings-bearing session, and then fails to re-submit an accepted terminal (the terminal outcome
 * is not what these preparation tests observe).
 *
 * @returns The provider script.
 */
function preparedSessionScript(): ScriptedReply[] {
    return [
        toolCall('select_environment', environmentSelectionArgs()),
        toolCall('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://example.com/article',
            profile: browserProfile,
            settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
        }),
        toolCall('finish_fix', {
            outcome: 'analysis_only',
            reasoning: 'The environment was reproduced but no safe rule was found.',
        }),
        { kind: ScriptedReplyKind.Text, text: 'The terminal submission was rejected.' },
        { kind: ScriptedReplyKind.Text, text: 'No terminal decision.' },
    ];
}

/**
 * Fake persistent extension context carrying the app-message surface the settings-payload pre-read
 * and the host-performed application both open a dedicated page on.
 *
 * @returns The fake context.
 */
function fakeExtensionContext(): BrowserContext {
    return fakePreparedExtensionSurface().context;
}

/**
 * The hermetic browser seams of one prepared-session run: every prepared launch exposes a
 * persistent context whose host read-back verifies the requested settings, so the run's locked
 * provenance binds to the read-back record.
 *
 * @returns The browser session and registry seams, plus the two-executor registry.
 */
function preparedSessionStubs(): {
    createBrowserSession: (config: BrowserSessionConfig) => Promise<BrowserSession>;
    createBrowserRegistry: () => Promise<ToolRegistry>;
    filteringExecutors: FilteringExecutorRegistry;
    launchReadBack: ReturnType<typeof launchReadBackDependencies>;
} {
    const createBrowserSession = vi.fn(async () => {
        return {
            close: vi.fn(),
            getConsoleLog: () => [],
            consoleCoverage: ConsoleCoverage.BrowserLogOnly,
            extensionContext: fakeExtensionContext(),
        } as unknown as BrowserSession;
    });
    const createBrowserRegistry = vi.fn(async () => {
        const registry = new ToolRegistry();
        registry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'browser_fact',
                    description: 'Read one browser fact',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ ok: true }),
        });
        return registry;
    });
    const filteringExecutors = twoCoreExecutorRegistry(
        preparableProbeExecutor({
            ready: true,
            provenance: {
                source: 'official_release',
                product: 'Probe product',
                version: '1.0.0',
                digestB32: 'digestb32examplevalue0123456789abcdefghijk',
            },
        }),
    );
    return {
        createBrowserSession,
        createBrowserRegistry,
        filteringExecutors,
        launchReadBack: launchReadBackDependencies([2]),
    };
}

/**
 * Build an instruction whose text carries a non-empty preparation section.
 *
 * @returns The loaded-instruction fixture with the sectioned content.
 */
function instructionWithPreparationSection(): LoadedInstruction {
    return {
        path: 'AGENT-INSTRUCTION.md',
        content: [
            'Verify the header banner, not the sidebar.',
            '',
            '## Preparation',
            'Build the blocker inside the workdir from the linked source.',
            '',
            'git clone https://blocker.example.test/blocker.git && build blocker',
            '',
            '## Rule application',
            '',
            'Apply exactly these steps, invent none:',
            '',
            '1. Open the blocker options page of the prepared build.',
            '2. Restore the baseline: no user rule, only the prepared filter set enabled.',
            '',
            '## State verification',
            '',
            'The host reads the blocker state back itself:',
            '',
            'read: extension-state user rules',
        ].join('\n'),
        sha256: 'a'.repeat(64),
        documents: [],
    };
}

/**
 * Materialize a real directory with no manifest, mimicking a fake build placement.
 *
 * @param workDir - The preparation workdir the placement must stay inside.
 * @returns The absolute path of the manifest-less directory.
 */
function writeUnpackedBareDir(workDir: string): string {
    const bare = join(workDir, 'bare');
    mkdirSync(bare, { recursive: true });
    return bare;
}

/**
 * Build a parser-compatible local issue fixture.
 *
 * @returns A local in-scope browser-extension issue.
 */
function localIssue(): RawIssue {
    return {
        number: 4,
        url: 'https://github.com/example-owner/example-repo/issues/4',
        title: 'Ad placeholder remains visible',
        body: [
            '### Issue URL (Ads)',
            'https://example.com/article',
            '',
            '### System configuration',
            'AdGuard product: | AdGuard Browser Extension v5.4.3',
            'Filters: | AdGuard Base filter',
        ].join('\n'),
        state: 'open',
        labels: ['T: Ads', 'N: AdGuard Browser Extension'],
        assignee: null,
        comments: [],
    };
}

/**
 * The facts a deterministic intake of {@link localIssue} produced — spelled literally now that the
 * parser is gone.
 *
 * @returns The validated-shape issue facts.
 */
function localFacts(): IssueFacts {
    return {
        issueNumber: 4,
        issueUrl: 'https://github.com/example-owner/example-repo/issues/4',
        reportedSiteUrls: ['https://example.com/article'],
        labels: ['T: Ads', 'N: AdGuard Browser Extension'],
        declaredIssueType: 'Ads',
        problemType: 'ads',
        product: 'AdGuard Browser Extension v5.4.3',
        enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
        screenshots: [],
    };
}

/**
 * Build minimal local core configuration.
 *
 * @param baseUrl - LLM base URL; tests wiring the loop onto the hermetic provider pass its base
 *   URL, everything else keeps the fixture gateway host.
 * @returns GitHub-independent configuration for tests.
 */
function coreConfig(baseUrl = 'https://llm.example.test/v1'): CoreConfig {
    return testCoreConfig({
        llm: { baseUrl, apiKey: 'local-key', visionModel: 'gemini-3.5-flash' },
    });
}

function candidateBindingFixture(baseline: 'read_back' | 'declared' = 'read_back') {
    const rule = 'example.com##.ad-slot';
    const candidateRuleHash = createHash('sha256').update(rule).digest('hex');
    const validationHash = candidateRuleHash.slice(0, 12);
    const validationArtifactId = `validation-${validationHash}`;
    const settingsEvidence = {
        profileKind: 'agent_selected',
        enabledFilterIds: [2],
        enabledFilters: [{ filterId: 2, name: 'AdGuard Base filter' }],
        activeRulesetFilterIds: [2],
        stealthEnabled: false,
        limitsExceeded: false,
    } as AdGuardExtensionSettingsEvidence;
    const visualReview = {
        verdict: 'verified' as const,
        symptom: 'resolved' as const,
        symptomScope: 'The reporter-visible advertising placeholder.',
        adLayoutResidue: 'absent' as const,
        coverageComplete: true,
        beforeInstances: [
            {
                artifactId: 'candidate-before',
                landmark: 'Article body',
                description: 'The advertising placeholder is visible.',
            },
        ],
        remainingInstances: [],
        pageIntegrity: 'intact' as const,
        validationArtifactId,
        candidateRuleHash,
        beforeViewportArtifactId: 'candidate-before',
        afterViewportArtifactId: 'candidate-after',
        beforeFullPageArtifactId: 'candidate-before-full-page',
        afterFullPageArtifactId: 'candidate-after-full-page',
        model: 'vision-model',
        rationale: 'The complete symptom disappeared and page integrity remained intact.',
        observedDamage: [],
    };
    const screenshots = {
        before: '/tmp/artifacts/candidate-before.png',
        after: '/tmp/artifacts/candidate-after.png',
        beforeFullPage: '/tmp/artifacts/candidate-before-full-page.png',
        afterFullPage: '/tmp/artifacts/candidate-after-full-page.png',
    };
    const environment: AgentRuntimeEnvironmentEvidence = {
        sessionId: 'prepared-session',
        targetUrl: 'https://example.com/article',
        extensionMode: 'prepared',
        profile: { ...browserProfile, userAgentProfile: 'Chromium' },
        selectedSettingsProfileKind: 'agent_selected',
        extension: cachedExtension(),
        ...(baseline === 'declared'
            ? { declaredBaselineListKeys: ['ublock:filters', 'easylist'] }
            : { settingsEvidence }),
        navigationVerified: true,
        fullVisionVerified: false,
        pageCaptures: [],
    };
    const binding: AgentRuntimeCandidateValidationBinding = {
        validationArtifactId,
        sessionId: environment.sessionId,
        extension: environment.extension!,
        ...(baseline === 'declared' ? {} : { settingsEvidence }),
        environment,
        visualReview,
        validationArtifact: {
            artifactId: validationArtifactId,
            path: `/tmp/artifacts/factual-validation-${validationHash}.json`,
        },
        visualReviewArtifact: {
            artifactId: `visual-review-${validationHash}`,
            path: `/tmp/artifacts/candidate-visual-review-${validationHash}.json`,
        },
        beforeViewport: { artifactId: 'candidate-before', path: screenshots.before },
        afterViewport: { artifactId: 'candidate-after', path: screenshots.after },
        beforeFullPage: {
            artifactId: 'candidate-before-full-page',
            path: screenshots.beforeFullPage,
        },
        afterFullPage: {
            artifactId: 'candidate-after-full-page',
            path: screenshots.afterFullPage,
        },
    };
    const selection: CandidateValidationSelection = {
        validationArtifactId,
        factualValidation: {},
        visualReview,
        visualReviewArtifactPath: binding.visualReviewArtifact.path,
        beforeScreenshotArtifactId: binding.beforeViewport.artifactId,
        afterScreenshotArtifactId: binding.afterViewport.artifactId,
        beforeFullPageScreenshotArtifactId: binding.beforeFullPage.artifactId,
        afterFullPageScreenshotArtifactId: binding.afterFullPage.artifactId,
        beforeScreenshotArtifactIds: [
            binding.beforeViewport.artifactId,
            binding.beforeFullPage.artifactId,
        ],
        afterScreenshotArtifactIds: [
            binding.afterViewport.artifactId,
            binding.afterFullPage.artifactId,
        ],
    };
    return { binding, selection, screenshots };
}

describe('runFixCore', () => {
    it('reports a run with no usable browser evidence as unavailable, never partial', () => {
        // A run that seals on an abort, an exhausted budget or a provider failure before any
        // browser evidence exists has verified nothing. 'partial' claims some verification was
        // done, so the browser-usable gate must come first for every ending and every status.
        for (const runStatus of ['failed', 'not_reproduced', 'already_fixed_current'] as const) {
            expect(deriveAgenticVerificationStatus(false, false, runStatus, false)).toBe(
                'unavailable',
            );
            expect(deriveAgenticVerificationStatus(false, false, runStatus, true)).toBe(
                'unavailable',
            );
        }
    });

    it('marks a completely proven current-extension fix as verified', () => {
        expect(deriveAgenticVerificationStatus(true, false, 'already_fixed_current', true)).toBe(
            'verified',
        );
        expect(deriveAgenticVerificationStatus(true, false, 'already_fixed_current', false)).toBe(
            'partial',
        );
        expect(deriveAgenticVerificationStatus(true, false, 'configuration_specific', true)).toBe(
            'verified',
        );
        expect(deriveAgenticVerificationStatus(true, false, 'configuration_specific', false)).toBe(
            'partial',
        );
    });

    it('rejects browser-off before starting the model-driven runtime', async () => {
        await expect(
            runFixCore(
                coreConfig(),
                { rawIssue: localIssue(), facts: localFacts() },
                {
                    artifactsDir: join(tmpdir(), 'fix-core-browser-off-must-not-run'),
                    browserMode: 'off',
                },
            ),
        ).rejects.toThrow('requires browser mode auto or on');
    });

    it('finalizes an owned environment at most once when final result validation fails', async () => {
        const root = mkdtempSync(join(tmpdir(), 'fix-core-single-finalize-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(filtersPath, { recursive: true });
        const actualContext = {
            kind: 'browser_extension' as const,
            product: 'AdGuard Browser Extension',
            browser: 'CloakBrowser Chromium',
            productVersion: '5.0.0',
        };
        const adapter: FilteringEnvironmentAdapter = {
            kind: 'browser_extension',
            capabilities: () => [],
            prepare: async () => ({
                ready: false,
                limitation: {
                    code: 'phase_open_failed',
                    stage: 'preparation',
                    detail: 'Not used.',
                },
            }),
            openPhase: async () => ({
                ready: false,
                limitation: { code: 'phase_open_failed', stage: 'phase', detail: 'Not used.' },
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
            snapshot: () => ({
                kind: 'browser_extension',
                lifecycle: 'ready',
                stateDigest: 'a'.repeat(64),
                actualContext,
                capabilities: [],
                preparation: null,
                baseline: null,
                openLeaseIds: [],
                cleanup: null,
            }),
        };
        const finalize = vi.fn().mockReturnValue({
            recorderVersion: 1 as const,
            runId: 'single-finalize',
            kind: 'browser_extension' as const,
            actualContext,
            capabilities: [],
            preparation: null,
            baseline: null,
            phases: [],
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
                status: 'inconclusive' as const,
                candidateDigest: null,
                failure: null,
            },
            secondaryFailures: [],
            disposition: { status: 'failed' as const, candidateDigest: null, failure: null },
        });
        try {
            await expect(
                runFixCore(
                    { ...coreConfig(), repositoryPath: filtersPath },
                    { rawIssue: localIssue(), facts: localFacts() },
                    {
                        artifactsDir: join(root, 'artifacts'),
                        browserMode: 'on',
                        agentRuntime: {},
                    },
                    {
                        environmentLifecycle: {
                            adapter,
                            recorder: { recordCleanup: vi.fn(), finalize },
                            disposition: {
                                status: 'failed',
                                candidateDigest: null,
                                failure: null,
                            },
                        },
                    },
                ),
            ).rejects.toThrow();
            expect(finalize).toHaveBeenCalledTimes(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it.each([
        ['AdGuard for Windows', 'Windows 11', 'Edge'],
        ['AdGuard for Mac', 'macOS 15', 'Safari'],
    ] as const)(
        'persists a capability-limited probe choice for %s without Extension fallback',
        async (product, os, browser) => {
            const root = mkdtempSync(join(tmpdir(), 'fix-core-agentic-cli-selection-'));
            const filtersPath = join(root, 'filters');
            mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
            writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
            const issue = {
                ...localIssue(),
                body: [
                    '### Issue URL (Ads)',
                    'https://example.com/article',
                    '',
                    '### System configuration',
                    `AdGuard product: | ${product}`,
                    `System version: | ${os}`,
                    `Browser: | ${browser}`,
                    'Filters: | AdGuard Base filter',
                ].join('\n'),
                labels: ['T: Ads', `N: ${product}`],
            };
            const facts: IssueFacts = {
                ...localFacts(),
                product,
                os,
                browser,
                labels: ['T: Ads', `N: ${product}`],
            };
            const piRuntime = await scriptedPiRuntime([
                toolCall('fetch_issue', { issueNumber: 4 }),
                toolCall('select_environment', environmentSelectionArgs(CORE_PROBE_NAME)),
                toolCall('finish_fix', {
                    outcome: 'analysis_only',
                    reasoning: 'The selected desktop executor could not be prepared.',
                }),
            ]);

            try {
                const result = await runFixCore(
                    { ...coreConfig(), repositoryPath: filtersPath },
                    { rawIssue: issue, facts },
                    {
                        artifactsDir: join(root, 'artifacts'),
                        browserMode: 'on',
                        agentRuntime: {},
                    },
                    {
                        piRuntime,
                        agentRuntime: {
                            createBaseRegistry: async () => new ToolRegistry(),
                            filteringExecutors: twoCoreExecutorRegistry(
                                preparableProbeExecutor({
                                    ready: false,
                                    limitation: {
                                        stage: 'prepare',
                                        code: 'probe_preparation_failed',
                                        detail: 'The probe desktop executor never became ready.',
                                    },
                                }),
                            ),
                        },
                    },
                );

                expect(result).toMatchObject({
                    runStatus: 'capability_limited',
                    effectiveMode: 'reasoning',
                    verificationStatus: 'unavailable',
                    candidatePatch: null,
                    environmentSelection: {
                        selectedKind: CORE_PROBE_NAME,
                        state: 'capability_limited',
                        declared: { issueFormType: 'Ads', labels: ['T: Ads', `N: ${product}`] },
                        reported: { product, os, browser },
                        observed: { issueType: 'ads' },
                        descriptor: {
                            availability: 'available',
                            preparationState: 'preparable',
                            limitationCode: null,
                            capabilities: ['cli_installation', 'cli_activation'],
                        },
                        cliPreparation: {
                            state: 'limited',
                            limitation: {
                                stage: 'prepare',
                                code: 'probe_preparation_failed',
                                detail: 'The probe desktop executor never became ready.',
                            },
                        },
                    },
                });
                expect(result).not.toHaveProperty('infrastructureFailureReason');
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        },
    );

    it('threads an accepted report_missing_information record into the run result', async () => {
        const root = mkdtempSync(join(tmpdir(), 'fix-core-missing-info-report-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
        const entry = {
            subject: 'The instruction lacks a contributing guide link',
            detail: 'The run cannot state where placement rules belong without it.',
        };
        const piRuntime = await scriptedPiRuntime([
            toolCall('fetch_issue', { issueNumber: 4 }),
            toolCall('select_environment', environmentSelectionArgs(CORE_PROBE_NAME)),
            toolCall('report_missing_information', entry),
            toolCall('finish_fix', {
                outcome: 'analysis_only',
                reasoning: 'The selected desktop executor could not be prepared.',
            }),
        ]);

        try {
            const result = await runFixCore(
                { ...coreConfig(), repositoryPath: filtersPath },
                { rawIssue: localIssue(), facts: localFacts() },
                {
                    artifactsDir: join(root, 'artifacts'),
                    browserMode: 'on',
                    agentRuntime: {},
                },
                {
                    piRuntime,
                    agentRuntime: { createBaseRegistry: async () => new ToolRegistry() },
                },
            );

            expect(result.missingInformation).toEqual([entry]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('threads an analysis-only candidate for review into the run result', async () => {
        // A sarkisozleri.bbs.tr run: apply_rule ran every phase, the review came back
        // inconclusive, and the rule the agent had found reached the issue comment only as prose.
        const root = mkdtempSync(join(tmpdir(), 'fix-core-candidate-for-review-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
        const candidateForReview = {
            rule: '||increase-rev.cv3-ecf.workers.dev^$domain=sarkisozleri.bbs.tr',
            placement: { filePath: 'BaseFilter/sections/foreign.txt' },
            unverifiedReason:
                'Lint and risk scoring accepted the rule, but the selected executor never ' +
                'became ready, so no experiment could confirm it.',
        };
        const piRuntime = await scriptedPiRuntime([
            toolCall('fetch_issue', { issueNumber: 4 }),
            toolCall('select_environment', environmentSelectionArgs(CORE_PROBE_NAME)),
            toolCall('finish_fix', {
                outcome: 'analysis_only',
                reasoning: 'The rule stands unverified because the environment never came up.',
                candidateForReview,
            }),
        ]);

        try {
            const result = await runFixCore(
                { ...coreConfig(), repositoryPath: filtersPath },
                { rawIssue: localIssue(), facts: localFacts() },
                {
                    artifactsDir: join(root, 'artifacts'),
                    browserMode: 'on',
                    agentRuntime: {},
                },
                {
                    piRuntime,
                    agentRuntime: {
                        createBaseRegistry: async () => new ToolRegistry(),
                        filteringExecutors: twoCoreExecutorRegistry(
                            preparableProbeExecutor({
                                ready: false,
                                limitation: {
                                    stage: 'prepare',
                                    code: 'probe_preparation_failed',
                                    detail: 'The probe desktop executor never became ready.',
                                },
                            }),
                        ),
                    },
                },
            );

            expect(result.candidateForReview).toEqual(candidateForReview);
            // An unverified candidate is still never a publishable patch.
            expect(result.candidatePatch).toBeNull();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('keeps the pre-candidate lint_rule gate from eating report_missing_information', async () => {
        const root = mkdtempSync(join(tmpdir(), 'fix-core-missing-info-gate-order-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
        const entry = {
            subject: 'The instruction lacks a syntax section for scriptlets',
            detail: 'The run cannot state how to write scriptlet rules without it.',
        };
        // The instruction registers a live guidance session, but the script never calls
        // lookup_rule_guidance — so the pre-candidate gate stays active for the whole run.
        const piRuntime = await scriptedPiRuntime([
            toolCall('fetch_issue', { issueNumber: 4 }),
            toolCall('select_environment', environmentSelectionArgs(CORE_PROBE_NAME)),
            toolCall('report_missing_information', entry),
            toolCall('lint_rule', {
                rule: 'example.com##.ad',
                filePath: 'BaseFilter/sections/foreign.txt',
            }),
            toolCall('finish_fix', {
                outcome: 'analysis_only',
                reasoning: 'The selected desktop executor could not be prepared.',
            }),
        ]);

        try {
            const result = await runFixCore(
                { ...coreConfig(), repositoryPath: filtersPath },
                { rawIssue: localIssue(), facts: localFacts() },
                {
                    artifactsDir: join(root, 'artifacts'),
                    browserMode: 'on',
                    instruction: runInstructionFixture(),
                    // The repository lint command is what offers lint_rule at all.
                    repositoryLint: { command: 'true', checkoutRoot: filtersPath },
                    agentRuntime: {},
                },
                {
                    piRuntime,
                    // The real factory builds the base registry here: creating an empty one would
                    // skip the guidance registration this test exists to gate against. The
                    // instruction option resolves to the guidance source that activates the
                    // pre-candidate gate on lint_rule from the first turn.
                    agentRuntime: {
                        filteringExecutors: twoCoreExecutorRegistry(
                            preparableProbeExecutor({
                                ready: false,
                                limitation: {
                                    stage: 'prepare',
                                    code: 'probe_preparation_failed',
                                    detail: 'The probe desktop executor never became ready.',
                                },
                            }),
                        ),
                    },
                },
            );

            // The gate ordering, read from the sealed trace: the report went through whole (the
            // echoed entry, not a gate refusal) while the gated lint_rule call in the very next
            // turn was refused for want of a lookup_rule_guidance call — proving the gate was
            // active at report time and never ate it.
            const trace = JSON.parse(readFileSync(result.artifactPaths.trace!, 'utf8'));
            const toolResults = trace.events.filter(
                (event: { type: string }) => event.type === 'tool_result',
            );
            const reportResult = toolResults.find(
                (event: { payload: { tool: string } }) =>
                    event.payload.tool === ToolName.ReportMissingInformation,
            );
            expect(reportResult?.payload.result).toEqual(entry);
            const lintResult = toolResults.find(
                (event: { payload: { tool: string } }) => event.payload.tool === ToolName.LintRule,
            );
            expect(lintResult?.payload.result.requiredTool).toBe(ToolName.LookupRuleGuidance);

            expect(result.missingInformation).toEqual([entry]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('records the not-linked guidance notice without the model calling the report tool', async () => {
        const root = mkdtempSync(join(tmpdir(), 'fix-core-missing-info-notice-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
        const noticeRecord = {
            subject: 'No syntax document is linked for rule guidance topic element_hiding',
            detail:
                'Rule guidance topic element_hiding is defined by the run instruction syntax ' +
                'document(s), but the instruction at AGENTS.md links no role documents at all.',
        };
        const baseRegistry = new ToolRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'lookup_rule_guidance',
                    description: 'Serve rule guidance for the run.',
                    parameters: {
                        type: 'object',
                        properties: { topic: { type: 'string' } },
                        required: ['topic'],
                    },
                },
            },
            handler: async () => ({
                topic: 'element_hiding',
                guidance:
                    'No syntax document is linked by this run instruction, so the element_hiding ' +
                    'topic has no authoritative text to serve. Record exactly what is missing.',
                maxCharacters: 8000,
                citations: [],
                notice: 'not_linked',
                missingInformation: noticeRecord,
            }),
        });
        const piRuntime = await scriptedPiRuntime([
            toolCall('fetch_issue', { issueNumber: 4 }),
            toolCall('select_environment', environmentSelectionArgs(CORE_PROBE_NAME)),
            toolCall('lookup_rule_guidance', { topic: 'element_hiding' }),
            toolCall('finish_fix', {
                outcome: 'analysis_only',
                reasoning: 'The selected desktop executor could not be prepared.',
            }),
        ]);

        try {
            const result = await runFixCore(
                { ...coreConfig(), repositoryPath: filtersPath },
                { rawIssue: localIssue(), facts: localFacts() },
                {
                    artifactsDir: join(root, 'artifacts'),
                    browserMode: 'on',
                    agentRuntime: {},
                },
                {
                    piRuntime,
                    agentRuntime: { createBaseRegistry: async () => baseRegistry },
                },
            );

            expect(result.missingInformation).toEqual([noticeRecord]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('keeps a phase-bootstrap death free of capability and infrastructure verdicts', async () => {
        const root = mkdtempSync(join(tmpdir(), 'fix-core-phase-bootstrap-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
        const piRuntime = await scriptedPiRuntime([
            toolCall('fetch_issue', { issueNumber: 4 }),
            toolCall('select_environment', environmentSelectionArgs()),
            toolCall('lookup_rule_guidance', { topic: 'element_hiding' }),
            toolCall('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://example.com/article',
                profile: browserProfile,
                settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
            }),
            toolCall('apply_rule', { candidateRule: 'example.com##.articleAdSlot' }),
            toolCall('finish_fix', {
                outcome: 'analysis_only',
                reasoning:
                    'The candidate example.com##.articleAdSlot was built, but the ' +
                    'phase browser session died during extension bootstrap, so ' +
                    'verification was skipped.',
            }),
            toolCall('finish_fix', {
                outcome: 'analysis_only',
                reasoning:
                    'The candidate example.com##.articleAdSlot was built, but the ' +
                    'phase browser session died during extension bootstrap, so ' +
                    'verification was skipped.',
            }),
            toolCall('finish_fix', {
                outcome: 'analysis_only',
                reasoning:
                    'The candidate example.com##.articleAdSlot was built, but the ' +
                    'phase browser session died during extension bootstrap, so ' +
                    'verification was skipped.',
            }),
        ]);
        const baseRegistry = new ToolRegistry();
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
        const createBrowserSession = vi.fn(async (config: BrowserSessionConfig) => {
            if (config.extensionReadinessBudgetMs !== undefined) {
                expect(config.extensionReadinessBudgetMs).toBe(90_000);
                throw new BrowserConfigurationError(
                    'Failed to apply AdGuard settings: AdGuard app did not finish ' +
                        'initialization after 893 probes over 90000ms.',
                    new Error('AdGuard fresh-install bootstrap is still running.'),
                    'settings_apply_failed',
                );
            }
            return {
                close: vi.fn(),
                getConsoleLog: () => [],
                consoleCoverage: ConsoleCoverage.BrowserLogOnly,
                extensionContext: fakeExtensionContext(),
            } as unknown as BrowserSession;
        });
        const actualContext = {
            kind: 'browser_extension' as const,
            product: 'AdGuard Browser Extension',
            browser: 'CloakBrowser Chromium',
            productVersion: '5.4.3',
        };
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
            baseline: null,
            openLeaseIds: [],
            cleanup: cleanupReceipt,
        });
        let environmentOptions: NonNullable<ExecutorAdapterContext['extensionOptions']> | undefined;
        const adapter: FilteringEnvironmentAdapter = {
            kind: 'browser_extension',
            capabilities: () => ['browser_navigation', 'filtering_control'],
            prepare: async () => ({ ready: true, state: adapterState() }),
            openPhase: async (request) => {
                // Deviation from the real adapter: phase A carries the extension root too, so
                // the very first opened phase exercises the raised readiness budget and dies in
                // extension bootstrap without needing the full A-observation machinery.
                try {
                    await environmentOptions!.createSession({
                        phase: request.phase,
                        targetUrl: request.targetUrl,
                        extensionRoot: '/tmp/extension-cache/extension',
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
        try {
            const config = { ...coreConfig(), repositoryPath: filtersPath };
            const result = await runFixCore(
                config,
                { rawIssue: localIssue(), facts: localFacts() },
                {
                    artifactsDir: join(root, 'artifacts'),
                    browserMode: 'on',
                    agentRuntime: {},
                },
                {
                    piRuntime,
                    agentRuntime: {
                        ...launchReadBackDependencies([2]),
                        createBaseRegistry: async () => baseRegistry,
                        createBrowserSession,
                        createBrowserRegistry: async () => {
                            const registry = new ToolRegistry();
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
                            environmentOptions = context.extensionOptions!;
                            return adapter;
                        }),
                    },
                },
            );

            // This harness lacks the full capture-and-vision fixture, so the scripted finish is
            // rejected until the host publishes the analysis — which is exactly what makes the
            // classification contract visible: the environment fault must not surface as a
            // capability verdict (which would terminally complete the live issue as unsupported)
            // nor as an infrastructure reason (which would schedule automatic retries).
            expect(result).toMatchObject({
                runStatus: 'analysis_only',
                candidatePatch: null,
            });
            expect(result).not.toHaveProperty('infrastructureFailureReason');
            expect(result.environmentSelection?.state).toBe('ready');
            // Exactly one phase session died in bootstrap under the raised budget: the typed
            // finish_fix_analysis_only guidance forbids blind relaunches.
            const phaseAttempts = createBrowserSession.mock.calls.filter(
                ([sessionConfig]) => sessionConfig.extensionReadinessBudgetMs !== undefined,
            );
            expect(phaseAttempts).toHaveLength(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('persists an unsupported product-case selection as a terminal product outcome', async () => {
        const root = mkdtempSync(join(tmpdir(), 'fix-core-agentic-unsupported-selection-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
        const piRuntime = await scriptedPiRuntime([
            toolCall('fetch_issue', { issueNumber: 4 }),
            toolCall('select_environment', environmentSelectionArgs('unsupported_product_case')),
            toolCall('finish_fix', {
                outcome: 'analysis_only',
                reasoning: 'The report concerns an unsupported product UI capability.',
            }),
        ]);

        try {
            const result = await runFixCore(
                { ...coreConfig(), repositoryPath: filtersPath },
                { rawIssue: localIssue(), facts: localFacts() },
                {
                    artifactsDir: join(root, 'artifacts'),
                    browserMode: 'on',
                    agentRuntime: {},
                },
                {
                    piRuntime,
                    agentRuntime: {
                        createBaseRegistry: async () => new ToolRegistry(),
                        filteringExecutors: twoCoreExecutorRegistry(
                            preparableProbeExecutor({
                                ready: true,
                                provenance: {
                                    source: 'official_release',
                                    product: 'Probe product',
                                    version: '1.0.0',
                                    digestB32: 'digestb32examplevalue0123456789abcdefghijk',
                                },
                            }),
                        ),
                    },
                },
            );

            expect(result).toMatchObject({
                runStatus: 'unsupported_product_case',
                candidatePatch: null,
                environmentSelection: {
                    selectedKind: 'unsupported_product_case',
                    state: 'unsupported',
                    descriptor: null,
                    actual: null,
                },
            });
            expect(result).not.toHaveProperty('infrastructureFailureReason');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('serializes candidate proof only from one exact prepared browser session', () => {
        const fixture = candidateBindingFixture();

        expect(
            serializeVerifiedCandidateBinding(
                fixture.binding,
                fixture.selection,
                fixture.screenshots,
            ),
        ).toMatchObject({
            validationArtifactId: fixture.binding.validationArtifactId,
            sessionId: 'prepared-session',
            settingsEvidence: { enabledListKeys: ['adguard:2'] },
            beforeViewport: fixture.binding.beforeViewport,
            afterFullPage: fixture.binding.afterFullPage,
        });

        expect(
            serializeVerifiedCandidateBinding(
                {
                    ...fixture.binding,
                    environment: {
                        ...fixture.binding.environment,
                        sessionId: 'different-prepared-session',
                    },
                },
                fixture.selection,
                fixture.screenshots,
            ),
        ).toBeUndefined();
        expect(
            serializeVerifiedCandidateBinding(fixture.binding, fixture.selection, {
                ...fixture.screenshots,
                after: '/tmp/artifacts/other-session-after.png',
            }),
        ).toBeUndefined();
    });

    it('serializes candidate proof for a session credited by a declared baseline', () => {
        // A blocker that declares its own list selection (uBlock Origin in Firefox) has no live
        // state to read back: the declared keys are its published settings, on the bound session
        // and on the binding alike, so the result-schema invariant tying the two holds.
        const fixture = candidateBindingFixture('declared');

        const evidence = serializeVerifiedCandidateBinding(
            fixture.binding,
            fixture.selection,
            fixture.screenshots,
        );

        expect(evidence?.settingsEvidence).toEqual({
            profileKind: 'agent_selected',
            enabledListKeys: ['ublock:filters', 'easylist'],
            activeRulesetListKeys: null,
            stealthEnabled: null,
            limitsExceeded: false,
        });
        expect(
            agenticRunEvidence.serializeAgentBrowserSessions([fixture.binding.environment])[0]
                ?.settingsEvidence,
        ).toEqual(evidence?.settingsEvidence);
        expect(
            agenticRunEvidence.describeVerifiedCandidateBindingFailure(
                fixture.binding,
                fixture.selection,
                fixture.screenshots,
            ),
        ).toEqual([]);
    });

    it('names the baseline drift that refuses a verified review', () => {
        const fixture = candidateBindingFixture();
        const reportedUrl = 'https://example.com/article';
        const expectedContext = {
            reportedUrl,
            existingRules: [],
            baselineHash: calculateTrustedBaselineHash(reportedUrl, []),
        };
        const factual = {
            trustedValidationContext: {
                reportedUrl,
                baselineHash: 'a'.repeat(64),
                existingRuleCount: 1,
            },
        };

        const refusal = candidatePatchVerificationRefusal(
            factual,
            { rule: 'example.com##.ad-slot' } as CandidatePatch,
            expectedContext,
            fixture.binding.visualReview,
        );

        expect(refusal).toContain('recorded baseline (1 rules');
        expect(refusal).toContain('verdict-time baseline (0 rules');
    });

    it('lets the model report browser unavailability despite the legacy scope gate', async () => {
        const root = mkdtempSync(join(tmpdir(), 'fix-core-agentic-scope-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
        const launchOne = {
            extension: 'none',
            targetUrl: 'https://example.com/article',
            profile: browserProfile,
        };
        const piRuntime = await scriptedPiRuntime([
            toolCall('fetch_issue', { issueNumber: 4 }),
            toolCall('select_environment', environmentSelectionArgs()),
            toolCall('launch_browser', launchOne),
            toolCall('launch_browser', launchOne),
            toolCall('launch_browser', launchOne),
            toolCall('finish_fix', {
                outcome: 'analysis_only',
                reasoning: 'Chromium remained unavailable after the bounded retries.',
            }),
        ]);
        const issue = {
            ...localIssue(),
            facts: localFacts(),
            labels: ['T: Other'],
        };
        let agentRunArtifacts: AgentRunArtifacts | undefined;
        try {
            const result = await runFixCore(
                { ...coreConfig(), repositoryPath: filtersPath },
                { rawIssue: issue, facts: localFacts() },
                {
                    artifactsDir: join(root, 'artifacts'),
                    browserMode: 'on',
                    agentRuntime: {},
                },
                {
                    piRuntime,
                    agentRuntime: {
                        createBaseRegistry: async () => new ToolRegistry(),
                        createBrowserSession: async () => {
                            throw new Error('Chromium is unavailable');
                        },
                    },
                    onAgentRunArtifacts: (artifacts) => {
                        agentRunArtifacts = artifacts;
                    },
                },
            );

            expect(hermetic!.requests).toHaveLength(6);
            expect(result).toMatchObject({
                runStatus: 'browser_unavailable',
                reasoning: 'Chromium remained unavailable after the bounded retries.',
            });
            expect(agentRunArtifacts).toMatchObject({
                decision: {
                    outcome: 'analysis_only',
                    reasoning: 'Chromium remained unavailable after the bounded retries.',
                },
                observations: expect.arrayContaining([
                    expect.objectContaining({ tool: 'fetch_issue' }),
                    expect.objectContaining({ tool: 'launch_browser' }),
                ]),
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('removes hidden metadata and all comments without immutable reporter identity', async () => {
        const root = mkdtempSync(join(tmpdir(), 'fix-core-prompt-boundary-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
        const humanFixCommit = '1'.repeat(40);
        const piRuntime = await scriptedPiRuntime([
            toolCall('fetch_issue', { issueNumber: 4 }),
            toolCall('finish_fix', {
                outcome: 'analysis_only',
                reasoning: 'No safe browser-verified patch.',
            }),
            toolCall('finish_fix', {
                outcome: 'analysis_only',
                reasoning: 'No safe browser-verified patch.',
            }),
            toolCall('finish_fix', {
                outcome: 'analysis_only',
                reasoning: 'No safe browser-verified patch.',
            }),
        ]);
        const issue: RawIssue = {
            ...localIssue(),
            body: `${localIssue().body}\n\n<!-- adguard-agent-benchmark: ${JSON.stringify({
                filtersBaseSha: '2'.repeat(40),
                humanFixCommit,
            })} -->`,
            comments: [
                {
                    author: 'reporter',
                    body: 'The empty advertising space is still visible after a reload.',
                    createdAt: '2026-01-01T00:00:00Z',
                },
                {
                    author: 'reporter',
                    body: 'Fixed with example.com##.ad-slot',
                    createdAt: '2026-01-02T00:00:00Z',
                },
                {
                    author: 'maintainer',
                    body: `Implemented in commit ${humanFixCommit}.`,
                    createdAt: '2026-01-03T00:00:00Z',
                },
            ],
        };
        try {
            const result = await runFixCore(
                { ...coreConfig(), repositoryPath: filtersPath },
                { rawIssue: issue, facts: localFacts() },
                {
                    artifactsDir: join(root, 'artifacts'),
                    browserMode: 'on',
                    agentRuntime: {},
                },
                {
                    piRuntime,
                    agentRuntime: { createBaseRegistry: async () => new ToolRegistry() },
                },
            );
            const recordedBodies = hermetic!.requests.map((request) =>
                JSON.stringify(request.messages),
            );
            expect(recordedBodies.join('\n')).toContain('Ad placeholder remains visible');
            expect(recordedBodies.join('\n')).not.toContain(humanFixCommit);
            expect(readFileSync(result.artifactPaths.trace!, 'utf8')).not.toContain(humanFixCommit);
            expect(JSON.stringify(result)).not.toContain(humanFixCommit);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('keeps structured reports from an already prompt-safe direct issue input', async () => {
        const root = mkdtempSync(join(tmpdir(), 'fix-core-prompt-safe-comments-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
        const piRuntime = await scriptedPiRuntime([
            toolCall('fetch_issue', { issueNumber: 4 }),
            toolCall('finish_fix', {
                outcome: 'analysis_only',
                reasoning: 'The prompt-safe report was inspected.',
            }),
            toolCall('finish_fix', {
                outcome: 'analysis_only',
                reasoning: 'The prompt-safe report was inspected.',
            }),
            toolCall('finish_fix', {
                outcome: 'analysis_only',
                reasoning: 'The prompt-safe report was inspected.',
            }),
        ]);
        const browserExtensionReport = [
            '### Issue URL (Ads)',
            'https://www.reddit.com/r/example',
            '',
            '### System configuration',
            'AdGuard product: | AdGuard Browser Extension v5.4.3.102 MV3',
            '',
            '### Issue configuration',
            '[Import](https://reports.adguard.com/settings/import.html?' +
                'product_type=ext&product_version=5.4.3.102&ext.manifest_version=3)',
        ].join('\n');
        const promptSafeIssue: FixCoreIssueInput = {
            ...localIssue(),
            facts: localFacts(),
            title: 'www.reddit.com',
            body: [
                '### Issue URL (Annoyance)',
                'https://www.reddit.com/',
                '',
                '### System configuration',
                'AdGuard product: | AdGuard for Android v4.12.3',
            ].join('\n'),
            comments: [
                {
                    author: 'adguard-bot',
                    body: browserExtensionReport,
                    createdAt: '2026-07-20T08:00:44Z',
                },
            ],
        };

        try {
            const result = await runFixCore(
                { ...coreConfig(), repositoryPath: filtersPath },
                promptSafeIssue,
                {
                    artifactsDir: join(root, 'artifacts'),
                    browserMode: 'on',
                    agentRuntime: {},
                },
                {
                    piRuntime,
                    agentRuntime: { createBaseRegistry: async () => new ToolRegistry() },
                },
            );

            const recordedBodies = hermetic!.requests.map((request) =>
                JSON.stringify(request.messages),
            );
            expect(recordedBodies.join('\n')).toContain('AdGuard for Android v4.12.3');
            expect(recordedBodies.join('\n')).toContain('AdGuard Browser Extension v5.4.3.102 MV3');
            expect(readFileSync(result.artifactPaths.trace!, 'utf8')).toContain(
                'AdGuard Browser Extension v5.4.3.102 MV3',
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('does not verify a no-patch decision from a browser launch without page vision evidence', async () => {
        const root = mkdtempSync(join(tmpdir(), 'fix-core-agentic-no-patch-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
        const piRuntime = await scriptedPiRuntime([
            toolCall('fetch_issue', { issueNumber: 4 }),
            toolCall('select_environment', environmentSelectionArgs()),
            toolCall('launch_browser', {
                extension: 'none',
                targetUrl: 'https://example.com/article',
                profile: browserProfile,
            }),
            toolCall('open_page', { url: 'https://example.com/article' }),
            toolCall('screenshot', { captureTiles: true }),
            toolCall('analyze_screenshot', {
                artifactId: 'full-page',
                prompt: 'Inspect the full-page overview.',
            }),
            toolCall('analyze_screenshot', {
                artifactId: 'page-tile',
                prompt: 'Inspect this original-resolution tile.',
            }),
            toolCall('finish_fix', {
                outcome: 'resolve_without_patch',
                runStatus: 'not_reproduced',
                reasoning: 'The model claims the symptom was absent, with control captures.',
                evidenceSummary: 'The captures all ran on the unfiltered control session.',
            }),
            { kind: ScriptedReplyKind.Text, text: 'The finish was rejected; collecting more.' },
            { kind: ScriptedReplyKind.Text, text: 'Still no terminal decision.' },
        ]);
        let agentRunArtifacts: AgentRunArtifacts | undefined;
        try {
            const result = await runFixCore(
                { ...coreConfig(), repositoryPath: filtersPath },
                { rawIssue: localIssue(), facts: localFacts() },
                {
                    artifactsDir: join(root, 'artifacts'),
                    browserMode: 'on',
                    agentRuntime: {},
                },
                {
                    piRuntime,
                    agentRuntime: {
                        createBaseRegistry: async () => {
                            const registry = new ToolRegistry();
                            registry.register({
                                definition: {
                                    type: 'function',
                                    function: {
                                        name: 'analyze_screenshot',
                                        description: 'Analyze a screenshot',
                                        parameters: { type: 'object', properties: {} },
                                    },
                                },
                                handler: async () => ({
                                    analysis: 'The complete page was visually inspected.',
                                }),
                            });
                            return registry;
                        },
                        createBrowserSession: async () =>
                            ({
                                close: vi.fn(),
                                getConsoleLog: () => [],
                                consoleCoverage: ConsoleCoverage.BrowserLogOnly,
                            }) as unknown as BrowserSession,
                        createBrowserRegistry: async ({ recorder }) => {
                            const registry = new ToolRegistry();
                            registry.register({
                                definition: {
                                    type: 'function',
                                    function: {
                                        name: 'open_page',
                                        description: 'Open the target page',
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
                                        description: 'Capture the complete page',
                                        parameters: { type: 'object', properties: {} },
                                    },
                                },
                                handler: async () => {
                                    recorder.addArtifact({
                                        id: 'viewport',
                                        path: join(root, 'artifacts', 'viewport.png'),
                                        type: 'screenshot',
                                        bytes: 10,
                                    });
                                    recorder.addArtifact({
                                        id: 'full-page',
                                        path: join(root, 'artifacts', 'full-page.png'),
                                        type: 'screenshot-full-page',
                                        bytes: 20,
                                    });
                                    recorder.addArtifact({
                                        id: 'page-tile',
                                        path: join(root, 'artifacts', 'page-tile.png'),
                                        type: 'screenshot-tile',
                                        bytes: 10,
                                    });
                                    return {
                                        artifactId: 'viewport',
                                        fullPageArtifactId: 'full-page',
                                        tileCoverage: {
                                            complete: true,
                                            tiles: [{ artifactId: 'page-tile' }],
                                        },
                                    };
                                },
                            });
                            return registry;
                        },
                        filteringExecutors: twoCoreExecutorRegistry(
                            preparableProbeExecutor({
                                ready: true,
                                provenance: {
                                    source: 'official_release',
                                    product: 'Probe product',
                                    version: '1.0.0',
                                    digestB32: 'digestb32examplevalue0123456789abcdefghijk',
                                },
                            }),
                        ),
                    },
                    onAgentRunArtifacts: (artifacts) => {
                        agentRunArtifacts = artifacts;
                    },
                },
            );

            // Complete page vision captured on the unfiltered control never verifies a no-patch
            // decision: the host keeps rejecting the terminal while no prepared extension
            // session holds the current-build vision evidence, and the run seals host-side.
            expect(result).toMatchObject({
                runStatus: 'failed',
                agentTerminationReason: 'terminal_not_called',
                effectiveMode: 'browser',
                verificationStatus: 'partial',
                symptomObservation: 'indeterminate',
                browserSessions: [
                    {
                        targetUrl: 'https://example.com/article',
                        extensionMode: 'none',
                        navigationVerified: true,
                        fullVisionVerified: true,
                        captures: [
                            {
                                visionVerified: true,
                                viewportArtifactId: 'viewport',
                                fullPageOverviewArtifactId: 'full-page',
                                tileArtifactIds: ['page-tile'],
                            },
                        ],
                    },
                ],
            });
            expect(agentRunArtifacts?.decision).toBeNull();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('verifies a no-patch decision only after navigated full-page and tile vision evidence', async () => {
        const root = mkdtempSync(join(tmpdir(), 'fix-core-agentic-no-patch-verified-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
        const piRuntime = await scriptedPiRuntime([
            toolCall('fetch_issue', { issueNumber: 4 }),
            toolCall('select_environment', environmentSelectionArgs()),
            toolCall('launch_browser', {
                extension: 'none',
                targetUrl: 'https://example.com/article',
                profile: {
                    ...browserProfile,
                    geolocation: { latitude: 52.2297, longitude: 21.0122 },
                },
            }),
            toolCall('open_page', { url: 'https://example.com/article' }),
            toolCall('screenshot', { captureTiles: true }),
            toolCall('analyze_screenshot', {
                artifactId: 'full-page',
                prompt: 'Inspect the full-page overview.',
            }),
            toolCall('analyze_screenshot', {
                artifactId: 'tile-1',
                prompt: 'Inspect the original-resolution tile.',
            }),
            toolCall('finish_fix', {
                outcome: 'resolve_without_patch',
                runStatus: 'not_reproduced',
                reasoning: 'Vision found no instance of the reporter-defined defect.',
                evidenceSummary: 'Complete overview and tile coverage inspected.',
            }),
            { kind: ScriptedReplyKind.Text, text: 'The finish was rejected; collecting more.' },
            { kind: ScriptedReplyKind.Text, text: 'Still no terminal decision.' },
        ]);
        const baseRegistry = new ToolRegistry();
        baseRegistry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'analyze_screenshot',
                    description: 'Analyze screenshot',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ analysis: 'The reporter-defined defect is absent.' }),
        });
        try {
            const result = await runFixCore(
                { ...coreConfig(), repositoryPath: filtersPath },
                { rawIssue: localIssue(), facts: localFacts() },
                {
                    artifactsDir: join(root, 'artifacts'),
                    browserMode: 'on',
                    agentRuntime: {},
                },
                {
                    piRuntime,
                    agentRuntime: {
                        createBaseRegistry: async () => baseRegistry,
                        createBrowserSession: async () =>
                            ({
                                close: vi.fn(),
                                getConsoleLog: () => [],
                                consoleCoverage: ConsoleCoverage.BrowserLogOnly,
                            }) as unknown as BrowserSession,
                        createBrowserRegistry: async ({ recorder }) => {
                            const browserRegistry = new ToolRegistry();
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
                                        description: 'Capture page',
                                        parameters: { type: 'object', properties: {} },
                                    },
                                },
                                handler: async () => {
                                    recorder.addArtifact({
                                        id: 'viewport',
                                        path: join(root, 'artifacts', 'viewport.png'),
                                        type: 'screenshot',
                                        bytes: 10,
                                    });
                                    recorder.addArtifact({
                                        id: 'full-page',
                                        path: join(root, 'artifacts', 'full-page.png'),
                                        type: 'screenshot-full-page',
                                        bytes: 20,
                                    });
                                    recorder.addArtifact({
                                        id: 'tile-1',
                                        path: join(root, 'artifacts', 'tile-1.png'),
                                        type: 'screenshot-tile',
                                        bytes: 10,
                                    });
                                    return {
                                        artifactId: 'viewport',
                                        fullPageArtifactId: 'full-page',
                                        tileCoverage: {
                                            complete: true,
                                            tiles: [{ artifactId: 'tile-1' }],
                                        },
                                    };
                                },
                            });
                            return browserRegistry;
                        },
                        filteringExecutors: twoCoreExecutorRegistry(
                            preparableProbeExecutor({
                                ready: true,
                                provenance: {
                                    source: 'official_release',
                                    product: 'Probe product',
                                    version: '1.0.0',
                                    digestB32: 'digestb32examplevalue0123456789abcdefghijk',
                                },
                            }),
                        ),
                    },
                },
            );

            expect(result).toMatchObject({
                effectiveMode: 'browser',
                verificationStatus: 'partial',
                symptomObservation: 'indeterminate',
                browserSessions: [
                    {
                        targetUrl: 'https://example.com/article',
                        extensionMode: 'none',
                        profile: {
                            ...browserProfile,
                            geolocation: { latitude: 52.2297, longitude: 21.0122 },
                            userAgentProfile: 'Chromium',
                        },
                        fullVisionVerified: true,
                        captures: [
                            {
                                visionVerified: true,
                                reporterSymptomPresence: null,
                                viewportArtifactId: 'viewport',
                                fullPageOverviewArtifactId: 'full-page',
                                tileArtifactIds: ['tile-1'],
                            },
                        ],
                    },
                ],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('lets one stateful agent select the extension and reporter settings', async () => {
        const root = mkdtempSync(join(tmpdir(), 'fix-core-agentic-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
        const piRuntime = await scriptedPiRuntime([
            toolCall('fetch_issue', { issueNumber: 4 }),
            toolCall('select_environment', environmentSelectionArgs()),
            toolCall('launch_browser', {
                extension: 'none',
                targetUrl: 'https://example.com/article',
                profile: browserProfile,
            }),
            toolCall('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://example.com/article',
                profile: browserProfile,
                settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
            }),
            toolCall('finish_fix', {
                outcome: 'analysis_only',
                reasoning: 'The environment was reproduced but no safe rule was found.',
            }),
            { kind: ScriptedReplyKind.Text, text: 'The terminal submission was rejected.' },
            { kind: ScriptedReplyKind.Text, text: 'No terminal decision.' },
        ]);
        const browserConfigs: BrowserSessionConfig[] = [];
        const createBrowserSession = vi.fn(async (config: BrowserSessionConfig) => {
            browserConfigs.push(config);
            void config;
            return {
                close: vi.fn(),
                getConsoleLog: () => [],
                consoleCoverage: ConsoleCoverage.BrowserLogOnly,
                extensionContext: fakeExtensionContext(),
            } as unknown as BrowserSession;
        });
        const createBrowserRegistry = vi.fn(async () => {
            const registry = new ToolRegistry();
            registry.register({
                definition: {
                    type: 'function',
                    function: {
                        name: 'browser_fact',
                        description: 'Read one browser fact',
                        parameters: { type: 'object', properties: {} },
                    },
                },
                handler: async () => ({ ok: true }),
            });
            return registry;
        });
        try {
            const config = { ...coreConfig(), repositoryPath: filtersPath };
            const result = await runFixCore(
                config,
                { rawIssue: localIssue(), facts: localFacts() },
                {
                    artifactsDir: join(root, 'artifacts'),
                    browserMode: 'on',
                    agentRuntime: {},
                },
                {
                    piRuntime,
                    agentRuntime: {
                        ...launchReadBackDependencies([2]),
                        createBaseRegistry: async () => new ToolRegistry(),
                        createBrowserSession,
                        createBrowserRegistry,
                        filteringExecutors: twoCoreExecutorRegistry(
                            preparableProbeExecutor({
                                ready: true,
                                provenance: {
                                    source: 'official_release',
                                    product: 'Probe product',
                                    version: '1.0.0',
                                    digestB32: 'digestb32examplevalue0123456789abcdefghijk',
                                },
                            }),
                        ),
                    },
                },
            );

            // No instruction: the host prepared the run's one build from the pinned-release seam
            // before the runtime existed — exactly one attempt, then the launch wiring boards it.
            expect(pinnedReleaseSeamMock).toHaveBeenCalledTimes(1);
            expect(browserConfigs).toHaveLength(2);
            expect(browserConfigs[0]).toMatchObject({
                headless: true,
                reproProfile: { ...browserProfile, userAgentProfile: 'Chromium' },
            });
            expect(browserConfigs[0]).not.toHaveProperty('adguardExtensionPath');
            // The prepared launch is plain — the exact build with no
            // host-applied settings profile.
            expect(browserConfigs[1]).toMatchObject({
                headless: true,
                adguardExtensionPath: PINNED_RELEASE_FIXTURE_DIR,
            });
            expect(browserConfigs[1]).not.toHaveProperty('extensionSettingsProfile');
            // The frozen surface advertises the selection and lifecycle tools from the first
            // request; browser-session tools are advertised the whole time and refuse the call
            // with the typed gate refusal until the session exists (byte-identical list). No
            // preparation tool is advertised: the extension is already host-prepared.
            const advertised = hermetic!.requests.map((request) => JSON.stringify(request.tools));
            expect(new Set(advertised).size).toBe(1);
            const firstTools = (
                hermetic!.requests[0]!.tools as {
                    function: { name: string };
                }[]
            ).map((tool) => tool.function.name);
            expect(firstTools).toContain('select_environment');
            expect(firstTools).not.toContain('browser_fact');
            const providerVisibleTask = JSON.stringify(hermetic!.requests[0]!.messages);
            expect(providerVisibleTask).toMatch(/selection-first/u);
            expect(providerVisibleTask).toMatch(/automatically resolves, verifies, installs/u);
            expect(providerVisibleTask).toMatch(/unsupported_product_case/u);
            expect(result).toMatchObject({
                runStatus: 'failed',
                agentTerminationReason: 'terminal_not_called',
                effectiveMode: 'reasoning',
                // The run's settings fact is the launch read-back record; the results layer
                // projects it into the applied-settings fields of the run evidence.
                reproductionSettingsStatus: 'applied',
                environmentSelection: {
                    selectedKind: 'browser_extension',
                    state: 'ready',
                    declared: {
                        issueFormType: 'Ads',
                        labels: ['T: Ads', 'N: AdGuard Browser Extension'],
                    },
                    reported: {
                        product: 'AdGuard Browser Extension v5.4.3',
                    },
                    observed: {
                        issueType: 'ads',
                    },
                    actual: {
                        kind: 'browser_extension',
                        product: 'AdGuard Browser Extension',
                        browser: 'CloakBrowser Chromium',
                        productVersion: '5.5.2.3',
                    },
                },
                extensionProvenance: {
                    source: 'pinned_release',
                    extensionPath: PINNED_RELEASE_FIXTURE_DIR,
                    manifestVersion: 3,
                    extensionSourceSha256: 'e'.repeat(64),
                    extensionSourceTag: PINNED_RELEASE_FIXTURE_TAG,
                },
                browserSessions: [
                    {
                        targetUrl: 'https://example.com/article',
                        extensionMode: 'none',
                        profile: { ...browserProfile, userAgentProfile: 'Chromium' },
                    },
                    {
                        targetUrl: 'https://example.com/article',
                        extensionMode: 'prepared',
                        profile: { ...browserProfile, userAgentProfile: 'Chromium' },
                        selectedSettingsProfileKind: 'agent_selected',
                    },
                ],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it.each([
        'navigation_timeout',
        'target_unreachable',
        'not_found',
        'http_blocked',
        'bot_challenge',
        'geo_blocked',
        'empty_dom',
    ] as const)(
        'classifies target-environment fallback %s separately from infrastructure failure',
        async (fallbackReason) => {
            const root = mkdtempSync(join(tmpdir(), 'fix-core-agentic-target-fallback-'));
            const filtersPath = join(root, 'filters');
            mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
            writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
            const launchNone = {
                extension: 'none',
                targetUrl: 'https://example.com/article',
                profile: browserProfile,
            };
            const piRuntime = await scriptedPiRuntime([
                toolCall('fetch_issue', { issueNumber: 4 }),
                toolCall('select_environment', environmentSelectionArgs()),
                toolCall('launch_browser', launchNone),
                toolCall('launch_browser', {
                    extension: 'prepared',
                    targetUrl: 'https://example.com/article',
                    profile: browserProfile,
                    settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
                }),
                toolCall('launch_browser', launchNone),
                toolCall('open_page', { url: 'https://example.com/article' }),
                toolCall('close_browser', {}),
                toolCall('launch_browser', {
                    extension: 'prepared',
                    targetUrl: 'https://example.com/article',
                    profile: {
                        viewport: 'desktop',
                        locale: 'ru-RU',
                        timezone: 'Europe/Moscow',
                        consentStrategy: 'reject',
                    },
                    settings: {
                        kind: 'agent_selected',
                        filterIds: [1, 2, 10],
                        stealthEnabled: false,
                    },
                }),
                toolCall('open_page', { url: 'https://example.com/article' }),
                toolCall('close_browser', {}),
                toolCall('launch_browser', {
                    extension: 'none',
                    targetUrl: 'https://example.com/article',
                    profile: {
                        viewport: 'desktop',
                        locale: 'pl-PL',
                        timezone: 'Europe/Warsaw',
                        consentStrategy: 'accept',
                    },
                }),
                toolCall('open_page', { url: 'https://example.com/article' }),
                toolCall('finish_fix', {
                    outcome: 'analysis_only',
                    reasoning: 'The environment was reproduced but no safe rule was found.',
                }),
            ]);
            const openPage = vi.fn(async () => ({
                error: `Target environment failed: ${fallbackReason}`,
                fallbackReason,
            }));
            const createBrowserSession = vi.fn(async (config: BrowserSessionConfig) => {
                void config;
                return {
                    close: vi.fn(),
                    getConsoleLog: () => [],
                    consoleCoverage: ConsoleCoverage.BrowserLogOnly,
                    extensionContext: fakeExtensionContext(),
                } as unknown as BrowserSession;
            });
            try {
                const result = await runFixCore(
                    { ...coreConfig(), repositoryPath: filtersPath },
                    { rawIssue: localIssue(), facts: localFacts() },
                    {
                        artifactsDir: join(root, 'artifacts'),
                        browserMode: 'on',
                        agentRuntime: {},
                    },
                    {
                        piRuntime,
                        agentRuntime: {
                            // The launch read-back verifies the requested filter set exactly: the
                            // prepared session's settings fact is the read-back record, not a
                            // launch-time settings piece.
                            ...launchReadBackDependencies([1, 2, 10]),
                            createBaseRegistry: async () => new ToolRegistry(),
                            createBrowserSession,
                            createBrowserRegistry: async () => {
                                const registry = new ToolRegistry();
                                registry.register({
                                    definition: {
                                        type: 'function',
                                        function: {
                                            name: 'open_page',
                                            description: 'Open the selected page',
                                            parameters: { type: 'object', properties: {} },
                                        },
                                    },
                                    handler: openPage,
                                });
                                return registry;
                            },
                        },
                    },
                );

                expect(createBrowserSession).toHaveBeenCalledTimes(5);
                expect(openPage).toHaveBeenCalledWith(
                    expect.objectContaining({ url: 'https://example.com/article' }),
                );
                expect(openPage).toHaveBeenCalledTimes(3);
                // The prepared build is the one host-prepared pinned release: the session
                // provenance states the single-source shape, not a per-report build. The run's
                // settings fact is the launch read-back record — its verified read-back carries
                // into the result as the applied-settings status even though the target never
                // became observable.
                expect(result).toMatchObject({
                    runStatus: 'target_url_unavailable',
                    fallbackReason,
                    reproductionSettingsStatus: 'applied',
                    extensionProvenance: {
                        source: 'pinned_release',
                        extensionPath: PINNED_RELEASE_FIXTURE_DIR,
                        manifestVersion: 3,
                        extensionSourceTag: PINNED_RELEASE_FIXTURE_TAG,
                        extensionSourceSha256: 'e'.repeat(64),
                    },
                });
                expect(result).not.toHaveProperty('infrastructureFailureReason');
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        },
    );

    it.each([
        {
            label: 'browser launch',
            error: new Error('browser executable unavailable'),
            fallbackReason: 'launch_failed',
        },
        {
            label: 'extension configuration',
            error: new BrowserConfigurationError(
                'MV3 extension settings could not be applied.',
                undefined,
                'settings_apply_failed',
            ),
            fallbackReason: 'extension_configuration_failed',
        },
    ] as const)(
        'keeps $label failure classified as browser infrastructure unavailability',
        async ({ error, fallbackReason }) => {
            const root = mkdtempSync(join(tmpdir(), 'fix-core-agentic-browser-infra-'));
            const filtersPath = join(root, 'filters');
            mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
            writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
            const piRuntime = await scriptedPiRuntime([
                toolCall('select_environment', environmentSelectionArgs()),
                toolCall('launch_browser', {
                    extension: 'none',
                    targetUrl: 'https://example.com/article',
                    profile: browserProfile,
                }),
                toolCall('finish_fix', {
                    outcome: 'analysis_only',
                    reasoning: 'Browser infrastructure was unavailable.',
                }),
                { kind: ScriptedReplyKind.Text, text: 'The terminal submission was rejected.' },
                { kind: ScriptedReplyKind.Text, text: 'No terminal decision.' },
            ]);
            try {
                const result = await runFixCore(
                    { ...coreConfig(), repositoryPath: filtersPath },
                    { rawIssue: localIssue(), facts: localFacts() },
                    {
                        artifactsDir: join(root, 'artifacts'),
                        browserMode: 'on',
                        agentRuntime: {},
                    },
                    {
                        piRuntime,
                        agentRuntime: {
                            createBaseRegistry: async () => new ToolRegistry(),
                            createBrowserSession: async () => {
                                throw error;
                            },
                        },
                    },
                );

                expect(result).toMatchObject({
                    runStatus: 'failed',
                    agentTerminationReason: 'terminal_not_called',
                    fallbackReason,
                    infrastructureFailureReason: 'browser_unavailable',
                });
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        },
    );

    it('fails the run named with the full captured output when the pinned release fetch fails once', async () => {
        const root = mkdtempSync(join(tmpdir(), 'fix-core-agentic-extension-infra-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
        try {
            const downloadPinnedExtensionRelease = vi
                .fn()
                .mockRejectedValue(
                    new Error('Pinned release v5.5.2.3 download failed: status 502 for asset.'),
                );
            const result = await runFixCore(
                { ...coreConfig(), repositoryPath: filtersPath },
                { rawIssue: localIssue(), facts: localFacts() },
                {
                    artifactsDir: join(root, 'artifacts'),
                    browserMode: 'on',
                    agentRuntime: {},
                },
                {
                    downloadPinnedExtensionRelease,
                },
            );

            // One attempt, one named failure: the fetcher error's full message — the captured
            // output of the failed step — is the run reasoning, with no retry and no session.
            expect(downloadPinnedExtensionRelease).toHaveBeenCalledTimes(1);
            expect(result).toMatchObject({
                runStatus: 'failed',
                reasoning: 'Pinned release v5.5.2.3 download failed: status 502 for asset.',
                infrastructureFailureReason: 'environment_unavailable',
                candidatePatch: null,
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('runs the instruction preparation session and adopts its build when the section is present', async () => {
        const root = mkdtempSync(join(tmpdir(), 'fix-core-prep-session-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
        const instruction = instructionWithPreparationSection();
        const piRuntime = await scriptedPiRuntime(preparedSessionScript());
        const { createBrowserSession, createBrowserRegistry, launchReadBack } =
            preparedSessionStubs();
        const runPreparationSession = vi.fn(async (options): Promise<PreparationSessionResult> => {
            const built = writeUnpackedExtensionFixture(options.workDir, {
                version: '1.2.3-built',
                manifest_version: 3,
            });
            return {
                status: 'done',
                workDir: options.workDir,
                extensionDir: built,
            };
        });
        try {
            const result = await runFixCore(
                { ...coreConfig(), repositoryPath: filtersPath },
                { rawIssue: localIssue(), facts: localFacts() },
                {
                    artifactsDir: join(root, 'artifacts'),
                    browserMode: 'on',
                    agentRuntime: {},
                    instruction,
                },
                {
                    piRuntime,
                    agentRuntime: {
                        ...launchReadBack,
                        createBaseRegistry: async () => new ToolRegistry(),
                        createBrowserSession,
                        createBrowserRegistry,
                    },
                    runPreparationSession,
                },
            );

            // The model phase ran against the exact section body inside the run's own
            // preparation workdir, and its build was adopted verbatim — no pinned download.
            expect(runPreparationSession).toHaveBeenCalledTimes(1);
            const section = extractPreparationSection(instruction.content)!;
            expect(runPreparationSession).toHaveBeenCalledWith(
                expect.objectContaining({
                    preparationSection: section.content,
                    workDir: resolve(join(root, 'artifacts', 'preparation')),
                }),
            );
            expect(pinnedReleaseSeamMock).not.toHaveBeenCalled();
            expect(result.extensionProvenance).toEqual({
                source: 'instruction',
                extensionPath: join(resolve(join(root, 'artifacts', 'preparation')), 'unpacked'),
                manifestVersion: ExtensionManifestVersion.Mv3,
                extensionSourceSha256: section.sha256,
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it.each([
        {
            label: 'names a directory that does not exist',
            placement: (workDir: string, _root: string) => join(workDir, 'missing'),
            failureDetail: 'does not exist',
        },
        {
            label: 'names a directory outside the preparation workdir',
            placement: (_workDir: string, root: string) => join(root, 'escape'),
            failureDetail: 'resolves outside the preparation workdir',
        },
        {
            label: 'names a directory without a manifest',
            placement: (workDir: string, _root: string) => writeUnpackedBareDir(workDir),
            failureDetail: 'carries no manifest.json',
        },
    ] as const)(
        'rejects a done preparation payload whose extensionDir $label',
        async ({ placement, failureDetail }) => {
            const root = mkdtempSync(join(tmpdir(), 'fix-core-prep-invalid-'));
            const filtersPath = join(root, 'filters');
            mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
            writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
            const piRuntime = await scriptedPiRuntime([]);
            const runPreparationSession = vi.fn(
                async (options): Promise<PreparationSessionResult> => ({
                    status: 'done',
                    workDir: options.workDir,
                    extensionDir: placement(options.workDir, root),
                }),
            );
            try {
                const result = await runFixCore(
                    { ...coreConfig(), repositoryPath: filtersPath },
                    { rawIssue: localIssue(), facts: localFacts() },
                    {
                        artifactsDir: join(root, 'artifacts'),
                        browserMode: 'on',
                        agentRuntime: {},
                        instruction: instructionWithPreparationSection(),
                    },
                    {
                        piRuntime,
                        agentRuntime: {
                            createBaseRegistry: async () => new ToolRegistry(),
                        },
                        runPreparationSession,
                    },
                );

                expect(pinnedReleaseSeamMock).not.toHaveBeenCalled();
                expect(result).toMatchObject({
                    runStatus: 'failed',
                    infrastructureFailureReason: 'environment_unavailable',
                });
                expect(result.reasoning).toContain(failureDetail);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        },
    );

    it('downloads the pinned release for an instruction without a preparation section', async () => {
        const root = mkdtempSync(join(tmpdir(), 'fix-core-instruction-no-prep-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
        const piRuntime = await scriptedPiRuntime(preparedSessionScript());
        const { createBrowserSession, createBrowserRegistry, launchReadBack } =
            preparedSessionStubs();
        const runPreparationSession = vi.fn();
        try {
            const result = await runFixCore(
                { ...coreConfig(), repositoryPath: filtersPath },
                { rawIssue: localIssue(), facts: localFacts() },
                {
                    artifactsDir: join(root, 'artifacts'),
                    browserMode: 'on',
                    agentRuntime: {},
                    instruction: runInstructionFixture(),
                },
                {
                    piRuntime,
                    agentRuntime: {
                        ...launchReadBack,
                        createBaseRegistry: async () => new ToolRegistry(),
                        createBrowserSession,
                        createBrowserRegistry,
                    },
                    runPreparationSession,
                },
            );

            // A section-less instruction never fails the run and never starts a model
            // preparation phase: the host performed the pinned download exactly as with no
            // instruction at all.
            expect(runPreparationSession).not.toHaveBeenCalled();
            expect(pinnedReleaseSeamMock).toHaveBeenCalledTimes(1);
            expect(result.extensionProvenance).toMatchObject({
                source: 'pinned_release',
                extensionPath: PINNED_RELEASE_FIXTURE_DIR,
                manifestVersion: ExtensionManifestVersion.Mv3,
                extensionSourceTag: PINNED_RELEASE_FIXTURE_TAG,
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('does not conflate an exhausted agent loop with model-authored analysis_only', async () => {
        const root = mkdtempSync(join(tmpdir(), 'fix-core-agent-termination-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
        const piRuntime = await scriptedPiRuntime([
            toolCall('fetch_issue', { issueNumber: 4 }),
            {
                kind: ScriptedReplyKind.Text,
                text: 'Investigation did not reach a terminal decision.',
            },
            {
                kind: ScriptedReplyKind.Text,
                text: 'Investigation did not reach a terminal decision.',
            },
        ]);
        let agentRunArtifacts: AgentRunArtifacts | undefined;
        try {
            const result = await runFixCore(
                { ...coreConfig(), repositoryPath: filtersPath },
                { rawIssue: localIssue(), facts: localFacts() },
                {
                    artifactsDir: join(root, 'artifacts'),
                    browserMode: 'on',
                    maxIterations: 1,
                    agentRuntime: {},
                },
                {
                    piRuntime,
                    agentRuntime: {
                        createBaseRegistry: async () => new ToolRegistry(),
                        filteringExecutors: twoCoreExecutorRegistry(
                            preparableProbeExecutor({
                                ready: true,
                                provenance: {
                                    source: 'official_release',
                                    product: 'Probe product',
                                    version: '1.0.0',
                                    digestB32: 'digestb32examplevalue0123456789abcdefghijk',
                                },
                            }),
                        ),
                    },
                    onAgentRunArtifacts: (artifacts) => {
                        agentRunArtifacts = artifacts;
                    },
                },
            );

            expect(hermetic!.requests).toHaveLength(1);
            expect(result).toMatchObject({
                runStatus: 'failed',
                agentTerminationReason: 'max_iterations_exceeded',
                candidatePatch: null,
                reasoning: expect.stringContaining(`(${SealKind.BudgetExceeded})`),
            });
            expect(result).not.toHaveProperty('infrastructureFailureReason');
            expect(agentRunArtifacts?.decision).toBeNull();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('routing check stops after the selection with the legacy observable shape', async () => {
        const root = mkdtempSync(join(tmpdir(), 'fix-core-routing-check-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
        const piRuntime = await scriptedPiRuntime([
            toolCall('select_environment', environmentSelectionArgs()),
            toolCall('open_page', { url: 'https://example.com/article' }),
        ]);
        try {
            const result = await runFixCore(
                { ...coreConfig(), repositoryPath: filtersPath },
                { rawIssue: localIssue(), facts: localFacts() },
                {
                    artifactsDir: join(root, 'artifacts'),
                    browserMode: 'on',
                    routingCheck: true,
                    agentRuntime: {},
                },
                {
                    piRuntime,
                    agentRuntime: {
                        createBaseRegistry: async () => new ToolRegistry(),
                        createBrowserSession: async () =>
                            ({
                                close: vi.fn(),
                                getConsoleLog: () => [],
                                consoleCoverage: ConsoleCoverage.BrowserLogOnly,
                            }) as unknown as BrowserSession,
                        createBrowserRegistry: async () => {
                            const registry = new ToolRegistry();
                            registry.register({
                                definition: {
                                    type: 'function',
                                    function: {
                                        name: 'open_page',
                                        description: 'Open the target page',
                                        parameters: { type: 'object', properties: {} },
                                    },
                                },
                                handler: async () => ({ url: 'x', statusCode: 200 }),
                            });
                            return registry;
                        },
                        filteringExecutors: twoCoreExecutorRegistry(
                            preparableProbeExecutor({
                                ready: true,
                                provenance: {
                                    source: 'official_release',
                                    product: 'Probe product',
                                    version: '1.0.0',
                                    digestB32: 'digestb32examplevalue0123456789abcdefghijk',
                                },
                            }),
                        ),
                    },
                },
            );

            // The run halted right after the accepted selection: the following turn never ran.
            expect(hermetic!.requests).toHaveLength(1);
            expect(result).toMatchObject({
                runStatus: 'failed',
                agentTerminationReason: 'halted_by_caller',
                environmentSelection: {
                    selectedKind: 'browser_extension',
                    state: 'ready',
                },
            });
            expect(result.reasoning).toContain(
                'Routing check: the environment selection was recorded',
            );
            const trace = readFileSync(result.artifactPaths.trace!, 'utf8');
            expect(trace).toContain('halted_by_caller');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('fails an unknown executor name naming it and the registered set before any model artifact', async () => {
        const root = mkdtempSync(join(tmpdir(), 'fix-core-executor-ghost-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
        const piRuntime = await scriptedPiRuntime([
            toolCall('select_environment', environmentSelectionArgs()),
        ]);
        try {
            const result = await runFixCore(
                { ...coreConfig(), repositoryPath: filtersPath },
                { rawIssue: localIssue(), facts: localFacts() },
                {
                    artifactsDir: join(root, 'artifacts'),
                    browserMode: 'on',
                    agentRuntime: {
                        executors: ['ghost'],
                    },
                },
                {
                    piRuntime,
                    agentRuntime: { createBaseRegistry: async () => new ToolRegistry() },
                },
            );

            expect(result).toMatchObject({ runStatus: 'failed' });
            expect(result.reasoning).toContain('Unknown executor "ghost"');
            expect(result.reasoning).toContain('Registered executors: browser_extension');
            // The resolution failed inside AgentRuntime.create, before any session turn was
            // requested and any site was reached.
            expect(hermetic!.requests).toHaveLength(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it.each([
        ['names the sole executor explicitly', { executors: ['browser_extension'] }],
        ['keeps the registered set when the run names none', {}],
    ] as const)(
        '%s: a one-element set locks without a model choice',
        async (_name, executorSet) => {
            const root = mkdtempSync(join(tmpdir(), 'fix-core-sole-executor-'));
            const filtersPath = join(root, 'filters');
            mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
            writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
            const piRuntime = await scriptedPiRuntime([
                toolCall('open_page', { url: 'https://example.com/article' }),
            ]);
            try {
                const result = await runFixCore(
                    { ...coreConfig(), repositoryPath: filtersPath },
                    { rawIssue: localIssue(), facts: localFacts() },
                    {
                        artifactsDir: join(root, 'artifacts'),
                        browserMode: 'on',
                        routingCheck: true,
                        agentRuntime: {
                            ...executorSet,
                        },
                    },
                    {
                        piRuntime,
                        agentRuntime: { createBaseRegistry: async () => new ToolRegistry() },
                    },
                );

                // The sole executor was locked at construction; the routing latch recognized the
                // deterministic acceptance and the scripted select_environment turn never existed.
                expect(result).toMatchObject({
                    agentTerminationReason: 'halted_by_caller',
                    environmentSelection: {
                        selectedKind: 'browser_extension',
                        state: 'ready',
                    },
                });
                expect(result.reasoning).toContain(
                    'Routing check: the environment selection was recorded',
                );
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        },
    );

    it('a run limited to a non-extension executor performs no extension preparation', async () => {
        // An AdGuard CLI-shaped executor never reads `preparedExtension` and launches with
        // `extension: none`; the run must never pay for its download or preparation session.
        const root = mkdtempSync(join(tmpdir(), 'fix-core-non-extension-executor-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
        const soleProbeRegistry = new FilteringExecutorRegistry();
        soleProbeRegistry.register(
            preparableProbeExecutor({
                ready: true,
                provenance: {
                    source: 'official_release',
                    product: 'Probe product',
                    version: '1.0.0',
                    digestB32: 'digestb32examplevalue0123456789abcdefghijk',
                },
            }),
        );
        const downloadPinnedExtensionRelease = vi.fn();
        const runPreparationSession = vi.fn();
        const piRuntime = await scriptedPiRuntime([
            toolCall('open_page', { url: 'https://example.com/article' }),
        ]);
        try {
            const result = await runFixCore(
                { ...coreConfig(), repositoryPath: filtersPath },
                { rawIssue: localIssue(), facts: localFacts() },
                {
                    artifactsDir: join(root, 'artifacts'),
                    browserMode: 'on',
                    routingCheck: true,
                    agentRuntime: { executors: [CORE_PROBE_NAME] },
                },
                {
                    piRuntime,
                    downloadPinnedExtensionRelease,
                    runPreparationSession,
                    agentRuntime: {
                        createBaseRegistry: async () => new ToolRegistry(),
                        filteringExecutors: soleProbeRegistry,
                    },
                },
            );

            expect(downloadPinnedExtensionRelease).not.toHaveBeenCalled();
            expect(runPreparationSession).not.toHaveBeenCalled();
            // The sole non-extension executor still locked and reached the routing halt: the skip
            // did not merely avoid a crash, the run proceeded exactly as a real AdGuard CLI-only run
            // would.
            expect(result).toMatchObject({
                agentTerminationReason: 'halted_by_caller',
                environmentSelection: { selectedKind: CORE_PROBE_NAME },
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('a rejected-terminal seal maps to a non-failed analysis-only result', async () => {
        const root = mkdtempSync(join(tmpdir(), 'fix-core-rejected-terminal-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
        const draftPayload = {
            outcome: 'propose_rule',
            ruleProposal: {
                rule: 'example.com##.ad',
                ruleType: 'cosmetic',
                risk: {
                    level: 'low',
                    reasons: ['test'],
                },
                placement: {
                    filter: 'BaseFilter',
                    filePath: 'BaseFilter/sections/foreign.txt',
                    confidence: 0.9,
                    alternatives: [],
                },
                duplicateCheck: { classification: 'none', matches: [] },
                productCompatibility: { extension: true },
            },
            policyDecision: { decision: 'allow_rule_generation', reasons: ['test'] },
            reasoning: 'The candidate validation evidence is preserved here.',
            summary: 'Draft run.',
            evidenceSummary: 'none',
        };
        const piRuntime = await scriptedPiRuntime([
            toolCall('fetch_issue', { issueNumber: 4 }),
            toolCall('select_environment', environmentSelectionArgs()),
            toolCall('finish_fix', draftPayload),
            toolCall('finish_fix', draftPayload),
            toolCall('finish_fix', draftPayload),
        ]);
        try {
            const result = await runFixCore(
                { ...coreConfig(), repositoryPath: filtersPath },
                { rawIssue: localIssue(), facts: localFacts() },
                {
                    artifactsDir: join(root, 'artifacts'),
                    browserMode: 'on',
                    agentRuntime: {},
                },
                {
                    piRuntime,
                    agentRuntime: {
                        createBaseRegistry: async () => new ToolRegistry(),
                    },
                },
            );

            expect(result).toMatchObject({
                runStatus: 'analysis_only',
                candidatePatch: null,
            });
            expect(result).not.toHaveProperty('agentTerminationReason');
            expect(result.reasoning).toContain(
                'The candidate validation evidence is preserved here.',
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('a deterministic provider rejection maps to llm_rejected', async () => {
        const root = mkdtempSync(join(tmpdir(), 'fix-core-llm-rejected-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
        const piRuntime = await scriptedPiRuntime([
            { kind: ScriptedReplyKind.Error, status: 400, message: 'malformed request' },
        ]);
        try {
            const result = await runFixCore(
                { ...coreConfig(), repositoryPath: filtersPath },
                { rawIssue: localIssue(), facts: localFacts() },
                {
                    artifactsDir: join(root, 'artifacts'),
                    browserMode: 'on',
                    agentRuntime: {},
                },
                {
                    piRuntime,
                    agentRuntime: {
                        createBaseRegistry: async () => new ToolRegistry(),
                    },
                },
            );

            expect(result).toMatchObject({
                runStatus: 'failed',
                agentTerminationReason: 'llm_rejected',
                infrastructureFailureReason: 'llm_rejected',
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('a transient provider failure carries its HTTP status onto the result', async () => {
        // 402 (unlike the deterministic 400 above) is a billing failure the account can recover
        // from, so it stays llm_error/llm_unavailable — and the status pi's message named must
        // reach the locked result for the report to name the billing cause instead of "unreachable".
        const root = mkdtempSync(join(tmpdir(), 'fix-core-llm-error-status-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
        const piRuntime = await scriptedPiRuntime([
            {
                kind: ScriptedReplyKind.Error,
                status: 402,
                message: 'This request requires more credits, or fewer max_tokens.',
            },
        ]);
        try {
            const result = await runFixCore(
                { ...coreConfig(), repositoryPath: filtersPath },
                { rawIssue: localIssue(), facts: localFacts() },
                {
                    artifactsDir: join(root, 'artifacts'),
                    browserMode: 'on',
                    agentRuntime: {},
                },
                {
                    piRuntime,
                    agentRuntime: {
                        createBaseRegistry: async () => new ToolRegistry(),
                    },
                },
            );

            expect(result).toMatchObject({
                runStatus: 'failed',
                agentTerminationReason: 'llm_error',
                infrastructureFailureReason: 'llm_unavailable',
                providerFailureStatus: 402,
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('does not expose a human reference through the core options or dependencies', () => {
        const optionsExposeHumanReference: 'humanReference' extends keyof FixCoreOptions
            ? true
            : false = false;
        const dependenciesExposeHumanReference: 'humanReference' extends keyof FixCoreDependencies
            ? true
            : false = false;

        expect(optionsExposeHumanReference).toBe(false);
        expect(dependenciesExposeHumanReference).toBe(false);
    });
});

/**
 * Build a run instruction as the loader would produce it.
 *
 * @returns The loaded-instruction fixture with one linked syntax document.
 */
function runInstructionFixture(): LoadedInstruction {
    return {
        path: 'AGENT-INSTRUCTION.md',
        content: [
            'Verify the header banner, not the sidebar.',
            '',
            '## Rule application',
            '',
            'Apply exactly these steps, invent none:',
            '',
            '1. Open the blocker options page of the prepared build.',
            '2. Restore the baseline: no user rule, only the prepared filter set enabled.',
            '',
            '## State verification',
            '',
            'The host reads the blocker state back itself:',
            '',
            'read: extension-state user rules',
        ].join('\n'),
        sha256: 'a'.repeat(64),
        documents: [
            {
                role: GuidanceDocumentRole.Syntax,
                origin: GuidanceDocumentOrigin.Url,
                url: 'https://wiki.example.test/filter-syntax',
                content: 'Full syntax reference body.',
                sha256: 'd'.repeat(64),
            },
        ],
    };
}

/**
 * Build a prepared KnowledgeBase guidance source as a runner would supply it.
 *
 * @returns The KnowledgeBase-branch guidance source fixture.
 */
function knowledgeBaseSourceFixture(): KnowledgeGuidanceSource {
    return {
        kind: RuleGuidanceSourceKind.KnowledgeBase,
        knowledgeBaseCommit: 'c'.repeat(40),
        filtersCommit: 'f'.repeat(40),
        knowledgeBaseRepository: 'AdguardTeam/KnowledgeBase',
        filtersRepository: 'AdguardTeam/AdguardFilters',
        syntaxPath: '/tmp/knowledge-base/create-own-filters.md',
        policyPath: '/tmp/knowledge-base/filter-policy.md',
        contributingPath: '/tmp/filters/CONTRIBUTING.md',
    };
}

describe('resolveRuleGuidanceSource', () => {
    it('prefers the run instruction over a prepared KnowledgeBase source', () => {
        const resolved = resolveRuleGuidanceSource({
            knowledgeGuidanceSource: knowledgeBaseSourceFixture(),
            instruction: runInstructionFixture(),
        });

        expect(resolved?.kind).toBe(RuleGuidanceSourceKind.Instruction);
        expect(resolved).toMatchObject({
            kind: RuleGuidanceSourceKind.Instruction,
            path: 'AGENT-INSTRUCTION.md',
            sha256: 'a'.repeat(64),
        });
    });

    it('passes a prepared KnowledgeBase source through when no instruction is loaded', () => {
        const knowledgeBase = knowledgeBaseSourceFixture();

        expect(resolveRuleGuidanceSource({ knowledgeGuidanceSource: knowledgeBase })).toStrictEqual(
            knowledgeBase,
        );
    });

    it('resolves nothing when the run carries neither an instruction nor a KnowledgeBase', () => {
        expect(resolveRuleGuidanceSource({})).toBeUndefined();
    });
});

describe('the agentic core threads the run instruction to its session', () => {
    it('embeds the instruction into the provider-visible fix task', async () => {
        const root = mkdtempSync(join(tmpdir(), 'fix-core-instruction-fill-'));
        const filtersPath = join(root, 'filters');
        mkdirSync(join(filtersPath, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(filtersPath, 'BaseFilter/sections/foreign.txt'), '');
        const piRuntime = await scriptedPiRuntime([
            toolCall('fetch_issue', { issueNumber: 4 }),
            toolCall('select_environment', environmentSelectionArgs(CORE_PROBE_NAME)),
            toolCall('finish_fix', {
                outcome: 'analysis_only',
                reasoning: 'The selected desktop executor could not be prepared.',
            }),
        ]);

        try {
            await runFixCore(
                { ...coreConfig(), repositoryPath: filtersPath },
                { rawIssue: localIssue(), facts: localFacts() },
                {
                    artifactsDir: join(root, 'artifacts'),
                    browserMode: 'on',
                    instruction: runInstructionFixture(),
                    agentRuntime: {},
                },
                {
                    piRuntime,
                    agentRuntime: { createBaseRegistry: async () => new ToolRegistry() },
                },
            );

            const providerVisibleTask = JSON.stringify(hermetic!.requests[0]!.messages);
            expect(providerVisibleTask).toContain('Verify the header banner, not the sidebar.');
            expect(providerVisibleTask).toContain(
                'syntax (url): https://wiki.example.test/filter-syntax',
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

/**
 * The complete blocker state one fake host read-back reports: two enabled filters, one of them in
 * the metadata-disabled set for the enabled-filters projection, MV3 counters, and Stealth on.
 *
 * @param overrides - Field overrides for the tested derivation branches.
 * @returns Consistent prepared-extension state read.
 */
function readBackFixture(
    overrides: Partial<AdGuardExtensionStateRead> = {},
): AdGuardExtensionStateRead {
    return {
        extensionId: 'read-back-extension-id',
        optionsPageUrl: 'chrome-extension://read-back-extension-id/pages/options.html',
        manifestVersion: ExtensionManifestVersion.Mv3,
        filterEngine: FilterEngine.DeclarativeNetRequest,
        appVersion: '5.4.3.99',
        optionsEnabledFilterIds: [2, 10],
        optionsData: {
            appVersion: '5.4.3.99',
            settings: { values: { [DISABLE_STEALTH_SETTING]: true } },
            filtersMetadata: {
                filters: [
                    {
                        filterId: 2,
                        enabled: true,
                        name: 'AdGuard Base filter',
                        groupId: 2,
                        version: '2.0.1',
                    },
                    { filterId: 10, enabled: true, name: 'AdGuard Tracking Protection filter' },
                    { filterId: 4, enabled: false, name: 'AdGuard Annoyances filter' },
                ],
                categories: [{ groupId: 2, groupName: 'Ads' }],
            },
            runtimeInfo: { areFilterLimitsExceeded: false },
        },
        userRules: {
            manifestVersion: ExtensionManifestVersion.Mv3,
            ruleCount: 0,
            contentSha256: 'b'.repeat(64),
            rulesLimits: null,
            content: '',
        },
        rulesLimits: null,
        ...overrides,
    };
}

describe('settingsEvidenceFromReadBack', () => {
    it('derives the session settings record from the blocker state the host read back', () => {
        const readBack = readBackFixture({
            rulesLimits: {
                dynamicRulesEnabledCount: 1,
                dynamicRulesMaximumCount: 30000,
                dynamicRulesUnsafeEnabledCount: 0,
                dynamicRulesUnsafeMaximumCount: 100,
                dynamicRulesRegexpsEnabledCount: 0,
                dynamicRulesRegexpsMaximumCount: 100,
                staticFiltersEnabledCount: 2,
                staticFiltersMaximumCount: 100,
                staticRulesEnabledCount: 10,
                staticRulesMaximumCount: 100000,
                staticRulesRegexpsEnabledCount: 0,
                staticRulesRegexpsMaxCount: 1000,
                actuallyEnabledFilters: [2, 10],
                expectedEnabledFilters: [2, 10],
                areFilterLimitsExceeded: false,
            },
        });

        const evidence = settingsEvidenceFromReadBack('agent_selected', readBack);

        expect(evidence).toStrictEqual({
            profileKind: 'agent_selected',
            manifestVersion: ExtensionManifestVersion.Mv3,
            filterEngine: FilterEngine.DeclarativeNetRequest,
            extensionId: 'read-back-extension-id',
            optionsPageUrl: 'chrome-extension://read-back-extension-id/pages/options.html',
            appVersion: '5.4.3.99',
            enabledFilterIds: [2, 10],
            // The metadata entries mirror the enabled set only; a disabled entry proves nothing
            // about the applied settings and must not travel with the record.
            enabledFilters: [
                {
                    filterId: 2,
                    name: 'AdGuard Base filter',
                    groupId: 2,
                    groupName: 'Ads',
                    version: '2.0.1',
                },
                { filterId: 10, name: 'AdGuard Tracking Protection filter' },
            ],
            optionsEnabledFilterIds: [2, 10],
            runtimeEnabledFilterIds: [2, 10],
            activeRulesetFilterIds: [2, 10],
            // The read-back stores the inverse setting: stealth disabled means stealth off.
            stealthEnabled: false,
            limitsExceeded: false,
            rulesLimits: readBack.rulesLimits,
        });
    });

    it('falls back to the observed options set when the runtime exposes no MV3 counters', () => {
        const evidence = settingsEvidenceFromReadBack(
            'reported_on_current',
            readBackFixture({
                optionsEnabledFilterIds: [2],
                rulesLimits: null,
                optionsData: {
                    appVersion: '5.4.3.99',
                    settings: { values: { [DISABLE_STEALTH_SETTING]: false } },
                    filtersMetadata: {
                        filters: [{ filterId: 2, enabled: true, name: 'AdGuard Base filter' }],
                        categories: [],
                    },
                    runtimeInfo: { areFilterLimitsExceeded: true },
                },
            }),
        );

        expect(evidence.runtimeEnabledFilterIds).toEqual([2]);
        expect(evidence.activeRulesetFilterIds).toBeNull();
        expect(evidence.stealthEnabled).toBe(true);
        expect(evidence.limitsExceeded).toBe(true);
    });

    it('round-trips through the durable settings proof artifact', () => {
        const root = mkdtempSync(join(tmpdir(), 'fix-core-settings-proof-'));
        try {
            const recorder = {
                addArtifact: vi.fn(),
            } as unknown as TraceRecorder;
            const evidence = settingsEvidenceFromReadBack('agent_selected', readBackFixture());

            const proofPath = agenticRunEvidence.persistAgentSettingsProof(
                evidence,
                root,
                recorder,
            );

            expect(readSettingsProof(proofPath)).toStrictEqual(evidence);
            expect(recorder.addArtifact).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'settings-proof', path: proofPath }),
            );
            // The locked-result projection reads the same record back with the keys the report
            // and the publication evidence need.
            expect(agenticRunEvidence.serializeAgentSettingsEvidence(evidence)).toStrictEqual({
                profileKind: 'agent_selected',
                enabledListKeys: ['adguard:2', 'adguard:10'],
                enabledFilters: [
                    { listKey: 'adguard:2', name: 'AdGuard Base filter' },
                    { listKey: 'adguard:10', name: 'AdGuard Tracking Protection filter' },
                ],
                activeRulesetListKeys: null,
                stealthEnabled: false,
                limitsExceeded: false,
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
