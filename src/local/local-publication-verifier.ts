import { isDeepStrictEqual } from 'node:util';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import * as v from 'valibot';
import { describeSharedRuleExtension } from '../repo/shared-rule-extension';
import { FixRunStatus } from '../types/fix-run-result';
import type { ReviewCandidateOperation } from '../repo/repository-edit';
import { RepositoryEditKind } from '../types/repository-edit-kind';
import { ReviewCandidateDisposition } from '../types/review-candidate-disposition';
import { PublicationOutcome } from '../types/publication-outcome';
import { AgentIssueInputSchema, type AgentIssueInput } from './issue-snapshot';
import {
    LOCAL_PUBLICATION_OWNERSHIP_MARKER,
    LOCAL_PUBLICATION_VISIBLE_MARKER,
    listPublishedLocalGenerations,
    removeVerifiedLocalPublicationGeneration,
} from './output-directory';
import { ReviewCheckoutError, verifyReviewCheckout } from './review-checkout';
import { readStableArtifact } from './evidence-sanitizer';
import {
    LocalPublicationFailureStage,
    LocalPublicationReviewSchema,
    LockedPublicationRunProjectionSchema,
    parseLocalPublicationManifest,
    projectRunBindings,
    type LocalPublicationArtifactDigest,
    type LocalPublicationIssueIdentity,
    type LocalPublicationManifest,
    type LockedPublicationRunProjection,
    type NotApplicableLocalPublicationCandidateDisposition,
} from './local-publication-manifest';
import {
    hasUnsafeControl,
    LocalPublicationTrustError,
    LocalPublicationTrustFailureCode,
    normalizeEvidencePath,
    schemaIssueDetail,
    sha256,
} from './local-publication-trust';

/**
 * The read side of a local publication: prove a persisted generation, or refuse it.
 *
 * Nothing here trusts what the publisher wrote. Every artifact is re-hashed against the manifest,
 * the manifest's duplicated semantics are re-derived from the locked run record with the same
 * projection that produced them, and each mismatch becomes a named trust failure rather than a
 * quietly accepted generation. It depends only on the leaves, never on the publisher, so a
 * generation can be verified by a process that published nothing.
 */

/**
 * Read and verify one exact generation file against an expected digest.
 *
 * @param generationPath - Canonical generation root.
 * @param artifact - Expected generation-relative digest.
 * @returns Exact verified bytes.
 */
function verifyPublicationArtifact(
    generationPath: string,
    artifact: LocalPublicationArtifactDigest,
): Buffer {
    const path = normalizeEvidencePath(artifact.path);
    const bytes = readStableArtifact(join(generationPath, path));
    if (bytes.byteLength !== artifact.bytes || sha256(bytes) !== artifact.sha256) {
        throw new LocalPublicationTrustError('unsafe_artifact');
    }
    return bytes;
}

/**
 * Parse one digest-verified JSON artifact through its complete runtime schema.
 *
 * @param bytes - Exact digest-verified artifact bytes.
 * @param schema - Runtime schema for the persisted value.
 * @returns Parsed schema-owned artifact value.
 */
export function parseVerifiedJsonArtifact<
    TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(bytes: Buffer, schema: TSchema): v.InferOutput<TSchema> {
    let value: unknown;
    try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    } catch {
        throw new LocalPublicationTrustError(
            LocalPublicationTrustFailureCode.UnsafeArtifact,
            'json: undecodable',
        );
    }
    const parsed = v.safeParse(schema, value);
    if (!parsed.success) {
        throw new LocalPublicationTrustError(
            LocalPublicationTrustFailureCode.UnsafeArtifact,
            schemaIssueDetail(parsed.issues[0]),
        );
    }
    return parsed.output;
}

/**
 * Compare JSON-safe persisted values after removing non-serialized optional properties.
 *
 * @param left - First JSON-safe value.
 * @param right - Second JSON-safe value.
 * @returns Whether both values have the same persisted semantics.
 */
function persistedValuesEqual(left: unknown, right: unknown): boolean {
    return isDeepStrictEqual(
        JSON.parse(JSON.stringify(left)) as unknown,
        JSON.parse(JSON.stringify(right)) as unknown,
    );
}

