import {
    closeSync,
    constants,
    lstatSync,
    openSync,
    readSync,
    readdirSync,
    realpathSync,
    writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, sep as pathSeparator } from 'node:path';
import * as v from 'valibot';
import { STORAGE_SENSITIVE_KEY_PATTERNS } from '../browser/har-redactor';
import { RunUsageSummarySchema, type RunUsageSummary } from '../types/usage-summary';
import {
    inspectBoundReviewCandidate,
    type ReviewCandidateBindingOutcome,
} from '../repo/repository-edit';
import { AgentRunArtifactsSchema, type AgentRunArtifacts } from '../types/agent-run-artifacts';
import { redactText } from '../tracer/redact-text';
import { redactPayload, type RedactPayloadOptions } from '../tracer/redactor';
import { copyVerifiedIssueInput, type VerifiedIssueRevision } from './issue-revision';
import type { PreparedFiltersCheckout } from './filters-preparer';
import {
    markLocalPublicationPublished,
    destroyReservedLocalPublicationGeneration,
    reserveLocalPublicationGeneration,
    writeReservedPublicationFile,
} from './output-directory';
import {
    materializeReviewCheckout,
    ReviewCheckoutError,
    type ReviewWorkspaceReceipt,
} from './review-checkout';
import { LocalRunRecordSchema, renderLocalAgentReport, type LocalRunRecord } from './run-output';
import { renderLocalPublicationReport } from './run-report-render';
import { PublicationOutcome } from '../types/publication-outcome';
import {
    projectRunBindings,
    LocalPublicationManifestSchema,
    LocalPublicationFailureStage,
    type LocalPublicationArtifactDigest,
    type LocalPublicationCandidateDisposition,
    type LocalPublicationFailure,
    type LocalPublicationManifest,
} from './local-publication-manifest';
import {
    LocalPublicationTrustError,
    MAX_EVIDENCE_FILE_BYTES,
    normalizeEvidencePath,
    sha256,
    type LocalPublicationTrustFailureCode,
} from './local-publication-trust';
import type { TrustedNormalizedCapture } from './png-normalizer';
import {
    assertNoResidualSecrets,
    copySanitizedEvidenceArtifact,
    sanitizeEvidenceCollection,
    MAX_EVIDENCE_FILES,
    MAX_EVIDENCE_TOTAL_BYTES,
} from './evidence-sanitizer';
import {
    parseVerifiedJsonArtifact,
    verifyLocalPublication,
    verifyUnmarkedLocalPublication,
} from './local-publication-verifier';

/**
 * The write side of a local publication: one run's evidence becomes one append-only generation.
 *
 * `publishLocalRun` reserves a generation, sanitizes the private evidence collection, redacts and
 * re-parses every Host-produced artifact, builds the manifest, proves the whole tree free of exact
 * configured secrets, and only then makes the generation visible. Everything it is defined in terms
 * of lives in leaves it imports and none of them import back: the publication vocabulary and its
 * schemas in `local-publication-manifest.ts`, the untrusted-evidence boundary in
 * `evidence-sanitizer.ts`, the image codec in `png-normalizer.ts`, and the proof that a persisted
 * generation says what it claims in `local-publication-verifier.ts` — which this module runs
 * against its own output before publishing it.
 */

/**
 * Fixed streaming residual-secret scanner chunk size.
 */
const PUBLICATION_SCAN_CHUNK_BYTES = 64 * 1024;

/**
 * Fixed secret-proof diagnostic retained outside a destroyed generation.
 */
export const LOCAL_PUBLICATION_FAILURE_FILENAME = 'publication-failure.json';

/**
 * Name of the generation file holding the redacted run record.
 *
 * Written by every `publishLocalRun` generation and bound into its manifest digest, so it exists
 * for every run even when the investigation failed.
 */
export const RUN_RESULT_FILE_NAME = 'run-result.json';

/**
 * Name of the generation file holding the redacted agent decision and observations.
 *
 * Written by every `publishLocalRun` generation and bound into its manifest digest, so it exists
 * for every run even when the investigation failed.
 */
export const AGENT_RUN_ARTIFACTS_FILE_NAME = 'agent-run-artifacts.json';

/**
 * Name of the generation file holding the redacted LLM usage summary.
 *
 * Written by every `publishLocalRun` generation and bound into its manifest digest, so it exists
 * for every run even when the investigation failed.
 */
