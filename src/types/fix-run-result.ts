import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import * as v from 'valibot';
import { CandidateVisualReviewSchema } from './candidate-visual-review';
import {
    ReporterSymptomPresence,
    SYMPTOM_PRESENCE_VALUES,
    type SymptomPresence,
} from './reporter-symptom-presence';
import { PLACEMENT_BASIS_VALUES } from './placement-basis';
import { ReproProfileSchema, reproEnvironmentsEqual } from './repro-profile';
import { RuleTypeSchema } from './rule-proposal';
import { UpstreamSourceDriftSchema } from './upstream-source-drift';
import { FilterListKeySchema } from '../environment/filter-list-ref';
import {
    CliAdapterProofSchema,
    PhaseApplicationProofSchema,
    PreparedExtensionProvenanceSchema,
} from '../environment/environment-proofs';
import {
    EnvironmentBrowserCaptureSchema,
    FilteringEnvironmentExecutionSchema,
} from '../environment/filtering-environment';
import {
    EnvironmentDispositionStatus,
    EnvironmentSelectionReservedCase,
    EnvironmentSelectionState,
} from '../environment/environment-vocabulary';
import { EnvironmentSelectionSnapshotSchema } from '../environment/environment-selection-contract';
import { projectEnvironmentResult } from '../environment/environment-result-projection';
import { ENVIRONMENT_PROJECTION_REFUSAL_VALUES } from './environment-projection-refusal';
import {
    CANDIDATE_VALIDATION_ARTIFACT_ID_PATTERN,
    candidateArtifactIdentitiesEqual,
    parseCandidateValidationArtifactFilename,
    parseCandidateValidationArtifactId,
    parseCandidateVisualReviewArtifactFilename,
    parseCandidateVisualReviewArtifactId,
} from './candidate-artifact-identity';
import { CandidateForReviewSchema } from './candidate-for-review';
import { PhaseLabel } from './validation';
import { MISSING_CATALOG_FILTER_REASON_VALUES } from './missing-catalog-filter-reason';
import { RepositoryEditKind } from './repository-edit-kind';
import {
    MAX_MISSING_INFORMATION_ENTRIES,
    MissingInformationEntrySchema,
} from './missing-information';
import { SettingsProfileKind, SETTINGS_PROFILE_KIND_VALUES } from './settings-profile-kind';
import { RULE_SYNTAX_KIND_VALUES } from './rule-syntax-kind';
import {
    BROWSER_FALLBACK_REASON_VALUES,
    type BrowserFallbackReason,
} from './browser-fallback-reason';
import { BrowserMode, BROWSER_MODE_VALUES } from './browser-mode';
import { RepositoryLintNoteSchema } from './repository-lint';
import {
    AgentTerminationReason,
    AGENT_TERMINATION_REASON_VALUES,
} from './agent-termination-reason';
import {
    InfrastructureFailureReason,
    INFRASTRUCTURE_FAILURE_REASON_VALUES,
} from './infrastructure-failure-reason';

/**
 * Compare JSON-safe result projections structurally and in order.
 *
 * @param left - First value.
 * @param right - Second value.
 * @returns Whether both values serialize identically.
 */
function structuresEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Compare environment-owned artifact fields while allowing independent run-level diagnostics.
 *
 * @param projected - Artifact paths derived only from canonical environment execution.
 * @param actual - Final paths after deterministic run-level artifact merging.
 * @returns Whether every environment-owned path remains exact and ordered.
 */
function environmentArtifactPathsAgree(
    projected: FixRunArtifactPaths,
    actual: FixRunArtifactPaths,
): boolean {
    return environmentArtifactPathDisagreements(projected, actual).length === 0;
}

/**
 * Name each artifact path family that disagrees with the canonical projection.
 *
 * @param projected - Paths projected from canonical execution.
 * @param actual - Paths carried by the assembled result.
 * @returns Names of the disagreeing families; empty when they agree.
 */
function environmentArtifactPathDisagreements(
    projected: FixRunArtifactPaths,
    actual: FixRunArtifactPaths,
): string[] {
    const projectedScreenshots = new Set(projected.screenshots);
    const actualEnvironmentScreenshots = actual.screenshots.filter((path) =>
        projectedScreenshots.has(path),
    );
    const disagreements: string[] = [];
    if (!structuresEqual(projected.screenshots, actualEnvironmentScreenshots)) {
        const missing = projected.screenshots.filter((path) => !actual.screenshots.includes(path));
        disagreements.push(
            missing.length > 0
                ? `screenshots (missing ${missing.length} of ${projected.screenshots.length})`
                : 'screenshots (order differs)',
        );
    }
    if (projected.domSnapshot !== actual.domSnapshot) {
        disagreements.push('domSnapshot');
    }
    if (projected.har !== actual.har) {
        disagreements.push('har');
    }
    if (projected.candidateVisualReview !== actual.candidateVisualReview) {
        disagreements.push('candidateVisualReview');
    }
    if (
        !structuresEqual(
            projected.verifiedCandidateScreenshots,
            actual.verifiedCandidateScreenshots,
        )
    ) {
        disagreements.push('verifiedCandidateScreenshots');
    }
    if (
        !structuresEqual(
            projected.rejectedCandidateScreenshots,
            actual.rejectedCandidateScreenshots,
        )
    ) {
        disagreements.push('rejectedCandidateScreenshots');
    }
    return disagreements;
}

/**
 * Whether a browser session ran without AdGuard or with the prepared extension.
 */
export const ExtensionMode = { None: 'none', Prepared: 'prepared' } as const;

/**
 * Every extension mode value, for schemas and exhaustive listings.
 */
export const EXTENSION_MODE_VALUES = Object.values(ExtensionMode);

/**
 * Extension mode of one browser session.
 */
export type ExtensionMode = (typeof ExtensionMode)[keyof typeof ExtensionMode];

export const BrowserModeSchema = v.picklist(BROWSER_MODE_VALUES);

/**
 * How an investigation executed: with a live browser or from reasoning alone.
 */
export const EffectiveMode = { Browser: 'browser', Reasoning: 'reasoning' } as const;

/**
 * Every effective mode value, for schemas and exhaustive listings.
 */
export const EFFECTIVE_MODE_VALUES = Object.values(EffectiveMode);

export const EffectiveModeSchema = v.picklist(EFFECTIVE_MODE_VALUES);

/**
 * Strength of live verification attached to the run result.
 */
export const VerificationStatus = {
    /**
     * The result was fully verified against a live browser reproduction.
     */
    Verified: 'verified',

    /**
     * Some but not all of the verification a complete run would perform was completed.
     */
    Partial: 'partial',

    /**
     * Browser verification was required but no usable browser was available.
     */
    Unavailable: 'unavailable',

    /**
     * No live verification was attempted, because the run used browser mode `off`.
     */
    NotAttempted: 'not_attempted',
} as const;

/**
 * Every VerificationStatus value, for schemas and exhaustive listings.
 */
export const VERIFICATION_STATUS_VALUES = Object.values(VerificationStatus);

/**
 * VerificationStatus value.
 */
export type VerificationStatus = (typeof VerificationStatus)[keyof typeof VerificationStatus];

export const VerificationStatusSchema = v.picklist(VERIFICATION_STATUS_VALUES);

/**
 * Whether the reporter's extension/filter settings were available and applied to the browser.
 */
