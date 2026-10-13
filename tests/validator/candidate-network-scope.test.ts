import { describe, expect, it } from 'vitest';
import {
    CandidateNetworkScope,
    deriveCandidateNetworkScope,
} from '../../src/validator/candidate-network-scope';

const REPORTED_URL = 'https://www.sarkisozleri.bbs.tr/85';

describe('deriveCandidateNetworkScope', () => {
    it('classifies the live workers.dev candidate as a third-party host block', () => {
        expect(
            deriveCandidateNetworkScope(
                '||increase-rev.cv3-ecf.workers.dev^$domain=sarkisozleri.bbs.tr',
                REPORTED_URL,
            ),
        ).toBe(CandidateNetworkScope.ThirdPartyHostBlock);
    });

    it('refuses every candidate that is not a block on a host outside the reported site', () => {
        // A first-party path on the reported host serves the page its own content.
        expect(deriveCandidateNetworkScope('||sarkisozleri.bbs.tr/ads^', REPORTED_URL)).toBe(
            CandidateNetworkScope.NotApplicable,
        );
        // A subdomain of the reported site is still the reported site.
        expect(deriveCandidateNetworkScope('||ads.sarkisozleri.bbs.tr^', REPORTED_URL)).toBe(
            CandidateNetworkScope.NotApplicable,
        );
        // A regex pattern anchors to no hostname the runner can compare.
        expect(
            deriveCandidateNetworkScope(
                '/increase-rev\\.[a-z0-9-]+\\.workers\\.dev/',
                REPORTED_URL,
            ),
        ).toBe(CandidateNetworkScope.NotApplicable);
        // A path-only pattern anchors to no hostname either.
        expect(deriveCandidateNetworkScope('/increase-rev/*', REPORTED_URL)).toBe(
            CandidateNetworkScope.NotApplicable,
        );
        // A wildcard host names a family rather than one host.
        expect(deriveCandidateNetworkScope('||increase-rev.*.workers.dev^', REPORTED_URL)).toBe(
            CandidateNetworkScope.NotApplicable,
        );
        // A cosmetic rule blocks no request at all.
        expect(deriveCandidateNetworkScope('sarkisozleri.bbs.tr##.ad-banner', REPORTED_URL)).toBe(
            CandidateNetworkScope.NotApplicable,
        );
        // A scriptlet rule blocks no request at all.
        expect(
            deriveCandidateNetworkScope(
                "sarkisozleri.bbs.tr#%#//scriptlet('set-constant', 'adsShown', 'true')",
                REPORTED_URL,
            ),
        ).toBe(CandidateNetworkScope.NotApplicable);
        // An exception unblocks rather than blocks.
        expect(
            deriveCandidateNetworkScope('@@||increase-rev.cv3-ecf.workers.dev^', REPORTED_URL),
        ).toBe(CandidateNetworkScope.NotApplicable);
        // A rule confined to first-party requests never blocks a third-party one.
        expect(
            deriveCandidateNetworkScope(
                '||increase-rev.cv3-ecf.workers.dev^$~third-party',
                REPORTED_URL,
            ),
        ).toBe(CandidateNetworkScope.NotApplicable);
        expect(
            deriveCandidateNetworkScope('||increase-rev.cv3-ecf.workers.dev^$1p', REPORTED_URL),
        ).toBe(CandidateNetworkScope.NotApplicable);
        // A reported URL the runner cannot parse leaves the candidate unclassified.
        expect(
            deriveCandidateNetworkScope('||increase-rev.cv3-ecf.workers.dev^', 'not a url'),
        ).toBe(CandidateNetworkScope.NotApplicable);
    });

    it('keeps a third-party classification for options that do not confine it to first party', () => {
        expect(
            deriveCandidateNetworkScope(
                '||increase-rev.cv3-ecf.workers.dev/loader.js$script,third-party',
                REPORTED_URL,
            ),
        ).toBe(CandidateNetworkScope.ThirdPartyHostBlock);
    });
});
