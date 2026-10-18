/**
 * How the agent's DOM checks read in the final visual review.
 *
 * Each record becomes a few labelled lines rather than JSON: an answer is already JSON text, and
 * serializing it again would escape every quote and push the block past any cap derived from the
 * answer bound. Every field is bounded here, so the block's size follows from the constants and the
 * reviewer always receives both answers of every check; only the echoed expression is shortened,
 * with a marker, because the claim and the answers carry the question.
 */
import {
    DomCheckMeasurementStatus,
    MAX_DOM_CHECKS,
    MAX_DOM_CHECK_CLAIM_CHARS,
    MAX_DOM_CHECK_RESULT_BYTES,
    type DomCheckMeasurement,
    type DomCheckRecord,
} from '../types/dom-check';

/**
 * Longest part of a check's expression the review shows; the factual record and the `apply_rule`
 * answer keep it whole.
 *
 * Enough for the reviewer to see which element and which property a focused check reads.
 */
const MAX_DOM_CHECK_EXPRESSION_ECHO_CHARS = 600;

/**
 * Room for one record's labels and cut markers.
 */
const DOM_CHECK_RECORD_LABEL_CHARS = 200;

/**
 * Size of the review's DOM-check block when every allowed check is at every bound.
 *
 * A UTF-8 answer of N bytes is at most N characters, and no field is escaped again, so the block
 * never exceeds this and the prompt cap never cuts an answer.
 */
export const MAX_DOM_CHECK_FACTS_CHARS =
    MAX_DOM_CHECKS *
    (DOM_CHECK_RECORD_LABEL_CHARS +
        MAX_DOM_CHECK_EXPRESSION_ECHO_CHARS +
        MAX_DOM_CHECK_CLAIM_CHARS +
        2 * MAX_DOM_CHECK_RESULT_BYTES);

/**
 * Collapse agent- or page-authored text onto one line, so no field can start a line of its own.
 *
 * @param text - Text to flatten.
 * @returns The text with every run of whitespace as one space.
 */
function oneLine(text: string): string {
    return text.replace(/\s+/gu, ' ').trim();
}

/**
 * State what one check returned in one phase.
 *
 * @param measurement - The phase's measurement.
 * @returns One line's worth of text.
 */
function renderMeasurement(measurement: DomCheckMeasurement): string {
    if (measurement.status === DomCheckMeasurementStatus.Failed) {
        return `failed: ${oneLine(measurement.error)}`;
    }
    return measurement.truncated
        ? `${measurement.result} [cut at ${MAX_DOM_CHECK_RESULT_BYTES} bytes]`
        : measurement.result;
}

/**
 * Render the checks for the review prompt, one block of lines per check.
 *
 * @param records - The checks with what they returned in the baseline and the candidate phase.
 * @returns The block, never longer than {@link MAX_DOM_CHECK_FACTS_CHARS}.
 */
export function renderDomChecksForReview(records: readonly DomCheckRecord[]): string {
    return records
        .map((record, index) => {
            const expression = oneLine(record.expression);
            const echo =
                expression.length > MAX_DOM_CHECK_EXPRESSION_ECHO_CHARS
                    ? `${expression.slice(0, MAX_DOM_CHECK_EXPRESSION_ECHO_CHARS)} [shortened]`
                    : expression;
            return [
                `Check ${index + 1}. Claim: ${oneLine(record.claim)}`,
                `Expression: ${echo}`,
                `BEFORE: ${renderMeasurement(record.before)}`,
                `AFTER: ${renderMeasurement(record.after)}`,
            ].join('\n');
        })
        .join('\n');
}
