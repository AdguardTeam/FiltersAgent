/**
 * The outline of one list file: its leading comment header, its marker lines, how many rules each
 * region holds, whether that region is kept sorted, and the file's line count.
 *
 * The agent reads this outline to choose where a new rule goes, so every fact here is one the file
 * itself states. Nothing is inferred about which section a rule belongs in.
 */
import { CONDITION_END_PATTERN, CONDITION_START_PATTERN } from './file-condition';
import { RuleKind, normalizeRule } from './rule-normalizer';
import { isListHeaderLine, isRuleLine } from './rule-line';
import { isSortedRuleRange } from './sorted-insertion';

/**
 * The kinds of marker line an outline reports.
 */
export const OutlineMarkerKind = {
    /**
     * Opening marker of one named section (`! SECTION: …`).
     */
    Section: 'section',

    /**
     * Closing marker of one named section (`! !SECTION: …`).
     */
    SectionEnd: 'section_end',

    /**
     * Opening note inside a section (`! NOTE: …`).
     */
    Note: 'note',

    /**
     * Closing note of a section (`! NOTE: … end ⬆️`).
     */
    NoteEnd: 'note_end',

    /**
     * Opening marker of one named site group (`! START: …`).
     */
    Group: 'group',

    /**
     * Closing marker of one named site group (`! END: …`).
     */
    GroupEnd: 'group_end',

    /**
     * Start of a conditional block (`!#if …`, `!#else`, `!#safari_cb_affinity(…)`).
     */
    Condition: 'condition',

    /**
     * End of a conditional block (`!#endif`, `!#safari_cb_affinity`).
     */
    ConditionEnd: 'condition_end',

    /**
     * A dashed banner line (`!--- … ---`); its text is absent on a bare dashed line.
     */
    Banner: 'banner',
} as const;

/**
 * OutlineMarkerKind value.
 */
export type OutlineMarkerKind = (typeof OutlineMarkerKind)[keyof typeof OutlineMarkerKind];

/**
 * One marker line of a list file, with the region that follows it.
 */
export interface OutlineMarker {
    /**
     * One-based line number of the marker.
     */
    line: number;

    /**
     * What kind of marker the line is.
     */
    kind: OutlineMarkerKind;

    /**
     * The marker line, trimmed; absent on a bare dashed line.
     */
    text?: string;

    /**
     * Number of rule lines between this marker and the next one.
     */
    ruleCount: number;

    /**
     * Whether that region is kept sorted.
     */
    sorted: boolean;
}

/**
 * The marker outline of one list file.
 */
export interface FileOutline {
    /**
     * Number of lines in the file, in the {@link filterFileLines} line model.
     */
    lineCount: number;

    /**
     * Number of rule lines before the first marker, or in the whole file when it has none.
     */
    leadingRuleCount: number;

    /**
     * Whether the lines before the first marker are kept sorted.
     */
    leadingSorted: boolean;

    /**
     * The leading comment lines above the first rule or marker, in file order and trimmed, joined
     * by newlines. Blank lines and a bracketed list header are skipped rather than ending it; the
     * empty string means the file has no such header.
     */
    header: string;

    /**
     * The file's marker lines, in file order.
     */
    markers: OutlineMarker[];
}

/**
 * Opening marker of a named section. The label after the colon is checked case-insensitively.
 */
const SECTION_OPENING_PATTERN = /^!\s*SECTION(?:\[[^\]]+\])?\s*:\s*.+$/iu;

/**
 * Closing marker of a named section. Like the opening marker it is case-insensitive; the name it
 * carries is ignored, because the innermost open section is the one it closes.
 */
const SECTION_CLOSING_PATTERN = /^!\s*!SECTION(?:\[[^\]]+\])?\s*:\s*.+$/iu;

/**
 * Opening marker of a note. Case-sensitive on purpose: prose such as `! Note:` is a sentence, not a
 * heading, and only the upper-case marker names a region.
 */
const NOTE_PATTERN = /^!\s*NOTE\s*:/u;

/**
 * Closing marker of a note: the same upper-case `! NOTE:` marker, ending in `end` or the upward
 * arrow. Case-sensitive for the same reason as {@link NOTE_PATTERN}.
 */
const NOTE_END_PATTERN = /^!\s*NOTE:.*(?:\bend\b|⬆️?)\s*$/u;

