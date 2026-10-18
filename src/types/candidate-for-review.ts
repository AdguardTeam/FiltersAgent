/**
 * The candidate an analysis-only run found but could not verify.
 *
 * A run that linted a rule, scored its risk and applied it without a rejection — or, on any report
 * but incorrect blocking, with a review that rejected it only for the ad layout residue it left,
 * the page intact and undamaged — yet never obtained a verifying review, would otherwise end with
 * the rule surviving only inside its own prose: the terminal outcome carries no rule field, the run
 * result carries `candidatePatch: null`, and the issue comment says "Analysis-only findings, no
 * verified change" — even when the rule is one wildcard away from the fix a maintainer would land.
 * This is the typed place for that rule. It changes nothing about publication: an unverified
 * candidate is still never a rule proposal, and a result carrying one still carries no candidate
 * patch.
 */
import * as v from 'valibot';

/**
 * Ceiling on the rule carried for review.
 *
 * The same 4096 characters the rejected-candidate evidence bounds its `candidateRule` by: both
 * fields hold one unpublished rule for a human to read, so a rule that fits one fits the other.
 */
export const MAX_CANDIDATE_FOR_REVIEW_RULE_CHARACTERS = 4_096;

/**
 * Ceiling on the explanation of why validation did not confirm the candidate.
 *
 * The same order of bound the model-authored run summary carries, and for the same reason: a model
 * writes to the feel of the instruction rather than to a character count, so a tight ceiling turns
 * an honest explanation into a rejected submission instead of a shorter one.
 */
export const MAX_UNVERIFIED_REASON_CHARACTERS = 1_000;

/**
 * A rule written verbatim as exactly one filter-file line.
 *
 * An embedded CR or LF does not make a longer rule — it makes a second, unreviewed one — so the
 * same single-line shape every other rule field in a serialized result is pinned to applies here.
 *
 * Deliberately flagless: this schema is part of the terminal tool's payload, which is converted to
 * JSON Schema for the model, and that conversion refuses a pattern carrying regex flags.
 */
// oxlint-disable-next-line unicorn/require-unicode-regexp -- JSON Schema conversion refuses flags.
const SINGLE_LINE_RULE_PATTERN = /^[^\r\n]+$/;

export const CandidateForReviewSchema = v.object({
    rule: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(MAX_CANDIDATE_FOR_REVIEW_RULE_CHARACTERS),
        v.regex(SINGLE_LINE_RULE_PATTERN),
        v.description(
            'The exact single filter rule this run found and could not verify, written as it ' +
                'would appear in the filter file.',
        ),
    ),
    placement: v.optional(
        v.object({
            filePath: v.pipe(
                v.string(),
                v.minLength(1),
                v.description('Checkout-relative filter file the rule would belong in.'),
            ),
        }),
    ),
    unverifiedReason: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(MAX_UNVERIFIED_REASON_CHARACTERS),
        v.description(
            'Why validation did not confirm this rule - the visual review verdict and its page ' +
                'integrity, the ad layout residue a review rejected it for, an unreachable ' +
                'reported flow, or the environment limit that stopped the experiment.',
        ),
    ),
});

/**
 * An unverified rule an analysis-only run carries to the report for a maintainer to judge.
 */
export type CandidateForReview = v.InferOutput<typeof CandidateForReviewSchema>;
