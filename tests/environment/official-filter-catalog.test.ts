import * as v from 'valibot';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    ExecutableFilterDecisionSchema,
    KNOWN_THIRD_PARTY_FILTER_NAMES,
    LEGACY_THIRD_PARTY_FILTER_ALIASES,
    decideExecutableFilters,
    type ExecutableFilterDecision,
} from '../../src/environment/official-filter-catalog';
import type { ReportedFilter } from '../../src/types/issue-facts';

const fetchSpy = vi.fn();

beforeAll(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
        fetchSpy as unknown as typeof globalThis.fetch,
    );
});

afterAll(() => {
    vi.restoreAllMocks();
});

/**
 * Reported lists the extraction left without an official id.
 *
 * @param names - Reported list texts.
 * @returns The lists as the report carries them.
 */
function named(...names: string[]): ReportedFilter[] {
    return names.map((name) => ({ name }));
}

/**
 * The reported Base filter, as the extraction identifies it.
 */
const BASE_FILTER: ReportedFilter = { name: 'AdGuard Base filter', officialFilterId: 2 };

const cases: Array<[string, readonly ReportedFilter[], ExecutableFilterDecision]> = [
    [
        'runs the official lists the extraction identified, deduped and ascending by catalog id',
        [
            BASE_FILTER,
            { name: 'AdGuard Russian filter', officialFilterId: 1 },
            { name: 'adguard base filter  ', officialFilterId: 2 },
        ],
        {
            status: 'executable',
            officialFilters: [
                {
                    filterId: 1,
                    listKey: 'adguard:1',
                    name: 'AdGuard Russian filter',
                    reportedName: 'AdGuard Russian filter',
                },
                {
                    filterId: 2,
                    listKey: 'adguard:2',
                    name: 'AdGuard Base filter',
                    reportedName: 'AdGuard Base filter',
                },
            ],
            skippedSources: [],
        },
    ],
    [
        'keeps the name the report used beside the catalog name its id stands for',
        [
            { name: 'AdGuard Base filter v2.0.54.62,', officialFilterId: 2 },
            { name: 'Фильтр AdGuard Русский', officialFilterId: 1 },
        ],
        {
            status: 'executable',
            officialFilters: [
                {
                    filterId: 1,
                    listKey: 'adguard:1',
                    name: 'AdGuard Russian filter',
                    reportedName: 'Фильтр AdGuard Русский',
                },
                {
                    filterId: 2,
                    listKey: 'adguard:2',
                    name: 'AdGuard Base filter',
                    reportedName: 'AdGuard Base filter v2.0.54.62,',
                },
            ],
            skippedSources: [],
        },
    ],
    [
        'reports a missing selection when nothing was reported',
        [],
        {
            status: 'not_executable',
            code: 'filter_selection_missing',
            skippedSources: [],
        },
    ],
    [
        'reports a missing selection when every reported entry is blank',
        named('', '  '),
        {
            status: 'not_executable',
            code: 'filter_selection_missing',
            skippedSources: [],
        },
    ],
    [
        'runs the official filters that resolved and records a name neither catalog knows',
        [BASE_FILTER, ...named('Youtube - remove shorts (url: none)')],
        {
            status: 'executable',
            officialFilters: [
                {
                    filterId: 2,
                    listKey: 'adguard:2',
                    name: 'AdGuard Base filter',
                    reportedName: 'AdGuard Base filter',
                },
            ],
            skippedSources: [
                { kind: 'unresolved_name', reportedName: 'Youtube - remove shorts (url: none)' },
            ],
        },
    ],
    [
        'reports no official baseline when no entry carries an official id',
        named('My own list'),
        {
            status: 'not_executable',
            code: 'no_official_filter_baseline',
            skippedSources: [{ kind: 'unresolved_name', reportedName: 'My own list' }],
        },
    ],
    [
        'keeps only official identities and records every skipped source',
        [BASE_FILTER, ...named('EasyList', "Fanboy's Annoyances", 'https://example.test/my.txt')],
        {
            status: 'executable',
            officialFilters: [
                {
                    filterId: 2,
                    listKey: 'adguard:2',
                    name: 'AdGuard Base filter',
                    reportedName: 'AdGuard Base filter',
                },
            ],
            skippedSources: [
                { kind: 'third_party_catalog', reportedName: 'EasyList' },
                { kind: 'third_party_catalog', reportedName: "Fanboy's Annoyances" },
                { kind: 'custom_subscription', reportedName: 'https://example.test/my.txt' },
            ],
        },
    ],
    [
        'skips a known third-party list that only the extension catalog carries',
        [BASE_FILTER, ...named('uBlock Origin – Block Outsider Intrusion into LAN')],
        {
            status: 'executable',
            officialFilters: [
                {
                    filterId: 2,
                    listKey: 'adguard:2',
                    name: 'AdGuard Base filter',
                    reportedName: 'AdGuard Base filter',
                },
            ],
            skippedSources: [
                {
                    kind: 'third_party_catalog',
                    reportedName: 'uBlock Origin – Block Outsider Intrusion into LAN',
                },
            ],
        },
    ],
    [
        'classifies a list upstream renamed as the skipped third-party source it still is',
        [BASE_FILTER, ...named('List-KR')],
        {
            status: 'executable',
            officialFilters: [
                {
                    filterId: 2,
                    listKey: 'adguard:2',
                    name: 'AdGuard Base filter',
                    reportedName: 'AdGuard Base filter',
                },
            ],
            skippedSources: [{ kind: 'third_party_catalog', reportedName: 'List-KR' }],
        },
    ],
    [
        'reports no official baseline for a renamed third-party list on its own',
        named('List-KR'),
        {
            status: 'not_executable',
            code: 'no_official_filter_baseline',
            skippedSources: [{ kind: 'third_party_catalog', reportedName: 'List-KR' }],
        },
    ],
    [
        'reports no official baseline when nothing official survives classification',
        named('EasyPrivacy', 'https://example.test/my.txt'),
        {
            status: 'not_executable',
            code: 'no_official_filter_baseline',
            skippedSources: [
                { kind: 'third_party_catalog', reportedName: 'EasyPrivacy' },
                { kind: 'custom_subscription', reportedName: 'https://example.test/my.txt' },
            ],
        },
    ],
];

