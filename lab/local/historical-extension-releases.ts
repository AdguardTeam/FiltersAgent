import { ExtensionManifestVersion } from '../../src/environment/extension-preparation';
import type { PinnedAdguardExtensionRelease } from '../../src/local/pinned-extension-release';

/**
 * Verified release code used with autobuild lists from the same three-component code line.
 */
export interface HistoricalExtensionRelease extends PinnedAdguardExtensionRelease {
    /**
     * First three components of compatible reporter versions.
     */
    codeLine: string;
}

export const HISTORICAL_EXTENSION_RELEASES: readonly HistoricalExtensionRelease[] = [
    {
        codeLine: '5.4.3',
        tag: 'v5.4.3.1',
        assetName: 'chrome-mv3.zip',
        downloadUrl:
            'https://github.com/AdguardTeam/AdguardBrowserExtension/releases/download/v5.4.3.1/chrome-mv3.zip',
        sha256: 'c91cbb56bbaacc96cb7b9554d9728158ce1791e02895ea5ca5d909cd4764c2f1',
        manifestVersion: ExtensionManifestVersion.Mv3,
    },
];

/**
 * Official autobuild tags prefix the full reporter manifest version.
 */
const AUTOBUILD_TAG_PREFIX = 'autobuild-v';

/**
 * The first three components identify the release code shared by autobuild versions.
 */
const CODE_LINE_COMPONENT_COUNT = 3;

/**
 * Identify the release code line of a reporter version.
 *
 * @param version - Validated four-component reporter version.
 * @returns Three-component release code line.
 */
export function extensionCodeLine(version: string): string {
    return version.split('.').slice(0, CODE_LINE_COMPONENT_COUNT).join('.');
}

/**
 * Find verified release code compatible with one reporter version.
 *
 * @param version - Validated reporter version.
 * @param releases - Verified release catalog, injectable for offline fixtures.
 * @returns Compatible release, or undefined when its code line is not supported.
 */
export function findHistoricalReleaseForVersion(
    version: string,
    releases: readonly HistoricalExtensionRelease[] = HISTORICAL_EXTENSION_RELEASES,
): HistoricalExtensionRelease | undefined {
    return releases.find((release) => release.codeLine === extensionCodeLine(version));
}

/**
 * Find the release explicitly selected by a historical run.
 *
 * @param tag - Release tag stored in the run pin.
 * @param releases - Verified release catalog, injectable for offline fixtures.
 * @returns Matching release, or undefined for an unknown tag.
 */
export function findHistoricalReleaseByTag(
    tag: string,
    releases: readonly HistoricalExtensionRelease[] = HISTORICAL_EXTENSION_RELEASES,
): HistoricalExtensionRelease | undefined {
    return releases.find((release) => release.tag === tag);
}

/**
 * Name the official autobuild tag of a reporter version.
 *
 * @param version - Validated four-component reporter version.
 * @returns Full autobuild tag.
 */
export function autobuildTagFor(version: string): string {
    return `${AUTOBUILD_TAG_PREFIX}${version}`;
}
