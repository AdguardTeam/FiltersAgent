import type { GuardCause } from './guard-types';

/**
 * The seal vocabulary: how one agent session run ended. Every arm of `TerminalOutcome` lives here —
 * the accepted terminal payload and the five ways a run can end without one — so run sealing, the
 * trace mapping, the fix-session seal and the replay failure classifier import the outcome shape
 * without importing each other. The run-guard vocabulary the budget arm references lives in its own
 * leaf, `guard-types.ts`.
 */

/**
 * How a run sealed.
 */
export const SealKind = {
    /**
     * The terminal tool accepted a payload.
     */
    Terminal: 'terminal',

    /**
     * Terminal submissions were rejected up to the cap.
     */
    RejectedTerminal: 'rejected-terminal',

    /**
     * The run ended without an accepted terminal submission after the single nudge re-prompt.
     */
    NoTerminal: 'no-terminal',

    /**
     * A provider failure exhausted the configured retry bounds (or was never transient).
     */
    ProviderFailure: 'provider-failure',

    /**
     * The wall-clock budget or the iteration backstop stopped the run.
     */
    BudgetExceeded: 'budget-exceeded',

    /**
     * The caller aborted the run.
     */
    Aborted: 'aborted',
} as const;

/**
 * SealKind value.
 */
export type SealKind = (typeof SealKind)[keyof typeof SealKind];

/**
 * The run sealed through the terminal tool.
 */
export interface TerminalSealed<T> {
    /**
     * Discriminator: sealed by the terminal tool.
     */
    kind: typeof SealKind.Terminal;

    /**
     * The validated, host-accepted terminal payload.
     */
    payload: T;

    /**
     * Submissions rejected before acceptance.
     */
    rejections: number;
}

/**
 * Which of the terminal tool's two rejection bounds ended the run.
 *
 * They answer different failures and read as different sentences to an operator, so the seal
 * records which one tripped instead of leaving every consumer to describe both: a model stuck
 * against ONE wall is a converging model that ran out of room, while a model alternating between
 * walls never builds a streak and is stopped only by the total ceiling.
 */
export const RejectionCap = {
    /**
     * The same rejection reason repeated up to the streak cap.
     */
    Streak: 'streak',

    /**
     * Rejections accumulated across differing reasons up to the total ceiling.
     */
    Total: 'total',
} as const;

/**
 * RejectionCap value.
 */
export type RejectionCap = (typeof RejectionCap)[keyof typeof RejectionCap];

/**
 * The run sealed after the terminal rejection cap was reached.
 */
export interface RejectedTerminalSealed {
    /**
     * Discriminator: sealed by the rejection cap.
     */
    kind: typeof SealKind.RejectedTerminal;

    /**
     * The last rejection reason shown to the model.
     */
    lastReason: string;

    /**
     * Total rejected submissions.
     */
    rejections: number;

    /**
     * Which bound tripped, so a consumer can state the reason the run ended rather than naming both
     * bounds and letting the reader guess.
     */
    cappedBy: RejectionCap;
}

/**
 * The run ended without an accepted terminal submission.
 */
export interface NoTerminalSealed {
    /**
     * Discriminator: no terminal call.
     */
    kind: typeof SealKind.NoTerminal;

    /**
     * What the model did instead (final reply snippet and stop reason, or the provider/session
     * error message).
     */
    diagnosis: string;
}

/**
 * The run sealed after a provider failure exhausted the configured retry bounds.
 */
export interface ProviderFailureSealed {
    /**
     * Discriminator: sealed by provider failure.
     */
    kind: typeof SealKind.ProviderFailure;

    /**
     * Pi's normalized provider message (HTTP status plus the provider's parsed error body) of the
     * final failed request. It is built from the provider response — never from request credentials
     * — so it carries no secrets.
     */
    message: string;

    /**
     * Whether the provider failure is a deterministic rejection of this exact request (pi's message
     * starts with a `DETERMINISTIC_REJECTION_STATUSES` status). Optional on purpose: the sealing
     * seam always records a boolean, while `undefined` — carried by construction sites that do not
     * care — means transient, the same conservative default as the harvest fallback. Only
     * `deterministic === true` selects `LlmRejected` downstream; absent or `false` means transient,
     * like every non-matching message.
     */
    deterministic?: boolean;

    /**
     * The provider's HTTP status of the final failed request, parsed from `message`'s leading
     * status token; absent when the message carried none. Unlike `message`, this carries no part of
     * the provider's response body — no account identifiers, no URLs — so it is the one piece of a
     * provider failure safe to carry all the way to the public report.
     */
    status?: number;
}

/**
 * The run sealed because an operational bound stopped it.
 */
export interface BudgetExceededSealed {
    /**
     * Discriminator: sealed by a run budget.
     */
    kind: typeof SealKind.BudgetExceeded;

    /**
     * Which bound tripped: the wall-clock budget, the iteration backstop, or the per-request
     * provider deadline.
     */
    budget:
        | typeof GuardCause.WallClock
        | typeof GuardCause.Turns
        | typeof GuardCause.RequestDeadline;

    /**
     * Human-readable detail naming the tripped limit.
     */
    detail: string;
}

/**
 * The run sealed because the caller aborted it — mid-run, or before it ever started.
 */
export interface AbortedSealed {
    /**
     * Discriminator: sealed by caller abort.
     */
    kind: typeof SealKind.Aborted;

    /**
     * Why the run was aborted.
     */
    message: string;
}

/**
 * A run that sealed without an accepted terminal payload. Named because every consumer that has to
 * explain a run without a model decision — the termination-reason mapping, the analysis-only
 * fallbacks — is defined over exactly these arms and never over the accepted one.
 */
export type NonTerminalSeal =
    | RejectedTerminalSealed
    | NoTerminalSealed
    | ProviderFailureSealed
    | BudgetExceededSealed
    | AbortedSealed;

/**
 * The sealed outcome of one agent session run — the only run result the rest of the codebase
 * consumes.
 */
export type TerminalOutcome<T> = TerminalSealed<T> | NonTerminalSeal;
