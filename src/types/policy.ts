import * as v from 'valibot';

/**
 * What the policy decided about automatic rule generation — the `decision` discriminant of every
 * policy decision a fix outcome carries.
 */
export const PolicyDecisionKind = {
    /**
     * Nothing blocks generating a rule.
     */
    AllowRuleGeneration: 'allow_rule_generation',

    /**
     * A human has to look at the issue before any rule is generated.
     */
    NeedsHumanReview: 'needs_human_review',

    /**
     * The issue should be closed without a rule.
     */
    ProposeClose: 'propose_close',
} as const;

/**
 * PolicyDecisionKind value.
 */
export type PolicyDecisionKind = (typeof PolicyDecisionKind)[keyof typeof PolicyDecisionKind];

export const PolicyDecisionSchema = v.variant('decision', [
    v.object({
        decision: v.literal(PolicyDecisionKind.AllowRuleGeneration),
        reasons: v.array(v.string()),
    }),
    v.object({
        decision: v.literal(PolicyDecisionKind.NeedsHumanReview),
        reasons: v.array(v.string()),
    }),
    v.object({
        decision: v.literal(PolicyDecisionKind.ProposeClose),
        reasons: v.array(v.string()),
    }),
]);

export type PolicyDecision = v.InferOutput<typeof PolicyDecisionSchema>;