export const LLM_USAGE_FILE_NAME = 'llm-usage.json';

/**
 * Name of the generation file holding the human-readable publication and investigation report.
 *
 * Written by every `publishLocalRun` generation — published or evidence-only — so the CLI print
 * helpers and any consumer may name it without restating the writer's document name here.
 */
export const LOCAL_PUBLICATION_REPORT_FILE_NAME = 'report.md';

/**
 * Name of the generation file holding the review-checkout candidate patch.
 *
 * Written only when the run published a bound candidate; consumers derive its presence from the
 * manifest or the run record rather than assuming every generation carries one.
 */
export const LOCAL_PUBLICATION_PATCH_FILE_NAME = 'candidate.patch';

/**
 * Paths returned for one consumer-visible generation.
 */
export interface LocalPublicationPaths {
    /**
     * Canonical generation path.
     */
    generationPath: string;

    /**
     * Canonical manifest path.
     */
    manifestPath: string;

    /**
     * Canonical human report path.
     */
    reportPath: string;

    /**
     * Canonical patch path for a normal bound publication.
     */
    candidatePatchPath: string | null;

    /**
     * Canonical detached review checkout for a normal bound publication.
     */
    reviewCheckoutPath: string | null;
}

/**
 * Durable normal local publication result.
 */
export interface PublishedLocalPublicationOutcome {
    /**
     * Normal publication discriminator.
     */
    kind: typeof PublicationOutcome.Published;

    /**
     * Consumer-visible generation paths.
     */
    paths: LocalPublicationPaths;

    /**
     * Fully verified durable manifest.
     */
    manifest: LocalPublicationManifest;
}

/**
 * Durable evidence-only local publication result.
 */
export interface EvidenceOnlyLocalPublicationOutcome {
    /**
     * Evidence-only publication discriminator.
     */
    kind: typeof PublicationOutcome.EvidenceOnly;

    /**
     * Consumer-visible generation paths without a review checkout.
     */
    paths: LocalPublicationPaths;

    /**
     * Fully verified durable evidence-only manifest.
     */
    manifest: LocalPublicationManifest;
}

/**
 * Durable local publication result.
 */
export type LocalPublicationOutcome =
    | PublishedLocalPublicationOutcome
    | EvidenceOnlyLocalPublicationOutcome;

/**
 * Complete inputs for one append-only local publication.
 */
export interface PublishLocalRunInput {
    /**
     * Opaque immutable issue revision.
     */
    revision: VerifiedIssueRevision;

    /**
     * Canonical immutable run record.
     */
    record: LocalRunRecord;

    /**
     * Prepared exact source checkout.
     */
    source: PreparedFiltersCheckout;

    /**
     * Tagged candidate-binding outcome.
     */
    candidateBinding: ReviewCandidateBindingOutcome;

    /**
     * Private raw evidence collection.
     */
    collectionDir: string;

    /**
     * Existing local output root that owns `runs/`.
     */
    outputRoot: string;

    /**
     * Exact model-owned decision and observations.
     */
    agentRunArtifacts: AgentRunArtifacts;

    /**
     * Validated model usage summary.
     */
    llmUsage: RunUsageSummary;

    /**
     * Exact Host-configured secrets removed before hashing.
     */
    configuredSecrets: readonly string[];

    /**
     * Optional Host-issued normalized image proofs.
     */
    trustedCaptures?: readonly TrustedNormalizedCapture[];
}

/**
 * Private deterministic seams used only by focused publication tests.
 */
export interface PublishLocalRunDependencies {
    /**
     * Publication UUID source.
     */
    idSource?: () => string;

    /**
     * Host wall-clock source.
     */
    now?: () => string;

    /**
     * Test-only mutation point immediately before the final residual-secret proof.
     */
    beforeResidualScan?: (generationPath: string) => void;
}

/**
 * Schema-required structural containers of the usage summary whose names accidentally match the
 * generic sensitive-key heuristics (`tokens` matches the `/token/i` rule). Their contents are
 * numeric counters and are walked and redacted value-by-value like every other structure.
 */
const USAGE_SUMMARY_PRESERVED_STRUCTURED_KEYS: ReadonlySet<string> = new Set(['tokens']);

/**
 * Schema-required structural containers of the run record and its manifest copy.
 *
 * `browserSessions` matches the `/session/i` PII rule and is a required array; blanking it makes
 * the published record fail its own re-parse. `sessionId` matches the credential rules by name, but
 * the record's invariants bind candidate evidence to exactly one session, so one shared placeholder
 * would make distinct sessions indistinguishable — it is pseudonymized instead (below), and the raw
 * value still never survives.
 */
