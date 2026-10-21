import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../src/agent/tool-registry';
import { CUSTOM_FILTERS_GROUP_ID } from '../../src/browser/adguard-custom-filters';
import { AdGuardExtensionMessageType } from '../../src/browser/adguard-extension-message-types';
import type { AdGuardExtensionStateRead } from '../../src/browser/adguard-extension-state-shapes';
import type { BrowserSession } from '../../src/browser/browser-session';
import {
    ExtensionManifestVersion,
    PreparedExtensionSource,
} from '../../src/environment/extension-preparation';
import type { ListSlice } from '../../src/environment/list-slice';
import { createLoopbackTextServer } from '../../src/local/loopback-text-server';
import { AgentRuntime, type AgentRuntimeDependencies } from '../../src/orchestrator/agent-runtime';
import type { PiRuntime } from '../../src/pi/runtime';
import type { SingleShotClient } from '../../src/pi/single-shot-types';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import { FilterEngine } from '../../src/types/filter-engine';
import type { IssueFacts } from '../../src/types/issue-facts';
import { testCoreConfig } from '../config/test-core-config';
import {
    fakePreparedExtensionSurface,
    type FakePreparedExtensionSurface,
} from '../environment/test-filtering-environment-fixtures';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const APP_VERSION = '5.5.2.3';
const BASE_FILTER_ID = 2;
const HEBREW_FILTER_ID = 108;
const TARGET_URL = 'https://www.walla.co.il/';

/**
 * The build's text of EasyList Hebrew as the pinned build stores it: the published checksum header
 * on line 1, CRLF line ends, five lines in all.
 */
const HEBREW_LINES = [
    '! Checksum: 5eV9kU2vJ1Xm3Q0HkFjJ7A',
    'walla.co.il##.ad-banner',
    '||ads.walla.co.il^$third-party',
    'walla.co.il##.sidebar-promo',
    'walla.co.il##.footer-promo',
];

/**
 * The build's text of the Base filter: three lines, so the answer's list line counts are told apart
 * from the sliced list's.
 */
const BASE_LINES = ['! Title: AdGuard Base filter', 'example.com##.ad', '||ads.example^'];

const rawIssue = {
    number: 242336,
    url: 'https://github.com/AdguardTeam/AdguardFilters/issues/242336',
    title: 'www.walla.co.il',
    body: 'AdGuard Browser Extension v5.5.2.47 MV3',
    state: 'open' as const,
    labels: ['T: Incorrect Blocking'],
    assignee: null,
    comments: [],
};

const facts: IssueFacts = {
    issueNumber: 242336,
    issueUrl: rawIssue.url,
    reportedSiteUrls: [],
    labels: rawIssue.labels,
    problemType: 'unknown',
    product: 'AdGuard Browser Extension v5.5.2.47 MV3',
    enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: BASE_FILTER_ID }],
    screenshots: [],
};

const visionStub: SingleShotClient = {
    modelId: 'vision-model',
    structured: async () => {
        throw new Error('not used by this suite');
    },
    text: async () => {
        throw new Error('not used by this suite');
    },
};

const browserProfile = {
    viewport: 'desktop' as const,
    locale: 'he-IL',
    timezone: 'Asia/Jerusalem',
    consentStrategy: 'untouched' as const,
};

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

/**
 * Writes an unpacked build: the manifest, the catalog naming both lists, and one declarative
 * ruleset per list whose dummy first rule carries the list text.
 */
function writeUnpackedBuild(): string {
    const root = mkdtempSync(join(tmpdir(), 'list-slice-runtime-'));
    temporaryRoots.push(root);
    writeFileSync(
        join(root, 'manifest.json'),
        JSON.stringify({ manifest_version: 3, version: APP_VERSION }),
    );
    mkdirSync(join(root, 'filters'), { recursive: true });
    writeFileSync(
        join(root, 'filters', 'filters_i18n.json'),
        JSON.stringify({
            groups: {},
            tags: {},
            filters: { [BASE_FILTER_ID]: {}, [HEBREW_FILTER_ID]: {} },
        }),
    );
    for (const [filterId, lines] of [
        [BASE_FILTER_ID, BASE_LINES],
        [HEBREW_FILTER_ID, HEBREW_LINES],
    ] as const) {
        const rulesetDir = join(root, 'filters', 'declarative', `ruleset_${filterId}`);
        mkdirSync(rulesetDir, { recursive: true });
        writeFileSync(
            join(rulesetDir, `ruleset_${filterId}.json`),
            JSON.stringify([
                {
                    id: 1,
                    priority: 1,
                    action: { type: 'allow' },
                    condition: { urlFilter: 'dummy-metadata-rule' },
                    metadata: { filterContent: `${lines.join('\r\n')}\r\n` },
                },
            ]),
        );
    }
    return root;
}

