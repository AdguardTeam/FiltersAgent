/**
 * Network verification of a third-party host block: the runner's own judgement, from the phase
 * network logs alone, of whether the candidate stopped the requests it names.
 *
 * A tracker or analytics report has nothing to see: the symptom is a request the page makes, and a
 * vision review that judges the reporter's symptom by images finds no instance before the rule and
 * cannot verify anything after it, so a tracker host block judged by images alone ends
 * `baseline_symptom_absent`. The network logs the phases already record answer the question
 * directly: the baseline lets the requests through, the candidate blocks every one of them, and
 * blocking them did not make the page reach for another third party instead.
 */
import * as v from 'valibot';
import type { NetworkRequestEntry } from '../browser/browser-interfaces';
import { RequestParty, classifyRequestParty } from '../browser/request-party';
import { normalizeRule } from '../repo/rule-normalizer';
import { candidateBlockedHost } from './candidate-network-scope';

/**
 * What the phase network logs proved about the candidate.
 */
export const CandidateNetworkVerdict = {
    /**
     * The baseline let requests to the blocked host through, the candidate let none through, and no
     * third party the page had not contacted before appeared in its place.
     */
    Verified: 'verified',

    /**
     * The baseline made no allowed request to the blocked host: the block has nothing to stop on
     * this page, so there is no symptom to fix.
     */
    BaselineAbsent: 'baseline_absent',

    /**
     * Requests to the blocked host still completed with the candidate applied.
     */
    RequestsAllowed: 'requests_allowed',

    /**
     * With the block in place the page reached third-party hosts it had not contacted in either
     * earlier phase, in the request kinds a tracker uses, and the requests went through — the shape
     * of a fallback loader the published filters do not stop.
     */
    NewThirdPartyHosts: 'new_third_party_hosts',
} as const;

/**
 * CandidateNetworkVerdict value.
 */
export type CandidateNetworkVerdict =
    (typeof CandidateNetworkVerdict)[keyof typeof CandidateNetworkVerdict];

/**
 * Every network verdict, for the schema picklist.
 */
export const CANDIDATE_NETWORK_VERDICT_VALUES = Object.values(CandidateNetworkVerdict);

/**
 * Upper bound on the new third-party hosts a verification names, so a page that fans out to
 * hundreds of hosts still yields a bounded record.
 */
const MAX_NEW_THIRD_PARTY_HOSTS = 20;

/**
 * Resource types a tracker or its fallback loader uses. A creative asset — an image, a font, a
 * stylesheet, a media file — served by a host the page had not used before is the ordinary churn of
 * advertising creatives and says nothing about the block; a script, a beacon or a data request to a
 * fresh host is what a fallback looks like.
 */
const TRACKING_RESOURCE_TYPES: ReadonlySet<string> = new Set([
    'script',
    'xhr',
    'fetch',
    'ping',
    'eventsource',
    'websocket',
    'other',
]);

/**
 * URL schemes of requests that leave the browser for a host. Everything else in a phase log is
 * served locally: an MV3 blocker's `$redirect` resources arrive as `chrome-extension://<per-session
 * id>/web-accessible-resources/redirects/…`, whose "host" is a fresh random id in every session,
 * and would read as a new third party in every candidate phase. `blob:` and `data:` carry no host
 * at all.
 */
const NETWORK_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:']);

/**
 * Modifiers that leave a host block judgeable by requests to the host alone. A resource-type
 * modifier (`$script`, `$image`) narrows what the rule blocks, so a request of another type
 * completing with the rule in place would be no failure of the rule; such a candidate is left to
 * the visual review rather than judged against every request.
 */
const HOST_ONLY_MODIFIER_PATTERN = /^(?:domain=.+|third-party|3p|~first-party|~1p|important)$/u;

const RequestCountSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

export const PhaseHostRequestsSchema = v.strictObject({
    total: RequestCountSchema,
    allowed: RequestCountSchema,
    blocked: RequestCountSchema,
});

export const CandidateNetworkVerificationSchema = v.strictObject({
    blockedHost: v.pipe(v.string(), v.minLength(1), v.maxLength(253)),
    phases: v.strictObject({
        A: PhaseHostRequestsSchema,
        B: PhaseHostRequestsSchema,
        C: PhaseHostRequestsSchema,
    }),
    newThirdPartyHosts: v.pipe(
        v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(253))),
        v.maxLength(MAX_NEW_THIRD_PARTY_HOSTS),
    ),
    verdict: v.picklist(CANDIDATE_NETWORK_VERDICT_VALUES),
});

/**
 * Requests one phase made to the blocked host and how they ended.
 */
export type PhaseHostRequests = v.InferOutput<typeof PhaseHostRequestsSchema>;

/**
 * The runner's network verification of one third-party host block.
 */
export type CandidateNetworkVerification = v.InferOutput<typeof CandidateNetworkVerificationSchema>;

/**
 * The phase network logs a verification judges.
 */
export interface CandidateNetworkPhaseLogs {
    /**
     * Requests of the unfiltered control phase.
     */
    A: readonly NetworkRequestEntry[];

    /**
     * Requests of the published-baseline phase.
     */
    B: readonly NetworkRequestEntry[];

    /**
     * Requests of the candidate phase.
     */
    C: readonly NetworkRequestEntry[];
}

/**
 * Whether a request host is the blocked host or one of its subdomains, which is what `||host^`
 * matches.
 *
 * @param host - Lowercase request hostname.
 * @param blockedHost - The anchored hostname of the block.
 * @returns Whether the block covers the host.
 */
