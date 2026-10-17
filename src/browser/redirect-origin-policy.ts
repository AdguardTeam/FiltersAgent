/**
 * Which redirect landing origins remain available after the current page load.
 */
export const RedirectOriginPolicy = {
    /**
     * Keep every public landing origin for live issue investigations.
     */
    KeepEveryLanding: 'keep_every_landing',
    /**
     * Keep only hosts related to the reported host for historical investigations.
     */
    KeepRelatedHosts: 'keep_related_hosts',
} as const;

/**
 * Redirect origin retention policy.
 */
export type RedirectOriginPolicy = (typeof RedirectOriginPolicy)[keyof typeof RedirectOriginPolicy];
