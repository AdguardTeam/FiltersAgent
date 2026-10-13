import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
    type CandidateVisualReviewModelOutput,
    CandidateVisualReviewModelOutputSchema,
    CandidateVisualReviewSchema,
    deriveCandidateVisualIntegrityBasis,
    deriveCandidateVisualSymptomBasis,
    deriveCandidateVisualVerdict,
} from '../../src/types/candidate-visual-review';
import { deriveCandidateNetworkScope } from '../../src/validator/candidate-network-scope';
import {
    CandidateNetworkVerdict,
    type CandidateNetworkVerification,
} from '../../src/validator/candidate-network-verification';

const REPORTED_URL = 'https://www.sarkisozleri.bbs.tr/85';

/**
 * Scopes are derived from real rules rather than spelled as literals, so these cases break when the
 * runner stops classifying the live bench candidate as a third-party host block.
 */
const THIRD_PARTY_SCOPE = deriveCandidateNetworkScope(
    '||increase-rev.cv3-ecf.workers.dev^$domain=sarkisozleri.bbs.tr',
    REPORTED_URL,
);
const FIRST_PARTY_SCOPE = deriveCandidateNetworkScope('||sarkisozleri.bbs.tr/ads^', REPORTED_URL);
const COSMETIC_SCOPE = deriveCandidateNetworkScope('sarkisozleri.bbs.tr##.ad-banner', REPORTED_URL);

const modelOutput = {
    symptom: 'resolved',
    symptomScope: 'Every repeated advertising banner leftover on the article page.',
    adLayoutResidue: 'absent',
    coverageComplete: true,
    beforeInstances: [
        {
            artifactId: 'before-tile-1',
            landmark: 'Between the market ticker and the first article card.',
            description: 'A large empty advertising banner slot.',
        },
    ],
    remainingInstances: [],
    pageIntegrity: 'intact',
    rationale: 'The reported overlay is gone and the underlying page remains usable.',
    observedDamage: [],
} satisfies CandidateVisualReviewModelOutput;

const review = {
    ...modelOutput,
    verdict: 'verified',
    validationArtifactId: 'validation-a1b2c3d4e5f6',
    candidateRuleHash: 'a'.repeat(64),
    beforeViewportArtifactId: 'screenshot-before-viewport',
    afterViewportArtifactId: 'screenshot-after-viewport',
    beforeFullPageArtifactId: 'screenshot-before-full-page',
    afterFullPageArtifactId: 'screenshot-after-full-page',
    model: 'google/gemini-3.5-flash',
} as const;

describe('CandidateVisualReviewModelOutputSchema', () => {
    it('accepts only the bounded semantic judgment returned by the model', () => {
        expect(v.parse(CandidateVisualReviewModelOutputSchema, modelOutput)).toEqual(modelOutput);
        expect(() =>
            v.parse(CandidateVisualReviewModelOutputSchema, {
                ...modelOutput,
                rationale: '',
            }),
        ).toThrow();
        expect(() =>
            v.parse(CandidateVisualReviewModelOutputSchema, {
                ...modelOutput,
                observedDamage: Array.from({ length: 21 }, () => 'damage'),
            }),
        ).toThrow();
        expect(() =>
            v.parse(CandidateVisualReviewModelOutputSchema, {
                ...modelOutput,
                validationArtifactId: 'validation-a1b2c3d4e5f6',
            }),
        ).toThrow();
    });
});

describe('CandidateVisualReviewSchema', () => {
    it('accepts a runner-bound review with all four visual evidence IDs', () => {
        expect(v.parse(CandidateVisualReviewSchema, review)).toEqual(review);
    });

    it('rejects malformed runner bindings and empty evidence identifiers', () => {
        expect(() =>
            v.parse(CandidateVisualReviewSchema, {
                ...review,
                validationArtifactId: 'validation-A1B2C3D4E5F6',
            }),
        ).toThrow();
        expect(() =>
            v.parse(CandidateVisualReviewSchema, {
                ...review,
                candidateRuleHash: 'A'.repeat(64),
            }),
        ).toThrow();
        expect(() =>
            v.parse(CandidateVisualReviewSchema, {
                ...review,
                beforeFullPageArtifactId: '',
            }),
        ).toThrow();
        expect(() =>
            v.parse(CandidateVisualReviewSchema, {
                ...review,
                model: '',
            }),
        ).toThrow();
    });

    it('rejects a verdict that does not match the semantic observations', () => {
        expect(() =>
            v.parse(CandidateVisualReviewSchema, {
                ...review,
                symptom: 'not_resolved',
            }),
        ).toThrow();
    });

    it('stores a third-party network block verified on an unclear page with its basis', () => {
        const stored = {
            ...review,
            pageIntegrity: 'unclear',
            candidateNetworkScope: THIRD_PARTY_SCOPE,
            integrityBasis: 'third_party_network_clean_before_after',
        };

        expect(v.parse(CandidateVisualReviewSchema, stored)).toEqual(stored);
        // The same observations without the runner's scope keep the contract that wants an
        // intact page, so the stored verdict no longer follows from the record.
        expect(() =>
            v.parse(CandidateVisualReviewSchema, {
                ...stored,
                candidateNetworkScope: FIRST_PARTY_SCOPE,
            }),
        ).toThrow();
        // A basis that does not follow from the record cannot be stored beside the verdict.
        expect(() =>
            v.parse(CandidateVisualReviewSchema, { ...stored, integrityBasis: 'intact' }),
        ).toThrow();
        expect(() =>
            v.parse(CandidateVisualReviewSchema, {
                ...review,
                symptom: 'unclear',
                verdict: 'inconclusive',
                integrityBasis: 'intact',
            }),
        ).toThrow();
    });
});

