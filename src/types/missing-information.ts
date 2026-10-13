import * as v from 'valibot';

/**
 * Character ceiling on the subject of one missing-information record.
 *
 * The subject is the one-line gap name the run report shows; it names what is missing, never
 * carries the evidence, so a longer text belongs in the detail and the report stays scannable.
 */
export const MAX_MISSING_INFORMATION_SUBJECT_CHARACTERS = 200;

/**
 * Character ceiling on the detail of one missing-information record.
 *
 * The detail explains the gap the way the agent experienced it; the ceiling keeps one verbose
 * record from crowding the bounded report block, while the trace and observations always carry the
 * full text.
 */
export const MAX_MISSING_INFORMATION_DETAIL_CHARACTERS = 2000;

/**
 * Largest number of missing-information records a run result carries.
 *
 * This is a report ceiling, not a recording ceiling: the tool results and the observation sink keep
 * every record, and a run that hits the cap still had the overflow recorded in its trace. Ten gaps
 * are more than a one-issue report can meaningfully list.
 */
export const MAX_MISSING_INFORMATION_ENTRIES = 10;

/**
 * One missing-information record: exactly what the run instruction lacks.
 *
 * Carried identically by the report_missing_information tool result, the deterministic not-linked
 * guidance notice, and the capped block on the run result.
 */
export const MissingInformationEntrySchema = v.strictObject({
    subject: v.pipe(v.string(), v.maxLength(MAX_MISSING_INFORMATION_SUBJECT_CHARACTERS)),
    detail: v.pipe(v.string(), v.maxLength(MAX_MISSING_INFORMATION_DETAIL_CHARACTERS)),
});

/**
 * One missing-information record.
 */
export type MissingInformationEntry = v.InferOutput<typeof MissingInformationEntrySchema>;
