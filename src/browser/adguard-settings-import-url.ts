import { createHash } from 'node:crypto';

/**
 * Hostnames whose HTTPS URLs may carry an AdGuard reporter settings import query.
 *
 * These are the report front-ends AdGuard publishes; a settings import found on any other host is
 * untrusted text rather than reporter-stated environment, so it may not decide which filters or
 * Stealth state a run reproduces. The importer, the runtime's provenance scan, and any other
 * validator of report URLs all read this one set: a report domain AdGuard adds becomes trusted for
 * all of them at once, never for one of them while the others reject the same URL.
 */
export const TRUSTED_REPORT_SETTINGS_HOSTS: ReadonlySet<string> = new Set([
    'reports.adguard.com',
    'reports.adguard.info',
    'reports.adguard.app',
]);

/**
 * Hash one AdGuard settings import URL after normalizing semantically irrelevant URL encoding.
 *
 * URLSearchParams serialization canonicalizes characters such as encoded commas and timestamps,
 * allowing a model-copied URL to remain bound to the reporter settings without requiring identical
 * percent-encoding. Parameter order is intentionally preserved because duplicate and legacy query
 * fields can be order-sensitive.
 *
 * @param importUrl - Trusted settings import URL already selected by the caller.
 * @returns SHA-256 digest of the canonical URL representation.
 */
export function canonicalAdGuardSettingsImportUrlSha256(importUrl: string): string {
    const url = new URL(importUrl);
    url.search = url.searchParams.toString();
    return createHash('sha256').update(url.href).digest('hex');
}
