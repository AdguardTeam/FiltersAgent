import { createHash } from 'node:crypto';
import {
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    openSync,
    readFileSync,
    readSync,
    realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import * as v from 'valibot';
import {
    AgentIssueInputSchema,
    FALLBACK_ATTACHMENT_EXTENSION,
    LocalIssueSnapshotSchema,
    deriveBoundedIssueInput,
    detectImageFileExtension,
    toAgentIssueInput,
    type AgentIssueInput,
    type LocalIssueAttachment,
    type LocalIssueSnapshot,
} from './issue-snapshot';
import { InputOrigin } from '../types/input-origin';
import { REPOSITORY_SLUG_PATTERN } from '../types/repository-slug';

export const EXPORTED_REVISION_MAX_ATTACHMENT_COUNT = 12;

export const EXPORTED_REVISION_MAX_AGGREGATE_BYTES = 48 * 1024 * 1024;

const Sha256Schema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/iu));

const RepositorySchema = v.pipe(v.string(), v.regex(REPOSITORY_SLUG_PATTERN));

export const ExportedIssueRevisionSchema = v.strictObject({
    schemaVersion: v.literal(2),
    inputOrigin: v.literal(InputOrigin.Exported),
    repository: RepositorySchema,
    issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
    sourceUpdatedAt: v.pipe(v.string(), v.isoTimestamp()),
    capturedAt: v.pipe(v.string(), v.isoTimestamp()),
    revisionDigest: Sha256Schema,
    promptDigest: Sha256Schema,
    snapshot: LocalIssueSnapshotSchema,
});

/**
 * Version-two portable issue envelope with immutable revision identity.
 */
export type ExportedIssueRevision = v.InferOutput<typeof ExportedIssueRevisionSchema>;

/**
 * Inputs used to construct one portable exported issue revision.
 */
export interface ExportedIssueRevisionSource {
    /**
     * GitHub repository in owner/repository form.
     */
    repository: string;

    /**
     * Positive issue number that must match the nested snapshot.
     */
    issueNumber: number;

    /**
     * Source issue update time captured by the exporter.
     */
    sourceUpdatedAt: string;

    /**
     * Audit time at which this bundle was captured.
     */
    capturedAt: string;

    /**
     * Existing prompt-safe local issue snapshot.
     */
    snapshot: LocalIssueSnapshot;
}

/**
 * Opaque, integrity-verified issue revision accepted by the common local handler.
 */
export interface VerifiedIssueRevision {
    /**
     * Normalized source repository identity.
     */
    readonly repository: string;

    /**
     * Positive source issue number.
     */
    readonly issueNumber: number;

    /**
     * Immutable source update timestamp.
     */
    readonly sourceUpdatedAt: string;

    /**
     * Full-source integrity digest compatible with the version-two envelope field.
     */
    readonly sourceIntegrityDigest: string;

    /**
     * Legacy unbounded prompt-integrity digest compatible with version-two envelopes.
     */
    readonly sourcePromptIntegrityDigest: string;

    /**
     * Trusted bounded work identity shared by every selector.
     */
    readonly revisionDigest: string;

    /**
     * Bounded prompt projection digest supplied to the common handler.
     */
    readonly promptDigest: string;

    /**
     * Provenance discriminator for an exported or read-only live input.
     */
    readonly inputOrigin: InputOrigin;
}

/**
 * Captured snapshot and bytes accepted by the selector-independent verifier.
 */
export interface CapturedIssueRevisionSource extends ExportedIssueRevisionSource {
    /**
     * Selector provenance retained outside the trusted work identity.
     */
    inputOrigin: InputOrigin;

    /**
     * Ordered attachment payloads corresponding to snapshot attachment metadata.
     */
    attachmentBytes: readonly Uint8Array[];

    /**
     * Optional full-source digest authenticated by an existing v2 envelope.
     */
    expectedSourceIntegrityDigest?: string;

    /**
     * Optional legacy prompt digest authenticated by an existing v2 envelope.
     */
    expectedSourcePromptIntegrityDigest?: string;
}

