import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlacementMap, SearchQuery, RuleMatch } from '../types/repo-context';
import { RuleKind, normalizeRule, type NormalizedRule } from './rule-normalizer';
import { matchesQuery } from './rule-matcher';
import { domainScopeCovers, domainScopeSearchTerms, isEntityScope } from './domain-scope';

/**
 * An intermediate search result: the public {@link RuleMatch} fields plus the normalized rule the
 * domain-affinity ranking reads.
 */
interface PreliminaryMatch {
    /**
     * The full text of the matched rule line.
     */
    rule: string;

    /**
     * Repository-relative path of the list file containing the rule.
     */
    filePath: string;

    /**
     * 1-based line number of the rule in the file.
     */
    line: number;

    /**
     * Filter name the file belongs to.
     */
    filter: string;

    /**
     * Section name the rule falls within, if any.
     */
    section?: string;

    /**
     * The normalized rule descriptor.
     */
    normalized: NormalizedRule;
}

/**
 * Comparable domain-affinity facts for ranking exact-target selector matches.
 */
interface DomainAffinityRank {
    /**
     * Whether the existing rule already applies to the requested domain.
     */
    applies: number;

    /**
     * Whether every positive scope shares the requested domain's final DNS label.
     */
    sameLabelOnly: number;

    /**
     * Number of positive scopes sharing the requested domain's final DNS label.
     */
    sameLabelCount: number;

    /**
     * Whether the rule is already shared by multiple domains and can be extended in place.
     */
    shared: number;
}

/**
 * Return the final DNS label used as a bounded locale-affinity signal.
 *
 * An entity scope (`shellshock.*`) stands for every public suffix at once, so it has no final label
 * to compare and contributes no locale signal either way.
 *
 * @param domain - Host-like cosmetic-rule domain scope.
 * @returns Lowercase final DNS label, or an empty string for unsupported scopes.
 */
function finalDomainLabel(domain: string): string {
    const normalized = domain.toLowerCase().replace(/^~/u, '');
    if (isEntityScope(normalized) || !/^[a-z0-9.-]+$/u.test(normalized)) {
        return '';
    }
    return normalized.split('.').at(-1) ?? '';
}

/**
 * Derive domain-affinity facts for one normalized repository rule.
 *
 * These facts only rank rules that already have the exact requested target. They do not decide
 * whether a candidate is visually correct or eligible for publication.
 *
 * @param existing - Normalized exact-target repository rule.
 * @param requestedDomain - Reported site hostname supplied with the search.
 * @returns Comparable domain-affinity tuple.
 */
function domainAffinityRank(
    existing: NormalizedRule,
    requestedDomain: string | undefined,
): DomainAffinityRank {
    if (!requestedDomain) {
        return { applies: 0, sameLabelOnly: 0, sameLabelCount: 0, shared: 0 };
    }
    const normalizedDomain = requestedDomain.toLowerCase().replace(/\.$/u, '');
    const positiveDomains = existing.domains.filter((domain) => !domain.startsWith('~'));
    const requestedLabel = finalDomainLabel(normalizedDomain);
    const sameLabelCount = requestedLabel
        ? positiveDomains.filter((domain) => finalDomainLabel(domain) === requestedLabel).length
        : 0;
    const applies =
        positiveDomains.length === 0 ||
        positiveDomains.some((domain) => domainScopeCovers(domain, normalizedDomain));
    return {
        applies: applies ? 1 : 0,
        sameLabelOnly: sameLabelCount > 0 && sameLabelCount === positiveDomains.length ? 1 : 0,
        sameLabelCount,
        shared: positiveDomains.length >= 2 ? 1 : 0,
    };
}

/**
 * Compare two exact-target matches by reported-domain affinity before repository order.
 *
 * @param left - First preliminary match.
 * @param right - Second preliminary match.
 * @param requestedDomain - Reported hostname supplied with the selector search.
 * @returns Negative when left should be presented first.
 */
