/**
 * Whether a request belongs to the reported page's own site or to a third party.
 */
export const RequestParty = {
    First: 'first',
    Third: 'third',
} as const;

/**
 * RequestParty value.
 */
export type RequestParty = (typeof RequestParty)[keyof typeof RequestParty];

/**
 * Generic second-level labels under which country-code registries delegate registrable names
 * (`example.co.uk`, `shop.com.cn`, `site.org.au`). The list is a bounded heuristic for marking
 * evidence, not a public-suffix authority: a miss only mislabels a first-party CDN as third party.
 */
const GENERIC_SECOND_LEVEL_LABELS = new Set([
    'ac',
    'biz',
    'co',
    'com',
    'edu',
    'gen',
    'go',
    'gov',
    'info',
    'ltd',
    'mil',
    'ne',
    'net',
    'nom',
    'or',
    'org',
    'plc',
    'web',
]);

/**
 * Reduce a hostname to the registrable name that identifies its site.
 *
 * @param hostname - Lowercase or mixed-case hostname, with or without a trailing dot.
 * @returns The registrable name (`sub.example.co.uk` → `example.co.uk`), the hostname itself for IP
 *   addresses and single labels.
 */
export function registrableDomain(hostname: string): string {
    const host = hostname.trim().toLowerCase().replace(/\.$/u, '');
    const labels = host.split('.').filter((label) => label.length > 0);
    if (labels.length <= 2 || labels.every((label) => /^\d+$/u.test(label))) {
        return labels.join('.');
    }
    const tld = labels.at(-1)!;
    const secondLevel = labels.at(-2)!;
    const countryCodeDelegation =
        tld.length === 2 && secondLevel.length <= 4 && GENERIC_SECOND_LEVEL_LABELS.has(secondLevel);
    return labels.slice(countryCodeDelegation ? -3 : -2).join('.');
}

/**
 * Extract the hostname of a URL or origin without throwing on malformed input.
 *
 * @param value - Absolute URL or origin.
 * @returns Lowercase hostname, or undefined when the value does not parse.
 */
function hostnameOf(value: string): string | undefined {
    try {
        return new URL(value).hostname.toLowerCase();
    } catch {
        return undefined;
    }
}

/**
 * Classify one request against the page it was observed on.
 *
 * @param requestUrl - Absolute request URL.
 * @param pageOrigin - Reported page URL or origin.
 * @returns First party when both resolve to the same registrable name, third party otherwise or
 *   when either side does not parse.
 */
export function classifyRequestParty(requestUrl: string, pageOrigin: string): RequestParty {
    const requestHost = hostnameOf(requestUrl);
    const pageHost = hostnameOf(pageOrigin);
    if (!requestHost || !pageHost) {
        return RequestParty.Third;
    }
    return registrableDomain(requestHost) === registrableDomain(pageHost)
        ? RequestParty.First
        : RequestParty.Third;
}
