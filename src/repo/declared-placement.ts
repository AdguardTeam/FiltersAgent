import { placementRuleTypeOfRule } from './candidate-rule-type';
import {
    declaredPlacementFor,
    type DeclaredPlacement,
    type DeclaredPlacementSet,
} from '../types/declared-placement';

/**
 * The declaration the run's instruction made for this candidate, when it names this target.
 *
 * A declaration settles the edit only for the kind it was written for: a repository that files
 * site-specific hiding and ad servers in different lists declares both, and the cosmetic line has
 * nothing to say about a network candidate. The draft naming the declared file is what makes the
 * declaration apply, and that is also what exempts the candidate from the duplicate-class refusal,
 * because the declaration prescribes its own edit.
 *
 * @param filePath - Repository-relative target filter file of the candidate.
 * @param candidateRule - Locked issue-scoped candidate rule.
 * @param declared - The run instruction's declared placements, when its instruction declares any.
 * @returns The governing declaration, or undefined when none names this target for this kind.
 */
export function declaredPlacementForTarget(
    filePath: string,
    candidateRule: string,
    declared?: DeclaredPlacementSet,
): DeclaredPlacement | undefined {
    const governing = declaredPlacementFor(declared, placementRuleTypeOfRule(candidateRule));
    return governing?.filePath === filePath ? governing : undefined;
}