function compareDomainAffinity(
    left: PreliminaryMatch,
    right: PreliminaryMatch,
    requestedDomain: string | undefined,
): number {
    const a = domainAffinityRank(left.normalized, requestedDomain);
    const b = domainAffinityRank(right.normalized, requestedDomain);
    return (
        b.applies - a.applies ||
        b.sameLabelOnly - a.sameLabelOnly ||
        b.sameLabelCount - a.sameLabelCount ||
        b.shared - a.shared
    );
}

/**
 * Determine whether a raw line is worth normalizing for a given query.
 *
 * Substring pre-filter for performance: the line must contain the query's domain / selector /
 * url-pattern / scriptlet token before normalization runs.
 *
 * @param line - The raw filter line.
 * @param query - The search query.
 * @returns True if the line is a candidate worth normalizing.
 */
function preFilter(line: string, query: SearchQuery): boolean {
    const lower = line.toLowerCase();
    if (query.domain && domainScopeSearchTerms(query.domain).some((term) => lower.includes(term))) {
        return true;
    }
    if (query.selector && lower.includes(query.selector.toLowerCase())) {
        return true;
    }
    if (query.urlPattern) {
        const domain = query.urlPattern.replace(/^\|\|/, '').replace(/\^.*$/, '').toLowerCase();
        if (domain && lower.includes(domain)) {
            return true;
        }
    }
    if (query.scriptlet && lower.includes(query.scriptlet.toLowerCase())) {
        return true;
    }
    return false;
}

/**
 * Find the section name containing a given 1-based line number.
 *
 * @param sections - The file's sections.
 * @param line - The 1-based line number.
 * @returns The section name or undefined.
 */
function sectionForLine(
    sections: PlacementMap['files'][number]['sections'],
    line: number,
): string | undefined {
    return sections.find((s) => line >= s.startLine && line <= s.endLine)?.name;
}

/**
 * Search the checkout for rules matching the query.
 *
 * Matching uses normalization (not raw grep): each candidate line is normalized and kept when it
 * answers the query ({@link matchesQuery}). A substring pre-filter keeps the scan fast on large
 * checkouts. Matches carry where they are, never how they relate to the candidate: that is the
 * agent's reading of the rules it is shown.
 *
 * @param query - The candidate rule target. At least one field is required.
 * @param map - The placement map for the checkout.
 * @param checkoutPath - Absolute path to the checkout root.
 * @returns Matching rules with their locations, the reported site's closest first.
 */
export function searchRules(
    query: SearchQuery,
    map: PlacementMap,
    checkoutPath: string,
): RuleMatch[] {
    const hasTarget =
        query.domain !== undefined ||
        query.selector !== undefined ||
        query.urlPattern !== undefined ||
        query.scriptlet !== undefined;
    if (!hasTarget) {
        throw new Error(
            'searchRules requires at least one of domain/selector/urlPattern/scriptlet',
        );
    }

    const preliminary: PreliminaryMatch[] = [];

    for (const file of map.files) {
        const absPath = join(checkoutPath, file.relativePath);
        const lines = readFileSync(absPath, 'utf8').split(/\r?\n/);
        lines.forEach((line, idx) => {
            const lineNo = idx + 1;
            if (!preFilter(line, query)) {
                return;
            }
            const normalized = normalizeRule(line);
            if (
                normalized.kind === RuleKind.Comment ||
                normalized.kind === RuleKind.Empty ||
                normalized.kind === RuleKind.Unknown
            ) {
                return;
            }
            if (!matchesQuery(query, normalized)) {
                return;
            }
            preliminary.push({
                rule: line,
                filePath: file.relativePath,
                line: lineNo,
                filter: file.filter,
                section: sectionForLine(file.sections, lineNo),
                normalized,
            });
        });
    }

    const rankedResults = preliminary.map((m) => ({
        preliminary: m,
        match: {
            rule: m.rule,
            filePath: m.filePath,
            line: m.line,
            filter: m.filter,
            section: m.section,
        } satisfies RuleMatch,
    }));

    rankedResults.sort(
        (a, b) =>
            compareDomainAffinity(a.preliminary, b.preliminary, query.domain) ||
            a.match.filter.localeCompare(b.match.filter) ||
            a.match.line - b.match.line,
    );
    return rankedResults.map(({ match }) => match);
}
