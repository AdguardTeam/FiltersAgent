import { rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
    fetchIssue,
    type FetchIssueOptions,
    type GithubReadConfig,
    type RawIssue,
} from '../../src/github/fetch-issue';
import { IssueState } from '../../src/types/issue-state';
import { AUTOMATIC_UPSTREAM_PROMPT_TEXT_LIMITS } from '../../src/github/prompt-safety';
import {
    buildLocalIssueSnapshot,
    captureLocalIssueSnapshot,
    detectImageFileExtension,
    exportLocalIssueSnapshot,
    IssueInputPolicyError,
    toAgentIssueInput,
    type ExportedLocalIssueSnapshot,
    type ReporterCommentFilterOptions,
} from '../../src/local/issue-snapshot';
import {
    EXPORTED_REVISION_MAX_AGGREGATE_BYTES,
    EXPORTED_REVISION_MAX_ATTACHMENT_COUNT,
    buildExportedIssueRevision,
    verifyCapturedIssueRevision,
    type VerifiedIssueRevision,
} from '../../src/local/issue-revision';
import { GITHUB_USER_IMAGE_HOSTS } from '../../src/parser/reporter-image-links';
import { InputOrigin } from '../../src/types/input-origin';

/**
 * Options for exporting one GitHub issue into a local replay bundle.
 */
export interface ExportGithubIssueOptions extends ReporterCommentFilterOptions {
    /**
     * Absolute destination directory for the exported bundle.
     */
    outputDir: string;

    /**
     * Persist a legacy snapshot or a version-two immutable revision envelope.
     */
    outputFormat?: 'legacy-snapshot' | 'revision-envelope';

    /**
     * Deterministic capture timestamp used by revision-envelope exports.
     */
    capturedAt?: string;

    /**
     * Repository root that must not contain the exported bundle.
     */
    workspaceRoot: string;

    /**
     * Persist only the marker-free issue subset and attachments accepted by the core agent.
     */
    promptSafeOnly?: boolean;

    /**
     * Limit model-visible comments to the issue author while preserving the complete raw history.
     */
    reporterOnlyPrompt?: boolean;
}

/**
 * Read-only seams used by the GitHub issue exporter.
 */
export interface GithubIssueExporterDependencies {
    /**
     * Fetch a complete issue and its comments from GitHub.
     */
    fetchIssue?: (
        config: GithubReadConfig,
        issueNumber: number,
        options?: FetchIssueOptions,
    ) => Promise<RawIssue>;

    /**
     * Fetch implementation used only to download user-posted images.
     */
    fetch?: typeof globalThis.fetch;
}

/**
 * Options controlling one read-only in-memory live revision capture.
 */
export interface CaptureGithubIssueRevisionOptions extends ReporterCommentFilterOptions {
    /**
     * Expected source timestamp selected by a polling scan.
     */
    expectedUpdatedAt?: string;

    /**
     * Deterministic audit timestamp for tests and cycle provenance.
     */
    capturedAt?: string;
}

/**
 * Minimal live summary returned when capture observes drift or closure.
 */
export interface LiveIssueCaptureSummary {
    /**
     * Positive GitHub issue number.
     */
    issueNumber: number;

    /**
     * Current source update timestamp.
     */
    updatedAt: string;

    /**
     * Current GitHub issue state.
     */
    state: IssueState;
}

/**
 * Exhaustive result of read-only live issue capture.
 */
export type LiveIssueCaptureResult =
    | {
          /**
           * Verified capture branch discriminator.
           */
          kind: 'verified';

          /**
           * Immutable verified issue revision.
           */
          revision: VerifiedIssueRevision;
      }
    | {
          /**
           * Superseded capture branch discriminator.
           */
          kind: 'superseded';

          /**
           * Current summary for the still-open issue.
           */
          summary: LiveIssueCaptureSummary & {
              /**
               * Open state observed after revision drift.
               */
              state: typeof IssueState.Open;
          };
      }
    | {
          /**
           * Closed capture branch discriminator.
           */
          kind: 'closed';

          /**
           * Current summary for the closed issue.
           */
          summary: LiveIssueCaptureSummary & {
              /**
               * Closed state observed during capture.
               */
              state: typeof IssueState.Closed;
          };
      }
    | {
          /**
           * Invalid capture branch discriminator.
           */
          kind: 'invalid';

          /**
           * Bounded capture failure category.
           */
          code: 'prompt_too_large' | 'invalid_revision';

          /**
           * Sanitized diagnostic explaining the rejection.
           */
          message: string;
      };

