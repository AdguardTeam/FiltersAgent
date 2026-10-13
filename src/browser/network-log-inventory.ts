import type { NetworkRequestEntry } from './browser-interfaces';
import { RequestParty, classifyRequestParty, registrableDomain } from './request-party';

/**
 * One request identity observed during a phase, reduced to the fields that decide a rule shape:
 * which host served it, what it was, whether it completed, and whether it is a third party relative
 * to the reported page.
 */
export interface NetworkLogRequestSummary {
    /**
     * The request hostname.
     */
    host: string;

    /**
     * The request path (pathname plus search), truncated only when absurdly long.
     */
    path: string;

    /**
     * The Playwright resource type (document, script, image, xhr, fetch, media, …).
     */
    type: string;

    /**
     * The HTTP response status (0 when the request was blocked or failed).
     */
    status: number;

    /**
     * Whether the request host is a third party relative to the reported page host.
     */
    thirdParty: boolean;

    /**
     * How many times this exact identity was requested during the phase.
     */
    count: number;
}

/**
 * The complete model-facing inventory of one phase's network activity.
 *
 * Every request reaches the model: identical requests collapse into one entry carrying a count, and
 * nothing is filtered by resource type or by URL shape. A summary that surfaces only URLs matching
 * a substring such as `/ad` or `doubleclick` hides exactly the loaders maintainers block
 * (`cs.iubenda.com`, `cdn.selly.pl`, `ptfg.flyertrip.com/static/img/campain/`).
 */
export interface NetworkLogInventory {
    /**
     * Total number of requests recorded in the phase.
     */
    requestCount: number;

    /**
     * Number of requests that completed with status 0 (blocked or failed).
     */
    blockedCount: number;

    /**
     * Request counts grouped by resource type, over every request.
     */
    byType: Record<string, number>;

    /**
     * Request counts grouped by host, over every request. Complete even when the per-path list is
     * bounded, so no host can disappear from the evidence.
     */
    byHost: Record<string, number>;

    /**
     * Every distinct request identity, third-party first and then by host.
     */
    requests: NetworkLogRequestSummary[];

    /**
     * URLs of blocked or failed requests (status 0).
     */
    blocked: string[];

    /**
     * How many distinct request identities were left out of `requests` by the path-list bound.
     * Their hosts remain in `byHost`; zero when the list is complete.
     */
    omittedRequestCount: number;
}

/**
 * Upper bound on distinct request identities listed per call. Not a relevance filter: it exists
 * only so one tool result cannot flood the context on a page with thousands of distinct URLs.
 * Whatever it drops is counted in `omittedRequestCount` and still present in `byHost`.
 */
const MAX_LISTED_REQUESTS = 300;

/**
 * Upper bound on blocked URLs listed per call.
 */
const MAX_BLOCKED_URLS = 50;

/**
 * Upper bound on a surfaced path before truncation, to bound tracker query strings.
 */
const MAX_PATH_LENGTH = 200;

/**
 * Normalize a hostname for comparison: lowercase and strip a trailing dot.
 *
 * @param host - Raw hostname.
 * @returns Normalized hostname.
 */
function normalizeHost(host: string): string {
    return host.toLowerCase().replace(/\.$/u, '');
}

/**
 * Resolve the registrable name of the reported page, which is what makes a party comparison
 * meaningful at all.
 *
 * @param reportedOrigin - Canonical origin or full URL of the reported page (may be undefined).
 * @returns The registrable name, or an empty string when the origin does not parse.
 */
function reportedRegistrableDomain(reportedOrigin: string | undefined): string {
    if (!reportedOrigin) {
        return '';
    }
    try {
        return registrableDomain(new URL(reportedOrigin).hostname);
    } catch {
        return '';
    }
}

/**
 * Host and bounded path of one parsed request URL.
 */
interface SplitRequestUrl {
    /**
     * Normalized request host.
     */
    host: string;

    /**
     * Path with query, cut to the inventory's path budget.
     */
    path: string;
}

/**
 * Reduce one raw request URL to its host and bounded path.
 *
 * @param url - The full request URL.
 * @returns The parsed host and path, or null when the URL cannot be parsed.
 */
function splitUrl(url: string): SplitRequestUrl | null {
    try {
        const parsed = new URL(url);
        const path = `${parsed.pathname}${parsed.search}`;
        return {
            host: normalizeHost(parsed.hostname),
            path: path.length > MAX_PATH_LENGTH ? `${path.slice(0, MAX_PATH_LENGTH)}…` : path,
        };
    } catch {
        return null;
    }
}

/**
 * Build the complete model-facing inventory from a redacted phase network log.
 *
 * @param entries - Redacted network request entries for the phase.
 * @param reportedOrigin - Canonical origin or URL of the reported page, for third-party marking.
 * @returns The inventory surfaced to the model.
 */
export function summarizeNetworkLog(
    entries: readonly NetworkRequestEntry[],
    reportedOrigin: string | undefined,
): NetworkLogInventory {
    // Without a parsable reported origin there is no party to compare against, so every request
    // stays unmarked rather than being called a third party on no evidence.
    const partyComparable = reportedRegistrableDomain(reportedOrigin).length > 0;
    const byType: Record<string, number> = {};
    const byHost: Record<string, number> = {};
    const blocked: string[] = [];
    const distinct = new Map<string, NetworkLogRequestSummary>();

    for (const entry of entries) {
        byType[entry.resourceType] = (byType[entry.resourceType] ?? 0) + 1;
        if (entry.statusCode === 0 && blocked.length < MAX_BLOCKED_URLS) {
            blocked.push(entry.url);
        }
        const split = splitUrl(entry.url);
        const host = split ? split.host : entry.url;
        byHost[host] = (byHost[host] ?? 0) + 1;
        if (!split) {
            continue;
        }
        const key = `${split.host}|${split.path}|${entry.resourceType}|${entry.statusCode}`;
        const existing = distinct.get(key);
        if (existing) {
            existing.count += 1;
            continue;
        }
        distinct.set(key, {
            host: split.host,
            path: split.path,
            type: entry.resourceType,
            status: entry.statusCode,
            thirdParty:
                partyComparable &&
                classifyRequestParty(entry.url, reportedOrigin!) === RequestParty.Third,
            count: 1,
        });
    }

    const ordered = [...distinct.values()].sort((a, b) => {
        if (a.thirdParty !== b.thirdParty) {
            return a.thirdParty ? -1 : 1;
        }
        if (a.host !== b.host) {
            return a.host.localeCompare(b.host);
        }
        return a.path.localeCompare(b.path);
    });

    return {
        requestCount: entries.length,
        blockedCount: entries.filter((entry) => entry.statusCode === 0).length,
        byType,
        byHost,
        requests: ordered.slice(0, MAX_LISTED_REQUESTS),
        blocked,
        omittedRequestCount: Math.max(0, ordered.length - MAX_LISTED_REQUESTS),
    };
}
