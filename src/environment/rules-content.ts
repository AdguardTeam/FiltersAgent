import { createHash } from 'node:crypto';

/**
 * Content helpers of the blocker state the host reads back and compares.
 *
 * The host reads the blocker state itself and credits an application only when that state contains
 * exactly the expected content. Both the readers and the expected side digest through the one
 * normalization, so a digest is always taken over the same bytes wherever it is computed. The
 * helpers live under `src/environment/` because the environment layer consumes them and must not
 * import them back from `src/validator/`.
 */

/**
 * Compute the SHA-256 hex digest over exact content bytes.
 *
 * @param content - Exact content.
 * @returns The lowercase hex digest.
 */
export function sha256OfContent(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Normalize rules content the one way every comparison reads it: strip the outer storage whitespace
 * the extension and the file-backed storages round-trip around the rule lines. Both the readers and
 * the expected side digest through this function, so a digest is always taken over the same bytes
 * wherever it is computed.
 *
 * @param content - Exact content as the state exposes it.
 * @returns The content without its outer whitespace.
 */
export function normalizeRulesContent(content: string): string {
    return content.trim();
}

/**
 * The read-back fields the observed digest is derived from: the exact rules content when the reader
 * exposes it, and the reader-computed digest for a read-back that carries no content.
 */
export interface ObservedRulesRead {
    /**
     * Exact rule content the state carries, when the reader exposes it.
     */
    rulesContent?: string;

    /**
     * SHA-256 over the exact rule content, when the state exposes only its digest.
     */
    rulesContentSha256?: string;
}

/**
 * Derive the observed rules digest one way for every read-back: from the normalized content when
 * the reader provides content, and from the reader-supplied digest only when it does not. A
 * read-back whose content disagrees with its own digest is judged by the content, so every
 * comparison digests the same bytes.
 *
 * @param read - The host read-back carrying content, a digest, or both.
 * @returns The observed digest, or undefined when the read-back carries neither.
 */
export function observedRulesDigest(read: ObservedRulesRead): string | undefined {
    if (read.rulesContent === undefined) {
        return read.rulesContentSha256;
    }
    return sha256OfContent(normalizeRulesContent(read.rulesContent));
}
