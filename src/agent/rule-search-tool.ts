/**
 * The `search_rules` tool: the model's only view of the AdguardFilters checkout, together with the
 * rule-inventory compaction and byte caps that keep a domain-only query from spending the whole
 * model-facing response budget on one repository.
 */
import { searchRules } from '../repo/search';
import { RuleKind, normalizeRule } from '../repo/rule-normalizer';
import type { IArtifactStore } from '../tracer/artifact-store';
import type { PlacementMap } from '../types/repo-context';
import { registeredParameters } from './registered-parameters';
import { ToolName } from './tool-names';
import type { ToolRegistry } from './tool-registry';
import { truncateUtf8 } from './truncate-utf8';

/**
 * Maximum exact-target repository matches returned in one model-visible search response.
 */
const MAX_AGENT_RULE_SEARCH_MATCHES = 20;

/**
 * Maximum number of domain-inventory matches shown directly to the model.
 */
const MAX_AGENT_DOMAIN_INVENTORY_MATCHES = 8;

/**
 * Maximum UTF-8 bytes of an individual domain-inventory rule preview.
 */
const MAX_DOMAIN_INVENTORY_RULE_PREVIEW_BYTES = 384;

/**
 * Maximum UTF-8 bytes of a filter or section label echoed back with an inventory match.
 *
 * These are repository-authored file titles and section headings, not rule text: a couple of words
 * in every real filter list. The cap only stops a malformed list header from displacing the match
 * facts the model actually chooses a follow-up query from.
 */
const MAX_INVENTORY_LABEL_BYTES = 128;

/**
 * Inventory families of repository rules as counted for the model-facing domain inventory.
 *
 * The three actionable kinds map straight onto their rule kinds; everything else (comments, empty
 * lines, unparsable text) collapses into `other`.
 */
const RuleInventoryKind = {
    Cosmetic: RuleKind.Cosmetic,
    Network: RuleKind.Network,
    Scriptlet: RuleKind.Scriptlet,
    Other: 'other',
} as const;

/**
 * Inventory family of one repository rule.
 */
type RuleInventoryKind = (typeof RuleInventoryKind)[keyof typeof RuleInventoryKind];

/**
 * Return the main syntactic family of one normalized filter rule for an inventory count.
 *
 * @param rule - Raw repository rule text.
 * @returns Stable inventory family name.
 */
function ruleInventoryKind(rule: string): RuleInventoryKind {
    const normalized = normalizeRule(rule);
    if (
        normalized.kind === RuleKind.Cosmetic ||
        normalized.kind === RuleKind.Network ||
        normalized.kind === RuleKind.Scriptlet
    ) {
        return normalized.kind;
    }
    return RuleInventoryKind.Other;
}

/**
 * Reduce one domain-inventory match to facts useful for choosing a focused follow-up query.
 *
 * Domain-only results are not an exact rule-edit instruction. The complete rule remains in the
 * trace artifact, while this preview prevents one unusually long rule from consuming the model's
 * entire fixed response budget. The file path stays whole: it is what a draft names to place a rule
 * beside the site's existing ones.
 *
 * @param match - Full repository match.
 * @returns Compact representative inventory match.
 */
function compactDomainInventoryMatch(
    match: ReturnType<typeof searchRules>[number],
): Record<string, unknown> {
    const rulePreview = truncateUtf8(match.rule, MAX_DOMAIN_INVENTORY_RULE_PREVIEW_BYTES);
    return {
        rulePreview,
        rulePreviewTruncated: rulePreview !== match.rule,
        filePath: match.filePath,
        filter: truncateUtf8(match.filter, MAX_INVENTORY_LABEL_BYTES),
        section:
            match.section === undefined
                ? undefined
                : truncateUtf8(match.section, MAX_INVENTORY_LABEL_BYTES),
        line: match.line,
        syntaxKind: ruleInventoryKind(match.rule),
    };
}

/**
 * Produce the compact, grouped form of a domain-only rule inventory.
 *
 * The complete inventory remains in an artifact. This response intentionally offers a small
 * representative sample so the model can choose a focused selector, pattern, or scriptlet query.
 *
 * @param matches - All applicable repository matches for one domain.
 * @param effectiveDomain - Runner-bound domain used for the search.
 * @param artifactStore - Optional trace-backed store for the complete inventory.
 * @returns Bounded model-facing inventory response.
 */
