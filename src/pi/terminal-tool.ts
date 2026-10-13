import * as v from 'valibot';
import type { ToolExecutionMode } from '@earendil-works/pi-coding-agent';
import { formatIssues } from './valibot-issues';
import { RejectionCap } from './seal-types';
import { type SessionToolSpec } from './session-tool-types';

/**
 * The terminal tool executes one call at a time. Pi runs a turn's tool calls in parallel by
 * default, and the fingerprint handed from `execute` to the observation of the same call is one
 * slot: two terminal calls in one assistant batch would let the second `execute` overwrite the
 * first call's fingerprint before its observation read it. Sequential execution makes execute →
 * observe strictly ordered per call, which is the invariant the slot relies on.
 */
const TERMINAL_EXECUTION_MODE: ToolExecutionMode = 'sequential';

/**
 * The terminal tool: the single finishing convention of a pi agent session. One mode, one tool.
 * Submissions face two depths of the same contract: pi pre-validates the raw arguments against the
 * advertised schema — the mode's Valibot schema converted verbatim — BEFORE execute runs and
 * bounces violations with its own error text; execute re-validates with Valibot, which is what
 * gives the handler typed input and what a caller invoking execute without pi in front of it relies
 * on, and then runs the optional host-side hook, throwing its rejection reason, which pi returns to
 * the model as a tool error. Either way the model sees the reason and retries in the same session
 * with full context.
 *
 * Rejection counting lives at exactly ONE place — `observeRejection` below, fed by the runner from
 * the session's `tool_execution_end` error events, which both bounce paths surface through.
 * Counting inside execute would miss every pre-`execute` validation bounce and leave a
 * schema-invalid submission loop unbounded. Two DIFFERENT values are kept, because the cap and the
 * sealed outcome ask different questions: `rejections` is the total number of rejected submissions
 * of the run (what the outcome reports, and what an operator reading a seal expects), while
 * `repeatedRejections` is the length of the current same-reason streak (what the cap compares
 * against `maxRejections`). Collapsing them into one counter — the streak, reported as the total —
 * would make a run that failed three different ways seal claiming a single rejection. The cap
 * counts REPEATED rejections: a reason the model has not seen before resets the streak, because a
 * model that changes its answer is still working the problem, while one that resubmits into the
 * same wall is stuck. Both counters are bounded: the streak by `maxRejections`, the total by the
 * wider ceiling `TERMINAL_REJECTION_TOTAL_MULTIPLE` derives from it, so a model alternating between
 * two walls forever — which never builds a streak — still seals as rejected-terminal with its last
 * reason instead of draining the turn budget into a budget-exceeded seal that carries no reason at
 * all. Acceptance settles the run with the validated payload.
 *
 * The simplified knowledge-base pattern (plain cap, no forced-tool-choice reserved turn) is used,
 * with progress awareness on top, because a plain cap seals a healthy run: a summary 39 characters
 * over its limit can be shortened on every retry (439 -> 425 -> 416) and still run out of budget,
 * because a model cannot count characters exactly.
 *
 * What makes two rejections "the same" is the host's business. A host hook may hand back a
 * fingerprint beside the model-facing reason, and the streak then compares fingerprints; a host
 * that gives none, and every pre-`execute` schema bounce, is compared by reason text. The
 * distinction exists because the text of a rejection can stay word-for-word identical while the
 * model does exactly the browser work it asks for: compared by text alone, three same-text
 * rejections whose progress counters moved between them would seal a fix run that is progressing.
 */

/**
 * Default cap on CONSECUTIVE identical rejections before the run seals as rejected-terminal.
 *
 * Every rejection returns the full validation reasons to the model, so three submissions that hit
 * the same wall are pathological rather than unlucky. A different reason means the model moved, so
 * the streak starts over and the run is not sealed while it is still converging; the total
 * rejection count keeps rising across those resets and is bounded only by the wider ceiling
 * `TERMINAL_REJECTION_TOTAL_MULTIPLE` derives.
 */
export const DEFAULT_MAX_TERMINAL_REJECTIONS = 3;

/**
 * How many streak caps' worth of rejections the total ceiling allows, absent an explicit one.
 *
 * The ceiling exists only for the failure the streak cap cannot see: a model that alternates
 * between two walls holds its streak at 1 forever. Three times the streak cap leaves the converging
 * case untouched — the shortening summary above needs three distinct reasons (439 -> 425 -> 416
 * characters) and a converging model runs out of distinct reasons quickly — while bounding the
 * alternating one at a small multiple of the budget a stuck model already gets. It scales with
 * `maxRejections`, so a mode that tightens the streak cap tightens the ceiling too.
 */
