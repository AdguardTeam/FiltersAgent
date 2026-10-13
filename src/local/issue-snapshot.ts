import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as v from 'valibot';
import { stripBenchmarkIssueMarker } from '../github/benchmark-issue-marker';
import { stripAgentControlMarkers } from '../github/agent-control-markers';
import { GeneratedCommentMarker } from '../github/generated-comment-markers';
import {
    AUTOMATIC_UPSTREAM_PROMPT_TEXT_LIMITS,
    assertRawPromptTextWithinLimit,
    boundPromptText,
    isLikelyHumanSolutionComment,
    isTrustedStructuredIssueReport,
    selectPromptSafeReporterComments,
    type PromptTextLimits,
} from '../github/prompt-safety';
import { extractReporterImageUrls } from '../parser/reporter-image-links';
import { IssueAttachmentKind, ISSUE_ATTACHMENT_KIND_VALUES } from '../types/issue-attachment-kind';
import { ISSUE_STATE_VALUES } from '../types/issue-state';

/**
 * Raw issue locations an image can be extracted from.
 */
export const IssueImageSource = {
    Body: 'body',
    ReporterComment: 'reporter_comment',
    RawComment: 'raw_comment',
} as const;

export const ISSUE_IMAGE_SOURCE_VALUES = Object.values(IssueImageSource);

/**
 * One issue image source.
 */
export type IssueImageSource = (typeof IssueImageSource)[keyof typeof IssueImageSource];

export const LocalIssueCommentSchema = v.object({
    author: v.string(),
    body: v.string(),
    createdAt: v.pipe(v.string(), v.isoTimestamp()),
});

export const LocalRawIssueSchema = v.object({
    number: v.pipe(v.number(), v.integer(), v.minValue(1)),
    reporterAuthor: v.optional(v.string()),
    url: v.pipe(v.string(), v.url()),
    title: v.string(),
    body: v.nullable(v.string()),
    state: v.picklist(ISSUE_STATE_VALUES),
    labels: v.array(v.string()),
    assignee: v.nullable(v.string()),
    comments: v.array(LocalIssueCommentSchema),
});

export const LocalIssueAttachmentSchema = v.object({
    kind: v.picklist(ISSUE_ATTACHMENT_KIND_VALUES),
    sourceUrl: v.nullable(v.pipe(v.string(), v.url())),
    localPath: v.pipe(v.string(), v.minLength(1)),
    sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/i)),
    promptVisible: v.optional(v.boolean(), true),
    source: v.optional(v.picklist(ISSUE_IMAGE_SOURCE_VALUES)),
});

export const LocalIssueSnapshotSchema = v.pipe(
    v.object({
        schemaVersion: v.literal(1),
        rawIssue: LocalRawIssueSchema,
        reporterComments: v.array(LocalIssueCommentSchema),
        attachments: v.array(LocalIssueAttachmentSchema),
    }),
    v.check(
        (snapshot) =>
            snapshot.reporterComments.every(
                (reporterComment) =>
                    filterReporterVisibleComments([reporterComment], {
                        reporterAuthorOnly: reporterComment.author,
                        includeStructuredIssueReports: true,
                    }).length === 1 &&
                    snapshot.rawIssue.comments.some(
                        (rawComment) =>
                            rawComment.author === reporterComment.author &&
                            rawComment.body === reporterComment.body &&
                            rawComment.createdAt === reporterComment.createdAt,
                    ),
            ),
        'Reporter comments must be safe comments preserved from the raw issue.',
    ),
);

export const AgentIssueInputSchema = v.object({
    number: v.pipe(v.number(), v.integer(), v.minValue(1)),
    url: v.pipe(v.string(), v.url()),
    title: v.string(),
    body: v.nullable(v.string()),
    state: v.picklist(ISSUE_STATE_VALUES),
    labels: v.array(v.string()),
    assignee: v.nullable(v.string()),
    comments: v.array(LocalIssueCommentSchema),
    attachments: v.array(LocalIssueAttachmentSchema),
});

