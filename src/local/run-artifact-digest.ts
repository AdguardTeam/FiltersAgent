import { createHash } from 'node:crypto';
import {
    closeSync,
    constants,
    existsSync,
    fstatSync,
    lstatSync,
    openSync,
    readFileSync,
    readdirSync,
} from 'node:fs';
import { join, relative, sep as currentOperatingSystemPathComponentSeparator } from 'node:path';
import * as v from 'valibot';

/**
 * The content-addressing primitives a locked fix-agent run is built and re-proved with: the digest
 * entry shape a manifest records, the SHA-256 of an artifact's exact bytes, and the no-follow,
 * single-link read every locked artifact is opened through.
 *
 * They live apart from the manifest itself because they are version-agnostic — every version of the
 * lock addresses its artifacts the same way, and only the set of bound artifacts differs.
 */

export const LocalRunArtifactDigestSchema = v.object({
    path: v.pipe(v.string(), v.minLength(1)),
    sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
    bytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

/**
 * Compute the lowercase SHA-256 digest of a UTF-8 artifact.
 *
 * @param content - Exact UTF-8 content written to disk.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
export function sha256Text(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Compute the lowercase SHA-256 digest of exact binary artifact bytes.
 *
 * @param content - Exact file bytes read through a no-follow descriptor.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
export function sha256Bytes(content: Buffer): string {
    return createHash('sha256').update(content).digest('hex');
}

/**
 * Describe one canonical artifact for the lock manifest.
 *
 * @param path - Canonical file name relative to the run directory.
 * @param content - Exact UTF-8 file content.
 * @returns Digest and byte length bound to the canonical path.
 */
export function createArtifactDigest(path: string, content: string) {
    return {
        path,
        sha256: sha256Text(content),
        bytes: Buffer.byteLength(content, 'utf8'),
    };
}

/**
 * Read one immutable regular file without following a final symlink or accepting hardlinks.
 *
 * @param path - Canonical file path to open.
 * @param label - Stable artifact label used in failures.
 * @returns Exact bytes read from the checked file descriptor.
 */
export function readImmutableFile(path: string, label: string): Buffer {
    let descriptor: number | undefined;
    try {
        descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const stats = fstatSync(descriptor);
        if (!stats.isFile() || stats.nlink !== 1) {
            throw new Error(`Run artifact must be an unlinked regular file: ${label}.`);
        }
        return readFileSync(descriptor);
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('Run artifact must')) {
            throw error;
        }
        throw new Error(
            `Cannot read immutable run artifact ${label}: ${(error as Error).message}`,
            {
                cause: error,
            },
        );
    } finally {
        if (descriptor !== undefined) {
            closeSync(descriptor);
        }
    }
}

/**
 * Recursively digest every browser, vision, network, and trace file under artifacts/.
 *
 * @param outputPath - Canonical run directory containing the evidence subtree.
 * @returns Lexically ordered relative evidence digests.
 */
export function collectEvidenceDigests(
    outputPath: string,
): v.InferOutput<typeof LocalRunArtifactDigestSchema>[] {
    const evidenceRoot = join(outputPath, 'artifacts');
    if (!existsSync(evidenceRoot)) {
        return [];
    }
    const rootStats = lstatSync(evidenceRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw new Error('Locked artifacts path must be a regular directory.');
    }
    const digests: v.InferOutput<typeof LocalRunArtifactDigestSchema>[] = [];

    /**
     * Walk one evidence directory without following links.
     *
     * @param directory - Current canonical directory beneath artifacts/.
     */
    function walk(directory: string): void {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            const stats = lstatSync(path);
            if (stats.isSymbolicLink()) {
                throw new Error(`Locked evidence must not contain symlinks: ${entry.name}.`);
            }
            if (stats.isDirectory()) {
                walk(path);
                continue;
            }
            if (!stats.isFile()) {
                throw new Error(`Locked evidence must contain only files: ${entry.name}.`);
            }
            const content = readImmutableFile(path, entry.name);
            digests.push({
                path: relative(outputPath, path)
                    .split(currentOperatingSystemPathComponentSeparator)
                    .join('/'),
                sha256: sha256Bytes(content),
                bytes: content.byteLength,
            });
        }
    }

    walk(evidenceRoot);
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is outside this project target.
    return digests.sort((first, second) => first.path.localeCompare(second.path));
}
