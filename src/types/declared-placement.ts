import type { PlacementRuleType } from './placement-rule-type';

/**
 * The placement a run instruction declared, rendered for one run.
 *
 * The instruction owns the declaration ({@link InstructionPlacement} in
 * `src/knowledge/instruction-placement.ts`); this is what it renders to for this run — the exact
 * file the rule goes into and the exact comment line that precedes it. Both the terminal placement
 * check and the repository-edit planner read it, so it lives in the shared vocabulary rather than
 * in either of them.
 */

/**
 * One run's declared placement: where the rule goes, and what is written above it.
 */
export interface DeclaredPlacement {
    /**
     * Checkout-relative file the instruction declared, with its `{{year}}` rendered.
     */
    filePath: string;

    /**
     * Comment line written immediately before the rule, with its `{{issueUrl}}` rendered; absent
     * when the declaration asks for no comment.
     */
    commentLine?: string;
}

/**
 * Every placement one run instruction declared, rendered for one run.
 *
 * A repository files by rule kind — EasyList keeps site-specific hiding in
 * `easylist_specific_hide.txt`, site-specific blocking in `easylist_specific_block.txt` and ad
 * servers in `easylist_adservers.txt` — which one declared file cannot express. Each kind may name
 * its own file, and one declaration may name no kind at all and cover the rest.
 */
export interface DeclaredPlacementSet {
    /**
     * Declarations that named a rule kind, keyed by that kind.
     */
    byRuleType: Partial<Record<PlacementRuleType, DeclaredPlacement>>;

    /**
     * The declaration that named no kind; it covers every kind without a line of its own. Absent
     * when every declaration named a kind, which leaves the other kinds to the default.
     */
    unqualified?: DeclaredPlacement;
}

/**
 * Resolve the placement one run declared for a candidate of this kind.
 *
 * @param declared - The run's rendered declarations, when its instruction carries any.
 * @param ruleType - Placement kind of the candidate, or undefined when its syntax names none.
 * @returns The declaration governing this candidate, or undefined when the default decides.
 */
export function declaredPlacementFor(
    declared: DeclaredPlacementSet | undefined,
    ruleType: PlacementRuleType | undefined,
): DeclaredPlacement | undefined {
    if (declared === undefined) {
        return undefined;
    }
    const qualified = ruleType === undefined ? undefined : declared.byRuleType[ruleType];
    return qualified ?? declared.unqualified;
}
