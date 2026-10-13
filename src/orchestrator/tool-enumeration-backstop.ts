/**
 * The enumeration backstop: what catches a model searching by one tool call per candidate.
 *
 * The pathology this exists for is NOT repetition. One run spent its entire 35-minute investigation
 * budget and sealed `wall_clock_exceeded` without ever reaching `apply_rule` — 227 tool calls over
 * 168 model turns, 99 of them `stabilize_page`, including one uninterrupted run of 37.
 *
 * Those 37 calls were not identical. Each carried a different `targetSelector` (`.GmL_8 >
 * div:nth-of-type(2)`, `div:has(> img[src*="1789529315"])`, `a[href*="steam"]`, …), and 74 distinct
 * results came back across the 99 calls: `stabilize_page` reports `targetFound`, so the model used
 * it to test one candidate selector per call while the page's `networkEntryCount` went on climbing
 * 96 → 297. A guard on repeated ARGUMENTS would have fired zero times on that run — the longest
 * identical-argument streak in the whole trace is 2, and it is a different tool.
 *
 * So the streak counted here is same-tool-regardless-of-arguments, and the notice tells the model
 * to batch what it has left to check. It never says the answer is already in hand: for this run
 * that would have been false, since every call did answer a different question — one model turn,
 * about 13 seconds on this provider, at a time.
 *
 * The two roles are kept apart on purpose. `stabilize_page`'s catalog guidance is what PREVENTS
 * this misuse, by saying what the target parameter is for and where batch selector tests belong.
 * This module is only the backstop for whatever enumerates next, which is why it names no tool and
 * treats every tool alike.
 *
 * "Every tool" has to mean every tool the session dispatches, so the fix session's tool adapter is
 * where results pass through it. Enumeration comes from repository tools too: a run can spend its
 * 35 minutes on 293 `search_rules` calls — 72 pattern variants for the one rule blocking
 * `player.ex.co`, 234 of them answering nothing — with a 40-call streak that a backstop on the
 * browser-tool tail alone never sees.
 */

/**
 * Consecutive same-tool calls after which the notice rides along with the real result.
 *
 * Picked from the two bands recorded traces actually show. Across 39 recorded runs of every tool,
 * the longest legitimate same-tool streak is 10 (`search_rules`, then `launch_browser` and
 * `evaluate_js` at 9 — each call a genuinely different question no earlier answer could have
 * supplied), while the two runs that exhausted their budget reached 37 (`stabilize_page`) and 40
 * (`search_rules`). Twelve clears the legitimate band with margin, so an honest investigation never
 * meets this notice, and it still leaves most of such a streak's turns for the model to change
 * course and finish the run.
 *
 * Deliberately not configurable: one mechanism with one bound, not a knob to tune per run.
 */
export const ENUMERATION_STREAK_LIMIT = 12;

/**
 * Key the notice travels under, beside the tool result's own fields.
 *
 * A separate key rather than a rewrite of the result: the model must still receive the real answer
 * to the call it just made. This backstop redirects the SEARCH; it never withholds evidence, never
 * refuses the call and never ends the run.
 */
export const ENUMERATION_NOTICE_KEY = 'enumerationNotice';

/**
 * One tripped streak, as the run's evidence records it.
 */
export interface ToolEnumerationStreak {
    /**
     * The tool called consecutively with nothing in between.
     */
    tool: string;

    /**
     * How many consecutive calls of that tool the streak had reached when it tripped.
     */
    consecutiveCalls: number;
}

/**
 * What one run's enumeration backstop needs.
 */
export interface ToolEnumerationBackstopOptions {
    /**
     * Sink invoked exactly once per streak, at the call that trips the bound, so a run's evidence
     * shows the loop was caught without a line per call for the rest of the streak.
     */
    onStreak: (streak: ToolEnumerationStreak) => void;
}

/**
 * One run's attached enumeration backstop.
 */
export interface ToolEnumerationBackstop {
    /**
     * Count one dispatched tool call and hand back what the model should see.
     *
     * @param toolName - The tool that was just dispatched.
     * @param result - The result the model would otherwise receive, unchanged.
     * @returns The same result below the bound; at and above it, the result plus the notice.
     */
    observe: (toolName: string, result: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Compose the notice the model receives once a tool run reaches the bound.
 *
 * The wording is the whole mechanism — it is what breaks the loop — so it states the cost the model
 * cannot see (a call is a model turn), keeps the real result in play, and names the one concrete
 * move that ends the enumeration: collapse the rest of the search into a single `evaluate_js`.
 *
 * @param toolName - The tool called consecutively.
 * @param consecutiveCalls - How many consecutive calls of it have now been made.
 * @returns The sentence added to the tool result.
 */
function enumerationNotice(toolName: string, consecutiveCalls: number): string {
    return (
        `You have now called ${toolName} ${consecutiveCalls} times in a row with no other tool in ` +
        'between. Each call costs a full model turn, and trying one variant per call is what ' +
        'exhausts the investigation budget before a rule is ever validated. The result above is ' +
        'real — use it. Stop repeating this call with new variants: act on what the results so ' +
        'far already show, move on to the next step of the investigation, and if what you are ' +
        'looking for has not turned up by now, record that it was not found instead of searching ' +
        'further. When you still need many answers from the page, get them from one evaluate_js ' +
        'expression that answers them all at once.'
    );
}

/**
 * Build one run's enumeration backstop.
 *
 * A streak is consecutive calls of the same tool with no other tool between them, so a different
 * tool resets the count — the model that interleaves its probes with real work is not enumerating.
 *
 * @param options - The sink recording a tripped streak into the run's evidence.
 * @returns The backstop the session adapter passes every tool result through.
 */
export function createToolEnumerationBackstop(
    options: ToolEnumerationBackstopOptions,
): ToolEnumerationBackstop {
    let streakTool: string | undefined;
    let consecutiveCalls = 0;

    return {
        observe: (toolName: string, result: Record<string, unknown>): Record<string, unknown> => {
            if (toolName === streakTool) {
                consecutiveCalls += 1;
            } else {
                streakTool = toolName;
                consecutiveCalls = 1;
            }
            if (consecutiveCalls < ENUMERATION_STREAK_LIMIT) {
                return result;
            }
            if (consecutiveCalls === ENUMERATION_STREAK_LIMIT) {
                // Once per streak, at the trip: the evidence needs to show the loop was caught,
                // not carry one identical decision event for every call that follows it.
                options.onStreak({ tool: toolName, consecutiveCalls });
            }
            return {
                ...result,
                [ENUMERATION_NOTICE_KEY]: enumerationNotice(toolName, consecutiveCalls),
            };
        },
    };
}
