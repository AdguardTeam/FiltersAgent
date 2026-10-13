/**
 * The launch declaration a preparation session seals in its terminal payload.
 *
 * An instruction whose blocker is installed as a signed Firefox XPI declares that family in the
 * preparation payload — the extension id, the XPI it downloaded, the managed-storage document the
 * extension reads, and the key path inside that document which must hold the user-filters file
 * content. The model never writes a policies file; the host builds the enterprise policies from
 * this declaration at every launch.
 *
 * This module is the one rule for reading that declaration. The terminal tool validates the payload
 * with it, so the model can correct a malformed declaration inside its own session, and the result
 * mapper builds the descriptor with it, so the accepted payload and the descriptor can never
 * disagree.
 */
import { resolve } from 'node:path';
import { buildManagedStorageWithUserFilters } from '../browser/firefox-policies';
import {
    ExtensionLaunchFamily,
    FIREFOX_USER_FILTERS_KEY_PATH_MAX,
    type FirefoxExtensionLaunch,
} from '../environment/extension-launch';

/**
 * Length ceiling of the managed-storage declaration the payload carries as JSON text.
 *
 * Why this value: the documented uBlock Origin document is one `adminSettings` object with a
 * filter-list selection — a few hundred bytes. Eight kilobytes carries a long list selection many
 * times over while keeping an inline filter dump out of a terminal field.
 */
export const PREPARATION_MANAGED_STORAGE_MAX_LENGTH = 8_192;

/**
 * The Firefox launch fields one preparation terminal payload may carry.
 *
 * Every field is optional in the payload schema so a malformed declaration is refused by name with
 * guidance the model can act on, instead of bouncing off the schema as an unexplained retry.
 */
export interface PreparationLaunchPayload {
    /**
     * Launch family the session declares; absent means the Chromium unpacked-directory family.
     */
    launchFamily?: string;

    /**
     * Extension id the enterprise policies are keyed by, for the Firefox family.
     */
    extensionId?: string;

    /**
     * Working-directory-relative path of the signed XPI, for the Firefox family.
     */
    xpiPath?: string;

    /**
     * Managed-storage document as JSON text, for the Firefox family.
     */
    managedStorage?: string;

    /**
     * Key path inside the managed-storage document that must hold the user-filters file content.
     */
    userFiltersKeyPath?: string[];
}

/**
 * Outcome of reading one payload's launch declaration: the Firefox descriptor, the Chromium family
 * (nothing to build), or the bounded reason the declaration cannot be honored.
 */
export type PreparationLaunchDeclaration =
    | {
          /**
           * The Chromium unpacked-directory family: the payload's `extensionDir` is the build.
           */
          family: typeof ExtensionLaunchFamily.Chromium;
      }
    | {
          /**
           * The Firefox family: a signed XPI force-installed through enterprise policies.
           */
          family: typeof ExtensionLaunchFamily.Firefox;

          /**
           * The validated Firefox launch descriptor, with the XPI path resolved absolute.
           */
          launch: FirefoxExtensionLaunch;
      }
    | {
          /**
           * Bounded reason the declaration cannot be honored, written for the model that sealed it.
           */
          reason: string;
      };

/**
 * Read one preparation payload's launch declaration.
 *
 * The Chromium family is the default, so an instruction that says nothing about its launch keeps
 * today's behavior. A Firefox declaration must carry all four fields, its managed storage must
 * parse as a JSON object, and the declared key path must be one the host can actually place the
 * user-filters content into — proved here by running the one placement rule the launch itself uses,
 * so a declaration that would hide the filters somewhere the extension never reads is refused
 * before any browser starts.
 *
 * @param payload - The terminal payload's launch fields, exactly as the session sealed them.
 * @param workDir - Absolute preparation workdir the relative XPI path resolves against.
 * @returns The family with its validated descriptor, or the bounded refusal reason.
 */
export function readPreparationLaunchDeclaration(
    payload: PreparationLaunchPayload,
    workDir: string,
): PreparationLaunchDeclaration {
    const declared = payload.launchFamily ?? ExtensionLaunchFamily.Chromium;
    if (declared === ExtensionLaunchFamily.Chromium) {
        return { family: ExtensionLaunchFamily.Chromium };
    }
    if (declared !== ExtensionLaunchFamily.Firefox) {
        return {
            reason:
                `The payload declares the unknown launch family "${declared}"; the known ` +
                `families are "${ExtensionLaunchFamily.Chromium}" (an unpacked extension ` +
                `directory) and "${ExtensionLaunchFamily.Firefox}" (a signed XPI).`,
        };
    }
    const { extensionId, xpiPath, managedStorage, userFiltersKeyPath } = payload;
    if (!extensionId || !xpiPath || !managedStorage || !userFiltersKeyPath) {
        return {
            reason:
                `A ${ExtensionLaunchFamily.Firefox} launch declaration must carry extensionId, ` +
                'xpiPath, managedStorage and userFiltersKeyPath; the host builds the enterprise ' +
                'policies from exactly those four fields and cannot install the extension ' +
                'without them.',
        };
    }
    if (
        userFiltersKeyPath.length === 0 ||
        userFiltersKeyPath.length > FIREFOX_USER_FILTERS_KEY_PATH_MAX
    ) {
        return {
            reason:
                `userFiltersKeyPath must name 1 to ${FIREFOX_USER_FILTERS_KEY_PATH_MAX} keys ` +
                `inside the managed-storage document; it named ${userFiltersKeyPath.length}.`,
        };
    }
    let template: unknown;
    try {
        template = JSON.parse(managedStorage);
    } catch (error) {
        return {
            reason:
                'managedStorage must be the managed-storage document as JSON text, but it does ' +
                `not parse: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    if (typeof template !== 'object' || template === null || Array.isArray(template)) {
        return {
            reason:
                'managedStorage must be a JSON object keyed by the settings the extension reads ' +
                `from browser.storage.managed; it parsed as ${Array.isArray(template) ? 'an array' : typeof template}.`,
        };
    }
    const launch: FirefoxExtensionLaunch = {
        launchFamily: ExtensionLaunchFamily.Firefox,
        extensionId,
        xpiPath: resolve(workDir, xpiPath),
        managedStorageTemplate: template as Record<string, unknown>,
        userFiltersKeyPath,
    };
    try {
        buildManagedStorageWithUserFilters(
            launch.managedStorageTemplate,
            launch.userFiltersKeyPath,
            '',
        );
    } catch (error) {
        return {
            reason: `The declared userFiltersKeyPath cannot hold the user-filters file content: ${
                error instanceof Error ? error.message : String(error)
            }`,
        };
    }
    return { family: ExtensionLaunchFamily.Firefox, launch };
}
