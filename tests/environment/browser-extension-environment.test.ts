import * as fsPromises from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import {
    BrowserExtensionEnvironmentAdapter,
    EnvironmentPhaseConfigurationOutcome,
    MAX_EXTENSION_BASELINE_BYTES,
    lockBrowserExtensionBaseline,
    type BrowserExtensionEnvironmentOptions,
    type EnvironmentPhaseConfigurationResult,
    type EnvironmentPhaseConfigurationRequest,
    type ExtensionBaselineSettings,
} from '../../src/environment/browser-extension-environment';
import { EnvironmentPhaseStateProofSchema } from '../../src/environment/environment-proofs';
import type { BaselineFileMetadata } from '../../src/environment/baseline-file-lock';
import { ConsoleCoverage, type IBrowserSession } from '../../src/browser/browser-interfaces';
import { officialAdguardListRef, type FilterListRef } from '../../src/environment/filter-list-ref';

/**
 * The application instruction a substituted phase-configuration records into its calls.
 */
const FIXTURE_APPLICATION = [
    '## Rule application',
    '',
    'Enable the requested filters on the prepared extension.',
    '',
    '## State verification',
    '',
    'read: extension-state user-rules',
    '',
].join('\n');

const settings: ExtensionBaselineSettings = {
    enabledFilterIds: [2],
    optionsEnabledFilterIds: [2],
    runtimeEnabledFilterIds: [2],
    activeRulesetFilterIds: [2],
    versions: new Map([[2, '2.0.0']]),
};

function metadata(overrides: Partial<BaselineFileMetadata> = {}): BaselineFileMetadata {
    return {
        size: 1,
        device: 1,
        inode: 2,
        modifiedMs: 1,
        regular: true,
        symbolicLink: false,
        ...overrides,
    };
}

async function fixture(filterIds: number[] = [2]): Promise<string> {
    const root = await fsPromises.mkdtemp(join(tmpdir(), 'extension-baseline-'));
    for (const filterId of filterIds) {
        const path = join(root, `filters/declarative/ruleset_${filterId}/ruleset_${filterId}.json`);
        await fsPromises.mkdir(join(root, `filters/declarative/ruleset_${filterId}`), {
            recursive: true,
        });
        await fsPromises.writeFile(path, '[{"id":1,"action":{"type":"block"}}]');
    }
    await fsPromises.writeFile(
        join(root, 'manifest.json'),
        JSON.stringify({
            manifest_version: 3,
            version: '5.0.0',
            declarative_net_request: {
                rule_resources: filterIds.map((filterId) => ({
                    id: `ruleset_${filterId}`,
                    enabled: true,
                    path: `filters/declarative/ruleset_${filterId}/ruleset_${filterId}.json`,
                })),
            },
        }),
    );
    return root;
}