const RUN_RECORD_PRESERVED_STRUCTURED_KEYS: ReadonlySet<string> = new Set([
    'browsersessions',
    'sessionid',
]);

/**
 * Record keys published as stable pseudonyms rather than one shared placeholder.
 */
const RUN_RECORD_PSEUDONYMIZED_KEYS: readonly string[] = ['sessionId'];

/**
 * Convert an object to deterministic sanitized JSON bytes and reject residual exact secrets.
 *
 * ONE redaction pass: `redactPayload`'s generic credential rules plus
 * {@link STORAGE_SENSITIVE_KEY_PATTERNS}, PII shapes included. A second walker with its own key
 * table would have to be exempted in lockstep with the first, and can blank the usage summary's own
 * price table.
 *
 * Those PII shapes are why publication states a key table at all. The generic rules name
 * credentials and say nothing about people, while publication answers the stricter question of what
 * leaves the machine: a published issue input carries the reporter's GitHub login
 * (`reporterAuthor`, and an `author` on every preserved comment), and a run record or manifest can
 * carry an `email`, a bare `id` or a `user` from anywhere the run's evidence reached. Numbers are
 * blanked exactly like strings — a numeric `id` is an identifier whether or not it is quoted — so a
 * caller publishing a record whose schema needs such a field names it in
 * `preservedStructuredKeys`.
 *
 * @param value - Canonical Host value.
 * @param secrets - Exact configured secrets.
 * @param options - Schema-required containers to preserve and identifiers to pseudonymize.
 * @returns Pretty JSON ending with one newline.
 */
function sanitizedJsonBytes(
    value: unknown,
    secrets: readonly string[],
    options: RedactPayloadOptions = {},
): Buffer {
    let bytes: Buffer;
    try {
        bytes = Buffer.from(
            `${JSON.stringify(
                redactPayload(value, secrets, {
                    ...options,
                    sensitiveKeyPatterns: STORAGE_SENSITIVE_KEY_PATTERNS,
                }),
                null,
                2,
            )}\n`,
            'utf8',
        );
    } catch {
        throw new LocalPublicationTrustError('redaction_failed');
    }
    assertNoResidualSecrets(bytes, secrets);
    return bytes;
}

/**
 * Prove one redacted artifact still satisfies the schema the publish workflow re-parses.
 *
 * Redaction runs after the source value passed validation, so a rule that replaces a
 * schema-required value — a configured secret colliding with enum text, a key rule rewriting a
 * typed field — would otherwise surface only as an anonymous failure in the publish job, after the
 * evidence container and its diagnostics are gone.
 *
 * @param name - Published artifact basename named by the trust diagnostic.
 * @param bytes - Sanitized JSON bytes about to be persisted.
 * @param parse - The same validation the publish workflow applies to this artifact.
 */
function assertRedactedArtifactReparses(
    name: string,
    bytes: Buffer,
    parse: (value: unknown) => unknown,
): void {
    try {
        parse(JSON.parse(bytes.toString('utf8')) as unknown);
    } catch (error) {
        const issue = error instanceof v.ValiError ? error.issues[0] : undefined;
        const where = (issue ? v.getDotPath(issue) : undefined) ?? 'root';
        throw new LocalPublicationTrustError(
            'redaction_failed',
            `${name} diverged from its schema after redaction at ${where}`,
        );
    }
}

/**
 * Persist one fixed secret-free publication failure outside a destroyed generation.
 *
 * @param outputRoot - Existing publication output root.
 * @param code - Stable proof failure code with no native diagnostic text.
 */
export function writeLocalPublicationSanitizationFailure(
    outputRoot: string,
    code:
        | typeof LocalPublicationTrustFailureCode.RedactionFailed
        | typeof LocalPublicationTrustFailureCode.ResidualSecret,
): void {
    const path = join(realpathSync(outputRoot), LOCAL_PUBLICATION_FAILURE_FILENAME);
    const bytes = Buffer.from(`${JSON.stringify({ code })}\n`, 'utf8');
    try {
        writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
        }
    } finally {
        bytes.fill(0);
    }
}

