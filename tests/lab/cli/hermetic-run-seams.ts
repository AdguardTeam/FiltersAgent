import { vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreConfig } from '../../../src/config/config';
import { ExtensionManifestVersion } from '../../../src/environment/extension-preparation';
import { ToolRegistry } from '../../../src/agent/tool-registry';
import { runFixCore } from '../../../src/orchestrator/fix-core';
import type { FixCoreDependencies } from '../../../src/orchestrator/fix-core-inputs';
import type { PiRuntime } from '../../../src/pi/runtime';
import type { SingleShotClient } from '../../../src/pi/single-shot-types';
import {
    HermeticProvider,
    HermeticScenario,
    ScriptedReply,
    ScriptedReplyKind,
    startHermeticProvider,
} from '../../pi/hermetic-provider';
import { createTestPiRuntime } from '../../pi/test-runtime';
import { testCoreConfig } from '../../config/test-core-config';
import type {
    FiltersPreparationConfig,
    KnowledgeBasePreparationConfig,
} from '../../../src/local/run-config-types';
import type { PreparedFiltersCheckout } from '../../../src/local/filters-preparer';
import type { PreparedKnowledgeBase } from '../../../lab/local/knowledge-base-preparer';
import { IntakeExtractionKind, type IntakeExtraction } from '../../../src/intake/extract-report';
import type { RawIssue } from '../../../src/github/fetch-issue';
import { RuleGuidanceSourceKind } from '../../../src/knowledge/guidance-source';
import type { UpstreamSourceDrift } from '../../../src/types/upstream-source-drift';
import { ExtensionEnvironmentKind } from '../../../src/types/extension-environment-kind';
import {
    runLocalFixFromRevision,
    type LocalFixRunnerDependencies,
} from '../../../lab/local/local-fix-runner';
import type { LocalCycleDependencies } from '../../../lab/local/local-cycle';

const hermeticProviders: HermeticProvider[] = [];

/**
 * The disposable fixture roots the stubbed pinned-release seam unpacked builds live under, one per
 * started handler; `disposeHermeticRunSeams` removes them beside the providers they served.
 */
const pinnedReleaseFixtureRoots: string[] = [];

/**
 * Release tag the fixture unpacked build claims for the smoke's stubbed pinned-release seam.
 */
const PINNED_RELEASE_FIXTURE_TAG = 'v5.5.2.3';

/**
 * Digest the stubbed pinned-release seam records as the fixture build's source pin.
 */
const PINNED_RELEASE_FIXTURE_SHA256 = 'e'.repeat(64);

/**
 * Stop every hermetic provider the smoke handlers started. Tests call this from their `afterEach`,
 * before the disposable fixture roots are removed.
 */
export async function disposeHermeticRunSeams(): Promise<void> {
    for (const provider of hermeticProviders.splice(0)) {
        await provider.close();
    }
    for (const root of pinnedReleaseFixtureRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
}

/**
 * Materialize one loadable unpacked extension directory under a fresh disposable root for the
 * smoke's stubbed pinned-release seam: the run's pre-run preparation consumes it instead of
 * reaching the release network.
 *
 * @returns Absolute path of the unpacked directory.
 */
function writePinnedReleaseFixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'smoke-pinned-release-'));
    pinnedReleaseFixtureRoots.push(root);
    const unpacked = join(root, 'unpacked');
    mkdirSync(unpacked, { recursive: true });
    writeFileSync(
        join(unpacked, 'manifest.json'),
        JSON.stringify({ version: '5.5.2.3', manifest_version: 3 }),
        'utf8',
    );
    return unpacked;
}

/**
 * The smoke provider key the artifact redaction treats as a secret: no persisted artifact may carry
 * it, and no production credential is involved anywhere.
 */
export const SMOKE_ARTIFACT_KEY = 'smoke-local-key';

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
 * Reject one forbidden vision call loudly: no snapshot smoke leg owns a vision transport.
 *
 * @param _signal - The call signal captured for diagnosis.
 * @returns Never; every call throws.
 */
