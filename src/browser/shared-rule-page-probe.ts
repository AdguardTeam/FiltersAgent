/**
 * Fixed probe comparing the selectors of shared element-hiding rules with the elements one searched
 * selector matches in the top document of a page.
 *
 * It matches natively (`Element.matches`, `querySelector`) and only reads: it changes nothing on
 * the page and applies no rule, so it tells which existing rule would hide an element, never that
 * the blocker hides it — only a validation phase shows that.
 */
import type { Page } from 'playwright-core';
import * as v from 'valibot';
import { decodeProbeInputExpression, encodeProbeInput } from './page-probe-transport';
import { createTrustedPageEvaluator } from './trusted-page-evaluator';

/**
 * How the element a shared rule hides relates to the element the searched selector matches.
 */
export const PageMatchRelation = {
    Same: 'same',
    Ancestor: 'ancestor',
    Descendant: 'descendant',
} as const;

/**
 * One relation between a shared rule's element and the searched one.
 */
export type PageMatchRelation = (typeof PageMatchRelation)[keyof typeof PageMatchRelation];

/**
 * Every relation, for the probe result's picklist.
 */
const PAGE_MATCH_RELATION_VALUES = Object.values(PageMatchRelation);

/**
 * Outcomes of one selector probe.
 */
export const SelectorProbeStatus = {
    Checked: 'checked',
    NoElement: 'no_element',
    SelectorNotSupported: 'selector_not_supported',
} as const;

/**
 * One selector probe outcome.
 */
export type SelectorProbeStatus = (typeof SelectorProbeStatus)[keyof typeof SelectorProbeStatus];

/**
 * Every probe outcome, for the probe result's picklist.
 */
const SELECTOR_PROBE_STATUS_VALUES = Object.values(SelectorProbeStatus);

/**
 * Most elements of the searched selector the rules are compared with. A selector naming one notice
 * matches one element; twenty covers a repeated widget without letting a broad selector multiply
 * the comparisons by the page's size.
 */
const MAX_PROBE_TARGET_ELEMENTS = 20;

/**
 * Most levels above the searched element a wrapper may sit. Consent platforms wrap their banner a
 * level or two deep (a CCM19 `.ccm-root`, a Ketch `#ketch-banner`); three keeps those while a
 * page-wide container stays out. `body` and `html` never count.
 */
const MAX_ANCESTOR_LEVELS = 3;

/**
 * Most elements inside the searched elements the probe looks for a rule's element among. Past it,
 * thousands of rule selectors run against a large subtree would hold the page's main thread for
 * seconds, so a larger subtree reports `descendantsChecked: false` instead.
 */
const MAX_DESCENDANT_SCAN_ELEMENTS = 2_000;

/**
 * Schema of the probe's answer for one call, its rule indexes bounded by the rules it was given.
 *
 * @param ruleCount - Number of rule selectors the probe compared.
 * @returns The schema the page's answer is parsed with.
 */
function selectorPageProbeSchema(ruleCount: number) {
    return v.strictObject({
        status: v.picklist(SELECTOR_PROBE_STATUS_VALUES),
        elementCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
        comparedElementCount: v.pipe(
            v.number(),
            v.integer(),
            v.minValue(0),
            v.maxValue(MAX_PROBE_TARGET_ELEMENTS),
        ),
        uncheckedCount: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(ruleCount)),
        descendantsChecked: v.boolean(),
        // The probe answers at most once per rule; in Firefox it runs in the page's own world, so a
        // longer list is a page script inflating it.
        matches: v.pipe(
            v.array(
                v.strictObject({
                    index: v.pipe(
                        v.number(),
                        v.integer(),
                        v.minValue(0),
                        v.maxValue(ruleCount - 1),
                    ),
                    relation: v.picklist(PAGE_MATCH_RELATION_VALUES),
                    levels: v.pipe(v.number(), v.integer(), v.minValue(0)),
                    elsewhere: v.pipe(v.number(), v.integer(), v.minValue(0)),
                }),
            ),
            v.maxLength(ruleCount),
        ),
    });
}

/**
 * What one selector probe found: how many elements the searched selector matches, how many of them
 * the rules were compared with, and each rule selector that hides one of those, a wrapper or a part
 * of them, by its index in the given list.
 */
export type SelectorPageProbe = v.InferOutput<ReturnType<typeof selectorPageProbeSchema>>;

/**
 * Build the probe expression around one encoded input.
 *
 * The input arrives as base64 of UTF-8 JSON and is decoded as UTF-8, so a selector naming non-Latin
 * text matches that text. Only the first elements of the searched selector are compared, and the
 * answer says how many. A rule selector the browser cannot parse throws on its first comparison and
 * is counted as unchecked; a match also counts the elements elsewhere on the page that the rule's
 * selector would hide: outside every element the searched selector matches — compared or not —
 * their wrappers and their contents.
 *
 * @param encodedInput - Base64 JSON holding `selector` and the `rules` selectors.
 * @returns A self-contained expression returning the probe's answer.
 */
