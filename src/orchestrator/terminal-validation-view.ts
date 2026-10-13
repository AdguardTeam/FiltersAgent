/**
 * The read-only projection of a run that the `finish_fix` terminal judgement reads.
 *
 * It lives in its own module because every part of the judgement — the vision requirements, the
 * configuration-profile evidence, the symptom matrix and placement checks — reads the same
 * projection, and a shared contract at the bottom of the graph keeps those parts independent of one
 * another. The runtime implements it by delegation, so every rejection can be exercised against a
 * constructed view without launching a browser.
 */
import { type EnvironmentSelectionSnapshot } from '../environment/environment-selection-contract';
import type { RawIssue } from '../github/fetch-issue';
import type { EvidenceRouteHost } from '../local/evidence-route-contract';
import type { CandidatePlacementContext } from '../repo/candidate-placement-check';
import type { CandidateValidationOutcome } from './agent-runtime-candidate-context';
import type {
    AgentRuntimeEnvironmentEvidence,
    AgentRuntimeSessionState,
} from './agent-runtime-session-evidence';

/**
 * Everything the terminal judgement reads off a run, and nothing it can change.
 *
 * The runtime builds one of these per judgement, so each property is the value at the moment
 * `finish_fix` was submitted rather than a live handle the judgement could mutate.
 */
export interface TerminalValidationView {
    /**
     * Prompt-safe issue snapshot the run was started from.
     */
    readonly issue: RawIssue;

    /**
     * Reporter screenshot artifact identities, in the one-based order `fetch_issue` advertises.
     */
    readonly issueAttachmentArtifactIds: readonly string[];

    /**
     * Exact prompt-safe browser targets bound outside the model loop.
     */
    readonly allowedTargetUrls: readonly string[];

    /**
     * Issue number `fetch_issue` returned, or undefined while the model never called it.
     */
    readonly fetchedIssueNumber: number | undefined;

    /**
     * Session browser tools currently dispatch into, or undefined after `close_browser`.
     */
    readonly activeSessionId: string | undefined;

    /**
     * Every browser session the run opened, keyed by session identity.
     */
    readonly sessionStates: ReadonlyMap<string, AgentRuntimeSessionState>;

    /**
     * The checkout facts a draft's placement is checked against, or undefined when the run has no
     * walked filters checkout to insert into.
     */
    readonly placementContext: CandidatePlacementContext | undefined;

    /**
     * Active CLI proxy evidence route when the run locked the CLI environment, else null.
     */
    readonly cliEvidenceRoute: EvidenceRouteHost | null;

    /**
     * Locked environment selection, or null when the model never locked one.
     *
     * @returns The environment selection snapshot, or null.
     */
    environmentSelection(): EnvironmentSelectionSnapshot | null;

    /**
     * Read the validation bookkeeping retained for one candidate ledger key.
     *
     * @param ledgerKey - Composed candidate ledger key.
     * @returns The recorded outcome, or undefined when the candidate never ran.
     */
    candidateValidationOutcome(ledgerKey: string): CandidateValidationOutcome | undefined;

    /**
     * Whether any browser session produced evidence in this run.
     *
     * @returns Whether at least one session recorded browser evidence.
     */
    hasBrowserEvidence(): boolean;

    /**
     * Whether the bounded per-target technical browser budget is spent.
     *
     * @returns Whether browser access to the reported target is exhausted.
     */
    hasExhaustedTechnicalBrowserFailure(): boolean;

    /**
     * Whether the run must reproduce the reporter's own settings profile before finishing.
     *
     * @returns Whether reporter settings parity is required.
     */
    requiresCurrentReporterSettings(): boolean;

    /**
     * Whether one session carried the current prepared extension build.
     *
     * @param state - Session to classify.
     * @returns Whether the session ran the current prepared build.
     */
    isCurrentPreparedState(state: AgentRuntimeSessionState): boolean;

    /**
     * Whether one session satisfies every terminal requirement of the prepared environment.
     *
     * @param state - Session to classify.
     * @returns Whether the session is terminal-grade prepared evidence.
     */
    isTerminalCurrentPreparedState(state: AgentRuntimeSessionState): boolean;

    /**
     * Reporter screenshot indices the model has not yet analyzed.
     *
     * @returns One-based indices still awaiting analysis.
     */
    remainingIssueScreenshotIndices(): number[];

    /**
     * Whether an inconclusive visual review permits one more execution of the same candidate.
     *
     * @param ledgerKey - Composed candidate ledger key.
     * @returns Whether the same candidate may run again.
     */
    canRetryInconclusiveVisualReview(ledgerKey: string): boolean;

    /**
     * Environment bound to one candidate validation artifact.
     *
     * @param validationArtifactId - Runner-owned candidate validation identity.
     * @returns Bound environment, or undefined when this run did not produce the artifact.
     */
    getValidationEnvironment(
        validationArtifactId: string,
    ): AgentRuntimeEnvironmentEvidence | undefined;

    /**
     * Environment bound to one candidate validation only when that session proved its settings.
     *
     * @param validationArtifactId - Runner-owned candidate validation identity.
     * @returns Proof-bound environment, or undefined for control or unverified sessions.
     */
    getVerifiedCandidateEnvironment(
        validationArtifactId: string,
    ): AgentRuntimeEnvironmentEvidence | undefined;
}