export const TERMINAL_REJECTION_TOTAL_MULTIPLE = 3;

/**
 * Terminal kinds of the terminal-tool settlement.
 */
export const TerminalSettlement = {
    /**
     * A submission passed schema and host validation; the run seals with its payload.
     */
    Accepted: 'accepted',

    /**
     * The rejection cap was reached; the run seals as rejected-terminal.
     */
    Capped: 'capped',
} as const;

/**
 * TerminalSettlement value.
 */
export type TerminalSettlement = (typeof TerminalSettlement)[keyof typeof TerminalSettlement];

/**
 * How the terminal tool settled — exactly once per run.
 */
export type TerminalToolSettlement<T> =
    | {
          /**
           * Discriminator: an accepted submission.
           */
          kind: typeof TerminalSettlement.Accepted;

          /**
           * The payload that passed schema and host validation.
           */
          payload: T;
      }
    | {
          /**
           * Discriminator: the rejection cap was reached.
           */
          kind: typeof TerminalSettlement.Capped;

          /**
           * The last rejection reason shown to the model.
           */
          lastReason: string;

          /**
           * Which of the two bounds tripped.
           */
          cappedBy: RejectionCap;
      };

/**
 * One host-side rejection of a schema-valid terminal payload.
 */
export interface TerminalHostRejection {
    /**
     * The model-facing reason, returned to the model as the tool error text.
     */
    reason: string;

    /**
     * Identity of the rejection for the same-reason streak: two rejections with equal fingerprints
     * count as the model resubmitting into the same wall. Absent, the reason text is the identity.
     */
    fingerprint?: string;
}

/**
 * Options for building one mode's terminal tool.
 */
export interface TerminalToolOptions<T> {
    /**
     * Tool name the model calls to finish the run (mode-owned, e.g. `finish_fix`).
     */
    name: string;

    /**
     * Model-facing description: what to submit and when to call it.
     */
    description: string;

    /**
     * The mode's result schema; every submission is validated against it.
     */
    schema: v.GenericSchema<T>;

    /**
     * Optional host-side check run after schema validation. Returns the rejection — the reason
     * shown to the model and, optionally, its streak fingerprint — or `undefined` to accept.
     */
    validateHost?: (
        payload: T,
    ) => Promise<TerminalHostRejection | undefined> | TerminalHostRejection | undefined;

    /**
     * Cap on the current same-reason rejection streak before the run seals as rejected-terminal.
     * The ceiling on the run's TOTAL rejections is derived from it by
     * `TERMINAL_REJECTION_TOTAL_MULTIPLE` and is not separately configurable: the two bounds answer
     * the same question at different scales, and a mode that tightens one must tighten the other.
     */
    maxRejections?: number;
}

/**
 * Handle the session runner uses to observe the terminal tool: the one-shot settlement, live
 * rejection state for the sealed outcome, and the observation channel through which EVERY rejected
 * submission — pi's pre-`execute` validation bounces and execute-thrown rejections alike — is
 * counted exactly once against the cap.
 */
export interface TerminalToolController<T> {
    /**
     * The tool to advertise (handed to the session runner in the tool set).
     */
    tool: SessionToolSpec;

    /**
     * Resolves when the tool accepts a payload or the rejection cap is reached.
     */
    settled: Promise<TerminalToolSettlement<T>>;

    /**
     * TOTAL number of rejected submissions observed so far (all bounce paths, none counted twice),
     * across every reason. This is the value the sealed outcome reports; it never resets, and the
     * run seals once it reaches the derived total ceiling.
     *
     * @returns The total rejection count.
     */
    rejections: () => number;

    /**
     * Length of the CURRENT same-reason rejection streak: the value the cap compares against
     * `maxRejections`. Starts over at 1 whenever the model submits into a different wall, so a
     * converging model keeps its turn even though its total rejection count keeps rising.
     *
     * @returns The current same-reason streak.
     */
    repeatedRejections: () => number;

    /**
     * The accepted payload, when settled accepted.
     *
     * @returns The payload or `undefined` before acceptance.
     */
    accepted: () => T | undefined;

    /**
     * The last rejection reason, when any rejection happened.
     *
     * @returns The reason or `undefined`.
     */
    lastReason: () => string | undefined;

