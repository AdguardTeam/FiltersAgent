import {
    applyRuleResultForModel,
    unsupportedCandidateOperationRefusal,
} from './apply-rule-model-result';
import { createHash, randomUUID } from 'node:crypto';
import * as v from 'valibot';
import { withToolDeadline } from '../pi/session-tools';
import { parseRevealSteps, symptomAbsenceLedgerKey } from './apply-rule-reveal-steps';
import type { NormalizedSafeInteractionPlan } from '../environment/safe-interaction';
import { revealStepsRepairGuidance } from '../environment/interaction-replay';
import type { SingleShotClient } from '../pi/single-shot-types';
import { ToolRegistry } from '../agent/tool-registry';
import type { RepositoryLintCommand } from '../rules/repository-lint-command';
import { createToolRegistry } from '../agent/tool-factory';
import type { FinishFixValidationRejection } from '../types/terminal-rejection';
import {
    FULL_PAGE_CAPTURE_INCOMPLETE_KIND,
    inspectFullPageVisualCapture,
} from '../analyzer/full-page-capture-inspection';
import { visionOverviewRefusal } from '../pi/single-shot-input';
import {
    parseImportExpectations,
    type AdGuardExtensionSettingsProfile,
} from '../browser/adguard-extension-settings';
import {
    readBundledFilterCatalogIds,
    requestedSettingsFilterIds,
} from '../browser/extension-filter-catalog';
import {
    BrowserConfigurationError,
    BrowserLaunchError,
    BrowserSession,
    SettingsFailureReason,
    type BrowserSessionConfig,
} from '../browser/browser-session';
import {
    describeDiagnosticError,
    recordPreflightDiagnostic,
} from '../local/preflight-diagnostic-log';
import { CloakBrowserEngine } from '../browser/cloakbrowser-engine';
import { allowUserScripts as allowUserScriptsDefault } from '../browser/chrome-user-scripts-toggle';
import { createLoopbackTextServer, type LoopbackTextServer } from '../local/loopback-text-server';
import { CHROMIUM_USER_AGENT_PROFILE } from '../browser/prepared-extension-launch';
import type { IBrowserSession } from '../browser/browser-interfaces';
import { registrableDomain } from '../browser/request-party';
import type { BrowserContext } from 'playwright-core';
import {
    extractBrowserNetworkErrorCode,
    sanitizeNavigationTarget,
} from '../browser/navigation-failure';
import {
    EnvironmentCapability,
    EnvironmentLimitationCode,
    EnvironmentSelectionReservedCase,
} from '../environment/environment-vocabulary';
import { type EnvironmentSelectionSnapshot } from '../environment/environment-selection-contract';
import { EnvironmentSelectionHost } from '../environment/environment-selection';
import type { EvidenceRouteHost } from '../local/evidence-route-contract';
import { readReporterOfficialFilterIds } from '../local/reporter-filters';
import { BrowserExtensionExecutorName } from '../environment/executor-name';
import { ExtensionLaunchFamily } from '../environment/extension-launch';
import {
    BrowserExtensionEnvironmentOptions,
    type BrowserExtensionSessionRequest,
    type ExtensionBaselineSettings,
    type BrowserExtensionCreatedSession,
    type EnvironmentPhaseConfigurationResult,
} from '../environment/browser-extension-environment';
import {
    BrowserExtensionAdsObserver,
    type BrowserExtensionAdsObserverDependencies,
    type BrowserExtensionAdsObserverOptions,
} from '../environment/browser-extension-ads-observer';
import {
    SymptomKind,
    isBreakageSymptom,
    symptomKindForProblemType,
} from '../validator/symptom-rubric';
import { composeReporterSymptomScope } from '../validator/reporter-symptom-scope';
import {
    CandidateOperation,
    CANDIDATE_OPERATION_VALUES,
    EnvironmentAdapterLimitation,
    EnvironmentAdapterLimitationCode,
    EnvironmentLimitationStage,
    FilteringEnvironmentAdapter,
    ProvisionalEnvironmentDisposition,
    ValidatorPhaseCompletion,
} from '../environment/filtering-environment';
import type { CliAdapterProof } from '../environment/environment-proofs';
import { BrowserToolBudgets } from './browser-tool-budgets';
import { executorRequestedLists } from './executor-list-convergence';
import {
    recordEvidenceRouteFilterFidelity,
    recordExtensionFilterFidelity,
    recordUnfilteredHostsFidelity,
} from './filter-fidelity-records';
import {
    createListLineCounter,
    launchListFields,
    listSliceRefusal,
    sliceSessionApplyRuleRefusal,
    type ListLineCounter,
} from './list-slice-launch';
import { judgeableBlockedHost } from '../validator/candidate-network-verification';
import {
    buildAgentRuntimeListCatalog,
    type AgentRuntimeListCatalogBundle,
} from './agent-runtime-list-catalog';
import * as environmentExecution from '../environment/filtering-environment-execution-recorder';
import type { RawIssue } from '../github/fetch-issue';
import type { RuleGuidanceSource } from '../knowledge/rule-guidance';
import type { ToolDefinition } from '../agent/tool-registry';
import type { FixOutcome } from '../types/fix-outcome';
import type { PreparedExtension } from '../local/prepared-extension';
import { createLogger } from '../logger/logger';
import { normalizeRule, type NormalizedRule } from '../repo/rule-normalizer';
import type { TraceRecorder } from '../tracer/trace-recorder';
import { TraceEventType } from '../types/trace';
import { Viewport, ConsentStrategy, type ReproProfile } from '../types/repro-profile';
import { ExtensionMode, type SymptomObservation } from '../types/fix-run-result';
import {
    CandidateVisualVerdict,
    CandidateVisualReviewSchema,
    type CandidateVisualReview,
} from '../types/candidate-visual-review';
import type { IssueFacts } from '../types/issue-facts';
import { parseRuleApplication } from '../knowledge/instruction-application';
import type { LoadedInstruction } from '../knowledge/instruction-loader';
import type { DeclaredPlacementSet } from '../types/declared-placement';
import type { LlmConfig } from '../config/config';
import type { PiRuntime } from '../pi/runtime';
import type { RunUsageCollector } from '../pi/usage-collector';
import { ApplicationGoalKind } from '../validator/phase-application-contract';
import { readAdGuardExtensionState as readAdGuardExtensionStateDefault } from '../browser/adguard-extension-state-read';
import { findExtensionRuntime as findExtensionRuntimeDefault } from '../browser/extension-runtime-location';
import {
    candidateArtifactIdentitiesEqual,
    parseCandidateValidationArtifactId,
    parseCandidateVisualReviewArtifactId,
} from '../types/candidate-artifact-identity';
import { createTrustedValidationContext } from '../validator/trusted-validation-context';
import {
    runAdsEnvironmentExperiment,
    type AdsEnvironmentPhaseObservationInput,
} from '../validator/phase-orchestrator';
import { extractBrowserLaunchSignal } from './browser-launch-signal';
import { PhaseLabel } from '../types/validation';
import { withCliExperimentVerdict } from './cli-candidate-experiment';
import { reporterImportUrlRefusal, reporterSettingsImportUrls } from './reporter-import-url';
import { ReporterSettingsLimits } from './reporter-settings-limits';
import { SettingsProfileKind } from '../types/settings-profile-kind';
import {
    isAgentRefusalFallback,
    isTargetEnvironmentFallbackReason,
} from '../types/browser-fallback-origin';
import { BrowserFallbackReason } from '../types/browser-fallback-reason';
import {
    isWithheldPage,
    PageObstruction,
    type WithheldPageObstruction,
} from '../types/page-obstruction';
import {
    registerEnvironmentSelectionTools,
    type EnvironmentSelectionToolsHost,
} from './environment-selection-tools';
import { registerReportMissingInformationTool } from '../agent/missing-information-tool';
import { wireRuntimeExecutors, type RuntimeExecutorWiring } from './agent-runtime-executor-wiring';
import {
    type ExecutorDependenciesByName,
    type ExecutorRuntimeHost,
    type FilteringExecutor,
    type FilteringExecutorRegistry,
    type LaunchedEvidenceSession,
    type EvidenceSessionLaunchRequest,
} from './filtering-executors';
import { registerLifecycleTools, type RuntimeLifecycleToolsHost } from './runtime-lifecycle-tools';
import {
    APPLY_RULE_TOOL_DEADLINE_MS,
    BROWSER_LAUNCH_DEADLINE_MS,
    BROWSER_TOOL_DEADLINE_MS,
} from './browser-tool-deadlines';
import {
    terminalSymptomObservation,
    validateTerminalOutcome as judgeTerminalOutcome,
} from './terminal-outcome-validator';
import type { TerminalValidationView } from './terminal-validation-view';
import type { CandidatePlacementContext } from '../repo/candidate-placement-check';
import {
    DECLARED_BASELINE_SETTINGS_PROFILE,
    launchBrowserAdvertisement,
    launchBrowserRefusal,
    launchBrowserRequestSchema,
    normalizeLaunchBrowserArguments,
    requestsUnsupportedProxyRegion,
} from './launch-browser-arguments';
import {
    MAX_CANDIDATE_VALIDATION_EXECUTIONS,
    MAX_TECHNICAL_BROWSER_FAILURES_PER_TARGET,
    bindAllowedTargetUrl,
    candidateLedgerKey,
    canonicalTargetUrl,
    reportedDomainFromAllowedTargets,
    targetUrlMatchKey,
    type CandidateValidationOutcome,
} from './agent-runtime-candidate-context';
import {
    sessionBaselineCredited,
    settingsEvidenceFromReadBack,
    type AgentRuntimeCandidateArtifactEvidence,
    type AgentRuntimeCandidateValidationBinding,
    type AgentRuntimeEnvironmentEvidence,
    type AgentRuntimeScreenshotEvidence,
    type AgentRuntimeSessionState,
} from './agent-runtime-session-evidence';
import { extensionBaselineSettingsFromStateRead } from './phase-application-wiring';
import {
    preparedExtensionActualContext,
    preparedExtensionLaunchChannel,
    preparedPhaseSessionConfig,
    relaunchPolicySession,
    type PreparedSessionLaunchHost,
} from './prepared-session-launch';
import { runApplication } from './phase-application-flow';
import {
    applicationInstructionContent,
    hostPerformsApplication,
    type PhaseApplicationFlowHost,
    type PhaseApplicationModelRunnerFactory,
} from './phase-application-flow-host';
import {
    createProductionBrowserRegistry,
    openSessionAppliedRulesLog,
} from './session-browser-registry';
import { recordingUnfilteredHosts, type AppliedRulesLog } from '../environment/applied-rules';
import { createRunHostStateRoot, type RunHostStateRoot } from './host-state-root';
import {
    buildFirefoxExtensionEnvironmentOptions,
    firefoxPreparedLaunch,
    runDeclaredFilterBaseline,
} from './firefox-environment-wiring';
import type { FirefoxExtensionEnvironmentOptions } from '../environment/firefox-extension-environment';
import {
    buildBrowserExtensionEnvironmentOptions,
    launchExtensionBaseline,
} from './phase-application-launch';
import { LaunchBaselineOutcomeKind, launchBaselineSettingsFields } from './launch-baseline-outcome';

/**
 * Maximum deterministic extension-settings failures allowed for one prompt-safe target.
 *
 * A non-convergent settings request can never succeed, but each attempt is cheap and touches no
 * site, so the counter stays smaller than the browser-access budget and never blocks a provably
 * convergent retry.
 */
const MAX_EXTENSION_CONFIGURATION_FAILURES_PER_TARGET = 2;

/**
 * Default shared wall-clock budget for one extension-configuration pass in a phase session.
 *
 * Every phase session bootstraps a fresh profile, and a fresh-install MV3 bootstrap (filter load
 * plus DNR ruleset compilation) under CI matrix load routinely outlives the short analysis-session
 * default. The budget is shared by all readiness waits of one configuration pass, so one experiment
 * spends at most one budget in phase B plus two in phase C (settings pass and user rules pass) —
 * about five minutes at this default, inside the fifteen-minute apply_rule deadline even before the
 * per-wait floors.
 */
const DEFAULT_PHASE_READINESS_BUDGET_MS = 90_000;

/**
 * Bound one native failure detail for a model-facing tool response.
 *
 * @param detail - Native failure message.
 * @param maxLength - Maximum characters kept.
 * @returns Original detail, or its truncated prefix with an ellipsis.
 */
function truncateDetail(detail: string, maxLength: number): string {
    return detail.length <= maxLength ? detail : `${detail.slice(0, maxLength - 1)}…`;
}

/**
 * Typed facts about the last infrastructure-shaped phase-session bootstrap failure.
 */
export interface PhaseBootstrapInfrastructureFailure {
    /**
     * Stable failure identity: error name plus configuration-failure category.
     */
    signature: string;

    /**
     * Consecutive infrastructure-shaped failures carrying this exact signature.
     */
    consecutiveFailures: number;

    /**
     * Native failure message preserved for diagnostics and classification.
     */
    detail: string;
}

/**
 * Number of physical navigation attempts performed by each agent-runtime open_page tool call.
 */
const AGENT_RUNTIME_OPEN_PAGE_RETRIES = 1;

/**
 * Maximum characters retained from one reporter screenshot observation.
 *
 * The observations are replayed into later prompts, so a single verbose vision answer must not be
 * able to crowd the reporter's own words out of the context window.
 */
const MAX_REPORTER_SCREENSHOT_OBSERVATION_LENGTH = 2_000;

/**
 * Inputs and immutable trust boundaries for one model-driven browser investigation.
 */
export interface AgentRuntimeOptions {
    /**
     * Prompt-safe issue snapshot exposed by fetch_issue.
     */
    issue: RawIssue;

    /**
     * Parser-owned declared and reported context used by the environment-selection host.
     */
    issueFacts: IssueFacts;

    /**
     * Integrity-registered issue screenshot IDs kept behind stable one-based model references.
     */
    issueAttachmentArtifactIds: string[];

    /**
     * Prompt-safe issue URLs from which the model must select an exact browser target.
     */
    allowedTargetUrls: string[];

    /**
     * Artifact directory shared by every model-selected browser profile.
     */
    artifactsDir: string;

    /**
     * Pinned AdguardFilters checkout available to repository and validation tools.
     */
    filtersPath: string;

    /**
     * Whether every browser session is headless.
     */
    headless: boolean;

    /**
     * Whether Chromium must use the CI no-sandbox flag.
     */
    noSandbox: boolean;

    /**
     * Single-shot client used for reporter and candidate visual analysis.
     */
    vision: SingleShotClient;

    /**
     * Recorder owning all tool and evidence artifacts.
     */
    recorder: TraceRecorder;

    /**
     * The run's one host-prepared extension build, prepared before the fix session starts: the
     * pinned prebuilt release, the operator-preloaded directory, or the preparation session's
     * result. `launch_browser` with `extension="prepared"` loads it from the first turn.
     */
    preparedExtension?: PreparedExtension;

    /**
     * This run's rule-guidance source: the pinned KnowledgeBase checkout or the instruction's
     * linked documents. Both travel into the tool factory and the guidance session dispatches on
     * the `kind` tag.
     */
    knowledgeGuidanceSource?: RuleGuidanceSource;

    /**
     * The repository's own lint command, when the run has one; it enables `lint_rule`.
     */
    repositoryLint?: RepositoryLintCommand;

    /**
     * The run instruction loaded at run start, when this run carries one. Its application contract
     * governs every between-phases rule application; a run without one applies the built-in AdGuard
     * instruction.
     */
    instruction?: LoadedInstruction;

    /**
     * The placement this run's instruction declares, rendered once by the core at run start. A
     * draft must name the declared file for rules of a declared kind, and the candidate's edit
     * appends to it; absent, the file the agent chooses is the one the edit goes to.
     */
    declaredPlacement?: DeclaredPlacementSet;

    /**
     * Validated LLM provider configuration the bounded application sessions are launched with.
     */
    llm: LlmConfig;

    /**
     * The run's pi runtime reused for the bounded application sessions.
     */
    piRuntime: PiRuntime;

    /**
     * Run-scoped usage collector shared with every model session of the run: when present, each
     * bounded application session charges its turns and tokens into the same collector the fix,
     * preparation and observe sessions use, so they land in one usage summary and run record.
     */
    usageCollector?: RunUsageCollector;

    /**
     * Whether verbose lifecycle logging is enabled.
     */
    verbose?: boolean;

    /**
     * Wall-clock budget for extension readiness waits in apply_rule phase sessions.
     *
     * Analysis sessions keep the built-in short budget; phase sessions bootstrap a fresh profile
     * per phase and need tens of seconds under CI matrix load.
     */
    phaseReadinessBudgetMs?: number;

    /**
     * Executor names the run locks from the registry, in request order.
     *
     * Absent resolves every registered executor; an unknown name fails `AgentRuntime.create` naming
     * it and the registered set, before any site access or model session.
     */
    agentRuntimeExecutors?: readonly string[];

    /**
     * The run's opaque per-executor dependency bag, forwarded to whichever registration the run
     * activates. An executor registered outside this tree reads its own name's entry here for the
     * host wiring `src/` cannot type; absent for a run that wires none.
     */
    executorDependencies?: ExecutorDependenciesByName;
}

/**
 * Runtime-owned browser context supplied to an injectable browser registry factory.
 */
export interface AgentRuntimeBrowserContext {
    /**
     * Newly launched isolated browser session.
     */
    session: BrowserSession;

    /**
     * Runtime recorder that owns every browser artifact identity and local path.
     */
    recorder: TraceRecorder;

    /**
     * Reporter symptom accumulated from issue screenshot vision calls.
     */
    reporterSymptom: () => string | undefined;

    /**
     * Physical navigation attempts allowed for one model-visible open_page call.
     */
    openPageRetries: number;

    /**
     * Bounded consent setup selected by the model for this isolated session.
     */
    consentStrategy: ReproProfile['consentStrategy'];
}

/**
 * Injectable lifecycle seams used by focused runtime tests.
 */
export interface AgentRuntimeDependencies {
    /**
     * Factory for the initial repository, KnowledgeBase, and offline vision tools.
     */
    createBaseRegistry?: () => Promise<ToolRegistry>;

    /**
     * Browser-session factory used instead of BrowserSession.create.
     */
    createBrowserSession?: (config: BrowserSessionConfig) => Promise<BrowserSession>;

    /**
     * Factory for browser-bound tools registered after each successful launch.
     */
    createBrowserRegistry?: (context: AgentRuntimeBrowserContext) => Promise<ToolRegistry>;

    /**
     * Hermetic executor registry resolving the run's executor set instead of the process registry.
     * Tests inject one to drive registry-driven executor flows without touching the global
     * registration; production runs always resolve from the global.
     */
    filteringExecutors?: FilteringExecutorRegistry;

    /**
     * Optional single-phase observer used by focused runtime tests.
     */
    observeEnvironmentPhase?: (
        input: AdsEnvironmentPhaseObservationInput,
    ) => Promise<ValidatorPhaseCompletion>;

    /**
     * Bounded browser and vision seams used with the real production Extension Ads observer.
     */
    browserExtensionAdsObserverDependencies?: BrowserExtensionAdsObserverDependencies;

    /**
     * Host read-back of the prepared AdGuard extension's full observable state.
     *
     * Defaults to the production state read over the session's persistent context; tests inject one
     * to drive the application read-back without a browser.
     */
    readAdGuardExtensionState?: typeof readAdGuardExtensionStateDefault;

    /**
     * Turn Chromium's "Allow User Scripts" on for the prepared extension before a list slice is
     * imported as a custom filter. Defaults to the production toggle over `chrome://extensions`;
     * tests inject one to prove the order without a browser.
     */
    allowUserScripts?: typeof allowUserScriptsDefault;

    /**
     * Start the run's loopback text server the list slices are served from. Defaults to the
     * production server on a kernel-chosen port; tests inject one to prove that a listen failure is
     * a slice-Baseline outcome the next slice launch retries, not a launch failure.
     */
    createLoopbackTextServer?: typeof createLoopbackTextServer;

    /**
     * Location of the prepared extension's background runtime inside one persistent context.
     *
     * Defaults to the production search; tests inject one for fake session contexts.
     */
    findExtensionRuntime?: typeof findExtensionRuntimeDefault;

    /**
     * Factory for the bounded application-session runner behind every between-phases application.
     *
     * Defaults to the shared pi mode-session runner, which requires the run's pi runtime and LLM
     * configuration; an injected factory (tests) may close over its own inputs and receives
     * whatever the run carries, so the application procedure is observable without a model.
     */
    createPhaseApplicationModelRunner?: PhaseApplicationModelRunnerFactory;
}

/**
 * Runtime-owned environment lifecycle consumed by the outer fix core.
 */
export interface AgentRuntimeFilteringEnvironmentLifecycle {
    /**
     * Selected adapter whose resources remain owned until outer cleanup.
     */
    adapter: FilteringEnvironmentAdapter;

    /**
     * Sole canonical recorder for this runtime.
     */
    recorder: environmentExecution.FilteringEnvironmentExecutionRecorder;

    /**
     * Most recent provisional environment disposition.
     */
    disposition: ProvisionalEnvironmentDisposition;
}

/**
 * Bounded browser failure retained for terminal status classification.
 */
interface AgentBrowserError {
    /**
     * Stable machine-readable failure category.
     */
    kind: string;

    /**
     * Truncated diagnostic detail returned by the browser boundary.
     */
    detail: string;

    /**
     * Stable result fallback used by the core runner when no browser evidence was obtained.
     */
    fallbackReason: BrowserFallbackReason;
}

/**
 * Accumulated technical browser failures for one exact prompt-safe target.
 */
/**
 * Typed reason an exhausted target stayed unverifiable, surfaced to the core result mapping.
 */
export interface ExhaustedTechnicalBrowserFailure {
    /**
     * Typed browser or target-environment failure category of the exhausted target.
     */
    fallbackReason: BrowserFallbackReason;

