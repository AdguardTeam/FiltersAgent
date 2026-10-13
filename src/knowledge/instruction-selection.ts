import * as v from 'valibot';
import { formatIssues } from '../pi/valibot-issues';

/**
 * Issue-selection narrowing vocabulary and parser.
 *
 * The instruction may narrow which issues a backlog run takes under an `## Issue selection` (or
 * "which issues", `which issues to take`) heading: a `- labels:` item lists labels the issue must
 * all carry, and `- max-age-days:` bounds how old an issue may be. Every other line in the section
 * is prose. This module owns that section's keywords and the typed parse of its items; the caller
 * extracts the section body with {@link extractInstructionSection} using
 * `{@link ISSUE_SELECTION_SECTION_KEYWORDS}` and hands it here.
 */

/**
 * Keywords binding a Markdown `##` heading to the issue-selection role, checked case-insensitively
 * in the heading text.
 *
 * The instruction author names the section naturally ("Issue selection", "Which issues to take");
 * these keywords keep the binding fixed over such headings.
 */
export const ISSUE_SELECTION_SECTION_KEYWORDS = ['selection', 'which issues'] as const;

/**
 * Valibot schema for one selection narrowed by the instruction.
 */
export const IssueSelectionNarrowingSchema = v.strictObject({
    labels: v.optional(v.array(v.string())),
    maxAgeDays: v.optional(v.pipe(v.number(), v.minValue(1))),
});

/**
 * One selection narrowing parsed from the instruction's selection items.
 */
export type IssueSelectionNarrowing = v.InferOutput<typeof IssueSelectionNarrowingSchema>;

/**
 * Line binding the labels every selected issue must carry, listing them as comma-separated text.
 */
const LABELS_ITEM_LINE_PATTERN = /^-\s+labels:\s*(.*)$/;

/**
 * Line binding the maximum age of a selected issue, in plain decimal days.
 */
const MAX_AGE_DAYS_ITEM_LINE_PATTERN = /^-\s+max-age-days:\s*(.*)$/;

/**
 * Text denoting a plain non-negative decimal number — the only form a max-age-days value accepts,
 * so nothing C-style (hex, exponents, `Infinity`) slips a surprising cutoff into the selection.
 */
const DECIMAL_NUMBER_TEXT_PATTERN = /^\d+(?:\.\d+)?$/u;

/**
 * Typed failure for a malformed issue-selection narrowing item.
 */
export class SelectionNarrowingError extends Error {
    /**
     * Create a typed selection-narrowing failure.
     *
     * @param message - Diagnostic naming the offending text.
     * @param options - Optional underlying validation error.
     */
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'SelectionNarrowingError';
    }
}

/**
 * Parse the selection items of an issue-selection section body into typed narrowing.
 *
 * Contract: only `- labels:` / `- max-age-days:` lines bind; every other line is prose and is
 * ignored. Label entries are trimmed and empty entries dropped; a later item for the same key
 * overwrites the earlier value. Malformed values — a non-numeric age, a negative or zero age —
 * throw `{@link SelectionNarrowingError}` naming the offending line.
 *
 * @param content - The selection section body; an empty or item-free body yields an empty
 *   narrowing, which means no narrowing.
 * @returns The parsed narrowing, to validate against the queue inputs.
 */
export function parseIssueSelectionNarrowing(content: string): IssueSelectionNarrowing {
    let labels: string[] | undefined;
    let maxAgeDays: number | undefined;
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        const labelsItem = LABELS_ITEM_LINE_PATTERN.exec(trimmed);
        if (labelsItem !== null) {
            labels = labelsItem[1]
                .split(',')
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0);
            continue;
        }
        const maxAgeItem = MAX_AGE_DAYS_ITEM_LINE_PATTERN.exec(trimmed);
        if (maxAgeItem !== null) {
            const numberText = maxAgeItem[1].trim();
            if (!DECIMAL_NUMBER_TEXT_PATTERN.test(numberText)) {
                throw new SelectionNarrowingError(
                    `max-age-days must be a positive number of days, received ${JSON.stringify(numberText)} in ${JSON.stringify(trimmed)}.`,
                );
            }
            maxAgeDays = Number(numberText);
            continue;
        }
    }
    const narrowing: IssueSelectionNarrowing = {};
    if (labels !== undefined) {
        narrowing.labels = labels;
    }
    if (maxAgeDays !== undefined) {
        narrowing.maxAgeDays = maxAgeDays;
    }
    const result = v.safeParse(IssueSelectionNarrowingSchema, narrowing);
    if (!result.success) {
        throw new SelectionNarrowingError(
            `Malformed issue-selection narrowing: ${formatIssues(result.issues)} in ${JSON.stringify(content)}.`,
            { cause: result.issues },
        );
    }
    return result.output;
}
