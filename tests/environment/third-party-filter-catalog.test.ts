import { describe, expect, it } from 'vitest';
import { KNOWN_THIRD_PARTY_FILTER_NAMES } from '../../src/environment/official-filter-catalog';
import {
    classifyMissingCatalogFilterId,
    THIRD_PARTY_FILTER_CATALOG,
} from '../../src/environment/third-party-filter-catalog';

describe('third-party-filter-catalog', () => {
    it('classifies the reporter filters missing from the MV3 build catalog by registry name', () => {
        // The finish_fix retry-budget failure came from exactly these three IDs.
        expect(classifyMissingCatalogFilterId(122)).toEqual({
            filterId: 122,
            reason: 'third_party_not_in_build_catalog',
            name: "Fanboy's Annoyances",
            subscriptionUrl: 'https://secure.fanboy.co.nz/fanboy-annoyance_ubo.txt',
        });
        expect(classifyMissingCatalogFilterId(207)).toEqual({
            filterId: 207,
            reason: 'third_party_not_in_build_catalog',
            name: 'Adblock Warning Removal List',
            subscriptionUrl: 'https://easylist-downloads.adblockplus.org/antiadblockfilters.txt',
        });
        expect(classifyMissingCatalogFilterId(251)).toEqual({
            filterId: 251,
            reason: 'third_party_not_in_build_catalog',
            name: 'Legitimate URL Shortener',
            subscriptionUrl:
                'https://raw.githubusercontent.com/DandelionSprout/adfilt/master/LegitimateURLShortener.txt',
        });
    });

    it('classifies IDs no AdGuard registry publishes as unknown', () => {
        expect(classifyMissingCatalogFilterId(999999)).toEqual({
            filterId: 999999,
            reason: 'unknown_filter_id',
        });
    });

    it('keeps every pinned name inside the adguard-cli-facing union', () => {
        // The module contract requires the two pinned snapshots to agree on third-party names.
        const knownNames = new Set<string>(KNOWN_THIRD_PARTY_FILTER_NAMES);
        for (const entry of THIRD_PARTY_FILTER_CATALOG) {
            expect(knownNames.has(entry.name), `registry name not pinned: ${entry.name}`).toBe(
                true,
            );
        }
    });

    it('carries a unique numeric ID and a subscription URL for every entry', () => {
        const seen = new Set<number>();
        for (const entry of THIRD_PARTY_FILTER_CATALOG) {
            expect(seen.has(entry.filterId), `duplicate filter ID ${entry.filterId}`).toBe(false);
            seen.add(entry.filterId);
            expect(entry.subscriptionUrl.startsWith('https://')).toBe(true);
        }
    });
});
