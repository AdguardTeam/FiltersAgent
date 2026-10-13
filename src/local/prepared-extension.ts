/**
 * PreparedExtension — the host-validated extension build every fix run carries into its browser
 * sessions, and its provenance vocabulary at the runtime seam.
 *
 * Exactly ONE PreparedExtension exists per run, prepared before the fix session starts: the host
 * downloads the operator-pinned prebuilt release, or adopts what the short-lived preparation
 * session built from the instruction's `## Preparation` section. The source kind is recorded so run
 * records state where the loaded build came from; the digest pins the exact source bytes and makes
 * substitution detectable. (Run records written by earlier builds may still name a third source, an
 * operator-preloaded directory, so `PreparedExtensionSource.Preloaded` stays parseable.)
 *
 * The record carries its launch family, because the two families install through channels with
 * nothing in common — a Chromium unpacked directory, or a Firefox signed XPI force-installed
 * through enterprise policies whose managed storage carries the user filters.
 */
import { readFileSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
    ExtensionLaunchFamily,
    type ChromiumExtensionLaunch,
    type FirefoxExtensionLaunch,
} from '../environment/extension-launch';
import {
    EXTENSION_MANIFEST_VERSION_VALUES,
    ExtensionManifestVersion,
    PreparedExtensionSource,
} from '../environment/extension-preparation';

/**
 * Where one prepared build came from, whatever family it launches in.
 */
export interface PreparedExtensionIdentity {
    /**
     * Where this build came from.
     */
    source: PreparedExtensionSource;

    /**
     * Digest pinning the exact extension source: the verified release download for the pinned
     * release, the instruction section content for an instruction build, and the manifest.json
     * bytes for a preloaded directory (there the operator directory itself is the source).
     */
    extensionSourceSha256: string;

    /**
     * Release tag the build came from, when it is a release build.
     */
    extensionSourceTag?: string;
}

/**
 * A Chromium-family prepared build: today's unpacked directory, validated to carry `manifest.json`.
 *
 * This is exactly the record every run carried before the families were distinguished — its
 * discriminant stays absent — so the launch wiring, the run-record provenance and the build digest
 * of the Chromium route read the same fields they always did.
 */
export type ChromiumPreparedExtension = PreparedExtensionIdentity & ChromiumExtensionLaunch;

/**
 * A Firefox-family prepared build: a signed XPI at an absolute path plus the managed-storage
 * declaration the host places the user filters into at every launch.
 */
export type FirefoxPreparedExtension = PreparedExtensionIdentity &
    FirefoxExtensionLaunch & {
        /**
         * Never present: a signed XPI has no unpacked directory. Declared absent so a reader that
         * does not care about the family reads `undefined` here instead of guessing a path.
         */
        extensionPath?: undefined;

        /**
         * Never present: the host reads no manifest out of a signed XPI. Declared absent for the
         * same reason as {@link FirefoxPreparedExtension.extensionPath}.
         */
        manifestVersion?: undefined;
    };

/**
 * The one extension build this run loads into its browser sessions, carrying its launch family.
 *
 * Validated at creation: a Chromium-family directory exists and carries `manifest.json`, and a
 * Firefox-family XPI exists at an absolute path with a managed-storage declaration the host can
 * place the user filters into. The launch wiring reads the family-specific fields; the run-record
 * provenance blocks serialize them beside the source identity.
 */
export type PreparedExtension = ChromiumPreparedExtension | FirefoxPreparedExtension;

/**
 * The one file the browser cannot load an extension without.
 */
const MANIFEST_FILE_NAME = 'manifest.json';

/**
 * The manifest field naming the package version.
 */
const PACKAGE_VERSION_FIELD = 'version';

/**
 * The manifest field naming the manifest generation.
 */
const MANIFEST_VERSION_FIELD = 'manifest_version';

/**
 * The parsed browser-relevant facts of one unpacked extension manifest.
 */
export interface PreparedExtensionManifestFacts {
    /**
     * The package version the manifest declares.
     */
    packageVersion: string;

    /**
     * The manifest generation the manifest declares.
     */
    manifestVersion: ExtensionManifestVersion;
}

/**
 * Test whether one parsed manifest field names a known manifest generation.
 *
 * @param value - The parsed `manifest_version` field of unknown shape.
 * @returns Whether the value is exactly one declared generation.
 */
function isKnownManifestVersion(value: unknown): value is ExtensionManifestVersion {
    return EXTENSION_MANIFEST_VERSION_VALUES.some((entry) => entry === value);
}

/**
 * Read and classify the manifest facts of one unpacked extension directory.
 *
 * @param extensionPath - Absolute unpacked directory (manifest.json at its root).
 * @returns The declared package version and manifest generation.
 * @throws When the directory is missing, the manifest is missing, or the manifest does not declare
 *   a known generation — a hosted directory the browser would refuse to load anyway.
 */
export function readPreparedExtensionManifest(
    extensionPath: string,
): PreparedExtensionManifestFacts {
    const manifestPath = join(extensionPath, MANIFEST_FILE_NAME);
    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    } catch (error) {
        throw new Error(
            `The prepared extension directory ${extensionPath} holds no readable ` +
                `${MANIFEST_FILE_NAME}: ${error instanceof Error ? error.message : String(error)}.`,
            { cause: error },
        );
    }
    const packageVersion = raw[PACKAGE_VERSION_FIELD];
    if (typeof packageVersion !== 'string' || packageVersion.trim().length === 0) {
        throw new Error(
            `The prepared extension manifest at ${manifestPath} declares no ` +
                `${PACKAGE_VERSION_FIELD} string.`,
        );
    }
    const manifestVersion = raw[MANIFEST_VERSION_FIELD];
    if (!isKnownManifestVersion(manifestVersion)) {
        throw new Error(
            `The prepared extension manifest at ${manifestPath} declares ` +
                `manifest_version=${String(manifestVersion)}; a known generation ` +
                `(${EXTENSION_MANIFEST_VERSION_VALUES.join(' or ')}) is required.`,
        );
    }
    return { packageVersion, manifestVersion };
}

