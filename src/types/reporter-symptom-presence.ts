import * as v from 'valibot';

/**
 * Whether the reporter's symptom was seen in a capture, with an explicit undecided state.
 */
export const ReporterSymptomPresence = {
    Present: 'present',
    Absent: 'absent',
    Indeterminate: 'indeterminate',
} as const;

/**
 * Every reporter symptom presence value, for schemas and exhaustive listings.
 */
export const REPORTER_SYMPTOM_PRESENCE_VALUES = Object.values(ReporterSymptomPresence);

export const ReporterSymptomPresenceSchema = v.picklist(REPORTER_SYMPTOM_PRESENCE_VALUES);

/**
 * Decided symptom presence without the undecided state, derived from the same members.
 */
export const SymptomPresence = {
    Present: ReporterSymptomPresence.Present,
    Absent: ReporterSymptomPresence.Absent,
} as const;

/**
 * Every decided symptom presence value, for schemas and exhaustive listings.
 */
export const SYMPTOM_PRESENCE_VALUES = Object.values(SymptomPresence);

/**
 * Decided symptom presence value.
 */
export type SymptomPresence = (typeof SymptomPresence)[keyof typeof SymptomPresence];

/**
 * Vision-owned presence of the exact reporter-defined symptom in one complete page capture.
 */
export type ReporterSymptomPresence = v.InferOutput<typeof ReporterSymptomPresenceSchema>;
