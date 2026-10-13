/**
 * The reporter's own screenshots, downloaded and registered as run artifacts.
 *
 * Split out of `site-analyzer.ts` because it shares nothing with the browser session: the download
 * path runs before a browser exists, and when none can be launched it is the only reporter evidence
 * a run gets. What it guards is one untrusted input — a URL out of an issue body — against three
 * separate risks: reaching a host that is not a reporter image namespace, reaching a non-public
 * address, and buffering an unbounded or non-raster response.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TraceRecorder } from '../tracer/trace-recorder';
import type { IssueScreenshot } from '../types/issue-facts';
import type { MatchedIssueScreenshot } from '../types/site-analysis';
import {
    defaultHostnameResolver,
    validatePublicHttpUrl,
    type HostnameResolver,
} from '../browser/network-safety';
import type { Logger } from '../logger/logger';
import { isReporterImageNamespace } from '../parser/reporter-image-links';

/**
 * Maximum accepted issue screenshot size in bytes.
 */
export const DEFAULT_SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Maximum number of explicitly validated screenshot redirects.
 */
const MAX_SCREENSHOT_REDIRECTS = 3;

/**
 * Raster image content types safe to persist as screenshot artifacts.
 */
const SUPPORTED_SCREENSHOT_CONTENT_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
]);

/**
 * Downloaded and validated screenshot payload.
 */
interface TrustedScreenshotDownload {
    /**
     * Bounded image bytes.
     */
    buffer: Buffer;

    /**
     * Safe filename extension derived from the response content type.
     */
    extension: string;
}

/**
 * Whether an HTTP status represents a redirect that carries a Location header.
 *
 * @param status - HTTP response status.
 * @returns True for 301, 302, 303, 307, and 308.
 */
function isRedirectStatus(status: number): boolean {
    return [301, 302, 303, 307, 308].includes(status);
}

/**
 * Choose a non-executable image extension from a validated image content type.
 *
 * @param contentType - Lowercase MIME type without parameters.
 * @returns Safe image filename extension.
 */
function imageExtension(contentType: string): string {
    if (contentType === 'image/jpeg') {
        return 'jpg';
    }
    if (contentType === 'image/webp') {
        return 'webp';
    }
    if (contentType === 'image/gif') {
        return 'gif';
    }
    return 'png';
}

/**
 * Read a fetch response incrementally while enforcing a hard byte limit.
 *
 * @param response - Successful image response.
 * @param maxBytes - Maximum number of bytes to buffer.
 * @returns Bounded response bytes.
 */
async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error(`Screenshot exceeds the ${maxBytes}-byte limit.`);
    }
    if (!response.body) {
        throw new Error('Screenshot response has no body.');
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            throw new Error(`Screenshot exceeds the ${maxBytes}-byte limit.`);
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks, total);
}

/**
 * Parse an absolute URL, or report that it does not parse.
 *
 * @param rawUrl - The URL text to parse.
 * @returns The parsed URL, or null when the text is not a URL at all.
 */
function parseUrl(rawUrl: string): URL | null {
    try {
        return new URL(rawUrl);
    } catch {
        return null;
    }
}

/**
 * Download one issue screenshot through an HTTPS-only, namespace-checked, redirect-checked path.
 *
 * The reporter-namespace allowlist applies to the link the reporter wrote, not to the hops that
 * link redirects through: where a reporter namespace keeps its bytes is that namespace's own
 * decision. GitHub answers `github.com/user-attachments/assets/<uuid>` with a 302 to a signed
 * `github-production-user-asset-*.s3.amazonaws.com` URL, so an allowlist applied to every hop
 * dropped every GitHub-hosted reporter screenshot. Each hop still passes the full SSRF guard —
 * https only, no credentials, and no hostname resolving to a non-public address.
 *
 * @param rawUrl - Untrusted screenshot URL from the issue body.
 * @param fetcher - Fetch implementation used for each manually followed hop.
 * @param resolveHostname - Resolver used to reject private DNS answers.
 * @param maxBytes - Hard response byte limit.
 * @returns Validated screenshot bytes and safe extension.
 */
