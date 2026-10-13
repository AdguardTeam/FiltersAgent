/**
 * The launch family of one host-prepared extension build: how a browser session loads it.
 *
 * The prepared extension carries its launch family, because the two families install an extension
 * through channels that have nothing in common. A Chromium-family build is an unpacked directory
 * the engine loads directly; a Firefox-family build is a signed XPI force-installed through
 * enterprise policies, whose managed storage carries the user filters. The engine, the user-agent
 * family and the between-phases application all follow this descriptor, so it is declared once here
 * — a path-free vocabulary both the Host layer and the model boundary depend on, importing nothing
 * but the manifest-generation vocabulary beside it.
 */
import { ExtensionManifestVersion } from './extension-preparation';

/**
 * The browser families a prepared extension build can be launched in.
 */
export const ExtensionLaunchFamily = {
    /**
     * The Chromium line: the engine loads an unpacked extension directory.
     */
    Chromium: 'chromium',

    /**
     * Firefox: the engine force-installs a signed XPI through enterprise policies, and managed
     * storage is the only channel that reaches the extension's settings.
     */
    Firefox: 'firefox',
} as const;

/**
 * Every ExtensionLaunchFamily value, for schemas and exhaustive listings.
 */
export const EXTENSION_LAUNCH_FAMILY_VALUES = Object.values(ExtensionLaunchFamily);

/**
 * ExtensionLaunchFamily value.
 */
export type ExtensionLaunchFamily =
    (typeof ExtensionLaunchFamily)[keyof typeof ExtensionLaunchFamily];

/**
 * Maximum number of key-path segments a Firefox managed-storage declaration may carry.
 *
 * Why this value: the documented uBlock Origin path is two segments (`adminSettings.userFilters`),
 * and a managed-storage document nested deeper than eight levels is not a settings key any more.
 * The bound keeps a malformed declaration from walking an unbounded structure.
 */
export const FIREFOX_USER_FILTERS_KEY_PATH_MAX = 8;

/**
 * How a Chromium-family build is launched: today's unpacked extension directory.
 *
 * The discriminant is optional on this arm only: every prepared build before the families were
 * distinguished was a Chromium one and carries no discriminant, so its absence means Chromium — for
 * a runtime record and a persisted run record alike.
 */
export interface ChromiumExtensionLaunch {
    /**
     * Discriminator: the Chromium line loads an unpacked directory; absent means the same.
     */
    launchFamily?: typeof ExtensionLaunchFamily.Chromium;

    /**
     * Absolute path of the unpacked directory (manifest.json at its root).
     */
    extensionPath: string;

    /**
     * Manifest generation the unpacked build ships, read from its own manifest.
     */
    manifestVersion: ExtensionManifestVersion;
}

/**
 * How a Firefox-family build is launched: a signed XPI plus the managed storage that carries the
 * run's user filters.
 */
export interface FirefoxExtensionLaunch {
    /**
     * Discriminator: Firefox force-installs a signed XPI through enterprise policies.
     */
    launchFamily: typeof ExtensionLaunchFamily.Firefox;

    /**
     * Extension ID the policies target, exactly as the extension publishes it (for example
     * `uBlock0@raymondhill.net`).
     */
    extensionId: string;

    /**
     * Absolute filesystem path of the signed XPI the browser must force-install.
     */
    xpiPath: string;

    /**
     * Managed-storage document the extension reads from `browser.storage.managed`, as the
     * instruction declared it: everything except the user filters themselves. The shape is owned by
     * the instruction, never by this app — for uBlock Origin it is `{ adminSettings: {
     * selectedFilterLists: [...] } }`.
     */
    managedStorageTemplate: Record<string, unknown>;

    /**
     * Key path inside {@link FirefoxExtensionLaunch.managedStorageTemplate} that must hold the
     * content of the declared user-filters file (for uBlock Origin `['adminSettings',
     * 'userFilters']`). The host writes the file, then places its exact content here before every
     * launch.
     */
    userFiltersKeyPath: readonly string[];
}

/**
 * How one prepared extension build is loaded into a browser session.
 */
export type ExtensionLaunchDescriptor = ChromiumExtensionLaunch | FirefoxExtensionLaunch;
