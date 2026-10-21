import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildPreparedExtensionLaunchChannel } from '../../src/browser/prepared-extension-launch';
import {
    ExtensionLaunchFamily,
    type FirefoxExtensionLaunch,
} from '../../src/environment/extension-launch';
import {
    ExtensionManifestVersion,
    PreparedExtensionSource,
} from '../../src/environment/extension-preparation';
import {
    loadPreparedExtensionFromDirectory,
    type PreparedExtension,
} from '../../src/local/prepared-extension';
import { preparedPhaseSessionConfig } from '../../src/orchestrator/prepared-session-launch';
import { ConsentStrategy, Viewport, type ReproProfile } from '../../src/types/repro-profile';
import { PhaseLabel } from '../../src/types/validation';

/**
 * The extension id uBlock Origin publishes for Firefox, as an instruction declares it.
 */
const UBLOCK_EXTENSION_ID = 'uBlock0@raymondhill.net';

/**
 * One Firefox launch declaration shaped like the uBlock Origin example's.
 *
 * @returns The declaration with an absolute XPI path under the system temp dir.
 */
function firefoxLaunch(): FirefoxExtensionLaunch {
    return {
        launchFamily: ExtensionLaunchFamily.Firefox,
        extensionId: UBLOCK_EXTENSION_ID,
        xpiPath: join(tmpdir(), 'ublock-origin.firefox.signed.xpi'),
        managedStorageTemplate: {
            adminSettings: { selectedFilterLists: ['user-filters', 'ublock-filters'] },
        },
        userFiltersKeyPath: ['adminSettings', 'userFilters'],
    };
}

describe('buildPreparedExtensionLaunchChannel', () => {
    it('launches a Firefox-family build through policies carrying the user filters at the declared key path', () => {
        const launch = firefoxLaunch();
        const channel = buildPreparedExtensionLaunchChannel({
            launch,
            userFiltersContent: '||ads.example^\n',
        });

        expect(channel.engine.browserType).toBe('firefox');
        expect(channel.userAgentProfile).toBe('Firefox');
        // The exact enterprise policies document Firefox reads at startup: the XPI force-installed
        // under its id, and the file content at the declared key path beside the declared lists.
        expect(channel.extensionChannel).toEqual({
            firefoxPolicies: {
                policies: {
                    ExtensionSettings: {
                        [UBLOCK_EXTENSION_ID]: {
                            installation_mode: 'force_installed',
                            install_url: pathToFileURL(launch.xpiPath).href,
                        },
                    },
                    '3rdparty': {
                        Extensions: {
                            [UBLOCK_EXTENSION_ID]: {
                                adminSettings: {
                                    selectedFilterLists: ['user-filters', 'ublock-filters'],
                                    userFilters: '||ads.example^\n',
                                },
                            },
                        },
                    },
                },
            },
        });
        // The declaration is launch input for every phase of the run: one phase's filters must never
        // survive into the next launch's managed storage.
        expect(launch.managedStorageTemplate).toEqual({
            adminSettings: { selectedFilterLists: ['user-filters', 'ublock-filters'] },
        });
    });

    it('carries empty user filters when the run has not written the declared file yet', () => {
        const channel = buildPreparedExtensionLaunchChannel({ launch: firefoxLaunch() });

        expect(channel.extensionChannel).toMatchObject({
            firefoxPolicies: {
                policies: {
                    '3rdparty': {
                        Extensions: {
                            [UBLOCK_EXTENSION_ID]: { adminSettings: { userFilters: '' } },
                        },
                    },
                },
            },
        });
    });

    it('launches a Chromium-family build through the unpacked directory and no policies', () => {
        const extensionPath = join(tmpdir(), 'prepared-extension');
        const channel = buildPreparedExtensionLaunchChannel({
            launch: {
                extensionPath,
                manifestVersion: ExtensionManifestVersion.Mv3,
                userScriptsPermission: false,
            },
        });

        expect(channel.engine.browserType).toBe('cloakbrowser');
        expect(channel.userAgentProfile).toBe('Chromium');
        expect(channel.extensionChannel).toEqual({
            adguardExtensionPath: extensionPath,
            adguardExtensionManifestVersion: ExtensionManifestVersion.Mv3,
            adguardExtensionUserScriptsPermission: false,
        });
    });

    it('refuses a declaration whose key path cannot hold the user filters', () => {
        const launch = firefoxLaunch();
        expect(() =>
            buildPreparedExtensionLaunchChannel({
                launch: {
                    ...launch,
                    userFiltersKeyPath: ['adminSettings', 'selectedFilterLists', 'userFilters'],
                },
                userFiltersContent: '||ads.example^',
            }),
        ).toThrow(/selectedFilterLists/);
    });
});

