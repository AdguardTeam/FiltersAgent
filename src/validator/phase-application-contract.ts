import type { ActionLogEntry } from '../environment/environment-proofs';
import type { FilterListKey } from '../environment/filter-list-ref';
import type { SettingsLimitation } from '../environment/settings-limitation';
import type { Logger } from '../logger/logger';
import type { ApplicationInstructionRefusal } from '../knowledge/instruction-application';
import type { BlockerStateRead, BlockerStateReaderRegistry } from './blocker-state-readers';

/**
 * The declared vocabulary of the between-phases rules application: the goal a run performs toward,
 * its typed outcomes, the bounded session bounds, and the runner seam the orchestrator implements
 * the application itself over.
 *
 * The shape both sides code against: something performs the instruction's steps, the host reads the
 * state back itself and credits only an exact match, and the action log comes from the host's own
 * record of what ran, never from a model's self-report. Two kinds of runner satisfy that seam today
 * — a bounded model session for an instruction that writes its own application steps, and the
 * host's own fixed message protocol on the built-in AdGuard route — and the procedure around them
 * cannot tell which it was handed.
 */

/**
 * What one between-phases application is asked to bring the blocker to.
 */
export const ApplicationGoalKind = {
    /**
     * Restore the prepared baseline: no candidate present, the previously proved filter set
     * enabled.
     */
    Baseline: 'baseline',

    /**
     * Apply the candidate rule exactly as written, changing nothing else.
     */
    Candidate: 'candidate',
} as const;

/**
 * ApplicationGoalKind value.
 */
export type ApplicationGoalKind = (typeof ApplicationGoalKind)[keyof typeof ApplicationGoalKind];

/**
 * The expected blocker state one application run is credited against.
 */
export type ApplicationGoal =
    | {
          /**
           * Plugging the baseline back in: the enabled filter set must equal the prepared one again
           * and no user rule may be present in the credited state.
           */
          kind: typeof ApplicationGoalKind.Baseline;
      }
    | {
          /**
           * The exact rule content the applied state must contain, one line per rule.
           */
          kind: typeof ApplicationGoalKind.Candidate;

          /**
           * The exact candidate rule content, newline-joined when it is a bounded set of lines.
           */
          rule: string;
      };

/**
 * How one application run ended.
 */
export const PhaseApplicationOutcomeKind = {
    /**
     * The host read the state back and it contains exactly the goal's expected content.
     */
    Applied: 'applied',

    /**
     * The instruction's application contract is missing or unsupported: no model turn was made.
     */
    Refused: 'refused',

    /**
     * The steps ran but the state read back does not contain exactly the expected content.
     */
    Unverified: 'unverified',
} as const;

/**
 * PhaseApplicationOutcomeKind value.
 */
export type PhaseApplicationOutcomeKind =
    (typeof PhaseApplicationOutcomeKind)[keyof typeof PhaseApplicationOutcomeKind];

/**
 * Turn cap of one model-driven application session.
 *
 * This bound and {@link APPLICATION_SESSION_BUDGET_MS} govern the model-driven path alone — an
 * instruction that writes its own `## Rule application` steps. The host-performed runner of the
 * built-in AdGuard route spends no turns and is bounded by its own extension-readiness deadline and
 * the request's abort signal instead.
 *
 * Why this value: application is a bounded procedure of enumerated steps, not an investigation. The
 * built-in AdGuard instruction's flow is six steps (open the options page, wait for the bootstrap,
 * import, confirm, save, report), several of them repeat a message, and a call pi rejects spends a
 * turn too. Ten turns leave a live model no headroom for that: application sessions capped at ten
 * end at the cap without their terminal payload. This is one shared bound for every application
 * instruction, never a per-blocker knob.
 */
export const APPLICATION_SESSION_MAX_TURNS = 16;

/**
 * Wall-clock budget of one model-driven application session in milliseconds.
 *
 * Like {@link APPLICATION_SESSION_MAX_TURNS} this governs the model-driven path alone; the
 * host-performed AdGuard runner is bounded by its readiness deadline and the abort signal.
 *
 * Why this value: the 30-minute apply_rule deadline hosts two model-driven application passes plus
 * the observation phases they bracket. A pass is paced by the model, not by the browser: a typical
 * model takes 20-50 seconds a turn, so the enumerated steps alone outlast a three-minute budget,
 * and application sessions under one end without their terminal payload. Six minutes fits the steps
 * at that pace and leaves the observations more than half of the deadline. One shared bound for
 * every application instruction, never a per-blocker knob.
 */
export const APPLICATION_SESSION_BUDGET_MS = 6 * 60_000;

/**
 * Resolved bounds of one model-driven application session.
 *
 * A host-performed runner receives these too — the procedure resolves them before it knows which
 * runner it holds — and ignores them: it spends no turns and bounds itself by the extension
 * readiness deadline and the request's abort signal.
 */
export interface PhaseApplicationBudget {
    /**
     * Turn cap of the bounded application session.
     */
    turns: number;

    /**
     * Wall-clock budget of the bounded application session in milliseconds.
     */
    budgetMs: number;
}

/**
 * The session one application runs over: the phase lease context the model's page tools act in.
 */
export interface PhaseApplicationSession {
    /**
     * The reported target page the lease observes, for the prompt's target fill.
     */
    targetUrl: string;

