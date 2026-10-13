import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CandidateVisualReview } from '../../src/types/candidate-visual-review';
import type { ArtifactRef } from '../../src/types/trace';
import {
    calculateTrustedBaselineHash,
    type TrustedValidationContext,
} from '../../src/validator/trusted-validation-context';
import { selectRepresentativeRejectedCandidateScreenshots } from '../../src/orchestrator/rejected-validation-evidence';

/**
 * Build immutable validation inputs for one synthetic issue.
 *
 * @param existingRules - Exact repository baseline used by the fixture.
 * @returns Trusted context bound to the synthetic issue URL.
 */
function trustedContext(existingRules: string[] = []): TrustedValidationContext {
    const reportedUrl = 'https://example.com/article';
    return {
        reportedUrl,
        existingRules,
        baselineHash: calculateTrustedBaselineHash(reportedUrl, existingRules),
    };
}

/**
 * Create a rejected factual-validation artifact and its aligned viewport screenshots.
 *
 * @param rule - Exact candidate rule whose hash owns the artifact identity.
 * @param context - Trusted issue URL and rule baseline.
 * @param overrides - Optional shallow record overrides for negative tests.
 * @param reviewOverrides - Optional shallow visual-review overrides for negative tests.
 * @returns Runtime artifacts and the parsed record used to write them.
 */
function rejectedAttempt(
    rule: string,
    context: TrustedValidationContext,
    overrides: Record<string, unknown> = {},
    reviewOverrides: Partial<CandidateVisualReview> = {},
): {
    artifacts: ArtifactRef[];
    record: Record<string, unknown>;
    review: CandidateVisualReview;
    validationArtifactId: string;
} {
    const dir = mkdtempSync(join(tmpdir(), 'rejected-validation-evidence-'));
    const candidateRuleHash = createHash('sha256').update(rule).digest('hex');
    const hash = candidateRuleHash.slice(0, 12);
    const validationArtifactId = `validation-${hash}`;
    const validationPath = join(dir, `factual-validation-${hash}.json`);
    const record: Record<string, unknown> = {
        trustedValidationContext: {
            reportedUrl: context.reportedUrl,
            baselineHash: context.baselineHash,
            existingRuleCount: context.existingRules.length,
        },
        phaseA: { url: context.reportedUrl, appliedRules: [] },
        phaseB: {
            url: context.reportedUrl,
            appliedRules: [...context.existingRules],
            antiAdblockDetected: false,
        },
        phaseC: {
            url: context.reportedUrl,
            appliedRules: [...context.existingRules, rule],
            antiAdblockDetected: false,
            sameDocumentControlScreenshotArtifactId: `${hash}-before`,
            screenshotArtifactId: `${hash}-after`,
            sameDocumentControlFullPageScreenshotArtifactId: `${hash}-before-full-page`,
            fullPageScreenshotArtifactId: `${hash}-after-full-page`,
            sameDocumentControlViewport: { x: 0, y: 120 },
            candidateViewport: { x: 0, y: 120 },
        },
        adElementStatus: {
            selector: '.ad-slot',
            phaseB: 'visible',
            phaseC: 'hidden',
        },
        structuralValidation: {
            status: 'regressed',
            strictContentIntact: false,
            regressionReasons: ['content_occlusion_introduced'],
        },
        contentIntact: false,
        ...overrides,
    };
    writeFileSync(validationPath, JSON.stringify(record));
    const beforePath = join(dir, `${hash}-before.png`);
    const afterPath = join(dir, `${hash}-after.png`);
    const beforeFullPagePath = join(dir, `${hash}-before-full-page.png`);
    const afterFullPagePath = join(dir, `${hash}-after-full-page.png`);
    writeFileSync(beforePath, 'before');
    writeFileSync(afterPath, 'after');
    writeFileSync(beforeFullPagePath, 'before full page');
    writeFileSync(afterFullPagePath, 'after full page');
    const review: CandidateVisualReview = {
        verdict: 'rejected',
        symptom: 'not_resolved',
        symptomScope: 'The complete reporter-defined page defect.',
        adLayoutResidue: 'absent',
        coverageComplete: true,
        beforeInstances: [
            {
                artifactId: `${hash}-before`,
                landmark: 'Reported target area.',
                description: 'The reported defect is visible before the candidate.',
            },
        ],
        remainingInstances: [
            {
                artifactId: `${hash}-after`,
                landmark: 'Reported target area.',
                description: 'The reported defect remains after the candidate.',
            },
        ],
        pageIntegrity: 'intact',
        validationArtifactId,
        candidateRuleHash,
        beforeViewportArtifactId: `${hash}-before`,
        afterViewportArtifactId: `${hash}-after`,
        beforeFullPageArtifactId: `${hash}-before-full-page`,
        afterFullPageArtifactId: `${hash}-after-full-page`,
        model: 'vision-model',
        rationale: 'The reported symptom remains visible.',
        observedDamage: [],
        ...reviewOverrides,
    };
    const reviewPath = join(dir, `candidate-visual-review-${hash}.json`);
    writeFileSync(reviewPath, JSON.stringify(review));
    return {
        validationArtifactId,
        record,
        review,
        artifacts: [
            {
                id: validationArtifactId,
                path: validationPath,
                type: 'application/json',
                bytes: 1,
            },
            { id: `${hash}-before`, path: beforePath, type: 'screenshot', bytes: 1 },
            { id: `${hash}-after`, path: afterPath, type: 'screenshot', bytes: 1 },
            {
                id: `${hash}-before-full-page`,
                path: beforeFullPagePath,
                type: 'screenshot-full-page',
                bytes: 1,
            },
            {
                id: `${hash}-after-full-page`,
                path: afterFullPagePath,
                type: 'screenshot-full-page',
                bytes: 1,
            },
            {
                id: `visual-review-${hash}`,
                path: reviewPath,
                type: 'candidate-visual-review',
                bytes: 1,
            },
        ],
    };
}