function selectorPageProbeExpression(encodedInput: string): string {
    return `(function () {
    'use strict';
    var MAX_TARGET_ELEMENTS = ${MAX_PROBE_TARGET_ELEMENTS};
    var MAX_ANCESTOR_LEVELS = ${MAX_ANCESTOR_LEVELS};
    var MAX_DESCENDANT_SCAN_ELEMENTS = ${MAX_DESCENDANT_SCAN_ELEMENTS};
    var input = ${decodeProbeInputExpression(encodedInput)};
    var unchecked = function (status) {
        return {
            status: status,
            elementCount: 0,
            comparedElementCount: 0,
            uncheckedCount: 0,
            descendantsChecked: false,
            matches: [],
        };
    };
    var found;
    try {
        found = Array.prototype.slice.call(document.querySelectorAll(input.selector));
    } catch (error) {
        return unchecked('${SelectorProbeStatus.SelectorNotSupported}');
    }
    if (found.length === 0) {
        return unchecked('${SelectorProbeStatus.NoElement}');
    }
    var targets = found.slice(0, MAX_TARGET_ELEMENTS);
    var stopAt = [document.body, document.documentElement];
    var ancestorChains = targets.map(function (target) {
        var chain = [];
        var current = target.parentElement;
        while (current && stopAt.indexOf(current) === -1 && chain.length < MAX_ANCESTOR_LEVELS) {
            chain.push(current);
            current = current.parentElement;
        }
        return chain;
    });
    var innerElementCount = targets.reduce(function (sum, target) {
        return sum + target.getElementsByTagName('*').length;
    }, 0);
    var descendantsChecked = innerElementCount <= MAX_DESCENDANT_SCAN_ELEMENTS;
    // Every element the searched selector matches, and every wrapper of one, so an element the
    // rule also hides counts as elsewhere in a walk up its own ancestors, whatever the page's size.
    var searched = new Set(found);
    var wrappers = new Set();
    found.forEach(function (element) {
        var parent = element.parentElement;
        while (parent && !wrappers.has(parent)) {
            wrappers.add(parent);
            parent = parent.parentElement;
        }
    });
    var relatesToSearched = function (element) {
        if (wrappers.has(element)) {
            return true;
        }
        for (var current = element; current; current = current.parentElement) {
            if (searched.has(current)) {
                return true;
            }
        }
        return false;
    };
    var levelsBelow = function (target, element) {
        var levels = 0;
        var current = element;
        while (current && current !== target) {
            levels += 1;
            current = current.parentElement;
        }
        return levels;
    };
    var relationOf = function (ruleSelector) {
        var same = targets.some(function (target) {
            return target.matches(ruleSelector);
        });
        if (same) {
            return { relation: '${PageMatchRelation.Same}', levels: 0 };
        }
        for (var level = 0; level < MAX_ANCESTOR_LEVELS; level += 1) {
            for (var chainIndex = 0; chainIndex < ancestorChains.length; chainIndex += 1) {
                var ancestor = ancestorChains[chainIndex][level];
                if (ancestor && ancestor.matches(ruleSelector)) {
                    return { relation: '${PageMatchRelation.Ancestor}', levels: level + 1 };
                }
            }
        }
        if (descendantsChecked) {
            for (var targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
                var inner = targets[targetIndex].querySelector(ruleSelector);
                if (inner) {
                    return {
                        relation: '${PageMatchRelation.Descendant}',
                        levels: levelsBelow(targets[targetIndex], inner),
                    };
                }
            }
        }
        return undefined;
    };
    var matches = [];
    var uncheckedCount = 0;
    input.rules.forEach(function (ruleSelector, index) {
        var hit;
        try {
            hit = relationOf(ruleSelector);
        } catch (error) {
            uncheckedCount += 1;
            return;
        }
        if (!hit) {
            return;
        }
        var elsewhere = Array.prototype.filter.call(
            document.querySelectorAll(ruleSelector),
            function (element) {
                return !relatesToSearched(element);
            },
        ).length;
        matches.push({ index: index, relation: hit.relation, levels: hit.levels, elsewhere: elsewhere });
    });
    return {
        status: '${SelectorProbeStatus.Checked}',
        elementCount: found.length,
        comparedElementCount: targets.length,
        uncheckedCount: uncheckedCount,
        descendantsChecked: descendantsChecked,
        matches: matches,
    };
})()`;
}

/**
 * Compare the selectors of shared rules with the elements one selector matches on a page.
 *
 * The probe runs in an isolated world where the browser offers one (Chromium) and in the page's
 * main world otherwise (Firefox); either way the page's answer is parsed before it is used.
 *
 * @param page - Page of the agent's live browser session.
 * @param selector - Selector the agent searched.
 * @param ruleSelectors - Distinct selectors of the shared rules to compare, by index.
 * @returns What the probe found.
 * @throws When the page answers with anything but the probe's result.
 */
export async function probeSelectorsOnPage(
    page: Page,
    selector: string,
    ruleSelectors: readonly string[],
): Promise<SelectorPageProbe> {
    const evaluator = await createTrustedPageEvaluator(page);
    const answer = await evaluator.evaluate(
        selectorPageProbeExpression(encodeProbeInput({ selector, rules: ruleSelectors })),
    );
    return v.parse(selectorPageProbeSchema(ruleSelectors.length), answer);
}
