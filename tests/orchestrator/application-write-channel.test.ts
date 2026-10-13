import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { buildExtensionSettingsPayload } from '../../src/orchestrator/application-write-channel';

/**
 * A real-shaped AdGuard settings export: every top-level section a genuine export carries, with
 * values distinct from what the tests below request, so a survived value proves the section was
 * left alone rather than coincidentally matching what was requested.
 */
const REAL_SHAPED_EXPORT = {
    'protocol-version': '1.0',
    'general-settings': {
        'app-language': 'en',
        'allow-acceptable-ads': true,
        'show-blocked-ads-count': false,
        'autodetect-filters': true,
        'safebrowsing-enabled': false,
        'filters-update-period': -1,
    },
    'extension-specific-settings': {
        'use-optimized-filters': false,
        'collect-hits-count': false,
        'show-context-menu': true,
        'show-info-about-adguard': false,
    },
    filters: {
        'enabled-filters': [1, 14],
        'enabled-groups': [0],
        'custom-filters': [],
        'user-filter': { enabled: true },
        whitelist: { enabled: true, domains: [], inverted: false },
    },
    stealth: {
        'stealth-disable-stealth-mode': false,
        'stealth-hide-referrer': true,
        'stealth-hide-search-queries': true,
        'stealth-send-do-not-track': true,
        'stealth-block-webrtc': false,
        'stealth-block-third-party-cookies': true,
        'stealth-block-third-party-cookies-time': 2_880,
    },
};

/**
 * Build a fake page whose evaluate answers `loadSettingsJson` with the given export content and
 * refuses every other message, so a mistaken message type fails the schema parse rather than
 * silently returning something that happens to work.
 *
 * @param exportContent - The JSON string the fake `loadSettingsJson` response carries.
 * @returns The fake page.
 */
function fakeSettingsPage(exportContent: string): Page {
    return {
        evaluate: vi.fn(async (_fn: unknown, arg: Record<string, unknown>) =>
            arg['type'] === 'loadSettingsJson' ? { content: exportContent } : true,
        ),
    } as unknown as Page;
}

