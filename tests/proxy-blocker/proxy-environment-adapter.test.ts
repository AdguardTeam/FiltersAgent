import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConsoleCoverage, type IBrowserSession } from '../../src/browser/browser-interfaces';
import type {
    BaselineFileMetadata,
    BaselineFileSystemPort,
    OpenedBaselineFile,
} from '../../src/environment/baseline-file-lock';
import {
    EnvironmentCapability,
    EnvironmentPreparationState,
    FilteringEnvironmentAvailability,
    type FilteringEnvironmentDescriptor,
} from '../../src/environment/environment-vocabulary';
import { EnvironmentSelectionHost } from '../../src/environment/environment-selection';
import { FilteringEnvironmentExecutionRecorder } from '../../src/environment/filtering-environment-execution-recorder';
import type {
    EnvironmentCandidate,
    ValidatorPhaseCompletion,
} from '../../src/environment/filtering-environment';
import type { EnvironmentPhase } from '../../src/environment/environment-proofs';
import type { IssueFacts } from '../../src/types/issue-facts';
import {
    ProxyBlockerEnvironmentAdapter,
    type ProxyBlockerBaselineEditReceipt,
    type ProxyBlockerCandidateReceipt,
} from '../../src/proxy-blocker/proxy-environment-adapter';
import { officialAdguardListRef, type FilterListRef } from '../../src/environment/filter-list-ref';

/**
 * Build the list references for numeric official ids, in test-friendly order.
 *
 * @param filterIds - Official catalog ids to request.
 * @returns Filter list refs as the executor interface carries them.
 */
function refsOf(filterIds: number[]): FilterListRef[] {
    return filterIds.map((filterId) => officialAdguardListRef(filterId)!);
}

/**
 * Build the list keys for numeric official ids.
 *
 * @param filterIds - Official catalog ids to render.
 * @returns Their `adguard:<id>` keys.
 */
function keysOf(filterIds: number[]): string[] {
    return filterIds.map((filterId) => `adguard:${filterId}`);
}
import type {
    ProxyBlockerBaselineAction,
    ProxyBlockerBaselineHostPort,
} from '../../src/proxy-blocker/published-baseline';

const CLI_DATA_ROOT = '/sandbox/state/data';
const CLI_VERSION = '1.4.13';
const INSTALLATION_DIGEST = 'a'.repeat(64);
const TARGET_URL = 'https://example.test/article';
const LAST_UPDATE = '2026-07-28 09:30:00';
const RULE = 'example.test##.ad';
const RULE_DIGEST = createHash('sha256').update(RULE).digest('hex');
const CULPRIT = 'culprit-one.example,culprit-two.example##.culprit-widget';
const CULPRIT_DIGEST = createHash('sha256').update(CULPRIT).digest('hex');
const CULPRIT_REPLACEMENT = `${CULPRIT}.ad`;
const CULPRIT_REPLACEMENT_DIGEST = createHash('sha256').update(CULPRIT_REPLACEMENT).digest('hex');
const CULPRIT_FILTER_ID = 2;

/**
 * Build the published content one scripted filter file carries.
 *
 * Only the culprit filter carries the culprit line, so a replacement that finds it anywhere else
 * would be finding a line the baseline never attributed to that filter.
 *
 * @param filterId - Official catalog ID whose file is being written.
 * @returns Exact published bytes for that filter.
 */
function publishedFilterContent(filterId: number): Buffer {
    const rule = filterId === CULPRIT_FILTER_ID ? CULPRIT : `other-${filterId}.example##.ad`;
    return Buffer.from(`! Filter ${filterId}\n${rule}\nlast.example##.tail\n`, 'utf8');
}

/**
 * Digest one filter resource exactly as the baseline lock does.
 *
 * @param bytes - Exact resource bytes.
 * @returns Hex SHA-256 digest.
 */
function digestOf(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
}

interface CatalogRowFixture {
    id: number;
    title: string;
    installed: boolean;
    enabled: boolean;
}

interface SandboxBehaviour {
    /**
     * Catalog rows the native list displays before any command runs.
     */
    rows?: CatalogRowFixture[];
    /**
     * Requested ID whose add command rejects.
     */
    failAdd?: number;
    /**
     * Exact filter command that rejects with a native failure.
     */
    failCommand?: { action: ProxyBlockerBaselineAction; filterId: number };
    /**
     * Catalog ID whose enable command succeeds while the row stays disabled.
     */
    ignoreEnable?: number;
    /**
     * Whether installing the agent-authored candidate source rejects.
     */
    failApplyCandidate?: boolean;
    /**
     * Receipt fields overriding an honest single-rule installation.
     */
    candidateReceipt?: Partial<ProxyBlockerCandidateReceipt>;
    /**
     * Whether removing the agent-authored candidate source rejects.
     */
    failRevokeCandidate?: boolean;
    /**
     * Whether replacing one line inside the locked baseline rejects.
     */
    failApplyBaselineEdit?: boolean;
    /**
     * Receipt fields overriding an honest single-line replacement.
     */
    baselineEditReceipt?: Partial<ProxyBlockerBaselineEditReceipt>;
    /**
     * Digest the restore reports instead of the locked one.
     */
    restoredSha256?: string;
}

interface Sandbox {
    host: ProxyBlockerBaselineHostPort;
    fileSystem: BaselineFileSystemPort;
    commands: string[];
    setEnabled(filterId: number, enabled: boolean): void;
    ignoreDisable(filterId: number | null): void;
    applyCandidate(rule: string): Promise<ProxyBlockerCandidateReceipt>;
    revokeCandidate(): Promise<void>;
    applyBaselineEdit(
        originalRule: string,
        replacementRule: string,
    ): Promise<ProxyBlockerBaselineEditReceipt>;
    applyBaselineRemoval(originalRule: string): Promise<ProxyBlockerBaselineEditReceipt>;
    revokeBaselineEdit(): Promise<string>;
    filterLines(filterId: number): string[];
}

/**
 * Default pinned catalog the scripted installation displays.
 *
 * @returns Fresh mutable rows for one sandbox.
 */
function defaultRows(): CatalogRowFixture[] {
    return [
        { id: -1, title: 'Custom user filter', installed: true, enabled: true },
        { id: 1, title: 'AdGuard Russian filter', installed: false, enabled: false },
        { id: 2, title: 'AdGuard Base filter', installed: false, enabled: false },
        { id: 14, title: 'AdGuard Annoyances filter', installed: false, enabled: false },
    ];
}

