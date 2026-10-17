import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ExtensionManifestVersion,
    PreparedExtensionSource,
} from '../../src/environment/extension-preparation';
import { loadHistoricalBuildExtension } from '../../src/local/prepared-extension';
import { createLogger } from '../../src/logger/logger';
import { prepareRunExtension } from '../../src/orchestrator/pre-run-preparation';
import type { PiRuntime } from '../../src/pi/runtime';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import { testCoreConfig } from '../config/test-core-config';

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

function extensionDirectory(): string {
    const root = mkdtempSync(join(tmpdir(), 'pre-run-extension-'));
    roots.push(root);
    writeFileSync(
        join(root, 'manifest.json'),
        JSON.stringify({ manifest_version: 3, version: '5.4.3.99' }),
    );
    return root;
}

function context() {
    return {
        recorder: new TraceRecorder({ runId: 'preparation', issueNumber: 1, mode: 'fix' }),
        llm: testCoreConfig().llm,
        piRuntime: {} as PiRuntime,
        logger: createLogger(),
    };
}

describe('prepareRunExtension', () => {
    it('uses the host-prepared build without downloading the pin or running a preparation session', async () => {
        // A historical run must load exactly the host build, even when its instruction can build one.
        const extensionPath = extensionDirectory();
        const preparedExtension = await loadHistoricalBuildExtension(extensionPath, {
            version: '5.4.3.99',
            releaseTag: 'v5.4.3.1',
            releaseSha256: 'a'.repeat(64),
            autobuildTag: 'autobuild-v5.4.3.99',
            autobuildCommit: 'b'.repeat(40),
        });
        const download = vi.fn(async () => {
            throw new Error('Host builds must not download a release');
        });
        const prepare = vi.fn(async () => {
            throw new Error('Host builds must not start a preparation session');
        });

        const result = await prepareRunExtension(
            context(),
            {
                artifactsDir: extensionPath,
                preparedExtension,
                instruction: {
                    path: 'INSTRUCTION.md',
                    content: '## Preparation\nBuild the blocker.\n',
                    sha256: 'c'.repeat(64),
                    documents: [],
                },
            },
            { downloadPinnedExtensionRelease: download, runPreparationSession: prepare },
        );

        expect(result).toBe(preparedExtension);
        expect(download).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
    });

    it('downloads the pinned release when the run has neither a host-prepared build nor a preparation section', async () => {
        // Live runs retain the verified pinned-release path and its recorded source identity.
        const extensionDir = extensionDirectory();
        const download = vi.fn(async () => ({
            extensionDir,
            manifestVersion: ExtensionManifestVersion.Mv3,
            sha256: 'd'.repeat(64),
            tag: 'v5.5.2.3',
            fromCache: false,
        }));
        const prepare = vi.fn(async () => {
            throw new Error('No preparation section');
        });

        const result = await prepareRunExtension(
            context(),
            { artifactsDir: extensionDir },
            { downloadPinnedExtensionRelease: download, runPreparationSession: prepare },
        );

        expect(result).toMatchObject({
            extensionPath: extensionDir,
            source: PreparedExtensionSource.PinnedRelease,
            extensionSourceTag: 'v5.5.2.3',
            extensionSourceSha256: 'd'.repeat(64),
        });
        expect(download).toHaveBeenCalledOnce();
        expect(prepare).not.toHaveBeenCalled();
    });
});