    /**
     * Bounded user-facing diagnostic recorded with the final attempt.
     */
    detail: string;
}

interface TechnicalBrowserFailureState {
    /**
     * Number of failed browser-access operations observed for the target.
     */
    attempts: number;

    /**
     * Most recent browser fallback category.
     */
    fallbackReason: BrowserFallbackReason;

    /**
     * Bounded most recent diagnostic detail.
     */
    detail: string;

    /**
     * Fatal process signal of the most recent launch_browser crash, or null for failures that carry
     * no deterministic launch signature (timeouts, navigation failures, mixed signals).
     */
    launchSignal: string | null;

    /**
     * Whether the budget was declared exhausted early because the identical launch crash repeated:
     * an unchanged environment that dies on the same fatal signal cannot succeed on a third
     * attempt, so the remaining attempt is forfeited instead of burned.
     */
    failFastExhausted: boolean;
}

/**
 * How one kind of withheld page is recorded and explained to the model.
 */
interface WithheldPageReport {
    /**
     * Typed reason an exhausted target stayed unverifiable.
     */
    fallbackReason: BrowserFallbackReason;

    /**
     * The wall, named as the subject of the recorded detail and the guidance.
     */
    wall: string;

    /**
     * What another session can change about this wall.
     */
    nextSession: string;
}

/**
 * The record and guidance for each wall vision can see in place of the reported page.
 */
const WITHHELD_PAGE_REPORT: Readonly<Record<WithheldPageObstruction, WithheldPageReport>> = {
    [PageObstruction.AntiBotChallenge]: {
        fallbackReason: BrowserFallbackReason.BotChallenge,
        wall: 'An anti-bot challenge',
        nextSession: 'a materially different session may still pass',
    },
    [PageObstruction.SignInWall]: {
        fallbackReason: BrowserFallbackReason.SignInRequired,
        wall: 'A sign-in wall',
        nextSession: 'this runner cannot sign in, so another session rarely gets past it',
    },
    [PageObstruction.RegionBlock]: {
        fallbackReason: BrowserFallbackReason.GeoBlocked,
        wall: 'A regional block',
        nextSession: "this runner's region is fixed, so another session rarely gets past it",
    },
};

/**
 * Candidate metadata retained across the browser dispatch boundary.
 */
interface PendingCandidateAttempt {
    /**
     * The model-proposed rule exactly as it would be published, outer whitespace trimmed.
     *
     * The experiment applies these bytes, not the normalized form: the verdict and the published
     * evidence bind the validation to the rule text the run publishes, and the normalized form
     * reorders and lowercases a network rule's modifiers.
     */
    rule: string;

    /**
     * Shared normalized representation of the model-proposed rule.
     */
    normalized: NormalizedRule;

    /**
     * One-based runtime candidate attempt number.
     */
    attemptNumber: number;

    /**
     * Candidate operation against the published baseline; add when omitted by the model.
     */
    operation: CandidateOperation;

    /**
     * Exact published baseline line targeted by an edit or remove operation, verbatim.
     *
     * Never normalized: baseline mutation receipts compare the exact published bytes.
     */
    originalRule?: string;

    /**
     * Reveal steps this call passed, replayed in every phase; absent when it passed none.
     */
    revealPlan?: NormalizedSafeInteractionPlan;
}

/**
 * Trusted apply_rule response fields retained under their producing browser session.
 */
interface CandidateValidationReference {
    /**
     * Exact browser session active when apply_rule returned.
     */
    sessionId: string;

    /**
     * Schema-valid runner-bound semantic review returned by apply_rule.
     */
    visualReview: CandidateVisualReview;

    /**
     * Recorder artifact identity of the persisted semantic review.
     */
    visualReviewArtifactId: string;
}

/**
 * Return items in deterministic key order without relying on a mutating array sort.
 *
 * @param items - Values to order.
 * @param keyOf - Stable string key used for ordering.
 * @returns Newly allocated ordered values.
 */
function orderedEnvironmentItems<T>(items: T[], keyOf: (item: T) => string): T[] {
    return items.reduce<T[]>((ordered, item) => {
        const itemKey = keyOf(item);
        const insertionIndex = ordered.findIndex(
            (existing) => keyOf(existing).localeCompare(itemKey) > 0,
        );
        if (insertionIndex === -1) {
            return [...ordered, item];
        }
        return [...ordered.slice(0, insertionIndex), item, ...ordered.slice(insertionIndex)];
    }, []);
}

/**
 * Canonicalize a model-selected browser environment value for stable equality checks.
 *
 * Object keys and set-like settings arrays are sorted so reordering filter IDs or JSON properties
 * cannot make the same failed environment appear materially different.
 *
 * @param value - Parsed browser environment value.
 * @returns Recursively canonical serializable value.
 */
function canonicalEnvironmentValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return orderedEnvironmentItems(
            value.map((item) => canonicalEnvironmentValue(item)),
            (item) => JSON.stringify(item),
        );
    }
    if (typeof value !== 'object' || value === null) {
        return value;
    }
    return Object.fromEntries(
        orderedEnvironmentItems(
            Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
            ([key]) => key,
        ).map(([key, entryValue]) => [key, canonicalEnvironmentValue(entryValue)]),
    );
}

/**
 * Build a stable identity for one complete model-selected browser environment.
 *
 * @param targetUrl - Fragment-insensitive identity of the prompt-safe target URL.
 * @param extensionMode - Whether the prepared extension is loaded.
 * @param extensionCommit - Prepared extension commit, when loaded.
 * @param profile - Model-selected Chromium profile.
 * @param settings - Model-selected extension settings, when loaded.
 * @returns Canonical environment identity retained only for this run.
 */
function browserEnvironmentKey(
    targetUrl: string,
    extensionMode: ExtensionMode,
    extensionCommit: string | null,
    profile: Omit<ReproProfile, 'userAgentProfile'>,
    settings?: AdGuardExtensionSettingsProfile,
): string {
    return JSON.stringify(
        canonicalEnvironmentValue({
            targetUrl,
            extensionMode,
            extensionCommit,
            profile,
            settings: settings ?? null,
        }),
    );
}

/**
 * Read the fallback reason a browser-tool failure carries, whatever its class.
 *
 * @param result - Browser tool result returned by the active session registry.
 * @returns The typed fallback reason, or null when the result carries none.
 */
function refusedNavigationFallbackReason(
    result: Record<string, unknown>,
): BrowserFallbackReason | null {
    return typeof result.error === 'string' && typeof result.fallbackReason === 'string'
        ? (result.fallbackReason as BrowserFallbackReason)
        : null;
}

/**
 * Read a typed technical navigation category from a browser-tool failure.
 *
 * @param result - Browser tool result returned by the active session registry.
 * @returns Supported technical fallback category, or undefined for non-technical/model errors.
 */
function technicalNavigationFallbackReason(
    result: Record<string, unknown>,
): BrowserFallbackReason | undefined {
    if (typeof result.error !== 'string' || typeof result.fallbackReason !== 'string') {
        return undefined;
    }
    const fallbackReason = result.fallbackReason as BrowserFallbackReason;
    // Every navigation outcome the site or the network produced counts: this decides whether the
    // target's per-run budget is charged and whether the failure is remembered at all. A refusal of
    // our own — the model named a URL off the issue origins, or an unsafe one — says nothing about
    // the target and is not counted: charging the budget and retiring the session for it would let
    // three excursions declare a reachable site unavailable. The model may repeat the refused URL,
    // but each repeat is one refused call, bounded by the iteration budget and the same-tool streak
    // notice.
    return isTargetEnvironmentFallbackReason(fallbackReason) &&
        !isAgentRefusalFallback(fallbackReason)
        ? fallbackReason
        : undefined;
}

/**
 * Return a detached public view of one mutable browser-session record.
 *
 * @param state - Internal session state.
 * @returns Immutable evidence suitable for orchestration and result serialization.
 */
function environmentEvidence(state: AgentRuntimeSessionState): AgentRuntimeEnvironmentEvidence {
    return {
        sessionId: state.sessionId,
        targetUrl: state.targetUrl,
        extensionMode: state.extensionMode,
        profile: { ...state.profile },
        ...(state.selectedSettingsProfileKind
            ? { selectedSettingsProfileKind: state.selectedSettingsProfileKind }
            : {}),
        ...(state.extension ? { extension: state.extension } : {}),
        ...(state.extensionBaselineReadBack && state.selectedSettingsProfileKind
            ? {
                  settingsEvidence: settingsEvidenceFromReadBack(
                      state.selectedSettingsProfileKind,
                      state.extensionBaselineReadBack,
                  ),
              }
            : {}),
        ...(state.extensionBaselineReadBack
            ? { extensionBaselineReadBack: state.extensionBaselineReadBack }
            : {}),
        // The other channel a prepared session's baseline is credited through: a blocker that
        // declares its own list selection carries the declared keys instead of a read-back record,
        // and `sessionBaselineCredited` reads either — so this projection must carry it too or the
        // terminal gates would see an uncredited session.
        ...(state.declaredBaselineListKeys
            ? { declaredBaselineListKeys: state.declaredBaselineListKeys }
            : {}),
        navigationVerified: state.navigationVerified,
        fullVisionVerified: state.fullVisionVerified,
        pageCaptures: state.pageCaptures.map((capture) => ({
            visionVerified:
                capture.coverageComplete &&
                capture.requiredArtifactIds.length > 0 &&
                capture.requiredArtifactIds.every((artifactId) =>
                    state.analyzedArtifactIds.has(artifactId),
                ),
            viewport: capture.viewport ? { ...capture.viewport } : null,
            fullPageOverview: capture.fullPageOverview ? { ...capture.fullPageOverview } : null,
            tiles: capture.tiles.map((tile) => ({ ...tile })),
            coverageComplete: capture.coverageComplete,
            reporterSymptomPresence: capture.reporterSymptomPresence,
        })),
    };
}

/**
 * Browser lifecycle tool whose failure counts against the target-wide technical budget.
 */
const BrowserLifecycleToolName = {
    /**
     * The tool that launches a new browser session.
     */
    LaunchBrowser: 'launch_browser',

    /**
     * The tool that navigates an existing session to a target page.
     */
    OpenPage: 'open_page',
} as const;

/**
 * BrowserLifecycleToolName value.
 */
type BrowserLifecycleToolName =
    (typeof BrowserLifecycleToolName)[keyof typeof BrowserLifecycleToolName];

/**
 * Exact recorder media role required by a candidate artifact binding.
 */
const CandidateArtifactExpectedType = {
    /**
     * A structured JSON artifact (e.g. factual validation output).
     */
    ApplicationJson: 'application/json',

    /**
     * A candidate visual review record.
     */
    CandidateVisualReview: 'candidate-visual-review',

    /**
     * A single viewport screenshot.
     */
    Screenshot: 'screenshot',

    /**
     * A full-page screenshot.
     */
    ScreenshotFullPage: 'screenshot-full-page',
} as const;

/**
 * CandidateArtifactExpectedType value.
 */
type CandidateArtifactExpectedType =
    (typeof CandidateArtifactExpectedType)[keyof typeof CandidateArtifactExpectedType];

/**
 * Stateful lifecycle controlled by one reasoning loop through high-level tools.
 */
export class AgentRuntime {
    /**
     * Live registry read by the agent loop before every reasoning turn.
     */
    readonly registry: ToolRegistry;

    /**
     * Persistent tools that must survive browser-session replacement.
     */
    private readonly baseToolNames: Set<string>;

    /**
     * Host-owned immutable environment selection and provenance boundary.
     */
    private readonly environmentHost: EnvironmentSelectionHost;

    /**
     * Extension lifecycle definitions hidden until the agent locks Extension.
     */
    private readonly extensionLifecycleDefinitions = new Map<string, ToolDefinition>();

    /**
     * Exact allowed issue number recorded only after a successful fetch_issue call.
     */
    private fetchedIssueNumber?: number;

    /**
     * Session-bound tools removed when the active browser is closed.
     */
    private readonly activeBrowserToolNames = new Set<string>();

    /**
     * Exact extension build selected and prepared by the model.
     */
    private preparedExtension?: PreparedExtension;

    /**
     * Current isolated browser session.
     */
    private browserSession?: BrowserSession;

    /**
     * Bounded vision observations of reporter-owned screenshots.
     */
    private reporterScreenshotObservations: string[] = [];

    /**
     * Successful reporter screenshot results reused for repeated inspection requests in this run.
     */
    private readonly reporterScreenshotResults = new Map<string, Record<string, unknown>>();

    /**
     * Unique reporter screenshot artifacts successfully inspected by the vision model.
     */
    private readonly analyzedIssueScreenshotArtifactIds = new Set<string>();

    /**
     * Whether pinned rule guidance was consulted before a candidate.
     */
    private guidanceConsulted = false;

    /**
     * Pages a reported URL redirected to on another site, in the order the run reached them.
     *
     * A link shortener or a tracking redirect is the reported URL, yet the page the reporter saw is
     * where it lands. Each landing becomes a target the model may launch a session on, and the
     * domain a candidate may be scoped to.
     */
    private readonly redirectTargetUrls: string[] = [];

    /**
     * Canonical candidate rules and their stable attempt numbers.
     */
    private readonly candidateAttempts = new Map<string, number>();

    /**
     * Browser sessions in which each canonical candidate was actually dispatched.
     */
    private readonly candidateAttemptSessionIds = new Map<string, Set<string>>();

    /**
     * How often a candidate's experiment stopped because the baseline showed no symptom.
     *
     * The first occurrence buys one restated symptom description; a second proves the candidate
     * cannot be judged in a controlled experiment at all.
     */
    private readonly baselineSymptomAbsentCounts = new Map<string, number>();

    /**
     * Browser-bound candidate outcomes indexed by canonical rule.
     */
    private readonly candidateValidationOutcomes = new Map<string, CandidateValidationOutcome>();

    /**
     * Browser-bound executions per canonical candidate, independent of semantic-attempt budget.
     */
    private readonly candidateValidationExecutionCounts = new Map<string, number>();

    /**
     * Reveal-step plan digests each canonical candidate was already judged under, empty for none.
     */
    private readonly candidateRevealPlanDigests = new Map<string, Set<string>>();

    /**
     * Technical browser-access failures accumulated by exact prompt-safe target URL.
     */
    private readonly technicalBrowserFailures = new Map<string, TechnicalBrowserFailureState>();

    /**
     * Sessions whose withheld page already spent a technical attempt, so repeated landings or
     * repeated capture analyses inside one session never double-charge the budget.
     */
    private readonly withheldPageCountedSessions = new Set<string>();

    /**
     * Browser environments that already produced a technical navigation failure in this run.
     */
    private readonly failedBrowserEnvironmentKeys = new Set<string>();

    /**
     * Deterministic extension-settings failures accumulated by exact prompt-safe target URL.
     *
     * Non-convergent settings never touch the site, so they are budgeted apart from the
     * browser-access failures that probe the target.
     */
    private readonly extensionConfigurationFailures = new Map<string, number>();

    /**
     * Filter IDs proven non-convergent for one target, used to steer retry guidance away from the
     * doomed reporter import URL.
     */
    private readonly nonConvergentFilterIds = new Map<string, number[]>();

    /**
     * Browser environments retained after session replacement for exact evidence binding.
     */
    private readonly sessionStates = new Map<string, AgentRuntimeSessionState>();

    /**
     * Candidate validation artifact identities mapped to the session that produced them.
     */
    private readonly validationSessionIds = new Map<string, string>();

    /**
     * Candidate review references retained under the exact validation identity and session.
     */
    /**
     * Candidate-phase CLI proofs by validation identity, for desktop candidate bindings.
     */
    private readonly candidateCliProofs = new Map<string, CliAdapterProof>();

    private readonly candidateValidationReferences = new Map<
        string,
        CandidateValidationReference
    >();

    /**
     * Page screenshot artifact identities mapped to the session that captured them.
     */
    private readonly screenshotSessionIds = new Map<string, string>();

    /**
     * Current session identity used by dynamically registered browser tools.
     */
    private activeSessionId?: string;

    /**
     * Most recently launched session identity retained for non-verified reporting.
     */
    private latestSessionId?: string;

    /**
     * Most recent session whose prepared extension settings Chromium verified successfully.
     */
    private latestVerifiedSettingsSessionId?: string;

    /**
     * Whether a launch with the reporter's own settings proved that their filter set exceeds the
     * MV3 limits, waiving reporter parity for the terminal decision.
     */
    private readonly reporterSettingsLimits: ReporterSettingsLimits;

    /**
     * Most recent typed launch or configuration failure.
     */
    private lastBrowserError?: AgentBrowserError;

    /**
     * Adapter selected lazily by the first eligible Extension candidate.
     */
    private filteringEnvironmentAdapter?: FilteringEnvironmentAdapter;

    /**
     * Sole common execution recorder paired with the selected adapter.
     */
    private filteringEnvironmentRecorder?: environmentExecution.FilteringEnvironmentExecutionRecorder;

    /**
     * Provisional disposition updated after each common experiment.
     */
    private filteringEnvironmentDisposition?: ProvisionalEnvironmentDisposition;

    /**
     * Monotonic physical execution ordinal for common-environment candidate experiments.
     */
    private filteringEnvironmentExperimentExecutionOrdinal = 0;

    /**
     * Infrastructure-shaped phase-session bootstrap failures of the current attempt streak.
     *
     * A phase session that dies inside browser launch or extension bootstrap is an environment
     * fault, not a capability limit of the locked environment: the state keeps the typed detail so
     * the run reports the real cause (and never a capability-limited verdict) and the operator can
     * fix the environment from one run's evidence.
     */
    private phaseBootstrapFailure: {
        /**
         * Stable failure identity: error name plus configuration-failure category.
         */
        signature: string;
        /**
         * Consecutive infrastructure-shaped failures carrying this exact signature.
         */
        consecutiveFailures: number;
        /**
         * Native failure message preserved for diagnostics and the model-facing detail.
         */
        detail: string;
        /**
         * Experiment execution ordinal active when the last failure was recorded.
         */
        experimentOrdinal: number;
    } | null = null;

    /**
     * Proxied evidence route revealed only after an activated executor selection adopted it.
     */
    private cliEvidenceRoute: EvidenceRouteHost | null = null;

    /**
     * Persistent browser contexts of the sessions an application acts over, keyed by the exact
     * session instance.
     *
     * The between-phases application reads the prepared extension's state over the session's own
     * context; a session without one (plain launches, fakes) never enters this map.
     */
    private readonly applicationReadContexts = new WeakMap<IBrowserSession, BrowserContext>();

    /**
     * The active browser session's budgets for its open-ended tools.
     */
    private readonly browserToolBudgets = new BrowserToolBudgets();

    /**
     * The run's loopback text server, started by the first list slice and living until the run
     * releases its host state: the extension may re-download a custom filter after its import.
     */
    private loopbackTextServer?: Promise<LoopbackTextServer>;

    /**
     * Line counts of the prepared Chromium build's lists, read once per list for the run.
     */
    private listLineCounter?: ListLineCounter;

    /**
     * Official filter identifiers the run's activated selection executes, as its activation
     * reported them.
     */
    private activatedReporterFilterIds: readonly number[] = [];

    /**
     * The run's list catalog bundle: the one placement-map walk of the pinned checkout and the
     * catalog derived from it, consumed by the registry wiring and by both filtering-environment
     * preparation request constructions.
     */
    private readonly listCatalog: AgentRuntimeListCatalogBundle;

    /**
     * The run's resolved executor registrations the environment-selection host and every adapter
     * construction dispatch through.
     */
    private readonly executors: readonly FilteringExecutor[];

    /**
     * Per-run model-facing tool descriptions composed from the run's executor set.
     */
    private readonly sessionToolDescriptionOverrides: Readonly<Record<string, string>>;

    /**
     * The run's own host-state directory: where a relative file-backed verification target
     * resolves, for the between-phases application and for every launch alike.
     *
     * It is created here rather than derived from the checkout so the file the host maintains lies
     * outside the repository by construction — no walk of the checkout can read the run's own
     * candidate back as repository content.
     */
    private readonly hostStateRoot: RunHostStateRoot;

    /**
     * Construct a runtime after its base tools have been registered.
     *
     * @param options - Immutable issue, browser, and repository boundaries.
     * @param dependencies - Injectable preparation and browser seams.
     * @param baseRegistry - Preserved handlers for persistent non-browser tools.
     * @param registry - Runtime-owned live registry.
     * @param listCatalog - The run's walked placement map and derived list catalog.
     * @param executorWiring - The run's resolved executor set and its selection host.
     */
    private constructor(
        private readonly options: AgentRuntimeOptions,
        private readonly dependencies: AgentRuntimeDependencies,
        private readonly baseRegistry: ToolRegistry,
        registry: ToolRegistry,
        listCatalog: AgentRuntimeListCatalogBundle,
        executorWiring: RuntimeExecutorWiring,
    ) {
        this.registry = registry;
        this.baseToolNames = new Set(registry.getToolNames());
        this.listCatalog = listCatalog;
        this.environmentHost = executorWiring.environmentHost;
        this.executors = executorWiring.executors;
        this.reporterSettingsLimits = new ReporterSettingsLimits(
            reporterSettingsImportUrls(options.issue),
            this.environmentHost,
            createLogger({ verbose: options.verbose ?? false }),
        );
        this.hostStateRoot = createRunHostStateRoot();
        createLogger({ verbose: options.verbose ?? false }).info(
            { hostStateRoot: this.hostStateRoot.path, checkoutPath: options.filtersPath },
            'the run host-state root: every relative file-backed verification target resolves ' +
                'here, outside the repository checkout',
        );
        // The run's one extension build was prepared host-side before this runtime existed.
        this.preparedExtension = options.preparedExtension;
        registerLifecycleTools(this.registry, this.runtimeLifecycleToolsHost());
        this.captureAndHideExtensionLifecycleTools();
        this.sessionToolDescriptionOverrides = registerEnvironmentSelectionTools(
            this.registry,
            this.environmentSelectionToolsHost(),
        );
        registerReportMissingInformationTool(this.registry);
    }

