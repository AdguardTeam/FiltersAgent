import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';
import * as v from 'valibot';
import { type BaselineHostPort, type BaselineHostAction } from '../local/evidence-route-contract';
import {
    hashStream,
    nodeBaselineFileSystem,
    sameMetadata,
    type BaselineFileMetadata,
    type BaselineFileSystemPort,
} from '../environment/baseline-file-lock';
import {
    EnvironmentAdapterLimitationCode,
    EnvironmentLimitationStage,
    type EnvironmentAdapterLimitation,
} from '../environment/filtering-environment';
import {
    PublishedBaselineProvenanceSchema,
    type PublishedBaselineProvenance,
} from '../environment/environment-proofs';
import { adguardListKey } from '../environment/filter-list-ref';
import type { ExecutorName } from '../environment/executor-name';
import { OFFICIAL_ADGUARD_FILTERS } from '../environment/official-filter-catalog';
import { readProxyBlockerFilterList, type ProxyBlockerCatalogRow } from './catalog-table';
import {
    describeDiagnosticError,
    recordPreflightDiagnostic,
} from '../local/preflight-diagnostic-log';

/**
 * Largest executed file one filter may contribute, matching the Extension adapter's accepted limit.
 */
const MAX_BASELINE_RESOURCE_BYTES = 64 * 1024 * 1024;

/**
 * Largest total executed content one baseline may carry.
 */
const MAX_BASELINE_AGGREGATE_BYTES = 256 * 1024 * 1024;

/**
 * Largest storage scan the differential accepts.
 *
 * A truncated snapshot would silently corrupt the attribution — files present but unlisted would
 * look newly created by the next add — so a scan beyond this bound is refused, never trimmed.
 */
const MAX_BASELINE_STORAGE_FILES = 4_096;

/**
 * Exact native action this module may ask the isolated installation to perform; the vocabulary
 * lives in the src-owned evidence-route contract.
 */
export type ProxyBlockerBaselineAction = BaselineHostAction;

/**
 * Host boundary this module drives; the production implementation owns spawning and its bounds.
 */
export type ProxyBlockerBaselineHostPort = BaselineHostPort;

/**
 * Exact requested official baseline and the instant it was acquired.
 */
export interface ProxyBlockerBaselineRequest {
    /**
     * Executor the baseline is locked for, recorded in the provenance.
     */
    environment: ExecutorName;

    /**
     * Pinned official catalog IDs, strictly ascending.
     */
    requestedFilterIds: readonly number[];

    /**
     * Deterministic acquisition timestamp recorded in provenance.
     */
    acquiredAt: string;
}

/**
 * Successfully applied and integrity-locked baseline.
 */
export interface ReadyProxyBlockerBaseline {
    /**
     * Discriminator for a locked baseline.
     */
    ready: true;

    /**
     * Exact executed baseline provenance.
     */
    baseline: PublishedBaselineProvenance;
}

/**
 * Baseline preparation stopped by a stable limitation.
 */
export interface LimitedProxyBlockerBaseline {
    /**
     * Discriminator for an unavailable baseline.
     */
    ready: false;

    /**
     * Stable path-free baseline limitation.
     */
    limitation: EnvironmentAdapterLimitation;
}

/**
 * Locked baseline or the stable reason no reproducible baseline exists.
 */
export type ProxyBlockerBaselineResult = ReadyProxyBlockerBaseline | LimitedProxyBlockerBaseline;

/**
 * Finite local reason one baseline preparation was refused.
 *
 * These never cross the public boundary: each maps to one already-defined public limitation code,
 * while the observed facts behind it stay in the local diagnostic log.
 */
