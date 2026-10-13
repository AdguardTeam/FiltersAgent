/**
 * Where a prepared extension or KnowledgeBase checkout was sourced from.
 */
export const ProvenanceSource = {
    Local: 'local',
    Remote: 'remote',
} as const;

export const PROVENANCE_SOURCE_VALUES = Object.values(ProvenanceSource);

/**
 * One provenance source.
 */
export type ProvenanceSource = (typeof ProvenanceSource)[keyof typeof ProvenanceSource];
