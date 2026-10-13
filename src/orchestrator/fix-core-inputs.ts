import { BrowserMode } from '../types/browser-mode';
import type { AdGuardExtensionSettingsProfile } from '../browser/adguard-extension-settings';
import { type BrowserSession, type BrowserSessionConfig } from '../browser/browser-session';
import type { RawIssue } from '../github/fetch-issue';
import {
    toInstructionGuidanceSource,
    type LoadedInstruction,
} from '../knowledge/instruction-loader';
import type { KnowledgeGuidanceSource, RuleGuidanceSource } from '../knowledge/rule-guidance';
import { LinkedDocumentDownloadError } from '../knowledge/linked-document-downloader';
import type { Logger } from '../logger/logger';
import type { PiRuntime } from '../pi/runtime';
import type { SingleShotClient } from '../pi/single-shot-types';
import type { RunUsageCollector } from '../pi/usage-collector';
import type { AgentRunArtifacts } from '../types/agent-run-artifacts';
import type { IssueFacts } from '../types/issue-facts';
import type { RepositoryLintCommand } from '../rules/repository-lint-command';
import { type AgentRuntimeDependencies } from './agent-runtime';
import type { ExecutorDependenciesByName } from './filtering-executors';
import { IssueAttachmentKind } from '../types/issue-attachment-kind';
import { downloadPinnedExtensionRelease } from '../local/pinned-extension-release';
import { runPreparationSession } from './preparation-session';
import type { FixEnvironmentLifecycle } from './fix-environment-lifecycle';
/**
 * The fix core's input vocabulary: the local issue snapshot a run is handed, the options every
 * adapter constructs, and the test seams a run may be given. The agentic core reads exactly these,
 * so they live in their own leaf and no core has to import another core for a type.
 */

/**
 * Local issue data consumed by the GitHub-independent fix core.
 */
export interface FixCoreIssueAttachment {
    /**
     * Attachment classification produced by the local snapshot exporter.
     */
    kind: IssueAttachmentKind;

    /**
     * Original user-supplied URL, when the attachment came from a remote issue body.
     */
    sourceUrl: string | null;

    /**
     * Verified local snapshot file path.
     */
    localPath: string;

    /**
     * Lowercase or uppercase SHA-256 digest recorded by the exporter.
     */
    sha256: string;
}

/**
 * Wrapper form retained for adapters that keep issue facts separate from the prompt-safe issue.
 */
export interface FixCoreIssueEnvelope {
    /**
     * Parser-ready, prompt-safe issue snapshot exposed to the fetch_issue tool.
     */
    rawIssue: RawIssue;

    /**
     * Pre-parsed facts the caller extracted before invoking the core.
     */
    facts: IssueFacts;

    /**
     * Locally snapshotted issue attachments available to the evidence pipeline.
     */
    attachments?: readonly FixCoreIssueAttachment[];
}

/**
 * Direct local issue shape accepted by the core, structurally compatible with AgentIssueInput.
 */
export type FixCoreIssueInput = FixCoreIssueEnvelope | DirectFixCoreIssueInput;

/**
 * Prompt-safe direct issue accepted without a nested raw-issue envelope.
 */
export interface DirectFixCoreIssueInput extends RawIssue {
    /**
     * Locally snapshotted issue attachments available to the evidence pipeline.
     */
    attachments?: readonly FixCoreIssueAttachment[];

    /**
     * Pre-parsed facts the caller extracted before invoking the core.
     */
    facts: IssueFacts;
}

/**
 * Runtime options for a GitHub-independent investigation.
 */
export interface FixCoreOptions {
    /**
     * Directory where every trace and browser artifact is written.
     */
    artifactsDir: string;

    /**
     * Browser-first execution policy. Agentic fix accepts `auto` or `on`; both require browser
     * evidence and produce a report-only unavailable result when Chromium cannot run.
     */
    browserMode?: BrowserMode;