/**
 * A comment preserved in a local issue snapshot.
 */
export type LocalIssueComment = v.InferOutput<typeof LocalIssueCommentSchema>;

/**
 * The complete issue payload retained for audit and replay.
 */
export type LocalRawIssue = v.InferOutput<typeof LocalRawIssueSchema>;

/**
 * A downloaded issue image or attachment with an integrity digest.
 */
export type LocalIssueAttachment = v.InferOutput<typeof LocalIssueAttachmentSchema>;

/**
 * A replayable issue snapshot that keeps raw and agent-visible data separate.
 */
export type LocalIssueSnapshot = v.InferOutput<typeof LocalIssueSnapshotSchema>;

/**
 * The issue subset safe to pass into the core agent.
 */
export type AgentIssueInput = v.InferOutput<typeof AgentIssueInputSchema>;

/**
 * Deterministic reporter-input violation that automatic intake may retry and quarantine.
 */
export class IssueInputPolicyError extends Error {
    /**
     * Create a deterministic issue-input policy error.
     *
     * @param message - Bounded diagnostic describing the rejected input.
     * @param options - Optional original error retained as the cause.
     */
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'IssueInputPolicyError';
    }
}

/**
 * Stable identity for an issue comment that contains a known human solution.
 */
export interface LocalCommentIdentity {
    /**
     * Login of the comment author.
     */
    author: string;

    /**
     * Original creation timestamp of the comment.
     */
    createdAt: string;
}

/**
 * Explicit exclusions supplied while converting raw issue history into reporter context.
 */
export interface ReporterCommentFilterOptions {
    /**
     * Human-solution comments identified by trusted export metadata.
     */
    humanSolutionComments?: readonly LocalCommentIdentity[];

    /**
     * Additional bot logins that do not use GitHub's conventional `[bot]` suffix.
     */
    additionalBotAuthors?: readonly string[];

    /**
     * When set, expose comments only from the immutable GitHub issue author.
     */
    reporterAuthorOnly?: string;

    /**
     * Preserve complete structured issue reports posted by AdGuard's issue automation account.
     */
    includeStructuredIssueReports?: boolean;
}

/**
 * Filesystem and transport dependencies used while exporting one local issue.
 */
export interface CaptureLocalIssueSnapshotOptions extends ReporterCommentFilterOptions {
    /**
     * Fetch one user-supplied attachment without coupling the exporter to GitHub or `fetch`.
     */
    downloadAttachment: (url: string, remainingBytes?: number) => Promise<Uint8Array>;

    /**
     * Maximum distinct image references accepted for this export.
     */
    maxAttachmentCount?: number;

    /**
     * Maximum combined bytes accepted across downloaded images.
     */
    maxTotalAttachmentBytes?: number;

    /**
     * Skip raw-history images that are not included in the prompt-safe reporter view.
     */
    promptVisibleAttachmentsOnly?: boolean;

    /**
     * Optional prompt limits used to derive the bounded runtime issue projection.
     */
    promptTextLimits?: PromptTextLimits;
}

/**
 * Filesystem and transport dependencies used while exporting one local issue.
 */
export interface ExportLocalIssueSnapshotOptions extends CaptureLocalIssueSnapshotOptions {
    /**
     * Directory where `issue.json` and downloaded attachments are stored.
     */
    outputDir: string;
}

/**
 * One defensively copied attachment payload captured before persistence.
 */
export interface CapturedLocalIssueAttachment {
    /**
     * Portable attachment metadata included in the serialized snapshot.
     */
    attachment: LocalIssueAttachment;

    /**
     * Defensively copied bytes whose digest matches the attachment metadata.
     */
    bytes: Uint8Array;
}

/**
 * Complete immutable issue capture shared by live and exported selectors.
 */
