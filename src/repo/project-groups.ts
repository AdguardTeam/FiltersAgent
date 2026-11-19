import { MIN_SHARED_RULE_DOMAINS, normalizedFamilySignature } from './rule-family';
import type { NormalizedRule } from './rule-normalizer';

/**
 * One rule of a list file, filed under the domain list it carries.
 */
interface ScopedRule {
    /**
     * One-based line of the rule in its file.
     */
    line: number;

    /**
     * The rule without its domains, which tells two rules of one domain list apart.
     */
    signature: string;
}

/**
 * Find the rules a list file keeps as groups repeating one domain list.
 *
 * Maintainers keep one project's rules — one company's sites, one platform's mirrors, one vendor's
 * widget — as several rules repeating the same domain list, and a site added to one of them would
 * no longer match the rest of its group. A rule belongs to such a group when its exact domain list,
 * of at least two domains, also scopes another rule of the same file with a different expression;
 * two copies of one rule do not make a group.
 *
 * @param rules - Every line of one list file, normalized, in file order.
 * @returns For each one-based line that belongs to a group, every line of that group, ascending.
 */
export function projectGroupLines(
    rules: readonly NormalizedRule[],
): ReadonlyMap<number, readonly number[]> {
    const rulesByDomains = new Map<string, ScopedRule[]>();
    rules.forEach((rule, index) => {
        const signature = normalizedFamilySignature(rule);
        if (rule.domains.length < MIN_SHARED_RULE_DOMAINS || signature === undefined) {
            return;
        }
        const key = rule.domains.join(',');
        const scoped = rulesByDomains.get(key) ?? [];
        scoped.push({ line: index + 1, signature });
        rulesByDomains.set(key, scoped);
    });
    const grouped = new Map<number, readonly number[]>();
    for (const scoped of rulesByDomains.values()) {
        if (new Set(scoped.map((rule) => rule.signature)).size > 1) {
            const groupLines = scoped.map((rule) => rule.line);
            for (const line of groupLines) {
                grouped.set(line, groupLines);
            }
        }
    }
    return grouped;
}