/**
 * The host read-back as the fake surface's current state reports it: the built-in filters it has
 * on, every custom filter the last import installed, no user rules, Stealth off, and the MV3
 * counters with the dynamic-rule budget the slice's custom filter draws on.
 */
function surfaceReadBack(surface: FakePreparedExtensionSurface): AdGuardExtensionStateRead {
    const enabled = surface.enabledFilterIds();
    const customs = surface.customFilters();
    return {
        extensionId: EXTENSION_ID,
        optionsPageUrl: `chrome-extension://${EXTENSION_ID}/pages/options.html`,
        manifestVersion: ExtensionManifestVersion.Mv3,
        filterEngine: FilterEngine.DeclarativeNetRequest,
        appVersion: APP_VERSION,
        optionsEnabledFilterIds: [...enabled, ...customs.map((custom) => custom.filterId)],
        optionsData: {
            appVersion: APP_VERSION,
            settings: { values: { 'stealth-disable-stealth-mode': true } },
            filtersMetadata: {
                filters: [
                    {
                        filterId: BASE_FILTER_ID,
                        enabled: enabled.includes(BASE_FILTER_ID),
                        name: 'AdGuard Base filter',
                        groupId: 1,
                    },
                    {
                        filterId: HEBREW_FILTER_ID,
                        enabled: enabled.includes(HEBREW_FILTER_ID),
                        name: 'EasyList Hebrew',
                        groupId: 7,
                    },
                    ...customs.map((custom) => ({
                        filterId: custom.filterId,
                        enabled: true,
                        name: custom.name,
                        groupId: CUSTOM_FILTERS_GROUP_ID,
                    })),
                ],
                categories: [
                    { groupId: 1, groupName: 'Ad Blocking' },
                    { groupId: 7, groupName: 'Language-specific' },
                    { groupId: CUSTOM_FILTERS_GROUP_ID, groupName: 'Custom' },
                ],
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
        rulesLimits: {
            dynamicRulesEnabledCount: 3,
            dynamicRulesMaximumCount: 30_000,
            dynamicRulesUnsafeEnabledCount: 0,
            dynamicRulesUnsafeMaximumCount: 5_000,
            dynamicRulesRegexpsEnabledCount: 1,
            dynamicRulesRegexpsMaximumCount: 1_000,
            staticFiltersEnabledCount: enabled.length,
            staticFiltersMaximumCount: 10,
            staticRulesEnabledCount: 1_000,
            staticRulesMaximumCount: 300_000,
            staticRulesRegexpsEnabledCount: 10,
            staticRulesRegexpsMaxCount: 1_000,
            actuallyEnabledFilters: [...enabled],
            expectedEnabledFilters: [...enabled],
            areFilterLimitsExceeded: false,
        },
    };
}

/**
 * A browser registry whose apply_rule must never be reached from a slice session: reaching it is
 * the failure the slice refusal exists to prevent.
 */
function browserRegistryWithApplyRule(onApplyRule: () => Record<string, unknown>): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
        definition: {
            type: 'function',
            function: {
                name: 'apply_rule',
                description: 'Validate a candidate.',
                parameters: { type: 'object', properties: {} },
            },
        },
        handler: async () => onApplyRule(),
    });
    return registry;
}

/**
 * The `launch_browser` request of a prepared session running both lists, with the given slice.
 */
function launchRequest(slice?: ListSlice): Record<string, unknown> {
    return {
        extension: 'prepared',
        targetUrl: TARGET_URL,
        profile: browserProfile,
        settings: {
            kind: 'agent_selected',
            filterIds: [BASE_FILTER_ID, HEBREW_FILTER_ID],
            stealthEnabled: false,
            ...(slice === undefined ? {} : { slice }),
        },
    };
}

/**
 * A runtime over an unpacked build with fake prepared-extension surfaces: every launched session
 * gets a fresh surface and the state read reflects it.
 */
