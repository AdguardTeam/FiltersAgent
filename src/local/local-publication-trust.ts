/**
 * The publication trust boundary: what publication refuses to publish, and the vocabulary it
 * refuses in.
 *
 * The resource caps an evidence artifact must stay under, the control-character check every path is
 * screened by, the stable failure codes and the error that carries one, the digest an artifact is
 * named by, the relative-path normalization every persisted path goes through, and the two records
 * a screenshot ends up as — published capture or typed omission.
 *
 * These are the checks themselves, not the manifest that reports their outcome: the sanitizer, the
 * PNG normalizer, the publisher and the verifier all reach for them without needing a manifest, and
 * nothing here needs one back. `local-publication-manifest` is the layer above, and it is the only
 * direction the dependency runs.
 */
import { createHash } from 'node:crypto';
import { isAbsolute, sep as pathSeparator } from 'node:path';
import type * as v from 'valibot';

/**
 * Maximum bytes in one published evidence artifact.
 */
export const MAX_EVIDENCE_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Maximum decoded pixel count accepted by the trusted PNG normalizer.
 */
export const MAX_CAPTURE_PIXELS = 50_000_000;

/**
 * Check whether text contains a disallowed control character.
 *
 * @param value - Text inspected before path use.
 * @returns Whether one C0 or DEL control character is present.
 */
export function hasUnsafeControl(value: string): boolean {
    return Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
    });
}

/**
 * Trust-boundary failure codes that must never produce a visible publication marker.
 */
export const LocalPublicationTrustFailureCode = {
    /**
     * The evidence collection as a whole failed a safety check.
     */
    UnsafeCollection: 'unsafe_collection',

    /**
     * An individual evidence artifact failed a safety or integrity check.
     */
    UnsafeArtifact: 'unsafe_artifact',

    /**
     * The artifact kind is not one publication accepts.
     */
    UnsupportedArtifact: 'unsupported_artifact',

    /**
     * The artifact exceeds a supported resource limit.
     */
    ArtifactLimit: 'artifact_limit',

    /**
     * Required pixel redaction could not be proven applied.
     */
    RedactionFailed: 'redaction_failed',

    /**
     * A secret pattern remained in the artifact after sanitization.
     */
    ResidualSecret: 'residual_secret',

    /**
     * Trusted image normalization proof is invalid.
     */
    InvalidImageProof: 'invalid_image_proof',
} as const;

/**
 * LocalPublicationTrustFailureCode value.
 */
export type LocalPublicationTrustFailureCode =
    (typeof LocalPublicationTrustFailureCode)[keyof typeof LocalPublicationTrustFailureCode];

/**
 * Fail-closed evidence sanitization or publication-integrity error.
 */
export class LocalPublicationTrustError extends Error {
    /**
     * Create a stable non-sensitive trust failure.
     *
     * The optional detail names the failing check and artifact for job logs — a collection-relative
     * path, an artifact basename, or an inner failure code, never file content or an absolute host
     * path. Only the code is ever persisted into publication markers; an anonymous message costs a
     * full evidence-archive reproduction to attribute (a bare "unsafe artifact" can hide git
     * rejecting a transport-damaged review checkout).
     *
     * @param code - Stable failure classification.
     * @param detail - Optional bounded diagnostic naming the failed check.
     */
    constructor(
        readonly code: LocalPublicationTrustFailureCode,
        readonly detail?: string,
    ) {
        let message = 'Evidence collection contains an unsafe artifact.';
        if (code === 'artifact_limit') {
            message = 'Evidence exceeds a supported resource limit.';
        } else if (code === 'redaction_failed' || code === 'residual_secret') {
            message = 'Evidence could not be proven sanitized.';
        } else if (code === 'invalid_image_proof') {
            message = 'Trusted image normalization proof is invalid.';
        }
        super(detail === undefined ? message : `${message} [${detail}]`);
        this.name = 'LocalPublicationTrustError';
    }
}

/**
 * Published trusted capture evidence.
 */
export interface PublishedImageCapture {
    /**
     * Capture discriminator.
     */
    kind: 'capture';

    /**
     * Normalized collection-relative path.
     */
    path: string;

    /**
     * Stable semantic role.
     */
    role: string;

    /**
     * Opaque Host proof identity.
     */
    proofId: string;

    /**
     * SHA-256 of normalized metadata-free PNG bytes.
     */
    sha256: string;

    /**
     * Exact normalized PNG byte count.
     */
    bytes: number;

    /**
     * Decoded capture width.
     */
    width: number;

    /**
     * Decoded capture height.
     */
    height: number;
}

/**
 * Typed omission replacing untrusted screenshot bytes.
 */
export interface PublishedImageOmission {
    /**
     * Omission discriminator.
     */
    kind: 'omitted';

    /**
     * Normalized collection-relative source path.
     */
    path: string;

    /**
     * Stable semantic role.
     */
    role: 'browser_evidence';

    /**
     * Stable reason that no raw bytes or digest were published.
     */
    reason: 'untrusted_image_without_pixel_redaction_proof';
}

/**
 * Calculate SHA-256 for exact bytes.
 *
 * @param bytes - Bytes to digest.
 * @returns Lowercase SHA-256.
 */
export function sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Normalize and validate one portable relative artifact path.
 *
 * @param path - Slash-separated candidate path.
 * @returns Exact normalized path.
 */
export function normalizeEvidencePath(path: string): string {
    const normalized = path.split(pathSeparator).join('/');
    if (
        normalized.length === 0 ||
        isAbsolute(normalized) ||
        normalized.includes('\\') ||
        hasUnsafeControl(normalized) ||
        normalized.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
    ) {
        throw new LocalPublicationTrustError('unsafe_artifact');
    }
    return normalized;
}

/**
 * Name a failed schema check by its key path and check type, never by the value it rejected.
 *
 * @param issue - First Valibot issue of the failed parse.
 * @returns Bounded diagnostic such as `schema: images max_length`.
 */
export function schemaIssueDetail(issue: v.BaseIssue<unknown>): string {
    const keys = (issue.path ?? []).map((item) => String(item.key)).join('.');
    return `schema: ${keys.length === 0 ? '(root)' : keys} ${issue.type}`;
}