export const ReproductionSettingsStatus = {
    /**
     * The reporter did not provide extension or filter settings for this run.
     */
    NotProvided: 'not_provided',

    /**
     * Reporter settings were parsed but could not be applied to the browser.
     */
    ParsedNotApplied: 'parsed_not_applied',

    /**
     * Reporter settings were parsed and applied to the browser exactly as reported.
     */
    Applied: 'applied',

    /**
     * Reporter settings were applied with some entries degraded due to catalog conflicts.
     */
    AppliedWithConflicts: 'applied_with_conflicts',
} as const;

/**
 * Every ReproductionSettingsStatus value, for schemas and exhaustive listings.
 */
export const REPRODUCTION_SETTINGS_STATUS_VALUES = Object.values(ReproductionSettingsStatus);

/**
 * ReproductionSettingsStatus value.
 */
export type ReproductionSettingsStatus =
    (typeof ReproductionSettingsStatus)[keyof typeof ReproductionSettingsStatus];

export const ReproductionSettingsStatusSchema = v.picklist(REPRODUCTION_SETTINGS_STATUS_VALUES);

/**
 * Browser observation of the exact defect defined by the issue evidence.
 */
export const SymptomObservation = {
    /**
     * The browser observed the reported symptom present.
     */
    Reproduced: 'reproduced',

    /**
     * The browser observed the reported symptom absent.
     */
    NotReproduced: 'not_reproduced',

    /**
     * The browser observation could not settle whether the symptom was present or absent.
     */
    Indeterminate: 'indeterminate',

    /**
     * No browser observation of the symptom was attempted.
     */
    NotAttempted: 'not_attempted',
} as const;

/**
 * Every SymptomObservation value, for schemas and exhaustive listings.
 */
export const SYMPTOM_OBSERVATION_VALUES = Object.values(SymptomObservation);

/**
 * SymptomObservation value.
 */
export type SymptomObservation = (typeof SymptomObservation)[keyof typeof SymptomObservation];

export const SymptomObservationSchema = v.picklist(SYMPTOM_OBSERVATION_VALUES);

/**
 * Whether current checkout rules independently resolved the reproduced selector in Phase B.
 */
export const CurrentRulesResolutionStatus = {
    /**
     * Current checkout rules were verified to resolve the reproduced selector.
     */
    Verified: 'verified',

    /**
     * Current checkout rules were checked and did not resolve the reproduced selector.
     */
    NotVerified: 'not_verified',

    /**
     * No attempt was made to verify current checkout rules against the reproduced selector.
     */
    NotAttempted: 'not_attempted',
} as const;

/**
 * Every CurrentRulesResolutionStatus value, for schemas and exhaustive listings.
 */
export const CURRENT_RULES_RESOLUTION_STATUS_VALUES = Object.values(CurrentRulesResolutionStatus);

/**
 * CurrentRulesResolutionStatus value.
 */
export type CurrentRulesResolutionStatus =
    (typeof CurrentRulesResolutionStatus)[keyof typeof CurrentRulesResolutionStatus];

export const CurrentRulesResolutionStatusSchema = v.picklist(
    CURRENT_RULES_RESOLUTION_STATUS_VALUES,
);

export const BrowserFallbackReasonSchema = v.picklist(BROWSER_FALLBACK_REASON_VALUES);

export const InfrastructureFailureReasonSchema = v.picklist(INFRASTRUCTURE_FAILURE_REASON_VALUES);

export const AgentTerminationReasonSchema = v.picklist(AGENT_TERMINATION_REASON_VALUES);

/**
 * Product outcome of a single fix run, independent from its execution mode.
 */
export const FixRunStatus = {
    /**
     * The reported defect is already fixed in the currently published extension build.
     */
    AlreadyFixedCurrent: 'already_fixed_current',

    /**
     * Fixed upstream already, but not yet reflected in the published extension build.
     */
    FixedUpstreamPendingExtension: 'fixed_upstream_pending_extension',

    /**
     * Fixed in the filter source, but not yet published.
     */
    FixedInSourcePendingPublication: 'fixed_in_source_pending_publication',

    /**
     * A verified candidate patch is proposed for the reported defect.
     */
    PatchProposed: 'patch_proposed',

    /**
     * The reported symptom could not be reproduced.
     */
    NotReproduced: 'not_reproduced',

    /**
     * The reported behavior depends on reporter-specific configuration not present by default.
     */
    ConfigurationSpecific: 'configuration_specific',

    /**
     * The run produced reasoning-only findings with no verified terminal disposition.
     */
    AnalysisOnly: 'analysis_only',

    /**
     * The reported product/environment combination is not supported by any environment.
     */
    UnsupportedProductCase: 'unsupported_product_case',

    /**
     * A required environment capability was unavailable during this run.
     */
    CapabilityLimited: 'capability_limited',

    /**
     * The reported target URL could not be reached during this run.
     */
    TargetUrlUnavailable: 'target_url_unavailable',

    /**
     * No usable browser was available to execute this run.
     */
    BrowserUnavailable: 'browser_unavailable',

    /**
     * Environment cleanup did not complete after this run.
     */
    CleanupFailed: 'cleanup_failed',

    /**
     * The run terminated in an unrecoverable failure.
     */
    Failed: 'failed',
} as const;

/**
 * Statuses that never carry a candidate patch: reasoning-only and terminal-failure outcomes are
 * report-only by contract.
 */
const REPORT_ONLY_RUN_STATUSES: readonly FixRunStatus[] = [
    FixRunStatus.AnalysisOnly,
    FixRunStatus.UnsupportedProductCase,
    FixRunStatus.CapabilityLimited,
    FixRunStatus.TargetUrlUnavailable,
    FixRunStatus.BrowserUnavailable,
    FixRunStatus.CleanupFailed,
    FixRunStatus.Failed,
];

/**
 * Every FixRunStatus value, for schemas and exhaustive listings.
 */
export const FIX_RUN_STATUS_VALUES = Object.values(FixRunStatus);

/**
 * FixRunStatus value.
 */
export type FixRunStatus = (typeof FixRunStatus)[keyof typeof FixRunStatus];

export const FixRunStatusSchema = v.picklist(FIX_RUN_STATUS_VALUES);

export const RuleSyntaxKindSchema = v.picklist(RULE_SYNTAX_KIND_VALUES);

export const RepositoryEditSchema = v.variant('kind', [
    v.object({
        kind: v.literal(RepositoryEditKind.Insert),
        insertionPoint: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
        anchorRule: v.optional(v.pipe(v.string(), v.minLength(1), v.regex(/^[^\r\n]+$/))),
        basis: v.optional(v.picklist(PLACEMENT_BASIS_VALUES)),
        precedingComment: v.optional(v.pipe(v.string(), v.minLength(1), v.regex(/^[^\r\n]+$/))),
    }),
    v.object({
        kind: v.literal(RepositoryEditKind.ExtendDomains),
        line: v.pipe(v.number(), v.integer(), v.minValue(1)),
        originalRule: v.pipe(v.string(), v.minLength(1), v.regex(/^[^\r\n]+$/)),
        replacementRule: v.pipe(v.string(), v.minLength(1), v.regex(/^[^\r\n]+$/)),
    }),
    v.object({
        kind: v.literal(RepositoryEditKind.Replace),
        line: v.pipe(v.number(), v.integer(), v.minValue(1)),
        originalRule: v.pipe(v.string(), v.minLength(1), v.regex(/^[^\r\n]+$/)),
        replacementRule: v.pipe(v.string(), v.minLength(1), v.regex(/^[^\r\n]+$/)),
    }),
    v.object({
        kind: v.literal(RepositoryEditKind.Remove),
        line: v.pipe(v.number(), v.integer(), v.minValue(1)),
        originalRule: v.pipe(v.string(), v.minLength(1), v.regex(/^[^\r\n]+$/)),
    }),
]);

