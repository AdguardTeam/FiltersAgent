import { canonicalHttpOrigin } from './network-safety';

/**
 * Relate landing and reported hosts only through equality or a subdomain boundary.
 *
 * Sibling hosts stay unrelated: `a.github.io` and `b.github.io` are different sites on one shared
 * suffix, and nothing short of a public-suffix authority tells them apart from `shop.example.com`
 * and `www.example.com`. For the same reason a tenant stays related to its provider's apex
 * (`a.github.io` and `github.io`, `www.example.co.uk` and `co.uk`): an accepted limit until the
 * parent check knows public suffixes.
 *
 * @param landingHostname - Canonical landing hostname.
 * @param issueHostname - Canonical hostname from the reported URL.
 * @returns Whether either host is the other's subdomain or the same host.
 */
export function isRelatedHost(landingHostname: string, issueHostname: string): boolean {
    return (
        landingHostname === issueHostname ||
        landingHostname.endsWith(`.${issueHostname}`) ||
        issueHostname.endsWith(`.${landingHostname}`)
    );
}

/**
 * Read the canonical hostname of one http(s) URL.
 *
 * @param url - Absolute URL or origin.
 * @returns Lowercase hostname without a trailing dot.
 * @throws When the value is not an absolute http(s) URL without credentials.
 */
function siteHostname(url: string): string {
    return new URL(canonicalHttpOrigin(url)).hostname.replace(/\.$/u, '');
}

/**
 * Decide whether a page the browser is on still belongs to the reported site.
 *
 * A site's own redirect keeps the reported page: `www.example.com` lands on `example.com`, `http`
 * on `https`, a path gains a slash or changes as the page scrolls. The scheme, the port and the
 * path are therefore ignored; only the hosts are related, through {@link isRelatedHost}. What the
 * page shows there is judged from its captures, not from its address.
 *
 * @param url - URL the browser landed on or a control leads to.
 * @param reportedUrl - Reported URL or its origin.
 * @returns Whether both are http(s) URLs on related hosts; false when either does not parse.
 */
export function isSameSiteUrl(url: string, reportedUrl: string): boolean {
    try {
        return isRelatedHost(siteHostname(url), siteHostname(reportedUrl));
    } catch {
        return false;
    }
}
