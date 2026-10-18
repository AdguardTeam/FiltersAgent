/**
 * DOM checks the agent attaches to `apply_rule`: read-only expressions the runner evaluates on the
 * baseline and candidate page loads of one experiment, each with the claim the agent expects it to
 * prove.
 *
 * Two reviewers looked at identical pixels after a candidate and disagreed whether a white column
 * was ad residue or page layout. The page's own structure answers that — an empty track of a
 * transparent grid, the page's own margins, an emptied container that still paints a background —
 * and only the agent knows which structure to ask about. The runner measures on the very page loads
 * the screenshots come from, and the visual review weighs the answers; no code reads their
 * meaning.
 */
import * as v from 'valibot';

/**
 * Most checks one `apply_rule` call may attach.
 *
 * Each check runs twice, in the baseline and the candidate phase, and both answers travel into the
 * review prompt and the tool result: a handful settles a residue question, more only crowds them.
 */
export const MAX_DOM_CHECKS = 5;

/**
 * Ceiling on the claim the agent states for one check.
 *
 * One sentence naming what the measurement should prove; the reviewer compares it with the result.
 */
export const MAX_DOM_CHECK_CLAIM_CHARS = 300;

/**
 * Ceiling on one recorded answer, per check and per phase, in UTF-8 bytes; a longer value is cut
 * here and kept whole as an artifact.
 *
 * A residue question is answered by a few computed styles and boxes. The review's block of checks
 * is sized from this cap (`MAX_DOM_CHECK_FACTS_CHARS`), so every answer reaches the reviewer whole
 * up to it.
 */
export const MAX_DOM_CHECK_RESULT_BYTES = 1_024;

/**
 * Longest one check may run on the page, in milliseconds.
 *
 * A computed style or a walk up a dozen ancestors answers in milliseconds. The validator still
 * admits a loop that never ends or a promise that never settles, and on the candidate page, where
 * the element the rehearsal found is gone, a walk that ended before may not; without this bound
 * only the experiment's own deadline would stop it.
 */
export const DOM_CHECK_TIMEOUT_MS = 5_000;

/**
 * A string holding at least one non-whitespace character.
 *
 * A blank expression or claim measures and states nothing, yet would make a new plan that spends
 * one of the candidate's runs. A pattern rather than `v.trim()`: the schema is also the tool's
 * advertised JSON Schema, which cannot express a transformation, and the pattern is checked the
 * same way on both sides. Deliberately flagless, because that conversion refuses regex flags.
 */
// oxlint-disable-next-line unicorn/require-unicode-regexp -- JSON Schema conversion refuses flags.
const NON_BLANK_PATTERN = /\S/;

export const DomCheckSchema = v.object({
    expression: v.pipe(
        v.string(),
        v.regex(NON_BLANK_PATTERN, 'The expression is blank.'),
        v.description(
            'A read-only JavaScript expression, held to the evaluate_js rules, whose JSON result ' +
                'answers the claim.',
        ),
    ),
    claim: v.pipe(
        v.string(),
        v.regex(NON_BLANK_PATTERN, 'The claim is blank.'),
        v.maxLength(MAX_DOM_CHECK_CLAIM_CHARS),
        v.description('What the result shows about the region the review named.'),
    ),
});

export const DomChecksRequestSchema = v.pipe(v.array(DomCheckSchema), v.maxLength(MAX_DOM_CHECKS));

/**
 * How one check ended in one phase.
 */
export const DomCheckMeasurementStatus = {
    /**
     * The expression returned a value, recorded as JSON.
     */
    Measured: 'measured',

    /**
     * The page threw, the check ran out of time or returned no JSON value, or an earlier check of
     * the same phase ran out of time and the rest were skipped.
     */
    Failed: 'failed',
} as const;
export type DomCheckMeasurementStatus =
    (typeof DomCheckMeasurementStatus)[keyof typeof DomCheckMeasurementStatus];

export const DomCheckMeasurementSchema = v.variant('status', [
    v.object({
        status: v.literal(DomCheckMeasurementStatus.Measured),
        result: v.string(),
        truncated: v.boolean(),
        artifactId: v.optional(v.string()),
    }),
    v.object({
        status: v.literal(DomCheckMeasurementStatus.Failed),
        error: v.string(),
    }),
]);

export const DomCheckRecordSchema = v.object({
    expression: v.string(),
    claim: v.string(),
    before: DomCheckMeasurementSchema,
    after: DomCheckMeasurementSchema,
});

export type DomCheck = v.InferOutput<typeof DomCheckSchema>;
export type DomCheckMeasurement = v.InferOutput<typeof DomCheckMeasurementSchema>;
export type DomCheckRecord = v.InferOutput<typeof DomCheckRecordSchema>;
