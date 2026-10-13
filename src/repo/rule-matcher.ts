import type { SearchQuery } from '../types/repo-context';
import type { NormalizedRule } from './rule-normalizer';
import { RuleKind } from './rule-normalizer';
import { domainScopeCovers, hostnameAndParentSuffixes } from './domain-scope';

/**
 * Determine whether an explicitly scoped rule applies to the requested site domain.
 *
 * Positive scopes cover the requested domain per {@link domainScopeCovers}, so an entity scope
 * (`shellshock.*`) covers the requested domain under whichever public suffix it was reported on.
 *
 * @param scopes - Normalized rule domain scopes, including possible `~` exclusions.
 * @param domain - Requested site domain.
 * @returns True when a positive scope covers the requested domain.
 */
function domainScopesApply(scopes: string[], domain: string): boolean {
    return scopes.some((scope) => {
        if (scope.startsWith('~')) {
            return false;
        }
        return domainScopeCovers(scope, domain);
    });
}

/**
 * Determine whether a rule belongs in a domain-only applicability inventory.
 *
 * Domain-only search intentionally does not synthesize a network blocking candidate. It returns
 * explicitly scoped cosmetic/scriptlet rules and network rules whose pattern or domain modifier
 * mentions the requested site.
 *
 * @param domain - Requested site domain.
 * @param existing - Existing normalized repository rule.
 * @returns True when the rule is relevant to the domain inventory.
 */
function isDomainInventoryMatch(domain: string, existing: NormalizedRule): boolean {
    const normalizedDomain = domain.toLowerCase();
    if (domainScopesApply(existing.domains, normalizedDomain)) {
        return true;
    }
    if (existing.kind !== RuleKind.Network || !existing.urlPattern) {
        return false;
    }
    const pattern = existing.urlPattern.toLowerCase();
    return hostnameAndParentSuffixes(normalizedDomain).some((host) => pattern.includes(host));
}

/**
 * Whether an existing rule has exactly the target a query names: its selector, URL pattern, or
 * scriptlet.
 *
 * @param query - The search query naming one target.
 * @param existing - The normalized form of an existing rule in the checkout.
 * @returns True when the rule has the named target, in any scope and of either polarity.
 */
function hasQueryTarget(query: SearchQuery, existing: NormalizedRule): boolean {
    if (query.selector !== undefined) {
        return existing.kind === RuleKind.Cosmetic && existing.selector === query.selector.trim();
    }
    if (query.urlPattern !== undefined) {
        return (
            existing.kind === RuleKind.Network &&
            existing.urlPattern === query.urlPattern.toLowerCase()
        );
    }
    if (query.scriptlet !== undefined) {
        return existing.kind === RuleKind.Scriptlet && existing.scriptletName === query.scriptlet;
    }
    return false;
}

/**
 * Decide whether an existing rule answers a search query.
 *
 * A domain-only query is an applicability inventory of the rules that already reach the site. A
 * query naming a selector, URL pattern or scriptlet returns every rule with exactly that target, in
 * any scope and of either polarity. How such a rule relates to the candidate — an exact copy, a
 * broader rule, a contradicting exception, a shared rule the reported domain could join — is the
 * agent's reading of the rule it is shown, not a label the search attaches.
 *
 * @param query - The search query.
 * @param existing - The normalized form of an existing rule in the checkout.
 * @returns True when the rule belongs in the query's results.
 */
export function matchesQuery(query: SearchQuery, existing: NormalizedRule): boolean {
    if (
        query.domain !== undefined &&
        query.selector === undefined &&
        query.urlPattern === undefined &&
        query.scriptlet === undefined
    ) {
        return isDomainInventoryMatch(query.domain, existing);
    }
    return hasQueryTarget(query, existing);
}
