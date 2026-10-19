import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { candidatePatchVerificationRefusal } from '../../src/orchestrator/candidate-verdict';
import type { CandidateVisualReview } from '../../src/types/candidate-visual-review';
import type { CandidatePatch } from '../../src/types/fix-run-result';
import { calculateTrustedBaselineHash } from '../../src/validator/trusted-validation-context';

const REPORTED_URL = 'https://www.example.com/';
const RULE = 'example.com##.ad-gate';
const RULE_HASH = createHash('sha256').update(RULE).digest('hex');

/**
 * Build one complete runner-bound experiment whose phases recorded where the browser landed.
 *
 * @param landedUrls - URL each phase recorded, keyed by phase.
 * @returns Factual record, trusted context and the verified review bound to it.
 */
function experiment(landedUrls: { A: string; B: string; C: string }) {
    const baselineHash = calculateTrustedBaselineHash(REPORTED_URL, []);
    const phase = (label: 'A' | 'B' | 'C', rules: string[]) => ({
        phase: label,
        url: landedUrls[label],
        screenshotArtifactId: `${label}-viewport`,
        fullPageScreenshotArtifactId: `${label}-full-page`,
        appliedRules: rules,
        ruleApplications: rules.map((rule) => ({ rule, status: 'applied' })),
    });
    const review: CandidateVisualReview = {
        verdict: 'verified',
        symptom: 'resolved',
        symptomScope: 'The anti-adblock wall over the homepage.',
        adLayoutResidue: 'absent',
        coverageComplete: true,
        beforeInstances: [
            {
                artifactId: 'B-viewport',
                landmark: 'Homepage',
                description: 'The anti-adblock wall covers the news.',
            },
        ],
        remainingInstances: [],
        pageIntegrity: 'intact',
        validationArtifactId: `validation-${RULE_HASH.slice(0, 12)}`,
        candidateRuleHash: RULE_HASH,
        beforeViewportArtifactId: 'B-viewport',
        afterViewportArtifactId: 'C-viewport',
        beforeFullPageArtifactId: 'B-full-page',
        afterFullPageArtifactId: 'C-full-page',
        model: 'vision-model',
        rationale: 'The wall is gone and the page is intact.',
        observedDamage: [],
    };
    return {
        factual: {
            trustedValidationContext: {
                reportedUrl: REPORTED_URL,
                baselineHash,
                existingRuleCount: 0,
            },
            phaseA: phase('A', []),
            phaseB: phase('B', []),
            phaseC: phase('C', [RULE]),
        },
        context: { reportedUrl: REPORTED_URL, existingRules: [], baselineHash },
        review,
    };
}

describe('candidatePatchVerificationRefusal', () => {
    it.each([
        ['the bare domain', 'https://example.com/'],
        ['http', 'http://www.example.com/'],
        ['another path on the site', 'https://example.com/news/'],
    ])("verifies a candidate whose phases followed the site's redirect to %s", (_name, landed) => {
        const { factual, context, review } = experiment({ A: landed, B: landed, C: landed });

        expect(
            candidatePatchVerificationRefusal(
                factual,
                { rule: RULE } as CandidatePatch,
                context,
                review,
            ),
        ).toBeUndefined();
    });

    it.each([
        ['another site', 'https://example.org/'],
        ['a sibling subdomain', 'https://shop.example.com/'],
    ])('names the phase that landed on %s', (_name, landed) => {
        const { factual, context, review } = experiment({
            A: 'https://example.com/',
            B: landed,
            C: 'https://example.com/',
        });

        const refusal = candidatePatchVerificationRefusal(
            factual,
            { rule: RULE } as CandidatePatch,
            context,
            review,
        );

        expect(refusal).toContain('phase B');
        expect(refusal).toContain(landed);
    });
});