const CliBaselineRejection = {
    /**
     * The requested official filter set is not a valid pinned catalog selection.
     */
    RequestedSetInvalid: 'requested_set_invalid',

    /**
     * A requested official filter is absent from the native catalog.
     */
    CatalogRowAbsent: 'catalog_row_absent',

    /**
     * The native catalog listing could not be read.
     */
    FilterListUnreadable: 'filter_list_unreadable',

    /**
     * A requested official filter could not be added from the native catalog.
     */
    AddCommandFailed: 'add_command_failed',

    /**
     * A requested official filter could not be enabled after it was added.
     */
    EnableCommandFailed: 'enable_command_failed',

    /**
     * An unrequested filter could not be disabled.
     */
    DisableCommandFailed: 'disable_command_failed',

    /**
     * The enabled filter set does not equal the requested official set.
     */
    EnabledSetMismatch: 'enabled_set_mismatch',

    /**
     * A requested official filter is not installed after preparation.
     */
    RequestedFilterNotInstalled: 'requested_filter_not_installed',

    /**
     * The isolated installation holds more files than the baseline scan accepts.
     */
    StorageScanUnbounded: 'storage_scan_unbounded',

    /**
     * The executed bytes of a requested filter could not be attributed to it.
     */
    AttributionAmbiguous: 'attribution_ambiguous',

    /**
     * An attributed filter file is not a regular file inside the installation data root.
     */
    ResourceUnsafe: 'resource_unsafe',

    /**
     * The executed filter content exceeds the accepted byte limit.
     */
    ResourceTooLarge: 'resource_too_large',

    /**
     * A filter changed while its executed bytes were locked.
     */
    ResourceChanged: 'resource_changed',
} as const;

/**
 * CliBaselineRejection value.
 */
type CliBaselineRejection = (typeof CliBaselineRejection)[keyof typeof CliBaselineRejection];

/**
 * The public face of one finite local reason: a picklist code and a fixed path-free sentence.
 */
interface BaselineLimitationText {
    /**
     * Already-defined public limitation code this reason collapses to.
     */
    code: EnvironmentAdapterLimitation['code'];

    /**
     * Constant public sentence carrying no path, argv, or native output.
     */
    detail: string;
}

/**
 * Public limitation each finite local reason collapses to.
 */
const BASELINE_LIMITATIONS: Readonly<Record<CliBaselineRejection, BaselineLimitationText>> =
    Object.freeze({
        [CliBaselineRejection.RequestedSetInvalid]: {
            code: EnvironmentAdapterLimitationCode.BaselineManifestInvalid,
            detail: 'The requested official filter set is not a valid pinned catalog selection.',
        },
        [CliBaselineRejection.CatalogRowAbsent]: {
            code: EnvironmentAdapterLimitationCode.BaselineManifestInvalid,
            detail: 'A requested official filter is absent from the native catalog.',
        },
        [CliBaselineRejection.FilterListUnreadable]: {
            code: EnvironmentAdapterLimitationCode.BaselineManifestInvalid,
            detail: 'The native catalog listing could not be read.',
        },
        [CliBaselineRejection.AddCommandFailed]: {
            code: EnvironmentAdapterLimitationCode.BaselineManifestInvalid,
            detail: 'A requested official filter could not be added from the native catalog.',
        },
        [CliBaselineRejection.EnableCommandFailed]: {
            code: EnvironmentAdapterLimitationCode.BaselineManifestInvalid,
            detail: 'A requested official filter could not be enabled after it was added.',
        },
        [CliBaselineRejection.DisableCommandFailed]: {
            code: EnvironmentAdapterLimitationCode.BaselineManifestInvalid,
            detail: 'An unrequested filter could not be disabled.',
        },
        [CliBaselineRejection.EnabledSetMismatch]: {
            code: EnvironmentAdapterLimitationCode.SettingsMismatch,
            detail: 'The enabled filter set does not equal the requested official set.',
        },
        [CliBaselineRejection.RequestedFilterNotInstalled]: {
            code: EnvironmentAdapterLimitationCode.SettingsMismatch,
            detail: 'A requested official filter is not installed after preparation.',
        },
        [CliBaselineRejection.StorageScanUnbounded]: {
            code: EnvironmentAdapterLimitationCode.BaselineIntegrityUnavailable,
            detail: 'The isolated installation holds more files than the baseline scan accepts.',
        },
        [CliBaselineRejection.AttributionAmbiguous]: {
            code: EnvironmentAdapterLimitationCode.BaselineIntegrityUnavailable,
            detail: 'The executed bytes of a requested filter could not be attributed to it.',
        },
        [CliBaselineRejection.ResourceUnsafe]: {
            code: EnvironmentAdapterLimitationCode.BaselineResourceUnsafe,
            detail: 'An attributed filter file is not a regular file inside the installation data root.',
        },
        [CliBaselineRejection.ResourceTooLarge]: {
            code: EnvironmentAdapterLimitationCode.BaselineResourceLimitExceeded,
            detail: 'The executed filter content exceeds the accepted byte limit.',
        },
        [CliBaselineRejection.ResourceChanged]: {
            code: EnvironmentAdapterLimitationCode.BaselineResourceChanged,
            detail: 'A filter changed while its executed bytes were locked.',
        },
    });