    /**
     * Stop the run right after the environment selection is accepted.
     *
     * A routing check needs the agent's exact selection decision — same prompt, same tools —
     * without paying for the investigation that would follow it.
     */
    routingCheck?: boolean;

    /**
     * Optional reasoning-model override.
     */
    model?: string;

    /**
     * Whether verbose operational logging is enabled.
     */
    verbose?: boolean;

    /**
     * Caller cancellation checked before every paid provider and browser/tool dispatch.
     */
    signal?: AbortSignal;

    /**
     * Publication repository persisted in the result without granting repository access.
     */
    repository?: string;

    /**
     * Publication repository base SHA used to detect a moved base branch.
     */
    baseSha?: string;

    /**
     * AdguardFilters repository used for rule search and candidate placement.
     */
    filtersRepository?: string;

    /**
     * Exact AdguardFilters checkout SHA used by the investigation.
     */
    filtersBaseSha?: string;

    /**
     * Maximum number of tool-enabled reasoning turns.
     */
    maxIterations?: number;

    /**
     * Wall-clock budget for the agentic investigation loop.
     */
    maxDurationMs?: number;

    /**
     * Settings profile applied to the unpacked extension; null selects an unfiltered control.
     */
    extensionSettingsProfile?: AdGuardExtensionSettingsProfile | null;

    /**
     * Pinned allowlisted documentation source exposed through lookup_rule_guidance.
     */
    knowledgeGuidanceSource?: KnowledgeGuidanceSource;

    /**
     * Loads the rule guidance a run falls back to when it carries neither an instruction nor a
     * prepared KnowledgeBase; see {@link resolveRunRuleGuidance}. Called only when the investigation
     * starts, so a run that ends before it never downloads anything.
     */
    loadDefaultRuleGuidance?: () => Promise<RuleGuidanceSource>;

    /**
     * The run instruction loaded at run start, when this run carries one. Its linked documents
     * replace the KnowledgeBase behind lookup_rule_guidance for the whole run — see
     * {@link resolveRuleGuidanceSource} for the one dispatch; its text rides the fix task's
     * `{{instructionContext}}` fill through `runFixSession`.
     */
    instruction?: LoadedInstruction;

    /**
     * The repository's own lint command, when the run has one: offered to the model as `lint_rule`
     * and run once more over the published candidate, whose objection the report carries as a note.
     * It never decides anything; absent, no lint runs at all.
     */
    repositoryLint?: RepositoryLintCommand;

    /**
     * Enables the single model-driven runtime. Omit only for compatibility tests. The run's
     * extension build is prepared host-side before the runtime exists — the pinned prebuilt
     * release, the operator-preloaded directory, or the instruction's `## Preparation` session —
     * and reaches the runtime through `preparedExtension`.
     */
    agentRuntime?: {
        /**
         * Executor names this run locks from the registry, in request order.
         *
         * Absent resolves every registered executor of the process the run enters; an unknown name
         * fails before any session artifact, naming it and the registered set. A caller can pass
         * its executor set explicitly, so a run without an executor's special binary still reaches
         * its typed preparation limitation instead of losing the desktop executor.
         */
        executors?: readonly string[];

        /**
         * Opaque per-executor dependency bag threaded into the run's activation context, keyed by
         * executor name. Every caller that wants an executor registered outside this tree to
         * activate against real host wiring supplies it here instead of module state.
         */
        executorDependencies?: ExecutorDependenciesByName;
    };
}

/**
 * Injectable seams used by focused tests and alternate local browser wrappers.
 */
export interface FixCoreDependencies {
    /**
     * Optional prebuilt single-shot vision client threaded into the agent runtime; the core builds
     * the client from the run's pi runtime otherwise. Tests inject a recording or hermetic-wired
     * stub.
     */
    vision?: SingleShotClient;

    /**
     * Optional prebuilt pi runtime for the agentic loop; the core creates one from the LLM
     * configuration otherwise. Tests inject a runtime wired to the hermetic provider.
     */
    piRuntime?: PiRuntime;

