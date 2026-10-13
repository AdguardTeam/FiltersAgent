import * as v from 'valibot';
import { EnvironmentCapabilitySchema } from '../environment/environment-vocabulary';
import {
    ActualExecutionContextSchema,
    AgentIntentAssessmentSchema,
    EnvironmentSelectionSnapshotSchema,
    ReportedExecutionContextSchema,
} from '../environment/environment-selection-contract';
import { DeclaredIssueContextSchema } from '../environment/declared-issue-context';
import {
    EnvironmentCleanupReceiptSchema,
    FilteringEnvironmentExecutionSchema,
} from '../environment/filtering-environment';
import { type ReviewCandidateOperation } from '../repo/repository-edit';
import { GIT_OBJECT_ID_PATTERN } from '../types/git-object-id';
import { CandidatePatchSchema, FixRunStatusSchema } from '../types/fix-run-result';
import { REPOSITORY_SLUG_PATTERN } from '../types/repository-slug';
import type { PreparedFiltersCheckout } from './filters-preparer';
import {
    LOCAL_PUBLICATION_OWNERSHIP_MARKER,
    LOCAL_PUBLICATION_VISIBLE_MARKER,
} from './output-directory';
import { type ReviewWorkspaceReceipt } from './review-checkout';
import { type LocalRunRecord } from './run-output';
import { EXTENSION_ENVIRONMENT_KIND_VALUES } from '../types/extension-environment-kind';
import { CHECKOUT_SOURCE_VALUES } from '../types/checkout-source';
import { INPUT_ORIGIN_VALUES, type InputOrigin } from '../types/input-origin';
import {
    ReviewCandidateDisposition,
    REVIEW_CANDIDATE_DISPOSITION_VALUES,
} from '../types/review-candidate-disposition';
import { PublicationOutcome, PUBLICATION_OUTCOME_VALUES } from '../types/publication-outcome';
import { SETTINGS_APPLICATION_STATUS_VALUES } from '../types/settings-application-status';
import { ACTIVATION_PROOF_VALUES } from '../types/activation-proof';
import { SETTINGS_PROFILE_KIND_VALUES } from '../types/settings-profile-kind';
import { CANDIDATE_BINDING_FAILURE_CODE_VALUES } from '../types/candidate-binding-failure-code';
import {
    LocalPublicationTrustError,
    LocalPublicationTrustFailureCode,
    MAX_CAPTURE_PIXELS,
    MAX_EVIDENCE_FILE_BYTES,
    normalizeEvidencePath,
    schemaIssueDetail,
    type PublishedImageCapture,
    type PublishedImageOmission,
} from './local-publication-trust';
import { MAX_EVIDENCE_FILES } from './evidence-sanitizer';

/**
 * The publication vocabulary: what a generation IS, and how a manifest is proved to say it.
 *
 * The manifest's own types, the Valibot schemas that validate each of them, the projection that
 * derives a manifest's semantic bindings from a run record, and the single parser both sides go
 * through. The writer builds a manifest here, the verifier re-derives and re-parses one here, and a
 * rule stated once cannot drift between them — `projectRunBindings` in particular is shared by
 * both, which is why it lives with the bindings shape it produces rather than with either side.
 *
 * The checks a manifest reports the outcome of — the resource caps, the path normalization, the
 * digest, the trust failure codes and their error — are one layer below in
 * `local-publication-trust`, which this module imports and which imports nothing back.
 */

/**
 * Digest entry for every exact file covered by a local publication manifest.
 */
export interface LocalPublicationArtifactDigest {
    /**
     * Normalized generation-relative path.
     */
    path: string;

    /**
     * Lowercase SHA-256 of exact persisted bytes.
     */
    sha256: string;

    /**
     * Exact persisted byte count.
     */
    bytes: number;
}

/**
 * Stage at which a sanitized publication failure occurred.
 */
export const LocalPublicationFailureStage = {
    /**
     * The failure occurred while binding the verified candidate to its source location.
     */
    CandidateBinding: 'candidate_binding',

    /**
     * The failure occurred while checking out the review copy of the repository.
     */
    ReviewCheckout: 'review_checkout',
} as const;

/**
 * LocalPublicationFailureStage value.
 */
export type LocalPublicationFailureStage =
    (typeof LocalPublicationFailureStage)[keyof typeof LocalPublicationFailureStage];

/**
 * Sanitized stable failure retained by an evidence-only publication.
 */
