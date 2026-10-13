/**
 * The browser evidence one {@link AgentRuntime} session accumulates: the screenshot and candidate
 * artifacts it registers, the captures vision inspects, and the environment provenance every
 * terminal judgement reads back.
 *
 * These are plain records with no runtime behavior, so the modules split out of the runtime — and
 * the fix cores that consume a finished run — describe the same evidence without importing the
 * runtime class.
 */
import type {
    AdGuardExtensionSettingsEvidence,
    AdGuardExtensionStateRead,
} from '../browser/adguard-extension-state-shapes';
import {
    DISABLE_STEALTH_SETTING,
    type AdGuardExtensionSettingsProfile,
} from '../browser/adguard-extension-settings';
import type { CliAdapterProof } from '../environment/environment-proofs';
import type { FilterListKey } from '../environment/filter-list-ref';
import type { ListSliceFacts } from '../environment/list-slice';
import type { PreparedExtension } from '../local/prepared-extension';
import type { CandidateVisualReview } from '../types/candidate-visual-review';
import type { PageObstruction } from '../types/page-obstruction';
import { ExtensionMode } from '../types/fix-run-result';
import type { ReproProfile } from '../types/repro-profile';
import { ReporterSymptomPresence } from '../types/reporter-symptom-presence';

/**
 * One runner-owned screenshot artifact bound to its producing browser session.
 */
export interface AgentRuntimeScreenshotEvidence {
    /**
     * Opaque artifact identity returned by the browser screenshot tool.
     */
    artifactId: string;

    /**
     * Recorder-owned local path, or null when an injected tool did not register the artifact.
     */
    path: string | null;
}

/**
 * One recorder-owned candidate artifact with its exact non-null local path.
 */
export interface AgentRuntimeCandidateArtifactEvidence {
    /**
     * Opaque artifact identity emitted by the trusted candidate validator.
     */
    artifactId: string;

    /**
     * Exact recorder path registered for this artifact identity.
     */
    path: string;
}

/**
 * Complete verified-candidate evidence bound to one prepared-extension browser session.
 */
export interface AgentRuntimeCandidateValidationBinding {
    /**
     * Runner-owned factual validation identity.
     */
    validationArtifactId: string;

    /**
     * Exact prepared browser session that dispatched the validation.
     */
    sessionId: string;

    /**
     * The run's one host-prepared extension build, loaded by that same prepared session, when one
     * ran.
     */
    extension?: PreparedExtension;

    /**
     * Browser-observed settings from that same prepared session, when an extension ran.
     */
    settingsEvidence?: AdGuardExtensionSettingsEvidence;

    /**
     * Candidate-phase CLI proof for a desktop run whose session ran no extension.
     */
    cli?: CliAdapterProof;

    /**
     * Detached environment carrying extension and settings provenance for the session.
     */
    environment: AgentRuntimeEnvironmentEvidence;

    /**
     * Schema-valid semantic review returned by this exact validation attempt.
     */
    visualReview: CandidateVisualReview;

    /**
     * Factual validation JSON artifact registered by the candidate validator.
     */
    validationArtifact: AgentRuntimeCandidateArtifactEvidence;

    /**
     * Persisted semantic review artifact registered by the vision verifier.
     */
    visualReviewArtifact: AgentRuntimeCandidateArtifactEvidence;

    /**
     * Before-state viewport screenshot inspected by the review.
     */
    beforeViewport: AgentRuntimeCandidateArtifactEvidence;

    /**
     * After-state viewport screenshot inspected by the review.
     */
    afterViewport: AgentRuntimeCandidateArtifactEvidence;

    /**
     * Before-state full-page screenshot inspected by the review.
     */
    beforeFullPage: AgentRuntimeCandidateArtifactEvidence;

    /**
     * After-state full-page screenshot inspected by the review.
     */
    afterFullPage: AgentRuntimeCandidateArtifactEvidence;
}

/**
 * One viewport/full-page/tile capture produced by an exact browser session.
 */
export interface AgentRuntimePageCaptureEvidence {
    /**
     * Whether vision inspected the full-page overview and every tile from this exact capture.
     */
    visionVerified: boolean;

    /**
     * Viewport screenshot captured at the current page position.
     */
    viewport: AgentRuntimeScreenshotEvidence | null;

    /**
     * Full-page overview captured by the same screenshot call.
     */
    fullPageOverview: AgentRuntimeScreenshotEvidence | null;

    /**
     * Original-resolution overlapping tiles captured by the same screenshot call.
     */
    tiles: AgentRuntimeScreenshotEvidence[];

    /**
     * Whether the runner reported complete tile coverage for this capture.
     */
    coverageComplete: boolean;

