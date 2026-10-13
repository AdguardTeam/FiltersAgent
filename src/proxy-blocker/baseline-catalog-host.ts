import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OFFICIAL_ADGUARD_FILTERS } from '../environment/official-filter-catalog';
import { CATALOG_STATUS_FORMS } from './catalog-table';
import type {
    ProxyBlockerBaselineAction,
    ProxyBlockerBaselineHostPort,
} from './published-baseline';
import type { DownloadedOfficialFilter } from '../local/official-filter-downloader';

/**
 * Column widths of the native catalog listing this host reproduces.
 */
const ID_WIDTH = 12;
const TITLE_WIDTH = 40;
const STATUS_WIDTH = 19;

/**
 * Pad one date or time component to two decimal digits.
 *
 * @param value - Numeric date or time component.
 * @returns Zero-padded decimal component.
 */
function padTimePart(value: number): string {
    return String(value).padStart(2, '0');
}

/**
 * Render one instant in the exact last-update form the native listing displays.
 *
 * The shared list contract reads an enabled row's status back as `YYYY-MM-DD HH:MM:SS` and nothing
 * else, so an ISO instant written into the column as-is makes every enabled row unreadable — and an
 * unreadable enabled row fails the whole baseline.
 *
 * @param acquiredAt - Acquisition instant in any `Date`-parsable form.
 * @returns Displayed last-update column value, in UTC.
 */
function renderLastUpdate(acquiredAt: string): string {
    const instant = new Date(acquiredAt);
    const date = `${instant.getUTCFullYear()}-${padTimePart(instant.getUTCMonth() + 1)}-${padTimePart(instant.getUTCDate())}`;
    return `${date} ${padTimePart(instant.getUTCHours())}:${padTimePart(instant.getUTCMinutes())}:${padTimePart(instant.getUTCSeconds())}`;
}

/**
 * Render one catalog row exactly as the native listing formats it.
 *
 * @param marker - Enabled checkbox marker.
 * @param id - Catalog identifier.
 * @param title - Catalog title.
 * @param status - Last-update column.
 * @returns Formatted row.
 */
function renderRow(
    marker: '[x]' | '[ ]' | '   ',
    id: number,
    title: string,
    status: string,
): string {
    return `${marker} | ${String(id).padStart(ID_WIDTH)} | ${title.padEnd(TITLE_WIDTH)} ${status.padEnd(STATUS_WIDTH)}`;
}

/**
 * Construction input for the locally backed baseline host.
 */
export interface ProxyBlockerBaselineHostInput {
    /**
     * Data directory the host owns for the files each add creates.
     */
    dataRoot: string;

    /**
     * Filter bytes each official identifier resolves to.
     */
    filters: readonly DownloadedOfficialFilter[];

    /**
     * Acquisition timestamp rendered in the catalog's last-update column.
     */
    acquiredAt: string;
}

/**
 * Baseline host port extended with the reader the AdGuard CLI route reconciles its proxy against.
 */
export interface ProxyBlockerBaselineHost extends ProxyBlockerBaselineHostPort {
    /**
     * Official identifiers currently enabled, ascending.
     *
     * @returns Enabled subset of the installed filters.
     */
    enabledFilterIds(): readonly number[];
}

/**
 * Create the baseline command boundary backed by locally supplied filter files.
 *
 * The published-baseline module is written against a product CLI: it adds a filter, watches the
 * data directory, and binds the file that appeared to the filter that caused it. That works
 * perfectly here — this host writes exactly one file per add, from bytes the run already downloaded
 * and hashed — whereas the real CLI fetches content in the background and never lets an observer
 * see it happen. Same proof, obtained honestly. The data root must be a directory the host owns
 * alone: a pre-existing file with an add's name would silently cost that add its attribution.
 *
 * @param input - Data directory and the filter bytes each identifier resolves to.
 * @returns Baseline host port over local files.
 */
export function createProxyBlockerBaselineHost(
    input: ProxyBlockerBaselineHostInput,
): ProxyBlockerBaselineHost {
    const byId = new Map(input.filters.map((filter) => [filter.filterId, filter]));
    const titles = new Map(
        OFFICIAL_ADGUARD_FILTERS.map((filter) => [filter.filterId, filter.name]),
    );
    const installed = new Set<number>();
    const enabled = new Set<number>();

    return {
        cliDataRoot: input.dataRoot,

        async runBaselineAction(action: ProxyBlockerBaselineAction, filterId: number | null) {
            if (action === 'list_all_filters') {
                const rows = [...titles.entries()]
                    .sort(([left], [right]) => left - right)
                    .map(([id, title]) => {
                        if (enabled.has(id)) {
                            return renderRow('[x]', id, title, renderLastUpdate(input.acquiredAt));
                        }
                        if (installed.has(id)) {
                            return renderRow('[ ]', id, title, CATALOG_STATUS_FORMS.disabled);
                        }
                        return renderRow('   ', id, title, CATALOG_STATUS_FORMS.notAdded);
                    });
                return [
                    `    | ${'ID'.padStart(ID_WIDTH)} | ${'Title'.padEnd(TITLE_WIDTH)} Last update`,
                    'Filters',
                    ...rows,
                    '',
                ].join('\n');
            }
            if (filterId === null) {
                throw new Error('baseline_filter_identity_unpinned');
            }
            if (action === 'add_filter') {
                const filter = byId.get(filterId);
                if (!filter) {
                    throw new Error('baseline_filter_content_unavailable');
                }
                // Byte-for-byte the same normalization the proxy applies to its executed copy, so
                // the attributed digest is the digest of what actually runs.
                await writeFile(
                    join(input.dataRoot, `filter-${filterId}.txt`),
                    filter.content.endsWith('\n') ? filter.content : `${filter.content}\n`,
                    { mode: 0o600 },
                );
                installed.add(filterId);
                enabled.add(filterId);
                return '';
            }
            if (action === 'enable_filter') {
                if (!installed.has(filterId)) {
                    throw new Error('baseline_filter_not_installed');
                }
                enabled.add(filterId);
                return '';
            }
            enabled.delete(filterId);
            return '';
        },

        async listStorageFiles() {
            const entries = await readdir(input.dataRoot, { withFileTypes: true });
            return entries
                .filter((entry) => entry.isFile())
                .map((entry) => join(input.dataRoot, entry.name));
        },

        enabledFilterIds() {
            // oxlint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is outside this target.
            return [...enabled].sort((left, right) => left - right);
        },
    };
}
