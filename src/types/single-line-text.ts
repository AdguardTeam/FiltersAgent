/**
 * Shared single-line text patterns for schema fields holding one line of repository or agent text.
 *
 * One line is a shape rule, not a length rule: a field may be empty where the format allows it
 * (`anchorRule`), and each schema keeps its own `minLength` and `maxLength` bounds. The patterns
 * are deliberately flagless: several of these schemas are converted to JSON Schema for the model,
 * and that conversion refuses a pattern carrying regex flags.
 */
import * as v from 'valibot';

/**
 * Text holding exactly one line, empty included.
 */
// oxlint-disable-next-line unicorn/require-unicode-regexp -- JSON Schema conversion refuses flags.
export const SINGLE_LINE_TEXT_PATTERN = /^[^\r\n]*$/;

/**
 * Text holding at least one non-whitespace character.
 *
 * A reason or heading made only of spaces states nothing, yet a shape-only check would accept it
 * and the report would print an empty argument after its colon. Composed with
 * {@link SINGLE_LINE_TEXT_PATTERN} through {@link nonBlankSingleLineText} wherever the field must
 * be non-blank: this pattern alone matches across line breaks. The value is matched, never trimmed:
 * the agent's own leading and trailing whitespace stays part of the recorded text.
 */
// oxlint-disable-next-line unicorn/require-unicode-regexp -- JSON Schema conversion refuses flags.
export const NON_BLANK_TEXT_PATTERN = /\S/;

/**
 * The schema of one line of text holding at least one non-whitespace character, at most `maxLength`
 * characters long.
 *
 * The two shared patterns are an intersection rather than two `v.regex` actions in one pipe: the
 * JSON Schema conversion refuses a second regex action on one field, and every field carrying this
 * text is part of a tool payload converted for the model. Each branch keeps the string type the
 * conversion reads bounds from.
 *
 * @param maxLength - Ceiling the field's own schema sets.
 * @returns The bounded non-blank single-line schema.
 */
export function nonBlankSingleLineText(maxLength: number) {
    return v.intersect([
        v.pipe(
            v.string(),
            v.regex(SINGLE_LINE_TEXT_PATTERN),
            v.minLength(1),
            v.maxLength(maxLength),
        ),
        v.pipe(v.string(), v.regex(NON_BLANK_TEXT_PATTERN)),
    ]);
}