/**
 * Pinned catalog wide enough for a three-filter baseline one probe can narrow.
 *
 * @returns Fresh mutable rows for one sandbox.
 */
function isolationRows(): CatalogRowFixture[] {
    return [
        { id: -1, title: 'Custom user filter', installed: true, enabled: true },
        { id: 1, title: 'AdGuard Russian filter', installed: false, enabled: false },
        { id: 2, title: 'AdGuard Base filter', installed: false, enabled: false },
        { id: 3, title: 'AdGuard Tracking Protection filter', installed: false, enabled: false },
        { id: 14, title: 'AdGuard Annoyances filter', installed: false, enabled: false },
    ];
}

/**
 * Render one catalog row in the pinned release table layout.
 *
 * @param row - Current fixture row state.
 * @returns One native output line.
 */
function renderRow(row: CatalogRowFixture): string {
    const marker = row.enabled ? '[x]' : row.installed ? '[ ]' : '   ';
    const status = row.enabled
        ? LAST_UPDATE
        : row.installed
          ? 'Filter is disabled'
          : 'Filter is not added';
    return `${marker} | ${String(row.id).padStart(12)} | ${row.title.padEnd(39)} ${status}`;
}

/**
 * Build the injected command and filesystem boundaries for one scripted sandbox.
 *
 * @param behaviour - Scripted native behaviour for this run.
 * @returns Ports plus the command journal and a hook for filters the CLI enables on its own.
 */
function createSandbox(behaviour: SandboxBehaviour = {}): Sandbox {
    const rows = (behaviour.rows ?? defaultRows()).map((row) => ({ ...row }));
    const commands: string[] = [];
    const storage = new Map<string, Buffer>();
    let nextInode = 100;
    const inodes = new Map<string, number>();
    let ignoredDisable: number | null = null;
    let lockedBytes: Buffer | null = null;

    const host: ProxyBlockerBaselineHostPort = {
        cliDataRoot: CLI_DATA_ROOT,
        async runBaselineAction(action, filterId) {
            commands.push(`${action}:${filterId ?? 'none'}`);
            if (
                behaviour.failCommand?.action === action &&
                behaviour.failCommand.filterId === filterId
            ) {
                throw new Error(`native ${action} refused for /private/tmp/cli/state`);
            }
            if (action === 'list_all_filters') {
                const header = `    | ${'ID'.padStart(12)} | ${'Title'.padEnd(39)} Last update`;
                return [header, 'Ad blocking', ...rows.map(renderRow), ''].join('\n');
            }
            const row = rows.find((candidate) => candidate.id === filterId);
            if (action === 'add_filter') {
                if (behaviour.failAdd === filterId) {
                    throw new Error('native add refused');
                }
                const path = `${CLI_DATA_ROOT}/filters/${filterId}.txt`;
                nextInode += 1;
                inodes.set(path, nextInode);
                storage.set(path, publishedFilterContent(filterId!));
                if (row) {
                    row.installed = true;
                    row.enabled = true;
                }
                return '';
            }
            const ignored =
                (action === 'enable_filter' && behaviour.ignoreEnable === filterId) ||
                (action === 'disable_filter' && ignoredDisable === filterId);
            if (row && !ignored) {
                row.enabled = action === 'enable_filter';
            }
            return '';
        },
        async listStorageFiles() {
            return [...storage.keys()];
        },
    };

    const metadataOf = (path: string): BaselineFileMetadata => {
        const bytes = storage.get(path);
        if (!bytes) {
            throw new Error('no such file');
        }
        return {
            size: bytes.byteLength,
            device: 1,
            inode: inodes.get(path)!,
            modifiedMs: 1_700_000_000_000 + inodes.get(path)!,
            regular: true,
            symbolicLink: false,
        };
    };

    const fileSystem: BaselineFileSystemPort = {
        async inspect(path) {
            return metadataOf(path);
        },
        async realpath(path) {
            return path;
        },
        async readBounded(path) {
            return storage.get(path)!.toString('utf8');
        },
        async openNoFollow(path): Promise<OpenedBaselineFile> {
            const bytes = storage.get(path);
            if (!bytes) {
                throw new Error('no such file');
            }
            return {
                async stat() {
                    return metadataOf(path);
                },
                async *stream() {
                    yield Uint8Array.from(bytes);
                },
                async close() {},
            };
        },
    };

    return {
        host,
        fileSystem,
        commands,
        setEnabled(filterId, enabled) {
            const row = rows.find((candidate) => candidate.id === filterId);
            if (row) {
                row.installed = true;
                row.enabled = enabled;
            }
        },
        ignoreDisable(filterId) {
            ignoredDisable = filterId;
        },
        async applyCandidate(rule) {
            commands.push('apply_candidate');
            if (behaviour.failApplyCandidate) {
                throw new Error('native reload refused');
            }
            return {
                contentDigest: createHash('sha256').update(rule).digest('hex'),
                ruleCount: 1,
                extraSourceCount: 1,
                ...behaviour.candidateReceipt,
            };
        },
        async revokeCandidate() {
            commands.push('revoke_candidate');
            if (behaviour.failRevokeCandidate) {
                throw new Error('native reload refused');
            }
        },
        async applyBaselineEdit(originalRule, replacementRule) {
            commands.push('apply_baseline_edit');
            if (behaviour.failApplyBaselineEdit) {
                throw new Error('native reload refused');
            }
            const path = `${CLI_DATA_ROOT}/filters/${CULPRIT_FILTER_ID}.txt`;
            const before = storage.get(path)!;
            lockedBytes = before;
            const lines = before.toString('utf8').split('\n');
            const after = Buffer.from(
                lines.map((line) => (line === originalRule ? replacementRule : line)).join('\n'),
                'utf8',
            );
            storage.set(path, after);
            return {
                filterId: CULPRIT_FILTER_ID,
                beforeSha256: digestOf(before),
                afterSha256: digestOf(after),
                replacedLineCount: lines.filter((line) => line === originalRule).length,
                extraSourceCount: 0,
                ...behaviour.baselineEditReceipt,
            };
        },
        async applyBaselineRemoval(originalRule) {
            commands.push('apply_baseline_removal');
            const path = `${CLI_DATA_ROOT}/filters/${CULPRIT_FILTER_ID}.txt`;
            const before = storage.get(path)!;
            lockedBytes = before;
            const lines = before.toString('utf8').split('\n');
            const after = Buffer.from(
                lines.filter((line) => line !== originalRule).join('\n'),
                'utf8',
            );
            storage.set(path, after);
            return {
                filterId: CULPRIT_FILTER_ID,
                beforeSha256: digestOf(before),
                afterSha256: digestOf(after),
                replacedLineCount: lines.filter((line) => line === originalRule).length,
                extraSourceCount: 0,
                ...behaviour.baselineEditReceipt,
            };
        },
        async revokeBaselineEdit() {
            commands.push('revoke_baseline_edit');
            const path = `${CLI_DATA_ROOT}/filters/${CULPRIT_FILTER_ID}.txt`;
            if (lockedBytes) {
                storage.set(path, lockedBytes);
            }
            return behaviour.restoredSha256 ?? digestOf(storage.get(path)!);
        },
        filterLines(filterId) {
            return storage
                .get(`${CLI_DATA_ROOT}/filters/${filterId}.txt`)!
                .toString('utf8')
                .split('\n');
        },
    };
}

