/**
 * Dollar precision preserves fractions of a cent on inexpensive models.
 */
export const MONEY_DECIMALS = 4;
/**
 * Tenths distinguish durations and mean milestones without implying excessive precision.
 */
export const STATISTIC_DECIMALS = 1;
/**
 * Missing measurements are distinct from zero.
 */
export const UNAVAILABLE = '—';
/**
 * Markdown table cells cannot contain literal line breaks.
 */
const LINE_BREAK_PATTERN = /[\r\n]/gu;
/**
 * RFC 4180 requires quoting fields containing delimiters, quotes or line breaks.
 */
const CSV_QUOTING_PATTERN = /[,"\r\n]/u;

/**
 * Render unavailable values distinctly from measured zero.
 *
 * @param value - Measured number or null.
 * @param decimals - Fixed decimal precision.
 * @returns Human-readable number or a dash.
 */
export function fixed(value: number | null, decimals: number): string {
    return value === null ? UNAVAILABLE : value.toFixed(decimals);
}

/**
 * Keep model labels and case names within their Markdown table cells.
 *
 * @param text - Artifact-sourced text.
 * @returns Text escaped for one Markdown table cell.
 */
export function markdownCell(text: string): string {
    return text.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(LINE_BREAK_PATTERN, ' ');
}

/**
 * Escape one RFC 4180 CSV field without rounding stored measurements.
 *
 * @param value - Scalar cell value, with null represented by an empty cell.
 * @returns Comma-safe quoted field when required.
 */
export function csvField(value: string | number | null): string {
    const text = value === null ? '' : String(value);
    return CSV_QUOTING_PATTERN.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
