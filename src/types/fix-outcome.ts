import * as v from 'valibot';
import { RuleProposalSchema } from './rule-proposal';
import { PolicyDecisionKind, PolicyDecisionSchema } from './policy';
import { NO_PATCH_RUN_STATUSES } from './fix-run-result';
import { CandidateForReviewSchema } from './candidate-for-review';

/**
 * Explicit reason a propose-close outcome is safe to publish.
 */
export const ReproductionStatus = {
    /**
     * A usable browser ran but did not reproduce the reported defect.
     */
    NotReproduced: 'not_reproduced',

    /**
     * Deterministic policy blocked automatic rule generation regardless of reproduction.
     */
    PolicyBlocked: 'policy_blocked',
} as const;

/**
 * The disposition a fix run ends in — the `outcome` discriminant of every `FixOutcome` variant.
 *
 * The value is a cross-module contract: the terminal tool validates it, the seal paths build it,
 * and the runner, the publisher and the analyze renderer all branch on it. Declared once here
 * beside the schema that owns it so no consumer respells the string.
 */
export const FixOutcomeKind = {
    /**
     * A validated, low-risk rule plus its placement, risk, and duplicate check — propose the rule.
     */
    ProposeRule: 'propose_rule',

    /**
     * Close the issue: either usable negative browser evidence or a deterministic policy block.
     */
    ProposeClose: 'propose_close',

    /**
     * Browser-proven resolution that requires no repository patch.
     */
    ResolveWithoutPatch: 'resolve_without_patch',

    /**
     * Reasoning-only findings with no verified terminal disposition — no GitHub writes.
     */
    AnalysisOnly: 'analysis_only',
} as const;

/**
 * FixOutcomeKind value.
 */
export type FixOutcomeKind = (typeof FixOutcomeKind)[keyof typeof FixOutcomeKind];

/**
 * Ceiling on the model-authored summary, enforced at the schema so the text is complete by
 * construction: a reviewer needs whole sentences from the agent, not a mechanical mid-sentence cut,
 * and a bound the model must fit is the only way to guarantee no downstream truncation. The ceiling
 * is generous because a model writes to the feel of the instruction rather than a character count,
 * so a tight ceiling turns honest summaries into rejected submissions; the instruction, not the
 * bound, is what keeps the text short.
 */
export const MAX_SUMMARY_LENGTH = 1_000;

/**
 * Model-authored brief account of the run for a human reviewer.
 */
const SummarySchema = v.optional(
    v.pipe(
        v.string(),
        v.maxLength(MAX_SUMMARY_LENGTH),
        v.description(
            'One or two complete plain-language sentences for a human reviewer: what was ' +
                'found and why this outcome. They are shown as written, never truncated - ' +
                'stay within the length limit.',
        ),
    ),
);

/**
 * Schema variant for a propose-rule outcome — the agent reproduced the ad and produced a validated,
 * low-risk rule plus its placement, risk, and duplicate check.
 */
const ProposeRuleOutcomeSchema = v.object({
    outcome: v.literal(FixOutcomeKind.ProposeRule),
    ruleProposal: RuleProposalSchema,
    policyDecision: PolicyDecisionSchema,
    reasoning: v.string(),
    summary: SummarySchema,
    evidenceSummary: v.string(),
});

/**
 * Policy decision required when a usable browser did not reproduce the defect.
 */
const NotReproducedPolicyDecisionSchema = v.object({
    decision: v.literal(PolicyDecisionKind.AllowRuleGeneration),
    reasons: v.array(v.string()),
});

/**
 * Policy decisions that explicitly block automatic rule generation.
 */
const PolicyBlockedDecisionSchema = v.variant('decision', [
    v.object({
        decision: v.literal(PolicyDecisionKind.ProposeClose),
        reasons: v.array(v.string()),
    }),
    v.object({
        decision: v.literal(PolicyDecisionKind.NeedsHumanReview),
        reasons: v.array(v.string()),
    }),
]);

/**
 * Schema variant for a propose-close outcome backed by usable negative browser evidence.
 */
const NotReproducedOutcomeSchema = v.object({
    outcome: v.literal(FixOutcomeKind.ProposeClose),
    reproductionStatus: v.literal(ReproductionStatus.NotReproduced),
    policyDecision: NotReproducedPolicyDecisionSchema,
    reasoning: v.string(),
    summary: SummarySchema,
    evidenceSummary: v.string(),
});

/**
 * Schema variant for a propose-close outcome required by deterministic policy.
 */
const PolicyBlockedOutcomeSchema = v.object({
    outcome: v.literal(FixOutcomeKind.ProposeClose),
    reproductionStatus: v.literal(ReproductionStatus.PolicyBlocked),
    policyDecision: PolicyBlockedDecisionSchema,
    reasoning: v.string(),
    summary: SummarySchema,
    evidenceSummary: v.string(),
});

/**
 * How a resolve-without-patch run stands: why the issue needs no repository change.
 */