const closedSessions: string[] = [];

/**
 * Build one fake controlled browser session for a phase.
 *
 * @param sessionId - Stable identity the adapter binds into its proof.
 * @returns Session honouring the common browser surface.
 */
function fakeSession(sessionId: string): IBrowserSession {
    return {
        artifactsDir: '/tmp/artifacts',
        isClosed: false,
        getPage: () => {
            throw new Error('not used');
        },
        close: async () => {
            closedSessions.push(sessionId);
        },
        getNetworkLog: () => [],
        resetNetworkLog: () => undefined,
        getConsoleLog: () => [],
        consoleCoverage: ConsoleCoverage.BrowserLogOnly,
    } as IBrowserSession;
}

/**
 * Build one adapter over a scripted sandbox with deterministic identities.
 *
 * @param sandbox - Scripted command and filesystem boundaries.
 * @param overrides - Optional session port replacement.
 * @returns Unprepared adapter ready for the contract under test.
 */
function createAdapter(
    sandbox: Sandbox,
    overrides: {
        createSession?: (phase: EnvironmentPhase) => Promise<IBrowserSession>;
        withoutCandidatePorts?: boolean;
        withoutBaselineEditPorts?: boolean;
        withoutBaselineRemovalPort?: boolean;
    } = {},
): ProxyBlockerEnvironmentAdapter {
    return new ProxyBlockerEnvironmentAdapter({
        executor: 'adguard_cli',
        cliVersion: CLI_VERSION,
        installationDigest: INSTALLATION_DIGEST,
        baselineHost: sandbox.host,
        fileSystem: sandbox.fileSystem,
        now: () => '2026-07-28T10:00:00.000Z',
        createLeaseId: (phase) => `lease-${phase}`,
        async createSession({ phase }) {
            const session = overrides.createSession
                ? await overrides.createSession(phase)
                : fakeSession(`session-${phase}`);
            return { session, sessionId: `session-${phase}` };
        },
        ...(overrides.withoutCandidatePorts
            ? {}
            : {
                  applyCandidate: (rule: string) => sandbox.applyCandidate(rule),
                  revokeCandidate: () => sandbox.revokeCandidate(),
              }),
        ...(overrides.withoutBaselineEditPorts
            ? {}
            : {
                  applyBaselineEdit: (originalRule: string, replacementRule: string) =>
                      sandbox.applyBaselineEdit(originalRule, replacementRule),
                  revokeBaselineEdit: () => sandbox.revokeBaselineEdit(),
              }),
        ...(overrides.withoutBaselineEditPorts || overrides.withoutBaselineRemovalPort
            ? {}
            : {
                  applyBaselineRemoval: (originalRule: string) =>
                      sandbox.applyBaselineRemoval(originalRule),
              }),
    });
}

/**
 * Prepare one adapter over the requested official set.
 *
 * @param sandbox - Scripted command and filesystem boundaries.
 * @param requestedFilterIds - Requested official catalog IDs.
 * @returns Prepared adapter and its preparation result.
 */
async function prepared(
    sandbox: Sandbox,
    requestedFilterIds: number[] = [2, 14],
    overrides: Parameters<typeof createAdapter>[1] = {},
): Promise<{
    adapter: ProxyBlockerEnvironmentAdapter;
    result: Awaited<ReturnType<ProxyBlockerEnvironmentAdapter['prepare']>>;
}> {
    const adapter = createAdapter(sandbox, overrides);
    const result = await adapter.prepare({ requestedLists: refsOf(requestedFilterIds) });
    return { adapter, result };
}

/**
 * Open one phase and return the commands it issued after preparation.
 *
 * @param sandbox - Scripted sandbox whose command journal is sliced.
 * @param adapter - Prepared adapter under test.
 * @param phase - Exact phase to open.
 * @param candidate - Exact candidate for C, else null.
 * @param enabledListKeys - Official list-key subset this phase asks to enable, else null.
 * @returns Open result plus the commands that phase issued.
 */
async function openPhase(
    sandbox: Sandbox,
    adapter: ProxyBlockerEnvironmentAdapter,
    phase: EnvironmentPhase,
    candidate: EnvironmentCandidate | null = phase === 'C'
        ? { operation: 'add', rule: RULE }
        : null,
    enabledListKeys: readonly string[] | null = null,
): Promise<{
    opened: Awaited<ReturnType<ProxyBlockerEnvironmentAdapter['openPhase']>>;
    commands: string[];
}> {
    const before = sandbox.commands.length;
    const opened = await adapter.openPhase({
        experimentId: 'experiment-1',
        phase,
        targetUrl: TARGET_URL,
        candidate,
        enabledListKeys,
    });
    return { opened, commands: sandbox.commands.slice(before) };
}

/**
 * Open the control and published-baseline phases a candidate phase depends on.
 *
 * @param sandbox - Scripted command and filesystem boundaries.
 * @param adapter - Prepared adapter under test.
 */
async function openBaselinePhases(
    sandbox: Sandbox,
    adapter: ProxyBlockerEnvironmentAdapter,
): Promise<void> {
    await openPhase(sandbox, adapter, 'A');
    await openPhase(sandbox, adapter, 'B');
}

