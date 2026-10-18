import { describe, expect, it } from 'vitest';
import { applyRuleResultForModel } from '../../src/orchestrator/apply-rule-model-result';
import { CandidateRefusalKind } from '../../src/orchestrator/candidate-refusals';
import { MAX_TOOL_RESULT_BYTES } from '../../src/pi/tool-result-envelope';

const REVIEW = { verdict: 'rejected', symptom: 'not_resolved', pageIntegrity: 'regressed' };

const bulk = (size: number): string => 'x'.repeat(size);

describe('applyRuleResultForModel', () => {
    it('keeps the verdict readable when the experiment record outgrows the tool-result limit', () => {
        // A long page: the phases and the structure facts alone exceed the limit, and the generic
        // envelope would hand the model the first kilobytes of them - never the review.
        const result = {
            phaseA: { url: 'https://example.com/', detail: bulk(4_000) },
            phaseB: { url: 'https://example.com/', detail: bulk(20_000) },
            phaseC: { url: 'https://example.com/', detail: bulk(20_000) },
            structureFacts: { detail: bulk(40_000) },
            summary: 'The candidate hid the target and part of the page.',
            validationArtifactId: 'validation-0123456789ab-execution-0123456789abcdef',
            visualReview: REVIEW,
            visualReviewArtifactId: 'visual-review-0123456789ab',
        };

        const projected = applyRuleResultForModel(result);
        const serialized = JSON.stringify(projected);

        expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
        // The decision leads the object, so even a reader of its head meets the verdict.
        expect(Object.keys(projected)[0]).toBe('visualReview');
        expect(projected.visualReview).toEqual(REVIEW);
        expect(projected.omittedEvidence).toMatchObject({ keys: ['structureFacts'] });
        expect((projected.omittedEvidence as { note: string }).note).toContain(
            'get_detail("validation-0123456789ab-execution-0123456789abcdef")',
        );
    });

    it('passes a result that fits through with nothing left out', () => {
        const result = {
            phaseB: { url: 'https://example.com/' },
            visualReview: REVIEW,
            validationArtifactId: 'validation-0123456789ab',
        };

        expect(applyRuleResultForModel(result)).toEqual(result);
    });

    it('leaves a refusal as it is', () => {
        // A refusal the environment gave after the candidate ledger: an earlier refusal never
        // reaches the projection.
        const refusal = {
            validationSkipped: true,
            error: 'This environment cannot edit a published line.',
            errorKind: CandidateRefusalKind.OperationUnsupported,
            retryable: false,
        };

        expect(applyRuleResultForModel(refusal)).toEqual(refusal);
    });
});
