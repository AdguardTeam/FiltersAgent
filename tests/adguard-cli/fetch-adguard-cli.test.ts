import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DESTINATION = mkdtempSync(join(tmpdir(), 'adguard-cli-fetch-test-'));

afterAll(() => {
    rmSync(DESTINATION, { recursive: true, force: true });
});

/*
 * A pre-release CLI rejected valid certificate chains a stable release accepts, and every run on it
 * analyzed traffic nothing had filtered. The installer is the one place every pin passes through,
 * so it refuses a pre-release before it downloads a byte. The host below does not resolve: a pin
 * that got past the check would fail on the download instead, naming no release.
 */
/**
 * Exit code the installer refuses a pin with, before any download.
 */
const REFUSED = 2;

/**
 * Run the installer for one release tag on a host that does not resolve.
 *
 * @param tag - Release tag in the archive URL.
 * @returns The installer's exit status and stderr.
 */
function install(tag: string): { status: number | null; stderr: string } {
    const url =
        `https://releases.invalid/AdguardTeam/AdGuardCLI/releases/download/${tag}/` +
        'adguard-cli-linux-x86_64.tar.gz';
    const result = spawnSync(
        process.execPath,
        [join(REPO_ROOT, 'scripts', 'fetch-adguard-cli.mjs'), url, 'a'.repeat(64), DESTINATION],
        { encoding: 'utf8' },
    );
    return { status: result.status, stderr: result.stderr };
}

describe('fetch-adguard-cli', () => {
    it.each(['v1.5.0-rc.1', 'v1.4.14-beta', 'v1.5.0-nightly.9'])(
        'refuses to install the pre-release %s',
        (tag) => {
            const result = install(tag);

            expect(result.status).toBe(REFUSED);
            expect(result.stderr).toContain(tag);
        },
    );

    it('lets a stable release through to the download', () => {
        // The download itself fails here: the host does not resolve.
        expect(install('v1.4.13-release').status).not.toBe(REFUSED);
    });
});
