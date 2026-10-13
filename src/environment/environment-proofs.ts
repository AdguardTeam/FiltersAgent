import * as v from 'valibot';
import { PhaseLabel, PHASE_LABEL_VALUES } from '../types/validation';
import { SETTINGS_PROFILE_KIND_VALUES } from '../types/settings-profile-kind';
import { EXTENSION_LAUNCH_FAMILY_VALUES } from './extension-launch';
import {
    EXTENSION_MANIFEST_VERSION_VALUES,
    PREPARED_EXTENSION_SOURCE_VALUES,
} from './extension-preparation';
import {
    LIST_KEY_MAX_COUNT,
    FilterListKeyListSchema,
    FilterListKeySchema,
} from './filter-list-ref';
import { ExecutorNameSchema } from './executor-name';
import { ActualExecutionContextSchema } from './environment-selection-contract';
import { normalizeRulesContent, sha256OfContent } from './rules-content';

/**
 * Bounded evidence digests: lowercase hex SHA-256.
 */
export const DigestSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u));

/**
 * Bounded opaque identifiers carried by adapter and recorder evidence.
 */
export const BoundedIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(256));

/**
 * Bounded single-line public failure detail.
 */
export const PublicDetailSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(500));

/**
 * The one rendering of a structured value a read-back could not observe.
 *
 * An unobserved value is null in every structured field — never an empty list or a false boolean
 * that a reader could mistake for an observation — and every renderer prints this phrase in its
 * place.
 */
export const NOT_OBSERVED_TEXT = 'not observed';

export const EnvironmentPhaseSchema = v.picklist(PHASE_LABEL_VALUES);

/**
 * Filtering state a phase runs under, from no filtering through baseline plus candidate.
 */
export const EnvironmentFilteringState = {
    /**
     * No filtering is active: phase A's control state.
     */
    Disabled: 'disabled',

    /**
     * Only the published baseline lists are active: phase B's state.
     */
    PublishedBaseline: 'published_baseline',

    /**
     * The published baseline plus the candidate rule are active: phase C's state.
     */
    PublishedBaselinePlusCandidate: 'published_baseline_plus_candidate',
} as const;

/**
 * Every EnvironmentFilteringState value, for schemas and exhaustive listings.
 */
export const ENVIRONMENT_FILTERING_STATE_VALUES = Object.values(EnvironmentFilteringState);

export const EnvironmentFilteringStateSchema = v.picklist(ENVIRONMENT_FILTERING_STATE_VALUES);

/**
 * EnvironmentFilteringState value.
 */
export type EnvironmentFilteringState =
    (typeof EnvironmentFilteringState)[keyof typeof EnvironmentFilteringState];

/**
 * Exact published list content executed by an adapter, described by list keys.
 */
export const PublishedBaselineResourceSchema = v.strictObject({
    listKey: FilterListKeySchema,
    rulesetId: BoundedIdSchema,
    path: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
    version: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
    byteCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
    sha256: DigestSchema,
});

export const PublishedBaselineProvenanceSchema = v.strictObject({
    environment: ExecutorNameSchema,
    acquiredAt: v.pipe(v.string(), v.isoTimestamp()),
    enabledListKeys: v.pipe(
        v.array(FilterListKeySchema),
        v.minLength(1),
        v.maxLength(LIST_KEY_MAX_COUNT),
    ),
    // May be empty: a release that fetches list content lazily — after the add returns, or when
    // its proxy starts — never lets an observer bind bytes to the list that caused them. The
    // enabled set below still describes what filters, and every phase of a run sees the same one.
    resources: v.pipe(v.array(PublishedBaselineResourceSchema), v.maxLength(128)),
    aggregateDigest: DigestSchema,
    /**
     * Enabled lists whose executed bytes could not be bound to a resource above.
     *
     * A release can arrive with lists of its own already installed, and a file that was already on
     * disk cannot be attributed by observing what an add creates. Those lists still take part in
     * filtering, so they are named here rather than silently dropped or allowed to fail the whole
     * baseline: every phase of a run sees the same set, and the report can say which parts of it
     * are byte-proven.
     */
    unattributedListKeys: v.optional(
        v.pipe(v.array(FilterListKeySchema), v.maxLength(LIST_KEY_MAX_COUNT)),
    ),
});

