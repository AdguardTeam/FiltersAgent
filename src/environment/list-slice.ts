/**
 * A slice of one built-in filter list: the lines of the build's own text of that list a browser
 * session runs instead of the whole list, as a trusted custom filter, while the built-in list stays
 * off. The agent halves a list this way once the list behind a problem is known; nothing here
 * decides which lines matter.
 */

/**
 * Which lines of which list a session runs.
 */
export interface ListSlice {
    /**
     * The built-in list, in the extension's own registry numbering.
     */
    filterId: number;

    /**
     * First line of the slice, 1-based, inclusive, into the build's own text of the list.
     */
    firstLine: number;

    /**
     * Last line of the slice, 1-based, inclusive.
     */
    lastLine: number;
}

/**
 * Longest slice whose lines the launch answer quotes. A slice this short is the end of a halving,
 * where the agent needs the rule texts themselves; a longer one is still being narrowed and its
 * text would only crowd the answer.
 */
export const MAX_REPORTED_SLICE_LINES = 40;

/**
 * The MV3 dynamic-rule budget a slice session draws on: a custom filter compiles into Chrome's
 * dynamic rules, which the browser caps, keeping the first rules and dropping the rest. The agent
 * reads these to know whether the slice ran whole.
 */
export interface SliceDynamicRules {
    /**
     * Dynamic rules the extension has compiled, the slice's included.
     */
    enabled: number;

    /**
     * Dynamic rules the browser allows at once.
     */
    maximum: number;

    /**
     * Compiled dynamic rules Chrome classes as unsafe (redirects, header changes, ...).
     */
    unsafeEnabled: number;

    /**
     * Unsafe dynamic rules the browser allows at once.
     */
    unsafeMaximum: number;

    /**
     * Compiled dynamic rules with a regular-expression condition.
     */
    regexEnabled: number;

    /**
     * Regular-expression dynamic rules the browser allows at once.
     */
    regexMaximum: number;
}

/**
 * What a session that runs a slice reports about it, once the slice is installed and verified.
 */
export interface ListSliceFacts extends ListSlice {
    /**
     * Line count of the whole list in the build's own text.
     */
    totalLines: number;

    /**
     * The id the extension allocated to the slice's custom filter, which the filtering log names.
     */
    customFilterId: number;

    /**
     * The dynamic-rule counters read back after the slice was installed.
     */
    dynamicRules: SliceDynamicRules;

    /**
     * Whether the dynamic-rule count reached the browser's cap: Chrome keeps the first rules and
     * drops the rest, so a slice at the limit did not run whole and must be halved before its
     * outcome is trusted.
     */
    atLimit: boolean;

    /**
     * The slice's own lines, as the build's text has them, when the slice is at most
     * {@link MAX_REPORTED_SLICE_LINES} lines long.
     */
    lines?: string[];
}

/**
 * One built-in list a session runs, with the line count the agent picks a slice range from.
 */
export interface EnabledListFacts {
    /**
     * The list, in the extension's own registry numbering.
     */
    id: number;

    /**
     * The list's name as the extension's options metadata carries it.
     */
    name: string;

    /**
     * Line count of the build's own text of the list, or null when the build carries no text for it
     * — such a list cannot be sliced.
     */
    lines: number | null;
}

/**
 * How many lines a slice spans.
 *
 * @param slice - The slice.
 * @returns Its line count.
 */
export function sliceLineCount(slice: ListSlice): number {
    return slice.lastLine - slice.firstLine + 1;
}

/**
 * The title the slice's custom filter carries, which the extension's filtering log and options
 * metadata then show for it.
 *
 * @param listName - The built-in list's name.
 * @param slice - The slice.
 * @param totalLines - Line count of the whole list text.
 * @returns The title.
 */
export function sliceTitle(listName: string, slice: ListSlice, totalLines: number): string {
    return `${listName} lines ${slice.firstLine}-${slice.lastLine} of ${totalLines}`;
}