/**
 * Reproduction profile the phase sessions observe their target with.
 */
const REPRO_PROFILE: ReproProfile = {
    userAgentProfile: 'Firefox',
    viewport: Viewport.Desktop,
    locale: 'en-US',
    timezone: 'UTC',
    consentStrategy: ConsentStrategy.Untouched,
};

describe('preparedPhaseSessionConfig', () => {
    it('observes every phase of a Firefox-family run in Firefox, the control phase included', () => {
        const extension: PreparedExtension = {
            ...firefoxLaunch(),
            source: PreparedExtensionSource.Instruction,
            extensionSourceSha256: 'e'.repeat(64),
        };
        const host = {
            hostStateRoot: tmpdir(),
            artifactsDir: tmpdir(),
            headless: true,
            verbose: false,
        };

        const phaseA = preparedPhaseSessionConfig(host, {
            extension,
            phase: PhaseLabel.A,
            extensionRoot: null,
            reproProfile: REPRO_PROFILE,
            readinessBudgetMs: 1_000,
        });
        const phaseB = preparedPhaseSessionConfig(host, {
            extension,
            phase: PhaseLabel.B,
            extensionRoot: null,
            reproProfile: REPRO_PROFILE,
            readinessBudgetMs: 1_000,
        });

        // Phase A is the run's control state, not a different browser: comparing an unfiltered
        // Chromium against a filtered Firefox would attribute the browser's own differences to the
        // filtering under test.
        expect(phaseA.engine.browserType).toBe('firefox');
        expect(phaseA).not.toHaveProperty('firefoxPolicies');
        expect(phaseB.engine.browserType).toBe('firefox');
        expect(
            phaseB.firefoxPolicies?.policies.ExtensionSettings[UBLOCK_EXTENSION_ID]
                ?.installation_mode,
        ).toBe('force_installed');
    });

    it.each([
        [['storage', 'userScripts'], true],
        [['storage'], false],
    ])(
        'tells a Chromium phase launch whether the prepared manifest %j requires userScripts',
        async (permissions, expected) => {
            const extensionPath = mkdtempSync(join(tmpdir(), 'prepared-extension-'));
            try {
                writeFileSync(
                    join(extensionPath, 'manifest.json'),
                    JSON.stringify({ manifest_version: 3, version: '5.4.3.1', permissions }),
                );
                const extension = await loadPreparedExtensionFromDirectory(
                    extensionPath,
                    PreparedExtensionSource.PinnedRelease,
                    'e'.repeat(64),
                );

                const config = preparedPhaseSessionConfig(
                    {
                        hostStateRoot: tmpdir(),
                        artifactsDir: tmpdir(),
                        headless: true,
                        verbose: false,
                    },
                    {
                        extension,
                        phase: PhaseLabel.C,
                        extensionRoot: extensionPath,
                        reproProfile: REPRO_PROFILE,
                        readinessBudgetMs: 1_000,
                    },
                );

                expect(config.adguardExtensionUserScriptsPermission).toBe(expected);
            } finally {
                rmSync(extensionPath, { recursive: true, force: true });
            }
        },
    );
});