describe('deriveCandidateVisualVerdict', () => {
    it('verifies only complete coverage with a reproduced, fully resolved symptom and intact page', () => {
        expect(deriveCandidateVisualVerdict(modelOutput)).toBe('verified');
    });

    it('rejects an unresolved symptom, any residual instance, or a regressed page', () => {
        expect(
            deriveCandidateVisualVerdict({
                ...modelOutput,
                symptom: 'not_resolved',
            }),
        ).toBe('rejected');
        expect(
            deriveCandidateVisualVerdict({
                ...modelOutput,
                remainingInstances: [
                    {
                        artifactId: 'after-tile-3',
                        landmark: 'Before the NAJNOWSZE heading.',
                        description: 'A second empty banner remains visible.',
                    },
                ],
            }),
        ).toBe('rejected');
        expect(
            deriveCandidateVisualVerdict({
                ...modelOutput,
                pageIntegrity: 'regressed',
            }),
        ).toBe('rejected');
        expect(
            deriveCandidateVisualVerdict({
                ...modelOutput,
                adLayoutResidue: 'present',
                remainingInstances: [],
                rationale:
                    'The creatives disappeared, but empty advertising wrappers remain visible.',
            }),
        ).toBe('rejected');
    });

    it('returns inconclusive for every remaining combination', () => {
        expect(
            deriveCandidateVisualVerdict({
                ...modelOutput,
                symptom: 'unclear',
            }),
        ).toBe('inconclusive');
        expect(
            deriveCandidateVisualVerdict({
                ...modelOutput,
                pageIntegrity: 'unclear',
            }),
        ).toBe('inconclusive');
        expect(
            deriveCandidateVisualVerdict({
                ...modelOutput,
                coverageComplete: false,
            }),
        ).toBe('inconclusive');
        expect(
            deriveCandidateVisualVerdict({
                ...modelOutput,
                beforeInstances: [],
            }),
        ).toBe('inconclusive');
        expect(
            deriveCandidateVisualVerdict({
                ...modelOutput,
                adLayoutResidue: 'unclear',
            }),
        ).toBe('inconclusive');
    });

    it('holds leftover ad layout against every candidate except a third-party host block', () => {
        // A network block of a third-party host stops the advertising from loading; the space the
        // page itself reserves for it is a cosmetic rule's job, and the maintainers of the bench
        // case landed the network rule alone.
        const residue = { ...modelOutput, adLayoutResidue: 'present' } as const;

        expect(deriveCandidateVisualVerdict(residue, THIRD_PARTY_SCOPE)).toBe('verified');
        expect(deriveCandidateVisualVerdict(residue, FIRST_PARTY_SCOPE)).toBe('rejected');
        expect(deriveCandidateVisualVerdict(residue, COSMETIC_SCOPE)).toBe('rejected');
        expect(deriveCandidateVisualVerdict(residue)).toBe('rejected');
        // The advertising itself still has to be gone.
        expect(
            deriveCandidateVisualVerdict(
                { ...residue, symptom: 'not_resolved' },
                THIRD_PARTY_SCOPE,
            ),
        ).toBe('rejected');
    });

    it('verifies an unclear page only for an undamaged third-party network block', () => {
        const unclearIntegrity = { ...modelOutput, pageIntegrity: 'unclear' } as const;

        expect(deriveCandidateVisualVerdict(unclearIntegrity, THIRD_PARTY_SCOPE)).toBe('verified');
        expect(
            deriveCandidateVisualVerdict(
                {
                    ...unclearIntegrity,
                    observedDamage: ['The article body lost its images below the fold.'],
                },
                THIRD_PARTY_SCOPE,
            ),
        ).toBe('inconclusive');
        expect(deriveCandidateVisualVerdict(unclearIntegrity, FIRST_PARTY_SCOPE)).toBe(
            'inconclusive',
        );
        expect(deriveCandidateVisualVerdict(unclearIntegrity, COSMETIC_SCOPE)).toBe('inconclusive');
    });
});

