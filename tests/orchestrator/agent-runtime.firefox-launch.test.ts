import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../src/agent/tool-registry';
import type { BrowserSession, BrowserSessionConfig } from '../../src/browser/browser-session';
import { ExtensionLaunchFamily } from '../../src/environment/extension-launch';
import { PreparedExtensionSource } from '../../src/environment/extension-preparation';
import type { LoadedInstruction } from '../../src/knowledge/instruction-loader';
import type { PreparedExtension } from '../../src/local/prepared-extension';
import { AgentRuntime, type AgentRuntimeOptions } from '../../src/orchestrator/agent-runtime';
import { extensionFilteringExecutor } from '../../src/orchestrator/extension-filtering-executor';
import { REPORTER_SETTINGS_SESSION_REQUIRED } from '../../src/orchestrator/validation-baseline-lock';
import {
    FilteringExecutorRegistry,
    type ExecutorAdapterContext,
} from '../../src/orchestrator/filtering-executors';
import type { FilteringEnvironmentAdapter } from '../../src/environment/filtering-environment';
import type { PiRuntime } from '../../src/pi/runtime';
import type { SingleShotClient } from '../../src/pi/single-shot-types';
import { PromptDocumentName, createPromptDocumentLoader } from '../../src/prompts/prompt-documents';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import type { IssueFacts } from '../../src/types/issue-facts';
import { testCoreConfig } from '../config/test-core-config';

/**
 * The extension id the uBlock Origin example declares.
 */
const UBLOCK_EXTENSION_ID = 'uBlock0@raymondhill.net';

/**
 * The user-filters file the uBlock Origin example's state verification declares, relative to the
 * run's host-state root.
 */
const DECLARED_USER_FILTERS = join('filters-agent', 'ublock', 'user-filters.txt');

const rawIssue = {
    number: 4242,
    url: 'https://github.com/uBlockOrigin/uAssets/issues/4242',
    title: 'Ad leftover',
    body: 'uBlock Origin in Firefox leaves an ad slot on the article page.',
    state: 'open' as const,
    labels: ['T: Ads'],
    assignee: null,
    comments: [],
};

/**
 * Issue facts naming one resolvable filter list: the environment selection exposes the browser
 * lifecycle only once the report's filter selection resolves, which is independent of the launch
 * family this suite is about.
 */
const issueFacts: IssueFacts = {
    issueNumber: 4242,
    issueUrl: 'https://github.com/uBlockOrigin/uAssets/issues/4242',
    reportedSiteUrls: [],
    labels: ['T: Ads'],
    problemType: 'unknown',
    product: 'uBlock Origin in Firefox',
    enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
    screenshots: [],
};

const browserProfile = {
    viewport: 'desktop' as const,
    locale: 'en-US',
    timezone: 'UTC',
    consentStrategy: 'untouched' as const,
};

/**
 * A SingleShotClient stub; this suite never reaches a vision call.
 */
const visionStub: SingleShotClient = {
    modelId: 'vision-model',
    structured: async () => {
        throw new Error('not used by this suite');
    },
    text: async () => {
        throw new Error('not used by this suite');
    },
};

/**
 * The shipped uBlock Origin example, loaded the way a run loads its instruction.
 *
 * @returns The loaded instruction.
 */
function ublockInstruction(): LoadedInstruction {
    const content = createPromptDocumentLoader().read(
        PromptDocumentName.InstructionsUblockOriginFirefox,
    );
    return {
        path: 'instructions/ublock-origin-firefox.md',
        content,
        sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
        documents: [],
    };
}

/**
 * The Firefox-family build the uBlock Origin example's preparation declares.
 *
 * @returns The prepared extension record.
 */
function firefoxPreparedExtension(): PreparedExtension {
    return {
        launchFamily: ExtensionLaunchFamily.Firefox,
        extensionId: UBLOCK_EXTENSION_ID,
        xpiPath: join(tmpdir(), 'ublock-origin.firefox.signed.xpi'),
        managedStorageTemplate: {
            adminSettings: { selectedFilterLists: ['user-filters', 'ublock-filters'] },
        },
        userFiltersKeyPath: ['adminSettings', 'userFilters'],
        source: PreparedExtensionSource.Instruction,
        extensionSourceSha256: 'e'.repeat(64),
    };
}

