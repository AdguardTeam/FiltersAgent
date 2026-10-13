import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { generatePlacementMap } from '../../src/repo/placement-map';
import {
    FilterListRefSchema,
    FilterListSourceKind,
    LIST_KEY_MAX_COUNT,
    LIST_PATH_MAX_LENGTH,
    officialAdguardListRef,
} from '../../src/environment/filter-list-ref';
import {
    buildListCatalog,
    requestedListsForExecutor,
    type ListCatalog,
    SkippedListReason,
} from '../../src/environment/list-catalog';
import { classifyMissingCatalogFilterId } from '../../src/environment/third-party-filter-catalog';
import type { PlacementMap } from '../../src/types/repo-context';

/**
 * The registry filter id of `Adblock Warning Removal List`: the third-party list the reporter of
 * AdguardFilters #241534 had enabled, which the fail-closed projection refused the whole desktop
 * run on.
 */
const THIRD_PARTY_FILTER_ID = 207;

/**
 * A filter id neither the official catalog nor the third-party registry publishes — in practice a
 * custom subscription the reporter's own product numbered.
 */
const UNKNOWN_FILTER_ID = 9999;

const THIRD_PARTY_URL = 'https://filters.example.org/easylist.txt';
const THIRD_PARTY_KEY = 'third-party:filters.example.org-easylist.txt';
const REPO_FILE_NAME = 'filters.txt';
const OFFICIAL_FILTER_NAME = 'AdGuard Base filter';

const REPOSITORY_MAP_PATHS = ['filters/filters.txt', 'filters/cookies.txt'];
const SECTION_SOURCE_MAP_PATHS = ['Adguard/FrenchFilter/sections/a.txt'];

/**
 * Build an in-memory placement map naming the given checkout-relative paths.
 *
 * @param paths - Checkout-relative `.txt` paths the map's files carry.
 * @returns A placement map with one entry per path.
 */
function placementMapFrom(paths: readonly string[]): PlacementMap {
    return {
        checkoutPath: '/run/checkout',
        generatedAt: '2026-09-09T00:00:00.000Z',
        files: paths.map((relativePath) => ({
            filter: relativePath.slice(0, relativePath.indexOf('/')),
            relativePath,
            sections: [{ name: 'default', startLine: 1, endLine: 1 }],
        })),
    };
}

/**
 * Build a catalog over the repository-map fixture.
 *
 * @param enabledListTexts - Reporter texts, kept minimal unless a case overrides them.
 * @returns The built catalog.
 */
function repositoryCatalog(enabledListTexts: readonly string[]): ListCatalog {
    return buildListCatalog({
        placementMap: placementMapFrom(REPOSITORY_MAP_PATHS),
        enabledListTexts,
    });
}

/**
 * The catalog entries owned by the run's repository, in catalog order.
 *
 * @param catalog - The built catalog.
 * @returns The owned entries.
 */
function ownedEntries(catalog: ListCatalog) {
    return catalog.lists.filter((entry) => entry.owned);
}

/**
 * The catalog entries the reporter enabled from outside the repository, in catalog order.
 *
 * @param catalog - The built catalog.
 * @returns The not-owned entries.
 */
function thirdPartyEntries(catalog: ListCatalog) {
    return catalog.lists.filter((entry) => !entry.owned);
}

