import * as v from 'valibot';
import { MAX_PLACEMENT_REASON_CHARACTERS } from './placement-basis';
import { nonBlankSingleLineText } from './single-line-text';

/**
 * How far the agent judges a candidate rule to reach beyond the reported symptom, as it tells the
 * reviewer.
 *
 * The agent assesses this from the evidence it collected — what the rule matched on the page, what
 * else it could match elsewhere — and nothing gates publication on it: the only structural limit a
 * candidate answers to is being scoped to the reported domain alone, which the candidate safety
 * gate checks on its own.
 */
export const RiskLevel = {
    /**
     * Touches only the reported symptom on the reported site.
     */
    Low: 'low',

    /**
     * May touch other content on the reported site; worth a reviewer's attention.
     */
    Medium: 'medium',

    /**
     * May affect content beyond the reported symptom; the reviewer should check it closely.
     */
    High: 'high',

    /**
     * The agent does not stand behind shipping it; a human has to decide.
     */
    Blocker: 'blocker',
} as const;

/**
 * Every RiskLevel value, for schemas and exhaustive listings.
 */
export const RISK_LEVEL_VALUES = Object.values(RiskLevel);

/**
 * Severity tier of one candidate rule's risk assessment.
 */
export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

export const RiskLevelSchema = v.picklist(RISK_LEVEL_VALUES);

// The agent's own assessment: a level and the reasons behind it. The numeric score, blast-radius
// flags and required action were the removed keyword scorer's vocabulary; artifacts that still
// carry them parse fine - v.object drops unknown keys.
export const RuleRiskSchema = v.object({
    level: RiskLevelSchema,
    reasons: v.array(v.string()),
});

/**
 * How a candidate rule relates to an existing rule found by the duplicate check.
 */
export const DuplicateClass = {
    /**
     * The candidate is byte-for-byte identical to an existing rule.
     */
    Exact: 'exact',

    /**
     * The candidate targets the same thing as an existing rule through different syntax.
     */
    Semantic: 'semantic',

    /**
     * An existing broader rule already covers everything the candidate would block.
     */
    Subsumed: 'subsumed',

    /**
     * The candidate contradicts an existing rule's effect.
     */
    Conflict: 'conflict',

    /**
     * A matching rule exists, but in a different filter than the candidate targets.
     */
    CrossFilter: 'cross-filter',

    /**
     * No related existing rule was found.
     */
    None: 'none',
} as const;

/**
 * Every DuplicateClass value, for schemas and exhaustive listings.
 */
export const DUPLICATE_CLASS_VALUES = Object.values(DuplicateClass);

/**
 * Relationship of one candidate rule to an existing rule found by the duplicate check.
 */
export type DuplicateClass = (typeof DuplicateClass)[keyof typeof DuplicateClass];

export const DuplicateClassSchema = v.picklist(DUPLICATE_CLASS_VALUES);

export const DuplicateCheckResultSchema = v.object({
    classification: DuplicateClassSchema,
    matches: v.array(v.object({ rule: v.string(), filePath: v.string() })),
});

/**
 * The kinds of in-file position an agent can name for a new rule.
 */
export const PlacementPositionKind = {
    /**
     * The rule becomes this 1-based line, and every existing line from it down moves one down.
     */
    BeforeLine: 'before_line',

    /**
     * The rule takes its sorted place among the existing rules of its kind.
     */
    Sorted: 'sorted',

    /**
     * The rule is appended at the end of the file, for the reason the agent states.
     */
    FileEnd: 'file_end',
} as const;

/**
 * PlacementPositionKind value.
 */
export type PlacementPositionKind =
    (typeof PlacementPositionKind)[keyof typeof PlacementPositionKind];

/**
 * The place inside the list file a new rule goes.
 *
 * The agent names it; the host only checks that the rule can go there and computes the edit, so no
 * position is inferred from the file's shape on the model's behalf.
 */
export const PlacementPositionSchema = v.variant('kind', [
    v.object({
        /**
         * The chosen-line discriminator.
         */
        kind: v.literal(PlacementPositionKind.BeforeLine),

        /**
         * 1-based line the rule becomes.
         */
        line: v.pipe(v.number(), v.integer(), v.minValue(1)),
    }),
    v.object({
        /**
         * The sorted-position discriminator.
         */
        kind: v.literal(PlacementPositionKind.Sorted),

        /**
         * 1-based line of an outline marker whose region the outline flags as sorted (`s`); absent
         * for the leading region, which must be flagged the same way.
         */
        line: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    }),
    v.object({
        /**
         * The end-of-file discriminator.
         */
        kind: v.literal(PlacementPositionKind.FileEnd),

        /**
         * Why the rule belongs at the end of the file.
         */
        reason: nonBlankSingleLineText(MAX_PLACEMENT_REASON_CHARACTERS),
    }),
]);

/**
 * The place inside the list file a new rule goes.
 */
export type PlacementPosition = v.InferOutput<typeof PlacementPositionSchema>;

// The agent names the file and the position inside it; the host checks the position and computes
// the edit. Old artifacts that still carry `insertionPoint` parse fine - v.object drops unknown
// keys.
export const PlacementResultSchema = v.object({
    filter: v.string(),
    filePath: v.string(),
    confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    alternatives: v.array(v.string()),
    position: v.optional(
        v.pipe(
            PlacementPositionSchema,
            v.description(
                `Where in the file a new rule goes: ${PlacementPositionKind.BeforeLine} (the ` +
                    `1-based line the rule becomes), ${PlacementPositionKind.Sorted} (its sorted ` +
                    'place inside the region an outline marker flags as sorted - name that ' +
                    "marker's line, or leave line out when the region before the first marker is " +
                    `flagged), or ${PlacementPositionKind.FileEnd} (with the reason). The host ` +
                    'never chooses another region or block. Required whenever the rule is a new ' +
                    'line, unless the run instruction declares a comment for the rule kind: that ' +
                    'placement appends the rule behind the comment and ignores the position. ' +
                    'Ignored as well when the host adds the domain to an existing shared rule ' +
                    'instead.',
            ),
        ),
    ),
});

export const ProductCompatibilitySchema = v.object({
    extension: v.boolean(),
});

/**
 * Proposal-level rule types; scriptlets stay inside the broad `cosmetic` category.
 */
export const RuleType = {
    Network: 'network',
    Cosmetic: 'cosmetic',
} as const;

/**
 * Every proposal rule type value, for schemas and exhaustive listings.
 */
export const RULE_TYPE_VALUES = Object.values(RuleType);

/**
 * Proposal-level rule type of one candidate.
 */
export type RuleType = (typeof RuleType)[keyof typeof RuleType];

export const RuleTypeSchema = v.picklist(RULE_TYPE_VALUES);

export const RuleProposalSchema = v.object({
    rule: v.string(),
    ruleType: RuleTypeSchema,
    risk: RuleRiskSchema,
    placement: PlacementResultSchema,
    duplicateCheck: DuplicateCheckResultSchema,
    productCompatibility: ProductCompatibilitySchema,
});

export type RuleProposal = v.InferOutput<typeof RuleProposalSchema>;
