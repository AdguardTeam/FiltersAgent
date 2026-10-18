import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
    FixOutcomeKind,
    FixOutcomeParametersSchema,
    FixOutcomeSchema,
    ReproductionStatus,
} from '../../src/types/fix-outcome';
import { FixRunStatus } from '../../src/types/fix-run-result';
import { formatIssues } from '../../src/pi/valibot-issues';
import { PolicyDecisionKind } from '../../src/types/policy';
import { DuplicateClass, RiskLevel, RuleType } from '../../src/types/rule-proposal';

/**
 * The contract under test: `finish_fix` shows the model one flat object, because providers refuse a
 * union at the root, while the run validates the submission against the branched result schema. pi
 * checks the flat object before execute, so it must accept every payload the result schema accepts
 * and show every field an outcome takes.
 */

const RULE_PROPOSAL = {
    rule: 'example.org##.marker-ad',
    ruleType: RuleType.Cosmetic,
    risk: { level: RiskLevel.Low, reasons: ['scoped to one site'] },
    placement: {
        filter: 'BaseFilter',
        filePath: 'BaseFilter/sections/foreign.txt',
        confidence: 0.9,
        alternatives: [],
    },
    duplicateCheck: { classification: DuplicateClass.None, matches: [] },
    productCompatibility: { extension: true },
};

/**
 * One accepted payload per outcome branch.
 */
const ACCEPTED_OUTCOMES: Record<string, Record<string, unknown>> = {
    proposeRule: {
        outcome: FixOutcomeKind.ProposeRule,
        ruleProposal: RULE_PROPOSAL,
        policyDecision: {
            decision: PolicyDecisionKind.AllowRuleGeneration,
            reasons: ['reproduced'],
        },
        reasoning: 'Reproduced and verified.',
        evidenceSummary: 'The banner is gone with the rule.',
    },
    notReproduced: {
        outcome: FixOutcomeKind.ProposeClose,
        reproductionStatus: ReproductionStatus.NotReproduced,
        policyDecision: {
            decision: PolicyDecisionKind.AllowRuleGeneration,
            reasons: ['not reproduced'],
        },
        reasoning: 'No ad with the reported setup.',
        evidenceSummary: 'Clean page in the filtered session.',
    },
    policyBlocked: {
        outcome: FixOutcomeKind.ProposeClose,
        reproductionStatus: ReproductionStatus.PolicyBlocked,
        policyDecision: { decision: PolicyDecisionKind.NeedsHumanReview, reasons: ['adult site'] },
        reasoning: 'Policy blocks rule generation.',
        evidenceSummary: 'Not investigated.',
    },
    resolveWithoutPatch: {
        outcome: FixOutcomeKind.ResolveWithoutPatch,
        runStatus: FixRunStatus.AlreadyFixedCurrent,
        reasoning: 'Current lists already block it.',
        evidenceSummary: 'Clean page with the current lists.',
    },
    analysisOnly: {
        outcome: FixOutcomeKind.AnalysisOnly,
        reasoning: 'The site did not load.',
        summary: 'The site was unreachable.',
        rejectedCandidateValidationArtifactId: 'validation-0123456789ab',
    },
    // A rule the review rejected only for the ad layout residue it left travels for review beside
    // the artifact of that same rejection, so a maintainer sees the residue the review named.
    analysisOnlyCarryingResidueRejection: {
        outcome: FixOutcomeKind.AnalysisOnly,
        reasoning: 'The only candidate left a blank column where the sidebar ad was.',
        candidateForReview: {
            rule: 'example.com##.banner',
            placement: { filePath: 'BaseFilter/sections/specific.txt' },
            unverifiedReason:
                'The review rejected it only for ad layout residue: a blank column remains ' +
                'where the sidebar ad was; page integrity intact, no damage observed.',
        },
        rejectedCandidateValidationArtifactId: 'validation-0123456789ab',
    },
};

/**
 * The field names of every object branch of a (possibly nested, possibly piped) variant.
 *
 * @param schema - The variant, object or pipe schema.
 * @returns Each branch's field names.
 */
function branchFields(schema: v.GenericSchema): string[][] {
    if ('pipe' in schema) {
        return branchFields((schema.pipe as v.GenericSchema[]).at(-1)!);
    }
    if ('options' in schema) {
        return (schema.options as v.GenericSchema[]).flatMap(branchFields);
    }
    return [Object.keys((schema as v.ObjectSchema<v.ObjectEntries, undefined>).entries)];
}

describe('finish_fix advertisement', () => {
    it.each(Object.entries(ACCEPTED_OUTCOMES))(
        'lets pi through every payload the result schema accepts: %s',
        (_name, payload) => {
            expect(v.safeParse(FixOutcomeSchema, payload).success).toBe(true);
            expect(v.safeParse(FixOutcomeParametersSchema, payload).success).toBe(true);
        },
    );

    it('refuses a malformed field of another outcome by name, as pi does', () => {
        // pi checks every advertised field's type whatever the outcome, so the result schema must
        // refuse the same call rather than drop the field and accept it.
        const payload = {
            outcome: FixOutcomeKind.AnalysisOnly,
            reasoning: 'The site did not load.',
            ruleProposal: null,
        };

        const parsed = v.safeParse(FixOutcomeSchema, payload);
        expect(parsed.success).toBe(false);
        expect(formatIssues(parsed.issues ?? [])).toMatch(/^ruleProposal:/u);
        expect(v.safeParse(FixOutcomeParametersSchema, payload).success).toBe(false);
    });

    it('drops a well-formed field of another outcome', () => {
        const parsed = v.safeParse(FixOutcomeSchema, {
            ...ACCEPTED_OUTCOMES['analysisOnly'],
            runStatus: FixRunStatus.AlreadyFixedCurrent,
        });

        expect(parsed.success).toBe(true);
        expect(parsed.output).not.toHaveProperty('runStatus');
    });

    it('shows the model every field an outcome takes', () => {
        const advertised = Object.keys(FixOutcomeParametersSchema.entries);
        for (const fields of branchFields(FixOutcomeSchema)) {
            expect(advertised).toEqual(expect.arrayContaining(fields));
        }
    });
});
