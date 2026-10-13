import { PlacementRuleType } from '../types/placement-rule-type';
import { RuleKind, normalizeRule } from './rule-normalizer';

/**
 * The one authority on which placement kind a candidate rule is.
 *
 * The run instruction declares placements per rule kind, and every check of a draft against a
 * declaration — the terminal placement check, the edit planner, the candidate safety gate — asks
 * which kind the candidate is. A second spelling of this mapping would let a rule be a scriptlet
 * for one of them and cosmetic for another, and the declaration for a kind would then silently miss
 * the candidate it was written for.
 */

/**
 * Infer the placement type of one raw candidate rule line.
 *
 * @param rule - Exact candidate rule text.
 * @returns Placement rule type, or undefined for non-actionable syntax.
 */
export function placementRuleTypeOfRule(rule: string): PlacementRuleType | undefined {
    const candidate = normalizeRule(rule);
    if (candidate.isException) {
        return PlacementRuleType.Exception;
    }
    if (candidate.kind === RuleKind.Scriptlet) {
        return PlacementRuleType.Scriptlet;
    }
    if (candidate.kind === RuleKind.Network) {
        return PlacementRuleType.Network;
    }
    if (candidate.kind === RuleKind.Cosmetic) {
        return PlacementRuleType.Cosmetic;
    }
    return undefined;
}
