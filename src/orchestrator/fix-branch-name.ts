/**
 * The branch name a fix run publishes under, and the reverse read of the reported domain out of an
 * existing branch name.
 */

/**
 * Extract a hostname from the first parseable URL in the list.
 *
 * Wraps `new URL(...).hostname` in a try/catch so malformed or unusual URLs from the issue body do
 * not throw. Iterates the list and uses the first URL that parses. If none parse, falls back to a
 * heuristic extraction (strip protocol and path).
 *
 * @param urls - The reported site URLs from the issue facts.
 * @returns The extracted hostname (may be a heuristic fallback).
 */
function extractDomain(urls: string[]): string {
    for (const url of urls) {
        try {
            return new URL(url).hostname;
        } catch {
            continue;
        }
    }
    const first = urls[0] ?? 'unknown';
    return first.replace(/^https?:\/\//, '').split('/')[0] || 'unknown';
}

/**
 * Sanitize a domain string for use in a branch/ref name: lowercase, strip non-`[a-z0-9.-]` chars,
 * trim leading/trailing dots.
 *
 * @param domain - The raw domain string.
 * @returns The sanitized domain, or `'unknown'` if empty.
 */
function sanitizeDomain(domain: string): string {
    return (
        domain
            .toLowerCase()
            .replace(/[^a-z0-9.-]/g, '')
            .replace(/^\.+|\.+$/g, '') || 'unknown'
    );
}

/**
 * Derive the `fix/<N>-<domain>` branch name from the issue number and reported site URLs.
 *
 * It never throws on malformed URLs.
 *
 * @param issueNumber - The GitHub issue number.
 * @param reportedSiteUrls - The reported site URLs from the issue facts.
 * @returns The branch name `fix/<N>-<sanitized-domain>`.
 */
export function deriveBranchName(issueNumber: number, reportedSiteUrls: string[]): string {
    const domain = sanitizeDomain(extractDomain(reportedSiteUrls));
    return `fix/${issueNumber}-${domain}`;
}

/**
 * Leading `fix/<issue number>-` segment that {@link deriveBranchName} puts in front of the domain.
 *
 * It has to stay the exact inverse of that template literal, which is why the two live side by
 * side: the branch name is the only carrier of the domain between the runner and the core, and a
 * prefix or separator changed on the construction side alone would silently strip the wrong span,
 * putting a mangled domain into the run result context and its telemetry rather than failing.
 */
const BRANCH_NAME_DOMAIN_PREFIX_PATTERN = /^fix\/\d+-/;

/**
 * Recover the sanitized reported domain from a branch name produced by {@link deriveBranchName}.
 *
 * @param branchName - Branch name in the `fix/<N>-<domain>` form.
 * @returns The sanitized domain segment, or the unchanged input when it carries no such prefix.
 */
export function branchNameDomain(branchName: string): string {
    return branchName.replace(BRANCH_NAME_DOMAIN_PREFIX_PATTERN, '');
}