describe('lockBrowserExtensionBaseline', () => {
    it('locks bundled MV2 filter texts and names downloaded filters as unattributed', async () => {
        const root = await fsPromises.mkdtemp(join(tmpdir(), 'extension-mv2-baseline-'));
        await fsPromises.mkdir(join(root, 'filters'), { recursive: true });
        await fsPromises.writeFile(
            join(root, 'filters', 'filter_2.txt'),
            '! base\n||ad.example^\n',
        );
        await fsPromises.writeFile(join(root, 'filters', 'filter_17.txt'), '! trackparam\n');
        await fsPromises.writeFile(
            join(root, 'manifest.json'),
            JSON.stringify({ manifest_version: 2, version: '5.4.3.1' }),
        );
        const mv2Settings: ExtensionBaselineSettings = {
            enabledFilterIds: [2, 17, 101],
            optionsEnabledFilterIds: [2, 17, 101],
            runtimeEnabledFilterIds: [2, 17, 101],
            activeRulesetFilterIds: [],
            versions: new Map([
                [2, '2.0.0'],
                [17, '1.0.0'],
                [101, '3.0.0'],
            ]),
        };

        const result = await lockBrowserExtensionBaseline({
            extensionRoot: root,
            settings: mv2Settings,
            acquiredAt: '2026-08-03T00:00:00.000Z',
        });

        expect(result.ready).toBe(true);
        if (!result.ready) {
            return;
        }
        expect(result.baseline).toMatchObject({
            environment: 'browser_extension',
            enabledListKeys: ['adguard:2', 'adguard:17', 'adguard:101'],
            resources: [
                {
                    listKey: 'adguard:2',
                    rulesetId: 'filter_2',
                    path: 'filters/filter_2.txt',
                    version: '2.0.0',
                },
                {
                    listKey: 'adguard:17',
                    rulesetId: 'filter_17',
                    path: 'filters/filter_17.txt',
                    version: '1.0.0',
                },
            ],
            unattributedListKeys: ['adguard:101'],
        });
        expect(result.baseline.resources[0].sha256).toMatch(/^[0-9a-f]{64}$/u);
    });

    it('rejects an MV2 baseline whose identity proofs disagree or claim active rulesets', async () => {
        const root = await fsPromises.mkdtemp(join(tmpdir(), 'extension-mv2-baseline-'));
        await fsPromises.mkdir(join(root, 'filters'), { recursive: true });
        await fsPromises.writeFile(join(root, 'filters', 'filter_2.txt'), '! base\n');
        await fsPromises.writeFile(
            join(root, 'manifest.json'),
            JSON.stringify({ manifest_version: 2, version: '5.4.3.1' }),
        );
        const withRulesets: ExtensionBaselineSettings = {
            enabledFilterIds: [2],
            optionsEnabledFilterIds: [2],
            runtimeEnabledFilterIds: [2],
            activeRulesetFilterIds: [2],
            versions: new Map([[2, '2.0.0']]),
        };
        const disagreeing: ExtensionBaselineSettings = {
            ...withRulesets,
            activeRulesetFilterIds: [],
            runtimeEnabledFilterIds: [2, 17],
        };

        const rulesetResult = await lockBrowserExtensionBaseline({
            extensionRoot: root,
            settings: withRulesets,
            acquiredAt: '2026-08-03T00:00:00.000Z',
        });
        const disagreeingResult = await lockBrowserExtensionBaseline({
            extensionRoot: root,
            settings: disagreeing,
            acquiredAt: '2026-08-03T00:00:00.000Z',
        });

        expect(rulesetResult.ready).toBe(false);
        expect(disagreeingResult.ready).toBe(false);
        if (!rulesetResult.ready) {
            expect(rulesetResult.limitation.code).toBe('settings_mismatch');
        }
        if (!disagreeingResult.ready) {
            expect(disagreeingResult.limitation.code).toBe('settings_mismatch');
        }
    });

    it('streams and locks the exact active MV3 ruleset bytes', async () => {
        const root = await fixture();

        const result = await lockBrowserExtensionBaseline({
            extensionRoot: root,
            settings,
            acquiredAt: '2026-07-24T00:00:00.000Z',
        });

        expect(result.ready).toBe(true);
        if (!result.ready) {
            return;
        }
        expect(result.baseline).toMatchObject({
            environment: 'browser_extension',
            enabledListKeys: ['adguard:2'],
            resources: [
                {
                    listKey: 'adguard:2',
                    rulesetId: 'ruleset_2',
                    path: 'filters/declarative/ruleset_2/ruleset_2.json',
                    version: '2.0.0',
                },
            ],
        });
        expect(result.baseline.resources[0].sha256).toMatch(/^[0-9a-f]{64}$/u);
    });

    it('locks a runtime-proven filter set even when the manifest ships other defaults', async () => {
        // Shipped MV3 manifests statically enable only their build defaults (ruleset_2); the
        // extension enables further rulesets at runtime through the DNR API. Live runs failed
        // baseline_integrity_unavailable for every non-default reporter set because the lock
        // read the static flags instead of the runtime-proven set, so the regression contract is
        // stated against realistic defaults here.
        const root = await fixture([2, 3, 4]);
        const filterIds = [2, 3, 4];

        const result = await lockBrowserExtensionBaseline({
            extensionRoot: root,
            settings: {
                enabledFilterIds: filterIds,
                optionsEnabledFilterIds: filterIds,
                runtimeEnabledFilterIds: filterIds,
                activeRulesetFilterIds: filterIds,
                versions: new Map(),
            },
            acquiredAt: '2026-07-24T00:00:00.000Z',
        });

        expect(result.ready).toBe(true);
        if (!result.ready) {
            return;
        }
        expect(result.baseline).toMatchObject({
            enabledListKeys: ['adguard:2', 'adguard:3', 'adguard:4'],
            resources: filterIds.map((filterId) => ({ listKey: `adguard:${filterId}` })),
        });
    });

    it('fails before opening content when manifest, resource count, or byte limits are exceeded', async () => {
        const cases = [
            { manifestSize: 2 * 1024 * 1024 + 1, resources: 1, selectedSize: 1 },
            { manifestSize: 100, resources: 129, selectedSize: 1 },
            { manifestSize: 100, resources: 1, selectedSize: 64 * 1024 * 1024 + 1 },
        ];
        for (const limits of cases) {
            let opened = false;
            const result = await lockBrowserExtensionBaseline(
                {
                    extensionRoot: '/opaque/root',
                    settings,
                    acquiredAt: '2026-07-24T00:00:00.000Z',
                },
                {
                    inspect: async (path) => ({
                        size: path.endsWith('manifest.json')
                            ? limits.manifestSize
                            : limits.selectedSize,
                        device: 1,
                        inode: path.endsWith('manifest.json') ? 1 : 2,
                        modifiedMs: 1,
                        regular: true,
                        symbolicLink: false,
                    }),
                    realpath: async (path) => path,
                    readBounded: async () => {
                        opened = true;
                        return JSON.stringify({
                            manifest_version: 3,
                            version: '5.0.0',
                            declarative_net_request: {
                                rule_resources: Array.from(
                                    { length: limits.resources },
                                    (_, index) => ({
                                        id: `ruleset_${index + 2}`,
                                        enabled: true,
                                        path: `filters/ruleset_${index + 2}.json`,
                                    }),
                                ),
                            },
                        });
                    },
                    openNoFollow: async () => ({
                        stat: async () => metadata({ size: limits.selectedSize }),
                        stream: async function* () {
                            opened = true;
                            yield new Uint8Array([1]);
                        },
                        close: async () => undefined,
                    }),
                },
            );

            expect(result).toMatchObject({ ready: false });
            if (limits.manifestSize > 2 * 1024 * 1024) {
                expect(opened).toBe(false);
            }
            if (limits.selectedSize > 64 * 1024 * 1024) {
                expect(opened).toBe(true); // the bounded manifest was read, ruleset bytes were not
            }
        }
    });

    it('rejects a descriptor identity mismatch and metadata drift during one opened stream', async () => {
        for (const drift of ['descriptor', 'during-stream'] as const) {
            let descriptorStats = 0;
            let closes = 0;
            const result = await lockBrowserExtensionBaseline(
                {
                    extensionRoot: '/opaque/root',
                    settings,
                    acquiredAt: '2026-07-24T00:00:00.000Z',
                },
                {
                    inspect: async (path) =>
                        metadata({ inode: path.endsWith('manifest.json') ? 1 : 2 }),
                    realpath: async (path) => path,
                    readBounded: async () =>
                        JSON.stringify({
                            manifest_version: 3,
                            declarative_net_request: {
                                rule_resources: [
                                    {
                                        id: 'ruleset_2',
                                        enabled: true,
                                        path: 'filters/ruleset_2.json',
                                    },
                                ],
                            },
                        }),
                    openNoFollow: async () => ({
                        stat: async () => {
                            descriptorStats += 1;
                            if (drift === 'descriptor') {
                                return metadata({ inode: 3 });
                            }
                            return metadata({ modifiedMs: descriptorStats === 1 ? 1 : 2 });
                        },
                        stream: async function* () {
                            yield new Uint8Array([1]);
                        },
                        close: async () => {
                            closes += 1;
                        },
                    }),
                },
            );

            expect(result).toMatchObject({
                ready: false,
                limitation: { code: 'baseline_resource_changed' },
            });
            expect(descriptorStats).toBe(2);
            expect(closes).toBe(1);
        }
    });

    it('rejects a 256 MiB plus one aggregate before opening any selected resource', async () => {
        const filterIds = [2, 3, 4, 5, 6];
        const aggregateSettings: ExtensionBaselineSettings = {
            enabledFilterIds: filterIds,
            optionsEnabledFilterIds: filterIds,
            runtimeEnabledFilterIds: filterIds,
            activeRulesetFilterIds: filterIds,
            versions: new Map(),
        };
        const sizes = new Map(
            filterIds.map((filterId, index) => [
                `ruleset_${filterId}.json`,
                index === filterIds.length - 1 ? 1 : MAX_EXTENSION_BASELINE_BYTES / 4,
            ]),
        );
        let opened = 0;
        const result = await lockBrowserExtensionBaseline(
            {
                extensionRoot: '/opaque/root',
                settings: aggregateSettings,
                acquiredAt: '2026-07-24T00:00:00.000Z',
            },
            {
                inspect: async (path) => {
                    if (path.endsWith('manifest.json')) {
                        return metadata({ inode: 1, size: 100 });
                    }
                    const entry = [...sizes.entries()].find(([name]) => path.endsWith(name));
                    return metadata({ size: entry?.[1] ?? 0, inode: filterIds.indexOf(2) + 2 });
                },
                realpath: async (path) => path,
                readBounded: async () =>
                    JSON.stringify({
                        manifest_version: 3,
                        declarative_net_request: {
                            rule_resources: filterIds.map((filterId) => ({
                                id: `ruleset_${filterId}`,
                                enabled: true,
                                path: `filters/ruleset_${filterId}.json`,
                            })),
                        },
                    }),
                openNoFollow: async () => {
                    opened += 1;
                    throw new Error('resources must not be opened');
                },
            },
        );

        expect(result).toMatchObject({
            ready: false,
            limitation: { code: 'baseline_resource_limit_exceeded' },
        });
        expect(opened).toBe(0);
    });

    it('rejects unsafe paths, symlinks, and runtime/settings disagreement with path-free errors', async () => {
        const unsafePaths = [
            '',
            '/tmp/rules.json',
            '..\\rules.json',
            '../rules.json',
            './rules.json',
            'filters//rules.json',
            'filters/../rules.json',
            'filters/rules.json/',
            'filters/\u0000rules.json',
            'filters/\u001frules.json',
        ];
        for (const path of unsafePaths) {
            const root = await fixture();
            await fsPromises.writeFile(
                join(root, 'manifest.json'),
                JSON.stringify({
                    manifest_version: 3,
                    version: '5.0.0',
                    declarative_net_request: {
                        rule_resources: [{ id: 'ruleset_2', enabled: true, path }],
                    },
                }),
            );
            const result = await lockBrowserExtensionBaseline({
                extensionRoot: root,
                settings,
                acquiredAt: '2026-07-24T00:00:00.000Z',
            });
            expect(result).toMatchObject({
                ready: false,
                limitation: { code: 'baseline_resource_unsafe' },
            });
            if (!result.ready) {
                expect(result.limitation.detail).not.toContain(root);
            }
        }

        const root = await fixture();
        const ruleset = join(root, 'filters/declarative/ruleset_2/ruleset_2.json');
        await fsPromises.writeFile(join(root, 'outside.json'), '[]');
        await import('node:fs/promises').then(({ unlink }) => unlink(ruleset));
        await fsPromises.symlink(join(root, 'outside.json'), ruleset);
        const symlinked = await lockBrowserExtensionBaseline({
            extensionRoot: root,
            settings,
            acquiredAt: '2026-07-24T00:00:00.000Z',
        });
        expect(symlinked).toMatchObject({
            ready: false,
            limitation: { code: 'baseline_resource_unsafe' },
        });

        const mismatch = await lockBrowserExtensionBaseline({
            extensionRoot: await fixture(),
            settings: { ...settings, runtimeEnabledFilterIds: [3] },
            acquiredAt: '2026-07-24T00:00:00.000Z',
        });
        expect(mismatch).toMatchObject({
            ready: false,
            limitation: { code: 'settings_mismatch' },
        });
    });
});

