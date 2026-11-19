/**
 * The conditional platform blocks of a list file: the `!#if … !#endif` and
 * `!#safari_cb_affinity(…)` regions a rule can land inside.
 *
 * A rule placed inside one is limited to the platforms the condition names, so the placement plan
 * records the block instead of leaving the limit invisible in the report. The reader here is one
 * pass over the lines above the chosen line; nothing is inferred about which block the agent
 * meant.
 */

/**
 * Start of a conditional block (`!#if`, `!#else`, `!#safari_cb_affinity(…)`). Case-insensitive.
 */
export const CONDITION_START_PATTERN = /^!#(?:if\b|else\b|safari_cb_affinity\s*\()/iu;

/**
 * Start of the alternative branch of a conditional block (`!#else`). Case-insensitive.
 */
export const CONDITION_ELSE_PATTERN = /^!#else\b/iu;

/**
 * End of a conditional block (`!#endif`, `!#safari_cb_affinity`). Case-insensitive.
 */
export const CONDITION_END_PATTERN = /^!#(?:endif\b|safari_cb_affinity\s*$)/iu;

/**
 * One conditional block still open above a line, as the rule landing there would inherit it.
 */
interface OpenCondition {
    /**
     * The opener line, trimmed (`!#if …`, `!#safari_cb_affinity(…)`).
     */
    opener: string;

    /**
     * Whether the line sits in the `!#else` branch rather than the positive one.
     */
    alternative: boolean;
}

/**
 * Name the platform condition a line sits inside.
 *
 * An `!#else` line switches the innermost open block to its alternative branch rather than closing
 * it, and the recorded string keeps that branch so the rule is never reported as sitting in the
 * positive branch it is excluded from. Block ends close the innermost block; a nested block is the
 * one the line inherits.
 *
 * @param lines - Exact repository lines in the filter-file line model.
 * @param line - One-based line whose enclosing condition is asked for.
 * @returns The innermost enclosing condition as one line, or undefined when none encloses it.
 */
export function openConditionAt(lines: readonly string[], line: number): string | undefined {
    const stack: OpenCondition[] = [];
    for (let index = 0; index < line - 1 && index < lines.length; index += 1) {
        const text = lines[index].trim();
        if (CONDITION_END_PATTERN.test(text)) {
            stack.pop();
            continue;
        }
        if (CONDITION_ELSE_PATTERN.test(text)) {
            const innermost = stack.at(-1);
            if (innermost !== undefined) {
                innermost.alternative = true;
            }
            continue;
        }
        if (CONDITION_START_PATTERN.test(text)) {
            stack.push({ opener: text, alternative: false });
        }
    }
    const innermost = stack.at(-1);
    if (innermost === undefined) {
        return undefined;
    }
    return innermost.alternative ? `${innermost.opener} !#else` : innermost.opener;
}