    /**
     * Create one runtime with prompt-safe issue and pinned repository tools.
     *
     * The run's executor set resolves first — after the local snapshot, before any model session or
     * browser — so an unknown requested executor name fails naming itself before any session
     * artifact exists. A one-element set locks its sole executor and activates it deterministically
     * here, with no model turn.
     *
     * @param options - Immutable runtime options.
     * @param dependencies - Optional test seams.
     * @returns Initialized model-driven runtime.
     */
    static async create(
        options: AgentRuntimeOptions,
        dependencies: AgentRuntimeDependencies = {},
    ): Promise<AgentRuntime> {
        const executorWiring = wireRuntimeExecutors({
            issueFacts: options.issueFacts,
            requestedExecutors: options.agentRuntimeExecutors,
            registry: dependencies.filteringExecutors,
            // A blocker that declares its own list selection supplies the run's executable
            // baseline; every other run resolves the reported names.
            filterBaseline: runDeclaredFilterBaseline(
                options.preparedExtension,
                options.issueFacts.enabledFilters.map((filter) => filter.name),
            ),
        });
        // One placement-map walk per run: its map feeds the checkout tools below, and its derived
        // catalog feeds both filtering-environment request constructions. A failed walk is logged,
        // never raised — today's own-walk behavior inside the factory then stays the
        // checkout-readiness gate for the code path that can reach it.
        const listCatalog = buildAgentRuntimeListCatalog({
            filtersPath: options.filtersPath,
            enabledListTexts: options.issueFacts.enabledFilters.map((filter) => filter.name),
            verbose: options.verbose ?? false,
        });
        let baseRegistry: ToolRegistry;
        if (dependencies.createBaseRegistry) {
            baseRegistry = await dependencies.createBaseRegistry();
        } else {
            baseRegistry = await createToolRegistry({
                allowedIssueNumber: options.issue.number,
                checkoutPath: options.filtersPath,
                placementMap: listCatalog.placementMap ?? undefined,
                visionTools: {
                    artifactsDir: options.artifactsDir,
                    recorder: options.recorder,
                    vision: options.vision,
                    reporterSymptom: () => undefined,
                },
                localIssueTools: {
                    localIssue: options.issue,
                    reportedDomain: reportedDomainFromAllowedTargets(options.allowedTargetUrls),
                },
                knowledgeGuidance: options.knowledgeGuidanceSource,
                ...(options.repositoryLint === undefined
                    ? {}
                    : { repositoryLint: options.repositoryLint }),
            });
        }
        const registry = new ToolRegistry();
        for (const definition of baseRegistry.getDefinitions()) {
            const name = definition.function.name;
            // Every base tool is copied verbatim, and mergeBrowserTools skips base names so the
            // single base registration is never clobbered by a per-session copy.
            registry.register({
                definition,
                handler: async (args) => await baseRegistry.dispatch(name, args),
            });
        }
        const runtime = new AgentRuntime(
            options,
            dependencies,
            baseRegistry,
            registry,
            listCatalog,
            executorWiring,
        );
        await runtime.activateSoleExecutor();
        return runtime;
    }

    /**
     * Return whether at least one browser session successfully navigated to its selected target.
     *
     * @returns True after a successful runner-observed navigation.
     */
    hasBrowserEvidence(): boolean {
        return [...this.sessionStates.values()].some((state) => state.navigationVerified);
    }

    /**
     * Return the run's one host-prepared extension build.
     *
     * @returns The prepared extension, when the host prepared one before the run.
     */
    getPreparedExtension(): PreparedExtension | undefined {
        return this.preparedExtension;
    }

    /**
     * Return the immutable environment selection audit produced by this runtime.
     *
     * @returns Locked selection snapshot, or null before the agent chooses.
     */
    getEnvironmentSelection(): EnvironmentSelectionSnapshot | null {
        return this.environmentHost.snapshot();
    }

    /**
     * Return the per-run model-facing tool descriptions composed from the run's executor set.
     *
     * @returns Guidance overrides keyed by tool name; empty for a sole-executor run, which offers
     *   no choice to describe.
     */
    sessionToolDescriptions(): Readonly<Record<string, string>> {
        return this.sessionToolDescriptionOverrides;
    }

    /**
     * Activate the run's sole executor without a model turn.
     *
     * A one-element set was locked deterministically at construction; the executor's activation
     * applies the model-loop effects a lock through select_environment would have applied. The
     * registration itself declines activation for a lock its capabilities cannot serve.
     */
    private async activateSoleExecutor(): Promise<void> {
        if (this.executors.length !== 1) {
            return;
        }
        await this.activateExecutor(this.executors[0]!);
    }

    /**
     * Activate one resolved executor for the run.
     *
     * @param registration - The executor registration to activate.
     */
    private async activateExecutor(registration: FilteringExecutor): Promise<void> {
        const facts = this.options.issueFacts;
        const runtime: ExecutorRuntimeHost = {
            activateEvidenceRoute: (route, reporterFilterIds) => {
                this.activateEvidenceRoute(route, reporterFilterIds);
            },
            enableExtensionLifecycleTools: () => {
                this.enableExtensionLifecycleTools();
            },
        };
        await registration.activate({
            environmentHost: this.environmentHost,
            issueFacts: facts,
            targetUrl: this.options.allowedTargetUrls[0]!,
            reporterFilterIds: readReporterOfficialFilterIds(facts),
            runtime,
            executorDependencies: this.options.executorDependencies,
        });
    }

    /**
     * Return the registration of the currently locked executor.
     *
     * @returns The resolved registration owning the lock, or undefined while nothing is locked or
     *   the run locked the reserved unsupported-product case.
     */
    private lockedExecutorRegistration(): FilteringExecutor | undefined {
        const selectedKind = this.environmentHost.snapshot()?.selectedKind;
        if (
            !selectedKind ||
            selectedKind === EnvironmentSelectionReservedCase.UnsupportedProductCase
        ) {
            return undefined;
        }
        return this.executors.find((executor) => executor.name === selectedKind);
    }

    /**
     * Launch one proxied evidence session through the run's activated evidence route.
     *
     * @param request - Exact target the session may open.
     * @returns The opened session and its freshly minted session identity.
     */
    private async launchExecutorEvidenceSession(
        request: EvidenceSessionLaunchRequest,
    ): Promise<LaunchedEvidenceSession> {
        const route = this.cliEvidenceRoute;
        if (!route) {
            throw new Error(
                'A proxied evidence session requires the run to hold an activated evidence route.',
            );
        }
        const session = await route.launchEvidenceSession({
            targetUrl: request.targetUrl,
            reproProfile: this.cliEvidenceProfile(),
            artifactsDir: this.options.artifactsDir,
            headless: this.options.headless,
            noSandbox: this.options.noSandbox,
            logger: createLogger({ verbose: this.options.verbose ?? false }),
        });
        return { session, sessionId: randomUUID() };
    }

    /**
     * Bind trusted prepared Extension provenance before the outer result snapshot is serialized.
     *
     * Common candidate execution may bind this earlier; report-only runs use this final Host step
     * without claiming that browser navigation itself succeeded.
     */
    bindPreparedExtensionActualContextForResult(): void {
        const snapshot = this.environmentHost.snapshot();
        const prepared = this.getPreparedExtension();
        if (
            snapshot?.selectedKind !== BrowserExtensionExecutorName ||
            snapshot.actual !== null ||
            !prepared
        ) {
            return;
        }
        this.environmentHost.bindActualContext(
            BrowserExtensionExecutorName,
            preparedExtensionActualContext(prepared),
        );
    }

    /**
     * Return the runtime-owned lifecycle only after a common environment was selected and prepared.
     *
     * @returns Adapter, recorder, and provisional disposition for outer cleanup.
     */
    getFilteringEnvironmentLifecycle(): AgentRuntimeFilteringEnvironmentLifecycle | undefined {
        if (
            !this.filteringEnvironmentAdapter ||
            !this.filteringEnvironmentRecorder ||
            !this.filteringEnvironmentDisposition
        ) {
            return undefined;
        }
        return {
            adapter: this.filteringEnvironmentAdapter,
            recorder: this.filteringEnvironmentRecorder,
            disposition: structuredClone(this.filteringEnvironmentDisposition),
        };
    }

    /**
     * Return the prepared extension and settings proof from the same successful browser session.
     *
     * The record survives later control sessions and navigation failures so terminal reporting does
     * not accidentally bind a prepared extension to unrelated settings or discard proven settings.
     *
     * @returns Latest state-bound prepared-extension settings evidence, when one exists.
     */
    getLatestVerifiedSettingsEnvironment(): AgentRuntimeEnvironmentEvidence | undefined {
        const state = this.latestVerifiedSettingsState();
        return state ? environmentEvidence(state) : undefined;
    }

    /**
     * Return the most recent environment with complete navigated full-page vision evidence.
     *
     * The run's one host-prepared extension is the current pinned build, so only a terminal-grade
     * prepared session carries no-patch evidence, unconditionally.
     *
     * @returns Exact no-patch evidence environment, when one exists.
     */
    getLatestCompleteVisionEnvironment(): AgentRuntimeEnvironmentEvidence | undefined {
        const states = [...this.sessionStates.values()];
        for (let index = states.length - 1; index >= 0; index -= 1) {
            const state = states[index];
            if (
                state.navigationVerified &&
                state.fullVisionVerified &&
                this.isTerminalCurrentPreparedState(state)
            ) {
                return environmentEvidence(state);
            }
        }
        return undefined;
    }

    /**
     * Return the most recently launched environment for diagnostic-only reporting.
     *
     * @returns Latest browser environment, when one launched.
     */
    getLatestEnvironment(): AgentRuntimeEnvironmentEvidence | undefined {
        const state = this.latestEnvironmentState();
        return state ? environmentEvidence(state) : undefined;
    }

    /**
     * Return detached evidence for every launched browser session in launch order.
     *
     * Closed and technically failed sessions remain visible so callers can distinguish control and
     * prepared-extension evidence without attributing a flat screenshot list to the wrong profile.
     *
     * @returns All runner-owned browser environment records in launch order.
     */
    getCompletedEnvironments(): AgentRuntimeEnvironmentEvidence[] {
        return [...this.sessionStates.values()].map(environmentEvidence);
    }

    /**
     * Return the exact browser environment that produced one candidate validation artifact.
     *
     * @param validationArtifactId - Runner-owned candidate validation identity.
     * @returns Bound environment, or undefined when the artifact was not produced in this runtime.
     */
    getValidationEnvironment(
        validationArtifactId: string,
    ): AgentRuntimeEnvironmentEvidence | undefined {
        const sessionId = this.validationSessionIds.get(validationArtifactId);
        const state = sessionId ? this.sessionStates.get(sessionId) : undefined;
        return state ? environmentEvidence(state) : undefined;
    }

    /**
     * Return a candidate validation environment only when that same session carried the prepared
     * extension and its browser-verified settings proof.
     *
     * @param validationArtifactId - Runner-owned candidate validation identity.
     * @returns Exact proof-bound environment, or undefined for control/unverified sessions.
     */
    getVerifiedCandidateEnvironment(
        validationArtifactId: string,
    ): AgentRuntimeEnvironmentEvidence | undefined {
        const sessionId = this.validationSessionIds.get(validationArtifactId);
        const state = sessionId ? this.sessionStates.get(sessionId) : undefined;
        if (!state) {
            return undefined;
        }
        // A desktop candidate verifies through the CLI proxy: its session provably ran no
        // extension, and the retained candidate-phase CLI proof is its executor evidence.
        if (this.candidateCliProofs.has(validationArtifactId)) {
            return state.extensionMode === ExtensionMode.None &&
                !state.extension &&
                !state.settingsEvidence
                ? environmentEvidence(state)
                : undefined;
        }
        return this.isTerminalCurrentPreparedState(state) ? environmentEvidence(state) : undefined;
    }

    /**
     * Return complete candidate artifacts only when one prepared session owns the validation,
     * verified settings, persisted review, and every reviewed screenshot identity/path pair.
     *
     * @param validationArtifactId - Runner-owned candidate validation identity.
     * @returns Exact session-bound proof, or undefined for missing or mixed evidence.
     */
    getVerifiedCandidateBinding(
        validationArtifactId: string,
    ): AgentRuntimeCandidateValidationBinding | undefined {
        const reference = this.candidateValidationReferences.get(validationArtifactId);
        const state = reference ? this.sessionStates.get(reference.sessionId) : undefined;
        // Every refusal below is logged with what it read: otherwise a verified review that never
        // becomes a candidate patch leaves the run analysis-only with no line saying which
        // predicate withheld the binding.
        const refuse = (reason: string, detail: Record<string, unknown> = {}): undefined => {
            createLogger({ verbose: this.options.verbose ?? false }).info(
                { validationArtifactId, reason, ...detail },
                'verified candidate binding withheld',
            );
            return undefined;
        };
        if (!reference) {
            return refuse('no validation reference recorded for the artifact');
        }
        if (!state) {
            return refuse('the validating session state is gone', {
                sessionId: reference.sessionId,
            });
        }
        if (reference.visualReview.verdict !== CandidateVisualVerdict.Verified) {
            return refuse('the recorded visual review is not verified', {
                verdict: reference.visualReview.verdict,
            });
        }
        if (reference.visualReview.validationArtifactId !== validationArtifactId) {
            return refuse('the recorded visual review names another validation artifact', {
                reviewValidationArtifactId: reference.visualReview.validationArtifactId,
            });
        }
        // A desktop candidate has no extension to bind: its executor proof is the candidate
        // phase's CLI proof, and the session provably ran with extension mode none.
        const cliProof = this.candidateCliProofs.get(validationArtifactId);
        if (cliProof) {
            if (
                state.extensionMode !== ExtensionMode.None ||
                state.extension ||
                state.settingsEvidence
            ) {
                return refuse('a CLI candidate proof sits on a session that ran an extension', {
                    extensionMode: state.extensionMode,
                });
            }
        } else if (!this.isTerminalCurrentPreparedState(state)) {
            return refuse('the validating session is not a terminal current prepared session', {
                sessionId: state.sessionId,
                extensionMode: state.extensionMode,
                hasExtension: state.extension !== undefined,
                selectedSettingsProfileKind: state.selectedSettingsProfileKind,
                baselineReadBack: state.extensionBaselineReadBack !== undefined,
                declaredBaselineListKeys: state.declaredBaselineListKeys !== undefined,
                reporterSettingsImportRequired: this.requiresCurrentReporterSettings(),
            });
        }
        const validationIdentity = parseCandidateValidationArtifactId(validationArtifactId);
        const visualIdentity = parseCandidateVisualReviewArtifactId(
            reference.visualReviewArtifactId,
        );
        if (!candidateArtifactIdentitiesEqual(validationIdentity, visualIdentity)) {
            return refuse('the validation and visual-review artifact identities differ', {
                visualReviewArtifactId: reference.visualReviewArtifactId,
            });
        }
        const validationArtifact = this.resolveCandidateArtifactEvidence(
            validationArtifactId,
            'application/json',
        );
        const visualReviewArtifact = this.resolveCandidateArtifactEvidence(
            reference.visualReviewArtifactId,
            'candidate-visual-review',
        );
        const beforeViewport = this.resolveCandidateArtifactEvidence(
            reference.visualReview.beforeViewportArtifactId,
            'screenshot',
        );
        const afterViewport = this.resolveCandidateArtifactEvidence(
            reference.visualReview.afterViewportArtifactId,
            'screenshot',
        );
        const beforeFullPage = this.resolveCandidateArtifactEvidence(
            reference.visualReview.beforeFullPageArtifactId,
            'screenshot-full-page',
        );
        const afterFullPage = this.resolveCandidateArtifactEvidence(
            reference.visualReview.afterFullPageArtifactId,
            'screenshot-full-page',
        );
        if (
            !validationArtifact ||
            !visualReviewArtifact ||
            !beforeViewport ||
            !afterViewport ||
            !beforeFullPage ||
            !afterFullPage
        ) {
            return refuse('a candidate evidence artifact does not resolve to one typed record', {
                validationArtifact: validationArtifact !== undefined,
                visualReviewArtifact: visualReviewArtifact !== undefined,
                beforeViewport: beforeViewport !== undefined,
                afterViewport: afterViewport !== undefined,
                beforeFullPage: beforeFullPage !== undefined,
                afterFullPage: afterFullPage !== undefined,
            });
        }
        const evidence = environmentEvidence(state);
        return {
            validationArtifactId,
            sessionId: state.sessionId,
            ...(cliProof
                ? { cli: structuredClone(cliProof) }
                : {
                      extension: evidence.extension,
                      settingsEvidence: evidence.settingsEvidence,
                  }),
            environment: evidence,
            visualReview: reference.visualReview,
            validationArtifact,
            visualReviewArtifact,
            beforeViewport,
            afterViewport,
            beforeFullPage,
            afterFullPage,
        };
    }

    /**
     * Return the one-based reporter screenshot indices that vision has not inspected yet.
     *
     * Duplicate attachment artifacts are treated as one image while every visible issue index is
     * retained in the response so the model can use the stable references returned by fetch_issue.
     *
     * @returns Remaining issue screenshot indices in prompt order.
     */
    private remainingIssueScreenshotIndices(): number[] {
        const missingArtifactIds = new Set(
            [...new Set(this.options.issueAttachmentArtifactIds)].filter(
                (artifactId) => !this.analyzedIssueScreenshotArtifactIds.has(artifactId),
            ),
        );
        return this.options.issueAttachmentArtifactIds.flatMap((artifactId, index) =>
            missingArtifactIds.has(artifactId) ? [index + 1] : [],
        );
    }

    /**
     * Return whether browser access exhausted its bounded technical retry budget.
     *
     * A single failed profile is not terminal evidence: the model must use the alternative
     * reporter-supported profiles offered by the runtime before declaring the browser unavailable.
     *
     * @returns True after one target reaches the global technical attempt limit.
     */
    private hasExhaustedTechnicalBrowserFailure(): boolean {
        return [...this.technicalBrowserFailures.values()].some(
            (failure) => failure.attempts >= MAX_TECHNICAL_BROWSER_FAILURES_PER_TARGET,
        );
    }

    /**
     * Return the exhausted per-target technical failure backing a bounded-exhaustion terminal.
     *
     * A challenge-walled target leaves the browser fully usable — the interstitial itself is
     * captured as evidence — so the unusable-browser fallback mapping never fires for it. This
     * accessor lets the core surface the typed reason the reported page stayed unverifiable (for
     * example `bot_challenge`) instead of leaving the accepted analysis-only decision without a
     * target status.
     *
     * @returns Fallback reason and bounded detail of the first exhausted target, if any.
     */
    getExhaustedTechnicalBrowserFailure(): ExhaustedTechnicalBrowserFailure | undefined {
        for (const failure of this.technicalBrowserFailures.values()) {
            if (
                failure.attempts >= MAX_TECHNICAL_BROWSER_FAILURES_PER_TARGET ||
                failure.failFastExhausted
            ) {
                return { fallbackReason: failure.fallbackReason, detail: failure.detail };
            }
        }
        return undefined;
    }

    /**
     * Count one withheld-page observation against the target's technical attempt budget.
     *
     * The tools themselves succeeded — the session is open and must stay usable, so the page can be
     * captured as evidence — but the reported page was withheld, and repeating the navigation from
     * this runner rarely changes that. Without this accounting a walled target makes every terminal
     * vision requirement unsatisfiable while never unlocking the bounded-exhaustion exemption: the
     * model is told to capture a page the site refuses to serve (a captcha landing in every
     * session, or a link that redirects to a sign-in page) until the run seals.
     *
     * The only evidence source is the vision model classifying a session capture — judged over the
     * actual pixels, it covers redirects to another origin and walls that keep the original URL
     * alike, with no URL or page-text heuristics to miss or misfire. Each session spends at most
     * one attempt, mirroring the hard-failure budget's one-attempt-per-profile semantics, and the
     * reasoning model can never spend the budget by assertion alone.
     *
     * @param targetUrl - Exact prompt-safe target selected for the run.
     * @param sessionId - Session that observed the wall, deduplicating repeat counts.
     * @param obstruction - The wall vision saw in place of the page.
     * @param observation - Bounded prompt-safe description of the observed wall evidence.
     * @param result - Successful tool result augmented with the budget state in place.
     */
    private countWithheldPage(
        targetUrl: string,
        sessionId: string,
        obstruction: WithheldPageObstruction,
        observation: string,
        result: Record<string, unknown>,
    ): void {
        const report = WITHHELD_PAGE_REPORT[obstruction];
        const previous = this.technicalBrowserFailures.get(targetUrl);
        const alreadyCounted = this.withheldPageCountedSessions.has(sessionId);
        const attempts = Math.min(
            (previous?.attempts ?? 0) + (alreadyCounted ? 0 : 1),
            MAX_TECHNICAL_BROWSER_FAILURES_PER_TARGET,
        );
        const exhausted = attempts >= MAX_TECHNICAL_BROWSER_FAILURES_PER_TARGET;
        if (!alreadyCounted) {
            this.withheldPageCountedSessions.add(sessionId);
            this.technicalBrowserFailures.set(targetUrl, {
                attempts,
                fallbackReason: report.fallbackReason,
                detail:
                    `${report.wall} withheld the reported page: ${observation} ` +
                    `(${attempts}/${MAX_TECHNICAL_BROWSER_FAILURES_PER_TARGET} withheld sessions).`,
                launchSignal: null,
                failFastExhausted: false,
            });
            this.options.recorder.record(exhausted ? 'decision' : 'retry', {
                phase: exhausted ? 'technical_attempt_budget_exhausted' : 'withheld_page_observed',
                targetUrl: sanitizeNavigationTarget(targetUrl),
                obstruction,
                observation,
                attempts,
                maximumAttempts: MAX_TECHNICAL_BROWSER_FAILURES_PER_TARGET,
            });
        }
        result.withheldPage = {
            obstruction,
            observation,
            attempts,
            maximumAttempts: MAX_TECHNICAL_BROWSER_FAILURES_PER_TARGET,
            analysisOnlyAvailable: exhausted,
            guidance: exhausted
                ? `${report.wall} withheld the reported page in every bounded attempt and browser ` +
                  'access to this target is now exhausted. Finish with analysis_only: the reported ' +
                  'page is not verifiable from this runner, and the recorded evidence already ' +
                  'documents why.'
                : `${report.wall} stood in for the reported page. Keep the capture as evidence; ` +
                  `${report.nextSession}, and each such session spends one bounded technical ` +
                  'attempt.',
        };
    }