    /**
     * Structured vision conclusion for the exact reporter-defined symptom in this capture.
     */
    reporterSymptomPresence: ReporterSymptomPresence | null;
}

/**
 * Exact browser environment that produced one navigation, visual review, or candidate validation.
 */
export interface AgentRuntimeEnvironmentEvidence {
    /**
     * Opaque identity of the isolated browser session.
     */
    sessionId: string;

    /**
     * Exact prompt-safe URL selected by the model for this session.
     */
    targetUrl: string;

    /**
     * Whether the isolated session was unfiltered or loaded the prepared extension.
     */
    extensionMode: ExtensionMode;

    /**
     * Model-selected browser profile used by Chromium.
     */
    profile: ReproProfile;

    /**
     * Settings profile explicitly selected by the model for this session.
     */
    selectedSettingsProfileKind?: AdGuardExtensionSettingsProfile['kind'];

    /**
     * The run's one host-prepared extension build, used by this session, when present.
     */
    extension?: PreparedExtension;

    /**
     * The settings record derived from the blocker state the host read back itself, when this
     * prepared session's baseline application verified. The read-back is the run's only settings
     * fact.
     */
    settingsEvidence?: AdGuardExtensionSettingsEvidence;

    /**
     * The blocker state the host read back itself after this session's baseline application, when
     * one ran. The record is the exact state the settings projection above flattens and the enabled
     * set proved for the prepared sessions.
     */
    extensionBaselineReadBack?: AdGuardExtensionStateRead;

    /**
     * The executable list keys this prepared session's baseline was credited with when the blocker
     * declares its own selection instead of exposing a host-readable state.
     *
     * Present exactly when `extensionBaselineReadBack` is absent for a credited session: the two
     * families prove a baseline through different channels, and `sessionBaselineCredited` is the
     * one predicate that reads either.
     */
    declaredBaselineListKeys?: readonly FilterListKey[];

    /**
     * Whether a browser tool successfully navigated this session to the selected origin.
     */
    navigationVerified: boolean;

    /**
     * Whether vision inspected a complete full-page overview and every captured tile.
     */
    fullVisionVerified: boolean;

    /**
     * Detached screenshot captures produced by this exact session in capture order.
     */
    pageCaptures: AgentRuntimePageCaptureEvidence[];
}

/**
 * One runner-owned full-page capture whose images must all be inspected by vision.
 */
export interface AgentPageVisionCapture extends AgentRuntimePageCaptureEvidence {
    /**
     * Primary viewport identity returned by the screenshot call.
     */
    captureArtifactId: string;

    /**
     * Full-page overview and original-resolution tile artifact identifiers.
     */
    requiredArtifactIds: string[];

    /**
     * Exact runner screenshot result retained for bounded batch vision inspection.
     */
    rawCapture: Record<string, unknown>;

    /**
     * What vision saw in place of the site's content in this capture, once it inspected it.
     */
    pageObstruction: PageObstruction | null;
}

/**
 * The navigation fact one session observed about the page itself; what the page showed in its place
 * is judged by vision on the session's captures.
 */
export interface PageAccessFacts {
    /**
     * HTTP status of the main document the latest navigation loaded.
     */
    statusCode: number;
}

/**
 * Mutable runtime state retained for one isolated browser session.
 */
export interface AgentRuntimeSessionState extends AgentRuntimeEnvironmentEvidence {
    /**
     * Exact operational settings profile used to reproduce independent B/C sessions.
     */
    settingsProfile?: AdGuardExtensionSettingsProfile;

    /**
     * Stable identity used to prevent repeating an already failed browser environment.
     */
    environmentKey: string;

    /**
     * Whether technical navigation failed and this session must be retired before continuing.
     */
    technicalNavigationFailed: boolean;

    /**
     * Complete page captures emitted by the screenshot tool in this session.
     */
    pageCaptures: AgentPageVisionCapture[];

    /**
     * Screenshot artifact identifiers successfully inspected by the vision model.
     */
    analyzedArtifactIds: Set<string>;

    /**
     * Latest navigation and page-text facts, for deciding whether this session could see the
     * reported content at all.
     */
    pageAccessFacts?: PageAccessFacts;

    /**
     * The list slice this session runs as a custom filter, when its launch requested one and the
     * Baseline verified it. A session carrying one validates no candidate: candidates are judged
     * against whole lists only.
     */
    listSlice?: ListSliceFacts;
}

/**
 * Whether one prepared session carries a credited launch baseline.
 *
 * Both blocker families must prove what the session browsed with before its evidence may reach the
 * filtering environment, but they prove it through different channels: the AdGuard route by the
 * host read-back its launch Baseline application took, a Firefox-family run by the managed-storage
 * selection its instruction declared and the browser applied at startup. This is the one predicate
 * every gate reads, so neither family is credited by the other's evidence.
 *
 * @param evidence - Browser session evidence retained by the runtime.
 * @returns Whether this session's baseline was credited through either channel.
 */