export interface LocalPublicationFailure {
    /**
     * Stable bounded failure code.
     */
    code: string;

    /**
     * Stable failure stage.
     */
    stage: LocalPublicationFailureStage;

    /**
     * Bounded sanitized human-readable detail.
     */
    detail: string;
}

/**
 * Bound candidate disposition serialized in a strict local publication manifest.
 */
export interface BoundLocalPublicationCandidateDisposition {
    /**
     * Bound candidate discriminator.
     */
    kind: 'bound';

    /**
     * Exact source-bound add, edit, or remove operation.
     */
    operation: ReviewCandidateOperation;
}

/**
 * Legitimate no-candidate disposition serialized in a strict manifest.
 */
export interface NotApplicableLocalPublicationCandidateDisposition {
    /**
     * No-candidate discriminator.
     */
    kind: 'not_applicable';

    /**
     * Stable reason why no review checkout is applicable.
     */
    disposition: ReviewCandidateDisposition;
}

/**
 * Sanitized candidate-binding failure serialized in a strict manifest.
 */
export interface FailedLocalPublicationCandidateDisposition {
    /**
     * Candidate-binding failure discriminator.
     */
    kind: 'failed';

    /**
     * Stable bounded failure facts.
     */
    failure: LocalPublicationFailure;
}

/**
 * Candidate disposition serialized in one strict local publication manifest.
 */
export type LocalPublicationCandidateDisposition =
    | BoundLocalPublicationCandidateDisposition
    | NotApplicableLocalPublicationCandidateDisposition
    | FailedLocalPublicationCandidateDisposition;

/**
 * Immutable issue identity bound into a publication manifest.
 */
export interface LocalPublicationIssueIdentity {
    /**
     * Repository containing the captured issue.
     */
    repository: string;

    /**
     * Captured issue number.
     */
    issueNumber: number;

    /**
     * Upstream issue revision timestamp.
     */
    sourceUpdatedAt: string;

    /**
     * Complete source-envelope integrity digest.
     */
    sourceIntegrityDigest: string;

    /**
     * Prompt-safe source integrity digest.
     */
    sourcePromptIntegrityDigest: string;

    /**
     * Verified revision digest.
     */
    revisionDigest: string;

    /**
     * Verified prompt digest.
     */
    promptDigest: string;

    /**
     * Trusted revision capture origin.
     */
    inputOrigin: InputOrigin;
}

/**
 * Artifact and semantic bindings stored in one publication manifest.
 */
export interface LocalPublicationBindings {
    /**
     * Digest of the public issue input.
     */
    issueInputSha256: string;

    /**
     * Digest of the canonical run record.
     */
    runRecordSha256: string;

    /**
     * Digest of model-authored run artifacts.
     */
    agentRunArtifactsSha256: string;

    /**
     * Digest of the provider usage snapshot.
     */
    llmUsageSha256: string;

    /**
     * Issue-form classification declared by the report.
     */
    declaredType: unknown;

    /**
     * Agent-observed issue classification.
     */
    observedType: unknown;

    /**
     * Product and browser context reported by the user.
     */
    reportedContext: unknown;

    /**
     * Product and browser context actually exercised.
     */
    actualContext: unknown;

    /**
     * Complete environment-selection decision.
     */
    environmentChoice: unknown;

    /**
     * Recorded fidelity limitations and conflicts.
     */
    fidelity: unknown;

    /**
     * Filter settings and environment execution facts.
     */
    filters: unknown;

    /**
     * Canonical phase evidence.
     */
    phaseEvidence: unknown;

    /**
     * Environment cleanup receipt.
     */
    cleanup: unknown;
}

/**
 * Complete consumer-visible manifest for one append-only local generation.
 */
export interface LocalPublicationManifest {
    /**
     * Manifest format version.
     */
    schemaVersion: 1;

    /**
     * Lowercase publication UUID.
     */
    publicationId: string;

    /**
     * Normal or sanitized evidence-only outcome.
     */
    outcome: PublicationOutcome;

    /**
     * Host clock timestamp.
     */
    createdAt: string;

    /**
     * Immutable issue revision identity.
     */
    issue: LocalPublicationIssueIdentity;

    /**
     * Exact source repository provenance.
     */
    source: PreparedFiltersCheckout['provenance'];

    /**
     * Digests and selected semantic fields binding the complete run.
     */
    bindings: LocalPublicationBindings;

    /**
     * Exact candidate binding disposition.
     */
    candidate: LocalPublicationCandidateDisposition;