    /**
     * Judge one submitted terminal outcome against the evidence this run actually produced.
     *
     * @param outcome - Terminal decision submitted through finish_fix.
     * @returns Typed rejection returned to the model, or undefined when the outcome stands.
     */
    validateTerminalOutcome(outcome: FixOutcome): FinishFixValidationRejection | undefined {
        return judgeTerminalOutcome(outcome, this.terminalValidationView());
    }

    /**
     * Report the reporter-defined symptom state this run's terminal evidence establishes.
     *
     * @returns Symptom observation carried into the run result.
     */
    getTerminalSymptomObservation(): SymptomObservation {
        return terminalSymptomObservation(this.terminalValidationView());
    }

    /**
     * The checkout facts a draft's placement is checked against: the pinned checkout, the list
     * files the run's one placement-map walk found, and the run instruction's declared placements.
     *
     * Undefined only when that walk failed, and then the base registry's own walk of the same
     * checkout has already failed the run before any session could reach `finish_fix`; a test that
     * injects its own base registry is the one caller that gets this far without a checkout.
     *
     * @returns The placement context, or undefined without a walked checkout.
     */
    private placementContext(): CandidatePlacementContext | undefined {
        const map = this.listCatalog.placementMap;
        if (map === null) {
            return undefined;
        }
        return {
            checkoutPath: this.options.filtersPath,
            ownedListPaths: new Set(map.files.map((entry) => entry.relativePath)),
            ...(this.options.declaredPlacement === undefined
                ? {}
                : { declaredPlacement: this.options.declaredPlacement }),
        };
    }

    /**
     * Project this runtime onto the read-only view the terminal judgement reads.
     *
     * Built fresh per judgement, so every field is the value at the moment finish_fix was submitted
     * rather than a live handle the judgement could write through.
     *
     * @returns View bound to the current run state.
     */
    private terminalValidationView(): TerminalValidationView {
        return {
            issue: this.options.issue,
            issueAttachmentArtifactIds: this.options.issueAttachmentArtifactIds,
            allowedTargetUrls: this.targetUrls(),
            fetchedIssueNumber: this.fetchedIssueNumber,
            activeSessionId: this.activeSessionId,
            sessionStates: this.sessionStates,
            placementContext: this.placementContext(),
            cliEvidenceRoute: this.cliEvidenceRoute,
            environmentSelection: () => this.environmentHost.snapshot(),
            candidateValidationOutcome: (ledgerKey) =>
                this.candidateValidationOutcomes.get(ledgerKey),
            hasBrowserEvidence: () => this.hasBrowserEvidence(),
            hasExhaustedTechnicalBrowserFailure: () => this.hasExhaustedTechnicalBrowserFailure(),
            requiresCurrentReporterSettings: () => this.requiresCurrentReporterSettings(),
            isCurrentPreparedState: (state) => this.isCurrentPreparedState(state),
            isTerminalCurrentPreparedState: (state) => this.isTerminalCurrentPreparedState(state),
            remainingIssueScreenshotIndices: () => this.remainingIssueScreenshotIndices(),
            canRetryInconclusiveVisualReview: (ledgerKey) =>
                this.canRetryInconclusiveVisualReview(ledgerKey),
            getValidationEnvironment: (validationArtifactId) =>
                this.getValidationEnvironment(validationArtifactId),
            getVerifiedCandidateEnvironment: (validationArtifactId) =>
                this.getVerifiedCandidateEnvironment(validationArtifactId),
        };
    }

    /**
     * Return the currently active browser session for final diagnostic persistence.
     *
     * @returns Active session, or undefined after close_browser.
     */
    getActiveBrowserSession(): BrowserSession | undefined {
        return this.browserSession;
    }

    /**
     * Return the most recent browser launch/configuration error observed by the model.
     *
     * @returns Stable error kind and bounded detail, when launch_browser failed.
     */
    getLastBrowserError(): AgentBrowserError | undefined {
        return this.lastBrowserError ? { ...this.lastBrowserError } : undefined;
    }

    /**
     * Close the active isolated browser session.
     *
     * @returns Promise resolved after cleanup.
     */
    async dispose(): Promise<void> {
        if (this.browserSession) {
            await this.browserSession.close();
            this.browserSession = undefined;
        }
        this.activeSessionId = undefined;
        this.disableActiveBrowserTools();
    }

    /**
     * Remove every tool bound to the current browser session from the next model turn.
     *
     * Lifecycle and repository tools are persistent, so a failed session leaves the model only the
     * safe choices needed to close it, select a materially different environment, or finish.
     */
    private disableActiveBrowserTools(): void {
        for (const name of this.activeBrowserToolNames) {
            this.registry.unregister(name);
        }
        this.activeBrowserToolNames.clear();
    }

    /**
     * Resolve the most recently launched mutable environment record.
     *
     * @returns Latest runtime session state, when one exists.
     */
    private latestEnvironmentState(): AgentRuntimeSessionState | undefined {
        return this.latestSessionId ? this.sessionStates.get(this.latestSessionId) : undefined;
    }

    /**
     * Resolve the most recent prepared-extension session with browser-verified settings.
     *
     * @returns Mutable state retained under the exact session identity, when available.
     */
    private latestVerifiedSettingsState(): AgentRuntimeSessionState | undefined {
        const states = [...this.sessionStates.values()];
        for (let index = states.length - 1; index >= 0; index -= 1) {
            const state = states[index];
            if (this.isTerminalCurrentPreparedState(state)) {
                return state;
            }
        }
        return undefined;
    }

    /**
     * Determine whether one exact session owns a coherent prepared-extension settings proof.
     *
     * The proof is the host read-back taken by the launch route's Baseline application: after the
     * options-page driver's retirement no launch-time settings piece exists, and a session without
     * the read-back record was never verified against any settings request.
     *
     * @param state - Browser session state that may have produced candidate evidence.
     * @returns Whether extension, selected profile, and verified settings are session-bound.
     */
    private hasVerifiedPreparedSettings(state: AgentRuntimeSessionState): boolean {
        return (
            state.extensionMode === ExtensionMode.Prepared &&
            state.extension !== undefined &&
            state.selectedSettingsProfileKind !== undefined &&
            sessionBaselineCredited(state)
        );
    }

    /**
     * Determine whether one prepared session is bound to the run's current pinned build.
     *
     * The run carries exactly one host-prepared extension — the current pinned build by
     * construction — so a prepared session qualifies by owning a coherent verified-settings proof.
     *
     * @param state - Browser session state to classify.
     * @returns Whether the session is a prepared session with verified settings.
     */
    private isCurrentPreparedState(state: AgentRuntimeSessionState): boolean {
        return this.hasVerifiedPreparedSettings(state);
    }

    /**
     * Determine whether this run requires exact reporter settings at termination.
     *
     * @returns Whether trusted prompt-safe reporter text supplies a complete settings import URL
     *   and no launch has yet proven that its filter set cannot run within the MV3 limits.
     */
    private requiresCurrentReporterSettings(): boolean {
        return (
            reporterSettingsImportUrls(this.options.issue).size > 0 &&
            !this.reporterSettingsLimits.parityProvenImpossible()
        );
    }

    /**
     * The import-URL digest of one prepared session's `reported_on_current` settings request.
     *
     * The request profile is the surviving provenance of what the session's application steps were
     * asked to perform; the digest binds it to the trusted reporter URL terms in the issue text.
     *
     * @param state - Prepared browser session whose request profile is inspected.
     * @returns The canonical import digest, or undefined outside a parseable reporter request.
     */
    private reportedOnCurrentImportDigest(state: AgentRuntimeSessionState): string | undefined {
        const profile = state.settingsProfile;
        if (profile?.kind !== SettingsProfileKind.ReportedOnCurrent) {
            return undefined;
        }
        try {
            return parseImportExpectations(profile.importUrl).importUrlSha256;
        } catch (error) {
            createLogger({ verbose: this.options.verbose ?? false }).warn(
                { error: error instanceof Error ? error.message : String(error) },
                'the reported_on_current settings profile carries an unparseable import URL',
            );
            return undefined;
        }
    }

    /**
     * Determine whether one prepared extension session can support a terminal live decision.
     *
     * Controlled profiles remain useful diagnostics. When the reporter supplied an explicit
     * settings import, only a prepared session whose request profile is `reported_on_current` with
     * that same import provides reporter parity; without an import URL — or once a launch proved
     * the reporter's set exceeds the MV3 limits — every verified prepared session qualifies.
     *
     * @param state - Prepared browser session being considered for terminal evidence.
     * @returns Whether the prepared extension and required settings provenance are both verified.
     */
    private isTerminalCurrentPreparedState(state: AgentRuntimeSessionState): boolean {
        if (!this.isCurrentPreparedState(state)) {
            return false;
        }
        const expectedImportDigests = reporterSettingsImportUrls(this.options.issue);
        const requestImportDigest =
            state.selectedSettingsProfileKind === SettingsProfileKind.ReportedOnCurrent
                ? this.reportedOnCurrentImportDigest(state)
                : undefined;
        return (
            expectedImportDigests.size === 0 ||
            this.reporterSettingsLimits.parityProvenImpossible() ||
            (requestImportDigest !== undefined && expectedImportDigests.has(requestImportDigest))
        );
    }

    /**
     * Capture the browser lifecycle definitions and remove them from the initial tool surface.
     *
     * The run's extension is prepared host-side before the session, so there is no preparation
     * tool: `prepare_extension` does not exist on any surface of this runtime.
     */
    private captureAndHideExtensionLifecycleTools(): void {
        for (const name of ['launch_browser', 'close_browser']) {
            const definition = this.registry
                .getDefinitions()
                .find((candidate) => candidate.function.name === name);
            if (!definition) {
                throw new Error(`Missing Extension lifecycle definition: ${name}`);
            }
            this.extensionLifecycleDefinitions.set(name, definition);
            this.registry.unregister(name);
            this.baseToolNames.delete(name);
        }
    }

    /**
     * Reveal the existing browser lifecycle only after a ready Extension selection is locked.
     */
    private enableExtensionLifecycleTools(): void {
        if (this.registry.getToolNames().includes('launch_browser')) {
            return;
        }
        const launchDefinition = this.extensionLifecycleDefinitions.get('launch_browser');
        const closeDefinition = this.extensionLifecycleDefinitions.get('close_browser');
        if (!launchDefinition || !closeDefinition) {
            throw new Error('Extension lifecycle definitions are incomplete.');
        }
        this.registry.register({
            definition: launchDefinition,
            handler: async (args) =>
                await withToolDeadline(
                    'launch_browser',
                    (signal) => this.launchBrowser(args, signal),
                    BROWSER_LAUNCH_DEADLINE_MS,
                ),
        });
        this.registry.register({
            definition: closeDefinition,
            handler: async () =>
                await withToolDeadline(
                    'close_browser',
                    async () => {
                        await this.dispose();
                        return { closed: true };
                    },
                    BROWSER_TOOL_DEADLINE_MS,
                ),
        });
        for (const name of ['launch_browser', 'close_browser']) {
            this.baseToolNames.add(name);
        }
    }

    /**
     * Stop whatever the evidence route owns, on every terminal path.
     */
    async stopEvidenceRoute(): Promise<void> {
        await this.cliEvidenceRoute?.stop?.().catch((error: unknown) => {
            // Shutdown stays non-fatal, but a module that failed to stop is the first thing to
            // check when its logs or its process outlive the run.
            createLogger({ verbose: this.options.verbose ?? false }).warn(
                { err: error },
                'the evidence route did not stop cleanly',
            );
        });
    }

    /**
     * The run's host-state root: where a relative file-backed verification target resolves.
     *
     * @returns Absolute path of the run-owned directory, outside the repository checkout.
     */
    getHostStateRoot(): string {
        return this.hostStateRoot.path;
    }

    /**
     * Remove the run's host-state directory, on every terminal path.
     *
     * Separate from `dispose()`, which only closes the active browser session and runs again
     * whenever the model closes or relaunches one: removing the directory there would delete the
     * blocker state the very next phase reads back.
     */
    async releaseHostState(): Promise<void> {
        const server = this.loopbackTextServer;
        this.loopbackTextServer = undefined;
        if (server !== undefined) {
            try {
                await (await server).close();
            } catch (error) {
                createLogger({ verbose: this.options.verbose ?? false }).error(
                    { err: error },
                    'the loopback text server did not close cleanly',
                );
            }
        }
        this.hostStateRoot.dispose();
    }

    /**
     * The run's loopback text server, started on first use. A start that fails is forgotten, so the
     * next slice launch listens again instead of answering the same rejection for the whole run.
     *
     * @returns The listening server.
     */
    private textServer(): Promise<LoopbackTextServer> {
        if (this.loopbackTextServer === undefined) {
            const start = this.dependencies.createLoopbackTextServer ?? createLoopbackTextServer;
            const started: Promise<LoopbackTextServer> = start().catch((error: unknown) => {
                if (this.loopbackTextServer === started) {
                    this.loopbackTextServer = undefined;
                }
                throw error;
            });
            this.loopbackTextServer = started;
        }
        return this.loopbackTextServer;
    }

    /**
     * The run's line counter over the prepared Chromium build, or undefined when the run prepared
     * no such build: a Firefox-family build ships no unpacked list text.
     *
     * @returns The per-run counter.
     */
    private listLineCountOf(): ListLineCounter | undefined {
        const prepared = this.preparedExtension;
        if (prepared === undefined || prepared.launchFamily === ExtensionLaunchFamily.Firefox) {
            return undefined;
        }
        this.listLineCounter ??= createListLineCounter(
            prepared.extensionPath,
            createLogger({ verbose: this.options.verbose ?? false }),
        );
        return this.listLineCounter;
    }

    /**
     * Reveal the proxied evidence-browser lifecycle for an activated CLI selection.
     *
     * The extension preparation tool stays hidden: the CLI route launches CloakBrowser through the
     * filtering foreground proxy without any extension.
     */
    private enableCliEvidenceBrowserTools(): void {
        if (this.registry.getToolNames().includes('launch_browser')) {
            return;
        }
        const launchDefinition = this.extensionLifecycleDefinitions.get('launch_browser');
        const closeDefinition = this.extensionLifecycleDefinitions.get('close_browser');
        if (!launchDefinition || !closeDefinition) {
            throw new Error('CLI evidence browser definitions are incomplete.');
        }
        this.registry.register({
            definition: launchDefinition,
            handler: async (args) =>
                await withToolDeadline(
                    'launch_browser',
                    (signal) => this.launchBrowser(args, signal),
                    BROWSER_LAUNCH_DEADLINE_MS,
                ),
        });
        this.registry.register({
            definition: closeDefinition,
            handler: async () =>
                await withToolDeadline(
                    'close_browser',
                    async () => {
                        await this.dispose();
                        return { closed: true };
                    },
                    BROWSER_TOOL_DEADLINE_MS,
                ),
        });
        for (const name of ['launch_browser', 'close_browser']) {
            this.baseToolNames.add(name);
        }
    }

    /**
     * Project this runtime onto the seam the environment-selection tools act through.
     *
     * The runtime is itself the executors' runtime host: the evidence-route activation and the
     * extension lifecycle exposure executors drive are runtime methods.
     *
     * @returns Host bound to this runtime's selection state and its resolved executor set.
     */
    private environmentSelectionToolsHost(): EnvironmentSelectionToolsHost {
        return {
            environmentHost: this.environmentHost,
            executors: this.executors,
            markBaseTool: (name) => {
                this.baseToolNames.add(name);
            },
            activateEvidenceRoute: (route, reporterFilterIds) => {
                this.activateEvidenceRoute(route, reporterFilterIds);
            },
            enableExtensionLifecycleTools: () => {
                this.enableExtensionLifecycleTools();
            },
            activateExecutor: (registration) => this.activateExecutor(registration),
        };
    }

    /**
     * Adopt one executor's prepared evidence route for the run and expose its proxied browser
     * tools.
     *
     * @param route - Route whose pinned configuration is already prepared.
     * @param reporterFilterIds - Filter identifiers the activated selection asked to execute.
     */
    private activateEvidenceRoute(
        route: EvidenceRouteHost,
        reporterFilterIds: readonly number[],
    ): void {
        this.cliEvidenceRoute = route;
        this.activatedReporterFilterIds = reporterFilterIds;
        this.enableCliEvidenceBrowserTools();
    }

    /**
     * Project this runtime onto the seam the issue, extension, and browser lifecycle tools act
     * through.
     *
     * @returns Host bound to this runtime's registries, bookkeeping, and session lifecycle.
     */
    private runtimeLifecycleToolsHost(): RuntimeLifecycleToolsHost {
        return {
            issue: this.options.issue,
            issueAttachmentArtifactIds: this.options.issueAttachmentArtifactIds,
            baseRegistry: this.baseRegistry,
            launchBrowserAdvertisement: launchBrowserAdvertisement(this.preparedExtension),
            capabilities: () => this.environmentHost.capabilities(),
            markBaseTool: (name) => {
                this.baseToolNames.add(name);
            },
            dispatchBaseTool: async (name, args) => await this.dispatchBaseTool(name, args),
            recordFetchedIssue: () => {
                this.fetchedIssueNumber = this.options.issue.number;
            },
            recordGuidanceConsulted: () => {
                this.guidanceConsulted = true;
            },
            cachedReporterScreenshotResult: (artifactId) =>
                this.reporterScreenshotResults.get(artifactId),
            recordReporterScreenshotAnalysis: (artifactId, analysis, result) => {
                if (!this.analyzedIssueScreenshotArtifactIds.has(artifactId)) {
                    this.reporterScreenshotObservations.push(
                        analysis.slice(0, MAX_REPORTER_SCREENSHOT_OBSERVATION_LENGTH),
                    );
                }
                this.analyzedIssueScreenshotArtifactIds.add(artifactId);
                const cachedResult = { ...result };
                delete cachedResult.artifactId;
                this.reporterScreenshotResults.set(artifactId, cachedResult);
            },
            recordScreenshotAnalysis: (artifactId) => {
                this.recordScreenshotAnalysis(artifactId);
            },
            screenshotSessionId: (artifactId) => this.screenshotSessionIds.get(artifactId),
            sessionState: (sessionId) => this.sessionStates.get(sessionId),
            countWithheldPage: (targetUrl, sessionId, obstruction, observation, result) => {
                this.countWithheldPage(targetUrl, sessionId, obstruction, observation, result);
            },
            inspectLatestFullPageCapture: async (signal) =>
                await this.inspectLatestFullPageCapture(signal),
            launchBrowser: async (args, signal) => await this.launchBrowser(args, signal),
            dispose: async () => {
                await this.dispose();
            },
        };
    }