async function refuseVision(_signal: unknown): Promise<never> {
    throw new Error('Vision provider must not be invoked by the snapshot smoke fixture.');
}

/**
 * A sealed vision client: every call throws, so a wiring regression fails loudly at the boundary
 * instead of silently reaching a provider.
 *
 * @returns The stub client.
 */
function sealedVisionClient(): SingleShotClient {
    return {
        modelId: 'vision-stub',
        structured: (options) => refuseVision(options),
        text: (options) => refuseVision(options),
    };
}

/**
 * The runtime configuration the cycle hands the verified runner: provider traffic goes to the
 * per-run hermetic endpoint, and the investigation core itself rides the injected runtime seam.
 *
 * @param baseUrl - The hermetic provider base URL.
 * @returns The smoke's core configuration.
 */
export function smokeCoreConfig(baseUrl: string): CoreConfig {
    return testCoreConfig({
        llm: { baseUrl, apiKey: SMOKE_ARTIFACT_KEY, visionModel: 'gemini-3.5-flash' },
    });
}

/**
 * The base URL of the hermetic provider most recently started by {@link hermeticVerifiedHandler}, so
 * a leg can build its core configuration against its own provider.
 *
 * @returns The latest provider base URL.
 */
export function latestHermeticBaseUrl(): string {
    const provider = hermeticProviders[hermeticProviders.length - 1];
    if (!provider) {
        throw new Error('No hermetic smoke provider has been started.');
    }
    return provider.baseUrl;
}

/**
 * Deterministic intake extraction of the smoke fixture: the site URL comes from the issue body, and
 * no suite request reaches a provider network.
 *
 * @param raw - The prompt-safe issue the runner loads.
 * @returns The scripted report extraction.
 */
async function smokeExtractReport(raw: RawIssue): Promise<IntakeExtraction> {
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
}

/**
 * KnowledgeBase lifecycle stand-in handing its callback one fixed prepared result.
 *
 * @param config - The preparation config the runner resolved.
 * @param filters - The prepared filters checkout the runner resolved.
 * @param callback - The guarded body to run.
 * @returns Whatever the guarded body returned.
 */