export const CandidatePatchSchema = v.object({
    rule: v.pipe(v.string(), v.minLength(1)),
    ruleType: RuleTypeSchema,
    syntaxKind: v.optional(RuleSyntaxKindSchema),
    filePath: v.pipe(v.string(), v.minLength(1)),
    insertionPoint: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    repositoryEdit: v.optional(RepositoryEditSchema),
});

export const AgentExtensionProvenanceSchema = PreparedExtensionProvenanceSchema;

export const AgentSettingsProfileKindSchema = v.picklist(SETTINGS_PROFILE_KIND_VALUES);

// Fragments are deliberately accepted: evidence must state the URL the session actually navigated,
// and single-page players carry the video identity in the fragment.
export const AgentBrowserTargetUrlSchema = v.pipe(
    v.string(),
    v.url(),
    v.check((value) => {
        const url = new URL(value);
        return (
            ['http:', 'https:'].includes(url.protocol) &&
            url.username.length === 0 &&
            url.password.length === 0 &&
            url.href === value
        );
    }, 'Browser target URL must be canonical, credential-free HTTP(S).'),
);

export const AgentSettingsEvidenceSchema = v.strictObject({
    profileKind: AgentSettingsProfileKindSchema,
    // Null when the read-back could not observe the enabled set; a file-backed verification method
    // says "not observed" here instead of listing nothing.
    enabledListKeys: v.nullable(v.array(FilterListKeySchema)),
    enabledFilters: v.optional(
        v.array(
            v.strictObject({
                listKey: FilterListKeySchema,
                name: v.optional(v.pipe(v.string(), v.minLength(1))),
            }),
        ),
    ),
    skippedFilterConflicts: v.optional(
        v.array(
            v.strictObject({
                listKey: FilterListKeySchema,
                reason: v.picklist(MISSING_CATALOG_FILTER_REASON_VALUES),
                name: v.optional(v.pipe(v.string(), v.minLength(1))),
                subscriptionUrl: v.optional(v.pipe(v.string(), v.minLength(1))),
            }),
        ),
    ),
    // Null when the read-back could not observe the compiled DNR rulesets; the report says
    // "not observed" here instead of claiming a verified-empty set. An observed empty array stays
    // empty, and a record written before the field could be null still parses.
    activeRulesetListKeys: v.nullable(v.array(FilterListKeySchema)),
    // Null when the read-back could not observe the Stealth state; an observed false stays false.
    stealthEnabled: v.nullable(v.boolean()),
    limitsExceeded: v.boolean(),
});

/**
 * The environment's own capture schema: a recorded capture is copied into the result as it is, so a
 * twin schema here would let a field added to one side compile and fail the result parse.
 */
export const AgentBrowserCaptureEvidenceSchema = EnvironmentBrowserCaptureSchema;

export const AgentBrowserSessionEvidenceSchema = v.strictObject({
    sessionId: v.pipe(v.string(), v.minLength(1)),
    targetUrl: AgentBrowserTargetUrlSchema,
    extensionMode: v.picklist(EXTENSION_MODE_VALUES),
    profile: ReproProfileSchema,
    selectedSettingsProfileKind: v.optional(AgentSettingsProfileKindSchema),
    extensionProvenance: v.optional(AgentExtensionProvenanceSchema),
    settingsEvidence: v.optional(AgentSettingsEvidenceSchema),
    navigationVerified: v.boolean(),
    fullVisionVerified: v.boolean(),
    captures: v.array(AgentBrowserCaptureEvidenceSchema),
});

export const AgentConfigurationProfileReferenceSchema = v.strictObject({
    sessionId: v.pipe(v.string(), v.minLength(1)),
    profileKind: AgentSettingsProfileKindSchema,
    reporterSymptomPresence: v.picklist(SYMPTOM_PRESENCE_VALUES),
    viewportArtifactId: v.pipe(v.string(), v.minLength(1)),
    // Null when the browser captured no overview; the tiles carry the coverage proof.
    fullPageOverviewArtifactId: v.nullable(v.pipe(v.string(), v.minLength(1))),
    tileArtifactIds: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
});

/**
 * Reporter settings snapshot persisted with the locked run result.
 *
 * The intake extraction fills these from the model-filled report at result assembly; the publisher
 * re-derives its reporter-settings publication requirement from this snapshot instead of re-parsing
 * the issue body, so a run is only ever gated by what its own extraction read.
 */
export const ReporterSettingsSnapshotSchema = v.strictObject({
    /**
     * The settings-import link the reporter provided, when the report carries one.
     */
    settingsImportUrl: v.optional(v.pipe(v.string(), v.url())),

    /**
     * Enabled filter lists as the report names them (import lists included).
     */
    enabledFilters: v.array(v.pipe(v.string(), v.minLength(1))),

    /**
     * The reporter's product row, verbatim including version and manifest-generation markers.
     */
    product: v.pipe(v.string(), v.minLength(1)),
});

/**
 * The reporter settings snapshot the publication gate reads.
 */
export type ReporterSettingsSnapshot = v.InferOutput<typeof ReporterSettingsSnapshotSchema>;

export const AgentConfigurationComparisonEvidenceSchema = v.strictObject({
    extensionProvenance: AgentExtensionProvenanceSchema,
    reporter: AgentConfigurationProfileReferenceSchema,
    controlled: AgentConfigurationProfileReferenceSchema,
});

/**
 * One candidate artifact the locked result binds. The output is branded because the wider
 * `EnvironmentArtifactReference` (with its `kind`) has the same shape: only a parse or a producer
 * spelling the two fields out yields it, so passing a reference itself fails the type check.
 */
export const AgentCandidateArtifactEvidenceSchema = v.pipe(
    v.strictObject({
        artifactId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
        path: v.pipe(v.string(), v.minLength(1)),
    }),
    v.brand('AgentCandidateArtifactEvidence'),
);

export const AgentCandidateValidationEvidenceSchema = v.pipe(
    v.strictObject({
        validationArtifactId: v.pipe(v.string(), v.regex(CANDIDATE_VALIDATION_ARTIFACT_ID_PATTERN)),
        sessionId: v.pipe(v.string(), v.minLength(1)),
        extensionProvenance: v.optional(AgentExtensionProvenanceSchema),
        settingsEvidence: v.optional(AgentSettingsEvidenceSchema),
        // The desktop executor's proof: a proxy-CLI run has no extension provenance or
        // settings profile to bind, and fabricating either would be dishonest.
        cli: v.optional(CliAdapterProofSchema),
        validationArtifact: AgentCandidateArtifactEvidenceSchema,
        visualReviewArtifact: AgentCandidateArtifactEvidenceSchema,
        beforeViewport: AgentCandidateArtifactEvidenceSchema,
        afterViewport: AgentCandidateArtifactEvidenceSchema,
        // Absent where the browser captured no overview; the tiles carry that state's proof.
        beforeFullPage: v.optional(AgentCandidateArtifactEvidenceSchema),
        afterFullPage: v.optional(AgentCandidateArtifactEvidenceSchema),
    }),
    v.check(
        (evidence) =>
            (evidence.extensionProvenance !== undefined) ===
            (evidence.settingsEvidence !== undefined),
        'Extension candidate evidence must carry provenance and settings together.',
    ),
    v.check(
        (evidence) => (evidence.cli !== undefined) !== (evidence.extensionProvenance !== undefined),
        'Candidate validation evidence must carry exactly one executor proof family.',
    ),
);

