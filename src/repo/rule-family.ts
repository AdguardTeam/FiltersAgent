import { RuleKind, findCosmeticSeparator, normalizeRule } from './rule-normalizer';

/**
 * Rule kinds whose shared multi-domain lines can be extended by one more reported scope.
 *
 * Maintainers resolve platform-wide symptoms with one shared line per platform — a cosmetic family
 * (`a.com,b.com##.banner`), a consent-state scriptlet family (`a.com,b.com#%#//scriptlet(...)`), or
 * a vendor-loader network family (`||cs.iubenda.com^$domain=a.it|b.it`). A planner that can extend
 * only cosmetic lines leaves the agent hiding CMP banners per site exactly where maintainers extend
 * such lines, so every one of these kinds is extensible.
 */
const EXTENSIBLE_FAMILY_KINDS: ReadonlySet<RuleKind> = new Set<RuleKind>([
    RuleKind.Cosmetic,
    RuleKind.Scriptlet,
    RuleKind.Network,
]);

/**
 * Whether rules of this kind form shared domain families the planner may extend.
 *
 * @param kind - Normalized rule kind.
 * @returns True for cosmetic, scriptlet, and network rules.
 */
export function isExtensibleFamilyKind(kind: RuleKind): boolean {
    return EXTENSIBLE_FAMILY_KINDS.has(kind);
}

/**
 * Test whether two normalized rules belong to the same broad repository placement family.
 *
 * Element hiding, CSS injection, ExtendedCSS, and scriptlets commonly share one domain block in
 * AdguardFilters. Network rules are kept separate from that cosmetic family.
 *
 * @param candidateKind - Kind of the locked candidate rule.
 * @param existingKind - Kind of one existing repository rule.
 * @returns Whether the rules can share a reported-domain placement block.
 */
export function samePlacementFamily(candidateKind: RuleKind, existingKind: RuleKind): boolean {
    if (candidateKind === RuleKind.Network) {
        return existingKind === RuleKind.Network;
    }
    const candidateIsCosmetic =
        candidateKind === RuleKind.Cosmetic || candidateKind === RuleKind.Scriptlet;
    const existingIsCosmetic =
        existingKind === RuleKind.Cosmetic || existingKind === RuleKind.Scriptlet;
    return candidateIsCosmetic && existingIsCosmetic;
}

/**
 * Identity of a rule family: the complete rule expression with its domain scope removed.
 *
 * Two rules with the same signature differ only in which sites they apply to, so one may be folded
 * into the other's domain list without touching what the rule does.
 *
 * @param rule - Raw filter rule text.
 * @returns Scope-free signature, or undefined when the rule cannot form a family.
 */
export function ruleFamilySignature(rule: string): string | undefined {
    const normalized = normalizeRule(rule);
    if (normalized.kind === RuleKind.Cosmetic || normalized.kind === RuleKind.Scriptlet) {
        if (!normalized.syntaxKind || !normalized.selector) {
            return undefined;
        }
        const separator = findCosmeticSeparator(normalized.canonical);
        return separator ? normalized.canonical.slice(separator.index) : undefined;
    }
    if (normalized.kind === RuleKind.Network) {
        if (!normalized.urlPattern) {
            return undefined;
        }
        const modifiers = normalized.modifiers.filter(
            (modifier) => !modifier.startsWith('domain='),
        );
        return (
            (normalized.isException ? '@@' : '') +
            normalized.urlPattern +
            (modifiers.length > 0 ? `$${modifiers.join(',')}` : '')
        );
    }
    return undefined;
}

/**
 * Rebuild a shared rule line with one more domain in its scope, preserving the rest verbatim.
 *
 * Cosmetic and scriptlet lines carry their scope as a leading comma list; network lines carry it
 * inside the `$domain=` modifier with `|` separators. The new domain leads the list in both shapes,
 * matching the planner's existing cosmetic convention.
 *
 * @param rule - Exact existing shared rule line.
 * @param domain - Reported domain to add.
 * @returns The replacement line, or undefined when the line carries no extensible scope.
 */
export function extendRuleDomains(rule: string, domain: string): string | undefined {
    const normalized = normalizeRule(rule);
    if (normalized.kind === RuleKind.Network) {
        const match = /(^|[$,])domain=/iu.exec(rule);
        if (!match) {
            return undefined;
        }
        const listStart = match.index + match[0].length;
        return `${rule.slice(0, listStart)}${domain}|${rule.slice(listStart)}`;
    }
    if (normalized.kind === RuleKind.Cosmetic || normalized.kind === RuleKind.Scriptlet) {
        return `${domain},${rule}`;
    }
    return undefined;
}