/**
 * Inline fake descriptors for the two executors this suite exercises.
 *
 * @returns Fresh descriptor fixtures independent of any default executor list.
 */
function suiteExecutorDescriptors(): FilteringEnvironmentDescriptor[] {
    return [
        {
            kind: 'browser_extension',
            availability: FilteringEnvironmentAvailability.Available,
            preparationState: EnvironmentPreparationState.NotStarted,
            limitationCode: null,
            capabilities: [
                EnvironmentCapability.BrowserNavigation,
                EnvironmentCapability.FilteringControl,
                EnvironmentCapability.ExtensionFiltering,
                EnvironmentCapability.CandidateApplication,
                EnvironmentCapability.BaselineIntegrity,
                EnvironmentCapability.PhaseProof,
            ],
        },
        {
            kind: 'adguard_cli',
            availability: FilteringEnvironmentAvailability.Available,
            preparationState: EnvironmentPreparationState.Preparable,
            limitationCode: null,
            capabilities: [
                EnvironmentCapability.CliInstallation,
                EnvironmentCapability.CliActivation,
            ],
        },
    ];
}

const facts: IssueFacts = {
    issueNumber: 4242,
    issueUrl: 'https://github.com/AdguardTeam/AdguardFilters/issues/4242',
    reportedSiteUrls: [TARGET_URL],
    labels: ['T: Ads', 'N: AdGuard for Mac'],
    declaredIssueType: 'Ads',
    problemType: 'ads',
    product: 'AdGuard for Mac',
    os: 'macOS 15',
    browser: 'Safari',
    enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
    screenshots: [],
};

/**
 * Build the model-authored CLI selection the agent submits for a desktop Ads report.
 *
 * @returns Selection request shaped exactly as the agent tool delivers it.
 */
function cliSelection(): unknown {
    return {
        kind: 'adguard_cli',
        requiredCapabilities: [],
        intent: {
            issueType: 'ads',
            rationale: 'The report describes an advertisement that survives the desktop product.',
            confidence: 0.9,
            evidence: [{ source: 'issue_body', observation: 'A banner remains visible.' }],
            conflicts: [],
        },
        rationale: 'CLI is the closest available approximation of the reported desktop product.',
        confidence: 0.8,
    };
}

/**
 * Build one complete validator observation for a phase the adapter established.
 *
 * @param sessionId - Session identity carried by the phase proof.
 * @returns Observed completion the recorder accepts.
 */
function observation(sessionId: string): ValidatorPhaseCompletion {
    return {
        kind: 'observed',
        sessionId,
        targetUrl: TARGET_URL,
        targetObservation: { symptomPresent: true, pageUsable: true },
        navigationVerified: true,
        artifacts: [],
        vision: null,
        candidateValidation: null,
        rejectedCandidates: [],
    };
}

