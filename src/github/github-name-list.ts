/**
 * Lists of GitHub names a repository configures through the action's inputs: issue labels
 * (`excludedLabels`, `inProgressLabels`) and account logins (`reportBots`).
 *
 * Each input is one comma-separated value. GitHub treats label names and logins case-insensitively,
 * so the matching here does too.
 */

/**
 * Separator between the names of one list input.
 */
const NAME_LIST_SEPARATOR = ',';

/**
 * Parse one comma-separated list input.
 *
 * @param raw - The input value, or undefined when unset.
 * @returns The trimmed names, blank entries dropped; empty when the input lists none.
 */
export function parseNameList(raw: string | undefined): string[] {
    return (raw ?? '')
        .split(NAME_LIST_SEPARATOR)
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
}

/**
 * Pick the names that appear in a configured list, ignoring case.
 *
 * @param names - Names as GitHub reports them, such as the labels an issue carries now.
 * @param listed - Names the run was configured with.
 * @returns The matching names in their own spelling; empty when none matches.
 */
export function matchingNames(names: readonly string[], listed: readonly string[]): string[] {
    const wanted = new Set(listed.map((name) => name.toLowerCase()));
    return names.filter((name) => wanted.has(name.toLowerCase()));
}
