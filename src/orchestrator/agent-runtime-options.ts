/**
 * The inputs one `AgentRuntime` is created with: the issue, the run's trust boundaries and the
 * dependencies the run injects. Declared in its own module so the runtime module stays focused on
 * the investigation itself.
 */
import type { RedirectOriginPolicy } from '../browser/redirect-origin-policy';
import type { LlmConfig } from '../config/config';
import type { RawIssue } from '../github/fetch-issue';
import type { LoadedInstruction } from '../knowledge/instruction-loader';
import type { RuleGuidanceSource } from '../knowledge/rule-guidance';
import type { PreparedExtension } from '../local/prepared-extension';
import type { PiRuntime } from '../pi/runtime';
import type { SingleShotClient } from '../pi/single-shot-types';
import type { RunUsageCollector } from '../pi/usage-collector';
import type { RepositoryLintCommand } from '../rules/repository-lint-command';
import type { TraceRecorder } from '../tracer/trace-recorder';
import type { DeclaredPlacementSet } from '../types/declared-placement';
import type { IssueFacts } from '../types/issue-facts';
import type { ExecutorDependenciesByName } from './filtering-executors';

/**
 * Inputs and immutable trust boundaries for one model-driven browser investigation.
 */
export interface AgentRuntimeOptions {
    /**
     * Policy deciding which redirect landing origins remain available to later navigation.
     */
    redirectOriginPolicy?: RedirectOriginPolicy;

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
     * The repository's skills directory, when its checkout ships one. Forwarded to every bounded
     * application session, so the application prompt lists the same skills as the fix session.
     */
    skillsDir?: string;

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