/**
 * The serialized single-source provenance of the one extension build a run loads.
 *
 * The run's extension is prepared host-side before any session starts, so the provenance is one
 * shape everywhere it survives — the durable adapter proof, the locked fix result, and the local
 * run record all serialize this same schema, and each session of the run loaded exactly this
 * build.
 *
 * The launch family decides which identity fields a record carries: a Chromium build names the
 * unpacked directory the browser loaded and the manifest generation read from it, a Firefox build
 * names the extension id and the signed XPI the enterprise policies force-installed (it has no
 * unpacked directory and no manifest the host reads). Both sides stay optional so records persisted
 * before the families were distinguished keep parsing. The managed-storage declaration is launch
 * input, not provenance, and is deliberately not serialized here.
 */
export const PreparedExtensionProvenanceSchema = v.strictObject({
    source: v.picklist(PREPARED_EXTENSION_SOURCE_VALUES),
    launchFamily: v.optional(v.picklist(EXTENSION_LAUNCH_FAMILY_VALUES)),
    extensionPath: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(1_024))),
    manifestVersion: v.optional(v.picklist(EXTENSION_MANIFEST_VERSION_VALUES)),
    extensionId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
    xpiPath: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(1_024))),
    extensionSourceSha256: DigestSchema,
    extensionSourceTag: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
});

/**
 * PreparedExtensionProvenanceSchema output.
 */
export type PreparedExtensionProvenance = v.InferOutput<typeof PreparedExtensionProvenanceSchema>;

/**
 * How the host reads the blocker state back to verify what the application steps produced.
 */
export const BlockerVerificationMethod = {
    /**
     * The blocker extension's own live state (the host queries the running extension directly).
     */
    ExtensionState: 'extension-state',

    /**
     * The blocker's user-rules file, read back by exact path and content digest.
     */
    UserRulesFile: 'user-rules-file',

    /**
     * The blocker's managed-storage policy file, read back by exact path and content digest.
     */
    ManagedStorageFile: 'managed-storage-file',
} as const;

/**
 * Every BlockerVerificationMethod value, for schemas and exhaustive listings.
 */
export const BLOCKER_VERIFICATION_METHOD_VALUES = Object.values(BlockerVerificationMethod);

export const BlockerVerificationMethodSchema = v.picklist(BLOCKER_VERIFICATION_METHOD_VALUES);

/**
 * BlockerVerificationMethod value.
 */
export type BlockerVerificationMethod =
    (typeof BlockerVerificationMethod)[keyof typeof BlockerVerificationMethod];

/**
 * Maximum recorded actions in one phase application proof.
 *
 * The application session is bounded to a handful of model turns over the blocker's UI, so its
 * recorded tool trace is proportional to those turns; 32 admits a full baseline-plus-candidate pass
 * with retries while keeping a misbehaving procedure from flooding the durable proof.
 */
export const PROOF_ACTION_LOG_MAX_ENTRIES = 32;

/**
 * Maximum characters of one recorded action summary.
 *
 * A summary names what a step did in one bounded sentence; 200 characters fits that without letting
 * a page dump ride the durable proof.
 */
export const PROOF_ACTION_LOG_SUMMARY_MAX = 200;

/**
 * Maximum characters of the recorded tool name in one action log entry.
 *
 * Tools are named by the registry enum (62 characters today is generous); 64 bounds the field so a
 * proof cannot carry arbitrary text in its tool slot.
 */
export const PROOF_ACTION_LOG_TOOL_MAX = 64;

/**
 * Maximum characters of the application record's detail.
 *
 * The detail is one host-written sentence naming what the credit could not observe; 500 characters
 * fits it with the method name and keeps model text out of the durable proof.
 */
export const PROOF_APPLICATION_DETAIL_MAX = 500;

/**
 * Maximum characters of one applied rule in the application proof.
 *
 * Mirrors the candidate rule bound: an applied rule is the candidate line itself, and a longer line
 * cannot be a candidate, so the proof refuses it instead of storing oversized content.
 */
export const PROOF_APPLIED_RULE_MAX_CHARACTERS = 4_096;