    /**
     * Optional browser-session factory used instead of the production static constructor.
     */
    createBrowserSession?: (config: BrowserSessionConfig) => Promise<BrowserSession>;

    /**
     * Injectable stateful-runtime lifecycle seams used by agentic core tests.
     */
    agentRuntime?: AgentRuntimeDependencies;

    /**
     * The host-side pinned-release fetcher seam. Tests inject a stub to stand in for the network
     * and its digest gating; production passes nothing, which selects the module's own verified
     * pin. The placeholder type keeps the seam signature aligned with the fetcher.
     */
    downloadPinnedExtensionRelease?: typeof downloadPinnedExtensionRelease;

    /**
     * The model preparation-session seam. Tests inject a stub standing in for the short-lived
     * shell-and-files session; production passes nothing.
     */
    runPreparationSession?: typeof runPreparationSession;

    /**
     * Optional common filtering lifecycle finalized before any result escapes the agentic core.
     */
    environmentLifecycle?: FixEnvironmentLifecycle;

    /**
     * Receives the model-owned terminal decision and exact tool observations shown to the model.
     *
     * This side channel keeps agent-authored material distinct from the trusted Host result while
     * preserving the existing `runFixCore()` result contract for its callers.
     */
    onAgentRunArtifacts?: (artifacts: AgentRunArtifacts) => void;

    /**
     * Optional run-scoped usage collector. When present, the fix core meters the vision single-shot
     * client (after the `dependencies.vision ?? createVisionClient(...)` resolution) and threads
     * session usage into it through the session wirings; the runner renders the summary at its
     * output sites. Absent → no metering.
     */
    usageCollector?: RunUsageCollector;
}

/**
 * Resolve the one rule-guidance source a run's core options carry.
 *
 * Exactly one source may back lookup_rule_guidance: instruction-driven runs replace the
 * KnowledgeBase entirely, so a loaded instruction always wins over a prepared KnowledgeBase source,
 * and only runs without an instruction keep serving the pinned documents. The branches are mutually
 * exclusive by construction — a runner that loaded an instruction skips its KnowledgeBase
 * preparation instead of double-wiring both.
 *
 * @param options - The core options holding the instruction and the prepared KnowledgeBase source,
 *   whichever the calling flow provisioned.
 * @returns The instruction-branch source when an instruction is loaded; otherwise the prepared
 *   KnowledgeBase source; undefined when the run carries neither and the session seeds the
 *   not-applicable stub instead.
 */
export function resolveRuleGuidanceSource(
    options: Pick<FixCoreOptions, 'instruction' | 'knowledgeGuidanceSource'>,
): RuleGuidanceSource | undefined {
    if (options.instruction) {
        return toInstructionGuidanceSource(options.instruction);
    }
    return options.knowledgeGuidanceSource;
}

/**
 * Resolve the rule guidance the investigation serves: the instruction's or the prepared
 * KnowledgeBase's when the run has one, otherwise the default the run's loader provides.
 *
 * The default is best effort. A download that fails leaves the run on the not-applicable stub, the
 * way a run without any guidance has always worked, and the log says why.
 *
 * @param options - The core options holding the guidance sources and the default loader.
 * @param logger - Diagnostics sink for a default that could not be loaded.
 * @returns The guidance source, or undefined when the run has none.
 */
export async function resolveRunRuleGuidance(
    options: Pick<
        FixCoreOptions,
        'instruction' | 'knowledgeGuidanceSource' | 'loadDefaultRuleGuidance'
    >,
    logger: Logger,
): Promise<RuleGuidanceSource | undefined> {
    const configured = resolveRuleGuidanceSource(options);
    if (configured !== undefined || options.loadDefaultRuleGuidance === undefined) {
        return configured;
    }
    try {
        return await options.loadDefaultRuleGuidance();
    } catch (error) {
        if (!(error instanceof LinkedDocumentDownloadError)) {
            throw error;
        }
        logger.warn(
            { err: error },
            'default rule guidance could not be downloaded; the run continues without it',
        );
        return undefined;
    }
}
