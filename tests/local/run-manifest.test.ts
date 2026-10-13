import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    LOCAL_RUN_MANIFEST_FILE_NAME,
    LOCAL_RUN_MANIFEST_VERSION_VALUES,
    verifyLocalRunManifest,
} from '../../src/local/run-manifest';
import { UnsupportedArtifactVersionError } from '../../src/types/versioned-document';

/**
 * Manifest version a run locked before the pi usage migration declares.
 *
 * That era bound a per-attempt `llm-usage.jsonl` ledger and a ledger-shaped usage summary, and
 * neither writer exists any more, so the verifier has to refuse the run rather than prove an
 * artifact set it cannot reconstruct.
 */
const LEDGER_ERA_MANIFEST_VERSION = 2;

/**
 * Lay down one run directory holding nothing but a manifest declaring the given version.
 *
 * Version rejection happens before any digest is opened, so an unreadable version needs no
 * artifacts behind it to be provable.
 *
 * @param schemaVersion - Version the manifest declares.
 * @returns Absolute path to the new directory.
 */
function writeRunDirectoryWithManifestVersion(schemaVersion: number): string {
    const runDirectory = mkdtempSync(join(tmpdir(), 'locked-run-version-'));
    writeFileSync(
        join(runDirectory, LOCAL_RUN_MANIFEST_FILE_NAME),
        `${JSON.stringify({ schemaVersion, runId: 'a'.repeat(64), artifacts: {}, evidence: [] }, null, 2)}\n`,
        'utf8',
    );
    return runDirectory;
}

describe('verifyLocalRunManifest version handling', () => {
    it.each([
        ['a run locked before the pi usage migration', LEDGER_ERA_MANIFEST_VERSION],
        ['a run locked by a newer build', Math.max(...LOCAL_RUN_MANIFEST_VERSION_VALUES) + 1],
    ])('refuses %s by version number', (_case, schemaVersion) => {
        const runDirectory = writeRunDirectoryWithManifestVersion(schemaVersion);
        try {
            expect(() => verifyLocalRunManifest(runDirectory)).toThrow(
                UnsupportedArtifactVersionError,
            );
            expect(() => verifyLocalRunManifest(runDirectory)).toThrow(
                new RegExp(`schemaVersion ${schemaVersion}\\b`, 'u'),
            );
        } finally {
            rmSync(runDirectory, { recursive: true, force: true });
        }
    });
});