/**
 * Maximum number of applied rules recorded in one phase application proof.
 *
 * The proof records the applied candidate bundle (a single rule today) plus a small margin for
 * instructions whose steps legitimately stage a bounded set; it is never a place to dump baseline
 * list content, which the baseline provenance owns.
 */
export const PROOF_APPLIED_RULES_MAX = 64;

/**
 * Exact single-line rule text recorded in the application proof.
 */
const AppliedRuleSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(PROOF_APPLIED_RULE_MAX_CHARACTERS),
    // The applied rules are newline-joined for the verified digest, so an embedded line break
    // would make that digest ambiguous with a different rule split; one line per rule.
    v.regex(/^[^\r\n]+$/u),
);

export const ActionLogEntrySchema = v.strictObject({
    tool: v.pipe(v.string(), v.minLength(1), v.maxLength(PROOF_ACTION_LOG_TOOL_MAX)),
    ok: v.boolean(),
    summary: v.pipe(v.string(), v.maxLength(PROOF_ACTION_LOG_SUMMARY_MAX)),
});

/**
 * ActionLogEntrySchema output.
 */
export type ActionLogEntry = v.InferOutput<typeof ActionLogEntrySchema>;

/**
 * The record of the application that produced a phase's filtering state.
 *
 * The host never trusts the model's self-report alone — the proof carries what the steps were
 * (`actionLog`, assembled by the host from the session trace) and the exact rules content the steps
 * claimed to persist (`appliedRules`), while the schema's phase rules require the extension state
 * read back afterwards to agree.
 */
export const PhaseApplicationProofSchema = v.strictObject({
    method: BlockerVerificationMethodSchema,
    appliedRules: v.pipe(v.array(AppliedRuleSchema), v.maxLength(PROOF_APPLIED_RULES_MAX)),
    actionLog: v.pipe(v.array(ActionLogEntrySchema), v.maxLength(PROOF_ACTION_LOG_MAX_ENTRIES)),
    // What the credit could not observe, as the application procedure recorded it: a file-backed
    // read-back cannot report the enabled filter set, so the phase was credited on the user-rules
    // content alone. Absent when the read-back observed everything the goal names.
    detail: v.optional(
        v.pipe(v.string(), v.minLength(1), v.maxLength(PROOF_APPLICATION_DETAIL_MAX)),
    ),
});

/**
 * PhaseApplicationProofSchema output.
 */
export type PhaseApplicationProof = v.InferOutput<typeof PhaseApplicationProofSchema>;

/**
 * SHA-256 of the exact newline-joined applied-rules content an application claims to have
 * persisted.
 *
 * Normalizes and digests through `rules-content.ts`, the one place every comparison site takes its
 * bytes from, so this proof-side digest agrees by construction with the read-back side computed
 * over the same content.
 *
 * @param appliedRules - Rules the application claims to have applied, one per line.
 * @returns The lowercase hex digest of the newline-joined content.
 */
function appliedRulesDigest(appliedRules: readonly string[]): string {
    return sha256OfContent(normalizeRulesContent(appliedRules.join('\n')));
}

export const ExtensionAdapterProofSchema = v.strictObject({
    packageVersion: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    manifestVersion: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    profileKind: v.picklist(SETTINGS_PROFILE_KIND_VALUES),
    // Null when the read-back could not observe the enabled set: a file-backed verification method
    // reads the rules content only, and an empty array would state "no lists enabled" instead.
    enabledListKeys: v.nullable(v.array(FilterListKeySchema)),
    // Null when the read-back could not observe the compiled DNR rulesets — a file-backed method
    // or an MV2 route has no inventory to read — so the proof never claims a verified-empty set.
    // An observed empty array stays empty, and a record written before the field could be null
    // still parses as the observation it was.
    activeRulesetListKeys: v.nullable(v.array(FilterListKeySchema)),
    // Null when the read-back could not observe the Stealth state; an observed false stays false.
    stealthEnabled: v.nullable(v.boolean()),
    userRulesDigest: v.nullable(DigestSchema),
    application: v.optional(PhaseApplicationProofSchema),
    provenance: v.optional(PreparedExtensionProvenanceSchema),
});

export const CliAdapterProofSchema = v.strictObject({
    // Null when the executing engine build does not know its version — a locally built proxy
    // has none to claim, and inventing one would poison every downstream comparison.
    cliVersion: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
    enabledListKeys: FilterListKeyListSchema,
    coenabledListKeys: FilterListKeyListSchema,
    userFilterEnabled: v.boolean(),
});