export interface CapturedLocalIssueSnapshot {
    /**
     * Complete untruncated snapshot used by source-integrity verification.
     */
    snapshot: LocalIssueSnapshot;

    /**
     * Bounded issue projection allowed to cross the agent boundary.
     */
    boundedIssue: AgentIssueInput;

    /**
     * Ordered attachment metadata and defensively copied payloads.
     */
    attachmentBytes: CapturedLocalIssueAttachment[];
}

/**
 * Files and validated data produced by a local issue export.
 */
export interface ExportedLocalIssueSnapshot {
    /**
     * Absolute or caller-relative path to the persisted snapshot JSON.
     */
    snapshotPath: string;

    /**
     * Validated in-memory snapshot matching the persisted document.
     */
    snapshot: LocalIssueSnapshot;

    /**
     * Optional version-two immutable revision envelope wrapping this snapshot.
     */
    revision?: import('./issue-revision').ExportedIssueRevision;
}

/**
 * Generated-comment markers that must never be placed in an agent prompt.
 *
 * The JSON-carrying marker openers are not listed: a snapshot stores them only in the issue body,
 * which {@link stripAgentControlMarkers} sanitizes on export.
 */
const EXCLUDED_COMMENT_MARKERS = [
    GeneratedCommentMarker.IssueSummary,
    GeneratedCommentMarker.AgentSummary,
    GeneratedCommentMarker.HumanSolution,
    GeneratedCommentMarker.HumanReference,
] as const;

/**
 * Bot accounts commonly present in copied AdGuard issue histories.
 */
const DEFAULT_BOT_AUTHORS = new Set(['adguard-bot', 'github-actions']);

/**
 * Prompt-visibility metadata retained for one downloaded image URL.
 */
interface PromptImageSource {
    /**
     * Whether the image may be exposed to the core agent.
     */
    promptVisible: boolean;

    /**
     * Raw issue location from which the image was extracted.
     */
    source: IssueImageSource;
}

/**
 * Filename suffix shape this agent is willing to put on a file it writes.
 *
 * A suffix comes from an untrusted URL or filename, so it is retyped rather than trusted: a dot,
 * then at most eight lowercase alphanumerics. That rejects path separators, dot segments, spaces,
 * shell and glob characters, and double extensions, while staying wide enough for every real image
 * suffix an attachment carries.
 */
const SAFE_ATTACHMENT_EXTENSION_PATTERN = /^\.[a-z0-9]{1,8}$/u;

/**
 * Suffix given to an attachment whose own suffix is missing, over-long, or otherwise unsafe.
 *
 * Deliberately not an image suffix: nothing about the bytes was recognized, so the name must not
 * claim a type. Every writer of attachment bytes — the snapshot and the run-owned copies the fix
 * runner materializes — uses this same fallback, so the same source file keeps one name.
 */
export const FALLBACK_ATTACHMENT_EXTENSION = '.bin';

/**
 * Reduce one candidate filename suffix to a suffix that is safe to write.
 *
 * @param candidateExtension - Suffix taken from an untrusted URL path or filename.
 * @returns The lowercase suffix, or `.bin` when it is unavailable or suspicious.
 */
export function safeAttachmentExtension(candidateExtension: string): string {
    const extension = candidateExtension.toLowerCase();
    return SAFE_ATTACHMENT_EXTENSION_PATTERN.test(extension)
        ? extension
        : FALLBACK_ATTACHMENT_EXTENSION;
}

/**
 * Choose a harmless filename suffix from a remote image URL.
 *
 * @param sourceUrl - Absolute attachment URL.
 * @param bytes - Downloaded bytes used to recover extensionless image types.
 * @returns A short lowercase extension, or `.bin` when it is unavailable or suspicious.
 */
function attachmentExtension(sourceUrl: string, bytes: Uint8Array): string {
    const detected = detectImageFileExtension(bytes);
    if (detected) {
        return detected;
    }
    return safeAttachmentExtension(extname(new URL(sourceUrl).pathname));
}

