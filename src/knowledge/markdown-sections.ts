/**
 * Splitting one served Markdown document into its heading sections, and the compact heading index
 * that names every heading a document has.
 *
 * An instruction-linked reference is whatever the run instruction points at — the uBlock Origin
 * "Static filter syntax" wiki page is 75 KB of nested `##`/`###`/`####` headings — and a guidance
 * response is bounded to a few thousand characters. Cutting the document at the bound served its
 * opening for every topic; cutting it at its headings lets the caller serve the part that answers
 * the question and name the parts it did not.
 *
 * A leaf module with no knowledge of guidance topics, roles or citations: it knows Markdown
 * structure and nothing else.
 */

/**
 * ATX heading line: one to six `#` markers, a required space, then the heading text. The space is
 * required by CommonMark and it is what keeps a filter rule out of the heading set — `##.ad` and
 * `###ad-banner` are cosmetic rules, not headings, and a syntax reference is full of them.
 */
const HEADING_PATTERN = /^(#{1,6})\s+(.*\S)\s*$/u;

/**
 * Fence line opening or closing a code block: three or more backticks or tildes, optionally
 * followed by an info string. Heading detection is suspended between a fence and its match, because
 * a fenced block in a syntax reference contains example rules, and one of those starting with `#`
 * is not a section of the document.
 */
const FENCE_PATTERN = /^\s{0,3}(`{3,}|~{3,})/u;

/**
 * Level reported for the preamble — the text before the document's first heading. Zero rather than
 * one, because the preamble is not a heading and must not be mistaken for the outermost one: it
 * contains every following section by the containment rule, and a `#`-level section does not.
 */
const PREAMBLE_LEVEL = 0;

/**
 * One heading-delimited span of a Markdown document, plus the preamble as a span of its own.
 *
 * Spans NEST: a section runs from its heading to the next heading of the same or a higher level, so
 * an `##` section contains its `###` children and each of those is also a section in its own right.
 * `startLine`/`endLine` are what a caller compares to drop a section it is already serving inside a
 * larger one.
 */
export interface MarkdownSection {
    /**
     * Heading depth, 1 through 6; {@link PREAMBLE_LEVEL} for the preamble.
     */
    level: number;

    /**
     * Heading text with its `#` markers and surrounding whitespace removed; empty for the preamble.
     */
    heading: string;

    /**
     * The section's whole text: its heading line followed by everything up to the next heading of
     * the same or a higher level. Just the text itself for the preamble.
     */
    text: string;

    /**
     * The section's text without its heading line; identical to `text` for the preamble.
     */
    body: string;

    /**
     * Zero-based index of the section's first line in the document.
     */
    startLine: number;

    /**
     * Zero-based index of the first line PAST the section.
     */
    endLine: number;
}

/**
 * One heading located while scanning a document, before its span is known.
 */
interface HeadingLine {
    /**
     * Heading depth, 1 through 6.
     */
    level: number;

    /**
     * Heading text with its `#` markers and surrounding whitespace removed.
     */
    heading: string;

    /**
     * Zero-based index of the heading's own line.
     */
    line: number;
}

/**
 * Split a Markdown document into its preamble and one nesting section per heading.
 *
 * @param document - The document text, with `\n` line endings.
 * @returns Every section in document order, the preamble first when the document has one. A
 *   document with no heading at all yields exactly one preamble section; an empty document yields
 *   none.
 */
export function splitMarkdownSections(document: string): MarkdownSection[] {
    const lines = document.split('\n');
    const headings: HeadingLine[] = [];
    let openFence: string | undefined;
    for (const [line, text] of lines.entries()) {
        const fence = FENCE_PATTERN.exec(text);
        if (fence !== null) {
            const marker = fence[1]!;
            if (openFence === undefined) {
                openFence = marker[0];
            } else if (marker[0] === openFence) {
                openFence = undefined;
            }
            continue;
        }
        if (openFence !== undefined) {
            continue;
        }
        const heading = HEADING_PATTERN.exec(text);
        if (heading !== null) {
            headings.push({ level: heading[1]!.length, heading: heading[2]!, line });
        }
    }
    const sections: MarkdownSection[] = [];
    const firstHeadingLine = headings[0]?.line ?? lines.length;
    if (document.length > 0 && firstHeadingLine > 0) {
        const preamble = lines.slice(0, firstHeadingLine).join('\n');
        sections.push({
            level: PREAMBLE_LEVEL,
            heading: '',
            text: preamble,
            body: preamble,
            startLine: 0,
            endLine: firstHeadingLine,
        });
    }
    for (const [position, current] of headings.entries()) {
        // The span ends at the next heading that is not nested under this one; its own children
        // stay inside it, which is what makes a parent section servable as a whole.
        const next = headings.slice(position + 1).find((later) => later.level <= current.level);
        const endLine = next?.line ?? lines.length;
        sections.push({
            level: current.level,
            heading: current.heading,
            text: lines.slice(current.line, endLine).join('\n'),
            body: lines.slice(current.line + 1, endLine).join('\n'),
            startLine: current.line,
            endLine,
        });
    }
    return sections;
}

/**
 * Render the document's heading index as its lines: every heading, at its own level, in document
 * order.
 *
 * The index is what turns a narrowed response into a navigable one — it is the model's evidence
 * that a section it wants exists somewhere else in the document, so it can ask again for that
 * section instead of reporting the guidance as missing. The lines are returned unjoined because a
 * bounded response may only be able to afford some of them: how many fit is the caller's budget
 * decision, and this module knows nothing about budgets.
 *
 * @param sections - Sections of one document, as {@link splitMarkdownSections} returned them.
 * @returns One line per heading, each keeping its `#` markers so the nesting is visible; empty for
 *   a document with no headings.
 */
export function headingIndexLines(sections: readonly MarkdownSection[]): string[] {
    return sections
        .filter((section) => section.level !== PREAMBLE_LEVEL)
        .map((section) => `${'#'.repeat(section.level)} ${section.heading}`);
}

/**
 * Decide whether one section's span lies inside another's.
 *
 * @param inner - The section that may be contained.
 * @param outer - The section that may contain it.
 * @returns True when `inner` is a different section whose whole span lies within `outer`.
 */
export function isContainedSection(inner: MarkdownSection, outer: MarkdownSection): boolean {
    if (inner === outer) {
        return false;
    }
    return inner.startLine >= outer.startLine && inner.endLine <= outer.endLine;
}