describe('decideExecutableFilters', () => {
    it.each(cases)('%s', (_name, reported, expected) => {
        const decision = decideExecutableFilters(reported);

        expect(decision).toEqual(expected);
        expect(v.parse(ExecutableFilterDecisionSchema, decision)).toEqual(expected);
    });

    it('reproduces the deprecated combined Annoyances filter through its component lists', () => {
        // An iOS report names filter 14, which the MV3 extension build does not ship; without its
        // component lists the run could not check a Cookie Notices rule.
        const decision = decideExecutableFilters([
            BASE_FILTER,
            { name: 'AdGuard Annoyances filter', officialFilterId: 14 },
            { name: 'AdGuard Popups filter', officialFilterId: 19 },
        ]);

        expect(decision).toMatchObject({ status: 'executable' });
        if (decision.status !== 'executable') {
            return;
        }
        expect(decision.officialFilters.map((filter) => filter.filterId)).toEqual([
            2, 18, 19, 20, 21, 22,
        ]);
        expect(decision.officialFilters[1]).toEqual({
            filterId: 18,
            listKey: 'adguard:18',
            name: 'AdGuard Cookie Notices filter',
            reportedName: 'AdGuard Annoyances filter',
        });
    });

    it('still classifies a selection far larger than the evidence it can record', () => {
        const unknownNames = Array.from({ length: 200 }, (_, index) => `Unknown filter ${index}`);
        const customUrls = Array.from(
            { length: 200 },
            (_, index) => `https://example.test/${index}.txt`,
        );

        const unresolvable = decideExecutableFilters(named(...unknownNames, ...customUrls));
        expect(unresolvable).toMatchObject({
            status: 'not_executable',
            code: 'no_official_filter_baseline',
            skippedSources: expect.arrayContaining([
                { kind: 'unresolved_name', reportedName: 'Unknown filter 0' },
            ]),
        });
        expect(v.parse(ExecutableFilterDecisionSchema, unresolvable)).toEqual(unresolvable);

        const executable = decideExecutableFilters([BASE_FILTER, ...named(...customUrls)]);
        expect(executable).toMatchObject({
            status: 'executable',
            officialFilters: [
                {
                    filterId: 2,
                    listKey: 'adguard:2',
                    name: 'AdGuard Base filter',
                    reportedName: 'AdGuard Base filter',
                },
            ],
        });
        expect(v.parse(ExecutableFilterDecisionSchema, executable)).toEqual(executable);
    });

    it('keeps every legacy alias incapable of widening the executed baseline', () => {
        for (const [alias, target] of LEGACY_THIRD_PARTY_FILTER_ALIASES) {
            expect(KNOWN_THIRD_PARTY_FILTER_NAMES).toContain(target);
            expect(decideExecutableFilters(named(alias))).toMatchObject({
                status: 'not_executable',
                code: 'no_official_filter_baseline',
                skippedSources: [{ kind: 'third_party_catalog' }],
            });
        }
    });

    it('never contacts a skipped or official filter source', () => {
        for (const [, reported] of cases) {
            decideExecutableFilters(reported);
        }

        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
