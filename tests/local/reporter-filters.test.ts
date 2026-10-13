import { describe, expect, it } from 'vitest';
import {
    readReporterFilterSelection,
    readReporterOfficialFilterIds,
} from '../../src/local/reporter-filters';

const DESKTOP_URL =
    'https://reports.adguard.com/settings/import.html?product_type=win&product_version=7.22.7' +
    '&filters=1.2.3.4.6.14&scheme_version=2';

describe('readReporterFilterSelection', () => {
    it('reads dot-separated desktop filters from the scheme-2 report URL', () => {
        expect(readReporterFilterSelection(DESKTOP_URL)).toEqual({
            filterIds: [1, 2, 3, 4, 6, 14],
            schemeVersion: '2',
        });
    });

    it('defaults to the desktop scheme and tolerates Markdown-escaped separators', () => {
        const escaped =
            'https://reports.adguard.com/settings/import.html?product_type=mac&amp;filters=2.14.4';
        expect(readReporterFilterSelection(escaped)).toEqual({
            filterIds: [2, 4, 14],
            schemeVersion: '2',
        });
    });

    it('reads a desktop dot-separated list whatever scheme version the report declares', () => {
        // Real AdGuard for Mac reports carry `filters` under scheme_version=3; keying the format
        // off the scheme number made every one of them parse as having no filters.
        const url =
            'https://reports.adguard.com/settings/import.html?product_type=mac' +
            '&filters=1.2.3.4.11.17.18.19.20.21.22&scheme_version=3';

        expect(readReporterFilterSelection(url)).toEqual({
            filterIds: [1, 2, 3, 4, 11, 17, 18, 19, 20, 21, 22],
            schemeVersion: '3',
        });
    });

    it('refuses a report that declares both desktop and extension filter parameters', () => {
        const url =
            'https://reports.adguard.com/settings/import.html?filters=1.2' +
            '&regular_filters=3.4&scheme_version=3';

        expect(readReporterFilterSelection(url)).toBeNull();
    });

    it('reads extension schemes from regular_filters with their own separators', () => {
        const scheme3 =
            'https://reports.adguard.com/settings/import.html?regular_filters=2.3&scheme_version=3';
        const scheme4 =
            'https://reports.adguard.com/settings/import.html?regular_filters=2,3&scheme_version=4';
        expect(readReporterFilterSelection(scheme3)?.filterIds).toEqual([2, 3]);
        expect(readReporterFilterSelection(scheme4)?.filterIds).toEqual([2, 3]);
    });

    it('returns null instead of throwing for absent, untrusted, or malformed input', () => {
        expect(readReporterFilterSelection(undefined)).toBeNull();
        expect(readReporterFilterSelection('not a url')).toBeNull();
        expect(
            readReporterFilterSelection(
                'http://reports.adguard.com/settings/import.html?filters=2',
            ),
        ).toBeNull();
        expect(
            readReporterFilterSelection('https://evil.example/settings/import.html?filters=2'),
        ).toBeNull();
        expect(
            readReporterFilterSelection(
                'https://reports.adguard.com/settings/import.html?filters=2.abc',
            ),
        ).toBeNull();
        expect(
            readReporterFilterSelection(
                'https://reports.adguard.com/settings/import.html?filters=2.-3',
            ),
        ).toBeNull();
        expect(
            readReporterFilterSelection('https://reports.adguard.com/settings/import.html'),
        ).toBeNull();
    });

    it('rejects an unsupported scheme version and an oversized selection', () => {
        expect(
            readReporterFilterSelection(
                'https://reports.adguard.com/settings/import.html?filters=2&scheme_version=9',
            ),
        ).toBeNull();
        const oversized = Array.from({ length: 65 }, (_, index) => index + 1).join('.');
        expect(
            readReporterFilterSelection(
                `https://reports.adguard.com/settings/import.html?filters=${oversized}`,
            ),
        ).toBeNull();
    });
});

describe('readReporterOfficialFilterIds', () => {
    it('takes the settings link when the report carries one, expanding combined filters', () => {
        expect(
            readReporterOfficialFilterIds({
                settingsImportUrl: DESKTOP_URL,
                enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
            }),
        ).toEqual([1, 2, 3, 4, 6, 18, 19, 20, 21, 22]);
    });

    it('falls back to the filters the report names when it has no settings link', () => {
        // An iOS report has no settings link; without this fallback the CLI route runs AdGuard
        // Base alone and cannot find the Cookie Notices rule the candidate edits.
        expect(
            readReporterOfficialFilterIds({
                enabledFilters: [
                    { name: 'AdGuard Base filter', officialFilterId: 2 },
                    { name: 'AdGuard Annoyances filter', officialFilterId: 14 },
                    { name: 'Some custom list' },
                ],
            }),
        ).toEqual([2, 18, 19, 20, 21, 22]);
        expect(readReporterOfficialFilterIds({ enabledFilters: [] })).toEqual([]);
    });
});