/**
 * Validate one unpacked directory as a loadable prepared extension and build the record for it.
 *
 * @param extensionPath - Absolute unpacked directory.
 * @param source - Where this build came from.
 * @param extensionSourceSha256 - Digest pinning the extension source.
 * @param sourceTag - Optional release tag the build came from.
 * @param expectedManifestVersion - Optional manifest generation the source established (a pinned
 *   release pin, or the preparation session's build target); a mismatch fails named here, before
 *   any browser session loads the wrong generation.
 * @returns The validated PreparedExtension.
 * @throws When the directory is missing or carries no readable manifest with a known generation.
 */
export async function loadPreparedExtensionFromDirectory(
    extensionPath: string,
    source: PreparedExtensionSource,
    extensionSourceSha256: string,
    sourceTag?: string,
    expectedManifestVersion?: ExtensionManifestVersion,
): Promise<PreparedExtension> {
    const directory = await stat(extensionPath).catch(() => undefined);
    if (directory === undefined || !directory.isDirectory()) {
        throw new Error(`The prepared extension directory ${extensionPath} does not exist.`);
    }
    await access(join(extensionPath, MANIFEST_FILE_NAME)).catch(() => {
        throw new Error(
            `The prepared extension directory ${extensionPath} carries no ` +
                `${MANIFEST_FILE_NAME}; the browser cannot load it.`,
        );
    });
    const manifest = readPreparedExtensionManifest(extensionPath);
    if (
        expectedManifestVersion !== undefined &&
        manifest.manifestVersion !== expectedManifestVersion
    ) {
        throw new Error(
            `The prepared extension loaded from ${extensionPath} ships ` +
                `manifest_version=${manifest.manifestVersion}; the source established ` +
                `${expectedManifestVersion}.`,
        );
    }
    return {
        extensionPath,
        manifestVersion: manifest.manifestVersion,
        source,
        extensionSourceSha256,
        ...(sourceTag === undefined ? {} : { extensionSourceTag: sourceTag }),
    };
}

/**
 * Validate one declared signed XPI as a loadable Firefox-family prepared extension.
 *
 * There is no unpacked directory and no readable manifest generation here: Firefox installs a
 * signed archive, which the browser itself validates at startup. What the host can validate before
 * paying for a run is that the declaration is launchable — the XPI is an existing file at an
 * absolute path (`install_url` must be an absolute `file://` URL), the extension id is non-empty,
 * and the managed-storage declaration can actually carry the user-filters content. The placement
 * itself is proved by the caller through the one placement rule the launch uses, so a declaration
 * that cannot hold the filters fails here rather than launching a browser whose user filters sit
 * somewhere the extension never reads.
 *
 * @param launch - The Firefox launch declaration the preparation session produced.
 * @param source - Where this build came from.
 * @param extensionSourceSha256 - Digest pinning the extension source.
 * @returns The validated PreparedExtension.
 * @throws When the XPI path is relative, or names something other than an existing file.
 */
export async function loadPreparedFirefoxExtension(
    launch: FirefoxExtensionLaunch,
    source: PreparedExtensionSource,
    extensionSourceSha256: string,
): Promise<PreparedExtension> {
    if (!isAbsolute(launch.xpiPath)) {
        throw new Error(
            `The prepared Firefox extension XPI path "${launch.xpiPath}" is relative; Firefox ` +
                'installs it through an absolute file:// URL, so the path must be absolute.',
        );
    }
    const xpi = await stat(launch.xpiPath).catch(() => undefined);
    if (xpi === undefined || !xpi.isFile()) {
        throw new Error(
            `The prepared Firefox extension XPI ${launch.xpiPath} does not exist as a file; ` +
                'the browser cannot force-install it.',
        );
    }
    if (launch.extensionId.trim().length === 0) {
        throw new Error(
            `The prepared Firefox extension at ${launch.xpiPath} declares an empty extension id; ` +
                'the enterprise policies are keyed by it.',
        );
    }
    return { ...launch, source, extensionSourceSha256 };
}

/**
 * Require the Chromium unpacked-directory build one Chromium-only path needs.
 *
 * The AdGuard route reads the extension's own options page, its bundled filter catalog and its
 * manifest — none of which a signed XPI has. A Firefox-family build reaching one of those paths is
 * a wiring fault, so it fails named here instead of being answered with a guess.
 *
 * @param extension - The run's one prepared extension build.
 * @param purpose - What the caller needed the unpacked directory for, quoted into the failure.
 * @returns The Chromium-family build.
 * @throws When this run's prepared build is not a Chromium-family one.
 */
export function requireChromiumPreparedExtension(
    extension: PreparedExtension,
    purpose: string,
): ChromiumPreparedExtension {
    if (extension.launchFamily === ExtensionLaunchFamily.Firefox) {
        throw new Error(
            `${purpose} requires a Chromium-family prepared extension (an unpacked directory), ` +
                `but this run prepared a ${extension.launchFamily}-family build.`,
        );
    }
    return extension;
}