/**
 * Stream one file while detecting any configured exact secret across chunk boundaries.
 *
 * @param path - Exact generated file path.
 * @param secrets - Existing non-CLI Host secrets represented as strings.
 * @returns Whether any non-empty secret occurs in the file.
 */
function scanFileForConfiguredSecrets(path: string, secrets: readonly string[]): boolean {
    const secretBytes = [...new Set(secrets.filter((secret) => secret.length > 0))].map((secret) =>
        Buffer.from(secret, 'utf8'),
    );
    if (secretBytes.length === 0) {
        return false;
    }
    const overlapLength = Math.max(...secretBytes.map((secret) => secret.byteLength - 1), 0);
    const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const chunk = Buffer.allocUnsafe(PUBLICATION_SCAN_CHUNK_BYTES);
    let overlap = Buffer.alloc(0);
    try {
        while (true) {
            const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
            if (bytesRead === 0) {
                return false;
            }
            const window = Buffer.concat([overlap, chunk.subarray(0, bytesRead)]);
            try {
                if (secretBytes.some((secret) => window.indexOf(secret) !== -1)) {
                    return true;
                }
                overlap.fill(0);
                overlap = Buffer.from(window.subarray(Math.max(0, window.length - overlapLength)));
            } finally {
                window.fill(0);
            }
        }
    } finally {
        overlap.fill(0);
        chunk.fill(0);
        for (const secret of secretBytes) {
            secret.fill(0);
        }
        closeSync(descriptor);
    }
}

/**
 * Prove that every generated publication artifact is bounded and free of scoped secrets.
 *
 * The detached review checkout is verified independently; only its agent-modified target is a
 * generated artifact and therefore joins this scan. Unchanged pinned source and Git internals do
 * not consume the publication evidence budget.
 *
 * @param generationPath - Exact unmarked publication generation.
 * @param changedReviewPath - Optional repository-relative target modified by the candidate.
 * @param configuredSecrets - Existing non-CLI Host secrets.
 */
function proveGeneratedPublicationSecretFree(
    generationPath: string,
    changedReviewPath: string | null,
    configuredSecrets: readonly string[],
): void {
    let files = 0;
    let totalBytes = 0;

    /**
     * Prove one exact generated regular file.
     *
     * @param path - Exact generated file path.
     */
    function proveFile(path: string): void {
        let stats;
        try {
            stats = lstatSync(path);
        } catch {
            throw new LocalPublicationTrustError('redaction_failed');
        }
        if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
            throw new LocalPublicationTrustError('redaction_failed');
        }
        files += 1;
        totalBytes += stats.size;
        if (
            files > MAX_EVIDENCE_FILES ||
            stats.size > MAX_EVIDENCE_FILE_BYTES ||
            totalBytes > MAX_EVIDENCE_TOTAL_BYTES
        ) {
            throw new LocalPublicationTrustError('redaction_failed');
        }
        try {
            if (scanFileForConfiguredSecrets(path, configuredSecrets)) {
                throw new LocalPublicationTrustError('residual_secret');
            }
        } catch (error) {
            if (error instanceof LocalPublicationTrustError) {
                throw error;
            }
            throw new LocalPublicationTrustError('redaction_failed');
        }
    }

    /**
     * Walk generated files without following directory links.
     *
     * @param directory - Current exact generated directory.
     */
    function walk(directory: string): void {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (directory === generationPath && entry.name === 'review') {
                if (changedReviewPath) {
                    proveFile(join(path, changedReviewPath));
                }
                continue;
            }
            const stats = lstatSync(path);
            if (stats.isSymbolicLink()) {
                throw new LocalPublicationTrustError('redaction_failed');
            }
            if (stats.isDirectory()) {
                walk(path);
            } else {
                proveFile(path);
            }
        }
    }

    walk(generationPath);
}

/**
 * Replace private collection paths with stable publication-relative evidence paths.
 *
 * @param value - Canonical issue, run, or model artifact value.
 * @param collectionRoot - Canonical private collection root.
 * @returns Deep defensive projection with no private collection path.
 */
function projectCollectionPaths<T>(value: T, collectionRoot: string): T {
    if (typeof value === 'string') {
        if (isAbsolute(value)) {
            const relativePath = relative(collectionRoot, value);
            if (
                relativePath !== '' &&
                relativePath !== '..' &&
                !relativePath.startsWith(`..${pathSeparator}`) &&
                !isAbsolute(relativePath)
            ) {
                return `evidence/${normalizeEvidencePath(relativePath)}` as T;
            }
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((entry) => projectCollectionPaths(entry, collectionRoot)) as T;
    }
    if (typeof value !== 'object' || value === null) {
        return value;
    }
    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
            key,
            projectCollectionPaths(entry, collectionRoot),
        ]),
    ) as T;
}

