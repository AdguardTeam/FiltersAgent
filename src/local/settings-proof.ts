/**
 * The settings-proof artifact: the one place a run's verified extension settings evidence is
 * written to disk and read back.
 *
 * Both ends are ours — the host read-back of the blocker state produces the evidence, the core
 * writes it, the local report reads it — so the file is trusted data, not external input: it is
 * parsed and cast to the producer's own type. A proof whose shape does not match is a bug in the
 * writer and must surface as one, never be smoothed over by a shape check here.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { AdGuardExtensionSettingsEvidence } from '../browser/adguard-extension-state-shapes';

/**
 * File name of the settings-proof artifact inside a run's artifacts directory.
 *
 * Named once here because the writer and every reader have to agree on it, and a run whose proof
 * lands under a second spelling reports "no proof" instead of failing.
 */
export const SETTINGS_PROOF_FILE_NAME = 'settings-proof.json';

/**
 * Write one run's verified extension settings evidence as its proof artifact.
 *
 * @param path - Destination path; the containing directory must already exist.
 * @param evidence - Settings evidence the host read back from the blocker state.
 * @returns The serialized JSON, so the caller can register the artifact's byte length.
 */
export function writeSettingsProof(
    path: string,
    evidence: AdGuardExtensionSettingsEvidence,
): string {
    const serialized = JSON.stringify(evidence, null, 2);
    writeFileSync(path, serialized);
    return serialized;
}

/**
 * Read back the settings proof a run wrote.
 *
 * A run that applied no settings profile writes no proof, so a missing path and an unreadable file
 * both mean "this run has no proof" rather than a malformed one.
 *
 * @param path - Settings-proof artifact path, or null/undefined when the run wrote none.
 * @returns The recorded settings evidence, or null when the run has no readable proof.
 */
export function readSettingsProof(
    path: string | null | undefined,
): AdGuardExtensionSettingsEvidence | null {
    if (!path) {
        return null;
    }
    let raw: string;
    try {
        raw = readFileSync(path, 'utf8');
    } catch {
        return null;
    }
    return JSON.parse(raw) as AdGuardExtensionSettingsEvidence;
}