/**
 * Every pinned official catalog ID, which is the only set that may reach child arguments.
 */
const PINNED_FILTER_IDS: ReadonlySet<number> = new Set(
    OFFICIAL_ADGUARD_FILTERS.map((filter) => filter.filterId),
);

/**
 * Refusal carrying one finite local reason across the internal call stack.
 */
class BaselineRejectionError extends Error {
    /**
     * Finite local reason behind the refusal.
     */
    readonly reason: CliBaselineRejection;

    constructor(reason: CliBaselineRejection) {
        super(reason);
        this.reason = reason;
    }
}

/**
 * Stop preparation with one finite local reason.
 *
 * @param reason - Finite local reason behind the refusal.
 * @returns Never; always throws.
 */
function reject(reason: CliBaselineRejection): never {
    throw new BaselineRejectionError(reason);
}

/**
 * Preserve one native failure before it collapses into a finite local reason.
 *
 * The refusal that follows carries only its own reason, so without this record the native message
 * behind a refused command or scan would be lost to the run that has to explain it.
 *
 * @param note - Which boundary produced the failure.
 * @param error - Arbitrary value the boundary rejected with.
 */
function recordNativeFailure(note: string, error: unknown): void {
    recordPreflightDiagnostic('published_baseline', {
        note,
        error: describeDiagnosticError(error),
    });
}

/**
 * Check whether the requested set is a valid pinned, deduplicated, ascending selection.
 *
 * @param requestedFilterIds - Exact official IDs the reporter's selection resolved to.
 * @returns Whether the set may be applied without any further interpretation.
 */
function isValidRequestedSet(requestedFilterIds: readonly number[]): boolean {
    return (
        requestedFilterIds.length > 0 &&
        requestedFilterIds.length <= OFFICIAL_ADGUARD_FILTERS.length &&
        requestedFilterIds.every(
            (id, index) =>
                PINNED_FILTER_IDS.has(id) && (index === 0 || requestedFilterIds[index - 1]! < id),
        )
    );
}

/**
 * Read the complete native catalog through the shared list contract.
 *
 * @param host - Bounded command boundary for the isolated installation.
 * @returns Every readable catalog row in displayed order.
 */
async function listCatalogRows(
    host: ProxyBlockerBaselineHostPort,
): Promise<readonly ProxyBlockerCatalogRow[]> {
    let stdout: string;
    try {
        stdout = await host.runBaselineAction('list_all_filters', null);
    } catch (error) {
        recordNativeFailure('list_command_failed', error);
        reject(CliBaselineRejection.FilterListUnreadable);
    }
    return readProxyBlockerFilterList(stdout, (listRejection, observed) => {
        recordPreflightDiagnostic('published_baseline', {
            note: 'filter_list_unreadable',
            listRejection,
            observed,
        });
        reject(CliBaselineRejection.FilterListUnreadable);
    }).rows.filter((row) => row.id > 0);
}

/**
 * Take one complete bounded snapshot of the files the installation currently holds.
 *
 * @param host - Bounded command and storage boundary for the isolated installation.
 * @returns Every absolute path the installation holds.
 */
async function snapshotStorage(host: ProxyBlockerBaselineHostPort): Promise<ReadonlySet<string>> {
    let files: readonly string[];
    try {
        files = await host.listStorageFiles();
    } catch (error) {
        recordNativeFailure('storage_scan_failed', error);
        reject(CliBaselineRejection.StorageScanUnbounded);
    }
    if (files.length > MAX_BASELINE_STORAGE_FILES) {
        reject(CliBaselineRejection.StorageScanUnbounded);
    }
    return new Set(files);
}

/**
 * Test whether a canonical attributed path remains under the canonical data root.
 *
 * @param root - Canonical installation data root.
 * @param target - Canonical attributed path.
 * @returns Whether target is a strict descendant of root.
 */
function isContained(root: string, target: string): boolean {
    const child = nodePath.relative(root, target);
    return (
        child.length > 0 &&
        child !== '..' &&
        !child.startsWith(`..${nodePath.sep}`) &&
        !nodePath.isAbsolute(child)
    );
}