    /**
     * Sanitized failure for evidence-only output.
     */
    failure: LocalPublicationFailure | null;

    /**
     * Every generation file except the manifest and marker files.
     */
    artifacts: LocalPublicationArtifactDigest[];

    /**
     * Trusted captures and typed raw-image omissions.
     */
    images: (PublishedImageCapture | PublishedImageOmission)[];

    /**
     * Detached review receipt for a normal bound publication.
     */
    review: ReviewWorkspaceReceipt | null;
}

/**
 * Strict lowercase SHA-256 value accepted from persisted publication data.
 */
export const LocalPublicationSha256Schema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u));

/**
 * Strict lowercase Git object identifier accepted from persisted publication data.
 */
const LocalPublicationGitOidSchema = v.pipe(v.string(), v.regex(GIT_OBJECT_ID_PATTERN));

/**
 * Non-negative safe integer used by persisted byte and count fields.
 */
const LocalPublicationCountSchema = v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(Number.MAX_SAFE_INTEGER),
);

/**
 * Positive safe integer used by persisted line and dimension fields.
 */
export const LocalPublicationPositiveCountSchema = v.pipe(
    LocalPublicationCountSchema,
    v.minValue(1),
);

/**
 * Check whether one persisted path is a normalized portable relative path.
 *
 * @param path - Untrusted persisted path.
 * @returns Whether the path passes the publication path boundary.
 */
function isSafeLocalPublicationPath(path: string): boolean {
    try {
        return normalizeEvidencePath(path) === path;
    } catch {
        return false;
    }
}

/**
 * Strict portable path accepted from a persisted publication manifest.
 */
const LocalPublicationPathSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.check(isSafeLocalPublicationPath, 'Publication paths must be normalized relative paths.'),
);

/**
 * Strict source-bound operation fields shared by add, edit, and remove candidates.
 */
const LocalPublicationOperationBaseEntries = {
    sourceCommit: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u)),
    filePath: LocalPublicationPathSchema,
    targetBlobOid: LocalPublicationGitOidSchema,
    targetFileSha256: LocalPublicationSha256Schema,
    targetBytes: v.pipe(LocalPublicationCountSchema, v.maxValue(16 * 1024 * 1024)),
    targetLines: v.pipe(LocalPublicationCountSchema, v.maxValue(500_000)),
    line: LocalPublicationPositiveCountSchema,
};

/**
 * Strict persisted add operation including its exact insertion boundary.
 */
const AddLocalPublicationOperationSchema = v.pipe(
    v.strictObject({
        operation: v.literal('add'),
        ...LocalPublicationOperationBaseEntries,
        beforeLine: v.string(),
        afterLine: v.string(),
        insertionBoundarySha256: LocalPublicationSha256Schema,
        addedRule: v.pipe(
            v.string(),
            v.minLength(1),
            v.maxLength(16 * 1024),
            v.regex(/^[^\r\n]+$/u),
        ),
        precedingComment: v.optional(
            v.pipe(v.string(), v.minLength(1), v.maxLength(16 * 1024), v.regex(/^[^\r\n]+$/u)),
        ),
    }),
    v.check(
        (operation) => operation.line <= operation.targetLines + 1,
        'Add line must name a source insertion boundary.',
    ),
);

/**
 * Strict persisted edit operation including the exact source and replacement rules.
 */
const EditLocalPublicationOperationSchema = v.pipe(
    v.strictObject({
        operation: v.literal('edit'),
        ...LocalPublicationOperationBaseEntries,
        originalRule: v.pipe(
            v.string(),
            v.minLength(1),
            v.maxLength(16 * 1024),
            v.regex(/^[^\r\n]+$/u),
        ),
        replacementRule: v.pipe(
            v.string(),
            v.minLength(1),
            v.maxLength(16 * 1024),
            v.regex(/^[^\r\n]+$/u),
        ),
    }),
    v.check(
        (operation) => operation.line <= operation.targetLines,
        'Edit line must identify an existing source line.',
    ),
);

/**
 * Strict persisted remove operation including the exact source rule.
 */
const RemoveLocalPublicationOperationSchema = v.pipe(
    v.strictObject({
        operation: v.literal('remove'),
        ...LocalPublicationOperationBaseEntries,
        originalRule: v.pipe(
            v.string(),
            v.minLength(1),
            v.maxLength(16 * 1024),
            v.regex(/^[^\r\n]+$/u),
        ),
    }),
    v.check(
        (operation) => operation.line <= operation.targetLines,
        'Remove line must identify an existing source line.',
    ),
);

