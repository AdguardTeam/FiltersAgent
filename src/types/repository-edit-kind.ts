/**
 * Shapes of a repository edit: insert a new line, extend a shared rule, replace or remove an exact
 * line.
 */
export const RepositoryEditKind = {
    Insert: 'insert',
    ExtendDomains: 'extend_domains',
    Replace: 'replace',
    Remove: 'remove',
} as const;

/**
 * RepositoryEditKind value.
 */
export type RepositoryEditKind = (typeof RepositoryEditKind)[keyof typeof RepositoryEditKind];