/**
 * Derive the only valid persisted no-candidate disposition for one locked run.
 *
 * @param record - Digest-verified canonical run record.
 * @returns Stable no-candidate disposition.
 */
function expectedNoCandidateDisposition(
    record: LockedPublicationRunProjection,
): NotApplicableLocalPublicationCandidateDisposition['disposition'] {
    if (record.result.runStatus === FixRunStatus.UnsupportedProductCase) {
        return ReviewCandidateDisposition.Unsupported;
    }
    if (record.result.runStatus === FixRunStatus.Failed) {
        return ReviewCandidateDisposition.Inconclusive;
    }
    if (
        record.result.runStatus === FixRunStatus.AlreadyFixedCurrent ||
        record.result.runStatus === FixRunStatus.FixedUpstreamPendingExtension ||
        record.result.runStatus === FixRunStatus.FixedInSourcePendingPublication
    ) {
        return ReviewCandidateDisposition.NoCandidate;
    }
    return ReviewCandidateDisposition.NotVerified;
}

/**
 * Check that a bound persisted operation is the exact projection of the locked candidate.
 *
 * @param operation - Strict persisted source-bound operation.
 * @param record - Digest-verified canonical run record.
 * @returns Whether every duplicated candidate field agrees.
 */
function operationMatchesLockedRun(
    operation: ReviewCandidateOperation,
    record: LockedPublicationRunProjection,
): boolean {
    const candidate = record.result.candidatePatch;
    if (
        !candidate ||
        record.result.runStatus !== FixRunStatus.PatchProposed ||
        candidate.filePath !== operation.filePath ||
        record.result.filtersBaseSha?.toLowerCase() !== operation.sourceCommit
    ) {
        return false;
    }
    const edit = candidate.repositoryEdit;
    if (operation.operation === 'add') {
        if (edit !== undefined && edit.kind !== RepositoryEditKind.Insert) {
            return false;
        }
        const insertionPoint =
            (edit?.kind === RepositoryEditKind.Insert
                ? edit.insertionPoint
                : candidate.insertionPoint) ?? operation.targetLines;
        const anchorRule = edit?.kind === RepositoryEditKind.Insert ? edit.anchorRule : undefined;
        const insertsAtEnd = operation.line === operation.targetLines + 1;
        const anchorMatches = insertsAtEnd
            ? operation.afterLine === 'EOF' && anchorRule === undefined
            : anchorRule === operation.afterLine;
        const expectedBoundaryDigest = sha256(
            Buffer.from(
                JSON.stringify({
                    filePath: operation.filePath,
                    targetBlobOid: operation.targetBlobOid,
                    targetFileSha256: operation.targetFileSha256,
                    line: operation.line,
                    beforeLine: operation.beforeLine,
                    afterLine: operation.afterLine,
                }),
                'utf8',
            ),
        );
        return (
            candidate.rule === operation.addedRule &&
            operation.line === insertionPoint + 1 &&
            anchorMatches &&
            operation.insertionBoundarySha256 === expectedBoundaryDigest
        );
    }
    if (operation.operation === 'edit') {
        if (
            edit === undefined ||
            // The kind check precedes every field access: an `insert` edit carries neither `line`
            // nor `originalRule`, so narrowing it away first is what makes the rest type-check.
            (edit.kind !== RepositoryEditKind.Replace &&
                edit.kind !== RepositoryEditKind.ExtendDomains) ||
            edit.line !== operation.line ||
            edit.originalRule !== operation.originalRule ||
            edit.replacementRule !== operation.replacementRule
        ) {
            return false;
        }
        // A replacement carries the replacement line itself. A constrained extension carries the
        // scoped rule the extension serves, so the structural predicate — the same one the gate and
        // `applyRepositoryEdit` already enforce for this edit kind — is what ties the two together.
        return edit.kind === RepositoryEditKind.Replace
            ? candidate.rule === operation.replacementRule
            : describeSharedRuleExtension(
                  candidate.rule,
                  edit.originalRule,
                  edit.replacementRule,
              ) !== null;
    }
    return (
        edit?.kind === RepositoryEditKind.Remove &&
        candidate.rule === operation.originalRule &&
        edit.line === operation.line &&
        edit.originalRule === operation.originalRule
    );
}