/**
 * Defensive attachment copy retained behind the verified revision boundary.
 */
export interface VerifiedIssueAttachmentCopy {
    /**
     * Prompt-safe attachment metadata without the original bundle path.
     */
    attachment: LocalIssueAttachment;

    /**
     * Captured bytes verified against the recorded SHA-256.
     */
    bytes: Uint8Array;
}

/**
 * Module-private data that cannot be synthesized from parsed JSON.
 */
interface VerifiedRevisionData {
    /**
     * Defensive prompt-safe issue value.
     */
    issue: AgentIssueInput;

    /**
     * Attachment metadata and bytes captured during verification.
     */
    attachments: VerifiedIssueAttachmentCopy[];
}

/**
 * Canonical attachment projection independent of local bundle paths.
 */
interface CanonicalAttachment {
    /**
     * Attachment role in issue evidence.
     */
    kind: LocalIssueAttachment['kind'];

    /**
     * Original remote source URL.
     */
    sourceUrl: string | null;

    /**
     * Lowercase content digest.
     */
    sha256: string;

    /**
     * Whether this attachment may enter the model context.
     */
    promptVisible: boolean;

    /**
     * Raw issue location that supplied the attachment.
     */
    source: LocalIssueAttachment['source'] | null;
}

/**
 * Bounded bytes and digest captured from one attachment file.
 */
interface BoundedFileRead {
    /**
     * Immutable attachment bytes captured from the open file descriptor.
     */
    bytes: Uint8Array;

    /**
     * Lowercase SHA-256 digest of the captured bytes.
     */
    sha256: string;
}

const verifiedRevisionData = new WeakMap<VerifiedIssueRevision, VerifiedRevisionData>();

/**
 * Normalize a GitHub repository identity for stable hashing.
 *
 * @param repository - Repository identity supplied by an exporter or envelope.
 * @returns Trimmed lowercase owner/repository identity.
 */
function normalizeRepository(repository: string): string {
    return v.parse(RepositorySchema, repository.trim()).toLowerCase();
}

/**
 * Compute a lowercase SHA-256 over canonical JSON.
 *
 * @param value - Explicit serializable projection.
 * @returns Lowercase hexadecimal digest.
 */