export const EnvironmentPhaseStateProofSchema = v.pipe(
    v.strictObject({
        leaseId: BoundedIdSchema,
        adapterStateDigest: DigestSchema,
        phase: EnvironmentPhaseSchema,
        filteringState: EnvironmentFilteringStateSchema,
        sessionId: BoundedIdSchema,
        actualContext: ActualExecutionContextSchema,
        baselineDigest: v.nullable(DigestSchema),
        candidateDigest: v.nullable(DigestSchema),
        extension: v.nullable(ExtensionAdapterProofSchema),
        cli: v.optional(CliAdapterProofSchema),
    }),
    // Each phase asks whether the one environment proof present describes this exact state. A proof
    // that carries no environment member at all cannot describe B or C, so those stay closed.
    v.check((proof) => {
        if (proof.phase === PhaseLabel.A) {
            return (
                proof.filteringState === EnvironmentFilteringState.Disabled &&
                proof.baselineDigest === null &&
                proof.candidateDigest === null &&
                proof.extension === null &&
                (proof.cli === undefined || proof.cli.enabledListKeys.length === 0)
            );
        }
        if (proof.phase === PhaseLabel.B) {
            if (proof.cli !== undefined) {
                return (
                    proof.filteringState === EnvironmentFilteringState.PublishedBaseline &&
                    proof.baselineDigest !== null &&
                    proof.candidateDigest === null &&
                    proof.extension === null &&
                    proof.cli.enabledListKeys.length > 0
                );
            }
            return (
                proof.filteringState === EnvironmentFilteringState.PublishedBaseline &&
                proof.baselineDigest !== null &&
                proof.candidateDigest === null &&
                proof.extension?.userRulesDigest === null
            );
        }
        if (proof.cli !== undefined) {
            return (
                proof.filteringState === EnvironmentFilteringState.PublishedBaselinePlusCandidate &&
                proof.baselineDigest !== null &&
                proof.candidateDigest !== null &&
                proof.extension === null &&
                proof.cli.enabledListKeys.length > 0
            );
        }
        return (
            proof.filteringState === EnvironmentFilteringState.PublishedBaselinePlusCandidate &&
            proof.baselineDigest !== null &&
            proof.candidateDigest !== null &&
            proof.extension?.userRulesDigest === proof.candidateDigest
        );
    }, 'Phase proof must describe the exact A, B, or C filtering state.'),
    // The extension application record is required on the phases the instruction performs: B plugs
    // the baseline (nothing applied yet), C applies the candidate whose exact content the host then
    // proves by digest. CLI-authored proofs carry no application record.
    v.check((proof) => {
        if (proof.phase !== PhaseLabel.B || proof.extension === null) {
            return true;
        }
        const application = proof.extension.application;
        return application !== undefined && application.appliedRules.length === 0;
    }, 'Phase B extension proof must carry an application record with no applied rules.'),
    v.check((proof) => {
        if (proof.phase !== PhaseLabel.C || proof.extension === null) {
            return true;
        }
        const application = proof.extension.application;
        // The candidate digest equality itself is the phase-state check above; here the applied
        // content must be the exact bytes whose digest the extension proved.
        return (
            application !== undefined &&
            proof.extension.userRulesDigest !== null &&
            appliedRulesDigest(application.appliedRules) === proof.extension.userRulesDigest
        );
    }, 'Phase C extension proof must carry an application record whose applied rules digest matches the proven user rules.'),
);

/**
 * State of one environment phase.
 */
export type EnvironmentPhase = v.InferOutput<typeof EnvironmentPhaseSchema>;

/**
 * Immutable proof of adapter state attached to one browser lease.
 */
export type EnvironmentPhaseStateProof = v.InferOutput<typeof EnvironmentPhaseStateProofSchema>;

/**
 * Exact published filter content executed by an adapter.
 */
export type PublishedBaselineProvenance = v.InferOutput<typeof PublishedBaselineProvenanceSchema>;

/**
 * CLI-authored evidence of which official lists one phase actually had enabled.
 */
export type CliAdapterProof = v.InferOutput<typeof CliAdapterProofSchema>;
