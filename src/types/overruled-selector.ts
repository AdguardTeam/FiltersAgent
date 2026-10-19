/**
 * Where the selector a breakage phase was judged by came from.
 *
 * A cosmetic candidate is judged by its own selector; a network candidate by the
 * `adElementSelector` the model passed. The advice for a selector that stayed visible differs: the
 * model can drop a selector it passed, but must change a rule whose own selector matches the wrong
 * element.
 */
export const SelectorSource = {
    /**
     * The candidate rule's own selector.
     */
    Rule: 'rule',

    /**
     * The `adElementSelector` the model passed with a network candidate.
     */
    AdElementSelector: 'ad_element_selector',
} as const;

/**
 * SelectorSource value.
 */
export type SelectorSource = (typeof SelectorSource)[keyof typeof SelectorSource];

/**
 * A selector whose element stayed visible in the filtered baseline while vision saw the breakage.
 */
export interface OverruledSelector {
    /**
     * The selector the phase was judged by.
     */
    selector: string;

    /**
     * Where that selector came from.
     */
    source: SelectorSource;
}
