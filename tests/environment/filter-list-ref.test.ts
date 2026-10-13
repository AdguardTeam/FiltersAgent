import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
    FilterListRefSchema,
    type FilterListRef,
    adguardListKey,
    officialAdguardListRef,
    parseAdguardListKey,
    requestedListsToRegistryIds,
    sortListKeys,
} from '../../src/environment/filter-list-ref';

describe('adguard list keys', () => {
    it('builds one key per registry id', () => {
        expect(adguardListKey(2)).toBe('adguard:2');
        expect(adguardListKey(14)).toBe('adguard:14');
    });

    it('resolves an adguard key to its registry id', () => {
        expect(parseAdguardListKey('adguard:14')).toBe(14);
    });

    it('rejects an empty and a zero adguard suffix', () => {
        expect(parseAdguardListKey('adguard:')).toBeNull();
        expect(parseAdguardListKey('adguard:0')).toBeNull();
    });

    it('rejects foreign keys and malformed suffixes', () => {
        expect(parseAdguardListKey('ublock:2')).toBeNull();
        expect(parseAdguardListKey('adguard:2x')).toBeNull();
        expect(parseAdguardListKey('adguard:+2')).toBeNull();
        expect(parseAdguardListKey('adguard:2:3')).toBeNull();
        expect(parseAdguardListKey('')).toBeNull();
    });
});

describe('sortListKeys', () => {
    it('returns a lexicographically ascending copy without mutating the input', () => {
        const input = ['adguard:10', 'adguard:2', 'ublock:russia'];

        const sorted = sortListKeys(input);

        expect(sorted).toEqual(['adguard:10', 'adguard:2', 'ublock:russia']);
        expect(input).toEqual(['adguard:10', 'adguard:2', 'ublock:russia']);
    });
});

describe('officialAdguardListRef', () => {
    it('builds the schema-valid ref of a pinned official list', () => {
        const ref = officialAdguardListRef(2);

        expect(v.safeParse(FilterListRefSchema, ref).success).toBe(true);
        expect(ref).toEqual({
            key: 'adguard:2',
            title: 'AdGuard Base filter',
            source: {
                kind: 'url',
                url: 'https://filters.adtidy.org/extension/chromium/filters/2.txt',
            },
            owned: true,
        });
    });

    it('returns null for an id outside the pinned catalog', () => {
        expect(officialAdguardListRef(9999)).toBeNull();
    });
});

describe('requestedListsToRegistryIds', () => {
    it('translates non-ascending refs into ascending registry ids', () => {
        const refs = [
            officialAdguardListRef(2),
            officialAdguardListRef(14),
            officialAdguardListRef(1),
        ] as FilterListRef[];

        expect(requestedListsToRegistryIds(refs)).toEqual([1, 2, 14]);
    });

    it('returns null on the first unresolvable key', () => {
        const refs: FilterListRef[] = [
            officialAdguardListRef(2)!,
            {
                key: 'ublock:1',
                title: 'uBlock Russia list',
                source: { kind: 'url', url: 'https://example.test/ublock.txt' },
                owned: false,
            },
        ];

        expect(requestedListsToRegistryIds(refs)).toBeNull();
    });

    it('returns null for an unresolvable adguard suffix', () => {
        const refs: FilterListRef[] = [
            officialAdguardListRef(2)!,
            {
                key: 'adguard:9999',
                title: 'Unknown AdGuard filter',
                source: { kind: 'url', url: 'https://filters.adtidy.org/x/9999.txt' },
                owned: true,
            },
        ];

        expect(requestedListsToRegistryIds(refs)).toBeNull();
    });
});
