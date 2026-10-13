import { findCosmeticSeparator, normalizeRule, RuleKind } from './rule-normalizer';
import { samePlacementFamily } from './rule-family';

/**
 * Where a rule belongs inside a list file that keeps its rules sorted.
 *
 * Appending at the end of a sorted file is a visible mistake, not a neutral default: EasyList runs
 * `FOP.py` over its lists and its contributing guide asks for "the correct position following ASCII
 * ascending sorting", so a rule appended after the last line arrives out of place and a maintainer
 * has to move it. `easylist/easylist_specific_hide.txt`, for one, keeps its selector order intact
 * over 99.6% of adjacent lines, so an `append_eof` plan there lands a verified rule out of place.
 *
 * Sortedness is measured rather than assumed: the same measurement over AdguardFilters
 * `BaseFilter/sections/specific.txt` (0.519) and uAssets `filters/filters-2026.txt` (0.522) shows
 * those files are chronological logs, where the sorted position would be meaningless and the
 * existing domain-block and end-of-file anchors stay right.
 */

/**
 * The keys a filter list can be sorted by, as FOP sorts them.
 */
export const RuleSortKey = {
    /**
     * The whole rule text. FOP sorts blocking rules this way, lower-cased.
     */
    WholeLine: 'whole_line',

    /**
     * The rule with its leading domain list removed. FOP sorts element-hiding rules this way, so
     * `advfn.com###APS_BILLBOARD` sorts under `###APS_BILLBOARD` and the file reads as an ordered
     * index of selectors rather than of sites.
     */
    SelectorOnly: 'selector_only',
} as const;

/**
 * Every rule sort key value, for exhaustive listings.
 */
export const RULE_SORT_KEY_VALUES = Object.values(RuleSortKey);

/**
 * One key a filter list's rules can be ordered by.
 */
export type RuleSortKey = (typeof RuleSortKey)[keyof typeof RuleSortKey];

/**
 * Fraction of adjacent rule pairs that must already be in ascending order before a section counts
 * as sorted.
 *
 * Measured over the real lists this has to tell apart: the sorted ones score 0.989 to 1.000
 * (EasyList `easylist_specific_block.txt`, `easylist_adservers.txt`, `easylist_general_hide.txt`,
 * and `easylist_specific_hide.txt` under the selector key), while the chronological logs score
 * 0.519 (AdguardFilters `BaseFilter/sections/specific.txt`) and 0.522 (uAssets
 * `filters/filters-2026.txt`). The gap is enormous, so the threshold sits just under the worst
 * sorted list rather than at 1.0: a maintainer's single hand-placed line must not make a whole
 * sorted file look like a log.
 */
export const MIN_SORTED_ADJACENT_RATIO = 0.98;

/**
 * Fewest rules a section must hold before its order can mean anything.
 *
 * A handful of lines is in ascending order by accident often enough to be worthless as evidence —
 * three random rules are already ordered one time in six — and a short section is also where an
 * appended rule is least likely to be wrong. Twenty rules puts the accidental rate below one in a
 * billion while still admitting every real sorted section of the lists measured above.
 */
export const MIN_SORTED_SECTION_RULES = 20;

/**
 * A planned position inside a section proven to be sorted.
 */
export interface SortedInsertion {
    /**
     * Zero-based line index the rule takes, in the {@link filterFileLines} model.
     */
    insertionPoint: number;

    /**
     * Exact line the rule is planned to precede; absent when the position is the end of the file.
     */
    anchorRule?: string;

    /**
     * Key the section proved sorted under.
     */
    sortKey: RuleSortKey;

    /**
     * Number of rules the section holds, as counted for the measurement.
     */
    sectionRules: number;

    /**
     * Fraction of the section's adjacent rule pairs already in ascending order.
     */
    orderedRatio: number;
}

/**
 * How one section's rules are compared: which part of the line is the key, and whether case
 * matters.
 */
interface SortComparator {
    /**
     * The key part of a line.
     */
    sortKey: RuleSortKey;

    /**
     * Whether keys are compared lower-cased, as FOP compares blocking rules.
     */
    caseFolded: boolean;
}

/**
 * One run of rule lines between comment lines.
 */
interface RuleSection {
    /**
     * Zero-based indices of the section's rule lines, in file order.
     */
    ruleIndices: number[];

