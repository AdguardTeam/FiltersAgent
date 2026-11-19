/**
 * The `search_rules` tool: the model's only view of the AdguardFilters checkout. The compaction of
 * the rule inventory, the outline and the window lives in `rule-search-compact.ts`; this module
 * validates the call's shape, selects the form the model receives and runs the page check a
 * selector query makes against the agent's open page.
 */
import * as v from 'valibot';
import { outlineListFile, readListFileWindow, searchRules } from '../repo/search';
import { collectSharedHidingRules, type SharedHidingRule } from '../repo/shared-hiding-rules';
import type { IArtifactStore } from '../tracer/artifact-store';
import type { PlacementMap } from '../types/repo-context';
import { registeredParameters } from './registered-parameters';
import {
    compactDomainRuleInventory,
    compactListFileOutline,
    compactListFileWindow,
} from './rule-search-compact';
import { checkSelectorOnPage, type ActivePage } from './rule-search-page-check';
import { SEARCH_RULES_PARAMETERS, type SearchRulesArguments } from './tool-catalog';
import { TOOL_GUIDANCE } from './tool-guidance';
import { ToolName } from './tool-names';
import type { ToolRegistry } from './tool-registry';

/**
 * Maximum exact-target repository matches returned in one model-visible search response.
 */
const MAX_AGENT_RULE_SEARCH_MATCHES = 20;

/**
 * Whether one `search_rules` call is a file read rather than a target enumeration.
 *
 * An outline or window read answers a different question from a match query, so it neither extends
 * nor resets the enumeration streak: only target queries are counted by the backstop.
 *
 * @param args - The raw call arguments, before validation.
 * @returns Whether the call reads a file outline or window; false for a call the tool refuses.
 */
export function isRuleSearchRead(args: unknown): boolean {
    const call = v.safeParse(SEARCH_RULES_PARAMETERS, args);
    return call.success && call.output.filePath !== undefined && !hasSearchTarget(call.output);
}

/**
 * Whether a `search_rules` call names something to match rules against.
 *
 * @param call - The validated call arguments.
 * @returns Whether a target field is present.
 */
function hasSearchTarget(call: SearchRulesArguments): boolean {
    return (
        call.domain !== undefined ||
        call.selector !== undefined ||
        call.urlPattern !== undefined ||
        call.scriptlet !== undefined
    );
}

/**
 * The one message naming every accepted `search_rules` call shape.
 */
const SEARCH_RULES_CALL_SHAPES =
    "search_rules takes one of three shapes: filePath alone for that file's outline, filePath " +
    'with line for a window around that line, or a target field (domain, selector, urlPattern, ' +
    'scriptlet) for matches, optionally with filePath to limit the matches to one list file.';

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
     * Runner-bound reported hostname, used to rank a selector query's text matches against the
     * reported site. Undefined when no trusted hostname is bound to the run. The page check scopes
     * its candidates to the live session's own domain instead.
     */
    trustedReportedDomain: string | undefined;

    /**
     * Store a truncated answer is persisted to in full — a domain inventory or a page check's match
     * list; undefined when the run has none.
     */
    artifactStore: IArtifactStore | undefined;

    /**
     * The live session's page and the domain it was launched on, read at call time, and undefined
     * while no session has navigated to its page. Supplied, a selector query also checks the
     * checkout's shared hiding rules against that page.
     */
    activePage?: () => ActivePage | undefined;

    /**
     * File the run's instruction declares for hiding rules, where every hiding candidate goes as a
     * new line; undefined when it declares none.
     */
    declaredHidingFile?: string;
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
    const { checkoutPath, map, trustedReportedDomain, artifactStore, activePage } = options;
    // The checkout stays pinned for the whole run, so its shared rules are collected once, at the
    // first page check.
    let sharedRules: SharedHidingRule[] | undefined;
    const sharedRulesOnce = (): SharedHidingRule[] => {
        sharedRules ??= collectSharedHidingRules(map, checkoutPath);
        return sharedRules;
    };
    registry.register({
        definition: {
            type: 'function',
            function: {
                name: ToolName.SearchRules,
                description: TOOL_GUIDANCE[ToolName.SearchRules]!,
                parameters: registeredParameters(ToolName.SearchRules),
            },
        },
        handler: async (args) => {
            const parsed: SearchRulesArguments = v.parse(SEARCH_RULES_PARAMETERS, args);
            const { filePath, line, domain, selector, urlPattern, scriptlet } = parsed;
            const query = { domain, selector, urlPattern, scriptlet };
            const hasTarget = hasSearchTarget(parsed);
            if (line !== undefined && (filePath === undefined || hasTarget)) {
                throw new Error(SEARCH_RULES_CALL_SHAPES);
            }
            if (filePath !== undefined && !hasTarget) {
                if (line !== undefined) {
                    return compactListFileWindow(
                        readListFileWindow(map, checkoutPath, filePath, line),
                    );
                }
                return compactListFileOutline(outlineListFile(map, checkoutPath, filePath));
            }
            if (!hasTarget) {
                throw new Error(SEARCH_RULES_CALL_SHAPES);
            }
            const effectiveDomain = query.selector
                ? (trustedReportedDomain ?? query.domain)
                : query.domain;
            const effectiveQuery = {
                ...query,
                ...(effectiveDomain ? { domain: effectiveDomain } : {}),
                ...(filePath === undefined ? {} : { filePath }),
            };
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
            const pageCheck =
                query.selector !== undefined && activePage !== undefined
                    ? await checkSelectorOnPage(query.selector, {
                          activePage,
                          sharedRules: sharedRulesOnce,
                          declaredFile: options.declaredHidingFile,
                          artifactStore,
                      })
                    : undefined;
            return {
                effectiveDomain,
                totalMatches: allMatches.length,
                truncated: allMatches.length > matches.length,
                matches,
                ...(pageCheck === undefined ? {} : { pageCheck }),
            };
        },
    });
}