    /**
     * Record one terminal tool result the session reported as an error. The runner calls this from
     * its `tool_execution_end` subscription, so pi-worded schema bounces and our own execute-thrown
     * reasons flow through the same counter. A no-op once the controller has settled (accepted or
     * capped), including for the 'already accepted' refusal result.
     *
     * @param reason - The model-facing error text of the tool result.
     */
    observeRejection: (reason: string) => void;
}

/**
 * Build one mode's terminal tool and its controller.
 *
 * @param options - Tool identity, result schema, host hook, and rejection cap.
 * @returns The controller the session runner observes.
 */
export function buildTerminalTool<T>(options: TerminalToolOptions<T>): TerminalToolController<T> {
    const maxRejections = options.maxRejections ?? DEFAULT_MAX_TERMINAL_REJECTIONS;
    const maxTotalRejections = maxRejections * TERMINAL_REJECTION_TOTAL_MULTIPLE;
    let acceptedPayload: T | undefined;
    let rejections = 0;
    let repeatedRejections = 0;
    let lastRejection: string | undefined;
    let lastFingerprint: string | undefined;
    // Set by execute for the host rejection it is about to throw, consumed by the observation of
    // that same tool result. The tool is declared sequential (`TERMINAL_EXECUTION_MODE`), so
    // execute and the runner's `tool_execution_end` observation of one call never interleave with
    // another call of this tool, and at most one fingerprint is ever pending.
    let pendingFingerprint: string | undefined;
    let settled = false;
    let settle!: (settlement: TerminalToolSettlement<T>) => void;
    const settlement = new Promise<TerminalToolSettlement<T>>((resolve) => {
        settle = resolve;
    });
    const settleOnce = (value: TerminalToolSettlement<T>): void => {
        if (settled) {
            return;
        }
        settled = true;
        settle(value);
    };
    const observeRejection = (reason: string): void => {
        if (settled) {
            return;
        }
        rejections += 1;
        const fingerprint = pendingFingerprint ?? reason;
        pendingFingerprint = undefined;
        repeatedRejections = fingerprint === lastFingerprint ? repeatedRejections + 1 : 1;
        lastFingerprint = fingerprint;
        lastRejection = reason;
        // Either bound seals: the streak catches a model stuck against one wall, the total catches
        // one alternating between walls without ever building a streak. The streak is reported
        // when both are reached on the same submission — it is the more specific diagnosis, and it
        // is the bound the model could have avoided by changing its answer.
        if (repeatedRejections >= maxRejections) {
            settleOnce({
                kind: TerminalSettlement.Capped,
                lastReason: reason,
                cappedBy: RejectionCap.Streak,
            });
        } else if (rejections >= maxTotalRejections) {
            settleOnce({
                kind: TerminalSettlement.Capped,
                lastReason: reason,
                cappedBy: RejectionCap.Total,
            });
        }
    };
    const tool: SessionToolSpec = {
        name: options.name,
        description: options.description,
        parameters: options.schema,
        executionMode: TERMINAL_EXECUTION_MODE,
        execute: async (args) => {
            if (acceptedPayload !== undefined) {
                throw new Error(
                    `${options.name}: a terminal payload was already accepted; the run is sealed`,
                );
            }
            const parsed = v.safeParse(options.schema, args);
            if (!parsed.success) {
                // Throw only: the runner's tool_execution_end observation counts this once.
                throw new Error(
                    `${options.name}: invalid payload (${formatIssues(parsed.issues)})`,
                );
            }
            const rejection = await options.validateHost?.(parsed.output);
            if (rejection !== undefined) {
                pendingFingerprint = rejection.fingerprint;
                // The model must see the budget it is spending: otherwise a run can die on its
                // third attempt without the model knowing it was the last.
                throw new Error(
                    `${options.name}: rejected (${rejection.reason}) ` +
                        `[rejected submission ${rejections + 1}; the run seals after ` +
                        `${maxRejections} consecutive rejections without evidence progress]`,
                );
            }
            acceptedPayload = parsed.output;
            settleOnce({ kind: TerminalSettlement.Accepted, payload: parsed.output });
            return {
                content: `${options.name} accepted the terminal payload; the run is sealed.`,
                details: { payload: parsed.output },
            };
        },
    };
    return {
        tool,
        settled: settlement,
        rejections: () => rejections,
        repeatedRejections: () => repeatedRejections,
        accepted: () => acceptedPayload,
        lastReason: () => lastRejection,
        observeRejection,
    };
}
