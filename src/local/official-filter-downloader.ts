import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    OFFICIAL_ADGUARD_FILTERS,
    OFFICIAL_FILTER_PUBLISHED_URL_TEMPLATE,
} from '../environment/official-filter-catalog';

/**
 * Largest accepted list, well above the biggest published filter.
 */
const MAXIMUM_FILTER_BYTES = 32 * 1024 * 1024;

/**
 * How long a cached copy is reused before it is fetched again.
 */
const CACHE_TTL_MS = 12 * 60 * 60_000;

/**
 * Hard deadline for one list download.
 */
const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * Official identifiers this downloader will fetch.
 */
const PINNED_OFFICIAL_FILTER_IDS: ReadonlySet<number> = new Set(
    OFFICIAL_ADGUARD_FILTERS.map((filter) => filter.filterId),
);

/**
 * Stable path-free failures of the filter downloader.
 */
export type OfficialFilterDownloadFailureCode =
    | 'filter_identity_unpinned'
    | 'filter_unavailable'
    | 'filter_too_large'
    | 'cache_unwritable';

/**
 * Stable non-echoing downloader failure.
 */
export class OfficialFilterDownloadError extends Error {
    /**
     * Create one path-free download failure.
     *
     * @param code - Stable public failure classification.
     */
    constructor(readonly code: OfficialFilterDownloadFailureCode) {
        super(`Official filter download failed: ${code}.`);
        this.name = 'OfficialFilterDownloadError';
    }
}

/**
 * One downloaded official list.
 */
export interface DownloadedOfficialFilter {
    /**
     * Official catalog identifier.
     */
    filterId: number;

    /**
     * Complete rule text.
     */
    content: string;

    /**
     * SHA-256 over the exact bytes, so a run can state what it executed.
     */
    sha256: string;

    /**
     * Whether the copy came from the local cache rather than the network.
     */
    fromCache: boolean;
}

/**
 * Fetch one official filter list, reusing a recent local copy when there is one.
 *
 * Only pinned catalog identifiers are accepted: the identifier originates in a reporter's settings
 * URL, and an unpinned value must never reach a network request.
 *
 * @param filterId - Official catalog identifier.
 * @param cacheDir - Directory holding cached copies.
 * @param fetchImpl - Injectable fetch for deterministic tests.
 * @returns The list text and its digest.
 */
export async function downloadOfficialFilter(
    filterId: number,
    cacheDir: string,
    fetchImpl: typeof fetch = fetch,
): Promise<DownloadedOfficialFilter> {
    if (!PINNED_OFFICIAL_FILTER_IDS.has(filterId)) {
        throw new OfficialFilterDownloadError('filter_identity_unpinned');
    }
    const cachePath = join(cacheDir, `filter-${filterId}.txt`);
    try {
        const metadata = await stat(cachePath);
        if (Date.now() - metadata.mtimeMs < CACHE_TTL_MS) {
            const content = await readFile(cachePath, 'utf8');
            return {
                filterId,
                content,
                sha256: createHash('sha256').update(content).digest('hex'),
                fromCache: true,
            };
        }
    } catch {
        // A missing or unreadable cache entry simply means the list is fetched.
    }

    let response: Response;
    try {
        response = await fetchImpl(
            OFFICIAL_FILTER_PUBLISHED_URL_TEMPLATE.replace('{id}', String(filterId)),
            {
                signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
            },
        );
    } catch {
        throw new OfficialFilterDownloadError('filter_unavailable');
    }
    if (!response.ok) {
        throw new OfficialFilterDownloadError('filter_unavailable');
    }
    const content = await response.text();
    if (content.length > MAXIMUM_FILTER_BYTES) {
        throw new OfficialFilterDownloadError('filter_too_large');
    }
    if (content.trim().length === 0) {
        throw new OfficialFilterDownloadError('filter_unavailable');
    }

    try {
        await mkdir(cacheDir, { recursive: true, mode: 0o700 });
        await writeFile(cachePath, content, { mode: 0o600 });
    } catch {
        throw new OfficialFilterDownloadError('cache_unwritable');
    }
    return {
        filterId,
        content,
        sha256: createHash('sha256').update(content).digest('hex'),
        fromCache: false,
    };
}

/**
 * Result of fetching a batch of official lists.
 */
export interface OfficialFilterDownloadOutcome {
    /**
     * Lists that were obtained, in request order.
     */
    filters: readonly DownloadedOfficialFilter[];

    /**
     * Identifiers whose lists could not be obtained.
     */
    unavailableFilterIds: readonly number[];
}

/**
 * Fetch every requested official list, reporting the ones that could not be obtained.
 *
 * A list the catalog does not publish is a fidelity gap for the caller to record, never a reason to
 * abandon a run: the remaining lists still reproduce most of the reporter's configuration.
 *
 * @param filterIds - Official catalog identifiers.
 * @param cacheDir - Directory holding cached copies.
 * @param fetchImpl - Injectable fetch for deterministic tests.
 * @returns Downloaded lists and the identifiers that failed.
 */
export async function downloadOfficialFilters(
    filterIds: readonly number[],
    cacheDir: string,
    fetchImpl: typeof fetch = fetch,
): Promise<OfficialFilterDownloadOutcome> {
    const filters: DownloadedOfficialFilter[] = [];
    const unavailableFilterIds: number[] = [];
    for (const filterId of filterIds) {
        try {
            filters.push(await downloadOfficialFilter(filterId, cacheDir, fetchImpl));
        } catch {
            unavailableFilterIds.push(filterId);
        }
    }
    return { filters, unavailableFilterIds };
}