function compactDomainRuleInventory(
    matches: ReturnType<typeof searchRules>,
    effectiveDomain: string | undefined,
    artifactStore: IArtifactStore | undefined,
): Record<string, unknown> {
    const grouped: Record<RuleInventoryKind, number> = {
        [RuleInventoryKind.Cosmetic]: 0,
        [RuleInventoryKind.Network]: 0,
        [RuleInventoryKind.Scriptlet]: 0,
        [RuleInventoryKind.Other]: 0,
    };
    for (const match of matches) {
        grouped[ruleInventoryKind(match.rule)] += 1;
    }
    const fullInventory = {
        effectiveDomain,
        totalMatches: matches.length,
        matches,
    };
    const artifactRef = artifactStore?.write(
        JSON.stringify(fullInventory, null, 2),
        'rule-search-inventory',
    );
    const topMatches = matches
        .slice(0, MAX_AGENT_DOMAIN_INVENTORY_MATCHES)
        .map(compactDomainInventoryMatch);
    return {
        effectiveDomain,
        totalMatches: matches.length,
        truncated: matches.length > topMatches.length,
        groupedInventory: grouped,
        topMatches,
        ...(artifactRef
            ? {
                  artifactId: artifactRef.id,
                  metaArtifact: {
                      id: artifactRef.id,
                      type: artifactRef.type,
                      bytes: artifactRef.bytes,
                  },
                  metaHint:
                      `Complete domain inventory is persisted. Use get_detail("${artifactRef.id}") ` +
                      'with a key or limit only when a focused follow-up needs it.',
              }
            : {}),
    };
}

/**
 * Everything the repository search tool needs to answer one model query.
 */
export interface RuleSearchToolOptions {
    /**
     * Path to the AdguardFilters checkout the search reads.
     */
    checkoutPath: string;

    /**
     * Placement map generated once for the checkout.
     */
    map: PlacementMap;

    /**
     * Runner-bound reported hostname, used to rank a selector query against the reported site.
     * Undefined when no trusted hostname is bound to the run.
     */
    trustedReportedDomain: string | undefined;

    /**
     * Store the complete domain inventory is persisted to; undefined when the run has none.
     */
    artifactStore: IArtifactStore | undefined;
}

/**
 * Register the `search_rules` tool against one checkout.
 *
 * @param registry - Registry receiving the tool.
 * @param options - Checkout, placement map, and the run's trusted search context.
 */
export function registerRuleSearchTool(
    registry: ToolRegistry,
    options: RuleSearchToolOptions,
): void {
    const { checkoutPath, map, trustedReportedDomain, artifactStore } = options;
    registry.register({
        definition: {
            type: 'function',
            function: {
                name: ToolName.SearchRules,
                description:
                    "Search this repository's filter lists for existing rules matching a domain, selector, URL " +
                    'pattern, or scriptlet. After a compound modifier selector is rejected, ' +
                    'search its stable base selector separately before retrying. When an ' +
                    'applicable multi-domain base rule exists, use it or extend its domain list ' +
                    'instead of changing only the candidate syntax. When search returns an ' +
                    'exact standard base element-hiding rule, validate its domain-scoped ## ' +
                    'candidate before attempting a modifier selector. The reported domain ' +
                    'being absent from a matching shared rule is expected: treat it as an ' +
                    'extend_domains candidate, not a reason to ignore that selector family. ' +
                    'A domain-only search returns a grouped compact inventory; use one focused ' +
                    'selector, URL pattern, or scriptlet query for exact matches.',
                parameters: registeredParameters(ToolName.SearchRules),
            },
        },
        handler: async (args) => {
            const query = {
                domain: typeof args.domain === 'string' ? args.domain : undefined,
                selector: typeof args.selector === 'string' ? args.selector : undefined,
                urlPattern: typeof args.urlPattern === 'string' ? args.urlPattern : undefined,
                scriptlet: typeof args.scriptlet === 'string' ? args.scriptlet : undefined,
            };
            const effectiveDomain = query.selector
                ? (trustedReportedDomain ?? query.domain)
                : query.domain;
            const effectiveQuery = effectiveDomain ? { ...query, domain: effectiveDomain } : query;
            const allMatches = searchRules(effectiveQuery, map, checkoutPath);
            const isDomainOnlyQuery =
                query.domain !== undefined &&
                query.selector === undefined &&
                query.urlPattern === undefined &&
                query.scriptlet === undefined;
            if (isDomainOnlyQuery) {
                return compactDomainRuleInventory(allMatches, effectiveDomain, artifactStore);
            }
            const matches = allMatches.slice(0, MAX_AGENT_RULE_SEARCH_MATCHES);
            return {
                effectiveDomain,
                totalMatches: allMatches.length,
                truncated: allMatches.length > matches.length,
                matches,
            };
        },
    });
}
