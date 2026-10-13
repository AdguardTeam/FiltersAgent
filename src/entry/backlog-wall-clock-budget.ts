/**
 * Backlog loop wall-clock budgeting.
 *
 * A hosted Actions job has a hard 6-hour cap; an unbounded backlog loop taking up to the full queue
 * limit, each issue paying its own investigation budget, can run past it — and a job GitHub kills
 * mid-run never reaches its `finally`, leaving no entry result, no handover, and no upload. The
 * loop instead stops taking new issues once the time remaining could not fit one more issue's own
 * budget, so it always exits through its own seal.
 */

/**
 * One decision point of the backlog loop's wall-clock budget.
 */
export interface BacklogWallClockBudget {
    /**
     * The loop's total wall-clock budget, in milliseconds.
     */
    budgetMs: number;

    /**
     * The most one more issue's investigation could still cost, reserved before starting it.
     */
    perIssueBudgetMs: number;

    /**
     * Milliseconds elapsed since the loop started, sampled by the caller's own clock just before
     * this decision.
     */
    elapsedMs: number;
}

/**
 * Decide whether the backlog loop may still start one more issue.
 *
 * Contract: an issue may start only while the budget remaining (`budgetMs - elapsedMs`) is at least
 * `perIssueBudgetMs` — so a started issue is never cut off mid-investigation by the loop's own
 * bookkeeping, only by the issue's own per-investigation budget. The moment the remaining budget
 * falls short, this returns false for every later issue too, since elapsed time only grows.
 *
 * @param budget - The loop's wall-clock budget and per-issue reservation, with the elapsed time
 *   sampled just before this decision.
 * @returns True when enough budget remains to reserve a full per-issue investigation.
 */
export function canStartAnotherBacklogIssue(budget: BacklogWallClockBudget): boolean {
    return budget.budgetMs - budget.elapsedMs >= budget.perIssueBudgetMs;
}