/**
 * Opening marker of a named site group. Group markers are case-insensitive across the lists.
 */
const GROUP_START_PATTERN = /^!\s*START\s*:\s*\S/iu;

/**
 * Closing marker of a named site group. Case-insensitive like {@link GROUP_START_PATTERN}, and the
 * name is optional: old parts of the lists close a group with a bare `! END` or `! end`.
 */
const GROUP_END_PATTERN = /^!\s*END(?:\s*:\s*\S.*)?$/iu;

/**
 * A dashed banner line. The dashes are the frame, so only a line starting with three or more of
 * them is a banner.
 */
const BANNER_PATTERN = /^!-{3,}.*$/u;

/**
 * One marker line's position in the file, with its classification.
 */
interface MarkerPosition {
    /**
     * Zero-based line index of the marker.
     */
    index: number;

    /**
     * The marker's classification.
     */
    marker: MarkerLine;
}

/**
 * One classified marker line, before its region is measured.
 */
export interface MarkerLine {
    /**
     * What kind of marker the line is.
     */
    kind: OutlineMarkerKind;

    /**
     * The trimmed marker line; absent on a bare dashed line.
     */
    text?: string;
}

/**
 * Whether a dashed banner line carries a label.
 *
 * A frame of dashes, spaces and closing `!` marks holds no label, so it stays a marker without text
 * and never becomes a heading.
 *
 * @param text - Trimmed banner line.
 * @returns Whether the line holds anything beyond its dashes, spaces and `!` marks.
 */
function bannerHasText(text: string): boolean {
    return /[^-\s!]/u.test(text.slice(1));
}

/**
 * The marker facts the label helper needs.
 */
interface MarkerLabelSource {
    /**
     * What kind of marker the value is.
     */
    kind: OutlineMarkerKind;

    /**
     * The marker's trimmed text, when it has one.
     */
    text?: string;
}

/**
 * Name the text one marker is known by.
 *
 * A banner is framed on both ends by dashes, whitespace and closing `!` marks, and that frame tells
 * the model nothing about the section; the label between the frames is what it names. Every other
 * marker already reads as its own label once trimmed.
 *
 * @param marker - The marker, or any value with a kind and optional trimmed text.
 * @returns The label, or undefined when the marker carries none.
 */
export function outlineMarkerLabel(marker: MarkerLabelSource): string | undefined {
    if (marker.text === undefined) {
        return undefined;
    }
    if (marker.kind !== OutlineMarkerKind.Banner) {
        return marker.text;
    }
    return marker.text
        .replace(/^[!\s-]+/u, '')
        .replace(/[!\s-]+$/u, '')
        .trim();
}

/**
 * Classify one line as a marker, or report that it is not one.
 *
 * The one classifier every reader of a list file shares: the outline, the enclosing heading and a
 * heading anchor the report names.
 *
 * @param line - Exact repository line.
 * @returns The marker kind and text, or undefined for an ordinary line.
 */
export function classifyMarker(line: string): MarkerLine | undefined {
    const text = line.trim();
    if (SECTION_CLOSING_PATTERN.test(text)) {
        return { kind: OutlineMarkerKind.SectionEnd, text };
    }
    if (SECTION_OPENING_PATTERN.test(text)) {
        return { kind: OutlineMarkerKind.Section, text };
    }
    if (NOTE_END_PATTERN.test(text)) {
        return { kind: OutlineMarkerKind.NoteEnd, text };
    }
    if (NOTE_PATTERN.test(text)) {
        return { kind: OutlineMarkerKind.Note, text };
    }
    if (GROUP_END_PATTERN.test(text)) {
        return { kind: OutlineMarkerKind.GroupEnd, text };
    }
    if (GROUP_START_PATTERN.test(text)) {
        return { kind: OutlineMarkerKind.Group, text };
    }
    if (CONDITION_END_PATTERN.test(text)) {
        return { kind: OutlineMarkerKind.ConditionEnd, text };
    }
    if (CONDITION_START_PATTERN.test(text)) {
        return { kind: OutlineMarkerKind.Condition, text };
    }
    if (BANNER_PATTERN.test(text)) {
        return { kind: OutlineMarkerKind.Banner, ...(bannerHasText(text) ? { text } : {}) };
    }
    return undefined;
}