/**
 * Check that the locked issue URL and numbers match the persisted issue identity.
 *
 * @param identity - Strict manifest issue identity.
 * @param input - Digest-verified public issue input.
 * @param record - Digest-verified canonical run record.
 * @returns Whether every duplicated issue field agrees.
 */
function issueIdentityMatchesLockedFiles(
    identity: LocalPublicationIssueIdentity,
    input: AgentIssueInput,
    record: LockedPublicationRunProjection,
): boolean {
    if (
        identity.issueNumber !== input.number ||
        identity.issueNumber !== record.result.issueNumber
    ) {
        return false;
    }
    try {
        const url = new URL(input.url);
        const components = url.pathname.split('/').filter((component) => component.length > 0);
        const repository = components
            .slice(0, 2)
            .map((component) => decodeURIComponent(component).toLowerCase())
            .join('/');
        return (
            url.protocol === 'https:' &&
            url.hostname.toLowerCase() === 'github.com' &&
            url.username === '' &&
            url.password === '' &&
            components.length >= 4 &&
            components[2]?.toLowerCase() === 'issues' &&
            Number(components[3]) === identity.issueNumber &&
            repository === identity.repository
        );
    } catch {
        return false;
    }
}

/**
 * Verify semantic values duplicated between a manifest and its locked JSON artifacts.
 *
 * @param manifest - Strict persisted publication manifest.
 * @param artifactBytes - Every digest-verified artifact indexed by relative path.
 */
function verifyLockedPublicationSemantics(
    manifest: LocalPublicationManifest,
    artifactBytes: ReadonlyMap<string, Buffer>,
): void {
    const issueInputBytes = artifactBytes.get('issue-input.json');
    const runRecordBytes = artifactBytes.get('run-result.json');
    if (!issueInputBytes || !runRecordBytes) {
        throw new LocalPublicationTrustError('unsafe_artifact');
    }
    const issueInput = parseVerifiedJsonArtifact(issueInputBytes, AgentIssueInputSchema);
    const record = parseVerifiedJsonArtifact(runRecordBytes, LockedPublicationRunProjectionSchema);
    const artifactByPath = new Map(manifest.artifacts.map((artifact) => [artifact.path, artifact]));
    const expectedBindings = projectRunBindings(record, {
        issueInputSha256: artifactByPath.get('issue-input.json')!.sha256,
        runRecordSha256: artifactByPath.get('run-result.json')!.sha256,
        agentRunArtifactsSha256: artifactByPath.get('agent-run-artifacts.json')!.sha256,
        llmUsageSha256: artifactByPath.get('llm-usage.json')!.sha256,
    });
    if (
        !issueIdentityMatchesLockedFiles(manifest.issue, issueInput, record) ||
        manifest.source.environment !== record.provenance.environment ||
        (record.result.filtersBaseSha !== null &&
            record.result.filtersBaseSha !== undefined &&
            manifest.source.commit !== record.result.filtersBaseSha.toLowerCase()) ||
        !persistedValuesEqual(manifest.bindings, expectedBindings)
    ) {
        throw new LocalPublicationTrustError('unsafe_artifact');
    }
    if (manifest.candidate.kind === 'bound') {
        if (
            manifest.candidate.operation.sourceCommit !== manifest.source.commit ||
            !operationMatchesLockedRun(manifest.candidate.operation, record)
        ) {
            throw new LocalPublicationTrustError('unsafe_artifact');
        }
    } else if (manifest.candidate.kind === 'not_applicable') {
        if (
            record.result.candidatePatch !== null ||
            manifest.candidate.disposition !== expectedNoCandidateDisposition(record)
        ) {
            throw new LocalPublicationTrustError('unsafe_artifact');
        }
    }
}

/**
 * Verify the valid outcome, failure, patch, and review combinations for one publication.
 *
 * @param generationPath - Canonical publication generation root.
 * @param manifest - Strict persisted manifest.
 * @param artifactBytes - Every digest-verified artifact indexed by relative path.
 */
