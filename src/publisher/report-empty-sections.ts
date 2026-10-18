/**
 * Removal of the report sections a run had nothing to put under.
 *
 * A report template spells every section it might need, but a run fills only what it observed. A
 * failure report can leave its Rule, Policy rationale, Place in the list and Executor and version
 * sections with nothing under them, and an empty heading promises the reader something the report
 * does not have. An empty fill outside any section — the outcome reason of a run that needs none —
 * leaves its blank lines behind instead. The rendered body is the only place this can be decided:
 * the template itself does not know which of its placeholders resolved.
 */

/**
 * Line opening or closing a fenced code block: up to three spaces, then a run of at least three
 * backticks or tildes. The run is captured, since only a run of the same character at least as long
 * closes the block. A backtick run with another backtick later on its line opens no block — it is a
 * code span, such as a rule a model quoted at the start of its reason.
 */
const CODE_FENCE_LINE_PATTERN = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/u;

/**
 * Line opening a Markdown section: both the heading whose body may be empty and the far bound of
 * the section before it. Depth two and below, so an instruction template that writes `###` sections
 * is treated exactly like the built-in template's `##` ones.
 *
 * The leading outcome block carries no heading at all, so it is never a candidate for removal.
 */
const SECTION_HEADING_LINE_PATTERN = /^[ \t]*#{2,}\s/u;

/**
 * Heading depth of one Markdown heading line.
 *
 * @param line - A line already matched by {@link SECTION_HEADING_LINE_PATTERN}.
 * @returns The number of leading `#` characters.
 */
function headingLevel(line: string): number {
    return (/^[ \t]*(#+)/u.exec(line)?.[1] ?? '').length;
}

/**
 * Drop every section whose body renders empty or whitespace only, in one pass.
 *
 * A section's body runs from the line after its heading to the next heading of the same or a
 * shallower depth, or the end of the body. Depth is what keeps a parent heading whose only content
 * is its subsections: `## Details` followed by `### Rule` ends at no heading shallower than itself
 * until after the subsection, so its body is the subsection and it stays. The heading and its blank
 * body are removed together, so an omitted section never leaves a dangling heading before the
 * sections that follow, and a section carrying any content stays exactly as rendered.
 *
 * @param body - Rendered comment body.
 * @returns The body with every empty section of this pass removed.
 */
function removeEmptySectionsOnce(body: string): string {
    const lines = body.split('\n');
    const kept: string[] = [];
    let index = 0;
    while (index < lines.length) {
        const line = lines[index] ?? '';
        if (!SECTION_HEADING_LINE_PATTERN.test(line)) {
            kept.push(line);
            index += 1;
            continue;
        }
        const level = headingLevel(line);
        let afterBody = index + 1;
        while (afterBody < lines.length && (lines[afterBody] ?? '').trim() === '') {
            afterBody += 1;
        }
        const boundary = lines[afterBody];
        const bodyIsEmpty =
            boundary === undefined ||
            (SECTION_HEADING_LINE_PATTERN.test(boundary) && headingLevel(boundary) <= level);
        if (!bodyIsEmpty) {
            kept.push(line);
            index += 1;
            continue;
        }
        index = afterBody;
    }
    return kept.join('\n');
}

/**
 * Drop every empty section, including a parent left hollow by the removal of its subsections.
 *
 * One pass decides each heading against the body it had at the time, so a parent whose only content
 * was empty subsections survives that pass and becomes empty in it. Repeating until the body stops
 * changing settles the cascade; every pass that changes anything removes at least one heading line,
 * so the loop is bounded by the body's own line count.
 *
 * @param body - Rendered comment body.
 * @returns The body with every empty section removed.
 */
export function removeEmptySections(body: string): string {
    let current = body;
    for (;;) {
        const reduced = removeEmptySectionsOnce(current);
        if (reduced === current) {
            return current;
        }
        current = reduced;
    }
}

/**
 * Collapse every run of blank lines outside fenced code blocks into one blank line.
 *
 * GitHub's page shows one blank line and five alike, but the comment's Markdown is also read as
 * written — in the run artifacts, in notification e-mails — where an empty outcome reason and an
 * empty version hint left five blank lines under the outcome. Inside a fenced block a blank line
 * belongs to the command output the block quotes, so it stays.
 *
 * @param body - Rendered comment body.
 * @returns The body with no two blank lines in a row outside its code blocks.
 */
export function collapseBlankLines(body: string): string {
    const kept: string[] = [];
    let openFence: string | undefined;
    for (const line of body.split('\n')) {
        const fence = CODE_FENCE_LINE_PATTERN.exec(line)?.[1];
        if (openFence !== undefined) {
            const closes =
                fence !== undefined &&
                fence[0] === openFence[0] &&
                fence.length >= openFence.length &&
                line.trim() === fence;
            if (closes) {
                openFence = undefined;
            }
        } else if (fence !== undefined) {
            openFence = fence;
        } else if (line.trim() === '' && kept.at(-1)?.trim() === '') {
            continue;
        }
        kept.push(line);
    }
    return kept.join('\n');
}