/**
 * Files that appeared under the data root while one filter was being added.
 */
interface BaselineStorageDelta {
    /**
     * Requested official catalog ID whose add ran.
     */
    filterId: number;

    /**
     * Absolute paths present after that add and absent before it.
     */
    created: readonly string[];
}

/**
 * Everything one preparation observed, kept for the local diagnostic record.
 *
 * A finite public code cannot say why an attribution was ambiguous; this record can, because it
 * carries the complete per-add file-set delta the differential actually saw. It is what lets the
 * first licensed run explain the sandbox's real on-disk layout instead of reporting "unknown".
 */
interface BaselinePreparationObservation {
    /**
     * Exact official IDs the run asked for.
     */
    requestedFilterIds: readonly number[];

    /**
     * Catalog rows displayed before any command ran.
     */
    initialRows: readonly ProxyBlockerCatalogRow[] | null;

    /**
     * Catalog rows displayed after the whole application sequence.
     */
    finalRows: readonly ProxyBlockerCatalogRow[] | null;

    /**
     * Files each add created, in application order.
     */
    storageDelta: BaselineStorageDelta[];

    /**
     * Storage file count observed before the first add.
     */
    initialStorageFileCount: number | null;
}

/**
 * One filter's executed file, attributed by what its own add created.
 */
interface AttributedFilterFile {
    /**
     * Requested official catalog ID.
     */
    filterId: number;

    /**
     * Absolute path of the file that add created.
     */
    path: string;

    /**
     * Displayed last-update instant for the filter's final catalog row.
     */
    version: string;
}

/**
 * Apply exactly the requested official set and attribute the bytes each add created.
 *
 * The attribution is a filesystem differential rather than an assumption about the CLI's on-disk
 * layout: the sandbox is agent-owned and idle, and one add runs at a time, so a file that exists
 * after an add and did not exist before it belongs to that add. A file the add merely rewrote was
 * already present, so shared index state is never claimed as any filter's content.
 *
 * @param request - Exact requested official filter IDs and the acquisition timestamp.
 * @param host - Bounded command and storage boundary for the isolated installation.
 * @param observation - Mutable record collecting the facts a refusal would need.
 * @returns Filters bound to the exact file their own add created, and the enabled filters whose
 *   bytes observation could not attribute.
 */