function fakeSession(
    id: string,
    close: () => Promise<void> = async () => undefined,
): IBrowserSession {
    return {
        artifactsDir: `/artifacts/${id}`,
        isClosed: false,
        getPage: () => {
            throw new Error('not used');
        },
        close,
        getNetworkLog: () => [],
        resetNetworkLog: () => undefined,
        getConsoleLog: () => [],
        consoleCoverage: ConsoleCoverage.BrowserLogOnly,
    } as IBrowserSession;
}

/**
 * Compute the content digest one read-back reports for an exact user-rule bundle.
 *
 * @param content - Exact newline-joined rule content.
 * @returns The lowercase SHA-256 hex digest.
 */
function contentDigest(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * A successful configuration outcome for the candidate phase: the read-back carries exactly the
 * candidate bundle and the baseline enabled set.
 *
 * @param call - Recorded configuration call.
 * @returns Applied outcome whose read-back matches the requested state.
 */
function appliedOutcome(
    call: EnvironmentPhaseConfigurationRequest,
): EnvironmentPhaseConfigurationResult {
    const prepared = call.baselineEnabledFilterIds;
    const rulesContent = call.candidateRule ?? '';
    return {
        kind: EnvironmentPhaseConfigurationOutcome.Applied,
        method: 'extension-state',
        readBack: {
            enabledFilterIds: [...prepared],
            activeRulesetFilterIds: [...prepared],
            stealthEnabled: false,
            rulesContent,
            rulesContentSha256: contentDigest(rulesContent),
        },
        actionLog: [{ tool: 'open_page', ok: true, summary: `{"url":"options"}` }],
    };
}

async function adapterOptions(
    overrides: Partial<BrowserExtensionEnvironmentOptions> = {},
): Promise<BrowserExtensionEnvironmentOptions> {
    const extensionRoot = await fixture();
    return {
        extensionRoot,
        packageVersion: '5.0.0',
        manifestVersion: '5.0.0',
        buildDigest: 'd'.repeat(64),
        profileKind: 'agent_selected',
        application: FIXTURE_APPLICATION,
        settingsProvider: async () => settings,
        createSession: async (request) => ({
            session: fakeSession(`session-${request.phase}`),
        }),
        phaseConfiguration: async (_session, request) => appliedOutcome(request),
        now: () => '2026-07-24T00:00:00.000Z',
        createLeaseId: (phase) => `lease-${phase}`,
        ...overrides,
    };
}

describe('BrowserExtensionEnvironmentAdapter actual context', () => {
    it('authors actual product and browser context from its verified build inputs', async () => {
        const adapter = new BrowserExtensionEnvironmentAdapter(await adapterOptions());

        expect(adapter.snapshot().actualContext).toEqual({
            kind: 'browser_extension',
            product: 'AdGuard Browser Extension',
            browser: 'CloakBrowser Chromium',
            productVersion: '5.0.0',
        });
    });
});

describe('BrowserExtensionEnvironmentAdapter', () => {
    it('translates requested list refs into ascending registry ids and emits list keys in that numeric order at its native seam', async () => {
        const providerInputs: number[][] = [];
        const configurationCalls: string[] = [];
        const extensionRoot = await fixture([2, 14]);
        const bothSettings: ExtensionBaselineSettings = {
            enabledFilterIds: [2, 14],
            optionsEnabledFilterIds: [2, 14],
            runtimeEnabledFilterIds: [2, 14],
            activeRulesetFilterIds: [2, 14],
            versions: new Map(),
        };
        const options = await adapterOptions({
            extensionRoot,
            settingsProvider: async (requestedFilterIds) => {
                providerInputs.push([...requestedFilterIds]);
                return bothSettings;
            },
            phaseConfiguration: async (session, request) => {
                configurationCalls.push(`${request.phase}:${request.candidateRule ?? 'baseline'}`);
                return appliedOutcome(request);
            },
        });
        const adapter = new BrowserExtensionEnvironmentAdapter(options);

        const prepared = await adapter.prepare({
            requestedLists: [officialAdguardListRef(14)!, officialAdguardListRef(2)!],
        });

        expect(prepared.ready).toBe(true);
        expect(providerInputs).toEqual([[2, 14]]);
        if (prepared.ready) {
            // The emitted key arrays mirror the canonical numeric-ascending registry-id order
            // the settings proofs carry. Plain lexicographic string order would place
            // 'adguard:14' before 'adguard:2', so this id pair pins that the emission is the
            // numeric order and never a key sort.
            expect(prepared.state.baseline).toMatchObject({
                enabledListKeys: ['adguard:2', 'adguard:14'],
                resources: [
                    { listKey: 'adguard:2', rulesetId: 'ruleset_2' },
                    { listKey: 'adguard:14', rulesetId: 'ruleset_14' },
                ],
            });
        }

        const b = await adapter.openPhase({
            experimentId: 'experiment-1',
            phase: 'B',
            targetUrl: 'https://example.test/',
            candidate: null,
        });
        expect(b.ready).toBe(true);
        if (b.ready) {
            expect(b.handle.adapterProof.extension).toMatchObject({
                enabledListKeys: ['adguard:2', 'adguard:14'],
                activeRulesetListKeys: ['adguard:2', 'adguard:14'],
            });
        }
        expect(providerInputs).toEqual([
            [2, 14],
            [2, 14],
        ]);
        // Phase B's application is the baseline plugging goal: the candidate rule stays null.
        expect(configurationCalls).toEqual(['B:baseline']);
    });

    it('fails preparation closed when a requested list key is unresolvable', async () => {
        const unpinned: FilterListRef = {
            key: 'adguard:9999',
            title: 'Unknown AdGuard filter',
            source: {
                kind: 'url',
                url: 'https://filters.adtidy.org/extension/chromium/filters/9999.txt',
            },
            owned: true,
        };
        for (const unresolvable of [
            { ...officialAdguardListRef(2)!, key: 'ublock:2', owned: false } as FilterListRef,
            unpinned,
        ]) {
            let providerCalls = 0;
            const adapter = new BrowserExtensionEnvironmentAdapter(
                await adapterOptions({
                    settingsProvider: async () => {
                        providerCalls += 1;
                        return settings;
                    },
                }),
            );

            const prepared = await adapter.prepare({ requestedLists: [unresolvable] });

            expect(prepared).toMatchObject({
                ready: false,
                limitation: { code: 'baseline_manifest_invalid', stage: 'preparation' },
            });
            if (!prepared.ready) {
                expect(prepared.limitation.detail).toContain(unresolvable.key);
            }
            expect(adapter.snapshot().lifecycle).toBe('limited');
            expect(providerCalls).toBe(0);
        }
    });

    it('prepares and runs the phases on every list the build activated, third-party rulesets included', async () => {
        // The request can only name pinned official lists, while a reporter import routinely
        // activates third-party rulesets the build ships (216, 238, 252). Every live run that
        // reached apply_rule with one of those enabled ended capability_limited here.
        const configuredLists: string[][] = [];
        const observed: ExtensionBaselineSettings = {
            enabledFilterIds: [2, 14, 216],
            optionsEnabledFilterIds: [2, 14, 216],
            runtimeEnabledFilterIds: [2, 14, 216],
            activeRulesetFilterIds: [2, 14, 216],
            versions: new Map(),
        };
        const adapter = new BrowserExtensionEnvironmentAdapter(
            await adapterOptions({
                extensionRoot: await fixture([2, 14, 216]),
                settingsProvider: async () => observed,
                phaseConfiguration: async (_session, request) => {
                    configuredLists.push([...request.baselineEnabledFilterIds]);
                    return appliedOutcome(request);
                },
            }),
        );

        const prepared = await adapter.prepare({
            requestedLists: [officialAdguardListRef(2)!, officialAdguardListRef(14)!],
        });

        expect(prepared).toMatchObject({
            ready: true,
            state: {
                baseline: { enabledListKeys: ['adguard:2', 'adguard:14', 'adguard:216'] },
            },
        });
        const b = await adapter.openPhase({
            experimentId: 'experiment-1',
            phase: 'B',
            targetUrl: 'https://example.test/',
            candidate: null,
        });
        expect(b.ready).toBe(true);
        // The phase sessions must run the set the investigation ran on, not a narrower one.
        expect(configuredLists).toEqual([['adguard:2', 'adguard:14', 'adguard:216']]);
    });

    it('refuses preparation, naming the lists, when the pinned official sets disagree', async () => {
        for (const scenario of [
            { enabled: [2, 14], requested: [2], named: '14' },
            { enabled: [2], requested: [2, 14], named: '14' },
        ]) {
            const observed: ExtensionBaselineSettings = {
                enabledFilterIds: scenario.enabled,
                optionsEnabledFilterIds: scenario.enabled,
                runtimeEnabledFilterIds: scenario.enabled,
                activeRulesetFilterIds: scenario.enabled,
                versions: new Map(),
            };
            const adapter = new BrowserExtensionEnvironmentAdapter(
                await adapterOptions({
                    extensionRoot: await fixture(scenario.enabled),
                    settingsProvider: async () => observed,
                }),
            );

            const prepared = await adapter.prepare({
                requestedLists: scenario.requested.map((id) => officialAdguardListRef(id)!),
            });

            expect(prepared).toMatchObject({
                ready: false,
                limitation: { code: 'settings_mismatch', stage: 'preparation' },
            });
            if (!prepared.ready) {
                expect(prepared.limitation.detail).toContain(scenario.named);
            }
        }
    });

    it('establishes true A/B/C sessions and applies C through the configuration seam', async () => {
        const createdPhases: string[] = [];
        const configurationCalls: Array<{ phase: string; candidateRule: string | null }> = [];
        const configurationSessions: string[] = [];
        const options = await adapterOptions({
            createSession: async (request) => {
                createdPhases.push(request.phase);
                return { session: fakeSession(`session-${request.phase}`) };
            },
            phaseConfiguration: async (session, request) => {
                configurationCalls.push({
                    phase: request.phase,
                    candidateRule: request.candidateRule,
                });
                configurationSessions.push(session === null ? 'null' : 'session');
                return appliedOutcome(request);
            },
        });
        const adapter = new BrowserExtensionEnvironmentAdapter(options);
        expect(
            await adapter.prepare({ requestedLists: [officialAdguardListRef(2)!] }),
        ).toMatchObject({ ready: true });

        const a = await adapter.openPhase({
            experimentId: 'experiment-1',
            phase: 'A',
            targetUrl: 'https://example.test/',
            candidate: null,
        });
        const b = await adapter.openPhase({
            experimentId: 'experiment-1',
            phase: 'B',
            targetUrl: 'https://example.test/',
            candidate: null,
        });
        const c = await adapter.openPhase({
            experimentId: 'experiment-1',
            phase: 'C',
            targetUrl: 'https://example.test/',
            candidate: { operation: 'add', rule: 'example.test##.ad' },
        });

        expect([a.ready, b.ready, c.ready]).toEqual([true, true, true]);
        expect(createdPhases).toEqual(['A', 'B', 'C']);
        // Phase A runs no application; B plugs the baseline (no candidate) and C carries the
        // candidate rule through the same seam.
        expect(configurationCalls).toEqual([
            { phase: 'B', candidateRule: null },
            { phase: 'C', candidateRule: 'example.test##.ad' },
        ]);
        expect(configurationSessions).toEqual(['session', 'session']);
        if (b.ready && c.ready) {
            expect(b.handle.adapterProof.baselineDigest).toBe(c.handle.adapterProof.baselineDigest);
            expect(c.handle.adapterProof.candidateDigest).toMatch(/^[0-9a-f]{64}$/u);
        }
    });

    it('proves MV2 phases through the read-back enabled set', async () => {
        const root = await fsPromises.mkdtemp(join(tmpdir(), 'extension-mv2-phase-'));
        await fsPromises.mkdir(join(root, 'filters'), { recursive: true });
        await fsPromises.writeFile(
            join(root, 'filters', 'filter_2.txt'),
            '! base\n||ad.example^\n',
        );
        await fsPromises.writeFile(
            join(root, 'manifest.json'),
            JSON.stringify({ manifest_version: 2, version: '5.4.3.1' }),
        );
        const mv2Settings: ExtensionBaselineSettings = {
            enabledFilterIds: [2],
            optionsEnabledFilterIds: [2],
            runtimeEnabledFilterIds: [2],
            activeRulesetFilterIds: [],
            versions: new Map([[2, '2.0.0']]),
        };
        // No MV2 build has DNR rulesets, so its read-back carries no active-ruleset set.
        const options = await adapterOptions({
            extensionRoot: root,
            packageVersion: '5.4.3.1',
            manifestVersion: '5.4.3.1',
            settingsProvider: async () => mv2Settings,
            phaseConfiguration: async (_session, request) => ({
                kind: EnvironmentPhaseConfigurationOutcome.Applied,
                method: 'extension-state',
                readBack: {
                    enabledFilterIds: [...request.baselineEnabledFilterIds],
                    stealthEnabled: false,
                    rulesContent: request.candidateRule ?? '',
                    rulesContentSha256: contentDigest(request.candidateRule ?? ''),
                },
                actionLog: [],
            }),
        });
        const adapter = new BrowserExtensionEnvironmentAdapter(options);
        expect(
            await adapter.prepare({ requestedLists: [officialAdguardListRef(2)!] }),
        ).toMatchObject({ ready: true });

        const b = await adapter.openPhase({
            experimentId: 'experiment-mv2',
            phase: 'B',
            targetUrl: 'https://example.test/',
            candidate: null,
        });
        const c = await adapter.openPhase({
            experimentId: 'experiment-mv2',
            phase: 'C',
            targetUrl: 'https://example.test/',
            candidate: { operation: 'add', rule: 'example.test##.ad' },
        });

        expect([b.ready, c.ready]).toEqual([true, true]);
    });

    it('fails closed for unsupported operations and a read-back without the candidate', async () => {
        const adapter = new BrowserExtensionEnvironmentAdapter(await adapterOptions());
        await adapter.prepare({ requestedLists: [officialAdguardListRef(2)!] });
        expect(
            await adapter.openPhase({
                experimentId: 'experiment-1',
                phase: 'C',
                targetUrl: 'https://example.test/',
                candidate: { operation: 'edit', rule: 'example.test##.ad' },
            }),
        ).toMatchObject({
            ready: false,
            limitation: { code: 'candidate_operation_unsupported' },
        });

        const nonConverged = new BrowserExtensionEnvironmentAdapter(
            await adapterOptions({
                phaseConfiguration: async (_session, request) => ({
                    kind: EnvironmentPhaseConfigurationOutcome.Unverified,
                    detail:
                        'The blocker state does not contain exactly the candidate rule: the host ' +
                        'read back content digest ' +
                        contentDigest('leftover rule') +
                        ' where ' +
                        contentDigest(request.candidateRule ?? '') +
                        ' was expected.',
                }),
            }),
        );
        await nonConverged.prepare({ requestedLists: [officialAdguardListRef(2)!] });
        const failed = await nonConverged.openPhase({
            experimentId: 'experiment-1',
            phase: 'C',
            targetUrl: 'https://example.test/',
            candidate: { operation: 'add', rule: 'example.test##.ad' },
        });
        expect(failed).toMatchObject({
            ready: false,
            limitation: { code: 'candidate_application_failed' },
        });
        expect(nonConverged.snapshot().openLeaseIds).toHaveLength(1);
    });

    it('drains partial sessions after close failures and makes final cleanup idempotent', async () => {
        let closeAttempts = 0;
        const adapter = new BrowserExtensionEnvironmentAdapter(
            await adapterOptions({
                createSession: async () => ({
                    session: fakeSession('close-failure', async () => {
                        closeAttempts += 1;
                        if (closeAttempts === 1) {
                            throw new Error('/private/profile secret failure');
                        }
                    }),
                }),
            }),
        );
        await adapter.prepare({ requestedLists: [officialAdguardListRef(2)!] });
        await adapter.openPhase({
            experimentId: 'experiment-1',
            phase: 'B',
            targetUrl: 'https://example.test/',
            candidate: null,
        });

        const first = await adapter.drainOpenHandles();
        const second = await adapter.drainOpenHandles();
        const cleanup = await adapter.cleanup();
        const repeated = await adapter.cleanup();

        expect(first).toMatchObject({ attempted: 1, failed: 1 });
        expect(first.failures[0].detail).not.toContain('/private/profile');
        expect(second).toMatchObject({ attempted: 1, closed: 1, failed: 0 });
        expect(cleanup).toEqual(repeated);
        expect(adapter.snapshot()).toMatchObject({ lifecycle: 'cleaned', openLeaseIds: [] });
    });

    it('carries the native session-create failure in the phase_open_failed detail', async () => {
        const adapter = new BrowserExtensionEnvironmentAdapter(
            await adapterOptions({
                createSession: async () => {
                    throw new Error(
                        'Failed to apply AdGuard settings: AdGuard app did not finish ' +
                            'initialization after 50 probes over 5000ms.',
                    );
                },
            }),
        );
        await adapter.prepare({ requestedLists: [officialAdguardListRef(2)!] });

        const opened = await adapter.openPhase({
            experimentId: 'experiment-1',
            phase: 'A',
            targetUrl: 'https://example.test/',
            candidate: null,
        });

        expect(opened).toMatchObject({
            ready: false,
            limitation: { code: 'phase_open_failed', stage: 'phase' },
        });
        if (!opened.ready) {
            expect(opened.limitation.detail).toContain(
                'did not finish initialization after 50 probes',
            );
        }
    });

    it('refuses any phase naming an enabled list subset instead of running the baseline', async () => {
        let sessions = 0;
        const adapter = new BrowserExtensionEnvironmentAdapter(
            await adapterOptions({
                createSession: async (request) => {
                    sessions += 1;
                    return { session: fakeSession(`session-${request.phase}`) };
                },
            }),
        );
        await adapter.prepare({ requestedLists: [officialAdguardListRef(2)!] });

        const narrowed = await adapter.openPhase({
            experimentId: 'experiment-1',
            phase: 'B',
            targetUrl: 'https://example.test/',
            candidate: null,
            enabledListKeys: ['adguard:2'],
        });

        expect(narrowed).toMatchObject({
            ready: false,
            limitation: { code: 'settings_mismatch', stage: 'phase' },
        });
        expect(sessions).toBe(0);
    });
});

describe('BrowserExtensionEnvironmentAdapter phase configuration', () => {
    it('limits phase C when the instruction application is refused', async () => {
        const adapter = new BrowserExtensionEnvironmentAdapter(
            await adapterOptions({
                phaseConfiguration: async (_session, request) => ({
                    kind: EnvironmentPhaseConfigurationOutcome.Refused,
                    gap: 'no-application-method',
                    detail:
                        'The instruction carries no rule-application section: nothing describes ' +
                        `how to apply a rule. (request phase ${request.phase})`,
                }),
            }),
        );
        await adapter.prepare({ requestedLists: [officialAdguardListRef(2)!] });

        const c = await adapter.openPhase({
            experimentId: 'experiment-1',
            phase: 'C',
            targetUrl: 'https://example.test/',
            candidate: { operation: 'add', rule: 'example.test##.ad' },
        });
        const b = await adapter.openPhase({
            experimentId: 'experiment-1',
            phase: 'B',
            targetUrl: 'https://example.test/',
            candidate: null,
        });

        expect(c).toMatchObject({
            ready: false,
            limitation: {
                code: 'application_instruction_refused',
                stage: 'candidate',
            },
        });
        expect(b).toMatchObject({
            ready: false,
            limitation: {
                code: 'application_instruction_refused',
                stage: 'phase',
            },
        });
        if (!c.ready) {
            expect(c.limitation.detail).toContain('no-application-method');
        }
        if (!b.ready) {
            expect(b.limitation.detail).toContain('phase B');
        }
    });

    it('forwards the phase request signal into the application session so an aborted experiment aborts it', async () => {
        let receivedSignal: AbortSignal | undefined;
        const adapter = new BrowserExtensionEnvironmentAdapter(
            await adapterOptions({
                phaseConfiguration: async (_session, request) => {
                    receivedSignal = request.signal;
                    return appliedOutcome(request);
                },
            }),
        );
        await adapter.prepare({ requestedLists: [officialAdguardListRef(2)!] });
        const controller = new AbortController();
        controller.abort();

        const b = await adapter.openPhase({
            experimentId: 'experiment-1',
            phase: 'B',
            targetUrl: 'https://example.test/',
            candidate: null,
            signal: controller.signal,
        });

        expect(b.ready).toBe(true);
        // The exact signal the caller aborted reached the application session's own request — not
        // a copy, not a fresh unlinked signal — so the session's own abort handling (already
        // correct) actually observes the abort instead of running out its own per-session budget.
        expect(receivedSignal).toBe(controller.signal);
        expect(receivedSignal?.aborted).toBe(true);
    });

    it('refuses credit on a read-back mismatch and carries the mismatch detail', async () => {
        const mismatchDetail = 'The blocker state does not contain exactly the candidate rule.';
        const build = async () =>
            new BrowserExtensionEnvironmentAdapter(
                await adapterOptions({
                    phaseConfiguration: async () => ({
                        kind: EnvironmentPhaseConfigurationOutcome.Unverified,
                        detail: mismatchDetail,
                    }),
                }),
            );
        const cAdapter = await build();
        await cAdapter.prepare({ requestedLists: [officialAdguardListRef(2)!] });

        const c = await cAdapter.openPhase({
            experimentId: 'experiment-1',
            phase: 'C',
            targetUrl: 'https://example.test/',
            candidate: { operation: 'add', rule: 'example.test##.ad' },
        });

        expect(c).toMatchObject({
            ready: false,
            limitation: { code: 'candidate_application_failed', stage: 'candidate' },
        });
        if (!c.ready) {
            expect(c.limitation.detail).toContain(mismatchDetail);
        }

        const bAdapter = await build();
        await bAdapter.prepare({ requestedLists: [officialAdguardListRef(2)!] });
        await expect(
            bAdapter.openPhase({
                experimentId: 'experiment-1',
                phase: 'B',
                targetUrl: 'https://example.test/',
                candidate: null,
            }),
        ).resolves.toMatchObject({
            ready: false,
            limitation: { code: 'phase_proof_unavailable', stage: 'phase' },
        });
    });

    it('credits an applied phase with the application record over the host read-back', async () => {
        const adapter = new BrowserExtensionEnvironmentAdapter(await adapterOptions());
        await adapter.prepare({ requestedLists: [officialAdguardListRef(2)!] });

        const c = await adapter.openPhase({
            experimentId: 'experiment-1',
            phase: 'C',
            targetUrl: 'https://example.test/',
            candidate: { operation: 'add', rule: 'example.test##.ad' },
        });
        const b = await adapter.openPhase({
            experimentId: 'experiment-1',
            phase: 'B',
            targetUrl: 'https://example.test/',
            candidate: null,
        });

        expect(c.ready).toBe(true);
        expect(b.ready).toBe(true);
        if (c.ready) {
            const extension = c.handle.adapterProof.extension;
            expect(extension).toMatchObject({
                profileKind: 'agent_selected',
                enabledListKeys: ['adguard:2'],
                activeRulesetListKeys: ['adguard:2'],
                stealthEnabled: false,
                userRulesDigest: contentDigest('example.test##.ad'),
            });
            // The summary text is the host's own tool-call serialization detail; the contract
            // asserts only that the entry exists with its tool and outcome.
            expect(extension?.application).toEqual({
                method: 'extension-state',
                appliedRules: ['example.test##.ad'],
                actionLog: [{ tool: 'open_page', ok: true, summary: expect.stringMatching(/.+/s) }],
            });
        }
        if (b.ready) {
            const extension = b.handle.adapterProof.extension;
            expect(extension?.userRulesDigest).toBeNull();
            expect(extension?.application).toEqual({
                method: 'extension-state',
                appliedRules: [],
                actionLog: [{ tool: 'open_page', ok: true, summary: expect.stringMatching(/.+/s) }],
            });
        }
    });

    it('opens file-backed B and C on the procedure verdict and records what it could not observe', async () => {
        // A user-rules file cannot report the enabled filter set, so the application procedure
        // credits these phases on the rules content alone and says so; the environment builds the
        // lease from that verdict and carries the caveat into the proof. The candidate arrives with
        // a stray trailing space, and the recorded digests use the normalization the read-back
        // used, so the proof still describes phase C exactly.
        const candidateRule = 'example.test##.ad';
        const unobservable =
            'The user-rules-file read-back does not expose the enabled filter set; the phase was ' +
            'credited on the user-rules content alone.';
        const adapter = new BrowserExtensionEnvironmentAdapter(
            await adapterOptions({
                phaseConfiguration: async (_session, request) => {
                    const content = (request.candidateRule ?? '').trim();
                    return {
                        kind: EnvironmentPhaseConfigurationOutcome.Applied,
                        method: 'user-rules-file',
                        readBack: {
                            rulesContent: content,
                            rulesContentSha256: contentDigest(content),
                        },
                        actionLog: [],
                        detail: unobservable,
                    };
                },
            }),
        );
        await adapter.prepare({ requestedLists: [officialAdguardListRef(2)!] });

        const b = await adapter.openPhase({
            experimentId: 'experiment-file',
            phase: 'B',
            targetUrl: 'https://example.test/',
            candidate: null,
        });
        const c = await adapter.openPhase({
            experimentId: 'experiment-file',
            phase: 'C',
            targetUrl: 'https://example.test/',
            candidate: { operation: 'add', rule: `${candidateRule} ` },
        });

        expect([b.ready, c.ready]).toEqual([true, true]);
        if (b.ready && c.ready) {
            expect(
                v.safeParse(EnvironmentPhaseStateProofSchema, b.handle.adapterProof).success,
            ).toBe(true);
            expect(
                v.safeParse(EnvironmentPhaseStateProofSchema, c.handle.adapterProof).success,
            ).toBe(true);
            expect(c.handle.adapterProof.candidateDigest).toBe(contentDigest(candidateRule));
            // The file-backed read-back cannot see the enabled set, the compiled DNR rulesets or
            // the Stealth state: all three carry null, never an empty list or a false boolean —
            // the lab renderers turn that null into "not observed" instead of "none".
            expect(b.handle.adapterProof.extension).toMatchObject({
                enabledListKeys: null,
                activeRulesetListKeys: null,
                stealthEnabled: null,
            });
            expect(c.handle.adapterProof.extension).toMatchObject({
                enabledListKeys: null,
                activeRulesetListKeys: null,
                stealthEnabled: null,
            });
            expect(c.handle.adapterProof.extension?.application).toMatchObject({
                method: 'user-rules-file',
                appliedRules: [candidateRule],
                detail: unobservable,
            });
            expect(b.handle.adapterProof.extension?.application?.detail).toBe(unobservable);
        }
    });

    it('observes and closes the session an application relaunched instead of the one it replaced', async () => {
        // A host-performed file-backed application relaunches the browser so it reads rebuilt
        // enterprise policies at startup; the phase must be observed over the relaunched session,
        // and closing the lease must close that session, not the one already replaced.
        const originalClose = vi.fn(async () => undefined);
        const replacementClose = vi.fn(async () => undefined);
        const replacement = fakeSession('relaunched', replacementClose);
        const adapter = new BrowserExtensionEnvironmentAdapter(
            await adapterOptions({
                createSession: async (request) => ({
                    session: fakeSession(`session-${request.phase}`, originalClose),
                }),
                phaseConfiguration: async (_session, request) => {
                    const content = (request.candidateRule ?? '').trim();
                    return {
                        kind: EnvironmentPhaseConfigurationOutcome.Applied,
                        method: 'managed-storage-file',
                        readBack: {
                            rulesContent: content,
                            rulesContentSha256: contentDigest(content),
                        },
                        actionLog: [],
                        session: replacement,
                    };
                },
            }),
        );
        await adapter.prepare({ requestedLists: [officialAdguardListRef(2)!] });

        const c = await adapter.openPhase({
            experimentId: 'experiment-relaunch',
            phase: 'C',
            targetUrl: 'https://example.test/',
            candidate: { operation: 'add', rule: 'example.test##.ad' },
        });

        expect(c.ready).toBe(true);
        if (c.ready) {
            expect(c.handle.session).toBe(replacement);
            await c.handle.close();
        }
        expect(replacementClose).toHaveBeenCalledTimes(1);
        expect(originalClose).not.toHaveBeenCalled();
    });

    it('keeps phase A free of any application step', async () => {
        let configurationCalls = 0;
        const adapter = new BrowserExtensionEnvironmentAdapter(
            await adapterOptions({
                phaseConfiguration: async () => {
                    configurationCalls += 1;
                    // Refusing is the strongest signal phase A ever reached this seam: the phase
                    // must close before the option is consulted at all.
                    return {
                        kind: EnvironmentPhaseConfigurationOutcome.Unverified,
                        detail: 'phase A must never reach the configuration seam',
                    };
                },
            }),
        );
        await adapter.prepare({ requestedLists: [officialAdguardListRef(2)!] });

        const a = await adapter.openPhase({
            experimentId: 'experiment-1',
            phase: 'A',
            targetUrl: 'https://example.test/',
            candidate: null,
        });

        expect(a.ready).toBe(true);
        expect(configurationCalls).toBe(0);
        if (a.ready) {
            expect(a.handle.adapterProof.extension).toBeNull();
        }
    });
});