export const VerifiedCandidateScreenshotPathsSchema = v.object({
    before: v.pipe(v.string(), v.minLength(1)),
    after: v.pipe(v.string(), v.minLength(1)),
    beforeFullPage: v.optional(v.pipe(v.string(), v.minLength(1))),
    afterFullPage: v.optional(v.pipe(v.string(), v.minLength(1))),
});

export const RejectedCandidateScreenshotPathsSchema = v.pipe(
    v.object({
        before: v.pipe(v.string(), v.minLength(1)),
        after: v.pipe(v.string(), v.minLength(1)),
        beforeFullPage: v.optional(v.pipe(v.string(), v.minLength(1))),
        afterFullPage: v.optional(v.pipe(v.string(), v.minLength(1))),
        validationArtifactId: v.pipe(v.string(), v.regex(CANDIDATE_VALIDATION_ARTIFACT_ID_PATTERN)),
        candidateRule: v.pipe(
            v.string(),
            v.minLength(1),
            v.maxLength(4_096),
            v.regex(/^[^\r\n]+$/),
        ),
        rejectionReasons: v.pipe(
            v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
            v.minLength(1),
            v.maxLength(20),
        ),
        visualReview: CandidateVisualReviewSchema,
        visualReviewArtifactPath: v.pipe(v.string(), v.minLength(1)),
    }),
    v.check(
        (evidence) => evidence.validationArtifactId === evidence.visualReview.validationArtifactId,
        'Rejected screenshot evidence must reference its bound visual review.',
    ),
);

export const FixRunArtifactPathsSchema = v.object({
    screenshots: v.array(v.string()),
    domSnapshot: v.nullable(v.string()),
    har: v.nullable(v.string()),
    trace: v.nullable(v.string()),
    settingsProof: v.optional(v.nullable(v.string())),
    browserLog: v.optional(v.nullable(v.string())),
    symptomObservationEvidence: v.optional(v.nullable(v.string())),
    preCandidateVisualInventory: v.optional(v.nullable(v.string())),
    candidateVisualReview: v.optional(v.nullable(v.string())),
    verifiedCandidateScreenshots: v.optional(VerifiedCandidateScreenshotPathsSchema),
    rejectedCandidateScreenshots: v.optional(RejectedCandidateScreenshotPathsSchema),
});

/**
 * Check whether a browser session contains a complete classified symptom capture.
 *
 * @param session - Browser session whose captures are inspected.
 * @param presence - Reporter-symptom classification required by the caller.
 * @param reference - Locked artifact identities that must bind the classified capture.
 * @returns Whether a complete vision-verified capture has the requested classification.
 */
function hasClassifiedCapture(
    session: v.InferOutput<typeof AgentBrowserSessionEvidenceSchema>,
    presence: SymptomPresence,
    reference: v.InferOutput<typeof AgentConfigurationProfileReferenceSchema>,
): boolean {
    return session.captures.some(
        (capture) =>
            capture.visionVerified &&
            capture.coverageComplete &&
            capture.reporterSymptomPresence === presence &&
            capture.viewport !== null &&
            capture.viewportArtifactId === reference.viewportArtifactId &&
            capture.fullPageOverviewArtifactId === reference.fullPageOverviewArtifactId &&
            capture.tileArtifactIds.length === reference.tileArtifactIds.length &&
            capture.tileArtifactIds.every(
                (artifactId, index) => artifactId === reference.tileArtifactIds[index],
            ) &&
            capture.tiles.length === reference.tileArtifactIds.length,
    );
}

/**
 * Valibot issue shape carrying the rejected value.
 */
interface RejectedResultIssue {
    /**
     * The value the schema rejected.
     */
    input: unknown;
}

/**
 * Read one property from an unknown record without asserting its whole shape.
 *
 * @param source - Value expected to be a record.
 * @param key - Property to read.
 * @returns The property value, or undefined when the source is not a record.
 */
function readUnknownProperty(source: unknown, key: string): unknown {
    if (typeof source !== 'object' || source === null) {
        return undefined;
    }
    return (source as Record<string, unknown>)[key];
}

/**
 * Name the compatibility field that diverged from the canonical execution projection.
 *
 * The invariant compares seven independent projections at once and reported only that one of them
 * disagreed, which leaves a reader holding a complete run with no way to tell whether the sessions,
 * the candidate binding, or the artifact paths drifted.
 *
 * @param issue - Valibot issue carrying the rejected result.
 * @returns Message naming each diverging compatibility field.
 */
function environmentProjectionFailureMessage(issue: RejectedResultIssue): string {
    const base =
        'Environment compatibility fields must be exact projections of canonical execution';
    const result = issue.input as FixRunResult | undefined;
    const execution = result?.environmentExecution;
    if (!execution) {
        return `${base}.`;
    }
    const projected = projectEnvironmentResult(execution);
    if (!projected) {
        return `${base}: canonical execution does not project at all.`;
    }
    if (!result?.environmentSelection?.actual) {
        return `${base}: the environment selection carries no actual context.`;
    }
    const diverged: string[] = [];
    if (execution.kind !== result.environmentSelection.selectedKind) {
        diverged.push('selectedKind');
    }
    if (!structuresEqual(execution.actualContext, result.environmentSelection.actual)) {
        diverged.push('actualContext');
    }
    if (!structuresEqual(projected.browserSessions, result.browserSessions)) {
        diverged.push('browserSessions');
    }
    if (!structuresEqual(projected.extensionProvenance, result.extensionProvenance)) {
        diverged.push('extensionProvenance');
    }
    if (!structuresEqual(projected.settingsEvidence, result.settingsEvidence)) {
        diverged.push('settingsEvidence');
    }
    if (
        !structuresEqual(projected.candidateValidationEvidence, result.candidateValidationEvidence)
    ) {
        diverged.push('candidateValidationEvidence');
    }
    if (
        !structuresEqual(
            projected.candidateApplicationEvidence,
            result.candidateApplicationEvidence,
        )
    ) {
        diverged.push('candidateApplicationEvidence');
    }
    if (!structuresEqual(projected.candidateVisualReview, result.candidateVisualReview)) {
        diverged.push('candidateVisualReview');
    }
    const pathDisagreements = environmentArtifactPathDisagreements(
        projected.artifactPaths,
        result.artifactPaths,
    );
    if (pathDisagreements.length > 0) {
        diverged.push(`artifactPaths [${pathDisagreements.join(', ')}]`);
    }
    return diverged.length > 0 ? `${base}: ${diverged.join(', ')}.` : `${base}.`;
}

/**
 * Name the exact reason a candidate validation binding failed its cross-field invariant.
 *
 * The invariant is a long conjunction over the bound screenshots, the bound session, and the
 * executor proof. Reporting only that it failed leaves the reader with a whole run of evidence and
 * no way to tell which field disagreed, so the message carries the failed field names.
 *
 * @param issue - Valibot issue carrying the rejected result.
 * @returns Human-readable message naming every disagreeing field.
 */
