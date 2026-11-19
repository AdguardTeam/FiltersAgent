/**
 * What a draft's candidate must satisfy before `finish_fix` may lock it, checked while the model
 * can still fix it: the rule is scoped to the reported domain alone, and it can be inserted into
 * the file the draft names.
 *
 * Both are retryable prerequisites of the terminal judgement (`terminal-outcome-validator`), kept
 * here so that module stays inside the repo's ~500-line rule.
 */
import { ToolName } from '../agent/tool-names';
import { candidatePlacementProblem } from '../repo/candidate-placement-check';
import { normalizeRule } from '../repo/rule-normalizer';
import type { FinishFixValidationRejection } from '../types/terminal-rejection';
import {
    reportedDomainFromAllowedTargets,
    type ProposeRuleOutcome,
} from './agent-runtime-candidate-context';
import { candidateScopeProblem, normalizeScopeDomain } from './candidate-scope';
import type { TerminalValidationView } from './terminal-validation-view';

/**
 * Return a draft whose rule is not scoped to the reported domain alone to the model, while it can
 * still fix it.
 *
 * The safety gate refuses such a draft after the run has sealed, and the model never learns why: a
 * vision-verified fix ends as analysis-only when the submitted rule is the merged line of an
 * extension plan (the existing rule's three domains plus the reported one). The common way here is
 * exactly that, so the recovery names it: submit the rule for the reported domain alone and let the
 * host extend the existing rule.
 *
 * @param view - Read-only projection of the run the judgement reads.
 * @param outcome - Schema-valid draft decision proposed by the model.
 * @returns Retryable scope prerequisite, or undefined when the draft is scoped as required.
 */
export function validateCandidateScope(
    view: TerminalValidationView,
    outcome: ProposeRuleOutcome,
): FinishFixValidationRejection | undefined {
    const reportedDomain = reportedDomainFromAllowedTargets(view.allowedTargetUrls);
    if (reportedDomain === undefined) {
        return undefined;
    }
    const candidate = normalizeRule(outcome.ruleProposal.rule);
    // A reported URL that redirected to another site adds that site's page as a target: a rule
    // scoped to any target's domain is scoped to the reported page.
    const inScope = view.allowedTargetUrls.some((url) => {
        const domain = reportedDomainFromAllowedTargets([url]);
        return domain !== undefined && candidateScopeProblem(candidate, domain) === undefined;
    });
    if (inScope) {
        return undefined;
    }
    const problem = candidateScopeProblem(candidate, reportedDomain)!;
    return {
        error:
            `${problem} When the fix extends an existing rule's domain list, the candidate is ` +
            'still the rule scoped to the reported domain alone: validate that rule with ' +
            'apply_rule, submit it in finish_fix, and the host merges it into the existing rule.',
        errorKind: 'candidate_scope_invalid',
        retryable: true,
        requiredAction: 'scope_candidate_to_reported_domain',
        requiredTool: ToolName.ApplyRule,
        candidateRule: candidate.canonical,
        expectedTargetDomain: normalizeScopeDomain(reportedDomain),
    };
}

/**
 * Return a draft whose rule cannot be inserted where it names to the model, with the reason, while
 * it can still choose another file or place.
 *
 * The agent decides where the rule goes. This only checks that the edit is possible — the file is
 * one of the repository's own lists, it exists, it is the file the run instruction declares for
 * rules of this kind when it declares one, and the position can take a new line — so the patch the
 * run publishes lands in the file and at the place the agent chose.
 *
 * @param view - Read-only projection of the run the judgement reads.
 * @param outcome - Schema-valid draft decision proposed by the model.
 * @returns Retryable placement prerequisite, or undefined when the rule can be inserted there.
 */
export function validateCandidatePlacement(
    view: TerminalValidationView,
    outcome: ProposeRuleOutcome,
): FinishFixValidationRejection | undefined {
    if (view.placementContext === undefined) {
        return undefined;
    }
    const { rule, placement } = outcome.ruleProposal;
    const problem = candidatePlacementProblem(
        view.placementContext,
        rule,
        placement.filePath,
        placement.position,
    );
    if (problem === undefined) {
        return undefined;
    }
    return {
        error:
            `The rule cannot go where the draft puts it: ${problem} Choose the file and the ` +
            'place from search_rules, its outline or a window.',
        errorKind: 'candidate_placement_not_insertable',
        retryable: true,
        requiredAction: 'choose_insertable_placement',
        requiredTool: ToolName.FinishFix,
        candidateRule: normalizeRule(rule).canonical,
        filePath: placement.filePath,
        // The refused position travels with the file so the streak follows the agent's answer: no
        // position, a sorted position and a chosen line are different walls, not one repeated one.
        position: placement.position ?? null,
    };
}
