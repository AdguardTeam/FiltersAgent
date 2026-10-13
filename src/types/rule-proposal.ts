import * as v from 'valibot';

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

// Deliberately no `insertionPoint`: the agent names the file, and the in-file position is
// host-planned at candidate build. Old artifacts that still carry the field parse fine - v.object
// drops unknown keys.
export const PlacementResultSchema = v.object({
    filter: v.string(),
    filePath: v.string(),
    confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    alternatives: v.array(v.string()),
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