    /**
     * Normalized kinds of those rules, index-aligned with {@link RuleSection.ruleIndices}.
     */
    ruleKinds: RuleKind[];
}

/**
 * A section proven sorted, with the comparator that proved it.
 */
interface SortedSection {
    /**
     * The section itself.
     */
    section: RuleSection;

    /**
     * Comparator the section's order holds under.
     */
    comparator: SortComparator;

    /**
     * Fraction of adjacent pairs in ascending order under that comparator.
     */
    orderedRatio: number;
}

/**
 * The sorted block a candidate belongs in, with the candidate's own key in that block's terms.
 */
interface ChosenSection {
    /**
     * The proven sorted block.
     */
    chosen: SortedSection;

    /**
     * The candidate's comparable key under that block's comparator.
     */
    candidateKey: string;
}

/**
 * Marker of a list header line such as `[Adblock Plus 2.0]`.
 *
 * It parses as a network pattern rather than as a comment, so without this it would join the file's
 * first section as a rule and distort that section's measured order.
 */
const LIST_HEADER_PATTERN = /^\[.*\]$/u;

/**
 * Extract the key one line sorts under.
 *
 * @param line - Exact repository line.
 * @param comparator - The section's comparator.
 * @returns The comparable key, or undefined when the line has no key of that kind.
 */
function sortKeyOf(line: string, comparator: SortComparator): string | undefined {
    const trimmed = line.trim();
    let key: string | undefined;
    if (comparator.sortKey === RuleSortKey.SelectorOnly) {
        const separator = findCosmeticSeparator(trimmed);
        key = separator === undefined ? undefined : trimmed.slice(separator.index);
    } else {
        key = trimmed;
    }
    if (key === undefined) {
        return undefined;
    }
    return comparator.caseFolded ? key.toLowerCase() : key;
}

/**
 * Split a file into its runs of rule lines.
 *
 * A comment or list-header line closes the current run, which is what FOP treats as a sortable
 * block. Blank lines are skipped without closing one: a blank line inside a sorted block does not
 * restart its order.
 *
 * @param lines - Exact repository lines.
 * @returns The file's rule runs in file order.
 */
function ruleSections(lines: readonly string[]): RuleSection[] {
    const sections: RuleSection[] = [];
    let current: RuleSection | undefined;
    for (const [index, line] of lines.entries()) {
        const kind = normalizeRule(line).kind;
        if (kind === RuleKind.Empty) {
            continue;
        }
        if (kind === RuleKind.Comment || LIST_HEADER_PATTERN.test(line.trim())) {
            current = undefined;
            continue;
        }
        if (current === undefined) {
            current = { ruleIndices: [], ruleKinds: [] };
            sections.push(current);
        }
        current.ruleIndices.push(index);
        current.ruleKinds.push(kind);
    }
    return sections;
}

/**
 * Measure how much of a section's order already ascends under one comparator.
 *
 * @param lines - Exact repository lines.
 * @param section - The section being measured.
 * @param comparator - Comparator to measure under.
 * @returns The ordered fraction, or undefined when some rule has no key of that kind.
 */
function orderedRatio(
    lines: readonly string[],
    section: RuleSection,
    comparator: SortComparator,
): number | undefined {
    const keys: string[] = [];
    for (const index of section.ruleIndices) {
        const key = sortKeyOf(lines[index] ?? '', comparator);
        if (key === undefined) {
            return undefined;
        }
        keys.push(key);
    }
    if (keys.length < 2) {
        return undefined;
    }
    let ordered = 0;
    for (let index = 0; index + 1 < keys.length; index += 1) {
        if ((keys[index] as string) <= (keys[index + 1] as string)) {
            ordered += 1;
        }
    }
    return ordered / (keys.length - 1);
}

/**
 * Prove one section sorted, under the first comparator whose order clears the threshold.
 *
 * The selector key is tried before the whole line because it is the more specific claim: a list of
 * site-scoped hiding rules is ordered by selector and only incidentally by site, and reading it the
 * other way round would place the rule by its domain in a file that is not ordered by domain.
 * Within a key, the case-sensitive reading is tried first because that is the ASCII order
 * contributing guides ask for; the lower-cased reading is what FOP applies to blocking rules.
 *
 * @param lines - Exact repository lines.
 * @param section - The section to prove.
 * @returns The proven section, or undefined when its order is no better than a log's.
 */
