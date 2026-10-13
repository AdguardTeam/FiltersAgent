import {
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    openSync,
    readFileSync,
    readdirSync,
    realpathSync,
} from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { STORAGE_SENSITIVE_KEY_PATTERNS } from '../browser/har-redactor';
import { redactText } from '../tracer/redact-text';
import { redactPayload, type RedactPayloadOptions } from '../tracer/redactor';
import {
    LocalPublicationTrustError,
    MAX_EVIDENCE_FILE_BYTES,
    normalizeEvidencePath,
    sha256,
    type PublishedImageCapture,
    type PublishedImageOmission,
} from './local-publication-trust';
import {
    trustedCaptureData,
    type TrustedCaptureData,
    type TrustedNormalizedCapture,
} from './png-normalizer';

/**
 * The untrusted-evidence boundary: a raw run collection in, an opaque sanitized pack out.
 *
 * Everything here treats its input as hostile. An artifact is read under an open descriptor and
 * re-stat'd so a file that changed mid-read is refused rather than published; text and structured
 * evidence go through the one redaction pass; a raw image is omitted with a classified reason
 * rather than copied, and only a Host-issued normalized capture is published in its place. The
 * sanitized bytes are held off the returned value, so a caller cannot hand a mutated buffer back.
 */

/**
 * Maximum number of published evidence artifacts.
 *
 * Full-page tile coverage on very tall pages legitimately produces ~50 files per capture and a
 * candidate run takes several such captures (control, prepared, validation phases). The byte guards
 * below remain the actual resource ceiling.
 */
export const MAX_EVIDENCE_FILES = 1024;

/**
 * Maximum aggregate published evidence bytes.
 */
export const MAX_EVIDENCE_TOTAL_BYTES = 512 * 1024 * 1024;

/**
 * Raw browser and reporter image formats omitted unless a PNG has Host proof.
 */
const UNTRUSTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/**
 * Digest and size of one sanitized publication artifact.
 */
export interface SanitizedEvidenceArtifact {
    /**
     * Normalized collection-relative path.
     */
    path: string;

    /**
     * SHA-256 of exact sanitized bytes.
     */
    sha256: string;

    /**
     * Exact sanitized byte count.
     */
    bytes: number;
}

declare const sanitizedEvidenceBrand: unique symbol;

/**
 * Opaque sanitized evidence pack and its consumer-safe digest projection.
 */
export interface SanitizedEvidencePack {
    /**
     * Compile-time opaque sanitized-pack marker.
     */
    readonly [sanitizedEvidenceBrand]: true;

    /**
     * Lexically ordered sanitized artifact digests.
     */
    readonly artifacts: readonly SanitizedEvidenceArtifact[];

    /**
     * Trusted captures and typed image omissions.
     */
    readonly images: readonly (PublishedImageCapture | PublishedImageOmission)[];
}

/**
 * Private sanitized bytes keyed by opaque pack.
 */
const sanitizedEvidenceBytes = new WeakMap<object, ReadonlyMap<string, Buffer>>();

/**
 * Inputs for sanitizing one private raw evidence collection.
 */
export interface SanitizeEvidenceCollectionOptions {
    /**
     * Exact private collection directory.
     */
    collectionDir: string;

    /**
     * Exact Host-configured secrets that must not survive.
     */
    configuredSecrets: readonly string[];

    /**
     * Optional Host-issued trusted capture proofs.
     */
    trustedCaptures?: readonly TrustedNormalizedCapture[];
}

/**
 * Read one stable no-follow single-link artifact with byte limits enforced before allocation.
 *
 * @param path - Exact artifact path.
 * @returns Exact bytes.
 */
export function readStableArtifact(path: string): Buffer {
    const artifact = basename(path);
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
        throw new LocalPublicationTrustError('unsafe_artifact', `${artifact}: unstable file`);
    }
    if (before.size > MAX_EVIDENCE_FILE_BYTES) {
        throw new LocalPublicationTrustError('artifact_limit', artifact);
    }
    let descriptor: number | undefined;
    try {
        descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = fstatSync(descriptor);
        if (
            !opened.isFile() ||
            opened.nlink !== 1 ||
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            opened.size !== before.size
        ) {
            throw new LocalPublicationTrustError('unsafe_artifact', `${artifact}: identity moved`);
        }
        const bytes = readFileSync(descriptor);
        const after = fstatSync(descriptor);
        if (
            bytes.byteLength !== opened.size ||
            after.dev !== opened.dev ||
            after.ino !== opened.ino ||
            after.size !== opened.size ||
            after.mtimeMs !== opened.mtimeMs
        ) {
            throw new LocalPublicationTrustError(
                'unsafe_artifact',
                `${artifact}: changed during read`,
            );
        }
        return bytes;
    } catch (error) {
        if (error instanceof LocalPublicationTrustError) {
            throw error;
        }
        throw new LocalPublicationTrustError('unsafe_artifact', `${artifact}: unreadable`);
    } finally {
        if (descriptor !== undefined) {
            closeSync(descriptor);
        }
    }
}

