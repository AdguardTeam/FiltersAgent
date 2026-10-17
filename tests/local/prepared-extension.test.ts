import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionLaunchFamily } from '../../src/environment/extension-launch';
import {
    ExtensionManifestVersion,
    PreparedExtensionSource,
} from '../../src/environment/extension-preparation';
import {
    historicalBuildSourceSha256,
    loadHistoricalBuildExtension,
} from '../../src/local/prepared-extension';

const historicalBuild = {
    version: '5.4.3.99',
    releaseTag: 'v5.4.3.1',
    releaseSha256: 'a'.repeat(64),
    autobuildTag: 'autobuild-v5.4.3.99',
    autobuildCommit: 'b'.repeat(40),
};
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

describe('historical prepared extension', () => {
    it('loads a historical build as a Chromium MV3 extension with historical-build provenance', async () => {
        const extensionDir = await mkdtemp(join(tmpdir(), 'prepared-extension-'));
        directories.push(extensionDir);
        await writeFile(
            join(extensionDir, 'manifest.json'),
            JSON.stringify({ version: historicalBuild.version, manifest_version: 3 }),
        );

        const prepared = await loadHistoricalBuildExtension(extensionDir, historicalBuild);

        expect(prepared.launchFamily).not.toBe(ExtensionLaunchFamily.Firefox);
        expect(prepared).toMatchObject({
            extensionPath: extensionDir,
            manifestVersion: ExtensionManifestVersion.Mv3,
            source: PreparedExtensionSource.HistoricalBuild,
            historicalBuild,
            extensionSourceTag: historicalBuild.autobuildTag,
            extensionSourceSha256: historicalBuildSourceSha256(historicalBuild),
        });
    });

    it('derives the source digest from both the release digest and the autobuild commit', () => {
        const digest = historicalBuildSourceSha256(historicalBuild);
        expect(historicalBuildSourceSha256({ ...historicalBuild })).toBe(digest);
        expect(
            historicalBuildSourceSha256({ ...historicalBuild, releaseSha256: 'c'.repeat(64) }),
        ).not.toBe(digest);
        expect(
            historicalBuildSourceSha256({ ...historicalBuild, autobuildCommit: 'd'.repeat(40) }),
        ).not.toBe(digest);
    });
});
