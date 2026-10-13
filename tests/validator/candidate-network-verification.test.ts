import { describe, expect, it } from 'vitest';
import type { NetworkRequestEntry } from '../../src/browser/browser-interfaces';
import {
    CandidateNetworkVerdict,
    judgeableBlockedHost,
    verifyCandidateNetwork,
} from '../../src/validator/candidate-network-verification';

const REPORTED_URL = 'https://nudostar.com/';
const CANDIDATE = '||alaphoid.com^$domain=nudostar.com';

/**
 * One recorded request: a completed one carries its status, a blocked one status 0.
 *
 * @param url - Request URL.
 * @param resourceType - Playwright resource type.
 * @param statusCode - Response status, 0 when the blocker stopped the request.
 * @returns The network log entry.
 */
function request(url: string, resourceType = 'script', statusCode = 200): NetworkRequestEntry {
    return {
        url,
        method: 'GET',
        resourceType,
        statusCode,
        requestHeaders: {},
        responseHeaders: {},
    };
}

const PAGE = [request('https://nudostar.com/', 'document'), request('https://nudostar.com/app.js')];
const TRACKER = [
    request('https://alaphoid.com/14/abc', 'script'),
    request('https://alaphoid.com/3/', 'xhr'),
    request('https://cdn.alaphoid.com/pixel/ase', 'fetch'),
];
const TRACKER_BLOCKED = TRACKER.map((entry) => ({ ...entry, statusCode: 0 }));

describe('verifyCandidateNetwork', () => {
    it('verifies the tracker block that the baseline let through and the candidate stopped', () => {
        // AdguardFilters #242153: nothing to see, ten requests to alaphoid.com in the baseline.
        const verification = verifyCandidateNetwork({
            candidateRule: CANDIDATE,
            reportedUrl: REPORTED_URL,
            phases: {
                A: [...PAGE, ...TRACKER],
                B: [...PAGE, ...TRACKER],
                C: [...PAGE, ...TRACKER_BLOCKED],
            },
        });

        expect(verification).toEqual({
            blockedHost: 'alaphoid.com',
            phases: {
                A: { total: 3, allowed: 3, blocked: 0 },
                B: { total: 3, allowed: 3, blocked: 0 },
                C: { total: 3, allowed: 0, blocked: 3 },
            },
            newThirdPartyHosts: [],
            verdict: CandidateNetworkVerdict.Verified,
        });
    });

    it('names each way the block falls short', () => {
        const phases = { A: [...PAGE, ...TRACKER], B: [...PAGE, ...TRACKER] };
        // A request to the host that still completes with the rule in place.
        expect(
            verifyCandidateNetwork({
                candidateRule: CANDIDATE,
                reportedUrl: REPORTED_URL,
                phases: {
                    ...phases,
                    C: [...PAGE, ...TRACKER_BLOCKED, request('https://alaphoid.com/7/', 'xhr')],
                },
            })?.verdict,
        ).toBe(CandidateNetworkVerdict.RequestsAllowed);
        // A script from a third party neither earlier phase contacted: the shape of a fallback.
        const fallback = verifyCandidateNetwork({
            candidateRule: CANDIDATE,
            reportedUrl: REPORTED_URL,
            phases: {
                ...phases,
                C: [
                    ...PAGE,
                    ...TRACKER_BLOCKED,
                    request('https://alaphoid-cdn.net/14/abc', 'script'),
                ],
            },
        });
        expect(fallback).toMatchObject({
            verdict: CandidateNetworkVerdict.NewThirdPartyHosts,
            newThirdPartyHosts: ['alaphoid-cdn.net'],
        });
        // A baseline that never reached the host has nothing for the block to stop.
        expect(
            verifyCandidateNetwork({
                candidateRule: CANDIDATE,
                reportedUrl: REPORTED_URL,
                phases: { A: [...PAGE, ...TRACKER], B: PAGE, C: PAGE },
            })?.verdict,
        ).toBe(CandidateNetworkVerdict.BaselineAbsent);
    });

    it('does not read a creative asset from a fresh host, or a first-party host, as a fallback', () => {
        const verification = verifyCandidateNetwork({
            candidateRule: CANDIDATE,
            reportedUrl: REPORTED_URL,
            phases: {
                A: [...PAGE, ...TRACKER],
                B: [...PAGE, ...TRACKER],
                C: [
                    ...PAGE,
                    ...TRACKER_BLOCKED,
                    request('https://img7.creative-cdn.example/banner.png', 'image'),
                    request('https://static.nudostar.com/late.js', 'script'),
                ],
            },
        });

        expect(verification?.verdict).toBe(CandidateNetworkVerdict.Verified);
        expect(verification?.newThirdPartyHosts).toEqual([]);
    });

    it('never counts a locally served resource or an already blocked fallback as a new host', () => {
        // The blocker's own $redirect resources carry a fresh per-session id as their "host", so
        // they differ between every two phases; the 18:35Z pass on 2026-09-22 reported one as a
        // new third party for both of its network candidates.
        const redirects = (sessionId: string): NetworkRequestEntry[] => [
            request(
                `chrome-extension://${sessionId}/web-accessible-resources/redirects/googletagservices-gpt.js`,
                'script',
                0,
            ),
            request(`blob:https://nudostar.com/${sessionId}`, 'fetch'),
        ];
        const verification = verifyCandidateNetwork({
            candidateRule: CANDIDATE,
            reportedUrl: REPORTED_URL,
            phases: {
                A: [...PAGE, ...TRACKER],
                B: [...PAGE, ...TRACKER, ...redirects('df88bcac-02ab-4340-8647-a45c9ef6a2cf')],
                C: [
                    ...PAGE,
                    ...TRACKER_BLOCKED,
                    ...redirects('7eb79fcd-522d-42ac-8818-64657d0aa411'),
                    // A fallback loader the published filters already stop.
                    request('https://alaphoid-cdn.net/14/abc', 'script', 0),
                ],
            },
        });

        expect(verification).toMatchObject({
            verdict: CandidateNetworkVerdict.Verified,
            newThirdPartyHosts: [],
        });
    });

    it('judges only a plain third-party host block', () => {
        // A resource-type modifier narrows what the rule blocks: an allowed image would be no
        // failure of a `$script` rule, so requests alone cannot judge it.
        expect(
            judgeableBlockedHost('||alaphoid.com^$script,domain=nudostar.com', REPORTED_URL),
        ).toBeUndefined();
        expect(judgeableBlockedHost('||nudostar.com/ads^', REPORTED_URL)).toBeUndefined();
        expect(judgeableBlockedHost('nudostar.com##.ad', REPORTED_URL)).toBeUndefined();
        expect(judgeableBlockedHost(CANDIDATE, REPORTED_URL)).toBe('alaphoid.com');
        expect(
            verifyCandidateNetwork({
                candidateRule: 'nudostar.com##.ad',
                reportedUrl: REPORTED_URL,
                phases: { A: PAGE, B: PAGE, C: PAGE },
            }),
        ).toBeUndefined();
    });
});