function verifyPublicationOutcome(
    generationPath: string,
    manifest: LocalPublicationManifest,
    artifactBytes: ReadonlyMap<string, Buffer>,
): void {
    const patch = artifactBytes.get('candidate.patch');
    const receiptBytes = artifactBytes.get('review-receipt.json');
    const reviewExists = existsSync(join(generationPath, 'review'));
    const patchExists = existsSync(join(generationPath, 'candidate.patch'));
    const receiptExists = existsSync(join(generationPath, 'review-receipt.json'));
    if (manifest.outcome === PublicationOutcome.EvidenceOnly) {
        const failureMatchesCandidate =
            manifest.candidate.kind === 'failed' &&
            manifest.failure?.stage === LocalPublicationFailureStage.CandidateBinding &&
            persistedValuesEqual(manifest.failure, manifest.candidate.failure);
        const failureMatchesReview =
            manifest.candidate.kind === 'bound' &&
            manifest.failure?.stage === LocalPublicationFailureStage.ReviewCheckout;
        if (
            (!failureMatchesCandidate && !failureMatchesReview) ||
            manifest.review !== null ||
            patch !== undefined ||
            receiptBytes !== undefined ||
            reviewExists ||
            patchExists ||
            receiptExists
        ) {
            throw new LocalPublicationTrustError('unsafe_artifact');
        }
        return;
    }
    if (manifest.failure !== null || manifest.candidate.kind === 'failed') {
        throw new LocalPublicationTrustError('unsafe_artifact');
    }
    if (manifest.candidate.kind === 'not_applicable') {
        if (
            manifest.review !== null ||
            patch !== undefined ||
            receiptBytes !== undefined ||
            reviewExists ||
            patchExists ||
            receiptExists
        ) {
            throw new LocalPublicationTrustError('unsafe_artifact');
        }
        return;
    }
    if (!manifest.review || !patch || !receiptBytes || !reviewExists) {
        throw new LocalPublicationTrustError('unsafe_artifact');
    }
    const persistedReceipt = parseVerifiedJsonArtifact(receiptBytes, LocalPublicationReviewSchema);
    const patchArtifact = manifest.artifacts.find(
        (artifact) => artifact.path === 'candidate.patch',
    );
    const operation = manifest.candidate.operation;
    if (
        !patchArtifact ||
        !persistedValuesEqual(persistedReceipt, manifest.review) ||
        manifest.review.sourceCommit !== manifest.source.commit ||
        manifest.review.headCommit !== manifest.source.commit ||
        manifest.review.candidatePreimageDigest !== operation.targetFileSha256 ||
        manifest.review.patchSha256 !== patchArtifact.sha256 ||
        manifest.review.patchBytes !== patchArtifact.bytes ||
        manifest.review.changedPath !== operation.filePath ||
        manifest.review.createdAt !== manifest.createdAt
    ) {
        throw new LocalPublicationTrustError('unsafe_artifact');
    }
    verifyReviewCheckout(
        join(generationPath, manifest.review.checkoutPath),
        manifest.review,
        patch,
        operation,
    );
}

/**
 * Verify a complete generation before its visibility marker is created.
 *
 * @param generationPath - Canonical reserved generation.
 * @param manifest - In-memory strict manifest.
 * @param manifestBytes - Exact manifest bytes already persisted.
 */
export function verifyUnmarkedLocalPublication(
    generationPath: string,
    manifest: LocalPublicationManifest,
    manifestBytes: Buffer,
): void {
    const persistedManifest = readStableArtifact(join(generationPath, 'manifest.json'));
    if (!persistedManifest.equals(manifestBytes)) {
        throw new LocalPublicationTrustError('unsafe_artifact');
    }
    const artifactBytes = new Map(
        manifest.artifacts.map((artifact) => [
            artifact.path,
            verifyPublicationArtifact(generationPath, artifact),
        ]),
    );
    const artifactByPath = new Map(manifest.artifacts.map((artifact) => [artifact.path, artifact]));
    const requiredBindings = [
        ['issue-input.json', manifest.bindings.issueInputSha256],
        ['run-result.json', manifest.bindings.runRecordSha256],
        ['agent-run-artifacts.json', manifest.bindings.agentRunArtifactsSha256],
        ['llm-usage.json', manifest.bindings.llmUsageSha256],
    ] as const;
    if (requiredBindings.some(([path, digest]) => artifactByPath.get(path)?.sha256 !== digest)) {
        throw new LocalPublicationTrustError('unsafe_artifact');
    }
    verifyLockedPublicationSemantics(manifest, artifactBytes);
    verifyPublicationOutcome(generationPath, manifest, artifactBytes);
    for (const image of manifest.images) {
        const artifact = artifactByPath.get(`evidence/${image.path}`);
        if (
            image.kind === 'omitted'
                ? artifact !== undefined
                : artifact?.sha256 !== image.sha256 || artifact.bytes !== image.bytes
        ) {
            throw new LocalPublicationTrustError('unsafe_artifact');
        }
    }
}