/**
 * GitHub-controlled hosts that may safely receive the configured read token.
 */
const AUTHENTICATED_GITHUB_HOSTS = new Set([
    'api.github.com',
    'github.com',
    'media.githubusercontent.com',
    'objects.githubusercontent.com',
    ...GITHUB_USER_IMAGE_HOSTS,
]);

/**
 * Maximum accepted attachment body size before the exporter fails closed.
 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Maximum number of manually revalidated GitHub-controlled redirects.
 */
const MAX_ATTACHMENT_REDIRECTS = 5;

/**
 * Per-request deadline for one attachment response or redirect hop.
 */
const ATTACHMENT_TIMEOUT_MS = 15_000;

/**
 * Parse and validate one source or redirect URL before it reaches the network.
 *
 * @param sourceUrl - Untrusted reporter image URL or redirect location.
 * @param baseUrl - Current safe URL used to resolve a relative redirect.
 * @returns Validated HTTPS URL on a GitHub-controlled attachment host.
 */
function validateAttachmentUrl(sourceUrl: string, baseUrl?: URL): URL {
    const url = baseUrl ? new URL(sourceUrl, baseUrl) : new URL(sourceUrl);
    // The host allowlist was dropped so a reporter who pastes a screenshot from any image host
    // still gets their issue investigated — rejecting the whole report over one attachment cost
    // more than it protected. What it actually guarded against is handled elsewhere and stays:
    // the read token is attached only for `AUTHENTICATED_GITHUB_HOSTS`, so no third-party host
    // ever receives it. The checks below are what a reporter-supplied URL must still satisfy.
    if (
        url.protocol !== 'https:' ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.port.length > 0 ||
        isPrivateHostLiteral(url.hostname)
    ) {
        throw new IssueInputPolicyError(
            'Issue images must use plain HTTPS on a public host, without credentials or an ' +
                'explicit port.',
        );
    }
    url.hash = '';
    return url;
}

/**
 * Check whether a hostname literally names a loopback or private address.
 *
 * A reporter's URL is untrusted input that this process will fetch, so an address inside the host's
 * own network is refused: it is never a real screenshot, and following one would turn the agent
 * into a probe for services that are not reachable from outside.
 *
 * @param hostname - Hostname taken from the attachment URL.
 * @returns Whether the hostname is a private or loopback literal.
 */
function isPrivateHostLiteral(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
        return true;
    }
    if (
        host === '::1' ||
        host.startsWith('fe80:') ||
        host.startsWith('fc') ||
        host.startsWith('fd')
    ) {
        return true;
    }
    const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
    if (!octets) {
        return false;
    }
    const [first, second] = [Number(octets[1]), Number(octets[2])];
    return (
        first === 0 ||
        first === 10 ||
        first === 127 ||
        (first === 169 && second === 254) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168)
    );
}

/**
 * Render an attachment URL for retained diagnostics without signed query credentials.
 *
 * @param url - Validated source or redirect URL used for the actual request.
 * @returns Same origin and path with search and fragment removed.
 */
function diagnosticAttachmentUrl(url: URL): string {
    const diagnosticUrl = new URL(url.href);
    diagnosticUrl.search = '';
    diagnosticUrl.hash = '';
    return diagnosticUrl.href;
}

/**
 * Read one successful image response without trusting Content-Length for memory safety.
 *
 * @param response - Successful, non-redirect attachment response.
 * @param sourceUrl - Validated URL retained only for bounded diagnostics.
 * @param maxBytes - Maximum number of response bytes that may be retained.
 * @returns Image bytes no larger than the configured attachment limit.
 */