/**
 * Create an artifact digest for exact generation-relative bytes.
 *
 * @param path - Generation-relative path.
 * @param bytes - Exact bytes.
 * @returns Digest entry.
 */
function publicationArtifact(path: string, bytes: Buffer): LocalPublicationArtifactDigest {
    return { path, sha256: sha256(bytes), bytes: bytes.byteLength };
}

/**
 * Project an opaque or tagged binding into a serializable immutable manifest disposition.
 *
 * @param binding - Exact runner-provided binding result.
 * @returns Serializable disposition.
 */
function projectCandidateBinding(
    binding: ReviewCandidateBindingOutcome,
): LocalPublicationCandidateDisposition {
    if (binding.kind === 'bound') {
        return { kind: 'bound', operation: inspectBoundReviewCandidate(binding.candidate) };
    }
    if (binding.kind === 'not_applicable') {
        return { kind: 'not_applicable', disposition: binding.disposition };
    }
    return { kind: 'failed', failure: { ...binding.failure } };
}

/**
 * Copy the public issue-revision identity without private prompt or attachment bytes.
 *
 * @param revision - Verified issue revision.
 * @returns Manifest issue identity.
 */
function projectIssueIdentity(revision: VerifiedIssueRevision): LocalPublicationManifest['issue'] {
    return {
        repository: revision.repository,
        issueNumber: revision.issueNumber,
        sourceUpdatedAt: revision.sourceUpdatedAt,
        sourceIntegrityDigest: revision.sourceIntegrityDigest,
        sourcePromptIntegrityDigest: revision.sourcePromptIntegrityDigest,
        revisionDigest: revision.revisionDigest,
        promptDigest: revision.promptDigest,
        inputOrigin: revision.inputOrigin,
    };
}

/**
 * Write and digest one exact file inside a reserved generation.
 *
 * @param reservation - Opaque reservation.
 * @param artifacts - Mutable manifest artifact list.
 * @param path - Generation-relative path.
 * @param bytes - Exact file bytes.
 */
function writePublicationArtifact(
    reservation: Parameters<typeof writeReservedPublicationFile>[0],
    artifacts: LocalPublicationArtifactDigest[],
    path: string,
    bytes: Buffer,
): void {
    writeReservedPublicationFile(reservation, path, bytes);
    artifacts.push(publicationArtifact(path, bytes));
}

/**
 * Publish one sanitized append-only generation and expose it only after full verification.
 *
 * @param input - Immutable issue, run, source, evidence and usage values.
 * @param dependencies - Private deterministic UUID and clock seams for tests.
 * @returns Durable normal or evidence-only publication.
 */
