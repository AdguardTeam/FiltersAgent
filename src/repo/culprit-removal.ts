import { isSingleActionableRule } from './culprit-replacement';
import { normalizeRule } from './rule-normalizer';

/**
 * The domain scope one exact culprit-rule removal takes away.
 */
export interface CulpritRemoval {
    /**
     * Ascending domain scopes the removed rule governed; empty when it carried no scope at all.
     */
    affectedScopes: readonly string[];
}

/**
 * Decide whether one exact existing rule is a rule this repair path may delete.
 *
 * This is the sole definition of the exact-remove invariant. Unlike a replacement, a deletion
 * cannot be bounded by proving it does not broaden the rule — it takes the rule away everywhere the
 * rule reached. So the only static proof available is polarity: the target must be a rule that
 * blocks. Deleting an exception would restore blocking instead of repairing it, and no evidence
 * gathered on the reported site can bound what that re-blocks elsewhere. Everything else this path
 * can say about the blast radius is the scope list returned here, which the report must disclose.
 *
 * @param originalRule - Exact existing rule proposed for deletion.
 * @returns The scope disclosure when the rule may be removed, else null.
 */
export function describeCulpritRemoval(originalRule: string): CulpritRemoval | null {
    if (!isSingleActionableRule(originalRule)) {
        return null;
    }
    const original = normalizeRule(originalRule);
    if (original.isException) {
        return null;
    }
    // `normalizeRule` already lowercases, dedupes, and sorts every domain list, so the affected
    // scopes are ascending without re-sorting them here. A `~`-prefixed scope is dropped: the rule
    // never reached it, so it loses nothing when the rule goes away.
    return { affectedScopes: original.domains.filter((domain) => !domain.startsWith('~')) };
}
