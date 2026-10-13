import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/logger/logger';
import {
    enableBlockerModule,
    loadBlockerModuleManifest,
    type LoadedBlockerModule,
} from '../../src/proxy-blocker/blocker-module-manifest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const OUT_DIR = mkdtempSync(join(tmpdir(), 'adguard-cli-module-'));

let module: LoadedBlockerModule;

beforeAll(() => {
    // The build the export runs, so the test drives exactly what a workflow installs.
    execFileSync(
        process.execPath,
        ['--import', 'tsx', join(REPO_ROOT, 'scripts', 'build-adguard-cli-module.ts'), OUT_DIR],
        { cwd: REPO_ROOT },
    );
    module = loadBlockerModuleManifest(join(OUT_DIR, 'blocker-module.json'));
}, 60_000);

afterAll(() => {
    rmSync(OUT_DIR, { recursive: true, force: true });
});

describe('the bundled AdGuard CLI module', () => {
    it('ships a manifest that plugs the adguard_cli executor in with only the licence', () => {
        expect(module.manifest.executor).toBe('adguard_cli');
        expect(module.manifest.env).toEqual(['ADGUARD_LICENSE_KEY']);
        expect(module.manifest.optionalEnv).toEqual(['ADGUARD_CLI_HOME_ARCHIVE']);
    });

    it('runs as a module process and names the licence a workflow did not pass', async () => {
        const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
        const workspaceDir = mkdtempSync(join(tmpdir(), 'adguard-cli-module-workspace-'));
        try {
            const blocker = enableBlockerModule(
                module,
                { PATH: process.env['PATH'] },
                logger,
            ).startBlocker(workspaceDir);

            await expect(blocker.describe()).rejects.toThrow(
                'The AdGuard CLI module is not configured: set ADGUARD_LICENSE_KEY.',
            );
            await expect(blocker.stop()).resolves.toEqual({ licenceReleased: false });
        } finally {
            rmSync(workspaceDir, { recursive: true, force: true });
        }
    }, 30_000);
});
