import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExtensionManifestVersion } from '../environment/extension-preparation';
import type { Logger } from '../logger/logger';
import { runPreparationSubprocess } from './preparation-subprocess';

/**
 * Release identity the fetcher verifies one downloaded asset against.
 *
 * The export shape of the one production pin below, spelled out so deterministic tests can inject a
 * self-consistent pin over their fixture bytes while production never passes anything.
 */
export interface PinnedAdguardExtensionRelease {
    /**
     * Release tag of AdguardTeam/AdguardBrowserExtension the asset is fetched from.
     */
    tag: string;

    /**
     * Asset inside the release holding the Chromium MV3 build.
     */
    assetName: string;

    /**
     * Direct download URL of the pinned asset.
     */
    downloadUrl: string;

    /**
     * SHA-256 over the exact asset bytes, verified before anything is unpacked.
     */
    sha256: string;

    /**
     * Manifest generation of the pinned build, consumed by the browser launch wiring.
     */
    manifestVersion: ExtensionManifestVersion;
}

/**
 * The one AdGuard Browser Extension build this action prepares when the run instruction carries no
 * `## Preparation` section: the current Chromium MV3 release asset.
 *
 * The asset URL shape and the digest are operator-verified constants; the full-bytes SHA-256 over
 * the exact download makes asset substitution impossible — a mismatched digest fails the run named
 * before any browser start.
 */
export const PINNED_ADGUARD_EXTENSION_RELEASE: PinnedAdguardExtensionRelease = {
    tag: 'v5.5.2.3',
    assetName: 'chrome-mv3.zip',
    downloadUrl:
        'https://github.com/AdguardTeam/AdguardBrowserExtension/releases/download/v5.5.2.3/chrome-mv3.zip',
    sha256: '439fa0f7598fd67239990c834428c04907293a40fdf847821861ff703d451ef3',
    manifestVersion: ExtensionManifestVersion.Mv3,
};

/**
 * Stable failure classes of the pinned-release fetcher.
 */
export const PinnedReleaseFailureCode = {
    /**
     * The download did not answer 2xx or could not be read; the message names the URL.
     */
    DownloadFailed: 'download_failed',

    /**
     * The downloaded bytes do not hash to the pinned digest; the message names tag, asset,
     * expected, and actual. Refused before anything is unpacked.
     */
    DigestMismatch: 'digest_mismatch',

    /**
     * Unzip exited non-zero; the message carries the full captured subprocess output.
     */
    UnpackFailed: 'unpack_failed',

    /**
     * The unpacked release carries no manifest.json; the message names what was unpacked instead.
     */
    ManifestMissing: 'manifest_missing',
} as const;

/**
 * PinnedReleaseFailureCode value.
 */
export type PinnedReleaseFailureCode =
    (typeof PinnedReleaseFailureCode)[keyof typeof PinnedReleaseFailureCode];

/**
 * Stable, named pinned-release failure carrying its public classification.
 */
export class PinnedReleaseError extends Error {
    /**
     * Stable public failure classification.
     */
    readonly code: PinnedReleaseFailureCode;

    /**
     * Underlying cause observed at fetch time, when one exists.
     */
    override readonly cause?: unknown;

    /**
     * Create one named pinned-release failure.
     *
     * @param code - Stable public failure classification.
     * @param message - Full diagnostic naming the tag, asset, and what was observed.
     * @param cause - Underlying error, when one exists.
     */
    constructor(code: PinnedReleaseFailureCode, message: string, cause?: unknown) {
        super(message);
        this.name = 'PinnedReleaseError';
        this.code = code;
        this.cause = cause;
    }
}

/**
 * Cache path segments between {@link DownloadPinnedExtensionReleaseOptions.destinationRoot} and the
 * per-tag release directory.
 */
const RELEASE_CACHE_SEGMENTS = ['extensions', 'prebuilt'] as const;

/**
 * File name under the release directory where the verified asset bytes are kept for re-unpacks.
 */
const RELEASE_ZIP_FILE_NAME = 'download';

/**
 * Directory under the release directory holding the unpacked extension the browser loads.
 */
const UNPACKED_RELEASE_DIR_NAME = 'unpacked';

/**
 * Marker file name recording the verified digest of the unpacked release; its presence with a
 * matching digest short-circuits re-download and re-unpack.
 */
const RELEASE_MARKER_FILE_NAME = 'digest.json';

