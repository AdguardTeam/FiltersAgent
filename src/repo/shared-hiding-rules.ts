import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlacementMap } from '../types/repo-context';
import { RuleSyntaxKind } from '../types/rule-syntax-kind';
import { projectGroupLines } from './project-groups';
import { isExtensibleSharedRule, normalizedFamilySignature } from './rule-family';
import { RuleKind, normalizeRule } from './rule-normalizer';

/**
 * Cosmetic syntaxes that hide the elements their selector matches: `##` and `#?#`.
 */
const HIDING_SYNTAX_KINDS: ReadonlySet<RuleSyntaxKind> = new Set([
    RuleSyntaxKind.ElementHiding,
    RuleSyntaxKind.ExtendedElementHiding,
]);

/**
 * One element-hiding rule several sites share, as a list file holds it.
 */
export interface SharedHidingRule {
    /**
     * Repository path of the list file holding the rule, as `search_rules` reports it.
     */
    filePath: string;

    /**
     * One-based line of the rule in that file.
     */
    line: number;

    /**
     * The rule's selector, whitespace collapsed, as the browser matches it.
     */
    selector: string;

    /**
     * The rule without its domains: separator and selector, such as `##.fixed.bottom-0`.
     */
    signature: string;

    /**
     * The sites the rule lists, lowercased and sorted.
     */
    domains: readonly string[];

    /**
     * Every line of the group the file keeps the rule in — the rules repeating its exact domain
     * list — ascending and including its own; empty when the rule stands alone. The extension
     * planner never extends a grouped rule: a site added to one line would miss the rest.
     */
    groupLines: readonly number[];
}

/**
 * Collect every element-hiding rule of the checkout that several sites share.
 *
 * A rule qualifies when it is an element-hiding rule (`##` or `#?#`) listing two or more sites,
 * none excluded, with no `[$…]` block. The extension planner could extend one that stands alone; a
 * rule its file keeps in a group is collected with the group's lines, because a maintainer adds a
 * new site to every line of the group. Whether a rule already covers the reported site is the
 * caller's check.
 *
 * @param map - Placement map of the checkout.
 * @param checkoutPath - Absolute path of the checkout.
 * @returns The shared hiding rules of every list file, in map and line order.
 */
export function collectSharedHidingRules(
    map: PlacementMap,
    checkoutPath: string,
): SharedHidingRule[] {
    const shared: SharedHidingRule[] = [];
    for (const file of map.files) {
        const rules = readFileSync(join(checkoutPath, file.relativePath), 'utf8')
            .split(/\r?\n/)
            .map(normalizeRule);
        const projectGroups = projectGroupLines(rules);
        rules.forEach((rule, index) => {
            const signature = normalizedFamilySignature(rule);
            if (
                rule.kind !== RuleKind.Cosmetic ||
                rule.syntaxKind === undefined ||
                !HIDING_SYNTAX_KINDS.has(rule.syntaxKind) ||
                rule.selector === undefined ||
                signature === undefined ||
                !isExtensibleSharedRule(rule)
            ) {
                return;
            }
            shared.push({
                filePath: file.relativePath,
                line: index + 1,
                selector: rule.selector,
                signature,
                domains: rule.domains,
                groupLines: projectGroups.get(index + 1) ?? [],
            });
        });
    }
    return shared;
}
