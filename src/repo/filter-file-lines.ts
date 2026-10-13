/**
 * The one line model every placement decision counts positions in.
 *
 * A planned insertion travels as a zero-based index plus the exact line it must precede, and the
 * review checkout re-derives that index from the committed blob (`decodeBoundLines` in
 * `repository-edit.ts`) before it will write anything. The two must split a file identically or an
 * anchored plan is rejected as stale: a file ending in a newline splits into a trailing empty
 * element that is not a line of the file, and a planner that keeps it would anchor a rule on `''`
 * at an index the verifier does not have.
 */

/**
 * Split filter-file text into the logical lines a planned insertion indexes.
 *
 * @param content - Exact file content, in either newline style.
 * @returns The file's lines, without the phantom element a trailing newline produces.
 */
export function filterFileLines(content: string): string[] {
    const normalized = content.replace(/\r\n?/gu, '\n');
    const lines = normalized.length === 0 ? [] : normalized.split('\n');
    if (lines.at(-1) === '') {
        lines.pop();
    }
    return lines;
}