async function preparedKnowledgeBaseStub<T>(
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
            environment: ExtensionEnvironmentKind.Current,
            source: 'local-shared-clone',
            sourceLocation: '/tmp/knowledge-base-source',
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
 * The upstream observation request shape the run hands the drift seam.
 */
interface DriftObservationRequest {
    /**
     * The exact commit the run was pinned to.
     */
    pinnedCommit: string;
}

/**
 * Upstream-observation stand-in so the run never reaches the network to observe drift.
 *
 * @param request - Observation request carrying the commit the run is pinned to.
 * @param request.pinnedCommit - The exact commit the run was pinned to.
 * @returns Drift record reporting that upstream was never seen.
 */
async function observeNoUpstream(request: DriftObservationRequest): Promise<UpstreamSourceDrift> {
    return {
        status: 'unobserved',
        pinnedCommit: request.pinnedCommit,
        upstreamCommit: null,
        observedAt: '2026-09-09T10:00:00.000Z',
    };
}

/**
 * Filters-preparation lifecycle stand-in that hands the callback the fixture checkout.
 *
 * @param checkoutPath - Absolute fixture checkout the runner treats as prepared.
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
                environment: ExtensionEnvironmentKind.Current,
                source: 'local-shared-clone',
                sourceLocation: '/tmp/smoke-filters-source',
                requestedRevision: 'master',
                commit: 'a'.repeat(40),
            },
        });
}

/**
 * The AdGuard CLI module stand-in: it cannot describe itself, exactly as an unconfigured module, so
 * the locked proxy selection stays capability-limited without spawning anything.
 *
 * @returns The blocker factory injected into the cycle dependencies.
 */
function unconfiguredBlockerStub(): LocalCycleDependencies['startAdguardCliBlocker'] {
    return vi.fn(() => ({
        describe: async () => {
            throw new Error('The AdGuard CLI module is not configured in the smoke fixture.');
        },
        start: vi.fn(),
        apply: vi.fn(),
        state: vi.fn(),
        log: vi.fn(),
        stop: async () => ({ licenceReleased: false }),
    }));
}

/**
 * The scripted agent loop a hermetic run serves: fetch the issue, lock the proxy route, seal the
 * investigation analysis-only. Both smoke legs replay this exact script.
 *
 * @returns The reply sequence.
 */
function scriptedAnalysisOnlyLoop(): ScriptedReply[] {
    return [
        toolCall('fetch_issue', { issueNumber: 4 }),
        toolCall('select_environment', {
            kind: 'adguard_cli',
            requiredCapabilities: [],
            intent: {
                issueType: 'ads',
                rationale:
                    'The report describes a website advertisement filtered at network level.',
                confidence: 0.9,
                evidence: [
                    {
                        source: 'issue_body',
                        observation: 'The issue body identifies a page-level advertising symptom.',
                    },
                ],
                conflicts: [],
            },
            rationale: 'The selected route matches the reported desktop filtering surface.',
            confidence: 0.85,
        }),
        toolCall('finish_fix', {
            outcome: 'analysis_only',
            reasoning: 'The selected route could not be prepared in the smoke fixture.',
        }),
    ];
}

/**
 * Build one hermetic per-issue investigation handler over the real verified-revision fix runner:
 * scripted provider runtime, sealed vision, seam-injected preparers and drift observation — the
 * established local-fix-runner suite pattern, shared verbatim by both smoke legs.
 *
 * @param checkoutPath - The fixture filters checkout the fixture preparer hands the run.
 * @returns The cycle-dependency block (handler and host stub) carrying the fresh provider.
 */
export async function hermeticVerifiedHandler(
    checkoutPath: string,
): Promise<Pick<LocalCycleDependencies, 'runLocalFixFromRevision' | 'startAdguardCliBlocker'>> {
    const provider = await startHermeticProvider({
        scenario: HermeticScenario.Scripted,
        script: scriptedAnalysisOnlyLoop(),
    });
    hermeticProviders.push(provider);
    const piRuntime: PiRuntime = await createTestPiRuntime({
        baseUrl: provider.baseUrl,
        model: 'test-model',
        visionModel: 'gemini-3.5-flash',
    });
    const vision = sealedVisionClient();
    const unpackedExtension = writePinnedReleaseFixture();
    const runnerDependencies: LocalFixRunnerDependencies = {
        extractReport: smokeExtractReport,
        runFixCore: async (config, issue, options, dependencies) =>
            await runFixCore(config, issue, options, {
                ...(dependencies as FixCoreDependencies),
                vision,
                piRuntime,
                // The run's pre-run extension preparation is stubbed: the smoke never reaches the
                // release network, whatever executor the scripted run locks.
                downloadPinnedExtensionRelease: async () => ({
                    extensionDir: unpackedExtension,
                    manifestVersion: ExtensionManifestVersion.Mv3,
                    sha256: PINNED_RELEASE_FIXTURE_SHA256,
                    tag: PINNED_RELEASE_FIXTURE_TAG,
                    fromCache: false,
                }),
                agentRuntime: { createBaseRegistry: async () => new ToolRegistry() },
            }),
        withPreparedKnowledgeBase: preparedKnowledgeBaseStub,
        observeUpstreamDrift: observeNoUpstream,
        withPreparedFiltersCheckout: preparedCheckoutStub(checkoutPath),
    };
    return {
        runLocalFixFromRevision: (coreConfig, revision, options) =>
            runLocalFixFromRevision(coreConfig, revision, options, runnerDependencies),
        startAdguardCliBlocker: unconfiguredBlockerStub(),
    };
}
