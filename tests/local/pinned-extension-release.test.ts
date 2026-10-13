import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { pino, type Logger } from 'pino';
import {
    PinnedReleaseError,
    PinnedReleaseFailureCode,
    PINNED_ADGUARD_EXTENSION_RELEASE,
    downloadPinnedExtensionRelease,
    type PinnedAdguardExtensionRelease,
} from '../../src/local/pinned-extension-release';
import { ExtensionManifestVersion } from '../../src/environment/extension-preparation';
import { runPreparationSubprocess } from '../../src/local/preparation-subprocess';

const FIXTURE_ROOT = join(tmpdir(), 'pinned-extension-release-tests');
const TEST_MANIFEST = JSON.stringify({
    name: 'pinned-release-test-extension',
    manifest_version: 3,
    version: '1.0.0',
});

const capturedLogLines: string[] = [];

afterAll(async () => {
    await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

/**
 * Build one pino logger whose JSON lines are captured in memory for assertions.
 */
function capturingLogger(): Logger {
    return pino(
        { level: 'info' },
        {
            write(chunk: string) {
                capturedLogLines.push(chunk);
            },
        },
    );
}

async function newDestinationRoot(): Promise<string> {
    const destinationRoot = join(FIXTURE_ROOT, `dest-${Date.now()}-${Math.random()}`);
    await mkdir(destinationRoot, { recursive: true });
    return destinationRoot;
}

/**
 * Build one small release-shaped zip on disk through the same preparation subprocess the fetcher
 * itself uses, so the fixture exercises the real unzip unpack on the other side.
 */
async function buildTestReleaseZip(
    zipPath: string,
    entries: Record<string, string>,
): Promise<void> {
    const stagingDir = join(FIXTURE_ROOT, `fixture-staging-${Date.now()}-${Math.random()}`);
    await mkdir(stagingDir, { recursive: true });
    for (const [name, content] of Object.entries(entries)) {
        await writeFile(join(stagingDir, name), content);
    }
    const result = await runPreparationSubprocess(
        { executable: 'zip', args: ['-q', zipPath, ...Object.keys(entries)], cwd: stagingDir },
        process.env,
    );
    if (result.exitCode !== 0) {
        throw new Error(`zip fixture failed: ${result.stderr}`);
    }
}

async function bytesOf(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(path));
}

/**
 * Build a self-consistent release pin over the exact bytes a test is about to serve, so the
 * download, digest, and unpack mechanisms run end-to-end without the network.
 */
function pinFor(bytes: Uint8Array): PinnedAdguardExtensionRelease {
    return {
        tag: 'vtest.1.0',
        assetName: 'chrome-mv3.zip',
        downloadUrl:
            'https://github.com/AdguardTeam/AdguardBrowserExtension/releases/download/' +
            'vtest.1.0/chrome-mv3.zip',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        manifestVersion: ExtensionManifestVersion.Mv3,
    };
}

/**
 * One stub fetch serving fixed bytes; records every requested URL for call-count assertions.
 */
function servingFetch(body: Uint8Array, status = 200): { fetchImpl: typeof fetch; urls: string[] } {
    const urls: string[] = [];
    return {
        urls,
        fetchImpl: async (input) => {
            urls.push(String(input));
            return new Response(body, { status });
        },
    };
}

/**
 * Path of the idempotency marker for a pinned tag, mirroring the decided cache layout
 * `extensions/prebuilt/<tag>/digest.json`.
 */
function cachedReleaseMarkerPath(destinationRoot: string, tag: string): string {
    return join(destinationRoot, 'extensions', 'prebuilt', tag, 'digest.json');
}

/**
 * Path the cached release zip is written to, mirroring the decided cache layout
 * `extensions/prebuilt/<tag>/download`.
 */
function cachedReleaseZipPath(destinationRoot: string, tag: string): string {
    return join(destinationRoot, 'extensions', 'prebuilt', tag, 'download');
}

describe('downloadPinnedExtensionRelease', () => {
    it('downloads, digest-verifies, unzips the pinned release, and reports provenance; the second call short-circuits to the cache without fetching', async () => {
        const destinationRoot = await newDestinationRoot();
        const fixtureZip = join(FIXTURE_ROOT, `fixture-success-${Date.now()}.zip`);
        await buildTestReleaseZip(fixtureZip, {
            'manifest.json': TEST_MANIFEST,
            'background.js': '/* background */',
        });
        const fixtureBytes = await bytesOf(fixtureZip);
        const pin = pinFor(fixtureBytes);
        const { fetchImpl, urls } = servingFetch(fixtureBytes);

        const first = await downloadPinnedExtensionRelease({
            destinationRoot,
            fetchImpl,
            pinnedRelease: pin,
            logger: capturingLogger(),
        });

        expect(urls).toEqual([pin.downloadUrl]);
        expect(first.fromCache).toBe(false);
        expect(first.sha256).toBe(pin.sha256);
        expect(first.tag).toBe(pin.tag);
        expect(first.manifestVersion).toBe(pin.manifestVersion);
        expect(first.extensionDir.startsWith(destinationRoot)).toBe(true);
        const unpackedManifest = JSON.parse(
            await readFile(join(first.extensionDir, 'manifest.json'), 'utf8'),
        );
        expect(unpackedManifest.manifest_version).toBe(3);

        const second = await downloadPinnedExtensionRelease({
            destinationRoot,
            fetchImpl,
            pinnedRelease: pin,
            logger: capturingLogger(),
        });

        expect(second.fromCache).toBe(true);
        expect(second.extensionDir).toBe(first.extensionDir);
        expect(urls).toHaveLength(1);
    });

    it('fails named on a sha256 mismatch, names tag, asset, expected, and actual, and leaves no marker', async () => {
        const destinationRoot = await newDestinationRoot();
        const legitimateZip = join(FIXTURE_ROOT, `fixture-legitimate-${Date.now()}.zip`);
        await buildTestReleaseZip(legitimateZip, {
            'manifest.json': TEST_MANIFEST,
            'background.js': '/* legitimate bytes behind the pin */',
        });
        const pin = pinFor(await bytesOf(legitimateZip));
        const substitutedZip = join(FIXTURE_ROOT, `fixture-substituted-${Date.now()}.zip`);
        await buildTestReleaseZip(substitutedZip, {
            'manifest.json': TEST_MANIFEST,
            'background.js': '/* substituted payload */',
        });
        const substitutedBytes = await bytesOf(substitutedZip);
        const actualDigest = createHash('sha256').update(substitutedBytes).digest('hex');
        const { fetchImpl } = servingFetch(substitutedBytes);

        const failure = await downloadPinnedExtensionRelease({
            destinationRoot,
            fetchImpl,
            pinnedRelease: pin,
            logger: capturingLogger(),
        }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(PinnedReleaseError);
        const digestError = failure as PinnedReleaseError;
        expect(digestError.code).toBe(PinnedReleaseFailureCode.DigestMismatch);
        expect(digestError.message).toContain(pin.tag);
        expect(digestError.message).toContain(pin.assetName);
        expect(digestError.message).toContain(pin.sha256);
        expect(digestError.message).toContain(actualDigest);
        await expect(stat(cachedReleaseMarkerPath(destinationRoot, pin.tag))).rejects.toMatchObject(
            { code: 'ENOENT' },
        );
    });

    it('fails named when the unpacked release carries no manifest.json', async () => {
        const destinationRoot = await newDestinationRoot();
        const manifestlessZip = join(FIXTURE_ROOT, `fixture-manifest-${Date.now()}.zip`);
        await buildTestReleaseZip(manifestlessZip, {
            'background.js': '/* payload without a manifest */',
        });
        const pin = pinFor(await bytesOf(manifestlessZip));
        const { fetchImpl } = servingFetch(await bytesOf(manifestlessZip));

        const failure = await downloadPinnedExtensionRelease({
            destinationRoot,
            fetchImpl,
            pinnedRelease: pin,
            logger: capturingLogger(),
        }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(PinnedReleaseError);
        const manifestError = failure as PinnedReleaseError;
        expect(manifestError.code).toBe(PinnedReleaseFailureCode.ManifestMissing);
        expect(manifestError.message).toContain(pin.tag);
        await expect(stat(cachedReleaseMarkerPath(destinationRoot, pin.tag))).rejects.toMatchObject(
            { code: 'ENOENT' },
        );
    });

    it('fails named with the release URL when the download does not answer with a 2xx', async () => {
        const destinationRoot = await newDestinationRoot();
        const pin = pinFor(new Uint8Array([1, 2, 3]));
        const { fetchImpl } = servingFetch(new Uint8Array(), 404);

        const failure = await downloadPinnedExtensionRelease({
            destinationRoot,
            fetchImpl,
            pinnedRelease: pin,
            logger: capturingLogger(),
        }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(PinnedReleaseError);
        const downloadError = failure as PinnedReleaseError;
        expect(downloadError.code).toBe(PinnedReleaseFailureCode.DownloadFailed);
        expect(downloadError.message).toContain(pin.downloadUrl);
    });

    it('keeps the unpack subprocess output in the log next to the run that unpacked it', async () => {
        const destinationRoot = await newDestinationRoot();
        const fixtureZip = join(FIXTURE_ROOT, `fixture-log-${Date.now()}.zip`);
        await buildTestReleaseZip(fixtureZip, {
            'manifest.json': TEST_MANIFEST,
            'background.js': '/* background */',
        });
        const fixtureBytes = await bytesOf(fixtureZip);
        const { fetchImpl } = servingFetch(fixtureBytes);
        capturedLogLines.length = 0;

        await downloadPinnedExtensionRelease({
            destinationRoot,
            fetchImpl,
            pinnedRelease: pinFor(fixtureBytes),
            logger: capturingLogger(),
        });

        expect(capturedLogLines.join('\n')).toContain(
            cachedReleaseZipPath(destinationRoot, 'vtest.1.0'),
        );
    });

    it('ships an operator-verified pin whose digest and release URL shape are consistent', () => {
        const { tag, assetName, downloadUrl, sha256 } = PINNED_ADGUARD_EXTENSION_RELEASE;
        expect(sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(downloadUrl).toBe(
            `https://github.com/AdguardTeam/AdguardBrowserExtension/releases/download/${tag}/${assetName}`,
        );
        expect(PINNED_ADGUARD_EXTENSION_RELEASE.manifestVersion).toBe(ExtensionManifestVersion.Mv3);
    });
});