export function sessionBaselineCredited(evidence: AgentRuntimeEnvironmentEvidence): boolean {
    return (
        evidence.extensionBaselineReadBack !== undefined ||
        evidence.declaredBaselineListKeys !== undefined
    );
}

/**
 * Count vision-inspected artifacts in one page capture.
 *
 * @param state - Session that owns the capture and its analysis ledger.
 * @param capture - Candidate full-page capture.
 * @returns Number of required artifacts already analyzed.
 */
export function analyzedCaptureArtifactCount(
    state: AgentRuntimeSessionState,
    capture: AgentPageVisionCapture,
): number {
    return capture.requiredArtifactIds.filter((artifactId) =>
        state.analyzedArtifactIds.has(artifactId),
    ).length;
}

/**
 * Rank one session by successful navigation and analyzed capture artifacts.
 *
 * @param state - Candidate runtime session.
 * @returns Monotonic evidence progress score.
 */
export function browserSessionVisionProgress(state: AgentRuntimeSessionState): number {
    const captureProgress = state.pageCaptures.reduce(
        (maximum, capture) => Math.max(maximum, analyzedCaptureArtifactCount(state, capture)),
        0,
    );
    return (state.navigationVerified ? 1_000_000 : 0) + captureProgress;
}

/**
 * Flatten one host read-back of the blocker state onto the runtime settings record.
 *
 * Everything the record carries is a fact of the read-back plus the profile the session requested:
 * the enabled set from the options metadata, the runtime and ruleset sets from the MV3 counters,
 * the Stealth state from the stored inverse setting, and the limit flags from both sources. An MV2
 * runtime reports no counters, so its runtime set falls back to the observed options state and
 * carries no ruleset set — exactly the facts that read can prove.
 *
 * @param profileKind - Settings profile the read-back session verified.
 * @param readBack - Complete blocker state the host read back itself.
 * @returns The session's settings evidence.
 */
export function settingsEvidenceFromReadBack(
    profileKind: AdGuardExtensionSettingsProfile['kind'],
    readBack: AdGuardExtensionStateRead,
): AdGuardExtensionSettingsEvidence {
    const enabledFilterIds = [...readBack.optionsEnabledFilterIds];
    const groupNames = new Map(
        (readBack.optionsData.filtersMetadata.categories ?? []).map((category) => [
            category.groupId,
            category.groupName,
        ]),
    );
    // The record mirrors the enabled set: a metadata entry the read found disabled proves nothing
    // about the applied settings and must not travel with it, and absent names are omitted rather
    // than left as undefined keys.
    const enabledFilters = readBack.optionsData.filtersMetadata.filters.flatMap((filter) => {
        if (!filter.enabled) {
            return [];
        }
        // The options metadata names groups by id only; the categories table carries the names.
        const groupName = filter.groupId === undefined ? undefined : groupNames.get(filter.groupId);
        return [
            {
                filterId: filter.filterId,
                ...(filter.name === undefined ? {} : { name: filter.name }),
                ...(filter.groupId === undefined ? {} : { groupId: filter.groupId }),
                ...(groupName === undefined ? {} : { groupName }),
                ...(filter.version === undefined ? {} : { version: filter.version }),
                ...(filter.tags === undefined ? {} : { tags: [...filter.tags] }),
            },
        ];
    });
    return {
        profileKind,
        manifestVersion: readBack.manifestVersion,
        filterEngine: readBack.filterEngine,
        extensionId: readBack.extensionId,
        optionsPageUrl: readBack.optionsPageUrl,
        appVersion: readBack.appVersion,
        enabledFilterIds,
        enabledFilters,
        optionsEnabledFilterIds: [...enabledFilterIds],
        runtimeEnabledFilterIds:
            readBack.rulesLimits === null
                ? [...enabledFilterIds]
                : [...readBack.rulesLimits.actuallyEnabledFilters],
        // No MV3 counters means nothing was observed about compiled rulesets — null, not the empty
        // array a reader would take for a verified "no rulesets active".
        activeRulesetFilterIds:
            readBack.rulesLimits === null ? null : [...readBack.rulesLimits.actuallyEnabledFilters],
        stealthEnabled: readBack.optionsData.settings.values[DISABLE_STEALTH_SETTING] === false,
        limitsExceeded:
            (readBack.rulesLimits?.areFilterLimitsExceeded ?? false) ||
            (readBack.optionsData.runtimeInfo?.areFilterLimitsExceeded ?? false),
        rulesLimits: readBack.rulesLimits,
    };
}