/**
 * The run options of a Firefox-family run over one temporary checkout.
 *
 * @param checkout - The run's checkout root; the declared user-filters file is not in it — the host
 *   maintains that file in the run's own host-state directory instead.
 * @returns Runtime options for `AgentRuntime.create`.
 */
function firefoxRunOptions(checkout: string): AgentRuntimeOptions {
    return {
        issue: rawIssue,
        issueFacts,
        issueAttachmentArtifactIds: [],
        allowedTargetUrls: ['https://example.test/article'],
        artifactsDir: mkdtempSync(join(tmpdir(), 'firefox-launch-artifacts-')),
        filtersPath: checkout,
        headless: true,
        noSandbox: false,
        vision: visionStub,
        recorder: new TraceRecorder({
            runId: 'agent-runtime-firefox-launch-test',
            issueNumber: rawIssue.number,
            mode: 'fix',
        }),
        instruction: ublockInstruction(),
        preparedExtension: firefoxPreparedExtension(),
        llm: testCoreConfig().llm,
        piRuntime: {} as unknown as PiRuntime,
    };
}

/**
 * A base registry carrying the rule-guidance tool the environment lifecycle expects.
 *
 * @returns The registry.
 */
function baseRegistryWithGuidance(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
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
    return registry;
}

/**
 * A browser registry whose `apply_rule` the runtime replaces with its own environment validation.
 *
 * @returns The registry.
 */
function browserRegistryWithApplyRule(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
        definition: {
            type: 'function',
            function: {
                name: 'apply_rule',
                description: 'Validate the candidate with the common environment.',
                parameters: { type: 'object', properties: {} },
            },
        },
        handler: async () => ({ legacy: true }),
    });
    return registry;
}

/**
 * An adapter that records its preparation request and refuses to go ready, so the run stops at the
 * environment boundary this suite is about instead of entering a full A/B/C experiment.
 *
 * @returns The adapter.
 */
function notReadyAdapter(): FilteringEnvironmentAdapter {
    const limitation = {
        code: 'phase_open_failed',
        stage: 'preparation',
        detail: 'This suite stops at the environment boundary.',
    } as const;
    return {
        kind: 'browser_extension',
        capabilities: () => ['browser_navigation', 'filtering_control'],
        prepare: vi.fn(async () => ({ ready: false as const, limitation })),
        openPhase: vi.fn(async () => ({ ready: false as const, limitation })),
        drainOpenHandles: vi.fn(async () => ({
            attempted: 0,
            closed: 0,
            failed: 0,
            failures: [],
        })),
        cleanup: vi.fn(async () => ({
            attempted: true,
            completed: true,
            finalizerAttempts: 0,
            finalizerCompleted: 0,
            finalizerFailed: 0,
            failures: [],
        })),
        snapshot: () => ({
            kind: 'browser_extension',
            lifecycle: 'limited',
            stateDigest: 'a'.repeat(64),
            actualContext: {
                kind: 'browser_extension',
                product: UBLOCK_EXTENSION_ID,
                browser: 'Playwright Firefox',
                productVersion: null,
            },
            capabilities: ['browser_navigation', 'filtering_control'],
            preparation: null,
            baseline: null,
            openLeaseIds: [],
            cleanup: null,
        }),
    };
}

