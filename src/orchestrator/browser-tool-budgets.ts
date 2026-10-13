/**
 * The per-session call budgets of the two open-ended browser tools, `evaluate_js` and
 * `interact_page`, and the refusals they answer with once spent.
 *
 * Both tools are unbounded by construction — a script, a sequence of clicks — so the budget is what
 * makes a dead end terminate: an unbounded run can spend 102 free-form evaluations re-deriving DOM
 * structure by hand and never apply its candidate. The counters belong to one browser session; a
 * materially different environment gets fresh ones.
 */
import { ToolName } from '../agent/tool-names';

/**
 * Free-form page-script evaluations allowed per browser session.
 *
 * `evaluate_js` is meant for focused facts the structured inspectors do not expose. Unbounded, a
 * run can spend 102 of them re-deriving DOM structure by hand and never apply its candidate, so the
 * budget makes that dead end terminate instead of consuming the whole investigation.
 */
const MAX_EVALUATE_JS_CALLS_PER_SESSION = 25;

/**
 * Interaction rehearsals one browser session may spend.
 *
 * Each rehearsal is a bounded sequence of up to twelve steps, so this funds finding the control
 * that triggers a symptom without funding aimless clicking around the page.
 */
const MAX_INTERACT_PAGE_CALLS_PER_SESSION = 8;

/**
 * The budgets of one browser session's open-ended tools.
 */
export class BrowserToolBudgets {
    /**
     * Free-form page evaluations spent in the active browser session.
     */
    private evaluateJsCalls = 0;

    /**
     * Interaction rehearsals spent in the active browser session.
     */
    private interactPageCalls = 0;

    /**
     * Start the counters over for a new browser session.
     */
    reset(): void {
        this.evaluateJsCalls = 0;
        this.interactPageCalls = 0;
    }

    /**
     * Count one call of a browser tool and refuse it once its budget is spent.
     *
     * @param toolName - The browser tool being dispatched.
     * @returns The typed refusal when the tool's budget is exhausted, else undefined.
     */
    spend(toolName: string): Record<string, unknown> | undefined {
        if (toolName === ToolName.InteractPage) {
            this.interactPageCalls += 1;
            if (this.interactPageCalls > MAX_INTERACT_PAGE_CALLS_PER_SESSION) {
                return {
                    error:
                        `The ${MAX_INTERACT_PAGE_CALLS_PER_SESSION}-rehearsal budget ` +
                        'for page interaction is exhausted for this session.',
                    errorKind: 'interact_page_budget_exhausted',
                    retryable: false,
                    requiredAction: 'decide_with_collected_evidence',
                    guidance: [
                        'Decide from the rehearsal evidence already collected.',
                        'Validate the candidate with apply_rule, or finish with the',
                        'evidence in hand.',
                    ],
                };
            }
        }
        if (toolName === ToolName.EvaluateJs) {
            this.evaluateJsCalls += 1;
            if (this.evaluateJsCalls > MAX_EVALUATE_JS_CALLS_PER_SESSION) {
                return {
                    error:
                        `The ${MAX_EVALUATE_JS_CALLS_PER_SESSION}-call budget for ` +
                        'free-form page evaluation is exhausted for this session.',
                    errorKind: 'evaluate_js_budget_exhausted',
                    retryable: false,
                    requiredAction: 'decide_with_collected_evidence',
                    guidance: [
                        'Use the structured inspectors and captures already collected.',
                        'If a candidate selector is known, validate it with apply_rule.',
                        'Otherwise finish with the evidence in hand.',
                    ],
                };
            }
        }
        return undefined;
    }
}
