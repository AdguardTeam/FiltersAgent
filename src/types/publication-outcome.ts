/**
 * Whether a run's evidence was published as a report or kept as evidence only.
 */
export const PublicationOutcome = {
    Published: 'published',
    EvidenceOnly: 'evidence_only',
} as const;

/**
 * Every PublicationOutcome value, for schemas and exhaustive listings.
 */
export const PUBLICATION_OUTCOME_VALUES = Object.values(PublicationOutcome);

/**
 * PublicationOutcome value.
 */
export type PublicationOutcome = (typeof PublicationOutcome)[keyof typeof PublicationOutcome];