describe('AgentRuntime Firefox-family launch', () => {
    it('launches Firefox with policies carrying the declared user-filters file content', async () => {
        const checkout = mkdtempSync(join(tmpdir(), 'firefox-launch-checkout-'));
        const createBrowserSession = vi.fn(
            async (_config: BrowserSessionConfig) =>
                ({ close: vi.fn() }) as unknown as BrowserSession,
        );
        const runtime = await AgentRuntime.create(firefoxRunOptions(checkout), {
            createBaseRegistry: async () => new ToolRegistry(),
            createBrowserSession,
            createBrowserRegistry: async () => new ToolRegistry(),
        });
        try {
            // The declared relative target resolves inside the run's host-state root, which is
            // where the between-phases application maintains it; the launch carries whatever that
            // file holds at that moment into managed storage.
            const declaredFile = join(runtime.getHostStateRoot(), DECLARED_USER_FILTERS);
            mkdirSync(dirname(declaredFile), { recursive: true });
            writeFileSync(declaredFile, '||ads.example^\n', 'utf8');

            const launched = await runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://example.test/article',
                profile: browserProfile,
            });

            expect(createBrowserSession).toHaveBeenCalledTimes(1);
            const config = createBrowserSession.mock.calls[0]![0];
            expect(config.engine.browserType).toBe('firefox');
            expect(config.reproProfile.userAgentProfile).toBe('Firefox');
            expect(config).not.toHaveProperty('adguardExtensionPath');
            expect(
                config.firefoxPolicies?.policies['3rdparty']?.Extensions[UBLOCK_EXTENSION_ID],
            ).toEqual({
                adminSettings: {
                    selectedFilterLists: ['user-filters', 'ublock-filters'],
                    userFilters: '||ads.example^\n',
                },
            });
            // The baseline of this family is the instruction's own declaration, applied by the
            // browser when it force-installed the XPI: the launch is credited with it and names the
            // exact selection, instead of claiming an AdGuard-style live settings proof it cannot
            // take.
            expect(launched).toMatchObject({
                launched: true,
                settingsVerified: true,
                settingsEnabledLists: ['declared:ublock-filters', 'declared:user-filters'],
            });
            expect(String((launched as { settingsDetail?: unknown }).settingsDetail)).toContain(
                UBLOCK_EXTENSION_ID,
            );
            // The credited session is the one every terminal gate reads back, and its evidence
            // carries the declared selection: without it the session would look uncredited to those
            // gates, the way it does for a prepared session that never proved a baseline at all.
            const verified = runtime.getLatestVerifiedSettingsEnvironment();
            expect(verified?.sessionId).toBe((launched as { sessionId: string }).sessionId);
            expect(verified?.declaredBaselineListKeys).toEqual([
                'declared:ublock-filters',
                'declared:user-filters',
            ]);
            expect(verified?.extensionBaselineReadBack).toBeUndefined();
        } finally {
            await runtime.dispose();
            await runtime.releaseHostState();
        }
    });

    it('builds the Firefox blocker environment from the declaration and requests no AdGuard list', async () => {
        const checkout = mkdtempSync(join(tmpdir(), 'firefox-environment-checkout-'));
        const adapterContexts: ExecutorAdapterContext[] = [];
        const adapter = notReadyAdapter();
        const registry = new FilteringExecutorRegistry();
        const { createAdapter: _production, ...registration } = extensionFilteringExecutor;
        void _production;
        registry.register({
            ...registration,
            createAdapter: (context) => {
                adapterContexts.push(context);
                return adapter;
            },
        });
        const runtime = await AgentRuntime.create(
            {
                ...firefoxRunOptions(checkout),
                recorder: new TraceRecorder({
                    runId: 'agent-runtime-firefox-environment-test',
                    issueNumber: rawIssue.number,
                    mode: 'fix',
                }),
            },
            {
                createBaseRegistry: async () => baseRegistryWithGuidance(),
                createBrowserSession: async () => ({ close: vi.fn() }) as unknown as BrowserSession,
                createBrowserRegistry: async () => browserRegistryWithApplyRule(),
                filteringExecutors: registry,
            },
        );
        try {
            // The run's baseline state: the host has written nothing into its host-state root yet,
            // so the declared user-filters file is absent and the launch carries empty filters.
            const declaredFile = join(runtime.getHostStateRoot(), DECLARED_USER_FILTERS);
            mkdirSync(dirname(declaredFile), { recursive: true });
            writeFileSync(declaredFile, '', 'utf8');

            await runtime.registry.dispatch('fetch_issue', { issueNumber: rawIssue.number });
            await runtime.registry.dispatch('lookup_rule_guidance', {});
            await runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://example.test/article',
                profile: browserProfile,
            });
            // Decision 1: the run's executable baseline is the declaration, so the selection locks
            // ready without resolving a single reported name against AdGuard's official catalog —
            // which those uBlock Origin list names never could.
            expect(runtime.getEnvironmentSelection()).toMatchObject({
                state: 'ready',
                filterBaseline: {
                    status: 'declared',
                    listKeys: ['declared:ublock-filters', 'declared:user-filters'],
                },
            });

            await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'example.test##.articleAdSlot',
            });

            expect(adapterContexts).toHaveLength(1);
            expect(adapterContexts[0]!.requestedLists).toEqual([]);
            expect(adapterContexts[0]!.extensionOptions).toBeUndefined();
            expect(adapterContexts[0]!.firefoxExtensionOptions).toMatchObject({
                extensionId: UBLOCK_EXTENSION_ID,
                declaredListKeys: ['declared:ublock-filters', 'declared:user-filters'],
            });
            expect(adapter.prepare).toHaveBeenCalledWith({ requestedLists: [] });
        } finally {
            await runtime.dispose();
            await runtime.releaseHostState();
        }
    });

    it('verifies rules on an issue that carries an AdGuard settings import', async () => {
        // A uBlock Origin session takes no settings, so an AdGuard import in the issue names
        // nothing it could reproduce: the declared baseline stays the one that verifies rules.
        const importUrl =
            'https://reports.adguard.com/settings/import.html?scheme_version=4&' +
            'product_version=5.4.3.99&regular_filters=2,3&stealth.enabled=0';
        const checkout = mkdtempSync(join(tmpdir(), 'firefox-import-checkout-'));
        const adapterContexts: ExecutorAdapterContext[] = [];
        const registry = new FilteringExecutorRegistry();
        const { createAdapter: _production, ...registration } = extensionFilteringExecutor;
        void _production;
        registry.register({
            ...registration,
            createAdapter: (context) => {
                adapterContexts.push(context);
                return notReadyAdapter();
            },
        });
        const runtime = await AgentRuntime.create(
            {
                ...firefoxRunOptions(checkout),
                issue: { ...rawIssue, body: `${rawIssue.body}\n\nSettings: ${importUrl}` },
                recorder: new TraceRecorder({
                    runId: 'agent-runtime-firefox-import-test',
                    issueNumber: rawIssue.number,
                    mode: 'fix',
                }),
            },
            {
                createBaseRegistry: async () => baseRegistryWithGuidance(),
                createBrowserSession: async () => ({ close: vi.fn() }) as unknown as BrowserSession,
                createBrowserRegistry: async () => browserRegistryWithApplyRule(),
                filteringExecutors: registry,
            },
        );
        try {
            const declaredFile = join(runtime.getHostStateRoot(), DECLARED_USER_FILTERS);
            mkdirSync(dirname(declaredFile), { recursive: true });
            writeFileSync(declaredFile, '', 'utf8');
            await runtime.registry.dispatch('fetch_issue', { issueNumber: rawIssue.number });
            await runtime.registry.dispatch('lookup_rule_guidance', {});
            const launched = await runtime.registry.dispatch('launch_browser', {
                extension: 'prepared',
                targetUrl: 'https://example.test/article',
                profile: browserProfile,
            });

            // The declared-baseline session is one a verdict can bind to.
            expect(runtime.getLatestVerifiedSettingsEnvironment()?.sessionId).toBe(
                (launched as { sessionId: string }).sessionId,
            );

            const applied = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'example.test##.articleAdSlot',
            });

            expect(applied.errorKind).not.toBe(REPORTER_SETTINGS_SESSION_REQUIRED);
            expect(adapterContexts).toHaveLength(1);
        } finally {
            await runtime.dispose();
            await runtime.releaseHostState();
        }
    });
});
