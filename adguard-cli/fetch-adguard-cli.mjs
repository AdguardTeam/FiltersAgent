#!/usr/bin/env node
/**
 * Fetch one pinned AdGuard CLI release archive, check its SHA-256, extract it, and verify the
 * binary's Ed25519 signature against the key AdGuard publishes
 * (https://github.com/AdguardTeam/AdGuardCLI#verify-releases).
 *
 * Callers pass the pinned release URL and checksum — the AdGuard CLI module's setup action takes
 * them from its `releaseUrl` and `releaseSha256` inputs — so every install of one pin runs the same
 * verified binary.
 *
 * Usage: fetch-adguard-cli.mjs <archive-url> <sha256> <destination-dir>
 */
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * AdGuard's published Ed25519 release key, SPKI DER in base64.
 */
const ADGUARD_RELEASE_PUBLIC_KEY = 'MCowBQYDK2VwAyEAN0NPZFtolGN+Cjyorh4Wo91vnBlLLQiWkbujeHDYbok=';

const [url, expectedSha256, destination] = process.argv.slice(2);
if (!url || !expectedSha256 || !destination) {
    console.error('Usage: fetch-adguard-cli.mjs <archive-url> <sha256> <destination-dir>');
    process.exit(2);
}

const response = await fetch(url);
if (!response.ok) {
    throw new Error(`AdGuard CLI download failed: HTTP ${response.status} for ${url}`);
}
const archive = Buffer.from(await response.arrayBuffer());
const actualSha256 = createHash('sha256').update(archive).digest('hex');
if (actualSha256 !== expectedSha256) {
    throw new Error(`AdGuard CLI archive checksum ${actualSha256} != pinned ${expectedSha256}`);
}

const scratch = mkdtempSync(join(tmpdir(), 'adguard-cli-fetch-'));
try {
    const archivePath = join(scratch, 'adguard-cli.tar.gz');
    writeFileSync(archivePath, archive);
    mkdirSync(destination, { recursive: true });
    execFileSync('tar', ['-xzf', archivePath, '-C', destination, '--strip-components=1']);
} finally {
    rmSync(scratch, { recursive: true, force: true });
}

const binary = join(destination, 'adguard-cli');
const key = createPublicKey({
    key: Buffer.from(ADGUARD_RELEASE_PUBLIC_KEY, 'base64'),
    format: 'der',
    type: 'spki',
});
if (!verify(null, readFileSync(binary), key, readFileSync(`${binary}.sig`))) {
    throw new Error('AdGuard CLI signature does not verify');
}
console.log(`adguard-cli signature verified (${destination})`);