describe('buildExtensionSettingsPayload', () => {
    it('waits for the background listener before reading the export', async () => {
        // Right after launch the options page is up before the background's message handlers
        // are; a live run lost its prepared launch to the first message landing in
        // that window.
        let calls = 0;
        const page = {
            evaluate: vi.fn(async (_fn: unknown, arg: Record<string, unknown>) => {
                calls += 1;
                if (calls <= 2) {
                    throw new Error(
                        'Could not establish connection. Receiving end does not exist.',
                    );
                }
                return arg['type'] === 'loadSettingsJson'
                    ? { content: JSON.stringify(REAL_SHAPED_EXPORT) }
                    : true;
            }),
        } as unknown as Page;

        const payload = JSON.parse(
            await buildExtensionSettingsPayload(page, {
                enabledFilterIds: [2],
                requiredGroupIds: [],
            }),
        ) as Record<string, unknown>;

        expect(calls).toBeGreaterThan(2);
        expect(payload['filters']).toMatchObject({ 'enabled-filters': [2] });
    });

    it('changes exactly filters, groups, Acceptable Ads and stealth and leaves the rest alone', async () => {
        const page = fakeSettingsPage(JSON.stringify(REAL_SHAPED_EXPORT));

        const payload = await buildExtensionSettingsPayload(page, {
            enabledFilterIds: [2, 3],
            requiredGroupIds: [1],
            stealthEnabled: true,
        });

        const root = JSON.parse(payload) as Record<string, unknown>;
        expect(root['protocol-version']).toEqual(REAL_SHAPED_EXPORT['protocol-version']);
        expect(root['general-settings']).toEqual({
            ...REAL_SHAPED_EXPORT['general-settings'],
            // The one general setting the payload owns: filter 10 is not expected here.
            'allow-acceptable-ads': false,
        });
        expect(root['extension-specific-settings']).toEqual(
            REAL_SHAPED_EXPORT['extension-specific-settings'],
        );
        const filters = root['filters'] as Record<string, unknown>;
        expect(filters['enabled-filters']).toEqual([2, 3]);
        // The export's own pre-existing group (0) survives the merge alongside the newly required
        // one (1): the payload adds groups, it never replaces the set.
        expect(filters['enabled-groups']).toEqual(expect.arrayContaining([0, 1]));
        expect((filters['enabled-groups'] as number[]).length).toBe(2);
        expect(filters['custom-filters']).toEqual(REAL_SHAPED_EXPORT.filters['custom-filters']);
        expect(filters['user-filter']).toEqual(REAL_SHAPED_EXPORT.filters['user-filter']);
        expect(filters['whitelist']).toEqual(REAL_SHAPED_EXPORT.filters['whitelist']);
        const stealth = root['stealth'] as Record<string, unknown>;
        expect(stealth['stealth-disable-stealth-mode']).toBe(false);
        for (const [key, value] of Object.entries(REAL_SHAPED_EXPORT.stealth)) {
            if (key === 'stealth-disable-stealth-mode') {
                continue;
            }
            expect(stealth[key]).toEqual(value);
        }
    });

    it('merges required groups into the export without dropping the ones already enabled', async () => {
        const page = fakeSettingsPage(JSON.stringify(REAL_SHAPED_EXPORT));

        const payload = await buildExtensionSettingsPayload(page, {
            enabledFilterIds: [2],
            // Requesting a group the export already carries must not duplicate it.
            requiredGroupIds: [0],
        });

        const filters = (JSON.parse(payload) as { filters: { 'enabled-groups': number[] } })
            .filters;
        expect(filters['enabled-groups']).toEqual([0]);
    });

    it('leaves the stealth section untouched when no Tracking-protection state is expected', async () => {
        const page = fakeSettingsPage(JSON.stringify(REAL_SHAPED_EXPORT));

        const payload = await buildExtensionSettingsPayload(page, {
            enabledFilterIds: [2],
            requiredGroupIds: [],
        });

        expect((JSON.parse(payload) as { stealth: unknown }).stealth).toEqual(
            REAL_SHAPED_EXPORT.stealth,
        );
    });

    it('throws when Tracking protection must be enabled but the export carries no stealth section', async () => {
        const { stealth: _stealth, ...withoutStealth } = REAL_SHAPED_EXPORT;
        const page = fakeSettingsPage(JSON.stringify(withoutStealth));

        await expect(
            buildExtensionSettingsPayload(page, {
                enabledFilterIds: [2],
                requiredGroupIds: [],
                stealthEnabled: true,
            }),
        ).rejects.toThrow(/stealth/);
    });

    it('does not throw when Tracking protection must be disabled and the export carries no stealth section', async () => {
        const { stealth: _stealth, ...withoutStealth } = REAL_SHAPED_EXPORT;
        const page = fakeSettingsPage(JSON.stringify(withoutStealth));

        const payload = await buildExtensionSettingsPayload(page, {
            enabledFilterIds: [2],
            requiredGroupIds: [],
            stealthEnabled: false,
        });

        expect(JSON.parse(payload)).not.toHaveProperty('stealth');
    });

    it('throws when the export carries no filters section', async () => {
        const page = fakeSettingsPage(JSON.stringify({ 'protocol-version': '1.0' }));

        await expect(
            buildExtensionSettingsPayload(page, {
                enabledFilterIds: [2],
                requiredGroupIds: [],
            }),
        ).rejects.toThrow(/filters/);
    });

    it('throws when the export does not parse as a JSON object', async () => {
        const page = fakeSettingsPage('not json');

        await expect(
            buildExtensionSettingsPayload(page, {
                enabledFilterIds: [2],
                requiredGroupIds: [],
            }),
        ).rejects.toThrow();
    });
});

