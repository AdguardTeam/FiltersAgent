/**
 * The launch channel one prepared extension build is loaded through.
 *
 * The engine follows the launch family. A Chromium-family build takes the stealth Chromium engine
 * and the unpacked-directory channel; a Firefox-family build takes the Playwright Firefox engine
 * and the enterprise-policies channel, whose managed storage carries the current content of the
 * run's user-filters file. The two channels are exclusive by construction here, which is what keeps
 * `BrowserSession.create` from ever seeing a mixed configuration.
 *
 * The policies are rebuilt on every launch rather than stored: Firefox reads `policies.json` only
 * at startup, so the content a session serves is exactly the content the file held when that
 * session was launched.
 */
import { CloakBrowserEngine } from './cloakbrowser-engine';
import { FirefoxEngine } from './firefox-engine';
import { buildFirefoxPolicies, buildManagedStorageWithUserFilters } from './firefox-policies';
import type { FirefoxPolicies } from './firefox-policies';
import type { IBrowserEngine, IBrowserSession } from './browser-interfaces';
import {
    ExtensionLaunchFamily,
    type ExtensionLaunchDescriptor,
} from '../environment/extension-launch';
import type { ExtensionManifestVersion } from '../environment/extension-preparation';
import type { ReproProfile } from '../types/repro-profile';

/**
 * User-agent family the reproduction profile carries for a Chromium-family launch.
 */
export const CHROMIUM_USER_AGENT_PROFILE = 'Chromium';

/**
 * User-agent family the reproduction profile carries for a Firefox-family launch.
 */
export const FIREFOX_USER_AGENT_PROFILE = 'Firefox';

/**
 * What one relaunch of a running session receives.
 */
export interface PolicySessionRelaunchRequest {
    /**
     * The running session the relaunch replaces; the implementation closes it.
     */
    previous: IBrowserSession;

    /**
     * Enterprise policies the replacement session must start with.
     */
    firefoxPolicies: FirefoxPolicies;

    /**
     * Reproduction profile the replacement session must carry, so the relaunched browser observes
     * the target exactly as the session it replaces did.
     */
    reproProfile: ReproProfile;
}

/**
 * Relaunch one session with rebuilt enterprise policies.
 *
 * Firefox reads `policies.json` only at startup, so new managed storage reaches the extension only
 * through a new browser: the host-performed file-backed application closes the persistent context
 * and launches again through this seam. Tests supply their own implementation to observe the
 * rebuilt policies without starting a browser.
 */
export type PolicySessionRelaunch = (
    request: PolicySessionRelaunchRequest,
) => Promise<IBrowserSession>;

/**
 * What one prepared build's launch channel needs beyond the descriptor itself.
 */
export interface PreparedExtensionLaunchInput {
    /**
     * How this run's prepared build is loaded: the family and its own channel inputs.
     */
    launch: ExtensionLaunchDescriptor;

    /**
     * Current content of the declared user-filters file, for the Firefox family.
     *
     * The host maintains that file between phases; whatever it holds at launch time is what the
     * rebuilt managed storage hands the extension. Empty content is the baseline ground state, so
     * an absent file and an empty file mean the same thing here.
     */
    userFiltersContent?: string;
}

/**
 * The session-configuration fields of exactly one family's extension channel, ready to spread into
 * a `BrowserSessionConfig`: a union, so a mixed configuration cannot even be spelled.
 */
export type PreparedExtensionChannelFields =
    | {
          /**
           * Unpacked extension directory, for the Chromium family.
           */
          adguardExtensionPath: string;

          /**
           * Manifest generation of the unpacked build, for the Chromium family.
           */
          adguardExtensionManifestVersion: ExtensionManifestVersion;
      }
    | {
          /**
           * Enterprise policies force-installing the signed XPI with the current user filters in
           * its managed storage, for the Firefox family.
           */
          firefoxPolicies: FirefoxPolicies;
      };

/**
 * The engine and the extension channel one prepared build launches through.
 */
export interface PreparedExtensionLaunchChannel {
    /**
     * The engine that can honor this family's extension channel.
     */
    engine: IBrowserEngine;

    /**
     * User-agent family the session's reproduction profile must carry, so the page the extension
     * filters is served the browser it is actually running in.
     */
    userAgentProfile: string;

    /**
     * The session-configuration fields of this family's one extension channel.
     */
    extensionChannel: PreparedExtensionChannelFields;
}

/**
 * Build the launch channel one prepared extension build is loaded through.
 *
 * @param input - The run's launch descriptor and, for the Firefox family, the current content of
 *   the declared user-filters file.
 * @returns The engine, the user-agent family, and exactly the one extension channel the family
 *   installs through.
 * @throws When the Firefox declaration's key path cannot hold the user-filters content, or its XPI
 *   path is not absolute — both raised by the policies builder before any browser starts.
 */
export function buildPreparedExtensionLaunchChannel(
    input: PreparedExtensionLaunchInput,
): PreparedExtensionLaunchChannel {
    const { launch } = input;
    if (launch.launchFamily === ExtensionLaunchFamily.Firefox) {
        return {
            engine: new FirefoxEngine(),
            userAgentProfile: FIREFOX_USER_AGENT_PROFILE,
            extensionChannel: {
                firefoxPolicies: buildFirefoxPolicies({
                    extensionId: launch.extensionId,
                    xpiPath: launch.xpiPath,
                    managedStorage: buildManagedStorageWithUserFilters(
                        launch.managedStorageTemplate,
                        launch.userFiltersKeyPath,
                        input.userFiltersContent ?? '',
                    ),
                }),
            },
        };
    }
    return {
        engine: new CloakBrowserEngine(),
        userAgentProfile: CHROMIUM_USER_AGENT_PROFILE,
        extensionChannel: {
            adguardExtensionPath: launch.extensionPath,
            adguardExtensionManifestVersion: launch.manifestVersion,
        },
    };
}
