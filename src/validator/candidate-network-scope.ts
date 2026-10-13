/**
 * What a candidate rule does to the reported page's request graph, decided by the runner from the
 * rule text and the trusted reported URL alone.
 *
 * The visual reviewer cannot prove from images that a first-party interactive function still works
 * after a request was blocked, so it reports `pageIntegrity: unclear` for every network candidate.
 * One case is still verifiable without that proof: a block aimed at a host outside the page's own
 * site serves the page nothing it owns, so a clean before/after with no observed damage is the
 * whole evidence there is to have. This module names that case so the derivation can admit it — and
 * names nothing else, so the model cannot talk a first-party or non-network candidate into it.
 */
import { sharesRegistrableDomain } from '../repo/domain-scope';
import { RuleKind, normalizeRule } from '../repo/rule-normalizer';

/**
 * How a candidate rule relates to the reported page's own site.
 */
export const CandidateNetworkScope = {
    /**
     * A blocking network rule anchored to a hostname outside the reported page's site.
     */
    ThirdPartyHostBlock: 'third_party_host_block',

    /**
     * Every other candidate: non-network, exception, first-party, or no concrete anchored host.
     */
    NotApplicable: 'not_applicable',
} as const;

/**
 * CandidateNetworkScope value.
 */
export type CandidateNetworkScope =
    (typeof CandidateNetworkScope)[keyof typeof CandidateNetworkScope];

/**
 * Every candidate network scope value, for schemas and exhaustive listings.
 */
export const CANDIDATE_NETWORK_SCOPE_VALUES = Object.values(CandidateNetworkScope);

/**
 * Prefix that anchors an AdGuard network pattern to a hostname and its subdomains.
 *
 * The single-pipe `|` form anchors the start of the whole URL including the scheme, so what follows
 * it is not a hostname and is deliberately not accepted here.
 */
const HOSTNAME_ANCHOR = '||';

/**
 * Characters that end the hostname inside a host-anchored network pattern.
 *
 * `^` is the separator anchor, `/` starts a path, and `?` starts a query — the three ways a
 * `||host…` pattern says it is done naming the host. Modifiers are already gone: the hostname is
 * read from the normalized pattern, which the `$` split removed them from.
 */
const HOSTNAME_TERMINATORS = ['^', '/', '?'] as const;

/**
 * Shape of a concrete hostname: dot-separated letter/digit/hyphen labels, at least two of them.
 *
 * A wildcard (`||increase-rev.*.workers.dev^`) names a family rather than one host, and a
 * single-label pattern (`||localhost^`) has no registrable domain to compare against the page, so
 * neither passes. Both then fall to `NotApplicable`, which is the fail-closed direction.
 */
const ANCHORED_HOSTNAME_PATTERN =
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;

/**
 * Modifiers that confine a network rule to requests the page's own site issued.
 *
 * A rule carrying one of these never blocks a third-party request, whatever its pattern says, so it
 * can never be the third-party case. AdGuard spells the negation `~third-party` / `~3p`, uBlock
 * Origin also accepts `1p` and `first-party`. `~first-party` and `~1p` are excluded on purpose:
 * they mean the opposite.
 */
const FIRST_PARTY_ONLY_MODIFIERS = new Set(['~third-party', '~3p', '1p', 'first-party']);

/**
 * Read the concrete hostname a normalized network pattern is anchored to.
 *
 * @param urlPattern - Normalized network pattern, lowercased and stripped of modifiers.
 * @returns The anchored hostname, or undefined when the pattern anchors to no single host.
 */
function anchoredHostname(urlPattern: string | undefined): string | undefined {
    if (urlPattern === undefined || !urlPattern.startsWith(HOSTNAME_ANCHOR)) {
        return undefined;
    }
    const afterAnchor = urlPattern.slice(HOSTNAME_ANCHOR.length);
    const end = HOSTNAME_TERMINATORS.reduce((shortest, terminator) => {
        const index = afterAnchor.indexOf(terminator);
        return index === -1 ? shortest : Math.min(shortest, index);
    }, afterAnchor.length);
    const hostname = afterAnchor.slice(0, end);
    return ANCHORED_HOSTNAME_PATTERN.test(hostname) ? hostname : undefined;
}

/**
 * Read the hostname of the trusted reported page URL.
 *
 * @param pageUrl - Runner-bound reported URL, never model input.
 * @returns The lowercase hostname, or undefined when the value is not a parseable URL.
 */
function pageHostname(pageUrl: string): string | undefined {
    try {
        const hostname = new URL(pageUrl).hostname.toLowerCase();
        return hostname.length > 0 ? hostname : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The host a third-party host block is anchored to, when the candidate is one.
 *
 * Runner-owned like the scope itself: read from the exact candidate text and the trusted reported
 * URL, so the network verification that judges requests to this host cannot be pointed at a host
 * the model chose to name.
 *
 * @param candidateRule - Exact candidate rule text the experiment applied.
 * @param pageUrl - Trusted reported page URL the experiment navigated to.
 * @returns The blocked hostname, or undefined when the candidate is not a third-party host block.
 */
export function candidateBlockedHost(candidateRule: string, pageUrl: string): string | undefined {
    if (
        deriveCandidateNetworkScope(candidateRule, pageUrl) !==
        CandidateNetworkScope.ThirdPartyHostBlock
    ) {
        return undefined;
    }
    return anchoredHostname(normalizeRule(candidateRule).urlPattern);
}

/**
 * Classify what a candidate rule does to the reported page's request graph.
 *
 * Both inputs are runner-owned: the exact candidate text the experiment applied and the trusted
 * reported URL the experiment navigated to. Nothing the model says enters this decision.
 *
 * @param candidateRule - Exact candidate rule text the experiment applied.
 * @param pageUrl - Trusted reported page URL the experiment navigated to.
 * @returns The candidate's scope relative to the reported page's own site.
 */
export function deriveCandidateNetworkScope(
    candidateRule: string,
    pageUrl: string,
): CandidateNetworkScope {
    const normalized = normalizeRule(candidateRule);
    if (normalized.kind !== RuleKind.Network || normalized.isException) {
        return CandidateNetworkScope.NotApplicable;
    }
    if (normalized.modifiers.some((modifier) => FIRST_PARTY_ONLY_MODIFIERS.has(modifier))) {
        return CandidateNetworkScope.NotApplicable;
    }
    const hostname = anchoredHostname(normalized.urlPattern);
    const page = pageHostname(pageUrl);
    if (hostname === undefined || page === undefined) {
        return CandidateNetworkScope.NotApplicable;
    }
    return hostname === page || sharesRegistrableDomain(hostname, page)
        ? CandidateNetworkScope.NotApplicable
        : CandidateNetworkScope.ThirdPartyHostBlock;
}