/**
 * Strict tagged source-bound candidate operation.
 */
const LocalPublicationOperationSchema = v.variant('operation', [
    AddLocalPublicationOperationSchema,
    EditLocalPublicationOperationSchema,
    RemoveLocalPublicationOperationSchema,
]);

/**
 * Strict candidate-binding failure persisted in a manifest.
 */
const CandidateBindingPublicationFailureSchema = v.strictObject({
    code: v.picklist(CANDIDATE_BINDING_FAILURE_CODE_VALUES),
    stage: v.literal(LocalPublicationFailureStage.CandidateBinding),
    detail: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
});

/**
 * Strict review-checkout failure persisted in a manifest.
 */
const ReviewCheckoutPublicationFailureSchema = v.strictObject({
    code: v.picklist([
        'review_precondition_failed',
        'review_git_failed',
        'review_unsafe_checkout',
        'review_resource_limit',
    ]),
    stage: v.literal(LocalPublicationFailureStage.ReviewCheckout),
    detail: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
});

/**
 * Strict tagged publication failure.
 */
const LocalPublicationFailureSchema = v.variant('stage', [
    CandidateBindingPublicationFailureSchema,
    ReviewCheckoutPublicationFailureSchema,
]);

/**
 * Strict tagged candidate disposition persisted in a manifest.
 */
const LocalPublicationCandidateSchema = v.variant('kind', [
    v.strictObject({
        kind: v.literal('bound'),
        operation: LocalPublicationOperationSchema,
    }),
    v.strictObject({
        kind: v.literal('not_applicable'),
        disposition: v.picklist(REVIEW_CANDIDATE_DISPOSITION_VALUES),
    }),
    v.strictObject({
        kind: v.literal('failed'),
        failure: CandidateBindingPublicationFailureSchema,
    }),
]);

/**
 * Strict immutable issue identity persisted in a manifest.
 */
const LocalPublicationIssueSchema = v.strictObject({
    repository: v.pipe(v.string(), v.regex(REPOSITORY_SLUG_PATTERN), v.maxLength(200)),
    issueNumber: LocalPublicationPositiveCountSchema,
    sourceUpdatedAt: v.pipe(v.string(), v.isoTimestamp()),
    sourceIntegrityDigest: LocalPublicationSha256Schema,
    sourcePromptIntegrityDigest: LocalPublicationSha256Schema,
    revisionDigest: LocalPublicationSha256Schema,
    promptDigest: LocalPublicationSha256Schema,
    inputOrigin: v.picklist(INPUT_ORIGIN_VALUES),
});

/**
 * Strict filters-source provenance persisted in a manifest.
 */
const LocalPublicationSourceSchema = v.strictObject({
    environment: v.picklist(EXTENSION_ENVIRONMENT_KIND_VALUES),
    source: v.picklist(CHECKOUT_SOURCE_VALUES),
    sourceLocation: v.pipe(v.string(), v.minLength(1), v.maxLength(4_096)),
    requestedRevision: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
    commit: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u)),
});

/**
 * Strict enabled-filter evidence nested in one persisted settings profile.
 */
const LocalPublicationEnabledFilterSchema = v.strictObject({
    id: v.union([v.string(), v.number()]),
    name: v.string(),
    group: v.nullable(v.string()),
    version: v.nullable(v.string()),
    metadataEnabled: v.boolean(),
    runtimeEnabled: v.boolean(),
});

/**
 * Strict settings-profile evidence nested in publication bindings.
 */
export const LocalPublicationSettingsProfileSchema = v.strictObject({
    name: v.picklist(SETTINGS_PROFILE_KIND_VALUES),
    status: v.picklist(SETTINGS_APPLICATION_STATUS_VALUES),
    detail: v.nullable(v.string()),
    activationProof: v.picklist(ACTIVATION_PROOF_VALUES),
    // Null mirrors the run-record contract: a proof-less profile never observed its enabled set,
    // and the manifest duplicates that record verbatim, so the null must survive publication.
    enabledFilters: v.nullable(v.array(LocalPublicationEnabledFilterSchema)),
});

/**
 * Strict duplicated semantic and digest bindings persisted in a manifest.
 */
