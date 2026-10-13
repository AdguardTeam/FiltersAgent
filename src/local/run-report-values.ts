/**
 * The smallest shared pieces of the run-report Markdown: how one optional value, one inline list,
 * one possibly-empty collection and one evidence path list are spelled.
 *
 * They are here rather than in any one renderer because the run status, the environment selection
 * and the candidate sections all reach for them, and a report whose `n/a` or `none` is spelled two
 * different ways in two sections reads as two different reports. Nothing here knows what a run is.
 */

/**
 * Render an optional value without exposing JavaScript null values.
 *
 * @param value - Optional string value.
 * @returns The original value or `n/a`.
 */
export function renderOptional(value: string | null): string {
    return value ?? 'n/a';
}

/**
 * Render a possibly empty list of enum-like values as inline code.
 *
 * @param values - Ordered values to render.
 * @returns Comma-separated inline-code values or `none`.
 */
export function renderInlineValues(values: readonly string[]): string {
    return values.length > 0 ? values.map((value) => `\`${value}\``).join(', ') : 'none';
}

/**
 * Render a nonempty collection or one explicit empty-state line.
 *
 * @param items - Ordered values to render.
 * @param render - Renderer for one value.
 * @param fallback - Line used when the collection is empty.
 * @returns Rendered lines or the fallback line.
 */
export function renderItemsOrFallback<T>(
    items: readonly T[],
    render: (item: T) => string,
    fallback: string,
): string[] {
    if (items.length === 0) {
        return [fallback];
    }
    return items.map(render);
}

/**
 * Render a list of local evidence paths.
 *
 * @param label - Heading for the evidence category.
 * @param paths - Local paths captured for that category.
 * @returns Markdown lines for the category.
 */
export function renderPathList(label: string, paths: string[]): string[] {
    const lines = [`### ${label}`, ''];
    if (paths.length === 0) {
        lines.push('None.');
        return lines;
    }
    lines.push(
        ...paths.flatMap((path, index) => [
            `![${label} ${index + 1}](<${path}>)`,
            '',
            `[Open ${label.toLowerCase()} ${index + 1}](<${path}>)`,
        ]),
    );
    return lines;
}