function candidateBindingFailureMessage(issue: RejectedResultIssue): string {
    const result = issue.input;
    const binding = readUnknownProperty(result, 'candidateValidationEvidence');
    const failures: string[] = [];
    if (binding !== undefined && binding !== null) {
        const sessionId = readUnknownProperty(binding, 'sessionId');
        const sessions = (
            (readUnknownProperty(result, 'browserSessions') as unknown[] | undefined) ?? []
        ).filter((session) => readUnknownProperty(session, 'sessionId') === sessionId);
        if (sessions.length !== 1) {
            failures.push(`bound sessions matching ${String(sessionId)}: ${sessions.length}`);
        }
        const verdict = readUnknownProperty(
            readUnknownProperty(result, 'candidateVisualReview'),
            'verdict',
        );
        if (verdict !== 'verified') {
            failures.push(`visual verdict ${String(verdict)}`);
        }
        const runStatus = readUnknownProperty(result, 'runStatus');
        const status = readUnknownProperty(
            readUnknownProperty(readUnknownProperty(result, 'environmentExecution'), 'disposition'),
            'status',
        );
        if (runStatus !== 'patch_proposed' && status !== EnvironmentDispositionStatus.Verified) {
            failures.push(`runStatus ${String(runStatus)} with disposition ${String(status)}`);
        }
        const artifactPaths = readUnknownProperty(result, 'artifactPaths');
        if (readUnknownProperty(artifactPaths, 'verifiedCandidateScreenshots') === undefined) {
            failures.push('verifiedCandidateScreenshots missing');
        }
        if (
            readUnknownProperty(artifactPaths, 'candidateVisualReview') !==
            readUnknownProperty(readUnknownProperty(binding, 'visualReviewArtifact'), 'path')
        ) {
            failures.push('candidateVisualReview path differs from the bound artifact');
        }
        const session = sessions[0];
        if (session !== undefined && readUnknownProperty(binding, 'cli') === undefined) {
            for (const field of ['settingsEvidence', 'extensionProvenance']) {
                if (
                    JSON.stringify(readUnknownProperty(session, field)) !==
                    JSON.stringify(readUnknownProperty(binding, field))
                ) {
                    failures.push(`bound session ${field} differs`);
                }
                if (
                    JSON.stringify(readUnknownProperty(result, field)) !==
                    JSON.stringify(readUnknownProperty(binding, field))
                ) {
                    failures.push(`run ${field} differs from the bound session`);
                }
            }
        }
    }
    return (
        'Candidate validation evidence must bind one proven session, its executor proof, and ' +
        'exact artifacts' +
        (failures.length > 0 ? `: ${failures.join('; ')}.` : '.')
    );
}