/**
 * Check whether bytes contain one exact signature at a fixed offset.
 *
 * @param bytes - Downloaded attachment bytes.
 * @param signature - Expected binary signature.
 * @param offset - Zero-based location of the signature.
 * @returns Whether every signature byte matches.
 */
function hasByteSignature(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
    return (
        bytes.byteLength >= offset + signature.length &&
        signature.every((value, index) => bytes[offset + index] === value)
    );
}

/**
 * Detect a browser-supported image filename extension from immutable file magic.
 *
 * @param bytes - Downloaded reporter attachment bytes.
 * @returns Supported lowercase extension, or null for unknown content.
 */
export function detectImageFileExtension(
    bytes: Uint8Array,
): '.png' | '.jpg' | '.gif' | '.webp' | null {
    if (hasByteSignature(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        return '.png';
    }
    if (hasByteSignature(bytes, [0xff, 0xd8, 0xff])) {
        return '.jpg';
    }
    if (
        hasByteSignature(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
        hasByteSignature(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    ) {
        return '.gif';
    }
    if (
        hasByteSignature(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        hasByteSignature(bytes, [0x57, 0x45, 0x42, 0x50], 8)
    ) {
        return '.webp';
    }
    return null;
}

/**
 * Compute a lowercase SHA-256 digest for attachment bytes.
 *
 * @param bytes - Downloaded or persisted file bytes.
 * @returns Hex-encoded SHA-256 digest.
 */
function attachmentDigest(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Build a stable lookup key for a comment identity.
 *
 * @param identity - Comment author and immutable creation timestamp.
 * @returns A case-insensitive identity key.
 */
function commentIdentityKey(identity: LocalCommentIdentity): string {
    return `${identity.author.trim().toLowerCase()}\u0000${identity.createdAt}`;
}

/**
 * Determine whether a login represents an automated account.
 *
 * @param author - GitHub author login.
 * @param additionalBots - Additional trusted bot logins.
 * @returns True when the author is an automated account.
 */
function isBotAuthor(author: string, additionalBots: ReadonlySet<string>): boolean {
    const normalized = author.trim().toLowerCase();
    return (
        normalized.endsWith('[bot]') ||
        DEFAULT_BOT_AUTHORS.has(normalized) ||
        additionalBots.has(normalized)
    );
}

/**
 * Return reporter context while excluding generated or post-solution material.
 *
 * Filtering is deterministic and uses a conservative classifier for explicit filter rules,
 * commit/PR references, and positive fixed-with phrases. Trusted comment identities remain an
 * additional exact exclusion. The input array and its comments are never mutated.
 *
 * @param comments - Complete raw issue comment history.
 * @param options - Trusted bot and human-solution identities supplied by the exporter.
 * @returns Cloned comments that are safe to expose to the agent.
 */
export function filterReporterVisibleComments(
    comments: readonly LocalIssueComment[],
    options: ReporterCommentFilterOptions = {},
): LocalIssueComment[] {
    const humanSolutions = new Set((options.humanSolutionComments ?? []).map(commentIdentityKey));
    const additionalBots = new Set(
        (options.additionalBotAuthors ?? []).map((author) => author.trim().toLowerCase()),
    );
    const reporterAuthorOnly = options.reporterAuthorOnly?.trim().toLowerCase();
    const includeStructuredIssueReports = options.includeStructuredIssueReports === true;

    const filtered = comments
        .filter(
            (comment) =>
                !isBotAuthor(comment.author, additionalBots) ||
                (includeStructuredIssueReports && isTrustedStructuredIssueReport(comment)),
        )
        .filter(
            (comment) => !EXCLUDED_COMMENT_MARKERS.some((marker) => comment.body.includes(marker)),
        )
        .filter((comment) => !humanSolutions.has(commentIdentityKey(comment)))
        .filter((comment) => !isLikelyHumanSolutionComment(comment.body));
    return (
        reporterAuthorOnly
            ? selectPromptSafeReporterComments(filtered, reporterAuthorOnly, {
                  includeStructuredIssueReports,
              })
            : filtered
    ).map((comment) => ({ ...comment }));
}

/**
 * Create and validate a local snapshot without modifying its raw issue payload.
 *
 * @param rawIssue - Complete raw issue fetched or loaded by a local adapter.
 * @param attachments - Downloaded issue attachments and screenshot digests.
 * @param options - Trusted exclusions used only to derive reporter-visible comments.
 * @returns A validated snapshot containing both raw and filtered issue views.
 */
export function buildLocalIssueSnapshot(
    rawIssue: LocalRawIssue,
    attachments: v.InferInput<typeof LocalIssueAttachmentSchema>[],
    options: ReporterCommentFilterOptions = {},
): LocalIssueSnapshot {
    const parsedRawIssue = v.parse(LocalRawIssueSchema, rawIssue);
    const parsedAttachments = v.parse(v.array(LocalIssueAttachmentSchema), attachments);
    return v.parse(LocalIssueSnapshotSchema, {
        schemaVersion: 1,
        rawIssue: parsedRawIssue,
        reporterComments: filterReporterVisibleComments(parsedRawIssue.comments, options),
        attachments: parsedAttachments,
    });
}

/**
 * Convert a persisted snapshot into the narrow input accepted by the core agent.
 *
 * Raw comments and exporter exclusion metadata are intentionally absent from the returned type.
 * Only the already-filtered reporter comments and downloaded attachment references cross the core
 * boundary.
 *
 * @param snapshot - Validated local issue snapshot.
 * @returns A validated issue input that contains no raw issue history.
 */
export function toAgentIssueInput(snapshot: LocalIssueSnapshot): AgentIssueInput {
    const parsed = v.parse(LocalIssueSnapshotSchema, snapshot);
    return v.parse(AgentIssueInputSchema, {
        number: parsed.rawIssue.number,
        url: parsed.rawIssue.url,
        title: parsed.rawIssue.title,
        body: stripAgentControlMarkers(stripBenchmarkIssueMarker(parsed.rawIssue.body)),
        state: parsed.rawIssue.state,
        labels: parsed.rawIssue.labels,
        assignee: parsed.rawIssue.assignee,
        comments: parsed.reporterComments,
        attachments: parsed.attachments.filter((attachment) => attachment.promptVisible),
    });
}

/**
 * Derive the bounded prompt projection while retaining the complete snapshot for audit.
 *
 * @param snapshot - Complete validated issue snapshot.
 * @param limits - Shared soft and hard automatic prompt limits.
 * @returns Bounded issue input safe to pass to the agent runtime.
 */
export function deriveBoundedIssueInput(
    snapshot: LocalIssueSnapshot,
    limits: PromptTextLimits = AUTOMATIC_UPSTREAM_PROMPT_TEXT_LIMITS,
): AgentIssueInput {
    const parsed = v.parse(LocalIssueSnapshotSchema, snapshot);
    try {
        assertRawPromptTextWithinLimit(
            {
                body: parsed.rawIssue.body,
                comments: parsed.rawIssue.comments,
            },
            limits,
        );
    } catch (error) {
        throw new IssueInputPolicyError((error as Error).message, { cause: error });
    }
    const issue = toAgentIssueInput(parsed);
    const bounded = boundPromptText(
        {
            body: issue.body,
            comments: issue.comments,
            sourceUrl: issue.url,
        },
        limits,
    );
    return v.parse(AgentIssueInputSchema, {
        ...issue,
        body: bounded.body,
        comments: bounded.comments,
    });
}

/**
 * Capture an issue snapshot and attachment bytes without writing temporary files.
 *
 * @param rawIssue - Complete issue payload to preserve.
 * @param options - Downloader, prompt policy, and attachment resource limits.
 * @returns Complete snapshot, bounded agent view, and defensive attachment byte copies.
 */
export async function captureLocalIssueSnapshot(
    rawIssue: LocalRawIssue,
    options: CaptureLocalIssueSnapshotOptions,
): Promise<CapturedLocalIssueSnapshot> {
    const parsedRawIssue = v.parse(LocalRawIssueSchema, rawIssue);
    const reporterComments = filterReporterVisibleComments(parsedRawIssue.comments, options);
    const reporterCommentKeys = new Set(reporterComments.map(commentIdentityKey));
    const additionalBots = new Set(
        (options.additionalBotAuthors ?? []).map((author) => author.trim().toLowerCase()),
    );
    const sources = new Map<string, PromptImageSource>();
    for (const sourceUrl of extractReporterImageUrls(parsedRawIssue.body ?? '')) {
        sources.set(sourceUrl, { promptVisible: true, source: IssueImageSource.Body });
    }
    for (const comment of parsedRawIssue.comments) {
        const promptVisible = reporterCommentKeys.has(commentIdentityKey(comment));
        if (options.promptVisibleAttachmentsOnly === true && !promptVisible) {
            continue;
        }
        if (isBotAuthor(comment.author, additionalBots) && !promptVisible) {
            continue;
        }
        for (const sourceUrl of extractReporterImageUrls(comment.body)) {
            const existing = sources.get(sourceUrl);
            if (!existing || (!existing.promptVisible && promptVisible)) {
                sources.set(sourceUrl, {
                    promptVisible,
                    source: promptVisible
                        ? IssueImageSource.ReporterComment
                        : IssueImageSource.RawComment,
                });
            }
        }
    }

    const maxAttachmentCount = options.maxAttachmentCount;
    if (
        maxAttachmentCount !== undefined &&
        (!Number.isSafeInteger(maxAttachmentCount) || maxAttachmentCount < 0)
    ) {
        throw new Error('maxAttachmentCount must be a non-negative safe integer.');
    }
    if (maxAttachmentCount !== undefined && sources.size > maxAttachmentCount) {
        throw new IssueInputPolicyError(
            `Issue contains ${sources.size} images; the automatic intake limit is ` +
                `${maxAttachmentCount}.`,
        );
    }
    const maxTotalAttachmentBytes = options.maxTotalAttachmentBytes;
    if (
        maxTotalAttachmentBytes !== undefined &&
        (!Number.isSafeInteger(maxTotalAttachmentBytes) || maxTotalAttachmentBytes < 0)
    ) {
        throw new Error('maxTotalAttachmentBytes must be a non-negative safe integer.');
    }

    const promptTextLimits = options.promptTextLimits ?? AUTOMATIC_UPSTREAM_PROMPT_TEXT_LIMITS;
    deriveBoundedIssueInput(buildLocalIssueSnapshot(parsedRawIssue, [], options), promptTextLimits);

    const attachmentBytes: CapturedLocalIssueAttachment[] = [];
    let totalAttachmentBytes = 0;
    for (const [index, [sourceUrl, visibility]] of [...sources.entries()].entries()) {
        const remainingBytes =
            maxTotalAttachmentBytes === undefined
                ? undefined
                : maxTotalAttachmentBytes - totalAttachmentBytes;
        const downloaded = await options.downloadAttachment(sourceUrl, remainingBytes);
        if (remainingBytes !== undefined && downloaded.byteLength > remainingBytes) {
            throw new IssueInputPolicyError(
                `Issue images exceed the ${maxTotalAttachmentBytes}-byte automatic intake limit.`,
            );
        }
        const bytes = Uint8Array.from(downloaded);
        totalAttachmentBytes += bytes.byteLength;
        const sha256 = attachmentDigest(bytes);
        const attachment = v.parse(LocalIssueAttachmentSchema, {
            kind: IssueAttachmentKind.IssueScreenshot,
            sourceUrl,
            localPath: join(
                'attachments',
                `${String(index + 1).padStart(2, '0')}-${sha256.slice(0, 16)}` +
                    attachmentExtension(sourceUrl, bytes),
            ),
            sha256,
            ...visibility,
        });
        attachmentBytes.push({ attachment, bytes });
    }
    const snapshot = buildLocalIssueSnapshot(
        parsedRawIssue,
        attachmentBytes.map((record) => record.attachment),
        options,
    );
    return {
        snapshot,
        boundedIssue: deriveBoundedIssueInput(snapshot, promptTextLimits),
        attachmentBytes: attachmentBytes.map((record) => ({
            attachment: { ...record.attachment },
            bytes: Uint8Array.from(record.bytes),
        })),
    };
}

/**
 * Export an issue and every user-posted image into a replayable local bundle.
 *
 * The complete raw comment history remains in `rawIssue`; bot summaries and explicitly identified
 * human solutions are removed only from `reporterComments`. The injected downloader keeps this
 * layer usable with GitHub, fixture, and offline adapters.
 *
 * @param rawIssue - Complete issue payload to preserve.
 * @param options - Output directory, downloader, and trusted comment exclusions.
 * @returns Persisted snapshot path and its validated in-memory value.
 */
export async function exportLocalIssueSnapshot(
    rawIssue: LocalRawIssue,
    options: ExportLocalIssueSnapshotOptions,
): Promise<ExportedLocalIssueSnapshot> {
    const captured = await captureLocalIssueSnapshot(rawIssue, options);
    const outputDir = resolve(options.outputDir);
    const attachmentsDir = join(outputDir, 'attachments');
    mkdirSync(attachmentsDir, { recursive: true });
    for (const record of captured.attachmentBytes) {
        writeFileSync(join(outputDir, record.attachment.localPath), record.bytes);
    }
    const snapshotPath = join(outputDir, 'issue.json');
    writeFileSync(snapshotPath, `${JSON.stringify(captured.snapshot, null, 2)}\n`, 'utf8');
    return { snapshotPath, snapshot: captured.snapshot };
}

/**
 * Load a local issue bundle and verify every attachment against its recorded digest.
 *
 * @param snapshotPath - Path to the `issue.json` produced by the exporter.
 * @returns Validated snapshot whose attachment files are intact.
 */
export function loadLocalIssueSnapshot(snapshotPath: string): LocalIssueSnapshot {
    let source: unknown;
    try {
        source = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    } catch (error) {
        throw new Error(
            `Unable to read local issue snapshot ${snapshotPath}: ${(error as Error).message}`,
            {
                cause: error,
            },
        );
    }
    const portableSnapshot = v.parse(LocalIssueSnapshotSchema, source);
    const bundleDir = dirname(resolve(snapshotPath));
    const snapshot = v.parse(LocalIssueSnapshotSchema, {
        ...portableSnapshot,
        attachments: portableSnapshot.attachments.map((attachment) => {
            if (isAbsolute(attachment.localPath)) {
                return attachment;
            }
            const localPath = resolve(bundleDir, attachment.localPath);
            const relativePath = relative(bundleDir, localPath);
            if (
                relativePath === '..' ||
                relativePath.startsWith(`..${sep}`) ||
                isAbsolute(relativePath)
            ) {
                throw new Error(
                    `Relative attachment path escapes the issue bundle: ${attachment.localPath}`,
                );
            }
            return { ...attachment, localPath };
        }),
    });
    for (const attachment of snapshot.attachments) {
        const actualSha256 = attachmentDigest(readFileSync(attachment.localPath));
        if (actualSha256 !== attachment.sha256.toLowerCase()) {
            throw new Error(
                `Attachment SHA-256 mismatch for ${attachment.localPath}: ` +
                    `expected ${attachment.sha256}, received ${actualSha256}.`,
            );
        }
    }
    return snapshot;
}