/**
 * File every extension must carry at its root for the browser to load it.
 */
const MANIFEST_FILE_NAME = 'manifest.json';

/**
 * The one unpacker, per the plan's choice of `unzip` — present on macOS and ubuntu-latest.
 */
const UNZIP_EXECUTABLE = 'unzip';

/**
 * One pinned prebuilt release placed on disk and verified, ready for the browser launch wiring.
 */
export interface PinnedExtensionRelease {
    /**
     * Unpacked extension directory (manifest.json at its root) inside the cache.
     */
    extensionDir: string;

    /**
     * Manifest generation of the pinned build.
     */
    manifestVersion: ExtensionManifestVersion;

    /**
     * SHA-256 over the exact downloaded zip bytes, as verified against the pin.
     */
    sha256: string;

    /**
     * Release tag the asset was fetched from.
     */
    tag: string;

    /**
     * Whether this call reused the previously downloaded and unpacked release.
     */
    fromCache: boolean;
}

/**
 * Inputs for one pinned-release download.
 */
export interface DownloadPinnedExtensionReleaseOptions {
    /**
     * Directory under which the per-tag release cache lives;
     * `<destinationRoot>/extensions/prebuilt/<tag>/` holds the zip, the unpacked dir, and the
     * digest marker.
     */
    destinationRoot: string;

    /**
     * Injectable fetch for deterministic tests; production uses global fetch.
     */
    fetchImpl?: typeof fetch;

    /**
     * Release identity to verify the download against; defaults to the operator-verified
     * {@link PINNED_ADGUARD_EXTENSION_RELEASE}. Injectable only so tests can pin their fixture
     * bytes; production callers leave it unset.
     */
    pinnedRelease?: PinnedAdguardExtensionRelease;

    /**
     * Logger receiving the download milestones and the full unpack subprocess output.
     */
    logger: Logger;
}

/**
 * Compute the SHA-256 hex digest over exact bytes.
 *
 * @param bytes - Exact downloaded bytes.
 * @returns Lowercase hex digest.
 */