/**
 * Decode exact UTF-8 or fail the sanitization boundary.
 *
 * @param bytes - Exact artifact bytes.
 * @returns Decoded text.
 */
function decodeText(bytes: Buffer): string {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        throw new LocalPublicationTrustError('redaction_failed');
    }
}

/**
 * How the ONE redaction pass is configured for UNTRUSTED structured evidence.
 *
 * A page's own storage dump, a HAR, a safe-interaction record. Same key table as the Host-produced
 * artifacts in `sanitizedJsonBytes`, and deliberately no `preservedStructuredKeys`: nothing here is
 * schema-validated on the way out, so no container has a claim to survive a key verdict.
 */
const UNTRUSTED_EVIDENCE_REDACTION: RedactPayloadOptions = {
    sensitiveKeyPatterns: STORAGE_SENSITIVE_KEY_PATTERNS,
};

/**
 * Sanitize one registered text or structured artifact.
 *
 * @param path - Normalized relative path.
 * @param bytes - Exact untrusted bytes.
 * @param secrets - Exact Host-configured secrets.
 * @returns Sanitized deterministic bytes.
 */
function sanitizeArtifact(path: string, bytes: Buffer, secrets: readonly string[]): Buffer {
    const extension = extname(path).toLowerCase();
    const text = decodeText(bytes);
    try {
        if (extension === '.json' || extension === '.har') {
            return Buffer.from(
                `${JSON.stringify(
                    redactPayload(JSON.parse(text), secrets, UNTRUSTED_EVIDENCE_REDACTION),
                    null,
                    2,
                )}\n`,
                'utf8',
            );
        }
        if (extension === '.jsonl') {
            const lines = text
                .split(/\r?\n/u)
                .filter((line) => line.length > 0)
                .map((line) =>
                    JSON.stringify(
                        redactPayload(JSON.parse(line), secrets, UNTRUSTED_EVIDENCE_REDACTION),
                    ),
                );
            return Buffer.from(lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8');
        }
        if (['.txt', '.md', '.log', '.html'].includes(extension)) {
            return Buffer.from(redactText(text, secrets), 'utf8');
        }
    } catch {
        throw new LocalPublicationTrustError('redaction_failed');
    }
    throw new LocalPublicationTrustError('unsupported_artifact');
}

/**
 * Prove that no exact configured secret survived in sanitized bytes.
 *
 * @param bytes - Sanitized artifact bytes.
 * @param secrets - Exact Host-configured secrets.
 */
export function assertNoResidualSecrets(bytes: Buffer, secrets: readonly string[]): void {
    for (const secret of secrets) {
        if (secret.length > 0 && bytes.includes(Buffer.from(secret, 'utf8'))) {
            throw new LocalPublicationTrustError('residual_secret');
        }
    }
}

/**
 * Sanitize a private raw collection into an opaque immutable evidence pack.
 *
 * Raw PNG files are classified from their paths and omitted without reading. Only matching opaque
 * Host-issued normalized captures contribute image bytes.
 *
 * @param options - Collection root, exact secrets and optional trusted captures.
 * @returns Opaque sanitized pack with digest-only public projection.
 */
export function sanitizeEvidenceCollection(
    options: SanitizeEvidenceCollectionOptions,
): SanitizedEvidencePack {
    const rootStats = lstatSync(options.collectionDir);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw new LocalPublicationTrustError('unsafe_collection');
    }
    const root = realpathSync(options.collectionDir);
    const trustedByPath = new Map<string, TrustedCaptureData>();
    for (const capture of options.trustedCaptures ?? []) {
        const data = trustedCaptureData.get(capture);
        if (!data) {
            continue;
        }
        if (trustedByPath.has(data.relativePath)) {
            throw new LocalPublicationTrustError('invalid_image_proof');
        }
        trustedByPath.set(data.relativePath, data);
    }
    const bytesByPath = new Map<string, Buffer>();
    const images: (PublishedImageCapture | PublishedImageOmission)[] = [];
    let discoveredFiles = 0;
    let aggregateBytes = 0;

    /**
     * Walk one collection directory without following links.
     *
     * @param directory - Current canonical directory.
     */
    function walk(directory: string): void {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            const stats = lstatSync(path);
            if (stats.isSymbolicLink()) {
                throw new LocalPublicationTrustError('unsafe_artifact');
            }
            if (stats.isDirectory()) {
                walk(path);
                continue;
            }
            if (!stats.isFile()) {
                throw new LocalPublicationTrustError('unsafe_artifact');
            }
            discoveredFiles += 1;
            if (discoveredFiles > MAX_EVIDENCE_FILES) {
                throw new LocalPublicationTrustError('artifact_limit');
            }
            const relativePath = normalizeEvidencePath(relative(root, path));
            const extension = extname(relativePath).toLowerCase();
            if (UNTRUSTED_IMAGE_EXTENSIONS.has(extension)) {
                const trusted = extension === '.png' ? trustedByPath.get(relativePath) : undefined;
                if (!trusted) {
                    images.push({
                        kind: 'omitted',
                        path: relativePath,
                        role: 'browser_evidence',
                        reason: 'untrusted_image_without_pixel_redaction_proof',
                    });
                    continue;
                }
                const normalized = Buffer.from(trusted.bytes);
                assertNoResidualSecrets(normalized, options.configuredSecrets);
                aggregateBytes += normalized.byteLength;
                if (
                    normalized.byteLength > MAX_EVIDENCE_FILE_BYTES ||
                    aggregateBytes > MAX_EVIDENCE_TOTAL_BYTES
                ) {
                    throw new LocalPublicationTrustError('artifact_limit');
                }
                bytesByPath.set(relativePath, normalized);
                images.push({
                    kind: 'capture',
                    path: relativePath,
                    role: trusted.role,
                    proofId: trusted.proofId,
                    sha256: sha256(normalized),
                    bytes: normalized.byteLength,
                    width: trusted.width,
                    height: trusted.height,
                });
                continue;
            }
            const raw = readStableArtifact(path);
            let sanitized: Buffer;
            try {
                sanitized = sanitizeArtifact(relativePath, raw, options.configuredSecrets);
            } finally {
                raw.fill(0);
            }
            assertNoResidualSecrets(sanitized, options.configuredSecrets);
            aggregateBytes += sanitized.byteLength;
            if (
                sanitized.byteLength > MAX_EVIDENCE_FILE_BYTES ||
                aggregateBytes > MAX_EVIDENCE_TOTAL_BYTES
            ) {
                throw new LocalPublicationTrustError('artifact_limit');
            }
            bytesByPath.set(relativePath, sanitized);
        }
    }

    walk(root);
    const artifacts = [...bytesByPath.entries()]
        .map(([path, bytes]) => ({ path, sha256: sha256(bytes), bytes: bytes.byteLength }))
        // oxlint-disable-next-line unicorn/no-array-sort -- This pipeline owns its fresh array.
        .sort((left, right) => left.path.localeCompare(right.path));
    // oxlint-disable-next-line unicorn/no-array-sort -- This local array is not shared.
    images.sort((left, right) => left.path.localeCompare(right.path));
    const pack = Object.freeze({
        artifacts: Object.freeze(artifacts.map((artifact) => Object.freeze(artifact))),
        images: Object.freeze(images.map((image) => Object.freeze(image))),
    }) as unknown as SanitizedEvidencePack;
    sanitizedEvidenceBytes.set(
        pack,
        new Map([...bytesByPath.entries()].map(([path, bytes]) => [path, Buffer.from(bytes)])),
    );
    return pack;
}

/**
 * Copy exact sanitized bytes from an opaque evidence pack.
 *
 * @param pack - Host-issued sanitized pack.
 * @param path - Exact normalized artifact path.
 * @returns Defensive byte copy.
 */
export function copySanitizedEvidenceArtifact(pack: SanitizedEvidencePack, path: string): Buffer {
    const bytes = sanitizedEvidenceBytes.get(pack)?.get(normalizeEvidencePath(path));
    if (!bytes) {
        throw new LocalPublicationTrustError('unsafe_artifact');
    }
    return Buffer.from(bytes);
}