// Split in two only because Valibot types `pipe` through fixed-arity overloads: past nineteen
// actions the object type stops being inferred and every callback silently degrades to `unknown`.
// Nesting keeps each stage inside a typed overload, so a further invariant is added to the outer
// pipe rather than by widening this one.
const FixRunResultInvariantsSchema = v.pipe(
    v.object({
        issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
        domain: v.pipe(v.string(), v.minLength(1)),
        runStatus: FixRunStatusSchema,
        requestedBrowserMode: BrowserModeSchema,
        effectiveMode: EffectiveModeSchema,
        verificationStatus: VerificationStatusSchema,
        reproductionSettingsStatus: v.optional(ReproductionSettingsStatusSchema),
        reproductionSettingsDetail: v.optional(v.string()),
        symptomObservation: v.optional(SymptomObservationSchema),
        currentRulesResolutionStatus: v.optional(CurrentRulesResolutionStatusSchema),
        fallbackReason: v.nullable(BrowserFallbackReasonSchema),
        fallbackDetail: v.nullable(v.string()),
        infrastructureFailureReason: v.optional(InfrastructureFailureReasonSchema),
        agentTerminationReason: v.optional(AgentTerminationReasonSchema),
        // Absent when the seal's message named no leading status (an SDK-folded body, or an
        // ending that never involved the provider); never the provider's response body, which can
        // carry account identifiers and URLs — see `ProviderFailureSealed.status`.
        providerFailureStatus: v.optional(
            v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(599)),
        ),
        environmentSelection: v.optional(EnvironmentSelectionSnapshotSchema),
        environmentExecution: v.optional(FilteringEnvironmentExecutionSchema),
        // The invariant that refused canonical execution: a defect in our own result assembly. A
        // verified decision it refused has failed the run; any other run only records it.
        environmentProjectionRefusal: v.optional(v.picklist(ENVIRONMENT_PROJECTION_REFUSAL_VALUES)),
        reporterSettings: v.optional(ReporterSettingsSnapshotSchema),
        extensionProvenance: v.optional(AgentExtensionProvenanceSchema),
        settingsEvidence: v.optional(AgentSettingsEvidenceSchema),
        // The candidate application record travels beside the extension-proof projection: what
        // the model's steps did (the host-assembled action log) and what the host proved by
        // reading the blocker state back.
        candidateApplicationEvidence: v.optional(PhaseApplicationProofSchema),
        browserSessions: v.optional(v.array(AgentBrowserSessionEvidenceSchema)),
        configurationComparisonEvidence: v.optional(AgentConfigurationComparisonEvidenceSchema),
        candidateValidationEvidence: v.optional(AgentCandidateValidationEvidenceSchema),
        candidatePatch: v.nullable(CandidatePatchSchema),
        // The candidate an analysis-only run found and could not verify. It travels beside
        // `candidatePatch`, never instead of it: publication reads the patch and only the patch,
        // so this field reaches the report and nothing else.
        candidateForReview: v.optional(CandidateForReviewSchema),
        missingInformation: v.optional(
            v.pipe(
                v.array(MissingInformationEntrySchema),
                v.maxLength(MAX_MISSING_INFORMATION_ENTRIES),
            ),
        ),
        candidateVisualReview: v.optional(CandidateVisualReviewSchema),
        // What the repository's own lint command said about the published candidate, only when it
        // flagged it or could not run; it decides nothing and reaches the report alone.
        repositoryLint: v.optional(RepositoryLintNoteSchema),
        artifactPaths: FixRunArtifactPathsSchema,
        reasoning: v.string(),
        repository: v.nullable(v.string()),
        baseSha: v.nullable(v.string()),
        filtersRepository: v.optional(
            v.nullable(v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u))),
        ),
        filtersBaseSha: v.optional(v.nullable(v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/iu)))),
        sourceDrift: v.optional(v.nullable(UpstreamSourceDriftSchema)),
    }),
    v.check(
        (result) =>
            result.agentTerminationReason === undefined || result.runStatus === FixRunStatus.Failed,
        'A Host agent termination must be represented as a failed run.',
    ),
    v.check(
        (result) =>
            result.providerFailureStatus === undefined ||
            result.agentTerminationReason === AgentTerminationReason.LlmError ||
            result.agentTerminationReason === AgentTerminationReason.LlmRejected,
        'A provider-failure status requires the run to have ended by an LLM failure.',
    ),
    v.check(
        (result) =>
            result.effectiveMode !== EffectiveMode.Reasoning ||
            (REPORT_ONLY_RUN_STATUSES.includes(result.runStatus) && result.candidatePatch === null),
        'Reasoning-only results must be report-only and cannot contain a candidate patch.',
    ),
    v.check((result) => {
        if (result.runStatus === FixRunStatus.UnsupportedProductCase) {
            return (
                result.environmentSelection?.state === EnvironmentSelectionState.Unsupported &&
                result.environmentSelection.selectedKind ===
                    EnvironmentSelectionReservedCase.UnsupportedProductCase &&
                result.candidatePatch === null &&
                result.infrastructureFailureReason === undefined
            );
        }
        if (result.runStatus === FixRunStatus.CapabilityLimited) {
            return (
                result.environmentSelection?.state ===
                    EnvironmentSelectionState.CapabilityLimited &&
                result.candidatePatch === null &&
                result.infrastructureFailureReason === undefined
            );
        }
        return true;
    }, 'Unsupported and capability-limited results require their matching selection state.'),
    v.check(
        (result) =>
            result.environmentSelection?.state === EnvironmentSelectionState.Ready ||
            result.candidatePatch === null,
        'A non-ready environment selection cannot carry a candidate patch.',
    ),
    v.check((result) => {
        const execution = result.environmentExecution;
        if (!execution) {
            return true;
        }
        const projected = projectEnvironmentResult(execution);
        if (!projected || !result.environmentSelection?.actual) {
            return false;
        }
        return (
            execution.kind === result.environmentSelection.selectedKind &&
            structuresEqual(execution.actualContext, result.environmentSelection.actual) &&
            structuresEqual(projected.browserSessions, result.browserSessions) &&
            structuresEqual(projected.extensionProvenance, result.extensionProvenance) &&
            structuresEqual(projected.settingsEvidence, result.settingsEvidence) &&
            structuresEqual(
                projected.candidateValidationEvidence,
                result.candidateValidationEvidence,
            ) &&
            structuresEqual(
                projected.candidateApplicationEvidence,
                result.candidateApplicationEvidence,
            ) &&
            structuresEqual(projected.candidateVisualReview, result.candidateVisualReview) &&
            environmentArtifactPathsAgree(projected.artifactPaths, result.artifactPaths)
        );
    }, environmentProjectionFailureMessage),
    v.check((result) => {
        const execution = result.environmentExecution;
        if (!execution || (execution.cleanup.completed && execution.drain.failed === 0)) {
            return true;
        }
        return (
            result.runStatus === 'failed' &&
            result.infrastructureFailureReason ===
                InfrastructureFailureReason.EnvironmentUnavailable &&
            result.candidatePatch === null &&
            result.verificationStatus !== VerificationStatus.Verified
        );
    }, 'Incomplete environment cleanup must suppress verification and force environment failure.'),
    v.check(
        (result) =>
            result.runStatus !== 'patch_proposed' ||
            (result.environmentSelection?.state === EnvironmentSelectionState.Ready &&
                result.environmentSelection.actual?.kind ===
                    result.environmentSelection.selectedKind),
        'A proposed patch requires actual context from the same ready locked environment.',
    ),
    v.check(
        (result) =>
            result.runStatus !== 'patch_proposed' ||
            (result.candidatePatch !== null &&
                result.verificationStatus === VerificationStatus.Verified &&
                result.candidateVisualReview?.verdict === 'verified' &&
                result.artifactPaths.verifiedCandidateScreenshots !== undefined &&
                result.browserSessions !== undefined &&
                result.candidateValidationEvidence !== undefined),
        'A patch_proposed result requires a verified vision review and complete visual evidence.',
    ),
    v.check((result) => {
        const binding = result.candidateValidationEvidence;
        if (!binding) {
            return true;
        }
        const review = result.candidateVisualReview;
        const screenshots = result.artifactPaths.verifiedCandidateScreenshots;
        const boundSession = result.browserSessions?.filter(
            (session) => session.sessionId === binding.sessionId,
        );
        const boundPairs = [
            binding.beforeViewport,
            binding.afterViewport,
            ...(binding.beforeFullPage ? [binding.beforeFullPage] : []),
            ...(binding.afterFullPage ? [binding.afterFullPage] : []),
        ];
        const candidateRuleHash = result.candidatePatch
            ? createHash('sha256').update(result.candidatePatch.rule).digest('hex')
            : undefined;
        const validationIdentity = parseCandidateValidationArtifactId(binding.validationArtifactId);
        const validationFileIdentity = parseCandidateValidationArtifactFilename(
            basename(binding.validationArtifact.path),
        );
        const visualIdentity = parseCandidateVisualReviewArtifactId(
            binding.visualReviewArtifact.artifactId,
        );
        const visualFileIdentity = parseCandidateVisualReviewArtifactFilename(
            basename(binding.visualReviewArtifact.path),
        );
        // A binding normally accompanies a proposed patch; it may also survive on a terminal
        // that proposed nothing when the attached canonical execution proves the verified
        // experiment happened — discarding that evidence would cost the reviewer the strongest
        // artifact the run produced.
        const terminalBound =
            (result.runStatus === 'patch_proposed' &&
                result.candidatePatch !== null &&
                review?.candidateRuleHash === candidateRuleHash &&
                validationIdentity?.candidateShortHash === candidateRuleHash?.slice(0, 12)) ||
            result.environmentExecution?.disposition.status ===
                EnvironmentDispositionStatus.Verified;
        const shared =
            terminalBound &&
            review?.verdict === 'verified' &&
            review.validationArtifactId === binding.validationArtifactId &&
            binding.validationArtifact.artifactId === binding.validationArtifactId &&
            candidateArtifactIdentitiesEqual(validationIdentity, validationFileIdentity) &&
            candidateArtifactIdentitiesEqual(validationIdentity, visualIdentity) &&
            candidateArtifactIdentitiesEqual(validationIdentity, visualFileIdentity) &&
            result.artifactPaths.candidateVisualReview === binding.visualReviewArtifact.path &&
            screenshots !== undefined &&
            binding.beforeViewport.artifactId === review.beforeViewportArtifactId &&
            binding.afterViewport.artifactId === review.afterViewportArtifactId &&
            (binding.beforeFullPage?.artifactId ?? null) === review.beforeFullPageArtifactId &&
            (binding.afterFullPage?.artifactId ?? null) === review.afterFullPageArtifactId &&
            binding.beforeViewport.path === screenshots.before &&
            binding.afterViewport.path === screenshots.after &&
            binding.beforeFullPage?.path === screenshots.beforeFullPage &&
            binding.afterFullPage?.path === screenshots.afterFullPage &&
            boundPairs.every((pair) => result.artifactPaths.screenshots.includes(pair.path)) &&
            new Set(boundPairs.map((pair) => pair.artifactId)).size === boundPairs.length &&
            new Set(boundPairs.map((pair) => pair.path)).size === boundPairs.length &&
            boundSession?.length === 1 &&
            boundSession[0].navigationVerified;
        if (!shared) {
            return false;
        }
        const session = boundSession![0]!;
        if (binding.cli !== undefined) {
            // The desktop executor binds through its CLI proof: no extension ever ran, so
            // neither the result nor the bound session may claim extension evidence.
            return (
                result.settingsEvidence === undefined &&
                result.extensionProvenance === undefined &&
                session.extensionMode === ExtensionMode.None &&
                session.extensionProvenance === undefined &&
                session.settingsEvidence === undefined
            );
        }
        return (
            result.settingsEvidence !== undefined &&
            JSON.stringify(result.settingsEvidence) === JSON.stringify(binding.settingsEvidence) &&
            result.extensionProvenance !== undefined &&
            JSON.stringify(result.extensionProvenance) ===
                JSON.stringify(binding.extensionProvenance) &&
            session.extensionMode === ExtensionMode.Prepared &&
            session.extensionProvenance !== undefined &&
            JSON.stringify(session.extensionProvenance) ===
                JSON.stringify(binding.extensionProvenance) &&
            session.settingsEvidence !== undefined &&
            JSON.stringify(session.settingsEvidence) === JSON.stringify(binding.settingsEvidence)
        );
    }, candidateBindingFailureMessage),
    v.check((result) => {
        const rejected = result.artifactPaths.rejectedCandidateScreenshots;
        if (!rejected) {
            return true;
        }
        return (
            result.candidateVisualReview !== undefined &&
            JSON.stringify(result.candidateVisualReview) ===
                JSON.stringify(rejected.visualReview) &&
            result.artifactPaths.candidateVisualReview === rejected.visualReviewArtifactPath
        );
    }, 'Representative rejected evidence must match the top-level visual review and artifact path.'),
    v.check((result) => {
        const registeredPaths = new Set(result.artifactPaths.screenshots);
        return (result.browserSessions ?? []).every((session) =>
            session.captures.every((capture) =>
                [capture.viewport, capture.fullPageOverview, ...capture.tiles]
                    .filter((path): path is string => path !== null)
                    .every((path) => registeredPaths.has(path)),
            ),
        );
    }, 'Browser-session screenshots must belong to the locked run artifact list.'),
    v.check(
        (result) =>
            (result.browserSessions ?? []).every((session) => {
                const verifiedCaptures = session.captures.filter(
                    (capture) => capture.visionVerified,
                );
                return (
                    session.fullVisionVerified === verifiedCaptures.length > 0 &&
                    session.captures.every(
                        (capture) =>
                            (capture.viewport === null) === (capture.viewportArtifactId === null) &&
                            (capture.fullPageOverview === null) ===
                                (capture.fullPageOverviewArtifactId === null) &&
                            capture.tileArtifactIds.length === capture.tiles.length,
                    ) &&
                    // The overview is context the browser cannot always capture; the tiles
                    // carry the coverage proof.
                    verifiedCaptures.every(
                        (capture) => capture.coverageComplete && capture.tiles.length > 0,
                    )
                );
            }),
        'Vision-verified sessions require a complete inspected tile capture.',
    ),
    v.check(
        (result) => noPatchVerdictIsSessionBound(result),
        'Verified no-patch outcomes require exact session-bound browser and vision evidence.',
    ),
);

