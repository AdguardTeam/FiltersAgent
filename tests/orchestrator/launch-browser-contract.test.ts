import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { ExtensionLaunchFamily } from '../../src/environment/extension-launch';
import { ExtensionManifestVersion } from '../../src/environment/extension-preparation';
import { PreparedExtensionSource } from '../../src/environment/extension-preparation';
import type { PreparedExtension } from '../../src/local/prepared-extension';
import {
    launchBrowserAdvertisement,
    launchBrowserRefusal,
    launchBrowserRequestSchema,
} from '../../src/orchestrator/launch-browser-arguments';
import { ConsentStrategy, Viewport } from '../../src/types/repro-profile';
import { SettingsProfileKind } from '../../src/types/settings-profile-kind';
import { toAdvertisedSchema } from '../../src/pi/tool-schema';

/**
 * The contract under test: the schema the model is shown for `launch_browser` and the schema the
 * runtime validates against must agree. The first live uBO run met both halves of a disagreement —
 * one call refused with `Expected "settings" but received undefined`, a later one with `Expected
 * never but received "settings"` — and never launched a browser.
 */

const TARGET_URL = 'https://example.test/article';

/**
 * The browser profile every accepted request carries.
 */
const PROFILE = {
    viewport: Viewport.Desktop,
    locale: 'en-US',
    timezone: 'UTC',
    consentStrategy: ConsentStrategy.Untouched,
};

/**
 * A Firefox-family prepared build: an XPI force-installed through enterprise policies, whose
 * managed-storage declaration is the run's whole filter baseline.
 *
 * @returns The prepared build a Firefox-family run carries.
 */
function firefoxPrepared(): PreparedExtension {
    return {
        launchFamily: ExtensionLaunchFamily.Firefox,
        source: PreparedExtensionSource.PinnedRelease,
        extensionId: 'uBlock0@raymondhill.net',
        xpiPath: '/run/ubo.xpi',
        extensionSourceSha256: 'a'.repeat(64),
        managedStorageTemplate: { adminSettings: { selectedFilterLists: ['user-filters'] } },
        userFiltersKeyPath: ['adminSettings', 'userFilters'],
    } as unknown as PreparedExtension;
}

/**
 * A Chromium-family prepared build, whose settings the host writes and reads back.
 *
 * @returns The prepared build a Chromium-line run carries.
 */
function chromiumPrepared(): PreparedExtension {
    return {
        launchFamily: ExtensionLaunchFamily.Chromium,
        source: PreparedExtensionSource.PinnedRelease,
        extensionPath: '/run/extension',
        manifestVersion: ExtensionManifestVersion.Mv3,
        extensionSourceSha256: 'b'.repeat(64),
    } as unknown as PreparedExtension;
}

/**
 * A slice of one selected list: the in-list bisection request a Chromium run takes.
 */
const SLICE_SETTINGS = {
    kind: SettingsProfileKind.AgentSelected,
    filterIds: [2, 108],
    stealthEnabled: false,
    slice: { filterId: 108, firstLine: 1, lastLine: 900 },
};

/**
 * Advertised top-level property names the model is shown for one run.
 *
 * @param prepared - The run's prepared build.
 * @returns The advertised property names.
 */
function advertisedProperties(prepared: PreparedExtension): string[] {
    const advertised = toAdvertisedSchema(
        launchBrowserAdvertisement(prepared).parameters,
        'launch_browser',
    );
    return Object.keys((advertised['properties'] ?? {}) as Record<string, unknown>);
}

/**
 * The advertised `settings` property names, as the JSON Schema the providers render it into.
 *
 * @param prepared - The run's prepared build.
 * @returns The property names the model is shown under `settings`.
 */
function advertisedSettingsProperties(prepared: PreparedExtension): string[] {
    const advertised = toAdvertisedSchema(
        launchBrowserAdvertisement(prepared).parameters,
        'launch_browser',
    ) as {
        properties?: { settings?: { properties?: Record<string, unknown> } };
    };
    return Object.keys(advertised.properties?.settings?.properties ?? {});
}

describe('launch_browser on a Firefox-family run', () => {
    it('accepts a prepared launch that carries no settings', () => {
        const parsed = v.safeParse(launchBrowserRequestSchema(firefoxPrepared()), {
            extension: 'prepared',
            targetUrl: TARGET_URL,
            profile: PROFILE,
        });

        expect(parsed.success).toBe(true);
    });

    it('refuses a prepared launch that carries settings, naming the declared baseline', () => {
        const prepared = firefoxPrepared();
        const parsed = v.safeParse(launchBrowserRequestSchema(prepared), {
            extension: 'prepared',
            targetUrl: TARGET_URL,
            profile: PROFILE,
            settings: {
                kind: SettingsProfileKind.AgentSelected,
                filterIds: [2],
                stealthEnabled: false,
            },
        });
        if (parsed.success) {
            throw new Error('a Firefox-family run must not accept model-selected settings');
        }

        const refusal = launchBrowserRefusal(prepared, parsed.issues);
        expect(refusal).toContain('no "settings"');
        expect(refusal).toContain('declared list selection');
        // The refusal must not offer the shapes this run cannot take.
        expect(refusal).not.toContain(SettingsProfileKind.AgentSelected);
    });

    it('shows the model no settings property at all', () => {
        expect(advertisedProperties(firefoxPrepared())).not.toContain('settings');
        expect(advertisedProperties(firefoxPrepared())).toContain('profile');
    });

    it('keeps refusing settings when they carry a list slice', () => {
        // A slice replaces one selected list by a custom filter the host imports; a Firefox-family
        // build has no settings surface to import into, so the whole settings object stays refused.
        const prepared = firefoxPrepared();
        const parsed = v.safeParse(launchBrowserRequestSchema(prepared), {
            extension: 'prepared',
            targetUrl: TARGET_URL,
            profile: PROFILE,
            settings: SLICE_SETTINGS,
        });
        if (parsed.success) {
            throw new Error('a Firefox-family run must not accept a list slice');
        }

        expect(launchBrowserRefusal(prepared, parsed.issues)).toContain('no "settings"');
    });
});