const LocalPublicationBindingsSchema = v.strictObject({
    issueInputSha256: LocalPublicationSha256Schema,
    runRecordSha256: LocalPublicationSha256Schema,
    agentRunArtifactsSha256: LocalPublicationSha256Schema,
    llmUsageSha256: LocalPublicationSha256Schema,
    declaredType: v.nullable(DeclaredIssueContextSchema),
    observedType: v.nullable(AgentIntentAssessmentSchema),
    reportedContext: v.nullable(ReportedExecutionContextSchema),
    actualContext: v.nullable(ActualExecutionContextSchema),
    environmentChoice: v.nullable(EnvironmentSelectionSnapshotSchema),
    fidelity: v.strictObject({
        missingCapabilities: v.pipe(v.array(EnvironmentCapabilitySchema), v.maxLength(16)),
        conflicts: v.pipe(
            v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))),
            v.maxLength(8),
        ),
    }),
    filters: v.strictObject({
        settingsProfiles: v.array(LocalPublicationSettingsProfileSchema),
        environmentExecution: v.nullable(FilteringEnvironmentExecutionSchema),
    }),
    phaseEvidence: v.nullable(FilteringEnvironmentExecutionSchema),
    cleanup: v.nullable(EnvironmentCleanupReceiptSchema),
});

/**
 * Strict digest and size entry for one locked publication artifact.
 */
const LocalPublicationArtifactSchema = v.pipe(
    v.strictObject({
        path: LocalPublicationPathSchema,
        sha256: LocalPublicationSha256Schema,
        bytes: v.pipe(LocalPublicationCountSchema, v.maxValue(MAX_EVIDENCE_FILE_BYTES)),
    }),
    v.check(
        (artifact) =>
            ![
                'manifest.json',
                LOCAL_PUBLICATION_OWNERSHIP_MARKER,
                LOCAL_PUBLICATION_VISIBLE_MARKER,
            ].includes(artifact.path),
        'Publication marker and manifest files cannot be artifact entries.',
    ),
);

/**
 * Strict tagged image capture or omission persisted in a manifest.
 */
const LocalPublicationImageSchema = v.variant('kind', [
    v.pipe(
        v.strictObject({
            kind: v.literal('capture'),
            path: LocalPublicationPathSchema,
            role: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
            proofId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)),
            sha256: LocalPublicationSha256Schema,
            bytes: v.pipe(LocalPublicationCountSchema, v.maxValue(MAX_EVIDENCE_FILE_BYTES)),
            width: v.pipe(LocalPublicationPositiveCountSchema, v.maxValue(MAX_CAPTURE_PIXELS)),
            height: v.pipe(LocalPublicationPositiveCountSchema, v.maxValue(MAX_CAPTURE_PIXELS)),
        }),
        v.check(
            (capture) => capture.width * capture.height <= MAX_CAPTURE_PIXELS,
            'Captured image dimensions exceed the supported pixel count.',
        ),
    ),
    v.strictObject({
        kind: v.literal('omitted'),
        path: LocalPublicationPathSchema,
        role: v.literal('browser_evidence'),
        reason: v.literal('untrusted_image_without_pixel_redaction_proof'),
    }),
]);

/**
 * Strict detached review-workspace receipt persisted in a manifest.
 */
export const LocalPublicationReviewSchema = v.strictObject({
    checkoutPath: v.literal('review'),
    sourceCommit: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u)),
    headCommit: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u)),
    indexTreeDigest: LocalPublicationGitOidSchema,
    candidatePreimageDigest: LocalPublicationSha256Schema,
    patchSha256: LocalPublicationSha256Schema,
    patchBytes: v.pipe(LocalPublicationCountSchema, v.maxValue(4 * 1024 * 1024)),
    changedPath: LocalPublicationPathSchema,
    checkoutFiles: v.pipe(LocalPublicationCountSchema, v.maxValue(100_000)),
    checkoutBytes: v.pipe(LocalPublicationCountSchema, v.maxValue(1024 * 1024 * 1024)),
    createdAt: v.pipe(v.string(), v.isoTimestamp()),
    cleanupEligible: v.literal(true),
});

/**
 * Strict complete persisted local-publication manifest.
 */