    /**
     * The prepared blocker's own management surface (its options page). Exactly this protocol and
     * host are admitted for application sessions; every other navigation is refused.
     */
    blockerSurfaceUrl?: string;

    /**
     * The host-built settings payload the task hands to the session, expressed in the extension's
     * own configuration keys. Absent means no payload was prepared; the task renders an empty
     * fill.
     */
    settingsPayload?: string;

    /**
     * Exact Tracking-protection state the prepared expectation requires the read-back to carry.
     * Absent means no exact expectation is in hand, so a read-back that observes the state still
     * credits on the rules content and enabled filter set alone.
     */
    expectStealthEnabled?: boolean;

    /**
     * Free-form caller context rendered into the session-notes fill.
     */
    notes?: string;

    /**
     * Enabled filter list key set the environment previously proved, compared as a set against the
     * read-back for the Baseline goal.
     */
    baselineEnabledFilterIds?: readonly FilterListKey[];
}

/**
 * Whoever performs one application's steps over the phase lease.
 *
 * Two implementations satisfy it: a bounded model session driving an instruction's own written
 * steps (`orchestrator/application-session.ts`), and the host performing the built-in AdGuard
 * route's fixed message protocol itself (`orchestrator/host-extension-application.ts`). The
 * procedure that calls it never learns which — it reads the blocker state back itself either way
 * and credits only an exact match.
 */
export interface PhaseApplicationRunner {
    /**
     * Run the one application pass.
     *
     * @param request - The rendered task prompt, the lease session, the resolved budget, and the
     *   cancellation signal.
     * @returns How the pass ended and the host-recorded trace of what ran.
     */
    run(request: PhaseApplicationRunnerRequest): Promise<PhaseApplicationRunnerResult>;
}

/**
 * What one runner invocation receives.
 */
export interface PhaseApplicationRunnerRequest {
    /**
     * The rendered application task document. A host-performed runner ignores it: the procedure
     * renders it before it knows which runner it holds, and the host follows the protocol in code.
     */
    prompt: string;

    /**
     * The phase lease session the page tools act in.
     */
    session: PhaseApplicationSession;

    /**
     * Resolved session bounds.
     */
    budget: PhaseApplicationBudget;

    /**
     * Caller cancellation, when the outer deadline provided one.
     */
    signal?: AbortSignal;
}

/**
 * How one runner's pass ended, with the host-recorded trace of what it did.
 */
export interface PhaseApplicationRunnerResult {
    /**
     * Whether the pass performed every step it was asked to: a model session ending with an
     * accepted terminal payload, or a host runner completing its protocol. The application verdict
     * never depends on this: the host read-back decides, even when the pass reports a failed step.
     */
    completed: boolean;

    /**
     * Bounded detail of the non-completed ending, naming the step that did not finish.
     */
    detail?: string;

    /**
     * The host-recorded steps of the pass: a model session's tool calls as the host saw them, or
     * the host's own protocol steps — never a model's self-report.
     */
    actionLog: ActionLogEntry[];
}

/**
 * Input of one between-phases application run.
 */
export interface PhaseApplicationInput {
    /**
     * Run instruction text whose application contract the procedure parses first.
     */
    application: string;

    /**
     * Expected blocker state the application is credited against.
     */
    goal: ApplicationGoal;

    /**
     * The phase lease session the application run acts over.
     */
    session: PhaseApplicationSession;

    /**
     * Whoever performs the application's steps: a bounded model session, or the host itself.
     */
    runner: PhaseApplicationRunner;

    /**
     * Reader registry the executor supplies; a declared method absent here is a refusal.
     */
    readBack: BlockerStateReaderRegistry;

    /**
     * Session-bound overrides; defaults to the named application-session constants.
     */
    budget?: Partial<PhaseApplicationBudget>;

    /**
     * Caller cancellation, threaded into the runner.
     */
    signal?: AbortSignal;

    /**
     * Application logger; one default logger otherwise.
     */
    logger?: Logger;
}

/**
 * Result of one between-phases application run.
 */
export type PhaseApplicationResult =
    | {
          /**
           * Discriminator: the state read back contains exactly the goal's expected content.
           */
          kind: typeof PhaseApplicationOutcomeKind.Applied;

          /**
           * Host-assembled tool trace of the application session.
           */
          actionLog: ActionLogEntry[];

          /**
           * The blocker state the host read back itself.
           */
          readBack: BlockerStateRead;

          /**
           * Optional record of what the credit could not observe: a file-backed read-back cannot
           * report the enabled filter set, so its baseline is credited on the empty user-rules
           * state alone and its candidate on the exact user-rules content alone.
           */
          detail?: string;
      }
    | (ApplicationInstructionRefusal & {
          /**
           * Discriminator: the application contract refused before any model turn.
           */
          kind: typeof PhaseApplicationOutcomeKind.Refused;
      })
    | {
          /**
           * Discriminator: steps ran, but the read-back does not contain exactly the expectation.
           */
          kind: typeof PhaseApplicationOutcomeKind.Unverified;

          /**
           * Bounded detail naming the mismatch or the failure the verification hit.
           */
          detail: string;

          /**
           * The browser limit that made the expectation unreachable, when the credit diagnosed one:
           * the detail says it in prose, this says it to code.
           */
          settingsLimitation?: SettingsLimitation;

          /**
           * Host-assembled tool trace of the application session.
           */
          actionLog: ActionLogEntry[];
      };