async function applyRequestedBaseline(
    request: ProxyBlockerBaselineRequest,
    host: ProxyBlockerBaselineHostPort,
    observation: BaselinePreparationObservation,
): Promise<{
    /**
     * Every requested filter bound to the file its own add created.
     */
    attributed: readonly AttributedFilterFile[];

    /**
     * Enabled filters whose bytes observation could not attribute.
     */
    unattributed: readonly number[];
}> {
    if (!isValidRequestedSet(request.requestedFilterIds)) {
        reject(CliBaselineRejection.RequestedSetInvalid);
    }
    const requested = new Set(request.requestedFilterIds);

    const initialRows = await listCatalogRows(host);
    observation.initialRows = initialRows;
    for (const filterId of request.requestedFilterIds) {
        if (!initialRows.some((row) => row.id === filterId)) {
            reject(CliBaselineRejection.CatalogRowAbsent);
        }
    }

    // The release activates with filters of its own already installed — Base among them — and an
    // add that only refreshes an existing file attributes nothing. Disabling what the release
    // brought first gives every requested filter the same starting point.
    for (const row of initialRows) {
        if (!row.enabled) {
            continue;
        }
        try {
            await host.runBaselineAction('disable_filter', row.id);
        } catch (error) {
            recordNativeFailure('disable_command_failed', error);
            reject(CliBaselineRejection.DisableCommandFailed);
        }
    }

    let snapshot = await snapshotStorage(host);
    observation.initialStorageFileCount = snapshot.size;
    const createdByFilter = new Map<number, readonly string[]>();
    for (const filterId of request.requestedFilterIds) {
        try {
            await host.runBaselineAction('add_filter', filterId);
        } catch (error) {
            recordNativeFailure('add_command_failed', error);
            reject(CliBaselineRejection.AddCommandFailed);
        }
        const next = await snapshotStorage(host);
        const created = [...next].filter((path) => !snapshot.has(path));
        createdByFilter.set(filterId, created);
        observation.storageDelta.push({ filterId, created });
        snapshot = next;
    }

    // Adding a filter enables it for most of the catalog, but not for all of it: this release
    // installs the Annoyances sub-filters without enabling them. The requested state is what the
    // baseline promises, so it is asserted with the contract's own enable action rather than left
    // to the side effect of an add. The listing is only re-read when something was enabled, so a
    // release that enables on add still runs exactly the commands it did before.
    let reconciliationRows = await listCatalogRows(host);
    let enabledAny = false;
    for (const row of reconciliationRows) {
        if (!requested.has(row.id) || !row.installed || row.enabled) {
            continue;
        }
        try {
            await host.runBaselineAction('enable_filter', row.id);
            enabledAny = true;
        } catch (error) {
            recordNativeFailure('enable_command_failed', error);
            reject(CliBaselineRejection.EnableCommandFailed);
        }
    }
    if (enabledAny) {
        reconciliationRows = await listCatalogRows(host);
    }

    for (const row of reconciliationRows) {
        if (!row.enabled || requested.has(row.id)) {
            continue;
        }
        try {
            await host.runBaselineAction('disable_filter', row.id);
        } catch (error) {
            recordNativeFailure('disable_command_failed', error);
            reject(CliBaselineRejection.DisableCommandFailed);
        }
    }

    const finalRows = await listCatalogRows(host);
    observation.finalRows = finalRows;
    for (const filterId of request.requestedFilterIds) {
        if (!finalRows.some((row) => row.id === filterId && row.installed)) {
            reject(CliBaselineRejection.RequestedFilterNotInstalled);
        }
    }
    // Set equality without ordering: the shared list reader already refuses a duplicate catalog ID,
    // so equal counts plus membership is exactly "the enabled set is the requested set".
    const enabledIds = finalRows.filter((row) => row.enabled).map((row) => row.id);
    if (
        enabledIds.length !== request.requestedFilterIds.length ||
        enabledIds.some((id) => !requested.has(id))
    ) {
        reject(CliBaselineRejection.EnabledSetMismatch);
    }

    // A filter whose add created exactly one file is byte-proven. One that created nothing was
    // already installed by the release, and one that created several cannot be told apart from
    // shared index state — neither can be attributed by observation, and neither is worth failing
    // a run over: the filter is enabled, every phase sees it, and the caller names it as
    // unattributed instead of claiming bytes it cannot prove.
    const attributed: AttributedFilterFile[] = [];
    const unattributed: number[] = [];
    for (const filterId of request.requestedFilterIds) {
        const created = createdByFilter.get(filterId) ?? [];
        if (created.length !== 1) {
            unattributed.push(filterId);
            continue;
        }
        attributed.push({
            filterId,
            path: created[0]!,
            version: finalRows.find((row) => row.id === filterId)!.status,
        });
    }
    return { attributed, unattributed };
}

/**
 * One attributed file whose identity was captured before its bytes were streamed.
 */
interface PreflightAttributedFile extends AttributedFilterFile {
    /**
     * No-follow metadata captured before streaming.
     */
    metadata: BaselineFileMetadata;
}

/**
 * Integrity-lock the attributed bytes and build the shared published-baseline provenance.
 *
 * @param request - Exact requested official filter IDs and the acquisition timestamp.
 * @param attributed - Every requested filter bound to the file its own add created.
 * @param cliDataRoot - Canonical CLI data root the recorded paths stay relative to.
 * @param fileSystem - No-follow filesystem boundary used for byte locking.
 * @param unattributedFilterIds - Enabled filters recorded as unattributed rather than byte-locked.
 * @returns Exact executed baseline provenance.
 */