async function createSliceRuntime(overrides: Partial<AgentRuntimeDependencies> = {}) {
    const extensionPath = writeUnpackedBuild();
    const session = {
        surface: fakePreparedExtensionSurface({ initialEnabledFilterIds: [BASE_FILTER_ID] }),
    };
    const validatorReached = vi.fn(() => ({ validationArtifactId: 'validation-1' }));
    const runtime = await AgentRuntime.create(
        {
            issue: rawIssue,
            issueFacts: facts,
            issueAttachmentArtifactIds: [],
            allowedTargetUrls: [TARGET_URL],
            artifactsDir: extensionPath,
            filtersPath: extensionPath,
            headless: true,
            noSandbox: false,
            vision: visionStub,
            recorder: new TraceRecorder({
                runId: 'agent-runtime-list-slice',
                issueNumber: rawIssue.number,
                mode: 'fix',
            }),
            preparedExtension: {
                extensionPath,
                manifestVersion: ExtensionManifestVersion.Mv3,
                userScriptsPermission: true,
                source: PreparedExtensionSource.PinnedRelease,
                extensionSourceSha256: 'e'.repeat(64),
                extensionSourceTag: `v${APP_VERSION}`,
            },
            llm: testCoreConfig().llm,
            piRuntime: {} as unknown as PiRuntime,
        },
        {
            createBaseRegistry: async () => new ToolRegistry(),
            createBrowserSession: async () => {
                session.surface = fakePreparedExtensionSurface({
                    initialEnabledFilterIds: [BASE_FILTER_ID],
                });
                return {
                    close: vi.fn(),
                    extensionContext: session.surface.context,
                } as unknown as BrowserSession;
            },
            createBrowserRegistry: async () => browserRegistryWithApplyRule(validatorReached),
            readAdGuardExtensionState: vi.fn(async () => surfaceReadBack(session.surface)),
            findExtensionRuntime: vi.fn(async () => ({
                extensionId: EXTENSION_ID,
                manifestVersion: ExtensionManifestVersion.Mv3,
            })),
            ...overrides,
        },
    );
    await runtime.registry.dispatch('fetch_issue', { issueNumber: rawIssue.number });
    return { runtime, session, validatorReached };
}

