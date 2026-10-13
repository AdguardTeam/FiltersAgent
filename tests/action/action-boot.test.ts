import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The repository root the smoke boots the face from: the sources path the Docker image's
 * tsx-over-node boot resolves against the checkout root it runs with.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The action face module the image boots through tsx, relative to the boot cwd exactly as the
 * image's entrypoint passes it.
 */
const ACTION_MAIN_ENTRY_PATH = 'src/action/action-main.ts';

/**
 * Boot environment for the smoke test: explicitly swept to `PATH` and `HOME` only, so a developer's
 * real environment cannot flip the outcome. `PATH` keeps the node executable resolvable for the tsx
 * loader's own subprocess needs, `HOME` keeps user-relative caches inert but defined.
 */
const SWEPT_BOOT_ENV = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
};

/**
 * Problem name the named failure on the swept boot's stderr must carry. The binding requires the
 * runner's workspace before it maps any input — GitHub binds `GITHUB_WORKSPACE` for every action it
 * runs, and the swept environment has none — so the boot fails named on the workspace, before the
 * resolver's combined input problems are reachable.
 */
const SWEPT_BOOT_EXPECTED_PROBLEM = 'GITHUB_WORKSPACE is required';

/**
 * Budget for one cold subprocess boot. The child transpiles the face's whole module graph through
 * tsx with an empty cache on CI, while the other vitest worker runs browser suites; the default
 * 5-second test timeout is sized for in-process tests, not for this.
 */
const COLD_BOOT_TIMEOUT_MS = 60_000;

describe('action face offline boot', () => {
    it(
        'boots the sources through tsx to the named missing-workspace failure offline',
        () => {
            const boot = spawnSync(process.execPath, ['--import', 'tsx', ACTION_MAIN_ENTRY_PATH], {
                cwd: REPO_ROOT,
                encoding: 'utf8',
                env: SWEPT_BOOT_ENV,
            });

            expect(boot.status).not.toBe(0);
            const stderr = boot.stderr ?? '';
            expect(stderr).toContain(SWEPT_BOOT_EXPECTED_PROBLEM);
        },
        COLD_BOOT_TIMEOUT_MS,
    );
});