describe('selectRepresentativeRejectedCandidateScreenshots', () => {
    it('binds a preferred rejected candidate to its exact aligned viewport pair', () => {
        const context = trustedContext(['example.com##.existing']);
        const rule = 'example.com##.ad-slot';
        const attempt = rejectedAttempt(rule, context);

        expect(
            selectRepresentativeRejectedCandidateScreenshots(
                attempt.artifacts,
                context,
                attempt.validationArtifactId,
            ),
        ).toEqual({
            before: attempt.artifacts[1].path,
            after: attempt.artifacts[2].path,
            beforeFullPage: attempt.artifacts[3].path,
            afterFullPage: attempt.artifacts[4].path,
            validationArtifactId: attempt.validationArtifactId,
            candidateRule: rule,
            rejectionReasons: ['vision_rejected', 'The reported symptom remains visible.'],
            visualReview: attempt.review,
            visualReviewArtifactPath: attempt.artifacts[5].path,
        });
    });

    it.each([
        [
            'mismatched id hash',
            (artifact: ArtifactRef) => (artifact.id = 'validation-000000000000'),
        ],
        [
            'mismatched filename hash',
            (artifact: ArtifactRef) =>
                (artifact.path = join(artifact.path, '..', 'factual-validation-000000000000.json')),
        ],
        ['wrong media type', (artifact: ArtifactRef) => (artifact.type = 'text/plain')],
    ])('rejects runner artifact identity with a %s', (_name, mutate) => {
        const context = trustedContext();
        const attempt = rejectedAttempt('example.com##.ad-slot', context);
        mutate(attempt.artifacts[0]);

        expect(
            selectRepresentativeRejectedCandidateScreenshots(attempt.artifacts, context),
        ).toBeUndefined();
    });

    it.each([
        [
            'foreign recorded context',
            (record: Record<string, unknown>) => {
                record.trustedValidationContext = {
                    reportedUrl: 'https://foreign.example/article',
                    baselineHash: 'f'.repeat(64),
                    existingRuleCount: 0,
                };
            },
        ],
        [
            'foreign phase URL',
            (record: Record<string, unknown>) => {
                record.phaseB = {
                    url: 'https://foreign.example/article',
                    appliedRules: [],
                };
            },
        ],
        [
            'altered Phase A baseline',
            (record: Record<string, unknown>) => {
                record.phaseA = { url: 'https://example.com/article', appliedRules: ['foreign'] };
            },
        ],
        [
            'altered Phase B baseline',
            (record: Record<string, unknown>) => {
                record.phaseB = { url: 'https://example.com/article', appliedRules: ['foreign'] };
            },
        ],
        [
            'extra Phase C rule',
            (record: Record<string, unknown>) => {
                const phaseC = record.phaseC as Record<string, unknown>;
                phaseC.appliedRules = ['foreign', ...(phaseC.appliedRules as string[])];
            },
        ],
    ])('rejects evidence with %s', (_name, mutate) => {
        const context = trustedContext();
        const attempt = rejectedAttempt('example.com##.ad-slot', context);
        mutate(attempt.record);
        writeFileSync(attempt.artifacts[0].path, JSON.stringify(attempt.record));

        expect(
            selectRepresentativeRejectedCandidateScreenshots(attempt.artifacts, context),
        ).toBeUndefined();
    });

    it('rejects an unaligned or incomplete same-document screenshot pair', () => {
        const context = trustedContext();
        const rule = 'example.com##.ad-slot';
        const attempt = rejectedAttempt(rule, context);
        const phaseC = attempt.record.phaseC as Record<string, unknown>;
        phaseC.candidateViewport = { x: 0, y: 122 };
        writeFileSync(attempt.artifacts[0].path, JSON.stringify(attempt.record));

        expect(
            selectRepresentativeRejectedCandidateScreenshots(attempt.artifacts, context),
        ).toBeUndefined();

        phaseC.candidateViewport = { x: 0, y: 120 };
        phaseC.sameDocumentControlError = 'control failed';
        writeFileSync(attempt.artifacts[0].path, JSON.stringify(attempt.record));
        expect(
            selectRepresentativeRejectedCandidateScreenshots(attempt.artifacts, context),
        ).toBeUndefined();
    });

    it('excludes a candidate that the bound visual review verifies despite structural flags', () => {
        const context = trustedContext();
        const attempt = rejectedAttempt(
            'example.com##.ad-slot',
            context,
            {
                structuralValidation: {
                    status: 'regressed',
                    regressionReasons: ['meaningful_text_lost'],
                },
                contentIntact: false,
            },
            {
                verdict: 'verified',
                symptom: 'resolved',
                coverageComplete: true,
                remainingInstances: [],
                pageIntegrity: 'intact',
                rationale: 'The issue is gone and the page remains visually intact.',
            },
        );

        expect(
            selectRepresentativeRejectedCandidateScreenshots(attempt.artifacts, context),
        ).toBeUndefined();
    });

    it('uses only the bound visual verdict and bounded rationale as rejection reasons', () => {
        const context = trustedContext();
        const rationale = `Vision explanation: ${'x'.repeat(1_000)}`;
        const attempt = rejectedAttempt(
            'example.com##.ad-slot',
            context,
            {
                structuralValidation: {
                    status: 'regressed',
                    regressionReasons: ['content_occlusion_introduced', 'meaningful_text_lost'],
                },
                layoutValidation: {
                    resolution: {
                        status: 'unresolved',
                        reasons: ['required_additional_top_space'],
                    },
                },
            },
            { rationale },
        );

        const selected = selectRepresentativeRejectedCandidateScreenshots(
            attempt.artifacts,
            context,
        );

        expect(selected?.rejectionReasons).toEqual(['vision_rejected', rationale.slice(0, 200)]);
    });

    it('ignores deterministic content, structural, layout, and element-status fields', () => {
        const context = trustedContext();
        const attempt = rejectedAttempt('example.com##.ad-slot', context, {
            adElementStatus: {
                phaseB: 'visible',
                phaseC: 'hidden',
            },
            structuralValidation: {
                status: 'x'.repeat(1_000),
                regressionReasons: ['deterministic_reason_must_not_escape'],
            },
            layoutValidation: {
                resolution: {
                    status: 'resolved',
                    reasons: ['another_deterministic_reason'],
                },
            },
            contentIntact: true,
        });

        const selected = selectRepresentativeRejectedCandidateScreenshots(
            attempt.artifacts,
            context,
        );

        expect(selected?.rejectionReasons).toEqual([
            'vision_rejected',
            'The reported symptom remains visible.',
        ]);
    });

    it('requires a runner-bound visual review for rejected evidence', () => {
        const context = trustedContext();
        const attempt = rejectedAttempt('example.com##.ad-slot', context);
        const artifacts = attempt.artifacts.filter(
            (artifact) => artifact.type !== 'candidate-visual-review',
        );

        expect(
            selectRepresentativeRejectedCandidateScreenshots(artifacts, context),
        ).toBeUndefined();
    });

    it.each([
        [
            'candidate hash',
            (attempt: ReturnType<typeof rejectedAttempt>) => {
                attempt.review.candidateRuleHash = '0'.repeat(64);
            },
        ],
        [
            'validation artifact',
            (attempt: ReturnType<typeof rejectedAttempt>) => {
                attempt.review.validationArtifactId = 'validation-000000000000';
            },
        ],
        [
            'viewport evidence',
            (attempt: ReturnType<typeof rejectedAttempt>) => {
                attempt.review.afterViewportArtifactId = 'foreign-after';
            },
        ],
        [
            'full-page evidence',
            (attempt: ReturnType<typeof rejectedAttempt>) => {
                attempt.review.afterFullPageArtifactId = 'foreign-after-full-page';
            },
        ],
    ])('rejects a visual review with a mismatched %s binding', (_name, mutate) => {
        const context = trustedContext();
        const attempt = rejectedAttempt('example.com##.ad-slot', context);
        mutate(attempt);
        writeFileSync(attempt.artifacts[5].path, JSON.stringify(attempt.review));

        expect(
            selectRepresentativeRejectedCandidateScreenshots(attempt.artifacts, context),
        ).toBeUndefined();
    });

    it('fails closed for an invalid preferred artifact instead of substituting another', () => {
        const context = trustedContext();
        const valid = rejectedAttempt('example.com##.valid', context);
        const invalid = rejectedAttempt('example.com##.invalid', context);
        const invalidRecord = invalid.record;
        invalidRecord.phaseA = {
            url: 'https://foreign.example/article',
            appliedRules: [],
        };
        writeFileSync(invalid.artifacts[0].path, JSON.stringify(invalidRecord));

        expect(
            selectRepresentativeRejectedCandidateScreenshots(
                [...valid.artifacts, ...invalid.artifacts],
                context,
                invalid.validationArtifactId,
            ),
        ).toBeUndefined();
    });

    it('ranks rejected above inconclusive regardless of deterministic browser fields', () => {
        const context = trustedContext();
        const inconclusive = rejectedAttempt(
            'example.com##.inconclusive',
            context,
            {
                adElementStatus: {
                    selector: '.inconclusive',
                    phaseB: 'visible',
                    phaseC: 'hidden',
                },
                structuralValidation: {
                    status: 'intact',
                    strictContentIntact: true,
                    regressionReasons: [],
                },
            },
            {
                verdict: 'inconclusive',
                symptom: 'unclear',
                coverageComplete: false,
                beforeInstances: [],
                remainingInstances: [],
                pageIntegrity: 'unclear',
                rationale: 'The images are insufficient to decide.',
            },
        );
        const rejected = rejectedAttempt(
            'example.com##.rejected',
            context,
            {
                adElementStatus: {
                    selector: '.rejected',
                    phaseB: 'visible',
                    phaseC: 'visible',
                },
                structuralValidation: {
                    status: 'regressed',
                    strictContentIntact: false,
                    regressionReasons: ['heading_lost', 'meaningful_text_lost'],
                },
            },
            {
                rationale: 'The reported symptom is still visible.',
            },
        );

        const selected = selectRepresentativeRejectedCandidateScreenshots(
            [...inconclusive.artifacts, ...rejected.artifacts],
            context,
        );

        expect(selected?.validationArtifactId).toBe(rejected.validationArtifactId);
        expect(basename(selected?.after ?? '')).toContain('after');
    });
});
