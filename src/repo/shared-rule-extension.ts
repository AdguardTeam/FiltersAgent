import { isExtensibleFamilyKind, ruleFamilySignature } from './rule-family';
import { normalizeRule } from './rule-normalizer';

/**
 * The wider domain scope one constrained shared-rule extension touches.
 */
export interface SharedRuleExtension {
    /**
     * The single domain scope this edit adds — the reported site, and the only scope verified.
     */
    addedScope: string;

    /**
     * Ascending scopes the shared rule already served and still serves unchanged.
     */
    retainedScopes: readonly string[];
}

/**
 * Decide whether a replacement line adds exactly one reported scope to an existing shared rule.
 *
 * This is the sole definition of the constrained-edit invariant: the original must be a rule at
 * least two other sites already share and the reported site does not, the rule expression must be
 * untouched, every prior domain must survive, and exactly the candidate's scope may appear. It also
 * refuses an exception on any of the three rules, because `##` and `#@#` share a syntax kind and an
 * unhide rule extended by a blocking candidate would invert what the reported site executes while
 * satisfying every other condition.
 *
 * @param candidateRule - Single-domain rule scoped to the reported site.
 * @param originalRule - Exact existing shared rule.
 * @param replacementRule - Complete replacement line.
 * @returns The scope disclosure when the edit is a valid constrained extension, else null.
 */
export function describeSharedRuleExtension(
    candidateRule: string,
    originalRule: string,
    replacementRule: string,
): SharedRuleExtension | null {
    const candidate = normalizeRule(candidateRule);
    const original = normalizeRule(originalRule);
    const replacement = normalizeRule(replacementRule);
    const addedScope = candidate.domains[0];
    // The family signature is the rule expression with its scope removed, so "the rule
    // expression must be untouched" is one equality across all three lines for cosmetic,
    // scriptlet, and network families alike.
    const signature = ruleFamilySignature(candidateRule);
    if (
        !isExtensibleFamilyKind(candidate.kind) ||
        candidate.isException ||
        original.isException ||
        replacement.isException ||
        candidate.domains.length !== 1 ||
        addedScope.startsWith('~') ||
        // The same two preconditions the extension planner selects a target under: a rule the
        // reported site already carries is not extended by naming it again, and a rule fewer than
        // two sites share is not shared at all.
        original.domains.includes(addedScope) ||
        original.domains.length < 2 ||
        original.domains.some((domain) => domain.startsWith('~')) ||
        signature === undefined ||
        ruleFamilySignature(originalRule) !== signature ||
        ruleFamilySignature(replacementRule) !== signature ||
        !original.domains.every((domain) => replacement.domains.includes(domain)) ||
        !replacement.domains.includes(addedScope) ||
        replacement.domains.length !== original.domains.length + 1
    ) {
        return null;
    }
    // `normalizeRule` already lowercases, dedupes, and sorts every domain list, so the retained
    // scopes are ascending without re-sorting them here.
    return { addedScope, retainedScopes: [...original.domains] };
}