function sha256Hex(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Describe a caught error for embedding in a typed failure message.
 *
 * @param error - Caught error of any shape.
 * @returns Message text suitable for embedding in a typed failure.
 */
function describeCause(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Parsed digest marker left by a previous successful download.
 */
interface ReleaseDigestMarker {
    /**
     * Release tag recorded at download time.
     */
    tag?: string;

    /**
     * Verified SHA-256 of the bytes unpacked to the cached dir.
     */
    sha256?: string;
}

/**
 * Read the digest marker left by a previous successful download, when there is one.
 *
 * @param markerPath - Path of the digest marker.
 * @returns The parsed marker, or undefined when it is missing or unreadable — either way a cache
 *   miss, never a failure.
 */
async function readDigestMarker(markerPath: string): Promise<ReleaseDigestMarker | undefined> {
    try {
        return JSON.parse(await readFile(markerPath, 'utf8')) as ReleaseDigestMarker;
    } catch {
        return undefined;
    }
}

/**
 * Download the pinned prebuilt AdGuard extension release, verify it, unpack it, and cache it.
 *
 * Contract: digest-first — the exact bytes are verified against the pin before anything is
 * unpacked, and a mismatch fails named (tag, asset, expected, actual) leaving no marker behind. The
 * unpack runs through the preparation subprocess with its full output logged. A previously verified
 * release whose marker digest still matches the pin short-circuits to the cached unpacked dir
 * without touching the network; a missing manifest in the unpacked asset fails named.
 *
 * @param options - Destination root, injectable fetch, optional test pin, logger.
 * @returns The unpacked extension directory with its provenance.
 * @throws {PinnedReleaseError} With a stable code for download, digest, unpack, and manifest
 *   failures.
 */
export async function downloadPinnedExtensionRelease(
    options: DownloadPinnedExtensionReleaseOptions,
): Promise<PinnedExtensionRelease> {
    const { destinationRoot, logger } = options;
    const fetchImpl = options.fetchImpl ?? fetch;
    const pin = options.pinnedRelease ?? PINNED_ADGUARD_EXTENSION_RELEASE;
    const releaseDir = join(destinationRoot, ...RELEASE_CACHE_SEGMENTS, pin.tag);
    const zipPath = join(releaseDir, RELEASE_ZIP_FILE_NAME);
    const unpackedDir = join(releaseDir, UNPACKED_RELEASE_DIR_NAME);
    const markerPath = join(releaseDir, RELEASE_MARKER_FILE_NAME);
    const manifestPath = join(unpackedDir, MANIFEST_FILE_NAME);

    const cachedMarker = await readDigestMarker(markerPath);
    if (
        cachedMarker?.sha256 === pin.sha256 &&
        cachedMarker.tag === pin.tag &&
        (await access(manifestPath).then(
            () => true,
            () => false,
        ))
    ) {
        logger.info(
            { tag: pin.tag, sha256: pin.sha256, extensionDir: unpackedDir },
            'Pinned release already downloaded and verified; reusing the cached unpacked dir',
        );
        return {
            extensionDir: unpackedDir,
            manifestVersion: pin.manifestVersion,
            sha256: pin.sha256,
            tag: pin.tag,
            fromCache: true,
        };
    }

    // Drop any stale marker and stale unpacked content first: a failed re-fetch must never MISS a
    // marker left behind, and unzip must never hit leftover files from a broken early attempt.
    await rm(markerPath, { force: true });
    await rm(unpackedDir, { recursive: true, force: true });

    logger.info(
        { tag: pin.tag, assetName: pin.assetName, url: pin.downloadUrl },
        'Downloading pinned release',
    );
    let bytes: Uint8Array;
    try {
        const response = await fetchImpl(pin.downloadUrl);
        if (!response.ok) {
            throw new PinnedReleaseError(
                PinnedReleaseFailureCode.DownloadFailed,
                `Pinned release ${pin.tag} asset ${pin.assetName} download failed: status ` +
                    `${response.status} for ${pin.downloadUrl}.`,
            );
        }
        bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
        if (error instanceof PinnedReleaseError) {
            throw error;
        }
        throw new PinnedReleaseError(
            PinnedReleaseFailureCode.DownloadFailed,
            `Pinned release ${pin.tag} asset ${pin.assetName} download failed: ` +
                `${describeCause(error)}.`,
            error,
        );
    }
    const digest = sha256Hex(bytes);
    if (digest !== pin.sha256) {
        throw new PinnedReleaseError(
            PinnedReleaseFailureCode.DigestMismatch,
            `Pinned release digest mismatch for tag ${pin.tag} asset ${pin.assetName}: expected ` +
                `${pin.sha256}, downloaded ${digest} (${bytes.byteLength} bytes); refusing to ` +
                'unpack substituted bytes.',
        );
    }
    logger.info(
        { tag: pin.tag, sha256: digest, byteLength: bytes.byteLength, zipPath },
        'Pinned release downloaded; digest verified against the pin',
    );

    await mkdir(releaseDir, { recursive: true });
    await writeFile(zipPath, bytes);

    const unpack = await runPreparationSubprocess(
        { executable: UNZIP_EXECUTABLE, args: ['-q', zipPath, '-d', unpackedDir] },
        process.env,
    );
    logger.info(
        {
            command: [UNZIP_EXECUTABLE, '-q', zipPath, '-d', unpackedDir],
            unzipStdout: unpack.stdout,
            unzipStderr: unpack.stderr,
        },
        'Pinned release unpack subprocess output',
    );
    if (unpack.exitCode !== 0) {
        throw new PinnedReleaseError(
            PinnedReleaseFailureCode.UnpackFailed,
            `Pinned release ${pin.tag} unpack failed: unzip exited ${unpack.exitCode}; ` +
                `stdout: ${unpack.stdout}; stderr: ${unpack.stderr}`,
        );
    }

    const unpackedEntries = await readdir(unpackedDir);
    if (!unpackedEntries.includes(MANIFEST_FILE_NAME)) {
        throw new PinnedReleaseError(
            PinnedReleaseFailureCode.ManifestMissing,
            `Pinned release ${pin.tag} unpacked without ${MANIFEST_FILE_NAME}; unpacked entries: ` +
                `${unpackedEntries.join(', ')}.`,
        );
    }

    await writeFile(markerPath, `${JSON.stringify({ sha256: digest, tag: pin.tag }, null, 2)}\n`);
    logger.info(
        { tag: pin.tag, extensionDir: unpackedDir, sha256: digest },
        'Pinned release ready',
    );
    return {
        extensionDir: unpackedDir,
        manifestVersion: pin.manifestVersion,
        sha256: digest,
        tag: pin.tag,
        fromCache: false,
    };
}