/**
 * Verify one visible append-only local publication, including marker, files and review checkout.
 *
 * @param generationPath - Exact published generation path.
 * @returns Parsed fully verified manifest.
 */
export function verifyLocalPublication(generationPath: string): LocalPublicationManifest {
    if (
        !isAbsolute(generationPath) ||
        generationPath !== resolve(generationPath) ||
        hasUnsafeControl(generationPath) ||
        Array.from(generationPath).some((character) => '*?{}[]'.includes(character))
    ) {
        throw new LocalPublicationTrustError('unsafe_artifact');
    }
    const generationStats = lstatSync(generationPath);
    if (!generationStats.isDirectory() || generationStats.isSymbolicLink()) {
        throw new LocalPublicationTrustError('unsafe_artifact');
    }
    const canonicalGeneration = realpathSync(generationPath);
    const runsPath = dirname(canonicalGeneration);
    const runsStats = lstatSync(runsPath);
    if (
        canonicalGeneration !== generationPath ||
        !runsStats.isDirectory() ||
        runsStats.isSymbolicLink() ||
        basename(runsPath) !== 'runs' ||
        realpathSync(runsPath) !== runsPath
    ) {
        throw new LocalPublicationTrustError('unsafe_artifact');
    }
    const id = basename(canonicalGeneration);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) {
        throw new LocalPublicationTrustError('unsafe_artifact');
    }
    const ownership = readStableArtifact(
        join(canonicalGeneration, LOCAL_PUBLICATION_OWNERSHIP_MARKER),
    ).toString('utf8');
    if (ownership !== `adguard-filters-agent publication ${id}\n`) {
        throw new LocalPublicationTrustError('unsafe_artifact');
    }
    const manifestBytes = readStableArtifact(join(canonicalGeneration, 'manifest.json'));
    const publishedDigest = readStableArtifact(
        join(canonicalGeneration, LOCAL_PUBLICATION_VISIBLE_MARKER),
    )
        .toString('utf8')
        .trim();
    if (publishedDigest !== sha256(manifestBytes)) {
        throw new LocalPublicationTrustError('unsafe_artifact');
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(manifestBytes.toString('utf8')) as unknown;
    } catch {
        throw new LocalPublicationTrustError('unsafe_artifact');
    }
    const manifest = parseLocalPublicationManifest(parsed);
    if (manifest.publicationId !== id) {
        throw new LocalPublicationTrustError('unsafe_artifact');
    }
    try {
        verifyUnmarkedLocalPublication(canonicalGeneration, manifest, manifestBytes);
    } catch (error) {
        if (error instanceof LocalPublicationTrustError) {
            throw error;
        }
        // Preserve the inner failure identity: a ReviewCheckoutError carries its own stable
        // code and bounded detail, and losing them made transport damage indistinguishable
        // from a hostile artifact.
        throw new LocalPublicationTrustError(
            'unsafe_artifact',
            error instanceof ReviewCheckoutError
                ? `review_checkout:${error.code}${error.detail ? ` ${error.detail}` : ''}`
                : (error as Error).name,
        );
    }
    return manifest;
}

/**
 * List all fully verified consumer-visible local publications.
 *
 * @param outputRoot - Existing local output root.
 * @returns Verified manifests in generation path order.
 */
export function listVerifiedLocalPublications(outputRoot: string): LocalPublicationManifest[] {
    return listPublishedLocalGenerations(outputRoot).map((path) => verifyLocalPublication(path));
}

/**
 * Explicitly remove one exact fully verified publication generation.
 *
 * No later local cycle calls this API. Verification of evidence and any detached review checkout
 * must succeed immediately before the ownership-guarded removal.
 *
 * @param generationPath - Exact canonical published generation path selected by the operator.
 */
export function cleanupLocalPublication(generationPath: string): void {
    verifyLocalPublication(generationPath);
    removeVerifiedLocalPublicationGeneration(generationPath);
}
