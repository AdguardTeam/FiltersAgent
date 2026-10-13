/**
 * KnowledgeBase revision selection modes for a run.
 */
export const KnowledgeBaseEnvironmentKind = {
    Current: 'current',
    Pinned: 'pinned',
} as const;

export const KNOWLEDGE_BASE_ENVIRONMENT_KIND_VALUES = Object.values(KnowledgeBaseEnvironmentKind);

/**
 * One KnowledgeBase environment kind.
 */
export type KnowledgeBaseEnvironmentKind =
    (typeof KnowledgeBaseEnvironmentKind)[keyof typeof KnowledgeBaseEnvironmentKind];
