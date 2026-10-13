/**
 * The two candidate screenshots a run publishes: the verified candidate's viewport capture without
 * the rule (the symptom visible) and with it (the symptom gone).
 */
import { readFileSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, relative, sep } from 'node:path';
import type { VerifiedCandidateScreenshotPaths } from '../../src/types/fix-run-result';
import { normalizeTrustedPngCapture } from '../../src/local/png-normalizer';
import type { TrustedNormalizedCapture } from '../../src/local/png-normalizer';

/**
 * Semantic role of a published candidate screenshot.
 */
export const CandidateScreenshotRole = {
    Before: 'candidate-before',
    After: 'candidate-after',
} as const;
export type CandidateScreenshotRole =
    (typeof CandidateScreenshotRole)[keyof typeof CandidateScreenshotRole];

/**
 * Proof identity of a candidate screenshot.
 *
 * Product decision (2026-09-29): both images are captures of the run's own clean headless browser
 * on the reporter's public page, never of the reporter's browser, so they carry no reporter pixels
 * and are published without pixel redaction.
 */
export const OWN_BROWSER_PUBLIC_PAGE_PROOF_ID = 'own-browser-public-page';

/**
 * The only image extension a trusted capture may have.
 */
const PNG_EXTENSION = '.png';

/**
 * Read one recorded screenshot into a trusted capture keyed by its collection-relative path.
 *
 * @param recordedPath - Absolute path the run recorded inside the private collection.
 * @param collectionRoot - Canonical private collection directory.
 * @param role - Semantic role of the image.
 * @returns Opaque trusted capture.
 */
function captureRecordedScreenshot(
    recordedPath: string,
    collectionRoot: string,
    role: CandidateScreenshotRole,
): TrustedNormalizedCapture {
    if (extname(recordedPath).toLowerCase() !== PNG_EXTENSION) {
        throw new Error(`The ${role} screenshot is not a PNG file: ${recordedPath}`);
    }
    let canonicalPath: string;
    let pngBytes: Buffer;
    try {
        canonicalPath = realpathSync(recordedPath);
        pngBytes = readFileSync(canonicalPath);
    } catch (error) {
        throw new Error(`The ${role} screenshot cannot be read: ${recordedPath}`, {
            cause: error,
        });
    }
    const relativePath = relative(collectionRoot, canonicalPath);
    if (
        relativePath === '' ||
        relativePath === '..' ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
    ) {
        throw new Error(
            `The ${role} screenshot lies outside the evidence collection: ${recordedPath}`,
        );
    }
    return normalizeTrustedPngCapture({
        relativePath,
        pngBytes,
        role,
        proofId: OWN_BROWSER_PUBLIC_PAGE_PROOF_ID,
        regions: [],
    });
}

/**
 * Build the trusted captures of the verified candidate's before and after viewport screenshots.
 *
 * The full-page images are not published. A missing or non-PNG recorded screenshot fails loudly: a
 * verified candidate must carry both.
 *
 * @param verified - Screenshot paths recorded for the verified candidate, if the run has one.
 * @param collectionDir - Private evidence collection the recorded paths lie in.
 * @returns The two trusted captures, or none when the run has no verified candidate.
 */
export function buildCandidateScreenshotCaptures(
    verified: VerifiedCandidateScreenshotPaths | undefined,
    collectionDir: string,
): TrustedNormalizedCapture[] {
    if (!verified) {
        return [];
    }
    const collectionRoot = realpathSync(collectionDir);
    return [
        captureRecordedScreenshot(verified.before, collectionRoot, CandidateScreenshotRole.Before),
        captureRecordedScreenshot(verified.after, collectionRoot, CandidateScreenshotRole.After),
    ];
}