export const LocalPublicationManifestSchema = v.pipe(
    v.strictObject({
        schemaVersion: v.literal(1),
        publicationId: v.pipe(
            v.string(),
            v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
        ),
        outcome: v.picklist(PUBLICATION_OUTCOME_VALUES),
        createdAt: v.pipe(v.string(), v.isoTimestamp()),
        issue: LocalPublicationIssueSchema,
        source: LocalPublicationSourceSchema,
        bindings: LocalPublicationBindingsSchema,
        candidate: LocalPublicationCandidateSchema,
        failure: v.nullable(LocalPublicationFailureSchema),
        artifacts: v.pipe(v.array(LocalPublicationArtifactSchema), v.maxLength(512)),
        // Every image record is one collection file, captured or omitted, so the sanitizer's file
        // cap is the bound: a lower one refuses a collection the sanitizer already accepted.
        images: v.pipe(v.array(LocalPublicationImageSchema), v.maxLength(MAX_EVIDENCE_FILES)),
        review: v.nullable(LocalPublicationReviewSchema),
    }),
    v.check(
        (manifest) =>
            new Set(manifest.artifacts.map((artifact) => artifact.path)).size ===
                manifest.artifacts.length &&
            new Set(manifest.images.map((image) => image.path)).size === manifest.images.length,
        'Publication artifact and image paths must be unique.',
    ),
);

/**
 * Strict semantic projection read from a digest-verified sanitized run record.
 *
 * The complete local run schema cannot be replayed after publication redaction because structural
 * fields such as `browserSessions` are deliberately replaced. This projection validates every field
 * duplicated into the publication manifest while ignoring unrelated redacted evidence.
 */
export const LockedPublicationRunProjectionSchema = v.object({
    result: v.object({
        issueNumber: LocalPublicationPositiveCountSchema,
        runStatus: FixRunStatusSchema,
        environmentSelection: v.optional(EnvironmentSelectionSnapshotSchema),
        environmentExecution: v.optional(FilteringEnvironmentExecutionSchema),
        candidatePatch: v.nullable(CandidatePatchSchema),
        filtersBaseSha: v.optional(v.nullable(v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/iu)))),
    }),
    provenance: v.object({
        environment: v.picklist(EXTENSION_ENVIRONMENT_KIND_VALUES),
        settingsProfiles: v.array(LocalPublicationSettingsProfileSchema),
    }),
});

/**
 * Semantic fields recovered from a digest-verified sanitized run record.
 */
export type LockedPublicationRunProjection = v.InferOutput<
    typeof LockedPublicationRunProjectionSchema
>;

/**
 * Canonical digests used to bind primary publication files to semantic manifest fields.
 */
export interface LocalPublicationPrimaryDigests {
    /**
     * Public issue-input digest.
     */
    issueInputSha256: string;

    /**
     * Canonical run-record digest.
     */
    runRecordSha256: string;

    /**
     * Model-authored artifact digest.
     */
    agentRunArtifactsSha256: string;

    /**
     * Provider usage snapshot digest.
     */
    llmUsageSha256: string;
}

/**
 * Build complete manifest semantic bindings from the canonical run record.
 *
 * @param record - Canonical run record.
 * @param digests - Canonical artifact digests.
 * @returns Complete semantic binding projection.
 */
export function projectRunBindings(
    record: LocalRunRecord | LockedPublicationRunProjection,
    digests: LocalPublicationPrimaryDigests,
): LocalPublicationManifest['bindings'] {
    const selection = record.result.environmentSelection;
    const execution = record.result.environmentExecution;
    return {
        ...digests,
        declaredType: selection?.declared ?? null,
        observedType: selection?.observed ?? null,
        reportedContext: selection?.reported ?? null,
        actualContext: selection?.actual ?? null,
        environmentChoice: selection ?? null,
        fidelity: {
            missingCapabilities: selection?.missingCapabilities ?? [],
            conflicts: selection?.observed?.conflicts ?? [],
        },
        filters: {
            settingsProfiles: record.provenance.settingsProfiles,
            environmentExecution: execution ?? null,
        },
        phaseEvidence: execution ?? null,
        cleanup: execution?.cleanup ?? null,
    };
}

/**
 * Parse a persisted manifest with bounded runtime checks needed by the verifier.
 *
 * @param value - Parsed untrusted JSON.
 * @returns Structurally checked manifest.
 */
export function parseLocalPublicationManifest(value: unknown): LocalPublicationManifest {
    const parsed = v.safeParse(LocalPublicationManifestSchema, value);
    if (!parsed.success) {
        throw new LocalPublicationTrustError(
            LocalPublicationTrustFailureCode.UnsafeArtifact,
            schemaIssueDetail(parsed.issues[0]),
        );
    }
    return parsed.output;
}
