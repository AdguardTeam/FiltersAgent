import { describe, expect, it } from 'vitest';
import { validateCandidateScope } from '../../src/orchestrator/terminal-candidate-prerequisites';
import type { TerminalValidationView } from '../../src/orchestrator/terminal-validation-view';
import type { ProposeRuleOutcome } from '../../src/orchestrator/agent-runtime-candidate-context';

/**
 * Build a draft that proposes one rule.
 *
 * @param rule - The proposed rule.
 * @returns The draft outcome.
 */
function draftFor(rule: string): ProposeRuleOutcome {
    return {
        outcome: 'propose_rule',
        ruleProposal: {
            rule,
            ruleType: 'cosmetic',
            risk: { level: 'low', reasons: [] },
            placement: {
                filter: 'BaseFilter',
                filePath: 'BaseFilter/sections/specific.txt',
                confidence: 0.9,
                alternatives: [],
            },
            duplicateCheck: { classification: 'none', matches: [] },
            productCompatibility: { extension: true },
        },
        policyDecision: { decision: 'allow_rule_generation', reasons: [] },
        reasoning: 'Candidate proposed.',
        evidenceSummary: 'Browser evidence.',
    };
}

describe('validateCandidateScope', () => {
    // The judgement reads only the target URLs from the view.
    const view = {
        allowedTargetUrls: ['https://short.link/abc', 'https://article-site.com/news/1'],
    } as unknown as TerminalValidationView;

    it('accepts a rule scoped to the page a reported URL redirected to', () => {
        expect(validateCandidateScope(view, draftFor('article-site.com##.ad'))).toBeUndefined();
    });

    it('still refuses a rule scoped to neither target', () => {
        expect(validateCandidateScope(view, draftFor('other-site.com##.ad'))).toMatchObject({
            errorKind: 'candidate_scope_invalid',
            expectedTargetDomain: 'short.link',
        });
    });
});
