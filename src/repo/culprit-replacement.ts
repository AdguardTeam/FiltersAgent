import { isSingleLineRule, normalizeRule, RuleKind, type NormalizedRule } from './rule-normalizer';

/**
 * The domain scope one exact culprit-rule replacement can affect.
 */
export interface CulpritReplacement {
    /**
     * Ascending domain scopes the original rule governed; empty when it carried no scope at all.
     */
    affectedScopes: readonly string[];
}

/**
 * Rule kinds a correction may be written in; a comment or a blank line corrects nothing.
 */
const ACTIONABLE_KINDS: ReadonlySet<NormalizedRule['kind']> = new Set([
    RuleKind.Network,
    RuleKind.Cosmetic,
    RuleKind.Scriptlet,
]);

/**
 * Whether a normalized rule carries anything after its syntax: a cosmetic or scriptlet body, or a
 * network pattern or modifier. A line that ends at its separator (`a.example##`) matches nothing,
 * so it can neither be corrected nor serve as a correction.
 *
 * @param rule - The normalized actionable rule.
 * @returns Whether the rule has a body.
 */
function hasRuleBody(rule: NormalizedRule): boolean {
    if (rule.kind === RuleKind.Network) {
        return (rule.urlPattern ?? '').length > 0 || rule.modifiers.length > 0;
    }
    return (rule.selector ?? '').length > 0;
}

/**
 * Decide whether a line is one well-formed rule that can take part in a correction: a single line
 * of an actionable kind with a body. Whether the blocker accepts the rule is not decided here — the
 * in-browser phases prove that — only whether the line is a rule at all. Exported so the
 * culprit-edit gate refuses a malformed line on exactly the terms this predicate would, rather than
 * on a second definition that could drift from it.
 *
 * @param rule - Raw candidate or repository line.
 * @returns Whether the line is a single actionable rule.
 */
export function isSingleActionableRule(rule: string): boolean {
    if (!isSingleLineRule(rule)) {
        return false;
    }
    const normalized = normalizeRule(rule);
    return ACTIONABLE_KINDS.has(normalized.kind) && hasRuleBody(normalized);
}

/**
 * The two halves of one rule's domain list, which are compared in opposite directions.
 */
interface PartitionedScopes {
    /**
     * Ascending scopes the rule serves.
     */
    positive: string[];

    /**
     * Ascending `~`-prefixed scopes the rule excludes.
     */
    negated: string[];
}

/**
 * Split a normalized domain list into the scopes a rule serves and the scopes it excludes.
 *
 * A `~`-prefixed scope subtracts from what the rule reaches, so the two halves must be compared in
 * opposite directions: a positive scope may only be lost, a negation may only be gained.
 *
 * @param rule - Normalized rule whose domain list is being partitioned.
 * @returns Ascending positive scopes and ascending negated scopes.
 */
function partitionScopes(rule: NormalizedRule): PartitionedScopes {
    return {
        positive: rule.domains.filter((domain) => !domain.startsWith('~')),
        negated: rule.domains.filter((domain) => domain.startsWith('~')),
    };
}

/**
 * Decide whether a complete replacement line is a safe correction of one exact existing rule.
 *
 * This is the sole definition of the exact-edit invariant. It deliberately does not judge the rule
 * expression: no structural check can prove a narrowed selector or URL pattern is right for the
 * domains the run never visited. What it does prove is that the change cannot reach further than
 * the rule already did — same kind, same concrete syntax, same polarity, no positive scope the
 * original did not already serve, and no negation the original carried thrown away — so the scopes
 * it returns are a complete bound on the blast radius the report must disclose.
 *
 * A rule that carried no positive scope at all already governs every site, so narrowing it to any
 * scope cannot broaden it; the empty disclosure is what the report renders as "every site this rule
 * matches".
 *
 * @param originalRule - Exact existing rule being corrected.
 * @param replacementRule - Complete replacement line.
 * @returns The scope disclosure when the replacement is a safe correction, else null.
 */
export function describeCulpritReplacement(
    originalRule: string,
    replacementRule: string,
): CulpritReplacement | null {
    if (!isSingleActionableRule(originalRule) || !isSingleActionableRule(replacementRule)) {
        return null;
    }
    const original = normalizeRule(originalRule);
    const replacement = normalizeRule(replacementRule);
    const originalScopes = partitionScopes(original);
    const replacementScopes = partitionScopes(replacement);
    if (
        original.kind !== replacement.kind ||
        original.syntaxKind !== replacement.syntaxKind ||
        original.isException ||
        replacement.isException ||
        original.canonical === replacement.canonical ||
        (originalScopes.positive.length > 0 &&
            !replacementScopes.positive.every((scope) =>
                originalScopes.positive.includes(scope),
            )) ||
        !originalScopes.negated.every((scope) => replacementScopes.negated.includes(scope))
    ) {
        return null;
    }
    // `normalizeRule` already lowercases, dedupes, and sorts every domain list, so the affected
    // scopes are ascending without re-sorting them here.
    return { affectedScopes: originalScopes.positive };
}