describe('AgentRuntime list slice', () => {
    it('runs one list as a served slice, reports its facts and refuses to validate in it', async () => {
        const { runtime, session, validatorReached } = await createSliceRuntime();
        try {
            const launched = await runtime.registry.dispatch(
                'launch_browser',
                launchRequest({ filterId: HEBREW_FILTER_ID, firstLine: 1, lastLine: 3 }),
            );

            const imported = session.surface.messages.findIndex(
                (message) => message.type === AdGuardExtensionMessageType.ApplySettingsJson,
            );
            expect(imported).toBeGreaterThanOrEqual(0);

            // The document installs the slice as one trusted custom filter served by the run, and
            // the built-in list it replaces is not among the enabled filters.
            const document = JSON.parse(String(session.surface.messages[imported]!.data?.json)) as {
                filters: {
                    'enabled-filters': number[];
                    'custom-filters': Array<{
                        customUrl: string;
                        title: string;
                        trusted: boolean;
                        enabled: boolean;
                    }>;
                };
            };
            expect(document.filters['enabled-filters']).toEqual([BASE_FILTER_ID]);
            expect(document.filters['custom-filters']).toHaveLength(1);
            const custom = document.filters['custom-filters'][0]!;
            expect(custom).toMatchObject({
                title: 'EasyList Hebrew lines 1-3 of 5',
                trusted: true,
                enabled: true,
            });
            const served = await fetch(custom.customUrl);
            expect(served.status).toBe(200);
            expect(await served.text()).toBe(`${HEBREW_LINES[1]}\n${HEBREW_LINES[2]}\n`);

            expect(launched).toMatchObject({
                launched: true,
                settingsVerified: true,
                listSlice: {
                    filterId: HEBREW_FILTER_ID,
                    firstLine: 1,
                    lastLine: 3,
                    totalLines: 5,
                    customFilterId: 1000,
                    dynamicRules: { enabled: 3, maximum: 30_000 },
                    atLimit: false,
                    lines: HEBREW_LINES.slice(0, 3),
                },
            });
            expect(launched.enabledLists).toEqual([
                { id: BASE_FILTER_ID, name: 'AdGuard Base filter', lines: BASE_LINES.length },
                { id: HEBREW_FILTER_ID, name: 'EasyList Hebrew', lines: HEBREW_LINES.length },
            ]);

            // A candidate cannot be judged against a slice: refused before any ledger entry.
            for (const candidateRule of [
                '@@||ads.walla.co.il^$third-party',
                'walla.co.il#@#.ad-banner',
                'walla.co.il#@#.sidebar-promo',
            ]) {
                const refused = await runtime.registry.dispatch('apply_rule', { candidateRule });
                expect(refused).toMatchObject({ errorKind: 'slice_session', retryable: true });
                expect(refused.listSlice).toEqual({
                    filterId: HEBREW_FILTER_ID,
                    firstLine: 1,
                    lastLine: 3,
                });
            }
            expect(validatorReached).not.toHaveBeenCalled();

            // A range past the list's end is refused naming the line count, before any launch.
            const refusedRange = await runtime.registry.dispatch(
                'launch_browser',
                launchRequest({ filterId: HEBREW_FILTER_ID, firstLine: 1, lastLine: 9 }),
            );
            expect(refusedRange).toMatchObject({
                errorKind: 'invalid_list_slice',
                retryable: true,
                totalLines: 5,
            });

            // The slice refusals spent no candidate attempt: a fourth distinct candidate in a
            // session without a slice still reaches the validator instead of the attempt limit.
            const relaunched = await runtime.registry.dispatch('launch_browser', launchRequest());
            expect(relaunched).toMatchObject({ launched: true, settingsVerified: true });
            expect(relaunched.listSlice).toBeUndefined();
            const validated = await runtime.registry.dispatch('apply_rule', {
                candidateRule: 'walla.co.il#@#.footer-promo',
            });
            expect(validated.errorKind).toBeUndefined();
            expect(validatorReached).toHaveBeenCalledTimes(1);
        } finally {
            await runtime.dispose();
            await runtime.releaseHostState();
        }
    });

    it('runs a slice of the only selected list, with no built-in list on', async () => {
        // The last steps of a halving run one list alone; its slice is then the whole session.
        const { runtime, session } = await createSliceRuntime();
        try {
            const launched = await runtime.registry.dispatch('launch_browser', {
                ...launchRequest(),
                settings: {
                    kind: 'agent_selected',
                    filterIds: [HEBREW_FILTER_ID],
                    stealthEnabled: false,
                    slice: { filterId: HEBREW_FILTER_ID, firstLine: 4, lastLine: 5 },
                },
            });

            expect(launched).toMatchObject({
                launched: true,
                settingsVerified: true,
                listSlice: { filterId: HEBREW_FILTER_ID, firstLine: 4, lastLine: 5, totalLines: 5 },
            });
            expect(session.surface.enabledFilterIds()).toEqual([]);
            expect(session.surface.customFilters()).toHaveLength(1);
            expect(launched.enabledLists).toEqual([
                { id: HEBREW_FILTER_ID, name: 'EasyList Hebrew', lines: HEBREW_LINES.length },
            ]);
        } finally {
            await runtime.dispose();
            await runtime.releaseHostState();
        }
    });

    it('settles a text server that cannot listen as an unverified slice and retries it next time', async () => {
        const createTextServer = vi
            .fn(createLoopbackTextServer)
            .mockRejectedValueOnce(new Error('listen EADDRINUSE: address already in use'));
        const { runtime } = await createSliceRuntime({
            createLoopbackTextServer: createTextServer,
        });
        try {
            const slice = { filterId: HEBREW_FILTER_ID, firstLine: 1, lastLine: 3 };

            // The session is launched and stays usable; only its Baseline is unverified. A launch
            // failure would mark the environment failed and spend the technical browser budget.
            const unverified = await runtime.registry.dispatch(
                'launch_browser',
                launchRequest(slice),
            );
            expect(unverified).toMatchObject({ launched: true, settingsVerified: false });
            expect(unverified.errorKind).toBeUndefined();
            expect(unverified.listSlice).toBeUndefined();

            // The failed start is not remembered: the next slice launch starts the server again.
            const verified = await runtime.registry.dispatch(
                'launch_browser',
                launchRequest(slice),
            );
            expect(createTextServer).toHaveBeenCalledTimes(2);
            expect(verified).toMatchObject({
                launched: true,
                settingsVerified: true,
                listSlice: { ...slice, totalLines: 5 },
            });
        } finally {
            await runtime.dispose();
            await runtime.releaseHostState();
        }
    });
});