function underBlockedHost(host: string, blockedHost: string): boolean {
    return host === blockedHost || host.endsWith(`.${blockedHost}`);
}

/**
 * The lowercase hostname of a request that left the browser.
 *
 * @param url - Absolute request URL as the network log recorded it.
 * @returns The hostname, or undefined when the URL does not parse or was served locally.
 */
function requestHost(url: string): string | undefined {
    try {
        const parsed = new URL(url);
        return NETWORK_SCHEMES.has(parsed.protocol)
            ? parsed.hostname.toLowerCase().replace(/\.$/u, '')
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The host a candidate blocks, when the phase network logs can judge the candidate by it.
 *
 * @param candidateRule - Exact candidate rule text the experiment applied.
 * @param reportedUrl - Trusted reported page URL the experiment navigated to.
 * @returns The blocked hostname, or undefined when the candidate is not a plain third-party host
 *   block that requests to the host alone can judge.
 */
export function judgeableBlockedHost(
    candidateRule: string,
    reportedUrl: string,
): string | undefined {
    const blockedHost = candidateBlockedHost(candidateRule, reportedUrl);
    if (blockedHost === undefined) {
        return undefined;
    }
    const judgeable = normalizeRule(candidateRule).modifiers.every((modifier) =>
        HOST_ONLY_MODIFIER_PATTERN.test(modifier),
    );
    return judgeable ? blockedHost : undefined;
}

/**
 * Count one phase's requests to the blocked host by how they ended.
 *
 * A request the blocker stopped never receives a response and is recorded with status 0; every
 * other status means the request reached its host.
 *
 * @param entries - The phase's network log.
 * @param blockedHost - The anchored hostname of the block.
 * @returns The request counts.
 */
export function phaseHostRequests(
    entries: readonly NetworkRequestEntry[],
    blockedHost: string,
): PhaseHostRequests {
    const counts = { total: 0, allowed: 0, blocked: 0 };
    for (const entry of entries) {
        const host = requestHost(entry.url);
        if (host === undefined || !underBlockedHost(host, blockedHost)) {
            continue;
        }
        counts.total += 1;
        if (entry.statusCode === 0) {
            counts.blocked += 1;
        } else {
            counts.allowed += 1;
        }
    }
    return counts;
}

/**
 * Third-party hosts the candidate phase reached with tracker-shaped requests that went through, and
 * that neither earlier phase had reached at all.
 *
 * Two earlier loads of the same page stand in for its ordinary host rotation; a host absent from
 * both and contacted only once the block was in place is what a fallback loader looks like. A
 * fallback the published filters already stop leaves the page as clean as the block alone, so only
 * a request that completed counts against the candidate.
 *
 * @param logs - The three phase network logs.
 * @param reportedUrl - Trusted reported page URL, for the third-party classification.
 * @param blockedHost - The anchored hostname of the block, whose own subdomains are not "new".
 * @returns The new hosts, sorted, bounded.
 */
function newThirdPartyHosts(
    logs: CandidateNetworkPhaseLogs,
    reportedUrl: string,
    blockedHost: string,
): string[] {
    const seenBefore = new Set<string>();
    for (const entry of [...logs.A, ...logs.B]) {
        const host = requestHost(entry.url);
        if (host !== undefined) {
            seenBefore.add(host);
        }
    }
    const fresh = new Set<string>();
    for (const entry of logs.C) {
        const host = requestHost(entry.url);
        if (
            host === undefined ||
            entry.statusCode === 0 ||
            seenBefore.has(host) ||
            underBlockedHost(host, blockedHost) ||
            !TRACKING_RESOURCE_TYPES.has(entry.resourceType) ||
            classifyRequestParty(entry.url, reportedUrl) !== RequestParty.Third
        ) {
            continue;
        }
        fresh.add(host);
    }
    return [...fresh].sort().slice(0, MAX_NEW_THIRD_PARTY_HOSTS);
}

/**
 * Judge a third-party host block by the three phase network logs.
 *
 * @param input - The candidate, the trusted reported URL and the phase logs.
 * @param input.candidateRule - Exact candidate rule text the experiment applied.
 * @param input.reportedUrl - Trusted reported page URL the experiment navigated to.
 * @param input.phases - The three phase network logs.
 * @returns The verification, or undefined when the candidate is not one the logs can judge.
 */
export function verifyCandidateNetwork(input: {
    /**
     * Exact candidate rule text the experiment applied.
     */
    candidateRule: string;

    /**
     * Trusted reported page URL the experiment navigated to.
     */
    reportedUrl: string;

    /**
     * The three phase network logs.
     */
    phases: CandidateNetworkPhaseLogs;
}): CandidateNetworkVerification | undefined {
    const blockedHost = judgeableBlockedHost(input.candidateRule, input.reportedUrl);
    if (blockedHost === undefined) {
        return undefined;
    }
    const phases = {
        A: phaseHostRequests(input.phases.A, blockedHost),
        B: phaseHostRequests(input.phases.B, blockedHost),
        C: phaseHostRequests(input.phases.C, blockedHost),
    };
    const fresh = newThirdPartyHosts(input.phases, input.reportedUrl, blockedHost);
    const verdict =
        phases.B.allowed === 0
            ? CandidateNetworkVerdict.BaselineAbsent
            : phases.C.allowed > 0
              ? CandidateNetworkVerdict.RequestsAllowed
              : fresh.length > 0
                ? CandidateNetworkVerdict.NewThirdPartyHosts
                : CandidateNetworkVerdict.Verified;
    return v.parse(CandidateNetworkVerificationSchema, {
        blockedHost,
        phases,
        newThirdPartyHosts: fresh,
        verdict,
    });
}