describe('launch_browser on a Chromium-line run', () => {
    it('still requires the model to select settings for a prepared launch', () => {
        const prepared = chromiumPrepared();
        const parsed = v.safeParse(launchBrowserRequestSchema(prepared), {
            extension: 'prepared',
            targetUrl: TARGET_URL,
            profile: PROFILE,
        });
        if (parsed.success) {
            throw new Error('the Chromium line must keep requiring model-selected settings');
        }

        expect(launchBrowserRefusal(prepared, parsed.issues)).toContain(
            SettingsProfileKind.AgentSelected,
        );
    });

    it('accepts a prepared launch with model-selected settings and shows the property', () => {
        const parsed = v.safeParse(launchBrowserRequestSchema(chromiumPrepared()), {
            extension: 'prepared',
            targetUrl: TARGET_URL,
            profile: PROFILE,
            settings: {
                kind: SettingsProfileKind.AgentSelected,
                filterIds: [2, 3],
                stealthEnabled: false,
            },
        });

        expect(parsed.success).toBe(true);
        expect(advertisedProperties(chromiumPrepared())).toContain('settings');
    });

    it('accepts a list slice on model-selected settings and advertises it', () => {
        const parsed = v.safeParse(launchBrowserRequestSchema(chromiumPrepared()), {
            extension: 'prepared',
            targetUrl: TARGET_URL,
            profile: PROFILE,
            settings: SLICE_SETTINGS,
        });

        expect(parsed.success).toBe(true);
        expect(advertisedSettingsProperties(chromiumPrepared())).toContain('slice');
    });

    it('refuses a slice whose line range is not 1-based', () => {
        // Lines are 1-based into the list text: a lastLine of 0 names no line at all.
        const parsed = v.safeParse(launchBrowserRequestSchema(chromiumPrepared()), {
            extension: 'prepared',
            targetUrl: TARGET_URL,
            profile: PROFILE,
            settings: {
                ...SLICE_SETTINGS,
                slice: { ...SLICE_SETTINGS.slice, lastLine: 0 },
            },
        });

        expect(parsed.success).toBe(false);
    });
});

describe("launch_browser settings of one kind carrying another kind's field", () => {
    it('reaches the runtime and is refused by the field name', () => {
        // AdguardFilters #242775: the model carried defaults_plus_required fields into a
        // reported_on_current request. The advertised union was refused before execution with every
        // branch's errors, none naming the field, and the model never launched the reporter profile.
        const prepared = chromiumPrepared();
        const request = {
            extension: 'prepared',
            targetUrl: TARGET_URL,
            profile: PROFILE,
            settings: {
                kind: SettingsProfileKind.ReportedOnCurrent,
                importUrl:
                    'https://reports.adguard.com/settings/import.html?product_version=5.5.2.3',
                siteHostname: 'www.zegarek.net',
            },
        };

        expect(v.safeParse(launchBrowserAdvertisement(prepared).parameters, request).success).toBe(
            true,
        );
        const parsed = v.safeParse(launchBrowserRequestSchema(prepared), request);
        if (parsed.success) {
            throw new Error('siteHostname does not belong to reported_on_current settings');
        }
        expect(launchBrowserRefusal(prepared, parsed.issues)).toContain('settings.siteHostname');
    });
});

describe('launch_browser control session', () => {
    it('refuses settings on a control session by naming the pairing, not the settings shapes', () => {
        // The model paired extension "none" with settings up to eight times per run and read the
        // generic "accepted settings shapes" refusal as the shapes being wrong.
        for (const prepared of [chromiumPrepared(), undefined]) {
            const parsed = v.safeParse(launchBrowserRequestSchema(prepared), {
                extension: 'none',
                targetUrl: TARGET_URL,
                profile: PROFILE,
                settings: {
                    kind: SettingsProfileKind.DefaultsPlusRequired,
                    requiredFilterIds: [2],
                },
            });
            if (parsed.success) {
                throw new Error('a control session must not accept settings');
            }

            const refusal = launchBrowserRefusal(prepared, parsed.issues);

            expect(refusal).toContain('extension "none"');
            expect(refusal).toContain('Drop "settings"');
            expect(refusal).not.toContain('Accepted settings shapes');
        }
    });
});

describe('launch_browser on a run with no prepared build', () => {
    it('keeps the model-selected contract, so a control session still validates', () => {
        const parsed = v.safeParse(launchBrowserRequestSchema(undefined), {
            extension: 'none',
            targetUrl: TARGET_URL,
            profile: PROFILE,
        });

        expect(parsed.success).toBe(true);
    });
});
