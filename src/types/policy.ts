import * as v from 'valibot';

export const PolicyDecisionSchema = v.variant('decision', [
    v.object({ decision: v.literal('allow_rule_generation'), reasons: v.array(v.string()) }),
    v.object({ decision: v.literal('needs_human_review'), reasons: v.array(v.string()) }),
    v.object({ decision: v.literal('propose_close'), reasons: v.array(v.string()) }),
]);

export type PolicyDecision = v.InferOutput<typeof PolicyDecisionSchema>;