describe('the Acceptable Ads switch of the settings payload', () => {
    it('turns the switch off when the search-ads filter is not expected', async () => {
        // The live defect: the export carried the switch on, the import answered true, and the
        // read-back observed [2, 3, 10] against the prepared [2, 3].
        const page = fakeSettingsPage(JSON.stringify(REAL_SHAPED_EXPORT));

        const payload = await buildExtensionSettingsPayload(page, {
            enabledFilterIds: [2, 3],
            requiredGroupIds: [],
        });

        const general = (JSON.parse(payload) as Record<string, Record<string, unknown>>)[
            'general-settings'
        ];
        expect(general?.['allow-acceptable-ads']).toBe(false);
    });

    it('turns the switch on when the search-ads filter is expected', async () => {
        const page = fakeSettingsPage(
            JSON.stringify({
                ...REAL_SHAPED_EXPORT,
                'general-settings': {
                    ...REAL_SHAPED_EXPORT['general-settings'],
                    'allow-acceptable-ads': false,
                },
            }),
        );

        const payload = await buildExtensionSettingsPayload(page, {
            enabledFilterIds: [2, 10],
            requiredGroupIds: [],
        });

        const general = (JSON.parse(payload) as Record<string, Record<string, unknown>>)[
            'general-settings'
        ];
        expect(general?.['allow-acceptable-ads']).toBe(true);
    });

    it('throws when the export carries no general-settings section to set the switch in', async () => {
        const { 'general-settings': _general, ...withoutGeneral } = REAL_SHAPED_EXPORT;
        const page = fakeSettingsPage(JSON.stringify(withoutGeneral));

        await expect(
            buildExtensionSettingsPayload(page, {
                enabledFilterIds: [2],
                requiredGroupIds: [],
            }),
        ).rejects.toThrow(/general-settings/);
    });
});

describe('the custom filters of the settings payload', () => {
    /**
     * An export whose custom-filters group is off and whose own custom filter differs from the one
     * requested, so the payload proves it replaced the section and switched the group on itself.
     */
    const exportWithStaleCustomFilter = {
        ...REAL_SHAPED_EXPORT,
        filters: {
            ...REAL_SHAPED_EXPORT.filters,
            'enabled-groups': [2],
            'custom-filters': [
                { customUrl: 'http://127.0.0.1:1/stale.txt', trusted: false, enabled: true },
            ],
        },
    };

    const sliceFilter = {
        customUrl: 'http://127.0.0.1:41234/slice-14.txt',
        title: 'EasyList Hebrew lines 1-900 of 1766',
        trusted: true,
        enabled: true,
    };

    it('writes the custom filters and switches their group on beside the required groups', async () => {
        const page = fakeSettingsPage(JSON.stringify(exportWithStaleCustomFilter));

        const payload = await buildExtensionSettingsPayload(page, {
            enabledFilterIds: [2],
            requiredGroupIds: [1],
            customFilters: [sliceFilter],
        });

        const filters = (JSON.parse(payload) as Record<string, Record<string, unknown>>)[
            'filters'
        ]!;
        // The export's own custom filter is gone: the section is exactly what was requested.
        expect(filters['custom-filters']).toEqual([sliceFilter]);
        // Without group 0 the build installs the custom filter and leaves it inert.
        expect(filters['enabled-groups']).toEqual(expect.arrayContaining([0, 1, 2]));
        expect((filters['enabled-groups'] as number[]).length).toBe(3);
        expect(filters['enabled-filters']).toEqual([2]);
    });

    it('empties the custom filters without switching their group on when none is requested', async () => {
        const page = fakeSettingsPage(JSON.stringify(exportWithStaleCustomFilter));

        const payload = await buildExtensionSettingsPayload(page, {
            enabledFilterIds: [2],
            requiredGroupIds: [1],
            customFilters: [],
        });

        const filters = (JSON.parse(payload) as Record<string, Record<string, unknown>>)[
            'filters'
        ]!;
        expect(filters['custom-filters']).toEqual([]);
        expect(filters['enabled-groups']).toEqual(expect.arrayContaining([1, 2]));
        expect((filters['enabled-groups'] as number[]).length).toBe(2);
    });
});
