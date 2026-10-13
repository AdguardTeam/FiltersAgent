/**
 * The structural kind of one candidate rule, as every placement decision names it.
 *
 * It lives in the shared vocabulary because both ends of the placement question need it and neither
 * owns it: a run instruction declares a placement per rule kind (`src/knowledge/`), and the
 * repository side matches a candidate to that declaration by its kind (`src/repo/`). Keeping it
 * here is what lets the instruction layer name a kind without importing the repository code.
 */
export const PlacementRuleType = {
    /**
     * A network rule: a request pattern, with or without modifiers.
     */
    Network: 'network',

    /**
     * A cosmetic rule: element hiding, CSS injection, or their extended forms.
     */
    Cosmetic: 'cosmetic',

    /**
     * An exception rule: a network allowlist entry or a cosmetic unhide.
     */
    Exception: 'exception',

    /**
     * A scriptlet injection rule, in either the AdGuard or the uBlock Origin spelling.
     */
    Scriptlet: 'scriptlet',
} as const;

/**
 * Every placement rule type value, for schemas and exhaustive listings.
 */
export const PLACEMENT_RULE_TYPE_VALUES = Object.values(PlacementRuleType);

/**
 * Structural type of one candidate as every placement decision names it.
 */
export type PlacementRuleType = (typeof PlacementRuleType)[keyof typeof PlacementRuleType];