    /**
     * Inspect the latest active full-page capture with bounded structured vision batches.
     *
     * The provider-facing helper owns semantic inspection. This runtime only binds its result to
     * the active session and atomically credits exact artifacts from successful batches.
     *
     * @param signal - Cooperative cancellation from the vision tool deadline, threaded into every
     *   vision request of the batch.
     * @returns Compact model-facing coverage result or typed retry guidance.
     */
    private async inspectLatestFullPageCapture(
        signal?: AbortSignal,
    ): Promise<Record<string, unknown>> {
        const state = this.activeSessionId
            ? this.sessionStates.get(this.activeSessionId)
            : undefined;
        if (!state) {
            return {
                error: 'Launch a browser session before inspecting a full-page capture.',
                errorKind: 'browser_session_required',
                retryable: true,
                requiredAction: 'launch_browser',
                requiredTool: 'launch_browser',
            };
        }
        if (!state.navigationVerified) {
            return {
                error: 'Navigate the active browser session before inspecting a full-page capture.',
                errorKind: 'page_navigation_required',
                retryable: true,
                requiredAction: 'open_page',
                requiredTool: 'open_page',
            };
        }
        const remainingIssueScreenshotIndices = this.remainingIssueScreenshotIndices();
        if (remainingIssueScreenshotIndices.length > 0) {
            return {
                error: 'Analyze every user issue screenshot before inspecting the live full page.',
                errorKind: 'issue_screenshot_analysis_required',
                retryable: true,
                requiredAction: 'analyze_issue_screenshots',
                requiredTool: 'analyze_screenshot',
                remainingIssueScreenshotIndices,
            };
        }
        const capture = state.pageCaptures.at(-1);
        if (!capture) {
            return {
                error: 'Capture the active page with screenshot(captureTiles=true) before batch vision.',
                errorKind: 'full_page_capture_required',
                retryable: true,
                requiredAction: 'capture_complete_page',
                requiredTool: 'screenshot',
            };
        }
        if (!capture.coverageComplete || capture.requiredArtifactIds.length === 0) {
            const tileCoverage = capture.rawCapture.tileCoverage;
            const coverageError =
                typeof tileCoverage === 'object' &&
                tileCoverage !== null &&
                typeof (tileCoverage as Record<string, unknown>).error === 'string'
                    ? String((tileCoverage as Record<string, unknown>).error)
                    : undefined;
            return {
                error:
                    'The latest full-page tile capture is incomplete, so batch vision cannot ' +
                    'inspect it. ' +
                    (coverageError ? `Capture detail: ${coverageError} ` : '') +
                    'Do not recapture the same page state; continue the investigation with the ' +
                    'viewport screenshot, full-page overview, DOM, and network evidence instead.',
                errorKind: FULL_PAGE_CAPTURE_INCOMPLETE_KIND,
                retryable: false,
            };
        }

        let result;
        try {
            result = await inspectFullPageVisualCapture(
                {
                    recorder: this.options.recorder,
                    vision: this.options.vision,
                    reporterSymptom:
                        this.reporterSymptom() ??
                        [this.options.issue.title, this.options.issue.body]
                            .join('\n')
                            .slice(0, 2_000),
                    artifactsDir: this.options.artifactsDir,
                    ...(signal === undefined ? {} : { signal }),
                },
                capture.rawCapture,
            );
        } catch (error) {
            return {
                error:
                    'Full-page batch vision could not inspect the runner-owned capture: ' +
                    (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
                errorKind: 'full_page_vision_unavailable',
                retryable: true,
                requiredAction: 'retry_full_page_capture_inspection',
                requiredTool: 'inspect_full_page_capture',
                captureArtifactId: capture.captureArtifactId,
            };
        }

        for (const artifactId of result.inspectedArtifactIds) {
            state.analyzedArtifactIds.add(artifactId);
        }
        capture.reporterSymptomPresence = result.inventory.reporterSymptomPresence;
        capture.pageObstruction = result.inventory.pageObstruction;
        this.refreshFullVisionEvidence(state);
        const compactResult: Record<string, unknown> = {
            captureArtifactId: capture.captureArtifactId,
            coverageComplete: result.coverageComplete,
            inspectedArtifactIds: result.inspectedArtifactIds,
            missingArtifactIds: result.missingArtifactIds,
            symptomScopes: result.inventory.symptomScopes.slice(0, 8),
            reporterSymptomPresence: result.inventory.reporterSymptomPresence,
            pageObstruction: result.inventory.pageObstruction,
            instanceCount: result.inventory.instances.length,
            instances: result.inventory.instances.slice(0, 20),
            model: result.inventory.model,
            evidenceArtifactId: result.artifactId,
        };
        if (isWithheldPage(result.inventory.pageObstruction)) {
            this.countWithheldPage(
                state.targetUrl,
                state.sessionId,
                result.inventory.pageObstruction,
                `vision classified full-page capture ${capture.captureArtifactId} as ` +
                    result.inventory.pageObstruction,
                compactResult,
            );
        }
        if (!result.coverageComplete) {
            return {
                error:
                    'Vision did not conclusively inspect every image in the latest full-page ' +
                    'capture. Retry only the listed screenshot artifacts.',
                errorKind: 'full_page_vision_incomplete',
                retryable: true,
                requiredAction: 'analyze_missing_screenshot_artifacts',
                requiredTool: 'analyze_screenshot',
                ...compactResult,
                batchFailures: result.batchFailures.map((failure) => ({
                    artifactIds: failure.artifactIds,
                    reason: failure.reason,
                })),
            };
        }
        return compactResult;
    }

    /**
     * Dispatch a base tool through a preserved proxy registration.
     *
     * @param name - Base tool name.
     * @param args - Tool arguments.
     * @returns Base tool result.
     */
    private async dispatchBaseTool(
        name: string,
        args: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
        return await this.baseRegistry.dispatch(name, args);
    }

    /**
     * Return a fail-closed response when browser access to one target exhausted its global budget.
     *
     * @param targetUrl - Exact prompt-safe target selected for the browser session.
     * @returns Typed terminal guidance when exhausted, otherwise undefined.
     */
    private technicalBrowserBudgetExhaustion(
        targetUrl: string,
    ): Record<string, unknown> | undefined {
        const state = this.technicalBrowserFailures.get(targetUrl);
        if (
            !state ||
            (state.attempts < MAX_TECHNICAL_BROWSER_FAILURES_PER_TARGET && !state.failFastExhausted)
        ) {
            return undefined;
        }
        return {
            error:
                `This call was attempt ${state.attempts}/` +
                `${MAX_TECHNICAL_BROWSER_FAILURES_PER_TARGET} for ${targetUrl} and it failed. ` +
                'Browser access to this target is now exhausted; do not launch another ' +
                `profile or retry navigation. Last failure: ${state.detail}`,
            errorKind: 'technical_attempt_budget_exhausted',
            fallbackReason: state.fallbackReason,
            retryable: false,
            requiredAction: 'finish_fix_analysis_only',
            guidance:
                'Do not launch another profile or retry navigation for this target. Call ' +
                'finish_fix with outcome=analysis_only and report that browser access is unavailable.',
            technicalFailure: {
                logicalOperation: 'browser_access',
                targetUrl,
                attempt: state.attempts,
                maximumAttempts: MAX_TECHNICAL_BROWSER_FAILURES_PER_TARGET,
                exhausted: true,
            },
        };
    }

    /**
     * Explain the next materially different browser environment after a navigation failure.
     *
     * @param state - Exact failed session selected by the model.
     * @returns Bounded actionable guidance for the next reasoning turn.
     */
    private failedNavigationGuidance(state: AgentRuntimeSessionState): string {
        if (state.extensionMode === ExtensionMode.None) {
            const nonConvergent = this.nonConvergentFilterIds.get(state.targetUrl);
            const settingsGuidance = nonConvergent
                ? [
                      'The exact reporter settings import cannot converge on the prepared build',
                      `(unsupported filter IDs: ${nonConvergent.join(', ')}).`,
                      'Launch the prepared extension with settings.kind=agent_selected using only',
                      'catalog-supported reporter filter IDs and the reporter Stealth state.',
                  ].join(' ')
                : [
                      'Prefer the prepared extension with exact reporter settings: filter IDs,',
                      'Stealth state, and import URL extracted from fetch_issue.',
                  ].join(' ');
            return [
                'Do not call open_page again in this control session.',
                'Call close_browser, then launch a materially different fresh session.',
                settingsGuidance,
            ].join(' ');
        }
        return [
            'Do not call open_page again in this session.',
            'Call close_browser, then launch a materially different fresh reporter session only',
            'when issue evidence supports a different locale, consent strategy, profile, or settings.',
        ].join(' ');
    }

    /**
     * Retire a session after one technical navigation failure.
     *
     * The session stays alive until close_browser so lifecycle cleanup remains explicit, while all
     * browser-bound tools disappear from the next dynamic tool list and cannot consume the global
     * target budget again.
     *
     * @param state - Active session whose navigation failed.
     */
    private retireFailedNavigationSession(state: AgentRuntimeSessionState): void {
        state.technicalNavigationFailed = true;
        this.failedBrowserEnvironmentKeys.add(state.environmentKey);
        this.disableActiveBrowserTools();
    }

    /**
     * Count one browser launch or navigation failure against the target-wide technical budget.
     *
     * Profile, locale, consent, and extension changes deliberately do not participate in the key,
     * so they cannot reset or bypass the maximum.
     *
     * @param toolName - Browser lifecycle tool that observed the failure.
     * @param targetUrl - Exact prompt-safe target selected for the run.
     * @param fallbackReason - Typed browser or target-environment failure category.
     * @param detail - Bounded technical diagnostic returned by the browser boundary.
     * @param result - Original tool result retained for attempts below the maximum.
     * @param launchSignal - Fatal process signal when the browser died on launch, or null.
     * @returns Original typed failure augmented with budget state, or fail-closed terminal
     *   guidance.
     */
    private recordTechnicalBrowserFailure(
        toolName: BrowserLifecycleToolName,
        targetUrl: string,
        fallbackReason: BrowserFallbackReason,
        detail: string,
        result: Record<string, unknown>,
        launchSignal: string | null = null,
    ): Record<string, unknown> {
        const previous = this.technicalBrowserFailures.get(targetUrl);
        const attempts = Math.min(
            (previous?.attempts ?? 0) + 1,
            MAX_TECHNICAL_BROWSER_FAILURES_PER_TARGET,
        );
        // A launch that dies on the identical fatal signal twice is a deterministic crash of an
        // unchanged environment: the third attempt cannot succeed, so the budget is declared
        // exhausted immediately instead of burning the remaining attempt on the same crash.
        const failFast =
            toolName === 'launch_browser' &&
            launchSignal !== null &&
            previous?.launchSignal === launchSignal;
        const boundedDetail = detail.slice(0, 1_000);
        const networkErrorCode =
            typeof result.networkErrorCode === 'string'
                ? result.networkErrorCode
                : extractBrowserNetworkErrorCode(detail);
        let userFacingDetail =
            fallbackReason === BrowserFallbackReason.TargetUnreachable
                ? `Target unreachable from this runner: ${sanitizeNavigationTarget(targetUrl)} ` +
                  `(${networkErrorCode ?? 'network connection failed'} in ${attempts}/` +
                  `${MAX_TECHNICAL_BROWSER_FAILURES_PER_TARGET} browser profiles).`
                : boundedDetail;
        if (failFast) {
            userFacingDetail = (
                `Browser launch crashed again with the identical fatal signal (${launchSignal}); ` +
                'the unchanged environment cannot launch, so the remaining attempt is ' +
                `forfeited. Last failure: ${userFacingDetail}`
            ).slice(0, 1_000);
        }
        const state: TechnicalBrowserFailureState = {
            attempts,
            fallbackReason,
            detail: userFacingDetail,
            launchSignal: toolName === 'launch_browser' ? launchSignal : null,
            failFastExhausted: failFast,
        };
        this.technicalBrowserFailures.set(targetUrl, state);
        this.lastBrowserError = {
            kind: fallbackReason,
            detail: userFacingDetail,
            fallbackReason,
        };
        const exhausted = attempts >= MAX_TECHNICAL_BROWSER_FAILURES_PER_TARGET || failFast;
        this.options.recorder.record(exhausted ? 'decision' : 'retry', {
            phase: exhausted ? 'technical_attempt_budget_exhausted' : 'technical_browser_retry',
            logicalOperation: 'browser_access',
            tool: toolName,
            targetUrl,
            fallbackReason,
            attempt: attempts,
            maximumAttempts: MAX_TECHNICAL_BROWSER_FAILURES_PER_TARGET,
            ...(failFast ? { failFast: 'identical_launch_signal' } : {}),
        });
        if (exhausted) {
            return this.technicalBrowserBudgetExhaustion(targetUrl)!;
        }
        const activeState = this.activeSessionId
            ? this.sessionStates.get(this.activeSessionId)
            : undefined;
        const navigationGuidance =
            toolName === 'open_page' && activeState
                ? this.failedNavigationGuidance(activeState)
                : 'Retry browser access with a materially different safe environment.';
        return {
            ...result,
            errorKind:
                typeof result.errorKind === 'string'
                    ? result.errorKind
                    : 'browser_navigation_failed',
            retryable: true,
            requiredAction:
                toolName === 'open_page'
                    ? 'close_browser_then_launch_materially_different'
                    : 'retry_browser_access',
            guidance: navigationGuidance,
            technicalFailure: {
                logicalOperation: 'browser_access',
                targetUrl,
                attempt: attempts,
                maximumAttempts: MAX_TECHNICAL_BROWSER_FAILURES_PER_TARGET,
                exhausted: false,
            },
        };
    }

    /**
     * Count one deterministic extension-settings failure against its own per-target budget.
     *
     * Non-convergent settings never reach the site, so this failure class stays out of the
     * browser-access budget while still bounding repeated doomed attempts.
     *
     * @param targetUrl - Exact prompt-safe target selected for the browser session.
     * @param unsupportedFilterIds - Requested filter IDs absent from the build catalog.
     * @param detail - Bounded diagnostic when the failure is not a catalog mismatch.
     * @returns Typed retryable or terminal settings guidance for the model.
     */
    private recordExtensionConfigurationFailure(
        targetUrl: string,
        unsupportedFilterIds: readonly number[],
        detail?: string,
    ): Record<string, unknown> {
        const attempts = (this.extensionConfigurationFailures.get(targetUrl) ?? 0) + 1;
        this.extensionConfigurationFailures.set(targetUrl, attempts);
        if (unsupportedFilterIds.length > 0) {
            this.nonConvergentFilterIds.set(targetUrl, [...unsupportedFilterIds]);
        }
        const exhausted = attempts >= MAX_EXTENSION_CONFIGURATION_FAILURES_PER_TARGET;
        this.options.recorder.record(exhausted ? 'decision' : 'retry', {
            phase: exhausted
                ? 'extension_configuration_budget_exhausted'
                : 'extension_configuration_retry',
            logicalOperation: 'extension_configuration',
            targetUrl,
            attempt: attempts,
            maximumAttempts: MAX_EXTENSION_CONFIGURATION_FAILURES_PER_TARGET,
        });
        return {
            error:
                detail ??
                'The requested AdGuard settings cannot converge on the prepared build: ' +
                    `filter IDs [${unsupportedFilterIds.join(', ')}] are not listed in this ` +
                    "build's catalog.",
            errorKind: 'extension_settings_unsupported',
            unsupportedFilterIds: [...unsupportedFilterIds],
            retryable: !exhausted,
            requiredAction: exhausted
                ? 'launch_with_catalog_supported_settings'
                : 'adjust_settings_filter_ids',
            guidance: exhausted
                ? 'Reporter-exact settings repeatedly failed to converge on this build. Launch ' +
                  'with settings.kind=agent_selected using only catalog-supported reporter ' +
                  'filter IDs, or finish with analysis_only.'
                : 'Relaunch with settings.kind=agent_selected and filterIds limited to IDs ' +
                  "this build's catalog supports (drop the listed IDs), or decode the " +
                  'reporter import URL and remove the unsupported IDs.',
            configurationFailure: {
                targetUrl,
                attempt: attempts,
                maximumAttempts: MAX_EXTENSION_CONFIGURATION_FAILURES_PER_TARGET,
                exhausted,
            },
        };
    }

    /**
     * Reject settings that can never converge on the prepared build before any browser launch.
     *
     * The bundled on-disk catalog is a fail-fast optimization: when it is unavailable, the runtime
     * options-page check stays the authoritative gate and this check abstains.
     *
     * @param targetUrl - Exact prompt-safe target selected for the browser session.
     * @param settings - Model-selected extension settings profile.
     * @returns Typed settings rejection, or undefined when the request may proceed.
     */
    private async validateExtensionSettingsAgainstCatalog(
        targetUrl: string,
        settings: AdGuardExtensionSettingsProfile,
    ): Promise<Record<string, unknown> | undefined> {
        let requestedFilterIds: number[];
        try {
            requestedFilterIds = requestedSettingsFilterIds(settings);
        } catch (error) {
            return this.recordExtensionConfigurationFailure(
                targetUrl,
                [],
                `The supplied AdGuard settings cannot be parsed: ${(error as Error).message}`,
            );
        }
        if (requestedFilterIds.length === 0) {
            return undefined;
        }
        // The bundled catalog is a Chromium-build optimization source: a Firefox-family build ships
        // no unpacked directory to read it from, so the check simply does not apply there.
        const prepared = this.preparedExtension;
        const extensionPath =
            prepared !== undefined && prepared.launchFamily !== ExtensionLaunchFamily.Firefox
                ? prepared.extensionPath
                : undefined;
        if (!extensionPath) {
            return undefined;
        }
        const catalogIds = await readBundledFilterCatalogIds(extensionPath);
        if (!catalogIds) {
            return undefined;
        }
        const missingFilterIds = requestedFilterIds.filter((filterId) => !catalogIds.has(filterId));
        if (missingFilterIds.length === 0) {
            return undefined;
        }
        return this.recordExtensionConfigurationFailure(targetUrl, missingFilterIds);
    }

    /**
     * Launch a fresh browser and register its tools into the live registry.
     *
     * @param args - Raw launch_browser arguments.
     * @param signal - Deadline signal the launch threads into its Baseline application session.
     * @returns Verified launch/settings provenance or a typed retryable error.
     */
    private async launchBrowser(
        args: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<Record<string, unknown>> {
        if (requestsUnsupportedProxyRegion(args)) {
            return {
                error:
                    'Geographic proxy routing is unavailable. No proxy was attempted and network ' +
                    'egress did not change. Remove profile.proxyRegion; locale, timezone, and ' +
                    'geolocation affect only the browser context and do not change network egress.',
                errorKind: 'unsupported_browser_capability',
                retryable: true,
                requiredAction: 'remove_proxy_region_and_retry',
                unsupportedCapability: 'geographic_proxy',
                proxyAttempted: false,
                networkEgressChanged: false,
            };
        }
        const parsed = v.safeParse(
            launchBrowserRequestSchema(this.preparedExtension),
            normalizeLaunchBrowserArguments(args),
        );
        if (!parsed.success) {
            return {
                error: launchBrowserRefusal(this.preparedExtension, parsed.issues),
                errorKind: 'invalid_browser_request',
                retryable: true,
            };
        }
        const request = parsed.output;
        const targetUrl = bindAllowedTargetUrl(request.targetUrl, this.targetUrls());
        if (!targetUrl) {
            return {
                error: 'targetUrl must exactly match one of the prompt-safe URLs in fetch_issue.',
                errorKind: 'target_url_not_allowed',
                retryable: true,
            };
        }
        if (request.extension === 'prepared' && !this.preparedExtension) {
            return {
                error: 'No extension has been prepared for this run.',
                errorKind: 'extension_not_prepared',
                retryable: true,
            };
        }
        if (
            request.extension === 'prepared' &&
            request.settings?.kind === SettingsProfileKind.ReportedOnCurrent
        ) {
            const importUrlRefusal = reporterImportUrlRefusal(
                request.settings.importUrl,
                reporterSettingsImportUrls(this.options.issue),
            );
            if (importUrlRefusal) {
                return importUrlRefusal;
            }
        }
        const exhaustedBudget = this.technicalBrowserBudgetExhaustion(targetUrl);
        if (exhaustedBudget) {
            return exhaustedBudget;
        }
        const activeState = this.activeSessionId
            ? this.sessionStates.get(this.activeSessionId)
            : undefined;
        if (activeState?.technicalNavigationFailed) {
            return {
                error: 'Close the technically failed browser session before selecting another one.',
                errorKind: 'failed_browser_session_must_close',
                retryable: true,
                requiredAction: 'close_browser',
                guidance: this.failedNavigationGuidance(activeState),
            };
        }
        const environmentKey = browserEnvironmentKey(
            targetUrlMatchKey(targetUrl) ?? targetUrl,
            request.extension,
            request.extension === 'prepared'
                ? (this.preparedExtension?.extensionSourceSha256 ?? null)
                : null,
            request.profile,
            request.extension === 'prepared'
                ? (request.settings as AdGuardExtensionSettingsProfile)
                : undefined,
        );
        if (this.failedBrowserEnvironmentKeys.has(environmentKey)) {
            return {
                error: 'This exact browser environment already failed technical navigation.',
                errorKind: 'failed_browser_environment_reused',
                retryable: true,
                requiredAction: 'launch_materially_different_browser',
                guidance:
                    request.extension === 'none'
                        ? 'Launch the prepared extension with exact reporter settings instead of ' +
                          'repeating the failed unfiltered control.'
                        : 'Change only an issue-supported profile or settings dimension; do not ' +
                          'repeat the same failed environment.',
            };
        }
        // The fail-fast catalog gate covers only model-owned settings: the model can correct
        // IDs it selected itself. Reporter-owned profiles go to the runtime options-page check,
        // which degrades them onto the convergent subset with recorded conflicts instead of
        // rejecting the launch.
        if (
            request.settings !== undefined &&
            (request.settings.kind === SettingsProfileKind.AgentSelected ||
                request.settings.kind === SettingsProfileKind.DefaultsPlusRequired)
        ) {
            const settingsRejection = await this.validateExtensionSettingsAgainstCatalog(
                targetUrl,
                request.settings as AdGuardExtensionSettingsProfile,
            );
            if (settingsRejection) {
                return settingsRejection;
            }
        }
        // A slice is judged on the build alone, so a wrong range costs no browser launch.
        const sliceRejection = listSliceRefusal({
            settings: request.settings as AdGuardExtensionSettingsProfile | undefined,
            hostPerformed: hostPerformsApplication(this.options.instruction),
            lineCountOf: this.listLineCountOf(),
        });
        if (sliceRejection) {
            return sliceRejection;
        }
        await this.dispose();
        let createdSession: BrowserSession | undefined;
        try {
            const extension = request.extension === 'prepared' ? this.preparedExtension : undefined;
            const createSession = this.dependencies.createBrowserSession ?? BrowserSession.create;
            // The engine and the extension channel follow the prepared build's launch family, and
            // so does the user-agent family — a page filtered by uBO in Firefox must be served the
            // browser that is really running it.
            const launchChannel = extension
                ? preparedExtensionLaunchChannel(this.preparedSessionLaunchHost(), extension)
                : undefined;
            const reproProfile: ReproProfile = {
                ...request.profile,
                userAgentProfile: launchChannel?.userAgentProfile ?? CHROMIUM_USER_AGENT_PROFILE,
            };
            if (this.cliEvidenceRoute) {
                // The route-activated selection browses through its activated filtering
                // foreground proxy; the extension is never part of this environment.
                createdSession = await this.cliEvidenceRoute.launchEvidenceSession({
                    targetUrl,
                    reproProfile,
                    artifactsDir: this.options.artifactsDir,
                    headless: this.options.headless,
                    noSandbox: this.options.noSandbox,
                    logger: createLogger({ verbose: this.options.verbose ?? false }),
                });
                recordEvidenceRouteFilterFidelity(
                    this.environmentHost,
                    this.cliEvidenceRoute.snapshot(),
                );
                // Granted only now: the session exists, so the foreground started and the probe
                // accepted this run's authority. Before that the environment has installation and
                // activation only, exactly as its descriptor advertises. The route exists only
                // for the lock that activated it, so the grant names the locked selection.
                const lockedKind = this.environmentHost.snapshot()?.selectedKind;
                if (
                    !lockedKind ||
                    lockedKind === EnvironmentSelectionReservedCase.UnsupportedProductCase
                ) {
                    throw new Error(
                        'An evidence route exists without a locked executor selection; ' +
                            'the runtime wiring is inconsistent.',
                    );
                }
                this.environmentHost.attachCliEvidenceRouteReady(lockedKind);
            } else {
                const config: BrowserSessionConfig = {
                    engine: launchChannel?.engine ?? new CloakBrowserEngine(),
                    logger: createLogger({ verbose: this.options.verbose ?? false }),
                    reproProfile,
                    artifactsDir: this.options.artifactsDir,
                    headless: this.options.headless,
                    noSandbox: this.options.noSandbox,
                    // A plain extension launch: no settings or user-rule pieces — the launch
                    // route's Baseline application plus the host read-back produce the session's
                    // settings proof after creation. The channel carries exactly one family's
                    // fields, so the session never sees a mixed configuration.
                    ...(launchChannel === undefined ? {} : launchChannel.extensionChannel),
                };
                createdSession = await createSession(config);
            }
            const sessionId = randomUUID();
            const sessionState: AgentRuntimeSessionState = {
                sessionId,
                targetUrl,
                extensionMode: request.extension,
                profile: reproProfile,
                ...(extension && this.preparedExtension
                    ? { extension: this.preparedExtension }
                    : {}),
                navigationVerified: false,
                fullVisionVerified: false,
                environmentKey,
                technicalNavigationFailed: false,
                pageCaptures: [],
                analyzedArtifactIds: new Set<string>(),
            };
            if (request.extension === 'prepared') {
                // A declared-baseline run selects nothing: it records the blocker's own declared
                // defaults, which is exactly what its browser applied at startup.
                const settings = (request.settings ??
                    DECLARED_BASELINE_SETTINGS_PROFILE) as AdGuardExtensionSettingsProfile;
                sessionState.selectedSettingsProfileKind = settings.kind;
                sessionState.settingsProfile = structuredClone(settings);
            }
            // Reset per session: a materially different environment gets its own budget, while a
            // single session cannot keep re-deriving the page by hand.
            this.browserToolBudgets.reset();
            this.browserSession = createdSession;
            this.activeSessionId = sessionId;
            this.latestSessionId = sessionId;
            this.sessionStates.set(sessionId, sessionState);
            // Opened before the Baseline application: the extension reports the declarative rules
            // Chrome fires only when its log is open while that application configures its engine.
            const appliedRules = recordingUnfilteredHosts(
                await openSessionAppliedRulesLog({
                    session: createdSession,
                    evidenceRoute: this.cliEvidenceRoute,
                    extension,
                    builtInAdGuardRoute: hostPerformsApplication(this.options.instruction),
                    logger: createLogger({ verbose: this.options.verbose ?? false }),
                }),
                (hosts) =>
                    recordUnfilteredHostsFidelity(
                        this.environmentHost,
                        hosts,
                        createLogger({ verbose: this.options.verbose ?? false }),
                    ),
            );
            // The Baseline application runs after session creation and before any phase gate: the
            // instruction's steps plus the host read-back are the one settings proof left after the
            // options-page driver's retirement, and settingsVerified is gated on their record.
            const baselineOutcome =
                request.extension === 'prepared' && extension && !this.cliEvidenceRoute
                    ? await launchExtensionBaseline(
                          this.phaseApplicationFlowHost(),
                          sessionState,
                          createdSession,
                          targetUrl,
                          request.settings as AdGuardExtensionSettingsProfile | undefined,
                          (conflicts) =>
                              recordExtensionFilterFidelity(this.environmentHost, conflicts),
                          signal,
                      )
                    : undefined;
            this.reporterSettingsLimits.recordLaunchOutcome(
                sessionState.settingsProfile,
                baselineOutcome,
            );
            const browserRegistry = await this.createSessionBrowserRegistry(
                createdSession,
                targetUrl,
                reproProfile.consentStrategy,
                appliedRules,
            );
            // A launch that timed out already answered the model with its deadline result: its late
            // settle must neither publish a read-back nor merge tools for a session the model was
            // told had failed. The same holds for a settle a newer launch has superseded: the
            // discarded session is closed here, and only its own identity may clear its references.
            if (signal?.aborted || this.activeSessionId !== sessionId) {
                await Promise.resolve(createdSession.close()).catch((closeError) => {
                    createLogger({ verbose: this.options.verbose ?? false }).error(
                        { err: closeError, sessionId },
                        'the discarded launch session could not be closed',
                    );
                });
                if (this.activeSessionId === sessionId) {
                    this.browserSession = undefined;
                    this.activeSessionId = undefined;
                }
                return {
                    launched: false,
                    sessionId,
                    targetUrl,
                    profile: reproProfile,
                    settingsVerified: false,
                    ...launchBaselineSettingsFields(baselineOutcome),
                };
            }
            if (baselineOutcome?.kind === LaunchBaselineOutcomeKind.Verified) {
                sessionState.extensionBaselineReadBack = baselineOutcome.readBack;
                if (baselineOutcome.listSlice !== undefined) {
                    sessionState.listSlice = baselineOutcome.listSlice;
                }
                if (extension) {
                    this.latestVerifiedSettingsSessionId = sessionId;
                }
            } else if (baselineOutcome?.kind === LaunchBaselineOutcomeKind.Declared) {
                // A blocker that declares its own list selection is credited from that declaration;
                // there is no live state to read back, so the session carries the declared keys
                // instead of a read-back record.
                sessionState.declaredBaselineListKeys = baselineOutcome.listKeys;
                if (extension) {
                    this.latestVerifiedSettingsSessionId = sessionId;
                }
            }
            this.mergeBrowserTools(browserRegistry);
            return {
                launched: true,
                sessionId,
                targetUrl,
                profile: reproProfile,
                extensionSource: extension?.source ?? null,
                extensionTag: extension?.extensionSourceTag ?? null,
                extensionSourceSha256: extension?.extensionSourceSha256 ?? null,
                settingsVerified:
                    request.extension === 'none' ||
                    baselineOutcome?.kind === LaunchBaselineOutcomeKind.Verified ||
                    baselineOutcome?.kind === LaunchBaselineOutcomeKind.Declared,
                settingsEvidence: null,
                ...launchBaselineSettingsFields(baselineOutcome),
                ...launchListFields(sessionState, this.listLineCountOf()),
                availableBrowserTools: browserRegistry
                    .getToolNames()
                    .filter((name) => !this.baseToolNames.has(name)),
            };
        } catch (error) {
            await Promise.resolve(createdSession?.close()).catch(() => undefined);
            this.browserSession = undefined;
            this.activeSessionId = undefined;
            const errorKind =
                error instanceof BrowserConfigurationError
                    ? 'extension_settings_failed'
                    : 'browser_launch_failed';
            const fallbackReason: BrowserFallbackReason =
                error instanceof BrowserConfigurationError
                    ? BrowserFallbackReason.ExtensionConfigurationFailed
                    : BrowserFallbackReason.LaunchFailed;
            return this.recordTechnicalBrowserFailure(
                'launch_browser',
                targetUrl,
                fallbackReason,
                (error as Error).message,
                {
                    error: (error as Error).message,
                    errorKind,
                    fallbackReason,
                },
                extractBrowserLaunchSignal(error),
            );
        }
    }

    /**
     * Create the browser-bound tools of one launched session: the injected test registry, or the
     * production registry bound to the session's applied-rules log.
     *
     * @param session - The launched session.
     * @param targetUrl - Exact prompt-safe URL selected for this session.
     * @param consentStrategy - Trusted bounded consent interaction selected for the session.
     * @param appliedRules - The session's applied-rules log; absent when its engine cannot report.
     * @returns Registry containing browser and candidate validation tools.
     */
    private async createSessionBrowserRegistry(
        session: BrowserSession,
        targetUrl: string,
        consentStrategy: ReproProfile['consentStrategy'],
        appliedRules: AppliedRulesLog | undefined,
    ): Promise<ToolRegistry> {
        const context: AgentRuntimeBrowserContext = {
            session,
            recorder: this.options.recorder,
            reporterSymptom: () => this.reporterSymptom(),
            openPageRetries: AGENT_RUNTIME_OPEN_PAGE_RETRIES,
            consentStrategy,
        };
        if (this.dependencies.createBrowserRegistry) {
            return await this.dependencies.createBrowserRegistry(context);
        }
        return await createProductionBrowserRegistry({
            ...context,
            targetUrl,
            issue: this.options.issue,
            filtersPath: this.options.filtersPath,
            placementMap: this.listCatalog.placementMap ?? undefined,
            artifactsDir: this.options.artifactsDir,
            vision: this.options.vision,
            appliedRules,
        });
    }

    /**
     * Create one adapter-owned browser session in the exact requested filtering state.
     *
     * The session's persistent context, when it carries the prepared extension, is registered for
     * the between-phases configuration seam: the application's host read-back reads the blocker
     * state over exactly that session's own context.
     *
     * @param state - Prepared active session supplying immutable profile and settings inputs.
     * @param request - Adapter-owned A/B/C session request.
     * @returns The created lease session.
     */
    private async createFilteringPhaseSession(
        state: AgentRuntimeSessionState,
        request: BrowserExtensionSessionRequest,
    ): Promise<BrowserExtensionCreatedSession> {
        if (!state.settingsProfile || !state.extension) {
            throw new Error('Prepared Extension state is incomplete.');
        }
        const createSession = this.dependencies.createBrowserSession ?? BrowserSession.create;
        const config = preparedPhaseSessionConfig(this.preparedSessionLaunchHost(), {
            extension: state.extension,
            phase: request.phase,
            extensionRoot: request.extensionRoot,
            reproProfile: state.profile,
            readinessBudgetMs:
                this.options.phaseReadinessBudgetMs ?? DEFAULT_PHASE_READINESS_BUDGET_MS,
        });
        // The owning experiment is captured before the await: a bootstrap abandoned by the tool
        // deadline can settle minutes later, and its late record must never masquerade as
        // evidence for whatever experiment is current by then.
        const experimentOrdinal = this.filteringEnvironmentExperimentExecutionOrdinal;
        const bootstrapStartedAt = Date.now();
        let session: BrowserSession;
        try {
            session = await createSession(config);
        } catch (error) {
            this.recordPhaseBootstrapFailure(
                request.phase,
                error,
                bootstrapStartedAt,
                experimentOrdinal,
            );
            throw error;
        }
        recordPreflightDiagnostic('browser', {
            note: 'phase_bootstrap_ready',
            phase: request.phase,
            bootstrapMs: Date.now() - bootstrapStartedAt,
            readinessBudgetMs: config.extensionReadinessBudgetMs ?? null,
        });
        if (session.extensionContext) {
            this.applicationReadContexts.set(session, session.extensionContext);
        }
        return { session };
    }

    /**
     * Build the runtime seam the between-phases application flow acts through.
     *
     * The flow (`phase-application-flow.ts`, `phase-application-launch.ts`) carries no reference to
     * this class; every leaf option and dependency override it needs travels through this narrow
     * host object instead, built fresh for each call so it always reflects the run's current
     * options and dependency overrides.
     *
     * @returns The host object the moved application flow's free functions take.
     */
    private phaseApplicationFlowHost(): PhaseApplicationFlowHost {
        return {
            hostStateRoot: this.hostStateRoot.path,
            applicationReadContexts: this.applicationReadContexts,
            llm: this.options.llm,
            piRuntime: this.options.piRuntime,
            recorder: this.options.recorder,
            usageCollector: this.options.usageCollector,
            verbose: this.options.verbose ?? false,
            instruction: this.options.instruction,
            phaseReadinessBudgetMs: this.options.phaseReadinessBudgetMs,
            relaunchPolicySession: (request) =>
                relaunchPolicySession(this.preparedSessionLaunchHost(), request),
            createPhaseApplicationModelRunner: this.dependencies.createPhaseApplicationModelRunner,
            findExtensionRuntime: this.dependencies.findExtensionRuntime,
            readAdGuardExtensionState: this.dependencies.readAdGuardExtensionState,
            listSlice: {
                textServer: () => this.textServer(),
                allowUserScripts: this.dependencies.allowUserScripts ?? allowUserScriptsDefault,
            },
        };
    }

    /**
     * Build the leaf launch options every prepared-extension session launch acts through.
     *
     * Built fresh per call, like the application flow's own host object, so it always reflects the
     * run's current options and dependency overrides.
     *
     * @returns The launch host the prepared-session launch functions take.
     */
    private preparedSessionLaunchHost(): PreparedSessionLaunchHost {
        return {
            instruction: this.options.instruction,
            hostStateRoot: this.hostStateRoot.path,
            artifactsDir: this.options.artifactsDir,
            headless: this.options.headless,
            noSandbox: this.options.noSandbox,
            verbose: this.options.verbose ?? false,
            createBrowserSession: this.dependencies.createBrowserSession,
        };
    }

    /**
     * The between-phases configuration option the browser-extension adapter calls back into.
     *
     * The application procedure owns the whole flow (bounded model steps over the lease, then the
     * host read-back); this closure only wires the run's inputs — the instruction content, the goal
     * derived from the phase, the lease session's context for the extension-state reader, and the
     * shared model-session runner.
     *
     * @param state - Prepared active session whose settings and caught context the application
     *   uses.
     * @returns The EnvironmentAdapter configuration seam implementation.
     */
    private phaseConfigurationFor(
        state: AgentRuntimeSessionState,
    ): NonNullable<BrowserExtensionEnvironmentOptions['phaseConfiguration']> {
        return async (session, request): Promise<EnvironmentPhaseConfigurationResult> => {
            const goal =
                request.phase === PhaseLabel.C && request.candidateRule !== null
                    ? ({
                          kind: ApplicationGoalKind.Candidate,
                          rule: request.candidateRule,
                      } as const)
                    : ({ kind: ApplicationGoalKind.Baseline } as const);
            return (
                await runApplication(this.phaseApplicationFlowHost(), state, request, goal, session)
            ).result;
        };
    }

    /**
     * The browser-observed settings the adapter locks and rechecks its baseline with.
     *
     * The host read-back taken at launch is the source of truth.
     *
     * @param state - Active prepared Extension session with its read-back record.
     * @returns The observed filter identity sets.
     * @throws When the session never recorded a launch read-back.
     */
    private extensionBaselineSettingsFor(
        state: AgentRuntimeSessionState,
    ): ExtensionBaselineSettings {
        if (state.extensionBaselineReadBack) {
            return extensionBaselineSettingsFromStateRead(state.extensionBaselineReadBack);
        }
        throw new Error(
            'A verified prepared Extension session requires the launch read-back record.',
        );
    }

    /**
     * Classify and record one failed phase-session bootstrap.
     *
     * Only infrastructure-shaped failures are recorded: browser launch faults and settings-apply
     * configuration faults. Everything else keeps the capability-limited classification.
     *
     * @param phase - Phase whose session failed to open.
     * @param error - Error thrown by the phase-session factory.
     * @param startedAt - Bootstrap start timestamp for elapsed diagnostics.
     * @param experimentOrdinal - Experiment that owned the attempt when it started.
     */
    private recordPhaseBootstrapFailure(
        phase: string,
        error: unknown,
        startedAt: number,
        experimentOrdinal: number,
    ): void {
        const stale = experimentOrdinal !== this.filteringEnvironmentExperimentExecutionOrdinal;
        const infrastructureShaped =
            error instanceof BrowserLaunchError ||
            (error instanceof BrowserConfigurationError &&
                error.reason === SettingsFailureReason.SettingsApplyFailed);
        recordPreflightDiagnostic('browser', {
            note: 'phase_bootstrap_failed',
            phase,
            bootstrapMs: Date.now() - startedAt,
            infrastructureShaped,
            stale,
            error: describeDiagnosticError(error),
        });
        // A settlement from an abandoned attempt is diagnostics-only: classification state
        // belongs to the experiment that is current now, not to the one the deadline killed.
        if (stale) {
            return;
        }
        if (!infrastructureShaped) {
            this.phaseBootstrapFailure = null;
            return;
        }
        const named = error as BrowserLaunchError | BrowserConfigurationError;
        const signature =
            named instanceof BrowserConfigurationError
                ? `${named.name}:${named.reason}`
                : named.name;
        const previous = this.phaseBootstrapFailure;
        this.phaseBootstrapFailure = {
            signature,
            consecutiveFailures:
                previous?.signature === signature ? previous.consecutiveFailures + 1 : 1,
            detail: named.message,
            experimentOrdinal,
        };
    }

    /**
     * Report the recorded phase-bootstrap infrastructure failure of the current streak.
     *
     * @returns Typed failure facts, or undefined when the last completed experiment got past
     *   session bootstrap or failed for a non-infrastructure reason.
     */
    getPhaseBootstrapInfrastructureFailure(): PhaseBootstrapInfrastructureFailure | undefined {
        if (!this.phaseBootstrapFailure) {
            return undefined;
        }
        const { signature, consecutiveFailures, detail } = this.phaseBootstrapFailure;
        return { signature, consecutiveFailures, detail };
    }

    /**
     * Record one adapter limitation in the immutable environment-selection audit.
     *
     * @param limitation - Stable common adapter limitation.
     */
    private recordFilteringEnvironmentLimitation(limitation: EnvironmentAdapterLimitation): void {
        let capability:
            | typeof EnvironmentCapability.BaselineIntegrity
            | typeof EnvironmentCapability.CandidateApplication
            | typeof EnvironmentCapability.PhaseProof = EnvironmentCapability.PhaseProof;
        if (
            limitation.stage === EnvironmentLimitationStage.Baseline ||
            limitation.stage === EnvironmentLimitationStage.Preparation
        ) {
            capability = EnvironmentCapability.BaselineIntegrity;
        } else if (limitation.stage === EnvironmentLimitationStage.Candidate) {
            capability = EnvironmentCapability.CandidateApplication;
        }
        // Named from the lock rather than hardcoded: the same common adapter limitations now
        // arrive from every executor's environment, and the host refuses a limit that names a
        // different environment than the one actually locked. The reserved case locks no
        // executor, so a lock it owns never becomes a target.
        const kind = this.environmentHost.snapshot()?.selectedKind;
        if (
            !kind ||
            kind === EnvironmentSelectionReservedCase.UnsupportedProductCase ||
            !this.executors.some((executor) => executor.name === kind)
        ) {
            return;
        }
        this.environmentHost.recordCapabilityLimitation(kind, {
            code: EnvironmentLimitationCode.EnvironmentPreparationFailed,
            capability,
            detail: limitation.detail,
        });
    }

    /**
     * Lazily create, prepare, and register the locked executor's common filtering environment.
     *
     * One path for every executor: the adapter comes from the locked registration's
     * `createAdapter`, and the requested lists are the run's executing ids converged onto the
     * AdGuard catalog — the browser-verified extension settings for an extension-executing run, the
     * activated selection's reported ids otherwise.
     *
     * An adapter whose constructor refuses the run's session shape answers with the proof-integrity
     * limitation, so no executor receives a request the runtime cannot build.
     *
     * A failed `prepare` is recorded as the environment's capability limit in every case: the run
     * still completes analysis-only with its collected route evidence, while the retained result
     * names the exact failure instead of implying a ready environment.
     *
     * @param state - Active session supplying the run's executing inputs.
     * @returns Null when ready, otherwise the stable preparation limitation.
     */
    private async ensureFilteringEnvironment(
        state: AgentRuntimeSessionState,
    ): Promise<EnvironmentAdapterLimitation | null> {
        // This runs both eagerly after activation and lazily from the candidate path, so it must
        // be idempotent. Building a second adapter re-binds the actual execution context, which
        // the environment host refuses — a run would reach apply_rule and lose it to exactly
        // that, after the whole investigation had already been paid for.
        if (this.filteringEnvironmentAdapter && this.filteringEnvironmentRecorder) {
            return this.filteringEnvironmentDisposition?.failure ?? null;
        }
        const incompleteProofLimitation: EnvironmentAdapterLimitation = {
            code: EnvironmentAdapterLimitationCode.BaselineIntegrityUnavailable,
            stage: EnvironmentLimitationStage.Preparation,
            detail: 'The locked environment lacks complete preparation proof.',
        };
        // A blocker that declares its own list selection resolves nothing against AdGuard's
        // catalog: the declaration is the run's executable baseline and the environment requests
        // no official list at all.
        const firefoxLaunch = firefoxPreparedLaunch(state.extension);
        // A launched blocker's read-back is a fact the adapter replays whole; only ids the reporter
        // merely had enabled converge onto the AdGuard catalog, with the rest recorded as the
        // run's filter-selection approximation. `executorRequestedLists` owns that distinction.
        const convergence = executorRequestedLists({
            observedFilterIds: firefoxLaunch
                ? []
                : state.extensionBaselineReadBack?.optionsEnabledFilterIds,
            reportedFilterIds: this.activatedReporterFilterIds,
            environmentHost: this.environmentHost,
            verbose: this.options.verbose ?? false,
        });
        if (convergence.limitation) {
            this.filteringEnvironmentDisposition = {
                status: 'capability_limited',
                candidateDigest: null,
                failure: convergence.limitation,
            };
            this.recordFilteringEnvironmentLimitation(convergence.limitation);
            return convergence.limitation;
        }
        const registration = this.lockedExecutorRegistration();
        if (!registration) {
            // Every candidate path passes through a locked executor selection, so a lock without
            // a registration is an inconsistent runtime; fail closed instead of constructing
            // through nothing.
            const limitation: EnvironmentAdapterLimitation = {
                code: EnvironmentAdapterLimitationCode.BaselineIntegrityUnavailable,
                stage: EnvironmentLimitationStage.Preparation,
                detail: 'The locked environment names no registered executor.',
            };
            this.filteringEnvironmentDisposition = {
                status: 'capability_limited',
                candidateDigest: null,
                failure: limitation,
            };
            this.recordFilteringEnvironmentLimitation(limitation);
            return limitation;
        }
        let extensionOptions: BrowserExtensionEnvironmentOptions | undefined;
        let firefoxExtensionOptions: FirefoxExtensionEnvironmentOptions | undefined;
        try {
            const environmentCallbacks = {
                extensionBaselineSettingsFor: () => this.extensionBaselineSettingsFor(state),
                createSession: async (request: BrowserExtensionSessionRequest) =>
                    await this.createFilteringPhaseSession(state, request),
                phaseConfiguration: this.phaseConfigurationFor(state),
            };
            if (firefoxLaunch) {
                firefoxExtensionOptions = buildFirefoxExtensionEnvironmentOptions(
                    this.options.instruction,
                    state,
                    environmentCallbacks,
                );
            } else {
                extensionOptions = buildBrowserExtensionEnvironmentOptions(
                    this.options.instruction,
                    state,
                    environmentCallbacks,
                );
            }
        } catch (error) {
            // The verified-extension inputs are executor-bound: executors that ignore them see
            // the construction failure, and the adapter's own refusal below turns it into the
            // typed proof-integrity limitation.
            createLogger({ verbose: this.options.verbose ?? false }).debug(
                {
                    error: describeDiagnosticError(error),
                    executor: registration.name,
                },
                'browser-extension adapter inputs unavailable for this session',
            );
        }
        let adapter: FilteringEnvironmentAdapter;
        try {
            adapter = registration.createAdapter({
                requestedLists: convergence.lists,
                extensionOptions,
                firefoxExtensionOptions,
                evidenceRoute: this.cliEvidenceRoute,
                launchEvidenceSession: (request) => this.launchExecutorEvidenceSession(request),
            });
        } catch (error) {
            createLogger({ verbose: this.options.verbose ?? false }).warn(
                {
                    error: describeDiagnosticError(error),
                    executor: registration.name,
                },
                'filtering environment adapter refused construction',
            );
            this.recordFilteringEnvironmentLimitation(incompleteProofLimitation);
            return incompleteProofLimitation;
        }
        const recorder = new environmentExecution.FilteringEnvironmentExecutionRecorder(
            this.options.recorder.toJSON().runId,
            this.environmentHost,
        );
        const prepared = await adapter.prepare({ requestedLists: convergence.lists });
        recorder.registerAdapter(adapter.snapshot());
        this.filteringEnvironmentAdapter = adapter;
        this.filteringEnvironmentRecorder = recorder;
        if (!prepared.ready) {
            this.filteringEnvironmentDisposition = {
                status: 'capability_limited',
                candidateDigest: null,
                failure: prepared.limitation,
            };
            this.recordFilteringEnvironmentLimitation(prepared.limitation);
            return prepared.limitation;
        }
        this.filteringEnvironmentDisposition = {
            status: 'inconclusive',
            candidateDigest: null,
            failure: null,
        };
        return null;
    }

    /**
     * Reproduction profile used by CLI evidence phase sessions.
     *
     * @returns Profile of the latest session, or the reporter-neutral default.
     */
    private cliEvidenceProfile(): ReproProfile {
        const latest = this.latestSessionId
            ? this.sessionStates.get(this.latestSessionId)
            : undefined;
        return (
            latest?.profile ?? {
                viewport: Viewport.Desktop,
                locale: 'en-US',
                timezone: 'UTC',
                userAgentProfile: 'Chromium',
                consentStrategy: ConsentStrategy.Untouched,
            }
        );
    }

    /**
     * Execute one candidate through the selected common Extension environment.
     *
     * @param candidate - Normalized candidate and semantic attempt identity.
     * @param args - Original apply_rule arguments containing an optional network selector.
     * @param signal - Cooperative cancellation from the apply_rule tool deadline.
     * @returns Existing apply_rule response or a typed common limitation.
     */
    private async runCommonExtensionCandidate(
        candidate: PendingCandidateAttempt,
        args: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<Record<string, unknown>> {
        // Verification entry refusal: parse the run instruction's application contract before
        // anything can open. A run whose instruction cannot describe how to apply and verify a rule
        // is refused here with the gap recorded to run evidence — the phases are never opened and
        // no application method is ever invented.
        const instructionContract = parseRuleApplication(
            applicationInstructionContent(this.options.instruction),
        );
        if ('gap' in instructionContract) {
            createLogger({ verbose: this.options.verbose ?? false }).warn(
                {
                    gap: instructionContract.gap,
                    detail: instructionContract.detail,
                },
                'verification refused: the run instruction describes no rule application',
            );
            this.options.recorder.record(TraceEventType.Decision, {
                phase: 'instruction_application_refused',
                gap: instructionContract.gap,
                detail: instructionContract.detail,
            });
            return {
                validationSkipped: true,
                error:
                    'The run instruction does not describe how to apply a rule: ' +
                    instructionContract.detail,
                errorKind: 'instruction_application_gap',
                gap: instructionContract.gap,
                retryable: false,
                requiredAction: 'finish_fix_analysis_only',
            };
        }
        const interactionPlan = candidate.revealPlan;
        // baselineSymptomAbsentCounts (written below, where an experiment concludes
        // baseline_symptom_absent) records a verdict per candidate ledger key and already asks
        // the model to stop after the second one via retryable: false. A model can ignore that
        // ask and rerun phases A and B a third time for the byte-identical candidate rule, paying
        // for two more full-page-vision browser phases (~40 images) a controlled experiment
        // cannot possibly settle: the baseline has already twice shown, cleanly, that the symptom
        // description names nothing the candidate can be judged against. This refusal makes the
        // stop hard instead of advisory, before any phase can open. A different candidate rule
        // keys separately and still gets its own two experiments.
        // Different reveal steps put the page into a different state, so they earn the candidate
        // its own two experiments; the same steps again cannot change the verdict.
        const exhaustedLedgerKey = symptomAbsenceLedgerKey(
            candidateLedgerKey(candidate.operation, candidate.normalized.canonical),
            interactionPlan,
        );
        if ((this.baselineSymptomAbsentCounts.get(exhaustedLedgerKey) ?? 0) >= 2) {
            return {
                validationSkipped: true,
                errorKind: 'baseline_symptom_absent_exhausted',
                retryable: false,
                requiredAction: 'finish_fix_analysis_only',
                guidance: [
                    'The baseline never showed the described symptom in two controlled',
                    'experiments for this exact candidate rule. A third identical experiment',
                    'cannot succeed and will not be run.',
                    'Finish with an analysis-only outcome that records the candidate rule and',
                    'the live evidence you already gathered for it.',
                ],
            };
        }
        const rawSymptomDescription =
            typeof args.symptomDescription === 'string' ? args.symptomDescription.trim() : '';
        const modelSymptomDescription =
            rawSymptomDescription.length > 0 ? rawSymptomDescription.slice(0, 2_000) : undefined;
        const state = this.activeSessionId
            ? this.sessionStates.get(this.activeSessionId)
            : undefined;
        if (this.cliEvidenceRoute) {
            // The CLI environment filters through its own activated foreground, so its candidate
            // sessions carry no extension provenance or settings evidence to demand.
            if (!state || state.extensionMode !== ExtensionMode.None || !state.navigationVerified) {
                return {
                    validationSkipped: true,
                    errorKind: 'cli_route_session_required',
                    retryable: true,
                    requiredAction: 'launch_cli_evidence_browser',
                };
            }
        } else if (
            !state ||
            state.extensionMode !== ExtensionMode.Prepared ||
            !state.extension ||
            !state.settingsProfile ||
            // The baseline proof is the host read-back taken by the launch route's Baseline
            // application, or — for a blocker that declares its own list selection — that
            // declaration; a session credited through neither channel was never verified against
            // any settings request.
            !sessionBaselineCredited(state)
        ) {
            return {
                validationSkipped: true,
                errorKind: 'prepared_extension_environment_required',
                retryable: true,
                requiredAction: 'launch_prepared_extension',
            };
        }
        const preparationLimitation = await this.ensureFilteringEnvironment(state);
        if (preparationLimitation) {
            return {
                validationSkipped: true,
                errorKind: 'environment_capability_limited',
                retryable: false,
                limitation: preparationLimitation,
            };
        }
        const adapter = this.filteringEnvironmentAdapter!;
        const recorder = this.filteringEnvironmentRecorder!;
        // Baseline mutation needs an environment that can edit its published baseline; the
        // browser-extension route cannot, so the refusal is typed and terminal for the shape
        // instead of demoting the environment lock through an experiment limitation.
        if (candidate.operation !== CandidateOperation.Add && !this.cliEvidenceRoute) {
            return unsupportedCandidateOperationRefusal(
                candidate.operation,
                'in the browser-extension environment',
            );
        }
        const candidateRule = candidate.rule;
        // The baseline is recomputed at the verdict, after the host has written the candidate into
        // the declared blocker-state file; that file lives in the run's host-state root, so both
        // computations see the same unchanged checkout.
        const trustedValidationContext = createTrustedValidationContext(
            state.targetUrl,
            this.options.filtersPath,
        );
        const observerOptions: BrowserExtensionAdsObserverOptions = {
            candidateRule,
            ...(typeof args.adElementSelector === 'string'
                ? { adElementSelector: args.adElementSelector }
                : {}),
            trustedValidationContext,
            profile: structuredClone(state.profile),
            recorder: this.options.recorder,
            artifactsDir: this.options.artifactsDir,
            vision: this.options.vision,
            // The reporter's own material leads and the model's per-candidate description follows
            // as what this one rule targets. Were the model's description to win outright, the
            // review would verify a candidate against the ad units it happens to cover while a
            // header banner the reporter also named stays on the page. See
            // `composeReporterSymptomScope`.
            reporterSymptom:
                composeReporterSymptomScope({
                    reportedProblem: this.options.issueFacts.userComment,
                    issueText: [this.options.issue.title, this.options.issue.body].join('\n'),
                    screenshotObservations: this.reporterScreenshotObservations,
                    candidateTarget: modelSymptomDescription,
                }) ??
                (isBreakageSymptom(this.symptomKind())
                    ? 'The exact site breakage described by the reporter.'
                    : 'The exact advertising symptom described by the reporter.'),
            symptomKind: this.symptomKind(),
            attemptNumber: candidate.attemptNumber,
            noSandbox: this.options.noSandbox,
            ...(interactionPlan ? { interactionPlan } : {}),
        };
        if (this.dependencies.browserExtensionAdsObserverDependencies) {
            observerOptions.dependencies =
                this.dependencies.browserExtensionAdsObserverDependencies;
        }
        const observer = this.dependencies.observeEnvironmentPhase
            ? null
            : new BrowserExtensionAdsObserver(observerOptions);
        this.filteringEnvironmentExperimentExecutionOrdinal += 1;
        const executionOrdinal = this.filteringEnvironmentExperimentExecutionOrdinal;
        const candidateDigest = createHash('sha256').update(candidateRule).digest('hex');
        const experiment = await runAdsEnvironmentExperiment({
            runId: this.options.recorder.toJSON().runId,
            experimentId:
                `candidate-${candidate.attemptNumber}-execution-${executionOrdinal}-` +
                candidateDigest.slice(0, 12),
            adapter,
            recorder,
            targetUrl: state.targetUrl,
            // originalRule travels verbatim: baseline mutation receipts compare the exact
            // published line bytes, which normalization would corrupt.
            candidate:
                candidate.operation === CandidateOperation.Add
                    ? { operation: CandidateOperation.Add, rule: candidateRule }
                    : candidate.operation === CandidateOperation.Remove
                      ? {
                            operation: CandidateOperation.Remove,
                            rule: candidate.originalRule ?? candidateRule,
                        }
                      : {
                            operation: CandidateOperation.Edit,
                            rule: candidateRule,
                            originalRule: candidate.originalRule!,
                        },
            observe:
                this.dependencies.observeEnvironmentPhase ??
                (async (input) => await observer!.observe(input)),
            ...(signal ? { signal } : {}),
        });
        if (signal?.aborted) {
            // The tool deadline already returned its timeout result for this call: a
            // late-settling experiment no longer owns disposition or bootstrap-failure state.
            return {
                validationSkipped: true,
                errorKind: 'tool_deadline_exceeded',
                retryable: true,
            };
        }
        if (
            this.phaseBootstrapFailure !== null &&
            this.phaseBootstrapFailure.experimentOrdinal !== executionOrdinal
        ) {
            // This experiment got past session bootstrap (or never reached it), so any streak
            // recorded by an earlier experiment is broken and must not classify this run.
            this.phaseBootstrapFailure = null;
        }
        this.filteringEnvironmentDisposition = {
            status: experiment.verdict,
            candidateDigest: experiment.verdict === 'verified' ? candidateDigest : null,
            failure: experiment.limitation,
        };
        if (experiment.verdict === 'verified') {
            // A desktop candidate binds through its CLI proof: retain the candidate phase's
            // proof under the validation identity so the provisional binding can carry it.
            const candidatePhase = experiment.phases.find((phase) => phase.phase === PhaseLabel.C);
            const completion =
                candidatePhase?.completion.kind === 'observed'
                    ? candidatePhase.completion
                    : undefined;
            const validationId = completion?.candidateValidation?.validationArtifactId;
            if (validationId && candidatePhase?.proof.cli) {
                this.candidateCliProofs.set(
                    validationId,
                    structuredClone(candidatePhase.proof.cli),
                );
            }
        }
        if (experiment.limitation) {
            const bootstrapFailure = this.phaseBootstrapFailure;
            if (
                experiment.limitation.code === EnvironmentAdapterLimitationCode.PhaseOpenFailed &&
                bootstrapFailure !== null &&
                bootstrapFailure.experimentOrdinal === executionOrdinal
            ) {
                // An infrastructure-shaped bootstrap fault is not a capability limit of the
                // locked environment, so the lock is not demoted and the result carries the
                // real cause instead of an unsupported-case verdict. It is also not retried:
                // an environment that dies at bootstrap gets fixed from the recorded evidence,
                // not re-rolled — the run finishes analysis-only with the candidate and the
                // exact failure in the report.
                // The disposition resets so a sticky failure cannot later re-enter through the
                // preparation branch and demote the lock after all.
                this.filteringEnvironmentDisposition = {
                    status: 'inconclusive',
                    candidateDigest: null,
                    failure: null,
                };
                return {
                    validationSkipped: true,
                    error:
                        'The phase browser session failed to bootstrap: ' +
                        truncateDetail(bootstrapFailure.detail, 300),
                    errorKind: 'phase_session_unavailable',
                    retryable: false,
                    requiredAction: 'finish_fix_analysis_only',
                    consecutiveBootstrapFailures: bootstrapFailure.consecutiveFailures,
                    limitation: experiment.limitation,
                    guidance:
                        'The candidate itself was not judged: the controlled browser session ' +
                        'died during launch or extension bootstrap, which is an environment ' +
                        'fault, not a property of this issue. Do not relaunch. Finish with an ' +
                        'analysis-only outcome that includes the exact candidate rule and ' +
                        'quotes this bootstrap failure as the reason verification was skipped.',
                };
            }
            if (
                experiment.limitation.code ===
                    EnvironmentAdapterLimitationCode.CandidateOperationUnsupported &&
                candidate.operation !== CandidateOperation.Add
            ) {
                // The environment refused the baseline-mutation SHAPE, not the issue: the lock
                // stays ready so the model can still validate an added exception or replacement
                // rule for the same report.
                this.filteringEnvironmentDisposition = {
                    status: 'inconclusive',
                    candidateDigest: null,
                    failure: null,
                };
                return {
                    ...unsupportedCandidateOperationRefusal(
                        candidate.operation,
                        'by this environment',
                    ),
                    limitation: experiment.limitation,
                };
            }
            this.recordFilteringEnvironmentLimitation(experiment.limitation);
            return {
                validationSkipped: true,
                errorKind: 'environment_capability_limited',
                retryable: false,
                limitation: experiment.limitation,
            };
        }
        const result = observer?.result();
        if (result) {
            return this.cliEvidenceRoute ? withCliExperimentVerdict(result, experiment) : result;
        }
        if (experiment.inconclusiveReason === 'baseline_symptom_absent') {
            // Phases ran cleanly; what failed is the symptom description the observer judged.
            // This is diagnosable evidence, not a tool failure: it carries no `error`, so it
            // never spends the apply_rule retry budget that guards against broken tooling. The
            // count written here is read at the top of this method: once it reaches 2, a third
            // call for this exact candidate is refused before any phase can open.
            const ledgerKey = exhaustedLedgerKey;
            const seen = (this.baselineSymptomAbsentCounts.get(ledgerKey) ?? 0) + 1;
            this.baselineSymptomAbsentCounts.set(ledgerKey, seen);
            const blockedHost = judgeableBlockedHost(candidateRule, state.targetUrl);
            const revealStepsProjection = observer?.revealStepsProjection() ?? null;
            const restatement = [
                'The phase sessions judge one symptom description. The description in force did not',
                'name anything that differs between the unfiltered page and the filtered baseline, so',
                'the candidate was never judged.',
                ...(blockedHost === undefined
                    ? []
                    : [
                          `The filtered baseline also made no allowed request to ${blockedHost}, so`,
                          'a block of that host has nothing to stop on this page.',
                      ]),
                'Pass symptomDescription to apply_rule and state the breakage you proved live: name the',
                'element or content that filtering removes and where on the page it sits. Never describe',
                'framing properties of the reporter screenshot such as cropping, window width, or text',
                'cut off at an image edge — no phase session can reproduce those.',
                ...(interactionPlan
                    ? []
                    : [
                          'If the symptom appears only after the page waits or is touched, rehearse',
                          'it with interact_page and pass that sequence as revealSteps.',
                      ]),
            ];
            const exhausted = [
                'The baseline still shows no symptom after a restated description, so this candidate',
                'cannot be proven in a controlled experiment. Do not retry it. Finish with an',
                'analysis-only outcome that records the candidate rule and the live evidence you',
                'gathered for it.',
            ];
            return {
                validationSkipped: true,
                environmentExperiment: experiment.verdict,
                phases: experiment.phases.map((phase) => phase.phase),
                errorKind: 'baseline_symptom_absent',
                retryable: seen === 1,
                ...(seen === 1 ? {} : { requiredAction: 'finish_fix_analysis_only' }),
                ...(revealStepsProjection ? { revealSteps: revealStepsProjection } : {}),
                guidance: [
                    ...revealStepsRepairGuidance(revealStepsProjection),
                    ...(seen === 1 ? restatement : exhausted),
                ],
            };
        }
        return {
            validationSkipped: experiment.verdict !== 'verified',
            environmentExperiment: experiment.verdict,
            phases: experiment.phases.map((phase) => phase.phase),
        };
    }

    /**
     * Determine whether one canonical candidate may repeat without consuming a semantic attempt.
     *
     * An attempt that ended before any validation evidence was recorded (for example a tool
     * deadline) never produced a verdict, so the candidate identity stays retryable. Otherwise only
     * an inconclusive bound-vision review may repeat, bounded by the execution count.
     *
     * @param ledgerKey - Composed operation-plus-canonical candidate ledger key.
     * @returns Whether the same browser session may repeat the rule without a semantic attempt.
     */
    private canRetryInconclusiveVisualReview(ledgerKey: string): boolean {
        const outcome = this.candidateValidationOutcomes.get(ledgerKey);
        if (outcome === undefined) {
            return true;
        }
        return (
            outcome.visualVerdict === 'inconclusive' &&
            outcome.validationAttemptCount < MAX_CANDIDATE_VALIDATION_EXECUTIONS
        );
    }

    /**
     * Determine whether one judged candidate may run again because its page is prepared
     * differently.
     *
     * A verdict reached on a page that never showed the symptom says nothing about the rule, so new
     * reveal steps buy one more experiment, bounded by the same execution count as a vision retry.
     *
     * @param ledgerKey - Composed operation-plus-canonical candidate ledger key.
     * @param revealDigest - Digest of the reveal steps this call passes, empty for none.
     * @returns Whether the candidate was never judged under these reveal steps.
     */
    private isUntriedRevealPlan(ledgerKey: string, revealDigest: string): boolean {
        const tried = this.candidateRevealPlanDigests.get(ledgerKey);
        return (
            tried !== undefined &&
            !tried.has(revealDigest) &&
            (this.candidateValidationExecutionCounts.get(ledgerKey) ?? 0) <
                MAX_CANDIDATE_VALIDATION_EXECUTIONS
        );
    }

    /**
     * Record that one candidate reached the browser-bound validator and retain its vision verdict.
     *
     * Error results (for example a tool deadline) recorded no verdict, so they leave no outcome:
     * the candidate must stay retryable instead of being consumed by a technical failure.
     *
     * @param candidate - Candidate registered before browser dispatch.
     * @param result - Browser-bound apply_rule response.
     */
    private recordCandidateValidationOutcome(
        candidate: PendingCandidateAttempt,
        result: Record<string, unknown>,
    ): void {
        if (result.validationSkipped === true || result.error !== undefined) {
            return;
        }
        const ledgerKey = candidateLedgerKey(candidate.operation, candidate.normalized.canonical);
        const validationAttemptCount =
            (this.candidateValidationExecutionCounts.get(ledgerKey) ?? 0) + 1;
        this.candidateValidationExecutionCounts.set(ledgerKey, validationAttemptCount);
        const triedReveal = this.candidateRevealPlanDigests.get(ledgerKey) ?? new Set<string>();
        triedReveal.add(candidate.revealPlan?.digest ?? '');
        this.candidateRevealPlanDigests.set(ledgerKey, triedReveal);
        const review =
            typeof result.visualReview === 'object' && result.visualReview !== null
                ? (result.visualReview as Record<string, unknown>)
                : undefined;
        this.candidateValidationOutcomes.set(ledgerKey, {
            attemptNumber: candidate.attemptNumber,
            validationAttemptCount,
            ...(typeof result.validationArtifactId === 'string'
                ? { validationArtifactId: result.validationArtifactId }
                : {}),
            ...(typeof review?.verdict === 'string' ? { visualVerdict: review.verdict } : {}),
            ...(typeof review?.rationale === 'string'
                ? { visualRationale: review.rationale.slice(0, 1_000) }
                : {}),
        });
    }

    /**
     * Merge only browser-specific handlers while preserving runtime and base tool state.
     *
     * @param browserRegistry - Fresh registry bound to the active session.
     */
    private mergeBrowserTools(browserRegistry: ToolRegistry): void {
        for (const definition of browserRegistry.getDefinitions()) {
            const name = definition.function.name;
            if (this.baseToolNames.has(name)) {
                continue;
            }
            this.registry.register({
                definition,
                handler: async (args) => {
                    const activeState = this.activeSessionId
                        ? this.sessionStates.get(this.activeSessionId)
                        : undefined;
                    const activeTargetUrl = activeState?.targetUrl;
                    if (activeTargetUrl) {
                        const exhaustedBudget =
                            this.technicalBrowserBudgetExhaustion(activeTargetUrl);
                        if (exhaustedBudget) {
                            return exhaustedBudget;
                        }
                    }
                    const spentBudget = this.browserToolBudgets.spend(name);
                    if (spentBudget) {
                        return spentBudget;
                    }
                    let pendingCandidate: PendingCandidateAttempt | undefined;
                    let freshLedgerKey: string | undefined;
                    if (name === 'apply_rule') {
                        // A slice session judges no candidate, and the refusal spends no attempt:
                        // it comes before every ledger entry below.
                        const sliceRefusal = sliceSessionApplyRuleRefusal(activeState?.listSlice);
                        if (sliceRefusal) {
                            return sliceRefusal;
                        }
                        // The guidance precondition holds only where guidance exists. A run
                        // without a rule-guidance session advertises lookup_rule_guidance as a
                        // gated stub, and demanding the call anyway would block every candidate
                        // on the built-in AdGuard route.
                        if (
                            !this.guidanceConsulted &&
                            this.baseToolNames.has('lookup_rule_guidance')
                        ) {
                            return {
                                error: 'Call lookup_rule_guidance before the first candidate.',
                                errorKind: 'guidance_required',
                                retryable: true,
                            };
                        }
                        const remainingIssueScreenshotIndices =
                            this.remainingIssueScreenshotIndices();
                        if (remainingIssueScreenshotIndices.length > 0) {
                            return {
                                error:
                                    'Analyze every unique user issue screenshot first by passing ' +
                                    'each remaining issueScreenshotIndex returned by fetch_issue.',
                                errorKind: 'issue_screenshot_analysis_required',
                                retryable: true,
                                requiredTool: 'analyze_screenshot',
                                availableIssueScreenshotIndices:
                                    this.options.issueAttachmentArtifactIds.map(
                                        (_, index) => index + 1,
                                    ),
                                remainingIssueScreenshotIndices,
                            };
                        }
                        const candidateRule =
                            typeof args.candidateRule === 'string' ? args.candidateRule : '';
                        if (
                            args.operation !== undefined &&
                            !CANDIDATE_OPERATION_VALUES.includes(
                                args.operation as CandidateOperation,
                            )
                        ) {
                            // Fail closed instead of silently reinterpreting the verb as 'add'.
                            return {
                                error:
                                    `Unknown candidate operation '${String(args.operation)}'; ` +
                                    "use 'add', 'edit', or 'remove'.",
                                errorKind: 'candidate_shape_invalid',
                                retryable: true,
                            };
                        }
                        const operation =
                            args.operation === CandidateOperation.Edit ||
                            args.operation === CandidateOperation.Remove
                                ? args.operation
                                : CandidateOperation.Add;
                        const originalRule =
                            typeof args.originalRule === 'string' && args.originalRule.length > 0
                                ? args.originalRule
                                : undefined;
                        // Mirror EnvironmentCandidateSchema shape rules before spending anything:
                        // edit requires the targeted published line, add and remove forbid the
                        // combination that would make the request ambiguous.
                        if (operation === CandidateOperation.Edit && originalRule === undefined) {
                            return {
                                error: "Candidate operation 'edit' requires originalRule.",
                                errorKind: 'candidate_shape_invalid',
                                retryable: true,
                            };
                        }
                        if (operation === CandidateOperation.Add && originalRule !== undefined) {
                            return {
                                error: "Candidate operation 'add' must not carry originalRule.",
                                errorKind: 'candidate_shape_invalid',
                                retryable: true,
                            };
                        }
                        const normalized = normalizeRule(
                            operation === CandidateOperation.Remove
                                ? (originalRule ?? candidateRule)
                                : candidateRule,
                        );
                        const canonical = normalized.canonical
                            ? candidateLedgerKey(operation, normalized.canonical)
                            : '';
                        if (!canonical) {
                            // No other validator takes a canonical-less candidate, so the refusal
                            // must be typed here instead of surfacing as a missing tool.
                            return {
                                error:
                                    'The candidate rule could not be parsed as a network, ' +
                                    'cosmetic, or scriptlet filter rule.',
                                errorKind: 'candidate_shape_invalid',
                                retryable: true,
                            };
                        }
                        const existingAttempt = this.candidateAttempts.get(canonical);
                        const sessionId = this.activeSessionId;
                        // Refused before the candidate is registered, so a malformed sequence never
                        // spends one of the run's semantic candidate attempts.
                        const revealRequest = parseRevealSteps(args.revealSteps);
                        if (revealRequest.kind === 'rejected') {
                            return {
                                error: 'The revealSteps were not accepted.',
                                errorKind: revealRequest.reason,
                                detail: revealRequest.detail,
                                retryable: true,
                            };
                        }
                        const revealPlan =
                            revealRequest.kind === 'normalized' ? revealRequest.plan : undefined;
                        const attemptedSessionIds =
                            this.candidateAttemptSessionIds.get(canonical) ?? new Set<string>();
                        if (
                            existingAttempt !== undefined &&
                            sessionId !== undefined &&
                            attemptedSessionIds.has(sessionId) &&
                            !this.canRetryInconclusiveVisualReview(canonical) &&
                            !this.isUntriedRevealPlan(canonical, revealPlan?.digest ?? '')
                        ) {
                            return {
                                validationSkipped: true,
                                errorKind: 'duplicate_candidate',
                                attemptNumber: existingAttempt,
                            };
                        }
                        if (existingAttempt !== undefined) {
                            if (sessionId) {
                                attemptedSessionIds.add(sessionId);
                            }
                            this.candidateAttemptSessionIds.set(canonical, attemptedSessionIds);
                            pendingCandidate = {
                                rule: candidateRule.trim(),
                                normalized,
                                attemptNumber: existingAttempt,
                                operation,
                                ...(originalRule === undefined ? {} : { originalRule }),
                                ...(revealPlan === undefined ? {} : { revealPlan }),
                            };
                        } else {
                            if (this.candidateAttempts.size >= 3) {
                                return {
                                    validationSkipped: true,
                                    errorKind: 'candidate_limit_reached',
                                    maximumAttempts: 3,
                                };
                            }
                            const attemptNumber = this.candidateAttempts.size + 1;
                            this.candidateAttempts.set(canonical, attemptNumber);
                            freshLedgerKey = canonical;
                            if (sessionId) {
                                attemptedSessionIds.add(sessionId);
                            }
                            this.candidateAttemptSessionIds.set(canonical, attemptedSessionIds);
                            pendingCandidate = {
                                rule: candidateRule.trim(),
                                normalized,
                                attemptNumber,
                                operation,
                                ...(originalRule === undefined ? {} : { originalRule }),
                                ...(revealPlan === undefined ? {} : { revealPlan }),
                            };
                        }
                    }
                    // In production candidates always take the environment-adapter path: the
                    // registry carries no apply_rule implementation. The dispatch fallthrough
                    // exists only for unit tests that inject createBrowserRegistry with their own
                    // apply_rule fixture to drive runtime-level contracts without faking a whole
                    // environment adapter — unless that test also replaced the run's executor set,
                    // which is the registry-driven flow this runtime exists for.
                    const commonEnvironmentApply =
                        this.dependencies.createBrowserRegistry === undefined ||
                        this.dependencies.observeEnvironmentPhase !== undefined ||
                        this.dependencies.filteringExecutors !== undefined;
                    const result = await withToolDeadline(
                        name,
                        (signal) =>
                            name === 'apply_rule' && pendingCandidate && commonEnvironmentApply
                                ? this.runCommonExtensionCandidate(pendingCandidate, args, signal)
                                : browserRegistry.dispatch(name, args),
                        name === 'apply_rule'
                            ? APPLY_RULE_TOOL_DEADLINE_MS
                            : BROWSER_TOOL_DEADLINE_MS,
                    );
                    if (name === 'open_page' && activeTargetUrl) {
                        if (isAgentRefusalFallback(refusedNavigationFallbackReason(result))) {
                            return {
                                ...result,
                                errorKind: 'navigation_refused',
                                retryable: true,
                                requiredAction: 'stay_on_issue_origin',
                                guidance:
                                    'This session stays open on the current page. Open only URLs ' +
                                    'on the issue origins: the reported page, its own redirects ' +
                                    'and the pages it links to there.',
                            };
                        }
                        const fallbackReason = technicalNavigationFallbackReason(result);
                        if (fallbackReason) {
                            if (activeState) {
                                this.retireFailedNavigationSession(activeState);
                            }
                            return this.recordTechnicalBrowserFailure(
                                'open_page',
                                activeTargetUrl,
                                fallbackReason,
                                String(result.error),
                                result,
                            );
                        }
                    }
                    if (name === 'apply_rule' && pendingCandidate) {
                        if (
                            freshLedgerKey !== undefined &&
                            result.errorKind === 'candidate_operation_unsupported'
                        ) {
                            // An operation-capability refusal judged the request shape, not the
                            // candidate's merit: release the slot registered by this call so the
                            // three semantic attempts stay spendable on supported operations.
                            this.candidateAttempts.delete(freshLedgerKey);
                            this.candidateAttemptSessionIds.delete(freshLedgerKey);
                        }
                        this.recordCandidateValidationOutcome(pendingCandidate, result);
                    }
                    this.recordBrowserToolResult(name, result);
                    // Everything above read the complete result. The model gets the experiment
                    // with its decision first and its bulk bounded, so the verdict is never the
                    // part the tool-result limit cuts away.
                    const forModel =
                        name === 'apply_rule'
                            ? applyRuleResultForModel(result)
                            : name === 'open_page'
                              ? this.withRedirectGuidance(result)
                              : result;
                    return forModel;
                },
            });
            this.activeBrowserToolNames.add(name);
        }
    }

    /**
     * Every URL the model may launch a session on: the prompt-safe reported URLs, then the pages
     * they redirected to on another site.
     *
     * @returns Target URLs in that order.
     */
    private targetUrls(): string[] {
        return [...this.options.allowedTargetUrls, ...this.redirectTargetUrls];
    }

    /**
     * Point the model at the redirect destination when open_page landed on another site.
     *
     * The session stays bound to the site it was launched on, so it can neither credit nor
     * investigate the page it landed on; a session launched on that page can.
     *
     * @param result - The open_page result.
     * @returns The result, with the destination and what to do about it when the page redirected.
     */
    private withRedirectGuidance(result: Record<string, unknown>): Record<string, unknown> {
        const state = this.activeSessionId
            ? this.sessionStates.get(this.activeSessionId)
            : undefined;
        const landedUrl =
            result.error === undefined && typeof result.url === 'string'
                ? canonicalTargetUrl(result.url)
                : undefined;
        if (
            !state ||
            !landedUrl ||
            !this.redirectTargetUrls.includes(landedUrl) ||
            registrableDomain(new URL(landedUrl).hostname) ===
                registrableDomain(new URL(state.targetUrl).hostname)
        ) {
            return result;
        }
        return {
            ...result,
            redirectedTo: landedUrl,
            guidance:
                'The reported URL redirected to another site, so this session does not count as ' +
                'reaching the reported page. Launch a new session with targetUrl set to ' +
                'redirectedTo and investigate the page there; rules for that page are scoped ' +
                'to its domain.',
        };
    }

    /**
     * Record navigation, complete-page capture, and validation identities from one browser tool.
     *
     * @param name - Browser tool name dispatched in the active session.
     * @param result - Typed serializable browser tool result.
     */
    private recordBrowserToolResult(name: string, result: Record<string, unknown>): void {
        const state = this.activeSessionId
            ? this.sessionStates.get(this.activeSessionId)
            : undefined;
        if (!state || result.error !== undefined) {
            return;
        }

        if (name === 'open_page' && typeof result.url === 'string') {
            // A site's own redirect keeps the reported page: `google.com` lands on `www.google.com`,
            // `http` on `https`. Comparing origins would refuse every such landing, and the run
            // could neither inspect the page it had loaded nor finish.
            const navigatedUrl = canonicalTargetUrl(result.url);
            if (
                navigatedUrl &&
                registrableDomain(new URL(navigatedUrl).hostname) ===
                    registrableDomain(new URL(state.targetUrl).hostname)
            ) {
                state.navigationVerified = true;
                this.lastBrowserError = undefined;
            } else if (navigatedUrl && !this.targetUrls().includes(navigatedUrl)) {
                // open_page only opens the session's own site, so a landing on another site is
                // where that site redirected the browser.
                this.redirectTargetUrls.push(navigatedUrl);
            }
            // The main document's status is the browser's own fact about the page. What the page
            // shows in its place — a sign-in wall, a regional block, a bot check — is judged by
            // vision on the capture a claim rests on, not from this navigation.
            state.pageAccessFacts = {
                statusCode: typeof result.statusCode === 'number' ? result.statusCode : 200,
            };
        }

        if (name === 'screenshot') {
            const viewportArtifactId =
                typeof result.artifactId === 'string' ? result.artifactId : undefined;
            const fullPageArtifactId =
                typeof result.fullPageArtifactId === 'string'
                    ? result.fullPageArtifactId
                    : undefined;
            const tileCoverage =
                typeof result.tileCoverage === 'object' && result.tileCoverage !== null
                    ? (result.tileCoverage as Record<string, unknown>)
                    : undefined;
            const tiles = Array.isArray(tileCoverage?.tiles) ? tileCoverage.tiles : [];
            const tileArtifactIds = tiles
                .map((tile) =>
                    typeof tile === 'object' &&
                    tile !== null &&
                    typeof (tile as Record<string, unknown>).artifactId === 'string'
                        ? String((tile as Record<string, unknown>).artifactId)
                        : undefined,
                )
                .filter((artifactId): artifactId is string => artifactId !== undefined);
            const coverageComplete =
                fullPageArtifactId &&
                tileCoverage?.complete === true &&
                tileArtifactIds.length > 0 &&
                tileArtifactIds.length === tiles.length;
            // The vision inventory excludes an overview no single request can carry or read, so
            // the runtime must not demand its inspection either; the original-resolution tiles
            // still carry the complete coverage proof. Both sides read the one shared rule.
            const overviewBytes = fullPageArtifactId
                ? this.options.recorder
                      .getArtifacts()
                      .find((artifact) => artifact.id === fullPageArtifactId)?.bytes
                : undefined;
            const overviewVisionEligible =
                fullPageArtifactId !== undefined &&
                visionOverviewRefusal({
                    bytes: overviewBytes,
                    documentWidth: tileCoverage?.documentWidth as number | undefined,
                    documentHeight: tileCoverage?.documentHeight as number | undefined,
                }) === null;
            const requiredArtifactIds =
                coverageComplete && fullPageArtifactId
                    ? [...(overviewVisionEligible ? [fullPageArtifactId] : []), ...tileArtifactIds]
                    : [];
            const viewport = viewportArtifactId
                ? this.resolveScreenshotEvidence(viewportArtifactId, ['screenshot'])
                : null;
            const fullPageOverview = fullPageArtifactId
                ? this.resolveScreenshotEvidence(fullPageArtifactId, ['screenshot-full-page'])
                : null;
            const tileEvidence = tileArtifactIds.map((artifactId) =>
                this.resolveScreenshotEvidence(artifactId, ['screenshot-tile']),
            );
            const allArtifactIds = [
                ...(viewportArtifactId ? [viewportArtifactId] : []),
                ...(fullPageArtifactId ? [fullPageArtifactId] : []),
                ...tileArtifactIds,
            ];
            // A capture belongs to the session that took it whether or not its navigation was
            // verified: a sign-in page on another origin is judged from exactly such a capture, and
            // only that session can spend the access budget for it.
            for (const artifactId of allArtifactIds) {
                this.screenshotSessionIds.set(artifactId, state.sessionId);
            }
            if (state.navigationVerified && allArtifactIds.length > 0) {
                state.pageCaptures.push({
                    visionVerified: false,
                    captureArtifactId:
                        viewportArtifactId ?? fullPageArtifactId ?? requiredArtifactIds[0]!,
                    viewport,
                    fullPageOverview,
                    tiles: tileEvidence,
                    coverageComplete: Boolean(coverageComplete),
                    reporterSymptomPresence: null,
                    pageObstruction: null,
                    requiredArtifactIds,
                    rawCapture: {
                        ...(viewportArtifactId ? { artifactId: viewportArtifactId } : {}),
                        ...(fullPageArtifactId ? { fullPageArtifactId } : {}),
                        ...(tileCoverage ? { tileCoverage } : {}),
                    },
                });
                this.refreshFullVisionEvidence(state);
            }
        }

        if (name === 'apply_rule' && typeof result.validationArtifactId === 'string') {
            this.validationSessionIds.set(result.validationArtifactId, state.sessionId);
            this.candidateValidationReferences.delete(result.validationArtifactId);
            const parsedVisualReview = v.safeParse(
                CandidateVisualReviewSchema,
                result.visualReview,
            );
            if (
                parsedVisualReview.success &&
                parsedVisualReview.output.validationArtifactId === result.validationArtifactId &&
                typeof result.visualReviewArtifactId === 'string'
            ) {
                this.candidateValidationReferences.set(result.validationArtifactId, {
                    sessionId: state.sessionId,
                    visualReview: parsedVisualReview.output,
                    visualReviewArtifactId: result.visualReviewArtifactId,
                });
            }
            const phases = ['phaseA', 'phaseB', 'phaseC'].map((key) =>
                typeof result[key] === 'object' && result[key] !== null
                    ? (result[key] as Record<string, unknown>)
                    : undefined,
            );
            if (
                phases.every(
                    (phase) =>
                        phase !== undefined &&
                        phase.error === undefined &&
                        typeof phase.url === 'string',
                )
            ) {
                state.navigationVerified = true;
            }
        }
    }

    /**
     * Resolve a screenshot identity to the exact recorder path available at capture time.
     *
     * @param artifactId - Browser-returned screenshot artifact identity.
     * @param allowedTypes - Screenshot artifact types valid for the capture role.
     * @returns Detached identity/path pair bound to this tool result.
     */
    private resolveScreenshotEvidence(
        artifactId: string,
        allowedTypes: string[],
    ): AgentRuntimeScreenshotEvidence {
        const artifacts = this.options.recorder.getArtifacts();
        for (let index = artifacts.length - 1; index >= 0; index -= 1) {
            const artifact = artifacts[index];
            if (artifact.id === artifactId && allowedTypes.includes(artifact.type)) {
                return { artifactId, path: artifact.path };
            }
        }
        return { artifactId, path: null };
    }

    /**
     * Resolve an unambiguous recorder artifact under one exact identity and media role.
     *
     * Repeated registrations of the same ID/path pair are tolerated for deterministic retries;
     * conflicting paths or media roles fail closed.
     *
     * @param artifactId - Runner-owned artifact identity to resolve.
     * @param expectedType - Exact recorder media role required by the candidate binding.
     * @returns Exact ID/path pair, or undefined for missing or ambiguous evidence.
     */
    private resolveCandidateArtifactEvidence(
        artifactId: string,
        expectedType: CandidateArtifactExpectedType,
    ): AgentRuntimeCandidateArtifactEvidence | undefined {
        const artifacts = this.options.recorder
            .getArtifacts()
            .filter((artifact) => artifact.id === artifactId);
        if (
            artifacts.length === 0 ||
            artifacts.some((artifact) => artifact.type !== expectedType)
        ) {
            return undefined;
        }
        const paths = new Set(artifacts.map((artifact) => artifact.path));
        if (paths.size !== 1) {
            return undefined;
        }
        return { artifactId, path: artifacts.at(-1)!.path };
    }

    /**
     * Mark one screenshot as inspected and refresh its owning session's coverage proof.
     *
     * @param artifactId - Runner-owned screenshot identity passed to analyze_screenshot.
     */
    private recordScreenshotAnalysis(artifactId: string): void {
        const sessionId = this.screenshotSessionIds.get(artifactId);
        const state = sessionId ? this.sessionStates.get(sessionId) : undefined;
        if (!state) {
            return;
        }
        state.analyzedArtifactIds.add(artifactId);
        this.refreshFullVisionEvidence(state);
    }

    /**
     * Recompute whether one navigated session has a fully inspected overview and tile set.
     *
     * @param state - Mutable session evidence to update.
     */
    private refreshFullVisionEvidence(state: AgentRuntimeSessionState): void {
        state.fullVisionVerified =
            state.navigationVerified &&
            state.pageCaptures.some(
                (capture) =>
                    capture.coverageComplete &&
                    capture.requiredArtifactIds.length > 0 &&
                    capture.requiredArtifactIds.every((artifactId) =>
                        state.analyzedArtifactIds.has(artifactId),
                    ),
            );
    }

    /**
     * Render bounded reporter screenshot observations for candidate vision prompts.
     *
     * @returns Combined model observations, or undefined before screenshot analysis.
     */
    private reporterSymptom(): string | undefined {
        if (this.reporterScreenshotObservations.length === 0) {
            return undefined;
        }
        return this.reporterScreenshotObservations.join('\n\n').slice(0, 6_000);
    }

    /**
     * Problem class driving the visual review rubric for this run.
     *
     * @returns Breakage semantics for incorrect-blocking reports, ads semantics otherwise.
     */
    private symptomKind(): SymptomKind {
        return symptomKindForProblemType(this.options.issueFacts.problemType);
    }
}