/**
 * The runner's verdict over the phase logs of a tracker block.
 *
 * @param verdict - What the logs proved.
 * @returns The verification record.
 */
function network(verdict: CandidateNetworkVerdict): CandidateNetworkVerification {
    return {
        blockedHost: 'alaphoid.com',
        phases: {
            A: { total: 3, allowed: 3, blocked: 0 },
            B: { total: 3, allowed: 3, blocked: 0 },
            C: {
                total: 3,
                allowed: verdict === CandidateNetworkVerdict.RequestsAllowed ? 1 : 0,
                blocked: 3,
            },
        },
        newThirdPartyHosts: [],
        verdict,
    };
}
describe('a review decided by the network verification', () => {
    // Vision saw nothing before and nothing after: a request has no picture.
    const nothingSeen: CandidateVisualReviewModelOutput = {
        ...modelOutput,
        symptom: 'unclear',
        beforeInstances: [],
        pageIntegrity: 'unclear',
        rationale: 'No advertising element was visible in either state.',
    };

    it('verifies a tracker block by the requests it stopped when vision saw nothing', () => {
        const verified = network(CandidateNetworkVerdict.Verified);

        expect(deriveCandidateVisualVerdict(nothingSeen, THIRD_PARTY_SCOPE, verified)).toBe(
            'verified',
        );
        expect(deriveCandidateVisualSymptomBasis(nothingSeen, THIRD_PARTY_SCOPE, verified)).toBe(
            'network_requests_blocked',
        );
        // Without the verification the same images verify nothing, as before.
        expect(deriveCandidateVisualVerdict(nothingSeen, THIRD_PARTY_SCOPE)).toBe('inconclusive');
        // The images still hold the page-safety half: visible damage rejects the block.
        expect(
            deriveCandidateVisualVerdict(
                {
                    ...nothingSeen,
                    pageIntegrity: 'regressed',
                    observedDamage: ['The player is gone.'],
                },
                THIRD_PARTY_SCOPE,
                verified,
            ),
        ).toBe('rejected');
        // Requests that still complete, or a fallback host, reject it whatever the images show.
        expect(
            deriveCandidateVisualVerdict(
                nothingSeen,
                THIRD_PARTY_SCOPE,
                network(CandidateNetworkVerdict.RequestsAllowed),
            ),
        ).toBe('rejected');
        expect(
            deriveCandidateVisualVerdict(
                nothingSeen,
                THIRD_PARTY_SCOPE,
                network(CandidateNetworkVerdict.NewThirdPartyHosts),
            ),
        ).toBe('rejected');
    });

    it('leaves the verdict to vision when it did see the symptom', () => {
        // A visible advertisement served from the blocked host: the images judge, the network facts
        // ride along.
        expect(
            deriveCandidateVisualVerdict(
                { ...modelOutput, symptom: 'not_resolved' },
                THIRD_PARTY_SCOPE,
                network(CandidateNetworkVerdict.Verified),
            ),
        ).toBe('rejected');
        expect(
            deriveCandidateVisualSymptomBasis(
                modelOutput,
                THIRD_PARTY_SCOPE,
                network(CandidateNetworkVerdict.Verified),
            ),
        ).toBe('observed');
    });

    it('stores the network-verified review with its bases and refuses a stored verdict the record does not produce', () => {
        const stored = {
            ...review,
            ...nothingSeen,
            candidateNetworkScope: THIRD_PARTY_SCOPE,
            integrityBasis: 'third_party_network_clean_before_after',
            networkVerification: network(CandidateNetworkVerdict.Verified),
            symptomBasis: 'network_requests_blocked',
        };

        expect(v.parse(CandidateVisualReviewSchema, stored)).toEqual(stored);
        expect(() =>
            v.parse(CandidateVisualReviewSchema, {
                ...stored,
                networkVerification: network(CandidateNetworkVerdict.RequestsAllowed),
            }),
        ).toThrow();
        expect(() =>
            v.parse(CandidateVisualReviewSchema, { ...stored, symptomBasis: 'observed' }),
        ).toThrow();
    });
});

describe('deriveCandidateVisualIntegrityBasis', () => {
    it('names why a verified verdict was reached, and nothing for an unverified one', () => {
        expect(deriveCandidateVisualIntegrityBasis(modelOutput, COSMETIC_SCOPE)).toBe('intact');
        expect(
            deriveCandidateVisualIntegrityBasis(
                { ...modelOutput, pageIntegrity: 'unclear' },
                THIRD_PARTY_SCOPE,
            ),
        ).toBe('third_party_network_clean_before_after');
        expect(
            deriveCandidateVisualIntegrityBasis(
                { ...modelOutput, pageIntegrity: 'unclear' },
                FIRST_PARTY_SCOPE,
            ),
        ).toBeUndefined();
    });
});