/**
 * The marker kinds that open a heading: a section, a note, a site group or a labelled banner.
 *
 * A condition block and a closing marker are not headings, so a line of either kind stays a plain
 * comment line.
 */
const HEADING_MARKER_KINDS: ReadonlySet<OutlineMarkerKind> = new Set([
    OutlineMarkerKind.Section,
    OutlineMarkerKind.Note,
    OutlineMarkerKind.Group,
    OutlineMarkerKind.Banner,
]);

/**
 * The cleaned label of the heading one line opens, or undefined when the line opens none.
 *
 * A dashed banner keeps its frame in the raw line and is named by the label between the dashes, so
 * a reader sees the same heading the outline reports.
 *
 * @param line - Exact repository line.
 * @returns The heading label, or undefined for a closer, a condition or an ordinary line.
 */
export function headingLineLabel(line: string): string | undefined {
    const marker = classifyMarker(line);
    if (marker === undefined || !HEADING_MARKER_KINDS.has(marker.kind)) {
        return undefined;
    }
    return outlineMarkerLabel(marker);
}

/**
 * Count the rule lines inside one inclusive range.
 *
 * @param lines - Exact repository lines.
 * @param startIndex - Zero-based first index of the range.
 * @param endIndex - Zero-based last index of the range, inclusive.
 * @returns Number of lines that are neither comment nor empty.
 */
function countRuleLines(lines: readonly string[], startIndex: number, endIndex: number): number {
    let count = 0;
    for (let index = startIndex; index <= endIndex; index += 1) {
        if (isRuleLine(lines[index])) {
            count += 1;
        }
    }
    return count;
}

/**
 * Read the comment header above the first rule or marker.
 *
 * A bracketed list header such as `[Adblock Plus 2.0]` and blank lines are skipped rather than
 * ending the header: a normal list states its title and Good/Bad guidance around them.
 *
 * @param lines - Exact repository lines.
 * @param endIndex - Zero-based index of the first marker, or the file's line count.
 * @returns The header's trimmed comment lines, joined by newlines.
 */
function leadingCommentHeader(lines: readonly string[], endIndex: number): string {
    const header: string[] = [];
    for (let index = 0; index < endIndex; index += 1) {
        const line = lines[index];
        if (isListHeaderLine(line)) {
            continue;
        }
        const kind = normalizeRule(line).kind;
        if (kind === RuleKind.Empty) {
            continue;
        }
        if (kind !== RuleKind.Comment) {
            break;
        }
        header.push(line.trim());
    }
    return header.join('\n');
}

/**
 * Build the outline of one list file.
 *
 * @param lines - Exact repository lines in the {@link filterFileLines} model.
 * @returns The file's header, markers with their regions, its leading rules and its line count.
 */
export function buildFileOutline(lines: readonly string[]): FileOutline {
    const positions: MarkerPosition[] = [];
    for (const [index, line] of lines.entries()) {
        const marker = classifyMarker(line);
        if (marker !== undefined) {
            positions.push({ index, marker });
        }
    }
    const firstMarker = positions[0]?.index ?? lines.length;
    const markers = positions.map((entry, position) => {
        const end = regionEnd(positions, position, lines.length);
        return {
            line: entry.index + 1,
            kind: entry.marker.kind,
            ...(entry.marker.text === undefined ? {} : { text: entry.marker.text }),
            ruleCount: countRuleLines(lines, entry.index + 1, end),
            sorted: isSortedRuleRange(lines, entry.index + 1, end),
        };
    });
    return {
        lineCount: lines.length,
        leadingRuleCount: countRuleLines(lines, 0, firstMarker - 1),
        leadingSorted: isSortedRuleRange(lines, 0, firstMarker - 1),
        header: leadingCommentHeader(lines, firstMarker),
        markers,
    };
}

/**
 * Find the last line index of the region one marker opens.
 *
 * @param positions - Every marker position of the file, in file order.
 * @param markerPosition - Zero-based position of the marker inside {@link positions}.
 * @param lineCount - Number of lines in the file.
 * @returns Zero-based index of the region's last line.
 */
function regionEnd(
    positions: readonly MarkerPosition[],
    markerPosition: number,
    lineCount: number,
): number {
    return (positions[markerPosition + 1]?.index ?? lineCount) - 1;
}
