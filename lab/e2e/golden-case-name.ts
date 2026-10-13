/**
 * Exact spelling accepted for a golden E2E case name.
 *
 * The preparer derives a name from the reported domain plus the issue number, and that name is then
 * used verbatim as a single directory segment under the tracked case root. It therefore stays
 * lowercase alphanumeric with internal hyphens only: no separator, dot, or uppercase character that
 * could name a parent directory, a hidden file, or an entry that collides on a case-insensitive
 * filesystem. The 100-character ceiling keeps the derived `<domain-slug>-<issue-number>` inside the
 * path budget of the run layout stacked on it.
 */
export const GOLDEN_CASE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,99})$/u;
