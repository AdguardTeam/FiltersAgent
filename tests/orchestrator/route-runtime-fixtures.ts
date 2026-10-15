import { vi } from 'vitest';
import { ToolRegistry } from '../../src/agent/tool-registry';
import type { BrowserSession } from '../../src/browser/browser-session';
import type {
    EvidenceRouteHost,
    EvidenceRoutePorts,
    EvidenceRouteSnapshot,
} from '../../src/local/evidence-route-contract';
import type { FilteringEnvironmentAdapter } from '../../src/environment/filtering-environment';
import type { PreparedExtension } from '../../src/local/prepared-extension';
import {
    ExtensionManifestVersion,
    PreparedExtensionSource,
} from '../../src/environment/extension-preparation';
import type {
    ExecutorAdapterContext,
    FilteringExecutor,
} from '../../src/orchestrator/filtering-executors';
import type { AgentRuntimeOptions } from '../../src/orchestrator/agent-runtime';
import type { SingleShotClient } from '../../src/pi/single-shot-types';
import type { PiRuntime } from '../../src/pi/runtime';
import type { IssueFacts } from '../../src/types/issue-facts';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import { testCoreConfig } from '../config/test-core-config';

/**
 * The issue every runtime built from these fixtures fetches.
 */
export const rawIssue = {
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
 * Issue facts of `rawIssue` with the AdGuard Base filter as the reporter's only list.
 */
export const baseFacts: IssueFacts = {
    issueNumber: 235988,
    issueUrl: 'https://github.com/AdguardTeam/AdguardFilters/issues/235988',
    reportedSiteUrls: [],
    labels: ['T: Ads'],
    problemType: 'unknown',
    product: 'AdGuard Browser Extension v5.4.3.99 MV3',
    enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
    screenshots: [],
};

/**
 * The reproduction profile every fixture session launches with.
 */
export const browserProfile = {
    viewport: 'desktop' as const,
    locale: 'en-US',
    timezone: 'UTC',
    consentStrategy: 'untouched' as const,
};

/**
 * A SingleShotClient stub; the fixtures never reach a vision call.
 */
const visionStub: SingleShotClient = {
    modelId: 'vision-model',
    structured: async () => {
        throw new Error('not used by these fixtures');
    },
    text: async () => {
        throw new Error('not used by these fixtures');
    },
};

/**
 * A PiRuntime stub. Every test that reaches the application flow injects its own
 * `createPhaseApplicationModelRunner`, so the runtime carried on `AgentRuntimeOptions` is never
 * dereferenced; it exists only to satisfy the required option.
 */
const piRuntimeStub = {} as unknown as PiRuntime;

/**
 * Build the pinned prepared extension the runtime options carry.
 *
 * @returns A prepared extension that no route-executed flow ever launches.
 */
function preparedExtension(): PreparedExtension {
    return {
        extensionPath: '/tmp/cache/extension',
        manifestVersion: ExtensionManifestVersion.Mv3,
        source: PreparedExtensionSource.PinnedRelease,
        extensionSourceSha256: 'e'.repeat(64),
        extensionSourceTag: 'v5.5.2.3',
    };
}

/**
 * Build runtime options for `rawIssue` on the nettg.pl targets.
 *
 * @param issueFacts - Facts the run starts from.
 * @param runId - Trace run id, distinct per suite.
 * @returns Options for `AgentRuntime.create`.
 */
export function runtimeOptions(issueFacts: IssueFacts, runId: string): AgentRuntimeOptions {
    return {
        issue: rawIssue,
        issueFacts,
        issueAttachmentArtifactIds: [],
        allowedTargetUrls: ['https://nettg.pl/', 'https://nettg.pl/article/123'],
        artifactsDir: '/tmp/artifacts',
        filtersPath: '/tmp/filters',
        headless: true,
        noSandbox: false,
        vision: visionStub,
        recorder: new TraceRecorder({ runId, issueNumber: rawIssue.number, mode: 'fix' }),
        preparedExtension: preparedExtension(),
        llm: testCoreConfig().llm,
        piRuntime: piRuntimeStub,
    };
}

/**
 * Build the base registry with the rule-guidance lookup a candidate needs first.
 *
 * @returns Registry carrying `lookup_rule_guidance`.
 */
export function baseRegistryWithGuidance(): ToolRegistry {
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
 * Build the browser registry whose `apply_rule` the runtime replaces with the environment path and
 * whose `open_page` verifies navigation.
 *
 * @returns Registry carrying `apply_rule` and `open_page`.
 */
export function browserRegistryWithApplyRuleAndOpenPage(): ToolRegistry {
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
    registry.register({
        definition: {
            type: 'function',
            function: {
                name: 'open_page',
                description: 'Open the target page.',
                parameters: { type: 'object', properties: {} },
            },
        },
        handler: openedPage,
    });
    return registry;
}

/**
 * Answer `open_page` as a page that loaded.
 *
 * @param args - The tool arguments, carrying the URL to open.
 * @returns The opened URL with a successful status.
 */
async function openedPage(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return { url: args.url, statusCode: 200 };
}

/**
 * The product the probe executor's preparation binds as the actual context.
 */
export const PROBE_PRODUCT = 'Probe CLI';

/**
 * The product version the probe executor's preparation binds as the actual context.
 */
export const PROBE_VERSION = '1.4.13';

/**
 * The executor name the probe registers under.
 */
export const PROBE_EXECUTOR = 'probe_proxy';

/**
 * A route-adopting executor registration for the route-executed flows: a preparable probe that
 * binds a ready preparation and adopts a fake evidence route with the activation's reporter filter
 * ids, exactly as a proxy executor activation prepares and binds its route.
 *
 * @param route - The evidence route the activation adopts.
 * @param createAdapter - Adapter factory the run calls with its executor context.
 * @param reporterFilterIds - The reporter filter ids the activation hands the run.
 * @returns The registration to place in a hermetic run registry.
 */
export function routeAdoptingExecutor(
    route: EvidenceRouteHost,
    createAdapter: (context: ExecutorAdapterContext) => FilteringEnvironmentAdapter,
    reporterFilterIds: readonly number[],
): FilteringExecutor {
    return {
        name: PROBE_EXECUTOR,
        descriptor: {
            kind: PROBE_EXECUTOR,
            availability: 'available',
            preparationState: 'preparable',
            limitationCode: null,
            capabilities: ['cli_installation', 'cli_activation'],
        },
        selectionGuidance: 'Probe proxy guidance.',
        createAdapter,
        activate: async (context) => {
            context.environmentHost.attachExecutorPreparation({
                ready: true,
                provenance: {
                    source: 'official_release',
                    product: PROBE_PRODUCT,
                    version: PROBE_VERSION,
                    digestB32: 'digestb32examplevalue0123456789abcdefghijklmnopqrstuvwxyz',
                },
            });
            context.runtime.activateEvidenceRoute(route, [...reporterFilterIds]);
        },
    };
}

/**
 * A fake evidence route for the route-executed flows, with the spies a test asserts on to prove
 * what did and did not run behind a preparation request.
 *
 * @returns The route and the spies of its ports.
 */
export function probeEvidenceRoute() {
    const runBaselineAction = vi.fn(
        async (action: string, filterId: number | null) => `action=${action}:${filterId ?? ''}`,
    );
    const applyCandidate = vi.fn();
    const revokeCandidate = vi.fn();
    const launchEvidenceSession = vi.fn(
        async () => ({ close: vi.fn() }) as unknown as BrowserSession,
    );
    const ports: EvidenceRoutePorts = {
        cliVersion: PROBE_VERSION,
        product: PROBE_PRODUCT,
        installationDigest: 'a'.repeat(64),
        baselineHost: {
            cliDataRoot: '/synthetic/data',
            runBaselineAction,
            listStorageFiles: vi.fn(async () => []),
        },
        applyCandidate,
        revokeCandidate,
        applyBaselineEdit: vi.fn(),
        applyBaselineRemoval: vi.fn(),
        revokeBaselineEdit: vi.fn(),
    };
    const route: EvidenceRouteHost = {
        prepareConfiguration: vi.fn(async () => undefined),
        launchEvidenceSession,
        environmentPorts: vi.fn(() => ports),
        openAppliedRulesLog: async () => ({ read: vi.fn() }),
        snapshot: (): EvidenceRouteSnapshot => ({
            state: 'configured',
            port: null,
            baseFilterEnabled: false,
            reproducedFilterIds: [],
            unavailableFilterIds: [],
            failureCode: null,
        }),
    };
    return { route, runBaselineAction, applyCandidate, revokeCandidate, launchEvidenceSession };
}