/**
 * Run statuses that conclude the reported defect needs no patch.
 */
export const NO_PATCH_RUN_STATUSES = [
    FixRunStatus.NotReproduced,
    FixRunStatus.AlreadyFixedCurrent,
    FixRunStatus.FixedUpstreamPendingExtension,
    FixRunStatus.ConfigurationSpecific,
] as const;

/**
 * One browser session as far as a no-patch verdict is concerned.
 */
interface NoPatchSessionEvidence {
    /**
     * Whether the session proved it navigated to the reported page.
     */
    navigationVerified: boolean;

    /**
     * Whether the session carries a complete inspected full-page capture.
     */
    fullVisionVerified: boolean;

    /**
     * Whether the session ran without AdGuard or with the prepared extension.
     */
    extensionMode: ExtensionMode;

    /**
     * Browser-proved settings profile, present only on a prepared session.
     */
    settingsEvidence?: unknown;
}

/**
 * The slice of an assembled run record the no-patch session predicate reads.
 */
interface NoPatchVerdictRecord {
    /**
     * Claimed terminal run status.
     */
    runStatus: string;

    /**
     * Claimed verification level of that status.
     */
    verificationStatus: string;

    /**
     * Session evidence carried by the record, absent while it is still being assembled.
     */
    browserSessions?: readonly NoPatchSessionEvidence[];
}

/**
 * Whether a record that claims a verified no-patch verdict actually carries the sessions proving
 * it.
 *
 * The verdict and the evidence list are assembled from different sources — the verdict from the
 * agent runtime, the sessions from canonical environment execution — so a record can claim more
 * than it holds. The schema rejects such a record, and the runner consults the same predicate
 * before finalizing so it can lower the claim instead of failing the whole run.
 *
 * @param result - Assembled result carrying its verdict and its session evidence.
 * @returns True when the claim needs no evidence, or when the required sessions are present.
 */
export function noPatchVerdictIsSessionBound(result: NoPatchVerdictRecord): boolean {
    if (
        result.browserSessions === undefined ||
        result.verificationStatus !== VerificationStatus.Verified ||
        !(NO_PATCH_RUN_STATUSES as readonly string[]).includes(result.runStatus)
    ) {
        return true;
    }
    const provenSessions = result.browserSessions.filter(
        (session) => session.navigationVerified && session.fullVisionVerified,
    );
    if (result.runStatus !== 'already_fixed_current') {
        return provenSessions.length > 0;
    }
    return (
        provenSessions.some((session) => session.extensionMode === ExtensionMode.None) &&
        provenSessions.some(
            (session) =>
                session.extensionMode === ExtensionMode.Prepared &&
                session.settingsEvidence !== undefined,
        )
    );
}

// The explicit annotation stops TypeScript from serializing the full pipe inference (TS7056);
// checks never change the schema's shape, so the invariants schema's types are exact.
export const FixRunResultSchema: v.GenericSchema<
    v.InferInput<typeof FixRunResultInvariantsSchema>,
    v.InferOutput<typeof FixRunResultInvariantsSchema>
