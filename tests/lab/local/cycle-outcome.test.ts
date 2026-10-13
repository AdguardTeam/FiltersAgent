import { describe, expect, it } from 'vitest';
import type { FixRunResult } from '../../../src/types/fix-run-result';
import {
    LocalExecutionInfrastructureError,
    classifyLocalExecutionError,
    deriveLocalCycleOutcome,
} from '../../../lab/local/cycle-outcome';

function result(
    runStatus: FixRunResult['runStatus'],
    infrastructureFailureReason?: FixRunResult['infrastructureFailureReason'],
    rejectedCandidate = false,
): FixRunResult {
    return {
        issueNumber: 4,
        domain: 'example.test',
        runStatus,
        requestedBrowserMode: 'auto',
        effectiveMode: 'browser',
        verificationStatus: 'unavailable',
        fallbackReason: null,
        fallbackDetail: null,
        ...(infrastructureFailureReason ? { infrastructureFailureReason } : {}),
        candidatePatch: null,
        ...(rejectedCandidate
            ? {
                  artifactPaths: {
                      screenshots: [],
                      domSnapshot: null,
                      har: null,
                      trace: null,
                      rejectedCandidateScreenshots: {
                          before: 'before.png',
                          after: 'after.png',
                          beforeFullPage: 'before-full.png',
                          afterFullPage: 'after-full.png',
                          visualReviewArtifactPath: 'review.json',
                          visualReview: {
                              verdict: 'rejected' as const,
                              summary: 'Candidate did not fix the symptom.',
                              validationArtifactId: 'validation-123456789abc',
                              candidateRuleHash: '1'.repeat(64),
                              beforeViewportArtifactId: 'before',
                              afterViewportArtifactId: 'after',
                              beforeFullPageArtifactId: 'before-full',
                              afterFullPageArtifactId: 'after-full',
                              rejectionReasons: ['symptom_persists' as const],
                          },
                          rejectionReasons: ['symptom_persists' as const],
                      },
                  },
              }
            : {
                  artifactPaths: {
                      screenshots: [],
                      domSnapshot: null,
                      har: null,
                      trace: null,
                  },
              }),
        reasoning: 'fixture',
        repository: null,
        baseSha: null,
    } as unknown as FixRunResult;
}

describe('local cycle outcome', () => {
    it.each([
        ['already_fixed_current', 'verified'],
        ['fixed_upstream_pending_extension', 'verified'],
        ['fixed_in_source_pending_publication', 'verified'],
        ['patch_proposed', 'verified'],
        ['not_reproduced', 'rejected'],
        ['configuration_specific', 'rejected'],
        ['analysis_only', 'inconclusive'],
        ['unsupported_product_case', 'unsupported'],
        ['capability_limited', 'unsupported'],
        ['target_url_unavailable', 'inaccessible'],
        ['cleanup_failed', 'cleanup_failed'],
    ] as const)('maps product run status %s to %s', (runStatus, category) => {
        expect(deriveLocalCycleOutcome(result(runStatus))).toEqual({ kind: 'product', category });
    });

    it('maps analysis_only with bound rejected evidence to rejected', () => {
        expect(deriveLocalCycleOutcome(result('analysis_only', undefined, true))).toEqual({
            kind: 'product',
            category: 'rejected',
        });
    });

    it.each([
        ['input_unavailable', 'investigation_input'],
        ['environment_unavailable', 'environment'],
        ['browser_unavailable', 'browser'],
        ['llm_unavailable', 'provider'],
        ['vision_provider_unavailable', 'provider'],
        ['output_unavailable', 'investigation_output'],
    ] as const)('gives typed infrastructure %s precedence over status', (reason, category) => {
        expect(deriveLocalCycleOutcome(result('patch_proposed', reason))).toEqual({
            kind: 'infrastructure',
            category,
        });
    });

    it.each([
        ['browser_unavailable', 'browser'],
        ['failed', 'runtime'],
    ] as const)('fails status %s to infrastructure %s', (runStatus, category) => {
        expect(deriveLocalCycleOutcome(result(runStatus))).toEqual({
            kind: 'infrastructure',
            category,
        });
    });

    it('distinguishes typed provider exceptions from generic handler failures', () => {
        expect(
            classifyLocalExecutionError(
                new LocalExecutionInfrastructureError('provider', 'provider unavailable'),
            ),
        ).toEqual({ kind: 'infrastructure', category: 'provider' });
        expect(classifyLocalExecutionError(new Error('generic failure'))).toEqual({
            kind: 'infrastructure',
            category: 'runtime',
        });
    });
});
