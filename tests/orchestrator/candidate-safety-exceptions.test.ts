import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enforceCandidateSafety } from '../../src/orchestrator/candidate-safety';
import type { ProposeRuleOutcome } from '../../src/orchestrator/agent-runtime-candidate-context';
import { FixOutcomeKind } from '../../src/types/fix-outcome';
import { ProblemType } from '../../src/types/issue-facts';
import { RuleType } from '../../src/types/rule-proposal';

let checkoutPath: string;

/**
 * A verified draft proposing one rule of the given type.
 *
 * @param rule - The proposed rule text.
 * @param ruleType - How the model labelled the rule.
 * @returns The draft outcome.
 */
function draftProposing(rule: string, ruleType: RuleType): ProposeRuleOutcome {
    return {
        outcome: FixOutcomeKind.ProposeRule,
        ruleProposal: {
            rule,
            ruleType,
            risk: { level: 'low', reasons: ['untrusted model claim'] },
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

beforeEach(() => {
    checkoutPath = mkdtempSync(join(tmpdir(), 'candidate-safety-exceptions-'));
    mkdirSync(join(checkoutPath, 'BaseFilter/sections'), { recursive: true });
    writeFileSync(
        join(checkoutPath, 'BaseFilter/sections/specific.txt'),
        'example.com##.existing\n',
    );
});

afterEach(() => {
    rmSync(checkoutPath, { recursive: true, force: true });
});

describe('enforceCandidateSafety exception rules', () => {
    it('accepts a domain-scoped network exception for an incorrect-blocking report', () => {
        const result = enforceCandidateSafety(
            draftProposing('@@||tag.perx.ru/js/container*.js$domain=example.com', RuleType.Network),
            {
                reportedDomain: 'example.com',
                checkoutPath,
                problemType: ProblemType.IncorrectBlocking,
            },
        );

        expect(result.rejectionReason).toBeNull();
        expect(result.outcome.outcome).toBe(FixOutcomeKind.ProposeRule);
    });

    it('accepts a domain-prefixed cosmetic exception for an incorrect-blocking report', () => {
        const result = enforceCandidateSafety(
            draftProposing('example.com#@#.cookie-footer', RuleType.Cosmetic),
            {
                reportedDomain: 'example.com',
                checkoutPath,
                problemType: ProblemType.IncorrectBlocking,
            },
        );

        expect(result.rejectionReason).toBeNull();
        expect(result.outcome.outcome).toBe(FixOutcomeKind.ProposeRule);
    });

    it('accepts a domain-scoped exception for an anti-adblock report', () => {
        // Letting the detector's probe through removed the wall, and the experiment verified it;
        // the gate must keep the rule.
        const result = enforceCandidateSafety(
            draftProposing(
                '@@||pagead2.googlesyndication.com/pagead/js/adsbygoogle.js$xmlhttprequest,domain=example.com',
                RuleType.Network,
            ),
            { reportedDomain: 'example.com', checkoutPath, problemType: ProblemType.AntiAdblock },
        );

        expect(result.rejectionReason).toBeNull();
        expect(result.outcome.outcome).toBe(FixOutcomeKind.ProposeRule);
    });

    it('rejects a generic exception without a domain scope even for incorrect blocking', () => {
        const result = enforceCandidateSafety(
            draftProposing('@@||tag.perx.ru^', RuleType.Network),
            {
                reportedDomain: 'example.com',
                checkoutPath,
                problemType: ProblemType.IncorrectBlocking,
            },
        );

        expect(result.rejectionReason).toMatch(/exactly one positive scope/i);
        expect(result.outcome.outcome).toBe(FixOutcomeKind.AnalysisOnly);
    });

    it('rejects an exception whose repeated domain modifiers reach another site', () => {
        // The blocker applies the rule on every listed domain, so a second `domain=` widens it.
        const result = enforceCandidateSafety(
            draftProposing(
                '@@||ads.test/probe.js$xmlhttprequest,domain=example.com,domain=example.com|other.test',
                RuleType.Network,
            ),
            { reportedDomain: 'example.com', checkoutPath, problemType: ProblemType.AntiAdblock },
        );

        expect(result.rejectionReason).toMatch(/exactly one positive scope/i);
        expect(result.outcome.outcome).toBe(FixOutcomeKind.AnalysisOnly);
    });

    it('rejects exception rules for report classes other than incorrect blocking and anti-adblock', () => {
        const result = enforceCandidateSafety(
            draftProposing('@@||tag.perx.ru/js/container*.js$domain=example.com', RuleType.Network),
            { reportedDomain: 'example.com', checkoutPath, problemType: ProblemType.Ads },
        );

        expect(result.rejectionReason).toMatch(
            /only eligible for incorrect-blocking and anti-adblock/i,
        );
        expect(result.outcome.outcome).toBe(FixOutcomeKind.AnalysisOnly);
    });
});