> = v.pipe(
    FixRunResultInvariantsSchema,
    v.check((result) => {
        if (result.runStatus !== 'already_fixed_current') {
            return true;
        }
        const sessions = result.browserSessions ?? [];
        const hasPresence = (extensionMode: ExtensionMode, presence: SymptomPresence): boolean =>
            sessions.some(
                (session) =>
                    session.extensionMode === extensionMode &&
                    (extensionMode === ExtensionMode.None ||
                        session.settingsEvidence !== undefined) &&
                    session.navigationVerified &&
                    session.fullVisionVerified &&
                    session.captures.some(
                        (capture) =>
                            capture.visionVerified && capture.reporterSymptomPresence === presence,
                    ),
            );
        const preparedCurrentAbsent = sessions.some(
            (session) =>
                session.extensionMode === ExtensionMode.Prepared &&
                session.extensionProvenance !== undefined &&
                session.settingsEvidence !== undefined &&
                session.navigationVerified &&
                session.fullVisionVerified &&
                session.captures.some(
                    (capture) =>
                        capture.visionVerified &&
                        capture.reporterSymptomPresence === ReporterSymptomPresence.Absent,
                ),
        );
        return (
            preparedCurrentAbsent &&
            hasPresence(ExtensionMode.None, 'present') &&
            hasPresence(ExtensionMode.Prepared, 'absent')
        );
    }, 'already_fixed_current requires a current extension plus unfiltered-present and prepared-absent vision evidence.'),
    v.check((result) => {
        if (result.runStatus !== 'fixed_in_source_pending_publication') {
            return true;
        }
        const execution = result.environmentExecution;
        const baseline = execution?.baseline;
        if (!execution || !baseline) {
            return false;
        }
        return (
            result.candidatePatch === null &&
            typeof result.filtersBaseSha === 'string' &&
            typeof result.filtersRepository === 'string' &&
            ([PhaseLabel.A, PhaseLabel.B, PhaseLabel.C] as const).every((phase) =>
                execution.phases.some((evidence) => evidence.phase === phase),
            ) &&
            execution.phases.some(
                (evidence) =>
                    evidence.phase === PhaseLabel.B &&
                    evidence.proof.baselineDigest === baseline.aggregateDigest,
            )
        );
    }, 'fixed_in_source_pending_publication requires an A/B/C reproduction bound to the executed published checksums, a pinned source commit, and no candidate patch.'),
    v.check(
        (result) =>
            !result.sourceDrift ||
            result.sourceDrift.pinnedCommit.toLowerCase() === result.filtersBaseSha?.toLowerCase(),
        'A source-drift record must name the exact commit the run is bound to.',
    ),
    v.check((result) => {
        if (
            result.runStatus !== 'configuration_specific' ||
            result.verificationStatus !== VerificationStatus.Verified
        ) {
            return true;
        }
        const sessions = (result.browserSessions ?? []).filter(
            (session) =>
                session.extensionMode === ExtensionMode.Prepared &&
                session.extensionProvenance !== undefined &&
                session.settingsEvidence !== undefined &&
                session.selectedSettingsProfileKind === session.settingsEvidence.profileKind &&
                session.navigationVerified &&
                session.fullVisionVerified,
        );
        const comparison = result.configurationComparisonEvidence;
        if (!comparison) {
            return false;
        }
        return sessions.some((reporter) => {
            // The run's one host-prepared build is the current pinned release by construction, so
            // the same-build reporter session qualifies through either current-build profile kind.
            const reporterProfileMatches = (
                [
                    SettingsProfileKind.ReportedOnCurrent,
                    SettingsProfileKind.AgentSelected,
                ] as readonly SettingsProfileKind[]
            ).includes(reporter.selectedSettingsProfileKind!);
            if (
                !reporterProfileMatches ||
                !hasClassifiedCapture(reporter, 'present', comparison.reporter) ||
                comparison.reporter.sessionId !== reporter.sessionId ||
                comparison.reporter.profileKind !== reporter.selectedSettingsProfileKind ||
                comparison.reporter.reporterSymptomPresence !== ReporterSymptomPresence.Present ||
                JSON.stringify(comparison.extensionProvenance) !==
                    JSON.stringify(reporter.extensionProvenance) ||
                JSON.stringify(result.extensionProvenance) !==
                    JSON.stringify(reporter.extensionProvenance) ||
                JSON.stringify(result.settingsEvidence) !==
                    JSON.stringify(reporter.settingsEvidence)
            ) {
                return false;
            }
            return sessions.some(
                (controlled) =>
                    controlled.selectedSettingsProfileKind ===
                        SettingsProfileKind.DefaultsPlusRequired &&
                    comparison.controlled.sessionId === controlled.sessionId &&
                    comparison.controlled.profileKind ===
                        SettingsProfileKind.DefaultsPlusRequired &&
                    comparison.controlled.reporterSymptomPresence ===
                        ReporterSymptomPresence.Absent &&
                    JSON.stringify(controlled.extensionProvenance) ===
                        JSON.stringify(reporter.extensionProvenance) &&
                    reproEnvironmentsEqual(
                        reporter.targetUrl,
                        reporter.profile,
                        controlled.targetUrl,
                        controlled.profile,
                    ) &&
                    hasClassifiedCapture(controlled, 'absent', comparison.controlled),
            );
        });
    }, 'Verified configuration_specific requires same-provenance reporter-present and controlled-absent prepared sessions.'),
    v.check(
        (result) =>
            result.configurationComparisonEvidence === undefined ||
            result.runStatus === 'configuration_specific',
        'Configuration comparison evidence belongs only to configuration_specific results.',
    ),
    v.check(
        (result) => result.candidateForReview === undefined || result.candidatePatch === null,
        'A candidate carried for review is by definition unverified and cannot accompany a patch.',
    ),
    v.check(
        (result) =>
            result.environmentProjectionRefusal === undefined ||
            result.environmentExecution === undefined,
        'A projection refusal leaves no canonical execution attached.',
    ),
);

export type { BrowserMode };

/**
 * Execution mode actually used after resolving browser availability.
 */
export type EffectiveMode = v.InferOutput<typeof EffectiveModeSchema>;

/**
 * Technical reason why browser evidence could not be used.
 */
export type { BrowserFallbackReason };

export type { InfrastructureFailureReason };

/**
 * Concrete AdGuard syntax inferred by the runner from the locked candidate rule.
 */
export type { RuleSyntaxKind } from './rule-syntax-kind';

/**
 * Minimal deterministic patch payload consumed by publishers.
 *
 * Runners populate `syntaxKind` and `repositoryEdit` themselves; neither value is accepted from
 * model reasoning. The top-level `insertionPoint` earlier builds wrote remains readable for their
 * locked run artifacts.
 */
export type CandidatePatch = v.InferOutput<typeof CandidatePatchSchema>;

/**
 * Verified model-selected extension build retained in the locked result.
 */
export type AgentExtensionProvenance = v.InferOutput<typeof AgentExtensionProvenanceSchema>;

/**
 * One candidate artifact bound in the locked result, branded.
 */
export type AgentCandidateArtifactEvidence = v.InferOutput<
    typeof AgentCandidateArtifactEvidenceSchema
>;

/**
 * The two fields of {@link AgentCandidateArtifactEvidence} before the brand, which a producer checks
 * its literal against with `satisfies` before the brand cast.
 */
export type AgentCandidateArtifactEvidenceFields = v.InferInput<
    typeof AgentCandidateArtifactEvidenceSchema
>;

/**
 * Bounded proof of the model-selected settings actually active in Chromium.
 */
export type AgentSettingsEvidence = v.InferOutput<typeof AgentSettingsEvidenceSchema>;

/**
 * Browser and vision evidence retained separately for each model-selected session.
 */
export type AgentBrowserSessionEvidence = v.InferOutput<typeof AgentBrowserSessionEvidenceSchema>;

/**
 * Explicit reporter-versus-controlled configuration matrix retained in a locked result.
 */
export type AgentConfigurationComparisonEvidence = v.InferOutput<
    typeof AgentConfigurationComparisonEvidenceSchema
>;

/**
 * Complete candidate proof bound to one prepared-extension session and its settings.
 */
export type AgentCandidateValidationEvidence = v.InferOutput<
    typeof AgentCandidateValidationEvidenceSchema
>;

/**
 * Exact viewport and full-page screenshots from one verified candidate visual review.
 */
export type VerifiedCandidateScreenshotPaths = v.InferOutput<
    typeof VerifiedCandidateScreenshotPathsSchema
>;

/**
 * Files persisted while investigating and validating the issue.
 */
export type FixRunArtifactPaths = v.InferOutput<typeof FixRunArtifactPathsSchema>;

/**
 * Serializable result of one browser-first fix attempt.
 */
export type FixRunResult = v.InferOutput<typeof FixRunResultSchema>;

export type { AgentTerminationReason };

/**
 * Validate and serialize a fix result for deterministic file-based handoff.
 *
 * @param result - Result produced by the runtime.
 * @returns Pretty-printed JSON terminated by a newline.
 */
export function serializeFixRunResult(result: FixRunResult): string {
    return JSON.stringify(v.parse(FixRunResultSchema, result), null, 2) + '\n';
}