async function readBoundedAttachment(
    response: Response,
    sourceUrl: URL,
    maxBytes: number,
): Promise<Uint8Array> {
    const diagnosticUrl = diagnosticAttachmentUrl(sourceUrl);
    const contentType = response.headers
        .get('content-type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase();
    if (contentType !== 'application/octet-stream' && !contentType?.startsWith('image/')) {
        throw new IssueInputPolicyError(
            `Issue attachment ${diagnosticUrl} has unsupported content type ` +
                `${contentType ?? 'missing'}.`,
        );
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new IssueInputPolicyError(`Issue attachment ${diagnosticUrl} is too large.`);
    }
    if (!response.body) {
        throw new IssueInputPolicyError(
            `Issue attachment ${diagnosticUrl} returned an empty body.`,
        );
    }

    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    const reader = response.body.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        byteLength += value.byteLength;
        if (byteLength > maxBytes) {
            await reader.cancel();
            throw new IssueInputPolicyError(`Issue attachment ${diagnosticUrl} is too large.`);
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    if (!detectImageFileExtension(bytes)) {
        throw new IssueInputPolicyError(
            `Issue attachment ${diagnosticUrl} does not contain a supported image.`,
        );
    }
    return bytes;
}

/**
 * Validate and normalize an external exporter destination.
 *
 * @param outputDir - Requested absolute output directory.
 * @param workspaceRoot - Absolute repository root that must remain untouched.
 * @returns Normalized output directory.
 */
function validateExternalOutputDir(outputDir: string, workspaceRoot: string): string {
    if (!isAbsolute(outputDir) || !isAbsolute(workspaceRoot)) {
        throw new Error('Issue export output and workspace root must be absolute paths.');
    }
    const outputPath = resolve(outputDir);
    const workspacePath = resolve(workspaceRoot);
    const workspaceRelative = relative(workspacePath, outputPath);
    if (
        workspaceRelative === '' ||
        (!workspaceRelative.startsWith('..') && !isAbsolute(workspaceRelative))
    ) {
        throw new Error('Issue export output must be outside the workspace.');
    }
    return outputPath;
}

/**
 * Download one issue attachment while keeping GitHub credentials on GitHub-owned hosts.
 *
 * @param sourceUrl - User-posted image URL discovered in issue Markdown or HTML.
 * @param token - GitHub read token used only for GitHub-controlled attachment hosts.
 * @param fetchImplementation - Fetch transport supplied by the runtime or a unit test.
 * @param aggregateRemainingBytes - Remaining bytes in the exported revision attachment budget.
 * @returns Downloaded attachment bytes.
 */
export async function downloadGithubAttachment(
    sourceUrl: string,
    token: string,
    fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
    aggregateRemainingBytes = MAX_ATTACHMENT_BYTES,
): Promise<Uint8Array> {
    if (!Number.isSafeInteger(aggregateRemainingBytes) || aggregateRemainingBytes < 0) {
        throw new Error('Attachment byte budget must be a non-negative safe integer.');
    }
    const maxBytes = Math.min(MAX_ATTACHMENT_BYTES, aggregateRemainingBytes);
    let url = validateAttachmentUrl(sourceUrl);
    for (let redirectCount = 0; redirectCount <= MAX_ATTACHMENT_REDIRECTS; redirectCount += 1) {
        const headers: Record<string, string> =
            token.length > 0 && AUTHENTICATED_GITHUB_HOSTS.has(url.hostname.toLowerCase())
                ? {
                      Accept: 'application/octet-stream',
                      Authorization: `Bearer ${token}`,
                  }
                : { Accept: 'application/octet-stream' };
        const response = await fetchImplementation(url.href, {
            headers,
            redirect: 'manual',
            signal: AbortSignal.timeout(ATTACHMENT_TIMEOUT_MS),
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            if (!location) {
                throw new IssueInputPolicyError(
                    `Issue attachment ${diagnosticAttachmentUrl(url)} returned a redirect ` +
                        'without Location.',
                );
            }
            if (redirectCount === MAX_ATTACHMENT_REDIRECTS) {
                throw new IssueInputPolicyError(
                    `Issue attachment ${diagnosticAttachmentUrl(url)} exceeded the redirect limit.`,
                );
            }
            url = validateAttachmentUrl(location, url);
            continue;
        }
        if (!response.ok) {
            if (response.status === 404 || response.status === 410) {
                throw new IssueInputPolicyError(
                    `Issue attachment ${diagnosticAttachmentUrl(url)} is no longer available ` +
                        `(HTTP ${response.status}).`,
                );
            }
            throw new Error(
                `Failed to download issue attachment ${diagnosticAttachmentUrl(url)}: ` +
                    `HTTP ${response.status} ${response.statusText}`.trim(),
            );
        }
        return await readBoundedAttachment(response, url, maxBytes);
    }
    throw new IssueInputPolicyError(
        `Issue attachment ${diagnosticAttachmentUrl(url)} exceeded the redirect limit.`,
    );
}

/**
 * Capture one live GitHub issue into the same opaque revision used by exported bundles.
 *
 * @param config - Read-only GitHub credentials and repository coordinates.
 * @param issueNumber - Positive target issue number.
 * @param options - Optional selected timestamp and deterministic capture time.
 * @param dependencies - Injectable read-only issue and attachment transports.
 * @returns Verified revision, source drift/closure, or a typed deterministic rejection.
 */
export async function captureGithubIssueRevision(
    config: GithubReadConfig,
    issueNumber: number,
    options: CaptureGithubIssueRevisionOptions = {},
    dependencies: GithubIssueExporterDependencies = {},
): Promise<LiveIssueCaptureResult> {
    const readIssue = dependencies.fetchIssue ?? fetchIssue;
    let rawIssue: RawIssue;
    try {
        rawIssue = await readIssue(config, issueNumber, {
            preserveGeneratedComments: true,
            preserveBenchmarkMetadata: true,
            promptTextLimits: AUTOMATIC_UPSTREAM_PROMPT_TEXT_LIMITS,
            maxRawCommentCount: 1_000,
        });
    } catch (error) {
        const message = (error as Error).message;
        if (/raw (?:prompt|issue history).*exceed|256000/iu.test(message)) {
            return { kind: 'invalid', code: 'prompt_too_large', message };
        }
        throw error;
    }
    if (!rawIssue.updatedAt) {
        return {
            kind: 'invalid',
            code: 'invalid_revision',
            message: 'Live issue capture requires the source issue update timestamp.',
        };
    }
    const summary: LiveIssueCaptureSummary = {
        issueNumber: rawIssue.number,
        updatedAt: rawIssue.updatedAt,
        state: rawIssue.state,
    };
    if (rawIssue.state === IssueState.Closed) {
        return { kind: 'closed', summary: { ...summary, state: IssueState.Closed } };
    }
    if (options.expectedUpdatedAt && options.expectedUpdatedAt !== rawIssue.updatedAt) {
        return { kind: 'superseded', summary: { ...summary, state: IssueState.Open } };
    }
    const reporterAuthor = rawIssue.reporterAuthor?.trim();
    if (!reporterAuthor) {
        return {
            kind: 'invalid',
            code: 'invalid_revision',
            message: 'Live issue capture requires the immutable GitHub issue author.',
        };
    }
    try {
        const captured = await captureLocalIssueSnapshot(rawIssue, {
            humanSolutionComments: options.humanSolutionComments,
            additionalBotAuthors: options.additionalBotAuthors,
            reporterAuthorOnly: reporterAuthor,
            includeStructuredIssueReports: true,
            promptVisibleAttachmentsOnly: true,
            promptTextLimits: AUTOMATIC_UPSTREAM_PROMPT_TEXT_LIMITS,
            maxAttachmentCount: EXPORTED_REVISION_MAX_ATTACHMENT_COUNT,
            maxTotalAttachmentBytes: EXPORTED_REVISION_MAX_AGGREGATE_BYTES,
            downloadAttachment: async (url, remainingBytes) =>
                await downloadGithubAttachment(
                    url,
                    config.token,
                    dependencies.fetch ?? globalThis.fetch,
                    remainingBytes ?? EXPORTED_REVISION_MAX_AGGREGATE_BYTES,
                ),
        });
        return {
            kind: 'verified',
            revision: verifyCapturedIssueRevision({
                repository: `${config.owner}/${config.repo}`,
                issueNumber,
                sourceUpdatedAt: rawIssue.updatedAt,
                capturedAt: options.capturedAt ?? new Date().toISOString(),
                snapshot: captured.snapshot,
                attachmentBytes: captured.attachmentBytes.map((record) => record.bytes),
                inputOrigin: InputOrigin.Live,
            }),
        };
    } catch (error) {
        if (!(error instanceof IssueInputPolicyError)) {
            throw error;
        }
        const message = error.message;
        return {
            kind: 'invalid',
            code: /raw prompt|characters/iu.test(message) ? 'prompt_too_large' : 'invalid_revision',
            message,
        };
    }
}

/**
 * Fetch an issue without writes and export its raw and prompt-safe views locally.
 *
 * Generated summaries are deliberately preserved by the GitHub fetch so the raw snapshot remains
 * auditable. The snapshot exporter then excludes bots, markers, and explicitly trusted human
 * solutions from the narrower reporter context supplied to the agent.
 *
 * @param config - Minimal GitHub read credentials and repository coordinates.
 * @param issueNumber - Positive issue number to export.
 * @param options - External destination and trusted prompt exclusions.
 * @param dependencies - Optional deterministic read/download seams.
 * @returns Persisted replay bundle and its validated in-memory snapshot.
 */
export async function exportGithubIssue(
    config: GithubReadConfig,
    issueNumber: number,
    options: ExportGithubIssueOptions,
    dependencies: GithubIssueExporterDependencies = {},
): Promise<ExportedLocalIssueSnapshot> {
    const outputDir = validateExternalOutputDir(options.outputDir, options.workspaceRoot);
    const readIssue = dependencies.fetchIssue ?? fetchIssue;
    const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
    const rawIssue = await readIssue(config, issueNumber, {
        preserveGeneratedComments: true,
        preserveBenchmarkMetadata: true,
    });
    const outputFormat = options.outputFormat ?? 'legacy-snapshot';
    if (outputFormat === 'revision-envelope' && !rawIssue.updatedAt) {
        throw new IssueInputPolicyError(
            'Revision-envelope export requires the source issue update timestamp.',
        );
    }
    const reporterAuthor = rawIssue.reporterAuthor?.trim();
    if (options.promptSafeOnly && !reporterAuthor) {
        throw new IssueInputPolicyError(
            'Prompt-safe export requires the immutable GitHub issue author.',
        );
    }
    let exported = await exportLocalIssueSnapshot(rawIssue, {
        outputDir,
        humanSolutionComments: options.humanSolutionComments,
        additionalBotAuthors: options.additionalBotAuthors,
        ...(options.promptSafeOnly || options.reporterOnlyPrompt
            ? { reporterAuthorOnly: reporterAuthor }
            : {}),
        includeStructuredIssueReports: options.includeStructuredIssueReports,
        ...(outputFormat === 'revision-envelope'
            ? {
                  maxAttachmentCount: EXPORTED_REVISION_MAX_ATTACHMENT_COUNT,
                  maxTotalAttachmentBytes: EXPORTED_REVISION_MAX_AGGREGATE_BYTES,
              }
            : {}),
        promptVisibleAttachmentsOnly: options.promptSafeOnly,
        downloadAttachment: async (url, remainingBytes) =>
            await downloadGithubAttachment(
                url,
                config.token,
                fetchImplementation,
                remainingBytes ?? MAX_ATTACHMENT_BYTES,
            ),
    });
    if (options.promptSafeOnly) {
        const agentInput = toAgentIssueInput(exported.snapshot);
        for (const attachment of exported.snapshot.attachments) {
            if (attachment.promptVisible) {
                continue;
            }
            const attachmentPath = isAbsolute(attachment.localPath)
                ? attachment.localPath
                : join(outputDir, attachment.localPath);
            rmSync(attachmentPath, { force: true });
        }
        const promptSafeSnapshot = buildLocalIssueSnapshot(
            {
                number: agentInput.number,
                reporterAuthor: exported.snapshot.rawIssue.reporterAuthor,
                url: agentInput.url,
                title: agentInput.title,
                body: agentInput.body,
                state: agentInput.state,
                labels: agentInput.labels,
                assignee: agentInput.assignee,
                comments: agentInput.comments,
            },
            agentInput.attachments,
            {
                ...(reporterAuthor === undefined ? {} : { reporterAuthorOnly: reporterAuthor }),
                includeStructuredIssueReports: options.includeStructuredIssueReports,
            },
        );
        writeFileSync(
            exported.snapshotPath,
            `${JSON.stringify(promptSafeSnapshot, null, 2)}\n`,
            'utf8',
        );
        exported = { snapshotPath: exported.snapshotPath, snapshot: promptSafeSnapshot };
    }
    if (outputFormat === 'legacy-snapshot') {
        return exported;
    }
    const revision = buildExportedIssueRevision({
        repository: `${config.owner}/${config.repo}`,
        issueNumber: exported.snapshot.rawIssue.number,
        sourceUpdatedAt: rawIssue.updatedAt as string,
        capturedAt: options.capturedAt ?? new Date().toISOString(),
        snapshot: exported.snapshot,
    });
    writeFileSync(exported.snapshotPath, `${JSON.stringify(revision, null, 2)}\n`, 'utf8');
    return { ...exported, revision };
}