function proveSorted(lines: readonly string[], section: RuleSection): SortedSection | undefined {
    if (section.ruleIndices.length < MIN_SORTED_SECTION_RULES) {
        return undefined;
    }
    for (const sortKey of RULE_SORT_KEY_VALUES) {
        for (const caseFolded of [false, true]) {
            const comparator: SortComparator = { sortKey, caseFolded };
            const ratio = orderedRatio(lines, section, comparator);
            if (ratio !== undefined && ratio >= MIN_SORTED_ADJACENT_RATIO) {
                return { section, comparator, orderedRatio: ratio };
            }
        }
    }
    return undefined;
}

/**
 * Choose the section a candidate's key belongs in.
 *
 * A file can hold several sorted blocks, and the candidate belongs in the one whose range covers
 * its key. When no range covers it — a key past the end of every block — the last sorted block is
 * the one a maintainer would extend.
 *
 * @param lines - Exact repository lines.
 * @param sorted - Sorted sections of the file, in file order.
 * @param candidateRule - Locked candidate rule.
 * @returns The chosen section and the candidate's key in it, or undefined when none can hold it.
 */
function chooseSection(
    lines: readonly string[],
    sorted: readonly SortedSection[],
    candidateRule: string,
): ChosenSection | undefined {
    const candidateKind = normalizeRule(candidateRule).kind;
    let fallback: ChosenSection | undefined;
    for (const entry of sorted) {
        // A sorted block is only the candidate's block when it holds the candidate's own kind of
        // rule throughout. Keys of different families interleave by character code — a
        // domain-scoped cosmetic rule sorts between `||ads.example^` and `|http`-anchored patterns
        // — so range containment alone would file a cosmetic rule into an ad-servers block.
        if (!entry.section.ruleKinds.every((kind) => samePlacementFamily(candidateKind, kind))) {
            continue;
        }
        const candidateKey = sortKeyOf(candidateRule, entry.comparator);
        if (candidateKey === undefined) {
            continue;
        }
        fallback = { chosen: entry, candidateKey };
        const indices = entry.section.ruleIndices;
        const first = sortKeyOf(lines[indices[0] as number] ?? '', entry.comparator);
        const last = sortKeyOf(lines[indices.at(-1) as number] ?? '', entry.comparator);
        if (first !== undefined && last !== undefined && first <= candidateKey) {
            if (candidateKey <= last) {
                return { chosen: entry, candidateKey };
            }
        }
    }
    return fallback;
}

/**
 * Plan the sorted position of a candidate rule inside a list file that keeps its rules sorted.
 *
 * @param lines - Exact repository lines in the {@link filterFileLines} model.
 * @param candidateRule - Locked candidate rule.
 * @returns The sorted position with its anchor, or undefined when the file keeps no usable order.
 */
export function findSortedInsertion(
    lines: readonly string[],
    candidateRule: string,
): SortedInsertion | undefined {
    const sorted = ruleSections(lines)
        .map((section) => proveSorted(lines, section))
        .filter((entry): entry is SortedSection => entry !== undefined);
    if (sorted.length === 0) {
        return undefined;
    }
    const selection = chooseSection(lines, sorted, candidateRule);
    if (selection === undefined) {
        return undefined;
    }
    const { chosen, candidateKey } = selection;
    const successor = chosen.section.ruleIndices.find((index) => {
        const key = sortKeyOf(lines[index] ?? '', chosen.comparator);
        return key !== undefined && key > candidateKey;
    });
    // No successor means the candidate sorts last in its block; it still belongs inside the block,
    // so the position is the line right after the block's final rule — a comment, a blank line, or
    // the end of the file.
    const insertionPoint = successor ?? (chosen.section.ruleIndices.at(-1) as number) + 1;
    const anchorRule = insertionPoint < lines.length ? lines[insertionPoint] : undefined;
    return {
        insertionPoint,
        ...(anchorRule === undefined ? {} : { anchorRule }),
        sortKey: chosen.comparator.sortKey,
        sectionRules: chosen.section.ruleIndices.length,
        orderedRatio: chosen.orderedRatio,
    };
}