function canonicalDigest(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

/**
 * Remove machine-local paths from attachment identity.
 *
 * @param attachment - Validated snapshot attachment.
 * @returns Stable attachment identity used by both digests.
 */
function canonicalAttachment(attachment: LocalIssueAttachment): CanonicalAttachment {
    return {
        kind: attachment.kind,
        sourceUrl: attachment.sourceUrl,
        sha256: attachment.sha256.toLowerCase(),
        promptVisible: attachment.promptVisible,
        source: attachment.source ?? null,
    };
}

/**
 * Project a snapshot into the exact prompt-safe model input identity.
 *
 * @param snapshot - Validated snapshot whose local paths must be excluded.
 * @returns Canonical prompt projection.
 */
function canonicalPromptProjection(snapshot: LocalIssueSnapshot): unknown {
    const issue = toAgentIssueInput(snapshot);
    return {
        number: issue.number,
        url: issue.url,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels,
        assignee: issue.assignee,
        comments: issue.comments.map((comment) => ({
            author: comment.author,
            body: comment.body,
            createdAt: comment.createdAt,
        })),
        attachments: issue.attachments.map(canonicalAttachment),
    };
}

/**
 * Project the bounded runtime issue into a path-independent prompt identity.
 *
 * @param issue - Exact bounded issue supplied to the common handler.
 * @returns Canonical runtime prompt projection.
 */
function canonicalAgentPromptProjection(issue: AgentIssueInput): unknown {
    return {
        number: issue.number,
        url: issue.url,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels,
        assignee: issue.assignee,
        comments: issue.comments.map((comment) => ({
            author: comment.author,
            body: comment.body,
            createdAt: comment.createdAt,
        })),
        attachments: issue.attachments.map(canonicalAttachment),
    };
}

/**
 * Project all immutable source facts into one portable revision identity.
 *
 * @param repository - Normalized repository identity.
 * @param issueNumber - Positive issue number.
 * @param sourceUpdatedAt - Source update timestamp.
 * @param snapshot - Validated raw and prompt-safe issue snapshot.
 * @returns Canonical complete revision projection.
 */
function canonicalRevisionProjection(
    repository: string,
    issueNumber: number,
    sourceUpdatedAt: string,
    snapshot: LocalIssueSnapshot,
): unknown {
    return {
        schemaVersion: 2,
        inputOrigin: InputOrigin.Exported,
        repository,
        issueNumber,
        sourceUpdatedAt,
        snapshot: {
            schemaVersion: snapshot.schemaVersion,
            rawIssue: {
                number: snapshot.rawIssue.number,
                reporterAuthor: snapshot.rawIssue.reporterAuthor ?? null,
                url: snapshot.rawIssue.url,
                title: snapshot.rawIssue.title,
                body: snapshot.rawIssue.body,
                state: snapshot.rawIssue.state,
                labels: snapshot.rawIssue.labels,
                assignee: snapshot.rawIssue.assignee,
                comments: snapshot.rawIssue.comments.map((comment) => ({
                    author: comment.author,
                    body: comment.body,
                    createdAt: comment.createdAt,
                })),
            },
            reporterComments: snapshot.reporterComments.map((comment) => ({
                author: comment.author,
                body: comment.body,
                createdAt: comment.createdAt,
            })),
            attachments: snapshot.attachments.map(canonicalAttachment),
        },
    };
}

/**
 * Enforce the immutable attachment-count policy before any file access.
 *
 * @param count - Number of attachments declared by the envelope.
 */
function assertAttachmentCount(count: number): void {
    if (count > EXPORTED_REVISION_MAX_ATTACHMENT_COUNT) {
        throw new Error(
            `Exported issue revision exceeds the limit of ` +
                `${EXPORTED_REVISION_MAX_ATTACHMENT_COUNT} attachments.`,
        );
    }
}

/**
 * Build a version-two exported revision envelope with canonical digests.
 *
 * @param source - Repository, revision time, and prompt-safe snapshot source.
 * @returns Validated portable envelope.
 */
export function buildExportedIssueRevision(
    source: ExportedIssueRevisionSource,
): ExportedIssueRevision {
    const snapshot = v.parse(LocalIssueSnapshotSchema, source.snapshot);
    const repository = normalizeRepository(source.repository);
    const issueNumber = v.parse(v.pipe(v.number(), v.integer(), v.minValue(1)), source.issueNumber);
    const sourceUpdatedAt = v.parse(v.pipe(v.string(), v.isoTimestamp()), source.sourceUpdatedAt);
    const capturedAt = v.parse(v.pipe(v.string(), v.isoTimestamp()), source.capturedAt);
    if (snapshot.rawIssue.number !== issueNumber) {
        throw new Error(
            `Exported issue number ${issueNumber} does not match nested snapshot ` +
                `#${snapshot.rawIssue.number}.`,
        );
    }
    assertAttachmentCount(snapshot.attachments.length);
    return v.parse(ExportedIssueRevisionSchema, {
        schemaVersion: 2,
        inputOrigin: InputOrigin.Exported,
        repository,
        issueNumber,
        sourceUpdatedAt,
        capturedAt,
        revisionDigest: canonicalDigest(
            canonicalRevisionProjection(repository, issueNumber, sourceUpdatedAt, snapshot),
        ),
        promptDigest: canonicalDigest(canonicalPromptProjection(snapshot)),
        snapshot,
    });
}

/**
 * Resolve one portable attachment beneath the physical bundle root.
 *
 * @param bundleRoot - Canonical physical bundle directory.
 * @param localPath - Untrusted portable attachment path.
 * @returns Canonical physical attachment path inside the bundle.
 */
function resolveBundleAttachment(bundleRoot: string, localPath: string): string {
    if (isAbsolute(localPath)) {
        throw new Error(`Exported revision attachment path must be relative: ${localPath}`);
    }
    const lexicalPath = resolve(bundleRoot, localPath);
    const lexicalRelative = relative(bundleRoot, lexicalPath);
    if (
        lexicalRelative === '..' ||
        lexicalRelative.startsWith(`..${sep}`) ||
        isAbsolute(lexicalRelative)
    ) {
        throw new Error(`Exported revision attachment path escapes its bundle: ${localPath}`);
    }
    const stats = lstatSync(lexicalPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error(`Exported revision attachment must be a regular file: ${localPath}`);
    }
    const physicalPath = realpathSync(lexicalPath);
    const physicalRelative = relative(bundleRoot, physicalPath);
    if (
        physicalRelative === '..' ||
        physicalRelative.startsWith(`..${sep}`) ||
        isAbsolute(physicalRelative)
    ) {
        throw new Error(`Exported revision attachment resolves outside its bundle: ${localPath}`);
    }
    return physicalPath;
}

/**
 * Read and capture one attachment without exceeding the remaining aggregate budget.
 *
 * @param path - Canonical regular file inside the bundle.
 * @param remainingBytes - Remaining bytes allowed by the shared revision policy.
 * @returns Captured file bytes and their lowercase SHA-256.
 */
function readBoundedFile(path: string, remainingBytes: number): BoundedFileRead {
    const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
    const file = openSync(path, constants.O_RDONLY | noFollow);
    try {
        const stats = fstatSync(file);
        if (!stats.isFile()) {
            throw new Error(`Exported revision attachment is not a regular file: ${path}`);
        }
        if (stats.size > remainingBytes) {
            throw new Error('Exported issue revision attachments exceed the 48 MiB limit.');
        }
        const chunks: Uint8Array[] = [];
        const digest = createHash('sha256');
        let byteLength = 0;
        while (true) {
            const chunk = new Uint8Array(64 * 1024);
            const read = readSync(file, chunk, 0, chunk.byteLength, null);
            if (read === 0) {
                break;
            }
            if (byteLength + read > remainingBytes) {
                throw new Error('Exported issue revision attachments exceed the 48 MiB limit.');
            }
            const captured = chunk.slice(0, read);
            digest.update(captured);
            chunks.push(captured);
            byteLength += read;
        }
        const bytes = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return { bytes, sha256: digest.digest('hex') };
    } finally {
        closeSync(file);
    }
}

/**
 * Return private verified data or reject a structurally forged value.
 *
 * @param revision - Opaque revision supplied to a trusted consumer.
 * @returns Module-private verified issue data.
 */
function getVerifiedRevisionData(revision: VerifiedIssueRevision): VerifiedRevisionData {
    const data = verifiedRevisionData.get(revision);
    if (!data) {
        throw new Error('Issue revision was not produced by the integrity verifier.');
    }
    return data;
}

/**
 * Verify already captured attachment bytes into the opaque common revision contract.
 *
 * @param source - Complete source snapshot, selector provenance, and ordered attachment bytes.
 * @returns Opaque revision whose private issue and bytes are defensively captured.
 */
export function verifyCapturedIssueRevision(
    source: CapturedIssueRevisionSource,
): VerifiedIssueRevision {
    const snapshot = v.parse(LocalIssueSnapshotSchema, source.snapshot);
    const repository = normalizeRepository(source.repository);
    const issueNumber = v.parse(v.pipe(v.number(), v.integer(), v.minValue(1)), source.issueNumber);
    const sourceUpdatedAt = v.parse(v.pipe(v.string(), v.isoTimestamp()), source.sourceUpdatedAt);
    v.parse(v.pipe(v.string(), v.isoTimestamp()), source.capturedAt);
    if (snapshot.rawIssue.number !== issueNumber) {
        throw new Error(
            `Captured issue number ${issueNumber} does not match nested snapshot ` +
                `#${snapshot.rawIssue.number}.`,
        );
    }
    assertAttachmentCount(snapshot.attachments.length);
    if (source.attachmentBytes.length !== snapshot.attachments.length) {
        throw new Error(
            `Captured issue revision declares ${snapshot.attachments.length} attachments but ` +
                `received ${source.attachmentBytes.length} payloads.`,
        );
    }

    const sourceIntegrityDigest = canonicalDigest(
        canonicalRevisionProjection(repository, issueNumber, sourceUpdatedAt, snapshot),
    );
    const sourcePromptIntegrityDigest = canonicalDigest(canonicalPromptProjection(snapshot));
    if (
        source.expectedSourceIntegrityDigest !== undefined &&
        sourceIntegrityDigest !== source.expectedSourceIntegrityDigest.toLowerCase()
    ) {
        throw new Error(
            `Exported revision digest mismatch: expected ${source.expectedSourceIntegrityDigest}, ` +
                `received ${sourceIntegrityDigest}.`,
        );
    }
    if (
        source.expectedSourcePromptIntegrityDigest !== undefined &&
        sourcePromptIntegrityDigest !== source.expectedSourcePromptIntegrityDigest.toLowerCase()
    ) {
        throw new Error(
            `Exported prompt digest mismatch: expected ` +
                `${source.expectedSourcePromptIntegrityDigest}, received ` +
                `${sourcePromptIntegrityDigest}.`,
        );
    }

    const capturedAttachments: VerifiedIssueAttachmentCopy[] = [];
    let totalBytes = 0;
    for (const [index, attachment] of snapshot.attachments.entries()) {
        const bytes = Uint8Array.from(source.attachmentBytes[index]!);
        totalBytes += bytes.byteLength;
        if (totalBytes > EXPORTED_REVISION_MAX_AGGREGATE_BYTES) {
            throw new Error('Exported issue revision attachments exceed the 48 MiB limit.');
        }
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (sha256 !== attachment.sha256.toLowerCase()) {
            throw new Error(
                `Attachment SHA-256 mismatch for ${attachment.localPath}: ` +
                    `expected ${attachment.sha256}, received ${sha256}.`,
            );
        }
        const verifiedExtension = detectImageFileExtension(bytes) ?? FALLBACK_ATTACHMENT_EXTENSION;
        capturedAttachments.push({
            attachment: {
                ...attachment,
                sha256,
                localPath: `attachments/${String(index + 1).padStart(2, '0')}` + verifiedExtension,
            },
            bytes,
        });
    }

    const boundedIssue = deriveBoundedIssueInput(snapshot);
    const promptSafeIssue = v.parse(AgentIssueInputSchema, {
        ...boundedIssue,
        attachments: capturedAttachments
            .filter(({ attachment }) => attachment.promptVisible)
            .map(({ attachment }) => ({ ...attachment })),
    });
    const promptDigest = canonicalDigest(canonicalAgentPromptProjection(promptSafeIssue));
    const revisionDigest = canonicalDigest({
        schemaVersion: 1,
        repository,
        issueNumber,
        promptDigest,
    });
    const revision = Object.freeze({
        repository,
        issueNumber,
        sourceUpdatedAt,
        sourceIntegrityDigest,
        sourcePromptIntegrityDigest,
        revisionDigest,
        promptDigest,
        inputOrigin: source.inputOrigin,
    });
    verifiedRevisionData.set(revision, {
        issue: structuredClone(promptSafeIssue),
        attachments: capturedAttachments.map(({ attachment, bytes }) => ({
            attachment: { ...attachment },
            bytes: Uint8Array.from(bytes),
        })),
    });
    return revision;
}

/**
 * Parse and fully verify one exported issue revision before runtime initialization.
 *
 * @param issuePath - Portable `issue.json` path.
 * @returns Opaque verified revision with captured prompt data and attachment bytes.
 */
export function loadVerifiedExportedIssueRevision(issuePath: string): VerifiedIssueRevision {
    let source: unknown;
    try {
        source = JSON.parse(readFileSync(issuePath, 'utf8')) as unknown;
    } catch (error) {
        throw new Error(
            `Unable to read exported issue revision ${issuePath}: ${(error as Error).message}`,
            { cause: error },
        );
    }
    const envelope = v.parse(ExportedIssueRevisionSchema, source);
    const repository = normalizeRepository(envelope.repository);
    if (envelope.snapshot.rawIssue.number !== envelope.issueNumber) {
        throw new Error('Exported revision issue identity does not match its nested snapshot.');
    }
    assertAttachmentCount(envelope.snapshot.attachments.length);
    const expectedRevisionDigest = canonicalDigest(
        canonicalRevisionProjection(
            repository,
            envelope.issueNumber,
            envelope.sourceUpdatedAt,
            envelope.snapshot,
        ),
    );
    const expectedPromptDigest = canonicalDigest(canonicalPromptProjection(envelope.snapshot));
    if (expectedRevisionDigest !== envelope.revisionDigest.toLowerCase()) {
        throw new Error(
            `Exported revision digest mismatch: expected ${envelope.revisionDigest}, ` +
                `received ${expectedRevisionDigest}.`,
        );
    }
    if (expectedPromptDigest !== envelope.promptDigest.toLowerCase()) {
        throw new Error(
            `Exported prompt digest mismatch: expected ${envelope.promptDigest}, ` +
                `received ${expectedPromptDigest}.`,
        );
    }

    const bundleRoot = realpathSync(dirname(resolve(issuePath)));
    const capturedAttachmentBytes: Uint8Array[] = [];
    let totalBytes = 0;
    for (const attachment of envelope.snapshot.attachments) {
        const path = resolveBundleAttachment(bundleRoot, attachment.localPath);
        const captured = readBoundedFile(path, EXPORTED_REVISION_MAX_AGGREGATE_BYTES - totalBytes);
        if (captured.sha256 !== attachment.sha256.toLowerCase()) {
            throw new Error(
                `Attachment SHA-256 mismatch for ${attachment.localPath}: ` +
                    `expected ${attachment.sha256}, received ${captured.sha256}.`,
            );
        }
        totalBytes += captured.bytes.byteLength;
        capturedAttachmentBytes.push(captured.bytes);
    }

    return verifyCapturedIssueRevision({
        repository,
        issueNumber: envelope.issueNumber,
        sourceUpdatedAt: envelope.sourceUpdatedAt,
        capturedAt: envelope.capturedAt,
        snapshot: envelope.snapshot,
        attachmentBytes: capturedAttachmentBytes,
        inputOrigin: InputOrigin.Exported,
        expectedSourceIntegrityDigest: expectedRevisionDigest,
        expectedSourcePromptIntegrityDigest: expectedPromptDigest,
    });
}

/**
 * Copy the exact prompt-safe issue captured during revision verification.
 *
 * @param revision - Opaque verified revision.
 * @returns Defensive issue-input copy with no source-bundle paths.
 */
export function copyVerifiedIssueInput(revision: VerifiedIssueRevision): AgentIssueInput {
    return structuredClone(getVerifiedRevisionData(revision).issue);
}

/**
 * Copy verified attachment metadata and bytes for safe owned materialization.
 *
 * @param revision - Opaque verified revision.
 * @returns Defensive attachment copies in snapshot order.
 */
export function copyVerifiedAttachments(
    revision: VerifiedIssueRevision,
): VerifiedIssueAttachmentCopy[] {
    return getVerifiedRevisionData(revision).attachments.map(({ attachment, bytes }) => ({
        attachment: { ...attachment },
        bytes: new Uint8Array(bytes),
    }));
}

/**
 * Copy only verified attachment bytes for integrity and isolation assertions.
 *
 * @param revision - Opaque verified revision.
 * @returns Defensive byte arrays in snapshot order.
 */
export function copyVerifiedAttachmentBytes(revision: VerifiedIssueRevision): Uint8Array[] {
    return copyVerifiedAttachments(revision).map(({ bytes }) => bytes);
}
