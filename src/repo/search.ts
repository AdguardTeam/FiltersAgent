import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import type { FilterFileEntry, PlacementMap, SearchQuery, RuleMatch } from '../types/repo-context';
import { SearchQuerySchema } from '../types/repo-context';
import type { FileOutline } from './file-outline';
import { buildFileOutline } from './file-outline';
import { filterFileLines } from './filter-file-lines';
import { RuleKind, normalizeRule, type NormalizedRule } from './rule-normalizer';
import { matchesQuery } from './rule-matcher';
import { domainScopeCovers, domainScopeSearchTerms, finalDomainLabel } from './domain-scope';

/**
 * How many lines a file window shows on either side of the line it is opened at.
 */
export const FILE_WINDOW_RADIUS_LINES = 15;

/**
 * One verbatim, numbered slice of a list file around a chosen line.
 */
export interface ListFileWindow {
    /**
     * Checkout-relative path of the file the window was read from.
     */
    filePath: string;

    /**
     * Number of lines in the file, in the {@link filterFileLines} line model.
     */
    lineCount: number;

    /**
     * The window's lines, in file order, each with its 1-based number.
     */
    lines: Array<{
        /**
         * 1-based line number inside the file.
         */
        line: number;

        /**
         * Exact line text.
         */
        text: string;
    }>;
}

/**
 * The marker outline of one named list file, carrying the canonical path the placement map found.
 */
export interface ListFileOutline extends FileOutline {
    /**
     * Checkout-relative path of the file, exactly as the placement map records it.
     */
    filePath: string;
}

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
 * Resolve one model-supplied file path against the checkout's list files.
 *
 * @param map - Placement map of the checkout.
 * @param filePath - Untrusted model-supplied path.
 * @returns The map entry naming the file.
 * @throws {Error} Naming the path when the checkout holds no list file at it.
 */
function listFileEntry(map: PlacementMap, filePath: string): FilterFileEntry {
    const normalized = filePath.replace(/\\/gu, '/');
    const entry = map.files.find((file) => file.relativePath.replace(/\\/gu, '/') === normalized);
    if (entry === undefined) {
        throw new Error(
            `${filePath} is not one of the checkout's list files. Pass a file path exactly as ` +
                'search_rules reports it.',
        );
    }
    return entry;
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
    const checked = v.parse(SearchQuerySchema, query);
    const hasTarget =
        checked.domain !== undefined ||
        checked.selector !== undefined ||
        checked.urlPattern !== undefined ||
        checked.scriptlet !== undefined;
    if (!hasTarget) {
        throw new Error(
            'searchRules requires at least one of domain/selector/urlPattern/scriptlet',
        );
    }
    const onlyFile =
        checked.filePath === undefined ? undefined : listFileEntry(map, checked.filePath);

    const preliminary: PreliminaryMatch[] = [];

    for (const file of map.files) {
        if (onlyFile !== undefined && file !== onlyFile) {
            continue;
        }
        const absPath = join(checkoutPath, file.relativePath);
        const lines = filterFileLines(readFileSync(absPath, 'utf8'));
        lines.forEach((line, idx) => {
            const lineNo = idx + 1;
            if (!preFilter(line, checked)) {
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
            if (!matchesQuery(checked, normalized)) {
                return;
            }
            preliminary.push({
                rule: line,
                filePath: file.relativePath,
                line: lineNo,
                filter: file.filter,
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
        } satisfies RuleMatch,
    }));

    rankedResults.sort(
        (a, b) =>
            compareDomainAffinity(a.preliminary, b.preliminary, checked.domain) ||
            a.match.filter.localeCompare(b.match.filter) ||
            a.match.line - b.match.line,
    );
    return rankedResults.map(({ match }) => match);
}

/**
 * Read the outline of one list file.
 *
 * @param map - The placement map for the checkout.
 * @param checkoutPath - Absolute path to the checkout root.
 * @param filePath - Checkout-relative path of the list file.
 * @returns The file's canonical path, header, markers, regions and line count.
 * @throws {Error} Naming the path when the checkout holds no list file at it.
 */
export function outlineListFile(
    map: PlacementMap,
    checkoutPath: string,
    filePath: string,
): ListFileOutline {
    const entry = listFileEntry(map, filePath);
    return {
        filePath: entry.relativePath,
        ...buildFileOutline(
            filterFileLines(readFileSync(join(checkoutPath, entry.relativePath), 'utf8')),
        ),
    };
}

/**
 * Read a verbatim, numbered window of one list file around a chosen line.
 *
 * @param map - The placement map for the checkout.
 * @param checkoutPath - Absolute path to the checkout root.
 * @param filePath - Checkout-relative path of the list file.
 * @param line - One-based line the window is centred on.
 * @returns The file's line count and {@link FILE_WINDOW_RADIUS_LINES} lines either side.
 * @throws {Error} Naming the line and the file's line count when the line is outside it.
 */
export function readListFileWindow(
    map: PlacementMap,
    checkoutPath: string,
    filePath: string,
    line: number,
): ListFileWindow {
    const entry = listFileEntry(map, filePath);
    const lines = filterFileLines(readFileSync(join(checkoutPath, entry.relativePath), 'utf8'));
    const lineCount = lines.length;
    if (!Number.isInteger(line) || line < 1 || line > lineCount) {
        throw new Error(
            `Line ${line} is outside ${filePath}, which has ${lineCount} lines. Pass a line ` +
                `between 1 and ${lineCount}.`,
        );
    }
    const first = Math.max(1, line - FILE_WINDOW_RADIUS_LINES);
    const last = Math.min(lineCount, line + FILE_WINDOW_RADIUS_LINES);
    return {
        filePath: entry.relativePath,
        lineCount,
        lines: Array.from({ length: last - first + 1 }, (_unused, index) => ({
            line: first + index,
            text: lines[first + index - 1],
        })),
    };
}