describe('ProxyBlockerEnvironmentAdapter', () => {
    it('locks the requested official baseline and reports the CLI as the actual product', async () => {
        const sandbox = createSandbox();
        const { adapter, result } = await prepared(sandbox);

        expect(result.ready).toBe(true);
        if (!result.ready) {
            return;
        }
        expect(adapter.snapshot()).toMatchObject({
            kind: 'adguard_cli',
            lifecycle: 'ready',
            baseline: {
                environment: 'adguard_cli',
                enabledListKeys: ['adguard:2', 'adguard:14'],
            },
            actualContext: {
                kind: 'adguard_cli',
                product: 'AdGuard CLI',
                browser: 'CloakBrowser Chromium',
                productVersion: CLI_VERSION,
            },
        });
    });

    it('fails preparation closed when a requested list key is unresolvable', async () => {
        for (const key of ['ublock:2', 'adguard:9999']) {
            const sandbox = createSandbox();
            const adapter = createAdapter(sandbox);

            const result = await adapter.prepare({
                requestedLists: [
                    officialAdguardListRef(2)!,
                    {
                        key,
                        title: 'Unresolvable list',
                        source: { kind: 'url', url: 'https://example.test/x.txt' },
                        owned: false,
                    },
                ],
            });

            expect(result.ready).toBe(false);
            if (result.ready) {
                return;
            }
            expect(result.limitation).toMatchObject({
                code: 'baseline_manifest_invalid',
                stage: 'preparation',
            });
            expect(result.limitation.detail).toContain(key);
            expect(adapter.snapshot().lifecycle).toBe('limited');
            // Nothing was sent to the native layer: no command ran for a reduced set.
            expect(sandbox.commands).toEqual([]);
        }
    });

    it('propagates a baseline limitation unchanged and never becomes ready', async () => {
        const sandbox = createSandbox({ failAdd: 14 });
        const { adapter, result } = await prepared(sandbox);

        expect(result).toEqual({
            ready: false,
            limitation: {
                code: 'baseline_manifest_invalid',
                stage: 'baseline',
                detail: 'A requested official filter could not be added from the native catalog.',
            },
        });
        expect(adapter.snapshot().lifecycle).toBe('limited');
    });

    it('proves the control phase by disabling every requested filter and re-reading the catalog', async () => {
        const sandbox = createSandbox();
        const { adapter } = await prepared(sandbox);

        const { opened, commands } = await openPhase(sandbox, adapter, 'A');

        expect(commands).toEqual([
            'disable_filter:2',
            'disable_filter:14',
            'list_all_filters:none',
        ]);
        expect(opened.ready).toBe(true);
        if (!opened.ready) {
            return;
        }
        expect(opened.handle.adapterProof).toMatchObject({
            phase: 'A',
            filteringState: 'disabled',
            baselineDigest: null,
            candidateDigest: null,
            extension: null,
            cli: { cliVersion: CLI_VERSION, enabledListKeys: [], userFilterEnabled: true },
        });
    });

    it('proves the published baseline by enabling exactly the requested filters', async () => {
        const sandbox = createSandbox();
        const { adapter, result } = await prepared(sandbox);
        await openPhase(sandbox, adapter, 'A');

        const { opened, commands } = await openPhase(sandbox, adapter, 'B');

        expect(commands).toEqual(['enable_filter:2', 'enable_filter:14', 'list_all_filters:none']);
        expect(opened.ready && result.ready).toBe(true);
        if (!opened.ready || !result.ready) {
            return;
        }
        expect(opened.handle.adapterProof).toMatchObject({
            phase: 'B',
            filteringState: 'published_baseline',
            baselineDigest: result.state.baseline!.aggregateDigest,
            extension: null,
            cli: { enabledListKeys: ['adguard:2', 'adguard:14'], coenabledListKeys: [] },
        });
    });

    it('opens both phases when the CLI enables a filter of its own accord in each of them', async () => {
        const sandbox = createSandbox();
        const { adapter } = await prepared(sandbox);
        sandbox.setEnabled(1, true);

        const control = await openPhase(sandbox, adapter, 'A');
        const baseline = await openPhase(sandbox, adapter, 'B');

        expect(control.opened.ready && baseline.opened.ready).toBe(true);
        if (!control.opened.ready || !baseline.opened.ready) {
            return;
        }
        expect(control.opened.handle.adapterProof.cli?.coenabledListKeys).toEqual(['adguard:1']);
        expect(baseline.opened.handle.adapterProof.cli?.coenabledListKeys).toEqual(['adguard:1']);
    });

    it('refuses the published baseline when an unrequested filter appears only in it', async () => {
        const sandbox = createSandbox();
        const { adapter } = await prepared(sandbox);
        await openPhase(sandbox, adapter, 'A');
        sandbox.setEnabled(1, true);

        const { opened } = await openPhase(sandbox, adapter, 'B');

        expect(opened).toMatchObject({
            ready: false,
            limitation: { code: 'phase_proof_unavailable', stage: 'phase' },
        });
    });

    it('refuses the published baseline when a requested filter stays disabled', async () => {
        const sandbox = createSandbox({ ignoreEnable: 14 });
        const { adapter } = await prepared(sandbox);
        await openPhase(sandbox, adapter, 'A');

        const { opened } = await openPhase(sandbox, adapter, 'B');

        expect(opened).toMatchObject({
            ready: false,
            limitation: { code: 'phase_proof_unavailable', stage: 'phase' },
        });
    });

    it('enables exactly the official subset one isolation probe asked for and proves it', async () => {
        const sandbox = createSandbox({ rows: isolationRows() });
        const { adapter } = await prepared(sandbox, [2, 3, 14]);
        await openPhase(sandbox, adapter, 'A');

        const { opened, commands } = await openPhase(sandbox, adapter, 'B', null, keysOf([2]));

        expect(commands).toEqual([
            'enable_filter:2',
            'disable_filter:3',
            'disable_filter:14',
            'list_all_filters:none',
        ]);
        expect(opened.ready).toBe(true);
        if (!opened.ready) {
            return;
        }
        expect(opened.handle.adapterProof.cli).toMatchObject({
            enabledListKeys: ['adguard:2'],
            coenabledListKeys: [],
        });
    });

    it('refuses a narrowed baseline the catalog proves wider than the subset asked for', async () => {
        const sandbox = createSandbox({ rows: isolationRows() });
        const { adapter } = await prepared(sandbox, [2, 3, 14]);
        await openPhase(sandbox, adapter, 'A');
        sandbox.setEnabled(3, true);
        sandbox.ignoreDisable(3);

        const { opened } = await openPhase(sandbox, adapter, 'B', null, keysOf([2]));

        expect(opened).toMatchObject({
            ready: false,
            limitation: { code: 'phase_proof_unavailable', stage: 'phase' },
        });
    });

    it.each([
        ['a filter that is not part of the locked baseline', keysOf([2, 99])],
        ['no filter at all', []],
    ])('refuses a subset naming %s before any filter command runs', async (_name, subset) => {
        const sandbox = createSandbox({ rows: isolationRows() });
        const { adapter } = await prepared(sandbox, [2, 3, 14]);
        await openPhase(sandbox, adapter, 'A');

        const { opened, commands } = await openPhase(sandbox, adapter, 'B', null, subset);

        expect(commands).toEqual([]);
        expect(opened).toMatchObject({
            ready: false,
            limitation: { code: 'settings_mismatch', stage: 'phase' },
        });
    });

    it('keeps the candidate phase bound to a whole baseline rather than an isolation probe', async () => {
        const sandbox = createSandbox({ rows: isolationRows() });
        const { adapter } = await prepared(sandbox, [2, 3, 14]);
        await openPhase(sandbox, adapter, 'A');
        await openPhase(sandbox, adapter, 'B', null, keysOf([2]));

        const afterProbe = await openPhase(sandbox, adapter, 'C');

        expect(afterProbe.commands).toEqual([]);
        expect(afterProbe.opened).toMatchObject({
            ready: false,
            limitation: { code: 'phase_proof_unavailable', stage: 'phase' },
        });

        await openPhase(sandbox, adapter, 'B');
        const afterBaseline = await openPhase(sandbox, adapter, 'C');

        expect(afterBaseline.opened.ready).toBe(true);
    });

    it('refuses a narrowed baseline whose co-enabled set drifted from the control', async () => {
        const sandbox = createSandbox({ rows: isolationRows() });
        const { adapter } = await prepared(sandbox, [2, 3, 14]);
        await openPhase(sandbox, adapter, 'A');
        sandbox.setEnabled(1, true);

        const { opened } = await openPhase(sandbox, adapter, 'B', null, keysOf([2]));

        expect(opened).toMatchObject({
            ready: false,
            limitation: { code: 'phase_proof_unavailable', stage: 'phase' },
        });
    });

    it('refuses a phase whose native filter command fails without leaking native detail', async () => {
        const sandbox = createSandbox({
            failCommand: { action: 'disable_filter', filterId: 14 },
        });
        const { adapter } = await prepared(sandbox);

        const { opened } = await openPhase(sandbox, adapter, 'A');

        expect(opened.ready).toBe(false);
        if (opened.ready) {
            return;
        }
        expect(opened.limitation).toMatchObject({ code: 'phase_open_failed', stage: 'phase' });
        expect(opened.limitation.detail).not.toContain('/private/tmp');
        expect(opened.limitation.detail).not.toContain('native');
    });

    it('applies exactly one candidate beside the baseline and proves nothing else changed', async () => {
        const sandbox = createSandbox();
        const { adapter, result } = await prepared(sandbox);
        await openPhase(sandbox, adapter, 'A');
        const baseline = await openPhase(sandbox, adapter, 'B');

        const { opened, commands } = await openPhase(sandbox, adapter, 'C');

        expect(commands).toEqual(['apply_candidate', 'list_all_filters:none']);
        expect(opened.ready && baseline.opened.ready && result.ready).toBe(true);
        if (!opened.ready || !baseline.opened.ready || !result.ready) {
            return;
        }
        expect(opened.handle.adapterProof).toMatchObject({
            phase: 'C',
            filteringState: 'published_baseline_plus_candidate',
            baselineDigest: result.state.baseline!.aggregateDigest,
            candidateDigest: RULE_DIGEST,
            extension: null,
        });
        expect(opened.handle.adapterProof.cli).toEqual(baseline.opened.handle.adapterProof.cli);
    });

    it('revokes the candidate exactly once when its phase closes', async () => {
        const sandbox = createSandbox();
        const { adapter } = await prepared(sandbox);
        await openBaselinePhases(sandbox, adapter);
        const { opened } = await openPhase(sandbox, adapter, 'C');
        expect(opened.ready).toBe(true);
        if (!opened.ready) {
            return;
        }

        await opened.handle.close();
        const cleanup = await adapter.cleanup();

        expect(sandbox.commands.filter((command) => command === 'revoke_candidate')).toEqual([
            'revoke_candidate',
        ]);
        expect(cleanup).toMatchObject({ completed: true, failures: [] });
    });

    it('keeps the run failed when the candidate cannot be revoked', async () => {
        const sandbox = createSandbox({ failRevokeCandidate: true });
        const { adapter } = await prepared(sandbox);
        await openBaselinePhases(sandbox, adapter);
        const { opened } = await openPhase(sandbox, adapter, 'C');
        expect(opened.ready).toBe(true);
        if (!opened.ready) {
            return;
        }

        await expect(opened.handle.close()).rejects.toThrow();
        const cleanup = await adapter.cleanup();

        expect(cleanup).toMatchObject({ completed: false });
        expect(cleanup.failures).toContainEqual({
            code: 'cleanup_failed',
            stage: 'cleanup',
            detail: expect.any(String),
        });
        expect(adapter.snapshot().lifecycle).toBe('cleanup_failed');
    });

    it.each([
        ['a candidate phase carrying no candidate', null, 'phase_open_failed', 'phase'],
        [
            'an edit naming no exact line to replace',
            { operation: 'edit' as const, rule: RULE },
            'candidate_operation_unsupported',
            'candidate',
        ],
    ])('refuses %s before issuing any command', async (_name, candidate, code, stage) => {
        const sandbox = createSandbox();
        const { adapter } = await prepared(sandbox);
        await openBaselinePhases(sandbox, adapter);

        const { opened, commands } = await openPhase(sandbox, adapter, 'C', candidate);

        expect(commands).toEqual([]);
        expect(opened).toMatchObject({ ready: false, limitation: { code, stage } });
    });

    it('refuses the candidate phase and omits the capability without any candidate ports', async () => {
        const sandbox = createSandbox();
        const { adapter } = await prepared(sandbox, [2, 14], {
            withoutCandidatePorts: true,
            withoutBaselineEditPorts: true,
        });
        await openBaselinePhases(sandbox, adapter);

        const { opened, commands } = await openPhase(sandbox, adapter, 'C');

        expect(commands).toEqual([]);
        expect(opened).toMatchObject({
            ready: false,
            limitation: { code: 'candidate_operation_unsupported', stage: 'candidate' },
        });
        expect(adapter.capabilities()).not.toContain('candidate_application');
        expect(createAdapter(sandbox).capabilities()).toContain('candidate_application');
    });

    it('refuses the candidate phase before a published baseline was established', async () => {
        const sandbox = createSandbox();
        const { adapter } = await prepared(sandbox);
        await openPhase(sandbox, adapter, 'A');

        const { opened, commands } = await openPhase(sandbox, adapter, 'C');

        expect(commands).toEqual([]);
        expect(opened).toMatchObject({
            ready: false,
            limitation: { code: 'phase_proof_unavailable', stage: 'phase' },
        });
    });

    it.each([
        ['the installation refuses the candidate', { failApplyCandidate: true }],
        [
            'the installation executes more than the proposed rule',
            { candidateReceipt: { ruleCount: 2 } },
        ],
        [
            'the installation gained another agent-authored source',
            { candidateReceipt: { extraSourceCount: 2 } },
        ],
    ])('revokes and reports a failed candidate application when %s', async (_name, behaviour) => {
        const sandbox = createSandbox(behaviour);
        const { adapter } = await prepared(sandbox);
        await openBaselinePhases(sandbox, adapter);

        const { opened, commands } = await openPhase(sandbox, adapter, 'C');

        expect(opened.ready).toBe(false);
        if (opened.ready) {
            return;
        }
        expect(opened.limitation).toMatchObject({
            code: 'candidate_application_failed',
            stage: 'candidate',
        });
        expect(opened.limitation.detail).not.toContain(RULE);
        expect(commands).toContain('revoke_candidate');
    });

    it('replaces exactly one published line and proves the official state is unchanged', async () => {
        const sandbox = createSandbox();
        const { adapter, result } = await prepared(sandbox);
        await openPhase(sandbox, adapter, 'A');
        const baseline = await openPhase(sandbox, adapter, 'B');

        const { opened, commands } = await openPhase(sandbox, adapter, 'C', {
            operation: 'edit',
            rule: CULPRIT_REPLACEMENT,
            originalRule: CULPRIT,
        });

        expect(commands).toEqual(['apply_baseline_edit', 'list_all_filters:none']);
        expect(opened.ready && baseline.opened.ready && result.ready).toBe(true);
        if (!opened.ready || !baseline.opened.ready || !result.ready) {
            return;
        }
        expect(opened.handle.adapterProof).toMatchObject({
            phase: 'C',
            filteringState: 'published_baseline_plus_candidate',
            baselineDigest: result.state.baseline!.aggregateDigest,
            candidateDigest: CULPRIT_REPLACEMENT_DIGEST,
            extension: null,
        });
        expect(opened.handle.adapterProof.cli).toEqual(baseline.opened.handle.adapterProof.cli);
        expect(sandbox.filterLines(CULPRIT_FILTER_ID)).toContain(CULPRIT_REPLACEMENT);
        expect(sandbox.filterLines(CULPRIT_FILTER_ID)).not.toContain(CULPRIT);
    });

    it('restores the locked published baseline when the edit phase closes', async () => {
        const sandbox = createSandbox();
        const { adapter } = await prepared(sandbox);
        await openBaselinePhases(sandbox, adapter);
        const { opened } = await openPhase(sandbox, adapter, 'C', {
            operation: 'edit',
            rule: CULPRIT_REPLACEMENT,
            originalRule: CULPRIT,
        });
        expect(opened.ready).toBe(true);
        if (!opened.ready) {
            return;
        }

        await opened.handle.close();
        const cleanup = await adapter.cleanup();

        expect(sandbox.commands.filter((command) => command === 'revoke_baseline_edit')).toEqual([
            'revoke_baseline_edit',
        ]);
        expect(sandbox.filterLines(CULPRIT_FILTER_ID)).toContain(CULPRIT);
        expect(cleanup).toMatchObject({ completed: true, failures: [] });
    });

    it('keeps the run failed when the locked baseline was not restored byte for byte', async () => {
        const sandbox = createSandbox({ restoredSha256: 'f'.repeat(64) });
        const { adapter } = await prepared(sandbox);
        await openBaselinePhases(sandbox, adapter);
        const { opened } = await openPhase(sandbox, adapter, 'C', {
            operation: 'edit',
            rule: CULPRIT_REPLACEMENT,
            originalRule: CULPRIT,
        });
        expect(opened.ready).toBe(true);
        if (!opened.ready) {
            return;
        }

        await expect(opened.handle.close()).rejects.toThrow();
        const cleanup = await adapter.cleanup();

        expect(cleanup).toMatchObject({ completed: false });
        expect(cleanup.failures).toContainEqual({
            code: 'cleanup_failed',
            stage: 'cleanup',
            detail: expect.any(String),
        });
        expect(adapter.snapshot().lifecycle).toBe('cleanup_failed');
    });

    it.each([
        ['the installation refuses the replacement', { failApplyBaselineEdit: true }],
        [
            'the replacement found no line to replace',
            { baselineEditReceipt: { replacedLineCount: 0 } },
        ],
        [
            'the replacement changed more than one line',
            { baselineEditReceipt: { replacedLineCount: 2 } },
        ],
        [
            'the installation gained an agent-authored source beside the baseline',
            { baselineEditReceipt: { extraSourceCount: 1 } },
        ],
        [
            'the edited resource is not the one the baseline locked',
            { baselineEditReceipt: { beforeSha256: 'e'.repeat(64) } },
        ],
        [
            'the resource is unchanged, so the reported replacement never happened',
            { baselineEditReceipt: { afterSha256: digestOf(publishedFilterContent(2)) } },
        ],
    ])('revokes and reports a failed edit application when %s', async (_name, behaviour) => {
        const sandbox = createSandbox(behaviour);
        const { adapter } = await prepared(sandbox);
        await openBaselinePhases(sandbox, adapter);

        const { opened, commands } = await openPhase(sandbox, adapter, 'C', {
            operation: 'edit',
            rule: CULPRIT_REPLACEMENT,
            originalRule: CULPRIT,
        });

        expect(opened.ready).toBe(false);
        if (opened.ready) {
            return;
        }
        expect(opened.limitation).toMatchObject({
            code: 'candidate_application_failed',
            stage: 'candidate',
        });
        expect(opened.limitation.detail).not.toContain(CULPRIT);
        expect(commands).toContain('revoke_baseline_edit');
    });

    it.each([
        [
            'an addition naming a line to replace',
            { operation: 'add' as const, rule: RULE, originalRule: CULPRIT },
        ],
        [
            'a removal naming a line to replace',
            { operation: 'remove' as const, rule: CULPRIT, originalRule: CULPRIT },
        ],
    ])('refuses %s before issuing any command', async (_name, candidate) => {
        const sandbox = createSandbox();
        const { adapter } = await prepared(sandbox);
        await openBaselinePhases(sandbox, adapter);

        const { opened, commands } = await openPhase(sandbox, adapter, 'C', candidate);

        expect(commands).toEqual([]);
        expect(opened).toMatchObject({
            ready: false,
            limitation: { code: 'candidate_operation_unsupported', stage: 'candidate' },
        });
    });

    it('deletes exactly one published line and proves the official state is unchanged', async () => {
        const sandbox = createSandbox();
        const { adapter, result } = await prepared(sandbox);
        await openPhase(sandbox, adapter, 'A');
        const baseline = await openPhase(sandbox, adapter, 'B');

        const { opened, commands } = await openPhase(sandbox, adapter, 'C', {
            operation: 'remove',
            rule: CULPRIT,
        });

        expect(commands).toEqual(['apply_baseline_removal', 'list_all_filters:none']);
        expect(opened.ready && baseline.opened.ready && result.ready).toBe(true);
        if (!opened.ready || !baseline.opened.ready || !result.ready) {
            return;
        }
        expect(opened.handle.adapterProof).toMatchObject({
            phase: 'C',
            filteringState: 'published_baseline_plus_candidate',
            baselineDigest: result.state.baseline!.aggregateDigest,
            candidateDigest: CULPRIT_DIGEST,
            extension: null,
        });
        expect(opened.handle.adapterProof.cli).toEqual(baseline.opened.handle.adapterProof.cli);
        expect(sandbox.filterLines(CULPRIT_FILTER_ID)).not.toContain(CULPRIT);
        expect(sandbox.filterLines(CULPRIT_FILTER_ID)).toEqual(
            publishedFilterContent(CULPRIT_FILTER_ID)
                .toString('utf8')
                .split('\n')
                .filter((line) => line !== CULPRIT),
        );
    });

    it('refuses the removal phase without the removal port and still offers the edit', async () => {
        const sandbox = createSandbox();
        const { adapter } = await prepared(sandbox, [2, 14], { withoutBaselineRemovalPort: true });
        await openBaselinePhases(sandbox, adapter);

        const { opened, commands } = await openPhase(sandbox, adapter, 'C', {
            operation: 'remove',
            rule: CULPRIT,
        });

        expect(commands).toEqual([]);
        expect(opened).toMatchObject({
            ready: false,
            limitation: { code: 'candidate_operation_unsupported', stage: 'candidate' },
        });
        expect(adapter.capabilities()).toContain('candidate_application');
    });

    it('refuses the edit phase without the baseline-edit ports and still offers the add', async () => {
        const sandbox = createSandbox();
        const { adapter } = await prepared(sandbox, [2, 14], { withoutBaselineEditPorts: true });
        await openBaselinePhases(sandbox, adapter);

        const { opened, commands } = await openPhase(sandbox, adapter, 'C', {
            operation: 'edit',
            rule: CULPRIT_REPLACEMENT,
            originalRule: CULPRIT,
        });

        expect(commands).toEqual([]);
        expect(opened).toMatchObject({
            ready: false,
            limitation: { code: 'candidate_operation_unsupported', stage: 'candidate' },
        });
        expect(adapter.capabilities()).toContain('candidate_application');
    });

    it('revokes and refuses the candidate phase when the official state drifted', async () => {
        const sandbox = createSandbox();
        const { adapter } = await prepared(sandbox);
        await openBaselinePhases(sandbox, adapter);
        sandbox.setEnabled(1, true);

        const { opened, commands } = await openPhase(sandbox, adapter, 'C');

        expect(opened).toMatchObject({
            ready: false,
            limitation: { code: 'phase_proof_unavailable', stage: 'phase' },
        });
        expect(commands).toContain('revoke_candidate');
    });

    it('refuses a phase before the baseline is prepared', async () => {
        const sandbox = createSandbox();
        const adapter = createAdapter(sandbox);

        const { opened, commands } = await openPhase(sandbox, adapter, 'A');

        expect(commands).toEqual([]);
        expect(opened).toMatchObject({
            ready: false,
            limitation: { code: 'phase_open_failed', stage: 'phase' },
        });
    });

    it('drains open phase sessions once and reports the same cleanup receipt twice', async () => {
        closedSessions.length = 0;
        const sandbox = createSandbox();
        const { adapter } = await prepared(sandbox);
        await openPhase(sandbox, adapter, 'A');

        const first = await adapter.cleanup();
        const second = await adapter.cleanup();

        expect(first).toMatchObject({ attempted: true, completed: true, failures: [] });
        expect(second).toEqual(first);
        expect(closedSessions).toEqual(['session-A']);
        expect(adapter.snapshot()).toMatchObject({ lifecycle: 'cleaned', openLeaseIds: [] });
    });

    it('records a locked CLI A/B investigation whose reported and actual products stay distinct', async () => {
        const sandbox = createSandbox();
        const selectionHost = new EnvironmentSelectionHost(facts, suiteExecutorDescriptors());
        expect(selectionHost.select(cliSelection())).toMatchObject({
            accepted: true,
            kind: 'adguard_cli',
            locked: true,
        });
        expect(selectionHost.select(cliSelection())).toMatchObject({
            accepted: false,
            errorKind: 'environment_locked',
        });

        const { adapter } = await prepared(sandbox);
        const recorder = new FilteringEnvironmentExecutionRecorder('run-1', selectionHost);
        recorder.registerAdapter(adapter.snapshot());
        for (const phase of ['A', 'B'] as const) {
            const token = recorder.beginPhase({
                runId: 'run-1',
                experimentId: 'experiment-1',
                phase,
            });
            const opened = await adapter.openPhase({
                experimentId: 'experiment-1',
                phase,
                targetUrl: TARGET_URL,
                candidate: null,
            });
            expect(opened.ready).toBe(true);
            if (!opened.ready) {
                return;
            }
            recorder.bindPhaseLease(token, opened.handle, adapter.snapshot());
            recorder.completePhase(token, observation(opened.handle.adapterProof.sessionId));
            await opened.handle.close();
        }
        const drain = await adapter.drainOpenHandles();
        const cleanup = await adapter.cleanup();
        recorder.recordCleanup({ adapterState: adapter.snapshot(), drain, cleanup });

        expect(() =>
            recorder.finalize({ status: 'verified', candidateDigest: null, failure: null }),
        ).toThrow();
        const execution = recorder.finalize({
            status: 'inconclusive',
            candidateDigest: null,
            failure: null,
        });

        expect(execution.phases.map((phase) => phase.phase)).toEqual(['A', 'B']);
        expect(selectionHost.snapshot()).toMatchObject({
            reported: { product: 'AdGuard for Mac', browser: 'Safari' },
            actual: {
                kind: 'adguard_cli',
                product: 'AdGuard CLI',
                productVersion: CLI_VERSION,
            },
            fidelityLimitations: [
                { code: 'product_approximation' },
                { code: 'browser_approximation' },
            ],
        });
    });

    it('records a complete CLI A/B/C investigation the recorder accepts as verified', async () => {
        const sandbox = createSandbox();
        const selectionHost = new EnvironmentSelectionHost(facts, suiteExecutorDescriptors());
        selectionHost.select(cliSelection());
        const { adapter } = await prepared(sandbox);
        const recorder = new FilteringEnvironmentExecutionRecorder('run-1', selectionHost);
        recorder.registerAdapter(adapter.snapshot());

        for (const phase of ['A', 'B', 'C'] as const) {
            const token = recorder.beginPhase({
                runId: 'run-1',
                experimentId: 'experiment-1',
                phase,
            });
            const opened = await adapter.openPhase({
                experimentId: 'experiment-1',
                phase,
                targetUrl: TARGET_URL,
                candidate: phase === 'C' ? { operation: 'add', rule: RULE } : null,
            });
            expect(opened.ready).toBe(true);
            if (!opened.ready) {
                return;
            }
            recorder.bindPhaseLease(token, opened.handle, adapter.snapshot());
            recorder.completePhase(token, observation(opened.handle.adapterProof.sessionId));
            await opened.handle.close();
        }
        const drain = await adapter.drainOpenHandles();
        const cleanup = await adapter.cleanup();
        recorder.recordCleanup({ adapterState: adapter.snapshot(), drain, cleanup });

        const execution = recorder.finalize({
            status: 'verified',
            candidateDigest: RULE_DIGEST,
            failure: null,
        });

        expect(execution.phases.map((phase) => phase.phase)).toEqual(['A', 'B', 'C']);
        expect(execution.disposition).toMatchObject({
            status: 'verified',
            candidateDigest: RULE_DIGEST,
        });
    });
});