export function publishLocalRun(
    input: PublishLocalRunInput,
    dependencies: PublishLocalRunDependencies = {},
): LocalPublicationOutcome {
    const reservation = reserveLocalPublicationGeneration(input.outputRoot, {
        idSource: dependencies.idSource,
    });
    const transientBuffers: Buffer[] = [];
    try {
        const createdAt = (dependencies.now ?? (() => new Date().toISOString()))();
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(createdAt)) {
            throw new LocalPublicationTrustError('unsafe_collection');
        }
        const issueInput = copyVerifiedIssueInput(input.revision);
        const collectionRoot = realpathSync(input.collectionDir);
        const sanitizedEvidence = sanitizeEvidenceCollection({
            collectionDir: input.collectionDir,
            configuredSecrets: input.configuredSecrets,
            trustedCaptures: input.trustedCaptures,
        });
        const agentRunArtifacts = v.parse(AgentRunArtifactsSchema, input.agentRunArtifacts);
        const llmUsage = v.parse(RunUsageSummarySchema, input.llmUsage);
        const publicationIssueInput = projectCollectionPaths(issueInput, collectionRoot);
        const publicationRecord = projectCollectionPaths(input.record, collectionRoot);
        const publicationAgentArtifacts = projectCollectionPaths(agentRunArtifacts, collectionRoot);
        const issueInputBytes = sanitizedJsonBytes(publicationIssueInput, input.configuredSecrets);
        const runRecordBytes = sanitizedJsonBytes(publicationRecord, input.configuredSecrets, {
            preservedStructuredKeys: RUN_RECORD_PRESERVED_STRUCTURED_KEYS,
            pseudonymizeKeys: RUN_RECORD_PSEUDONYMIZED_KEYS,
        });
        const agentRunArtifactsBytes = sanitizedJsonBytes(
            publicationAgentArtifacts,
            input.configuredSecrets,
        );
        const llmUsageBytes = sanitizedJsonBytes(llmUsage, input.configuredSecrets, {
            preservedStructuredKeys: USAGE_SUMMARY_PRESERVED_STRUCTURED_KEYS,
        });
        // Registered before the re-parse assertions below so the finally scrub still zero-fills
        // every sanitized buffer when an assertion aborts the publication.
        transientBuffers.push(
            issueInputBytes,
            runRecordBytes,
            agentRunArtifactsBytes,
            llmUsageBytes,
        );
        assertRedactedArtifactReparses(RUN_RESULT_FILE_NAME, runRecordBytes, (value) =>
            v.parse(LocalRunRecordSchema, value),
        );
        assertRedactedArtifactReparses(
            AGENT_RUN_ARTIFACTS_FILE_NAME,
            agentRunArtifactsBytes,
            (value) => v.parse(AgentRunArtifactsSchema, value),
        );
        assertRedactedArtifactReparses(LLM_USAGE_FILE_NAME, llmUsageBytes, (value) =>
            v.parse(RunUsageSummarySchema, value),
        );
        const candidate = projectCandidateBinding(input.candidateBinding);
        let outcome: LocalPublicationManifest['outcome'] =
            candidate.kind === 'failed'
                ? PublicationOutcome.EvidenceOnly
                : PublicationOutcome.Published;
        let failure: LocalPublicationFailure | null =
            candidate.kind === 'failed' ? candidate.failure : null;
        let review: ReviewWorkspaceReceipt | null = null;
        let patch: Buffer | null = null;
        if (input.candidateBinding.kind === 'bound') {
            try {
                const materialized = materializeReviewCheckout({
                    candidate: input.candidateBinding.candidate,
                    source: input.source,
                    checkoutPath: join(reservation.generationPath, 'review'),
                    createdAt,
                });
                review = materialized.receipt;
                patch = materialized.patch;
            } catch (error) {
                if (!(error instanceof ReviewCheckoutError)) {
                    throw error;
                }
                outcome = PublicationOutcome.EvidenceOnly;
                failure = {
                    code: `review_${error.code}`,
                    stage: LocalPublicationFailureStage.ReviewCheckout,
                    detail: redactText(error.message, input.configuredSecrets).slice(0, 500),
                };
            }
        }
        const artifacts: LocalPublicationArtifactDigest[] = [];
        writePublicationArtifact(reservation, artifacts, 'issue-input.json', issueInputBytes);
        writePublicationArtifact(reservation, artifacts, RUN_RESULT_FILE_NAME, runRecordBytes);
        writePublicationArtifact(
            reservation,
            artifacts,
            AGENT_RUN_ARTIFACTS_FILE_NAME,
            agentRunArtifactsBytes,
        );
        writePublicationArtifact(reservation, artifacts, LLM_USAGE_FILE_NAME, llmUsageBytes);
        for (const evidence of sanitizedEvidence.artifacts) {
            const evidenceBytes = copySanitizedEvidenceArtifact(sanitizedEvidence, evidence.path);
            writePublicationArtifact(
                reservation,
                artifacts,
                `evidence/${evidence.path}`,
                evidenceBytes,
            );
            evidenceBytes.fill(0);
        }
        if (outcome === PublicationOutcome.Published && patch && review) {
            transientBuffers.push(patch);
            writePublicationArtifact(
                reservation,
                artifacts,
                LOCAL_PUBLICATION_PATCH_FILE_NAME,
                patch,
            );
            const reviewReceiptBytes = sanitizedJsonBytes(review, input.configuredSecrets);
            transientBuffers.push(reviewReceiptBytes);
            writePublicationArtifact(
                reservation,
                artifacts,
                'review-receipt.json',
                reviewReceiptBytes,
            );
        } else {
            patch = null;
            review = null;
        }
        const publicationReport = renderLocalPublicationReport({
            publicationId: reservation.id,
            outcome,
            issueNumber: input.revision.issueNumber,
            revisionDigest: input.revision.revisionDigest,
            sourceCommit: input.source.provenance.commit,
            candidateDisposition: candidate.kind,
            failureCode: failure?.code ?? null,
            runRecordSha256: sha256(runRecordBytes),
            evidenceArtifacts: sanitizedEvidence.artifacts.length,
            imageOmissions: sanitizedEvidence.images.filter((image) => image.kind === 'omitted')
                .length,
            reviewCheckout: review?.checkoutPath ?? null,
        });
        const investigationReport = renderLocalAgentReport(
            publicationRecord,
            publicationAgentArtifacts.decision,
        );
        const reportBytes = Buffer.from(
            redactText(
                `${publicationReport.trimEnd()}\n\n${investigationReport.trimEnd()}\n`,
                input.configuredSecrets,
            ),
        );
        transientBuffers.push(reportBytes);
        assertNoResidualSecrets(reportBytes, input.configuredSecrets);
        writePublicationArtifact(
            reservation,
            artifacts,
            LOCAL_PUBLICATION_REPORT_FILE_NAME,
            reportBytes,
        );
        artifacts.sort((left, right) => left.path.localeCompare(right.path));
        const manifest: LocalPublicationManifest = {
            schemaVersion: 1,
            publicationId: reservation.id,
            outcome,
            createdAt,
            issue: projectIssueIdentity(input.revision),
            source: { ...input.source.provenance },
            bindings: projectRunBindings(publicationRecord, {
                issueInputSha256: sha256(issueInputBytes),
                runRecordSha256: sha256(runRecordBytes),
                agentRunArtifactsSha256: sha256(agentRunArtifactsBytes),
                llmUsageSha256: sha256(llmUsageBytes),
            }),
            candidate,
            failure,
            artifacts,
            images: sanitizedEvidence.images.map((image) => ({ ...image })),
            review,
        };
        // The manifest embeds the same canonical execution the run record carries, and the two
        // are compared field by field at verification: both copies must hide session identifiers
        // the same way or a legitimate publication reads as an unsafe artifact.
        const manifestBytes = sanitizedJsonBytes(manifest, input.configuredSecrets, {
            preservedStructuredKeys: RUN_RECORD_PRESERVED_STRUCTURED_KEYS,
            pseudonymizeKeys: RUN_RECORD_PSEUDONYMIZED_KEYS,
        });
        transientBuffers.push(manifestBytes);
        writeReservedPublicationFile(reservation, 'manifest.json', manifestBytes);
        const persistedManifest = parseVerifiedJsonArtifact(
            manifestBytes,
            LocalPublicationManifestSchema,
        );
        verifyUnmarkedLocalPublication(
            reservation.generationPath,
            persistedManifest,
            manifestBytes,
        );
        dependencies.beforeResidualScan?.(reservation.generationPath);
        proveGeneratedPublicationSecretFree(
            reservation.generationPath,
            review?.changedPath ?? null,
            input.configuredSecrets,
        );
        markLocalPublicationPublished(reservation, manifestBytes);
        const verified = verifyLocalPublication(reservation.generationPath);
        const paths: LocalPublicationPaths = {
            generationPath: reservation.generationPath,
            manifestPath: join(reservation.generationPath, 'manifest.json'),
            reportPath: join(reservation.generationPath, LOCAL_PUBLICATION_REPORT_FILE_NAME),
            candidatePatchPath:
                outcome === PublicationOutcome.Published && patch
                    ? join(reservation.generationPath, LOCAL_PUBLICATION_PATCH_FILE_NAME)
                    : null,
            reviewCheckoutPath:
                outcome === PublicationOutcome.Published && review
                    ? join(reservation.generationPath, 'review')
                    : null,
        };
        return { kind: outcome, paths, manifest: verified };
    } catch (error) {
        let failure: LocalPublicationTrustError;
        if (error instanceof LocalPublicationTrustError) {
            failure = error;
        } else if (error instanceof ReviewCheckoutError) {
            failure = new LocalPublicationTrustError('unsafe_artifact');
        } else {
            failure = new LocalPublicationTrustError('unsafe_artifact');
        }
        if (failure.code === 'redaction_failed' || failure.code === 'residual_secret') {
            destroyReservedLocalPublicationGeneration(reservation);
            writeLocalPublicationSanitizationFailure(input.outputRoot, failure.code);
        }
        throw failure;
    } finally {
        for (const bytes of transientBuffers) {
            bytes.fill(0);
        }
    }
}