const ResolveWithoutPatchRunStatusSchema = v.picklist(NO_PATCH_RUN_STATUSES);

/**
 * Schema variant for an analysis-only outcome — risk is too high, the site is unreachable, or the
 * structured output could not be parsed. No GitHub writes.
 *
 * `candidateForReview` is the one place a rule may appear on this outcome: a candidate that passed
 * lint and risk scoring and that no review confirmed, because `apply_rule` did not reject it or, on
 * any report but incorrect blocking, its review rejected it only for ad layout residue on an
 * intact, undamaged page. It is not a publication channel — the propose-rule outcome remains the
 * only one — it is what keeps the run's best finding out of the prose and in a field a reader can
 * act on.
 */
const AnalysisOnlyOutcomeSchema = v.object({
    outcome: v.literal(FixOutcomeKind.AnalysisOnly),
    reasoning: v.string(),
    summary: SummarySchema,
    candidateForReview: v.optional(CandidateForReviewSchema),
});

/**
 * Schema variant for a browser-proven resolution that requires no repository patch.
 */
const ResolveWithoutPatchOutcomeSchema = v.object({
    outcome: v.literal(FixOutcomeKind.ResolveWithoutPatch),
    runStatus: ResolveWithoutPatchRunStatusSchema,
    reasoning: v.string(),
    summary: SummarySchema,
    evidenceSummary: v.string(),
});

/**
 * What `finish_fix` advertises: {@link FixOutcomeSchema} as one flat object.
 *
 * Providers refuse a tool whose parameters are a union at the root, so the model is shown every
 * branch field side by side, with the outcome it belongs to in its description. pi checks a call
 * against this object before execute, and {@link FixOutcomeSchema} runs the same object first, so
 * both accept and refuse the same calls at this depth. The object relaxes every branch: each field
 * keeps its branch's leaf schema (`policyDecision` takes the decision schema both branch-specific
 * decisions narrow), and only the fields every branch requires are required here.
 */
export const FixOutcomeParametersSchema = v.object({
    outcome: v.picklist(Object.values(FixOutcomeKind)),
    reasoning: v.string(),
    summary: SummarySchema,
    evidenceSummary: v.optional(
        v.pipe(v.string(), v.description('Required for every outcome except analysis_only.')),
    ),
    ruleProposal: v.optional(
        v.pipe(
            RuleProposalSchema,
            v.description('Required for propose_rule; leave out otherwise.'),
        ),
    ),
    policyDecision: v.optional(
        v.pipe(
            PolicyDecisionSchema,
            v.description(
                'Required for propose_rule and propose_close; leave out otherwise. ' +
                    'propose_close with reproductionStatus ' +
                    'not_reproduced takes allow_rule_generation; with policy_blocked, ' +
                    'propose_close or needs_human_review.',
            ),
        ),
    ),
    reproductionStatus: v.optional(
        v.pipe(
            v.picklist(Object.values(ReproductionStatus)),
            v.description('Required for propose_close; leave out otherwise.'),
        ),
    ),
    runStatus: v.optional(
        v.pipe(
            ResolveWithoutPatchRunStatusSchema,
            v.description('Required for resolve_without_patch; leave out otherwise.'),
        ),
    ),
    candidateForReview: v.optional(
        v.pipe(CandidateForReviewSchema, v.description('analysis_only only.')),
    ),
});

/**
 * Schema for the structured decision the agent outputs in fix mode. The variant discriminator is
 * `outcome`; this is the terminal tool's payload schema.
 *
 * A variant, not a union: Valibot's union reports a branch's own issues only when exactly one
 * branch fits the type, and every branch here is an object, so a propose-rule payload without its
 * `ruleProposal` came back as "Expected Object but received Object". The variant picks the branch
 * by `outcome` — and the two propose-close branches by `reproductionStatus` — and names the field
 * that fails.
 *
 * The flat {@link FixOutcomeParametersSchema} runs first: it is what pi checked before execute, so a
 * malformed field of another outcome — `ruleProposal: null` on an analysis-only outcome — is
 * refused here too, by name, instead of being dropped by the branch. A well-formed one passes both
 * and the branch drops it.
 */
export const FixOutcomeSchema = v.pipe(
    FixOutcomeParametersSchema,
    v.variant('outcome', [
        ProposeRuleOutcomeSchema,
        v.variant('reproductionStatus', [NotReproducedOutcomeSchema, PolicyBlockedOutcomeSchema]),
        ResolveWithoutPatchOutcomeSchema,
        AnalysisOnlyOutcomeSchema,
    ]),
);

/**
 * The structured decision produced by the agent in fix mode, validated at terminal submission.
 */
export type FixOutcome = v.InferOutput<typeof FixOutcomeSchema>;

/**
 * Explicit reason a propose-close outcome is safe to publish.
 */
export type ReproductionStatus = (typeof ReproductionStatus)[keyof typeof ReproductionStatus];
