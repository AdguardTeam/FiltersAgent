/**
 * The one answer to "is this line a rule?" shared by the outline's region counts and the sorted-run
 * detection, so both split a list file identically.
 */
import { RuleKind, normalizeRule } from './rule-normalizer';

/**
 * Marker of a list header line such as `[Adblock Plus 2.0]` or `[$path=…]`.
 *
 * It parses as a network pattern rather than as a comment, so without this it would join the file's
 * first section as a rule and distort that section's measured order.
 */
const LIST_HEADER_PATTERN = /^\[.*\]$/u;

/**
 * Whether a line is a list header rather than a rule.
 *
 * @param line - Exact repository line.
 * @returns Whether the trimmed line is one bracketed header.
 */
export function isListHeaderLine(line: string): boolean {
    return LIST_HEADER_PATTERN.test(line.trim());
}

/**
 * Whether a line is a rule line: neither a comment, an empty line nor a list header.
 *
 * @param line - Exact repository line.
 * @param kind - The line's already normalized kind, when the caller has it.
 * @returns Whether the line holds a rule.
 */
export function isRuleLine(line: string, kind: RuleKind = normalizeRule(line).kind): boolean {
    return kind !== RuleKind.Comment && kind !== RuleKind.Empty && !isListHeaderLine(line);
}
