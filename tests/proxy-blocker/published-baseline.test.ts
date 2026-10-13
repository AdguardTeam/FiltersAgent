import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
    BaselineFileMetadata,
    BaselineFileSystemPort,
    OpenedBaselineFile,
} from '../../src/environment/baseline-file-lock';
import {
    installPreflightDiagnosticLog,
    openPreflightDiagnosticLog,
} from '../../src/local/preflight-diagnostic-log';
import {
    prepareProxyBlockerPublishedBaseline,
    type ProxyBlockerBaselineHostPort,
} from '../../src/proxy-blocker/published-baseline';

const temporaryRoots: string[] = [];

afterEach(async () => {
    installPreflightDiagnosticLog(null);
    await Promise.all(
        temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
});

const CLI_DATA_ROOT = '/sandbox/state/data';
const ACQUIRED_AT = '2026-07-28T10:00:00.000Z';
const LAST_UPDATE = '2026-07-28 09:30:00';

interface CatalogFixtureRow {
    id: number;
    title: string;
    installed: boolean;
    enabled: boolean;
}

interface StoredFile {
    bytes: Buffer;
    regular: boolean;
    symbolicLink: boolean;
    inode: number;
    modifiedMs: number;
}

interface FixtureBehaviour {
    /**
     * Catalog rows the native list displays before any command runs.
     */
    rows: CatalogFixtureRow[];
    /**
     * Storage files the sandbox already holds before the first add.
     */
    preexistingFiles?: readonly string[];
    /**
     * Byte lengths the filesystem reports for a path regardless of its real content.
     */
    reportedSizes?: Readonly<Record<string, number>>;
    /**
     * Requested ID whose add command rejects.
     */
    failAdd?: number;
    /**
     * Catalog IDs this release installs without enabling, the way it treats the Annoyances
     * sub-filters, so the baseline has to enable them explicitly.
     */
    installWithoutEnabling?: readonly number[];
    /**
     * Catalog ID whose enable command rejects.
     */
    failEnable?: number;
    /**
     * Catalog ID whose enable command succeeds while the row stays disabled.
     */
    ignoreEnable?: number;
    /**
     * Catalog ID whose disable command rejects.
     */
    failDisable?: number;
    /**
     * Catalog ID whose disable command succeeds while the row stays enabled.
     */
    ignoreDisable?: number;
    /**
     * Requested ID whose add command succeeds while the row stays not added.
     */
    ignoreAdd?: number;
    /**
     * Storage files each add creates, defaulting to exactly one file per filter.
     */
    filesForAdd?: (id: number) => readonly string[];
    /**
     * Storage files every add rewrites without creating, standing in for shared index state.
     */
    rewrittenByEveryAdd?: readonly string[];
    /**
     * Byte length of each created file.
     */
    fileBytes?: (id: number) => number;
    /**
     * Whether the storage scan refuses because its file bound was exceeded.
     */
    storageScanFails?: boolean;
    /**
     * Paths the fake filesystem reports as symbolic links.
     */
    symbolicLinks?: readonly string[];
    /**
     * Canonical locations that differ from the stored path.
     */
    realpaths?: Readonly<Record<string, string>>;
    /**
     * Path whose bytes and metadata change while it is being streamed.
     */
    changesWhileStreaming?: string;
}

interface BaselineFixture {
    host: ProxyBlockerBaselineHostPort;
    fileSystem: BaselineFileSystemPort;
    commands: string[];
}

/**
 * Render one catalog row in the pinned v1.4.13 table layout.
 */
function renderRow(row: CatalogFixtureRow): string {
    const marker = row.enabled ? '[x]' : row.installed ? '[ ]' : '   ';
    const status = row.enabled
        ? LAST_UPDATE
        : row.installed
          ? 'Filter is disabled'
          : 'Filter is not added';
    return `${marker} | ${String(row.id).padStart(12)} | ${row.title.padEnd(39)} ${status}`;
}

/**
 * Render the complete native list output for the current catalog state.
 */
function renderCatalog(rows: readonly CatalogFixtureRow[]): string {
    const header = `    | ${'ID'.padStart(12)} | ${'Title'.padEnd(39)} Last update`;
    return [header, 'Ad blocking', ...rows.map(renderRow), ''].join('\n');
}

/**
 * Build the injected command and filesystem boundaries for one scripted sandbox.
 */
function createFixture(behaviour: FixtureBehaviour): BaselineFixture {
    const rows = behaviour.rows.map((row) => ({ ...row }));
    const storage = new Map<string, StoredFile>();
    const commands: string[] = [];
    let nextInode = 100;

    const write = (relativePath: string, bytes: number): void => {
        nextInode += 1;
        storage.set(`${CLI_DATA_ROOT}/${relativePath}`, {
            bytes: Buffer.alloc(bytes, 'a'),
            regular: true,
            symbolicLink: (behaviour.symbolicLinks ?? []).includes(
                `${CLI_DATA_ROOT}/${relativePath}`,
            ),
            inode: nextInode,
            modifiedMs: 1_700_000_000_000 + nextInode,
        });
    };

    for (const path of behaviour.preexistingFiles ?? []) {
        write(path, 8);
    }

    const host: ProxyBlockerBaselineHostPort = {
        cliDataRoot: CLI_DATA_ROOT,
        async runBaselineAction(action, filterId) {
            commands.push(`${action}:${filterId ?? 'none'}`);
            if (action === 'list_all_filters') {
                return renderCatalog(rows);
            }
            if (action === 'add_filter') {
                if (behaviour.failAdd === filterId) {
                    throw new Error('native add refused');
                }
                for (const path of behaviour.rewrittenByEveryAdd ?? []) {
                    const existing = storage.get(`${CLI_DATA_ROOT}/${path}`);
                    if (existing) {
                        existing.modifiedMs += 1;
                    } else {
                        write(path, 16);
                    }
                }
                if (behaviour.ignoreAdd !== filterId) {
                    const row = rows.find((candidate) => candidate.id === filterId);
                    if (row) {
                        row.installed = true;
                        row.enabled = !behaviour.installWithoutEnabling?.includes(filterId!);
                    }
                    const created =
                        behaviour.filesForAdd?.(filterId!) ??
                        ([`filters/${filterId}.txt`] as const);
                    for (const path of created) {
                        write(path, behaviour.fileBytes?.(filterId!) ?? 32);
                    }
                }
                return '';
            }
            if (action === 'enable_filter') {
                if (behaviour.failEnable === filterId) {
                    throw new Error('native enable refused');
                }
                const row = rows.find((candidate) => candidate.id === filterId!);
                if (row && behaviour.ignoreEnable !== filterId) {
                    row.enabled = true;
                }
                return '';
            }
            if (behaviour.failDisable === filterId) {
                throw new Error('native disable refused');
            }
            if (behaviour.ignoreDisable !== filterId) {
                const row = rows.find((candidate) => candidate.id === filterId);
                if (row) {
                    row.enabled = false;
                }
            }
            return '';
        },
        async listStorageFiles() {
            if (behaviour.storageScanFails) {
                throw new Error('storage scan bound exceeded');
            }
            return [...storage.keys()];
        },
    };

    const metadataOf = (path: string): BaselineFileMetadata => {
        const file = storage.get(path);
        if (!file) {
            throw new Error('no such file');
        }
        return {
            size: behaviour.reportedSizes?.[path] ?? file.bytes.byteLength,
            device: 1,
            inode: file.inode,
            modifiedMs: file.modifiedMs,
            regular: file.regular,
            symbolicLink: file.symbolicLink,
        };
    };

    const fileSystem: BaselineFileSystemPort = {
        async inspect(path) {
            return metadataOf(path);
        },
        async realpath(path) {
            return behaviour.realpaths?.[path] ?? path;
        },
        async readBounded(path) {
            const file = storage.get(path);
            if (!file) {
                throw new Error('no such file');
            }
            return file.bytes.toString('utf8');
        },
        async openNoFollow(path): Promise<OpenedBaselineFile> {
            const file = storage.get(path);
            if (!file) {
                throw new Error('no such file');
            }
            return {
                async stat() {
                    return metadataOf(path);
                },
                async *stream() {
                    yield Uint8Array.from(file.bytes);
                    if (behaviour.changesWhileStreaming === path) {
                        file.modifiedMs += 1_000;
                    }
                },
                async close() {},
            };
        },
    };

    return { host, fileSystem, commands };
}

/**
 * Prepare the baseline over one scripted sandbox.
 */
async function prepare(
    requestedFilterIds: readonly number[],
    behaviour: FixtureBehaviour,
): Promise<{
    result: Awaited<ReturnType<typeof prepareProxyBlockerPublishedBaseline>>;
    commands: string[];
}> {
    const fixture = createFixture(behaviour);
    const result = await prepareProxyBlockerPublishedBaseline(
        { environment: 'adguard_cli', requestedFilterIds, acquiredAt: ACQUIRED_AT },
        fixture.host,
        fixture.fileSystem,
    );
    return { result, commands: fixture.commands };
}

const catalog: CatalogFixtureRow[] = [
    { id: 1, title: 'AdGuard Russian filter', installed: false, enabled: false },
    { id: 2, title: 'AdGuard Base filter', installed: false, enabled: false },
    { id: 3, title: 'AdGuard Tracking Protection filter', installed: false, enabled: false },
    { id: 4, title: 'AdGuard Social Media filter', installed: false, enabled: false },
    { id: 5, title: 'AdGuard Experimental filter', installed: false, enabled: false },
    { id: 14, title: 'AdGuard Annoyances filter', installed: false, enabled: false },
];

describe('prepareProxyBlockerPublishedBaseline', () => {
    it('names a filter it could not attribute instead of failing the baseline', async () => {
        // The release ships Base already installed, so its add creates no file to observe.
        const { result } = await prepare([1, 2], {
            rows: catalog,
            filesForAdd: (filterId) => (filterId === 2 ? [] : [`filters/${filterId}.txt`]),
        });

        expect(result.ready).toBe(true);
        if (!result.ready) {
            return;
        }
        expect(result.baseline.unattributedListKeys).toEqual(['adguard:2']);
        expect(result.baseline.resources.map((resource) => resource.rulesetId)).toEqual(['flm:1']);
        // The filter still takes part in filtering, so it stays in the enabled set.
        expect(result.baseline.enabledListKeys).toEqual(['adguard:1', 'adguard:2']);
    });

    it('prepares a byte-unproven baseline when the release fetches content lazily', async () => {
        // v1.4.13 downloads filter content after the add returns, so an observer never sees a
        // file appear. The run still needs the same enabled set in every phase.
        const { result } = await prepare([2], { rows: catalog, filesForAdd: () => [] });

        expect(result.ready).toBe(true);
        if (!result.ready) {
            return;
        }
        expect(result.baseline.resources).toEqual([]);
        expect(result.baseline.unattributedListKeys).toEqual(['adguard:2']);
        expect(result.baseline.enabledListKeys).toEqual(['adguard:2']);
    });

    it('disables what the release brought before attributing anything', async () => {
        // The real release activates with Base already installed and enabled.
        const preinstalled = catalog.map((row) =>
            row.id === 2 ? { ...row, installed: true, enabled: true } : { ...row },
        );
        const { commands } = await prepare([1, 2], { rows: preinstalled });

        expect(commands.indexOf('disable_filter:2')).toBeLessThan(commands.indexOf('add_filter:1'));
    });

    it('enables a requested filter the release installs without enabling', async () => {
        // The real release adds the Annoyances sub-filters without enabling them, which used to
        // fail the whole baseline as an enabled-set mismatch.
        const { result, commands } = await prepare([2, 14], {
            rows: catalog,
            installWithoutEnabling: [14],
        });

        expect(commands).toContain('enable_filter:14');
        expect(result.ready).toBe(true);
        if (!result.ready) {
            return;
        }
        expect(result.baseline.enabledListKeys).toEqual(['adguard:2', 'adguard:14']);
    });

    it('refuses when a requested filter stays disabled after its enable command', async () => {
        const { result } = await prepare([2, 14], {
            rows: catalog,
            installWithoutEnabling: [14],
            ignoreEnable: 14,
        });

        expect(result.ready).toBe(false);
        if (result.ready) {
            return;
        }
        expect(result.limitation.code).toBe('settings_mismatch');
    });

    it('adds every requested official filter once, ascending, and proves the exact enabled set', async () => {
        const { result, commands } = await prepare([1, 2, 14], { rows: catalog });

        expect(commands).toEqual([
            'list_all_filters:none',
            'add_filter:1',
            'add_filter:2',
            'add_filter:14',
            'list_all_filters:none',
            'list_all_filters:none',
        ]);
        expect(result.ready).toBe(true);
        if (!result.ready) {
            return;
        }
        expect(result.baseline).toMatchObject({
            environment: 'adguard_cli',
            acquiredAt: ACQUIRED_AT,
            enabledListKeys: ['adguard:1', 'adguard:2', 'adguard:14'],
        });
        expect(result.baseline.resources).toEqual(
            [1, 2, 14].map((filterId) => ({
                listKey: `adguard:${filterId}`,
                rulesetId: `flm:${filterId}`,
                path: `filters/${filterId}.txt`,
                version: LAST_UPDATE,
                byteCount: 32,
                sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
            })),
        );
        expect(result.baseline.aggregateDigest).toBe(
            createHash('sha256').update(JSON.stringify(result.baseline.resources)).digest('hex'),
        );
        expect(JSON.stringify(result.baseline)).not.toContain(CLI_DATA_ROOT);
    });

    it('locks bytes only for a filter whose own add created exactly one file', async () => {
        const ambiguous: Array<[string, FixtureBehaviour]> = [
            ['no new file', { rows: catalog, filesForAdd: () => [] }],
            [
                'two new files',
                {
                    rows: catalog,
                    filesForAdd: (id) => [`filters/${id}.txt`, `filters/${id}.meta`],
                },
            ],
            [
                'only shared index state',
                {
                    rows: catalog,
                    preexistingFiles: ['index.db'],
                    rewrittenByEveryAdd: ['index.db'],
                    filesForAdd: () => [],
                },
            ],
        ];

        for (const [, behaviour] of ambiguous) {
            const { result } = await prepare([2], behaviour);

            // Bytes are locked only for an unambiguous single-file add. Anything else leaves the
            // filter enabled and named as unattributed rather than claiming content it cannot
            // prove — or failing a run whose phases are all equally filtered.
            expect(result.ready).toBe(true);
            if (!result.ready) {
                return;
            }
            expect(result.baseline.resources).toEqual([]);
            expect(result.baseline.unattributedListKeys).toEqual(['adguard:2']);
        }
    });

    it('never claims shared index state as a filter content file', async () => {
        const { result } = await prepare([1, 2], {
            rows: catalog,
            preexistingFiles: ['index.db'],
            rewrittenByEveryAdd: ['index.db'],
        });

        expect(result.ready).toBe(true);
        if (!result.ready) {
            return;
        }
        expect(result.baseline.resources.map((resource) => resource.path)).toEqual([
            'filters/1.txt',
            'filters/2.txt',
        ]);
    });

    it('refuses an attributed file that is not a regular file inside the data root', async () => {
        const unsafe: FixtureBehaviour[] = [
            { rows: catalog, symbolicLinks: [`${CLI_DATA_ROOT}/filters/2.txt`] },
            {
                rows: catalog,
                realpaths: { [`${CLI_DATA_ROOT}/filters/2.txt`]: '/elsewhere/2.txt' },
            },
        ];

        for (const behaviour of unsafe) {
            const { result } = await prepare([2], behaviour);

            expect(result).toMatchObject({
                ready: false,
                limitation: { code: 'baseline_resource_unsafe', stage: 'baseline' },
            });
        }
    });

    it('refuses executed content beyond the per-resource and aggregate byte bounds', async () => {
        const oversized = await prepare([2], {
            rows: catalog,
            reportedSizes: { [`${CLI_DATA_ROOT}/filters/2.txt`]: 65 * 1024 * 1024 },
        });
        expect(oversized.result).toMatchObject({
            ready: false,
            limitation: { code: 'baseline_resource_limit_exceeded', stage: 'baseline' },
        });

        const aggregate = await prepare([1, 2, 3, 4, 5], {
            rows: catalog,
            reportedSizes: Object.fromEntries(
                [1, 2, 3, 4, 5].map((id) => [
                    `${CLI_DATA_ROOT}/filters/${id}.txt`,
                    60 * 1024 * 1024,
                ]),
            ),
        });
        expect(aggregate.result).toMatchObject({
            ready: false,
            limitation: { code: 'baseline_resource_limit_exceeded', stage: 'baseline' },
        });
    });

    it('refuses executed content that changed while it was being locked', async () => {
        const { result } = await prepare([2], {
            rows: catalog,
            changesWhileStreaming: `${CLI_DATA_ROOT}/filters/2.txt`,
        });

        expect(result).toMatchObject({
            ready: false,
            limitation: { code: 'baseline_resource_changed', stage: 'baseline' },
        });
    });

    it('leaves the complete per-add file-set delta behind an ambiguous attribution', async () => {
        const root = await mkdtemp(join(tmpdir(), 'adguard-cli-published-baseline-'));
        temporaryRoots.push(root);
        const log = openPreflightDiagnosticLog(join(root, 'artifacts'));
        installPreflightDiagnosticLog(log);

        const { result } = await prepare([2], {
            rows: catalog,
            filesForAdd: (id) => [`filters/${id}.txt`, `filters/${id}.meta`],
        });
        log.close({ phase: 'finished' });

        // The baseline no longer refuses here, but the delta that made attribution ambiguous is
        // still the only evidence explaining why a filter ended up unattributed.
        expect(result.ready).toBe(true);
        if (!result.ready) {
            return;
        }
        expect(result.baseline.unattributedListKeys).toEqual(['adguard:2']);
        interface DiagnosticRecord {
            channel: string;
            detail: {
                outcome?: string;
                unattributedFilterIds?: number[];
                observed?: { storageDelta?: Array<{ filterId: number; created: string[] }> };
            };
        }
        const accepted = (await readFile(log.path, 'utf8'))
            .split('\n')
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as DiagnosticRecord)
            .find(
                (record) =>
                    record.channel === 'published_baseline' && record.detail.outcome === 'accepted',
            );

        expect(accepted?.detail.unattributedFilterIds).toEqual([2]);
        expect(accepted?.detail.observed?.storageDelta).toEqual([
            {
                filterId: 2,
                created: [`${CLI_DATA_ROOT}/filters/2.txt`, `${CLI_DATA_ROOT}/filters/2.meta`],
            },
        ]);
    });

    it('fails closed rather than throwing when the sandbox cannot be observed at all', async () => {
        const unobservable: FixtureBehaviour[] = [
            { rows: catalog, storageScanFails: true },
            { rows: catalog, failDisable: 1 },
        ];

        for (const behaviour of unobservable) {
            const { result } = await prepare([2], {
                ...behaviour,
                rows: [
                    { id: 1, title: 'AdGuard Russian filter', installed: true, enabled: true },
                    { id: 2, title: 'AdGuard Base filter', installed: false, enabled: false },
                ],
            });

            expect(result.ready).toBe(false);
            if (result.ready) {
                return;
            }
            expect(result.limitation.stage).toBe('baseline');
            expect(result.limitation.detail).not.toContain(CLI_DATA_ROOT);
        }
    });

    it('disables a catalog filter the reporter never requested', async () => {
        const { result, commands } = await prepare([2], {
            rows: [
                { id: 1, title: 'AdGuard Russian filter', installed: true, enabled: true },
                { id: 2, title: 'AdGuard Base filter', installed: false, enabled: false },
            ],
        });

        expect(commands).toContain('disable_filter:1');
        expect(result.ready).toBe(true);
    });

    it('fails closed when a requested filter is missing from the native catalog', async () => {
        const { result, commands } = await prepare([2, 14], {
            rows: [{ id: 2, title: 'AdGuard Base filter', installed: false, enabled: false }],
        });

        expect(result).toMatchObject({
            ready: false,
            limitation: { code: 'baseline_manifest_invalid', stage: 'baseline' },
        });
        expect(commands.some((command) => command.startsWith('add_filter'))).toBe(false);
    });

    it('returns no partial baseline when one requested filter cannot be added', async () => {
        const { result, commands } = await prepare([1, 2], { rows: catalog, failAdd: 2 });

        expect(result).toMatchObject({
            ready: false,
            limitation: { code: 'baseline_manifest_invalid', stage: 'baseline' },
        });
        expect(commands).toContain('add_filter:1');
    });

    it('fails closed when an unrequested filter is still enabled after preparation', async () => {
        const { result } = await prepare([2], {
            rows: [
                { id: 1, title: 'AdGuard Russian filter', installed: true, enabled: true },
                { id: 2, title: 'AdGuard Base filter', installed: false, enabled: false },
            ],
            ignoreDisable: 1,
        });

        expect(result).toMatchObject({
            ready: false,
            limitation: { code: 'settings_mismatch', stage: 'baseline' },
        });
    });

    it('fails closed when a requested filter is not installed after its add', async () => {
        const { result } = await prepare([2], { rows: catalog, ignoreAdd: 2 });

        expect(result).toMatchObject({
            ready: false,
            limitation: { code: 'settings_mismatch', stage: 'baseline' },
        });
    });

    it('issues no command at all for a request outside the pinned official catalog', async () => {
        for (const requested of [[], [2, 1], [2, 2], [9_999]]) {
            const { result, commands } = await prepare(requested, { rows: catalog });

            expect(result).toMatchObject({
                ready: false,
                limitation: { code: 'baseline_manifest_invalid', stage: 'baseline' },
            });
            expect(commands).toEqual([]);
        }
    });
});
