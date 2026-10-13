import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readProxyBlockerFilterList } from '../../src/proxy-blocker/catalog-table';
import { prepareProxyBlockerPublishedBaseline } from '../../src/proxy-blocker/published-baseline';
import { createProxyBlockerBaselineHost } from '../../src/proxy-blocker/baseline-catalog-host';
import type { DownloadedOfficialFilter } from '../../src/local/official-filter-downloader';

const temporaryRoots: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
});

/**
 * The exact timestamp shape `environmentPorts` hands the host in the live route.
 */
const ACQUIRED_AT = '2026-07-30T21:14:05.123Z';

/**
 * Build one downloaded-filter stub whose digest matches its bytes, as the downloader guarantees.
 *
 * @param filterId - Official catalog identifier.
 * @param content - Complete rule text.
 * @returns Downloaded filter with an honest digest.
 */
function downloadedFilter(filterId: number, content: string): DownloadedOfficialFilter {
    return {
        filterId,
        content,
        sha256: createHash('sha256').update(content).digest('hex'),
        fromCache: false,
    };
}

/**
 * Create the host over a real private data directory, exactly as the evidence route does.
 *
 * @param filters - Filter bytes each identifier resolves to.
 * @returns Host bound to a fresh temporary data root.
 */
async function adguardCliHost(filters: readonly DownloadedOfficialFilter[]) {
    const dataRoot = await mkdtemp(join(tmpdir(), 'adguard-cli-baseline-'));
    temporaryRoots.push(dataRoot);
    return createProxyBlockerBaselineHost({ dataRoot, filters, acquiredAt: ACQUIRED_AT });
}

describe('createProxyBlockerBaselineHost', () => {
    it('prepares a ready byte-attributed baseline through the published-baseline flow', async () => {
        const base = downloadedFilter(2, '! Title: Base\nexample.org##.ad\n');
        const annoyances = downloadedFilter(14, '! Title: Annoyances\nexample.org##.cookie\n');
        const host = await adguardCliHost([base, annoyances]);

        const result = await prepareProxyBlockerPublishedBaseline(
            { environment: 'adguard_cli', requestedFilterIds: [2, 14], acquiredAt: ACQUIRED_AT },
            host,
        );

        expect(result).toMatchObject({ ready: true });
        if (!result.ready) {
            return;
        }
        expect(result.baseline.enabledListKeys).toEqual(['adguard:2', 'adguard:14']);
        expect(result.baseline.unattributedListKeys).toBeUndefined();
        expect(
            result.baseline.resources.map(({ listKey, sha256 }) => ({ listKey, sha256 })),
        ).toEqual([
            { listKey: 'adguard:2', sha256: base.sha256 },
            { listKey: 'adguard:14', sha256: annoyances.sha256 },
        ]);
    });

    it('renders a disabled filter row the shared list contract reads back', async () => {
        const base = downloadedFilter(2, 'example.org##.ad\n');
        const host = await adguardCliHost([base]);
        await host.runBaselineAction('add_filter', 2);
        await host.runBaselineAction('disable_filter', 2);

        const listing = await host.runBaselineAction('list_all_filters', null);
        const reading = readProxyBlockerFilterList(listing, (reason, observed) => {
            throw new Error(`${reason}: ${JSON.stringify(observed)}`);
        });

        expect(reading.rows.find((row) => row.id === 2)).toMatchObject({
            installed: true,
            enabled: false,
        });
    });
});