async function lockAttributedBytes(
    request: ProxyBlockerBaselineRequest,
    attributed: readonly AttributedFilterFile[],
    cliDataRoot: string,
    fileSystem: BaselineFileSystemPort,
    unattributedFilterIds: readonly number[] = [],
): Promise<PublishedBaselineProvenance> {
    const canonicalRoot = await fileSystem.realpath(cliDataRoot);
    const preflight: PreflightAttributedFile[] = [];
    let totalBytes = 0;
    for (const resource of attributed) {
        const metadata = await fileSystem.inspect(resource.path);
        const canonicalPath = await fileSystem.realpath(resource.path);
        if (
            metadata.symbolicLink ||
            !metadata.regular ||
            !isContained(canonicalRoot, canonicalPath)
        ) {
            reject(CliBaselineRejection.ResourceUnsafe);
        }
        totalBytes += metadata.size;
        if (
            metadata.size > MAX_BASELINE_RESOURCE_BYTES ||
            totalBytes > MAX_BASELINE_AGGREGATE_BYTES
        ) {
            reject(CliBaselineRejection.ResourceTooLarge);
        }
        preflight.push({ ...resource, metadata });
    }

    const resources: PublishedBaselineProvenance['resources'] = [];
    for (const resource of preflight) {
        const opened = await fileSystem.openNoFollow(resource.path);
        let sha256: string | null = null;
        let descriptorBefore: BaselineFileMetadata | null = null;
        let descriptorAfter: BaselineFileMetadata | null = null;
        let postflight: BaselineFileMetadata | null = null;
        try {
            descriptorBefore = await opened.stat();
            sha256 = await hashStream(resource.metadata.size, opened);
            descriptorAfter = await opened.stat();
            postflight = await fileSystem.inspect(resource.path);
        } finally {
            await opened.close();
        }
        if (
            !sha256 ||
            !descriptorBefore ||
            !descriptorAfter ||
            !postflight ||
            !sameMetadata(resource.metadata, descriptorBefore) ||
            !sameMetadata(descriptorBefore, descriptorAfter) ||
            !sameMetadata(descriptorAfter, postflight)
        ) {
            reject(CliBaselineRejection.ResourceChanged);
        }
        resources.push({
            listKey: adguardListKey(resource.filterId),
            rulesetId: `flm:${resource.filterId}`,
            path: nodePath.relative(cliDataRoot, resource.path),
            version: resource.version,
            byteCount: resource.metadata.size,
            sha256,
        });
    }
    return v.parse(PublishedBaselineProvenanceSchema, {
        environment: request.environment,
        acquiredAt: request.acquiredAt,
        enabledListKeys: request.requestedFilterIds.map(adguardListKey),
        resources,
        aggregateDigest: createHash('sha256').update(JSON.stringify(resources)).digest('hex'),
        ...(unattributedFilterIds.length > 0
            ? { unattributedListKeys: unattributedFilterIds.map(adguardListKey) }
            : {}),
    });
}

/**
 * Apply and integrity-lock the requested official baseline in the isolated CLI sandbox.
 *
 * Never throws: every internal rejection is returned as a typed limitation, so the caller's cleanup
 * path runs unchanged on every outcome.
 *
 * @param request - Exact requested official filter IDs and the acquisition timestamp.
 * @param host - Bounded command and storage boundary for the isolated installation.
 * @param fileSystem - No-follow filesystem boundary used for byte locking.
 * @returns Locked published baseline provenance or a stable path-free limitation.
 */
export async function prepareProxyBlockerPublishedBaseline(
    request: ProxyBlockerBaselineRequest,
    host: ProxyBlockerBaselineHostPort,
    fileSystem: BaselineFileSystemPort = nodeBaselineFileSystem,
): Promise<ProxyBlockerBaselineResult> {
    const observed: BaselinePreparationObservation = {
        requestedFilterIds: request.requestedFilterIds,
        initialRows: null,
        finalRows: null,
        storageDelta: [],
        initialStorageFileCount: null,
    };
    try {
        const { attributed, unattributed } = await applyRequestedBaseline(request, host, observed);
        const baseline = await lockAttributedBytes(
            request,
            attributed,
            host.cliDataRoot,
            fileSystem,
            unattributed,
        );
        recordPreflightDiagnostic('published_baseline', {
            outcome: 'accepted',
            observed,
            resources: baseline.resources,
            unattributedFilterIds: unattributed,
        });
        return { ready: true, baseline };
    } catch (error) {
        const reason =
            error instanceof BaselineRejectionError
                ? error.reason
                : CliBaselineRejection.AttributionAmbiguous;
        // Recorded before the outcome collapses to a finite code: the per-add file-set delta is the
        // only evidence that can say why an attribution or an applied set was refused.
        recordPreflightDiagnostic('published_baseline', {
            outcome: 'rejected',
            reason,
            observed,
            error: error instanceof BaselineRejectionError ? null : describeDiagnosticError(error),
        });
        const { code, detail } = BASELINE_LIMITATIONS[reason];
        return {
            ready: false,
            limitation: { code, stage: EnvironmentLimitationStage.Baseline, detail },
        };
    }
}
