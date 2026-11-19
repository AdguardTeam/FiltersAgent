import { findCosmeticSeparator, normalizeRule, RuleKind } from './rule-normalizer';
import { isRuleLine } from './rule-line';
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
 * agent's own chosen line is what places the rule.
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
 * One zero-based inclusive line range of a list file inside which a rule may take its sorted place.
 */
export interface RuleRegion {
    /**
     * Zero-based index of the region's first line.
     */
    startIndex: number;

    /**
     * Zero-based index of the region's last line, inclusive.
     */
    endIndex: number;
}

/**
 * A planned position inside a section proven to be sorted.
 */
export interface SortedInsertion {
    /**
     * Zero-based line index the rule takes, in the {@link filterFileLines} model.
     */
    insertionPoint: number;

    /**
     * Exact line the insertion precedes — a following rule, or a blank line between two rules of
     * the run. Absent only when the rule sorts after the run's last rule, so no following line
     * belongs to the run to anchor or link to.
     */
    anchorRule?: string;
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
        if (!isRuleLine(line, kind)) {
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
                return { section, comparator };
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
 * Determine whether the rules inside one line range are kept sorted.
 *
 * A region is sorted when at least one run of rules in it proves sorted, and every run in it that
 * is long enough to carry order (at least {@link MIN_SORTED_SECTION_RULES} rules) proves sorted
 * too: a short run is a coincidence either way, and one hand-placed line must not make the whole
 * region look like a log.
 *
 * @param lines - Exact repository lines in the {@link filterFileLines} model.
 * @param startIndex - Zero-based first index of the range.
 * @param endIndex - Zero-based last index of the range, inclusive.
 * @returns Whether the range is kept sorted.
 */
export function isSortedRuleRange(
    lines: readonly string[],
    startIndex: number,
    endIndex: number,
): boolean {
    const range = lines.slice(startIndex, endIndex + 1);
    const sections = ruleSections(range);
    const proven = new Set(sections.filter((section) => proveSorted(range, section) !== undefined));
    return (
        proven.size > 0 &&
        sections.every(
            (section) =>
                proven.has(section) || section.ruleIndices.length < MIN_SORTED_SECTION_RULES,
        )
    );
}

/**
 * The ordered body of a section's rules: the run without the hand-placed outliers that a tolerated
 * inversion leaves at either edge.
 *
 * A section passes as sorted while a single misplaced line remains, and that line is nearly always
 * at an edge: a maintainer drops a new rule under the header, or edits the last line of the block.
 * Such a line is not an anchor for a candidate — a small trailing outlier sorts before almost every
 * rule, so treating it as one sends the candidate to the run's end.
 */
interface OrderedBody {
    /**
     * Position of the body's first rule inside the section's rule list.
     */
    start: number;

    /**
     * Position of the body's last rule inside the section's rule list, inclusive.
     */
    end: number;
}

/**
 * Cut the tolerated leading and trailing outliers off a section's keys.
 *
 * Only an edge inversion is trimmed — a first key greater than the next one, or a last key smaller
 * than the previous one — and the trim repeats while the new edge is inverted too. An inversion
 * between two interior rules is not an edge outlier: the body keeps it, and the reverse search
 * still reads the order around it.
 *
 * @param keys - The section's comparable keys, in file order.
 * @returns The positions the ordered body spans.
 */
function orderedBody(keys: readonly string[]): OrderedBody {
    let start = 0;
    let end = keys.length - 1;
    while (start < end && keys[start] > keys[start + 1]) {
        start += 1;
    }
    while (end > start && keys[end] < keys[end - 1]) {
        end -= 1;
    }
    return { start, end };
}

/**
 * Plan the sorted position of a candidate rule inside one outline region the agent named.
 *
 * Only the named region is read, and only its own runs may hold the rule: a plan that fell back to
 * a sorted block elsewhere in the file would put the rule in a section the agent never chose.
 *
 * The position is the line after the last smaller key, searched from the end of the section's
 * ordered body. A section can carry one hand-placed line at either edge whose key breaks the order
 * while the rest still ascends — an unsorted head of one greater key, or a smaller key a maintainer
 * left at the tail — so those edge outliers are trimmed before the search and never serve as
 * anchors. Inside the body the first greater key from the top would land the rule in an unsorted
 * head, which is why the search runs from the end. When no body rule has a smaller key the rule
 * goes before the body's first rule, and when every body rule is smaller it goes after the body's
 * last one, where it sorts last and has no following rule to anchor.
 *
 * @param lines - Exact repository lines in the {@link filterFileLines} model.
 * @param candidateRule - Locked candidate rule.
 * @param region - The outline region the agent named, in zero-based inclusive line indices.
 * @returns The sorted position with its anchor, or undefined when the region holds no sorted run of
 *   the candidate's rule family.
 */
export function findSortedInsertion(
    lines: readonly string[],
    candidateRule: string,
    region: RuleRegion,
): SortedInsertion | undefined {
    const range = lines.slice(region.startIndex, region.endIndex + 1);
    const sorted = ruleSections(range)
        .map((section) => proveSorted(range, section))
        .filter((entry): entry is SortedSection => entry !== undefined);
    if (sorted.length === 0) {
        return undefined;
    }
    const selection = chooseSection(range, sorted, candidateRule);
    if (selection === undefined) {
        return undefined;
    }
    const { chosen, candidateKey } = selection;
    const indices = chosen.section.ruleIndices;
    const keys: string[] = [];
    for (const index of indices) {
        const key = sortKeyOf(range[index], chosen.comparator);
        if (key === undefined) {
            return undefined;
        }
        keys.push(key);
    }
    const body = orderedBody(keys);
    // The insertion precedes the body rule at this position; a position past the body means the
    // rule sorts after its last rule, where no following body rule exists to anchor.
    let followingBodyPosition: number = body.start;
    let localInsertionPoint = indices[body.start];
    for (let position = body.end; position >= body.start; position -= 1) {
        if (keys[position] < candidateKey) {
            localInsertionPoint = indices[position] + 1;
            followingBodyPosition = position + 1;
            break;
        }
    }
    // The line at the position is the exact boundary the rule is planned to precede: a following
    // rule, or a blank line between two rules of the ordered body. Only sorting after the body's
    // last rule leaves no following line of the body to anchor.
    const anchorRule = followingBodyPosition <= body.end ? range[localInsertionPoint] : undefined;
    return {
        insertionPoint: region.startIndex + localInsertionPoint,
        ...(anchorRule === undefined ? {} : { anchorRule }),
    };
}