async function downloadTrustedScreenshot(
    rawUrl: string,
    fetcher: typeof fetch,
    resolveHostname: HostnameResolver,
    maxBytes: number,
): Promise<TrustedScreenshotDownload> {
    let currentUrl = rawUrl;
    for (let redirects = 0; redirects <= MAX_SCREENSHOT_REDIRECTS; redirects += 1) {
        // The namespace allowlist is the first gate on the reporter's own link, ahead of the DNS
        // lookup inside `validatePublicHttpUrl`: a link outside the namespaces is refused without
        // ever resolving its hostname, so the downloader cannot be pointed at a host to probe it.
        // Redirect hops are the trusted origin's decision and are not held to the allowlist. A
        // link that does not even parse falls through to the validator's own typed refusal.
        if (redirects === 0) {
            const linked = parseUrl(currentUrl);
            if (linked !== null && !isReporterImageNamespace(linked)) {
                throw new Error(
                    `Screenshot URL host '${linked.hostname}' is not a reporter image namespace.`,
                );
            }
        }
        const safeUrl = await validatePublicHttpUrl(currentUrl, {
            httpsOnly: true,
            resolveHostname,
        });
        if (safeUrl.port && safeUrl.port !== '443') {
            throw new Error('Screenshot URL must use the default HTTPS port.');
        }

        const response = await fetcher(safeUrl.href, { redirect: 'manual' });
        if (isRedirectStatus(response.status)) {
            if (redirects === MAX_SCREENSHOT_REDIRECTS) {
                throw new Error('Screenshot redirect limit exceeded.');
            }
            const location = response.headers.get('location');
            if (!location) {
                throw new Error('Screenshot redirect is missing a Location header.');
            }
            currentUrl = new URL(location, safeUrl).href;
            continue;
        }
        if (!response.ok) {
            throw new Error(`Screenshot download returned HTTP ${response.status}.`);
        }
        const contentType = response.headers
            .get('content-type')
            ?.split(';', 1)[0]
            .trim()
            .toLowerCase();
        if (!contentType || !SUPPORTED_SCREENSHOT_CONTENT_TYPES.has(contentType)) {
            throw new Error(
                'Screenshot response does not have a supported raster image content type.',
            );
        }
        return {
            buffer: await readBoundedResponse(response, maxBytes),
            extension: imageExtension(contentType),
        };
    }
    throw new Error('Screenshot redirect limit exceeded.');
}

/**
 * Dependencies for capturing trusted screenshots without a browser session.
 */
export interface IssueScreenshotCaptureOptions {
    /**
     * Directory where downloaded screenshot artifacts are written.
     */
    artifactsDir: string;

    /**
     * Trace recorder that owns the screenshot artifact references.
     */
    recorder: TraceRecorder;

    /**
     * Injectable fetch implementation for issue screenshot downloads.
     */
    fetcher?: typeof fetch;

    /**
     * Injectable DNS resolver for screenshot host validation.
     */
    resolveHostname?: HostnameResolver;

    /**
     * Maximum accepted screenshot response size in bytes.
     */
    maxBytes?: number;

    /**
     * Diagnostics sink for the per-screenshot download outcome.
     *
     * A failed download is otherwise visible only as prose inside the returned record, which
     * nothing logs: a run can answer `issueScreenshots: []` for an issue carrying GitHub
     * attachments without a single log line about it.
     */
    logger?: Logger;
}

/**
 * Download and register issue screenshots through the trusted evidence path.
 *
 * This helper deliberately has no browser dependency, so callers can preserve the reporter's visual
 * evidence before attempting a browser launch or when the live browser is unavailable. Individual
 * download failures are returned as descriptions instead of aborting the run, and every outcome —
 * success or failure — is logged, so a run without reporter screenshots says why.
 *
 * @param screenshots - Untrusted screenshot references parsed from the issue body.
 * @param options - Artifact storage, trace recorder, logger, and injectable network dependencies.
 * @returns Screenshot records containing registered artifact IDs or bounded failure descriptions.
 */
export async function captureIssueScreenshots(
    screenshots: IssueScreenshot[],
    options: IssueScreenshotCaptureOptions,
): Promise<MatchedIssueScreenshot[]> {
    mkdirSync(options.artifactsDir, { recursive: true });
    const fetcher = options.fetcher ?? fetch;
    const resolveHostname = options.resolveHostname ?? defaultHostnameResolver;
    const maxBytes = options.maxBytes ?? DEFAULT_SCREENSHOT_MAX_BYTES;
    const results: MatchedIssueScreenshot[] = [];

    for (const screenshot of screenshots) {
        try {
            const download = await downloadTrustedScreenshot(
                screenshot.url,
                fetcher,
                resolveHostname,
                maxBytes,
            );
            const id = randomUUID();
            const filename = `${id}.${download.extension}`;
            const fullPath = join(options.artifactsDir, filename);
            writeFileSync(fullPath, download.buffer);
            options.recorder.addArtifact({
                id,
                path: fullPath,
                type: 'issue-screenshot',
                bytes: download.buffer.length,
            });
            options.logger?.info(
                { url: screenshot.url, bytes: download.buffer.length, artifactId: id },
                'issue screenshot downloaded',
            );
            results.push({
                issueScreenshotUrl: screenshot.url,
                liveArtifactId: id,
                description: screenshot.description ?? 'Issue screenshot downloaded',
            });
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            options.logger?.warn(
                { err, url: screenshot.url },
                'issue screenshot download failed; the reporter evidence is missing from this run',
            );
            results.push({
                issueScreenshotUrl: screenshot.url,
                description: `Download error: ${err.message}`,
            });
        }
    }

    return results;
}