describe('buildListCatalog', () => {
    it('marks the repository list files owned and the report URL not owned', () => {
        const catalog = repositoryCatalog([THIRD_PARTY_URL, REPO_FILE_NAME, OFFICIAL_FILTER_NAME]);

        expect(ownedEntries(catalog).map((ref) => ref.source)).toEqual([
            { kind: FilterListSourceKind.RepositoryPath, path: 'filters/cookies.txt' },
            { kind: FilterListSourceKind.RepositoryPath, path: 'filters/filters.txt' },
        ]);
        expect(ownedEntries(catalog).map((ref) => ref.key)).toEqual([
            'repo:filters/cookies.txt',
            'repo:filters/filters.txt',
        ]);
        expect(ownedEntries(catalog).map((ref) => ref.owned)).toEqual([true, true]);
        expect(thirdPartyEntries(catalog).map((ref) => ref.source)).toEqual([
            { kind: FilterListSourceKind.Url, url: THIRD_PARTY_URL },
        ]);
        expect(thirdPartyEntries(catalog).map((ref) => ref.key)).toEqual([THIRD_PARTY_KEY]);
        expect(thirdPartyEntries(catalog).map((ref) => ref.owned)).toEqual([false]);
        expect(ownedEntries(catalog).map((ref) => ref.title)).toEqual([
            'cookies.txt',
            'filters.txt',
        ]);
    });

    it('derives no third-party entry from plain catalog names', () => {
        const catalog = repositoryCatalog([REPO_FILE_NAME, OFFICIAL_FILTER_NAME, '', 'EasyList']);

        expect(thirdPartyEntries(catalog)).toEqual([]);
        expect(ownedEntries(catalog)).toHaveLength(REPOSITORY_MAP_PATHS.length);
    });

    it('deduplicates repeated URLs and stays build-stable across runs', () => {
        const first = repositoryCatalog([THIRD_PARTY_URL, THIRD_PARTY_URL, OFFICIAL_FILTER_NAME]);
        const second = repositoryCatalog([THIRD_PARTY_URL, THIRD_PARTY_URL, OFFICIAL_FILTER_NAME]);

        expect(first).toEqual(second);
        expect(thirdPartyEntries(first)).toHaveLength(1);
        const keys = first.lists.map((ref) => ref.key);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('keeps every emitted entry schema-valid across both fixtures', () => {
        const catalogs = [
            repositoryCatalog([THIRD_PARTY_URL]),
            buildListCatalog({
                placementMap: placementMapFrom(SECTION_SOURCE_MAP_PATHS),
                enabledListTexts: [THIRD_PARTY_URL],
            }),
        ];

        for (const catalog of catalogs) {
            for (const ref of catalog.lists) {
                expect(v.safeParse(FilterListRefSchema, ref).success).toBe(true);
            }
        }
        expect(ownedEntries(catalogs[1]!).map((ref) => ref.source)).toEqual([
            {
                kind: FilterListSourceKind.RepositoryPath,
                path: 'Adguard/FrenchFilter/sections/a.txt',
            },
        ]);
    });

    it('records an over-long repository path as skipped instead of dropping it', () => {
        const overLongPath = `${'a'.repeat(LIST_PATH_MAX_LENGTH)}/list.txt`;
        const catalog = buildListCatalog({
            placementMap: placementMapFrom([overLongPath, ...REPOSITORY_MAP_PATHS]),
            enabledListTexts: [],
        });

        expect(ownedEntries(catalog).map((ref) => ref.source)).toEqual([
            { kind: FilterListSourceKind.RepositoryPath, path: 'filters/cookies.txt' },
            { kind: FilterListSourceKind.RepositoryPath, path: 'filters/filters.txt' },
        ]);
        expect(catalog.skipped).toEqual([
            { reason: SkippedListReason.SchemaInvalid, source: overLongPath },
        ]);
    });

    it('records candidates past the list count bound as skipped', () => {
        const overflowPaths = Array.from(
            { length: LIST_KEY_MAX_COUNT + 1 },
            (_, index) => `list-${index + 1}.txt`,
        );
        const catalog = buildListCatalog({
            placementMap: placementMapFrom(overflowPaths),
            enabledListTexts: [],
        });

        expect(catalog.lists).toHaveLength(LIST_KEY_MAX_COUNT);
        expect(catalog.skipped).toEqual([
            {
                reason: SkippedListReason.CountBound,
                source: [...overflowPaths].sort()[LIST_KEY_MAX_COUNT],
            },
        ]);
    });
});

describe('buildListCatalog: third-party key uniqueness after the length cap', () => {
    it('restores uniqueness with a sha-256 digest when the slug exceeds the cap', () => {
        const longUrl = `https://example.com/${'a'.repeat(150)}.txt`;
        const siblingUrl = `https://example.com/${'a'.repeat(150)}b.txt`;
        const catalog = buildListCatalog({
            placementMap: placementMapFrom([]),
            enabledListTexts: [longUrl, siblingUrl],
        });

        const keys = thirdPartyEntries(catalog).map((ref) => ref.key);
        expect(keys).toHaveLength(2);
        expect(new Set(keys).size).toBe(2);
        for (const ref of catalog.lists) {
            expect(ref.key.length).toBeLessThanOrEqual(128);
            expect(v.safeParse(FilterListRefSchema, ref).success).toBe(true);
        }
    });
});

describe('buildListCatalog: inventory from a real checkout walk', () => {
    it('admits every on-disk list file of a real checkout as an owned entry and skips non-list files', () => {
        const checkout = mkdtempSync(join(tmpdir(), 'list-catalog-checkout-'));
        try {
            mkdirSync(join(checkout, 'filters'), { recursive: true });
            writeFileSync(join(checkout, 'filters', 'filters.txt'), '! Title: main list\n');
            writeFileSync(join(checkout, 'filters', 'cookies.txt'), '! Title: cookie list\n');
            writeFileSync(join(checkout, 'README.md'), '# Not a list file\n');

            const catalog = buildListCatalog({
                placementMap: generatePlacementMap(checkout),
                enabledListTexts: [],
            });

            // AC-1 over the real tree: the map walk admits every committed `.txt` list file, and
            // no non-`.txt` file becomes an entry.
            expect(ownedEntries(catalog).map((ref) => ref.source)).toEqual([
                { kind: FilterListSourceKind.RepositoryPath, path: 'filters/cookies.txt' },
                { kind: FilterListSourceKind.RepositoryPath, path: 'filters/filters.txt' },
            ]);
            expect(JSON.stringify(catalog.lists)).not.toContain('README');
        } finally {
            rmSync(checkout, { recursive: true, force: true });
        }
    });
});

describe('requestedListsForExecutor', () => {
    it('requests exactly one official ref per id, in evidence order', () => {
        const projection = requestedListsForExecutor([2, 14]);

        expect(projection.convergentLists).toEqual([
            officialAdguardListRef(2),
            officialAdguardListRef(14),
        ]);
        expect(projection.convergentLists).toHaveLength(2);
        expect(projection.conflicts).toEqual([]);
    });

    it('keeps the ids the catalog publishes and classifies the ones it does not', () => {
        const projection = requestedListsForExecutor([2, THIRD_PARTY_FILTER_ID, UNKNOWN_FILTER_ID]);

        expect(projection.convergentLists).toEqual([officialAdguardListRef(2)]);
        expect(projection.conflicts).toEqual([
            classifyMissingCatalogFilterId(THIRD_PARTY_FILTER_ID),
            classifyMissingCatalogFilterId(UNKNOWN_FILTER_ID),
        ]);
    });
});
