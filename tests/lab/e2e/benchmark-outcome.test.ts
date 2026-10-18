import { describe, expect, it } from 'vitest';
import {
    BenchmarkCaseStatus,
    BenchmarkFailureKind,
    benchmarkFailureKind,
    classifyAgentOutcome,
} from '../../../lab/e2e/benchmark-outcome';
import { INTAKE_SKIPPED_PREFIX } from '../../../lab/local/local-failure-stage';
import { PROVIDER_REJECTION_PREFIX } from '../../../src/pi/single-shot';
import type { FixRunResult } from '../../../src/types/fix-run-result';
import { InfrastructureFailureReason } from '../../../src/types/infrastructure-failure-reason';
import { VISUAL_REVIEW_UNAVAILABLE_PREFIX } from '../../../src/validator/candidate-visual-synthesis';

function runResult(overrides: Partial<FixRunResult> = {}): FixRunResult {
    return {
        domain: 'example.com',
        runStatus: 'analysis_only',
        verificationStatus: 'partial',
        symptomObservation: 'indeterminate',
        candidatePatch: null,
        reasoning: '',
        artifactPaths: { trace: null },
        ...overrides,
    } as FixRunResult;
}

const candidate = {
    rule: 'example.com##.banner',
    ruleType: 'cosmetic',
    filePath: 'BaseFilter/sections/specific.txt',
} as NonNullable<FixRunResult['candidatePatch']>;

describe('classifyAgentOutcome', () => {
    // Shapes as result assembly writes them: a candidate patch only on a verified patch_proposed
    // result, an unverified rule only as the candidate carried for review.
    it.each([
        [
            BenchmarkCaseStatus.Verified,
            runResult({
                runStatus: 'patch_proposed',
                candidatePatch: candidate,
                verificationStatus: 'verified',
                symptomObservation: 'reproduced',
            }),
        ],
        [
            BenchmarkCaseStatus.Proposed,
            runResult({
                symptomObservation: 'reproduced',
                candidateForReview: {
                    rule: candidate.rule,
                    unverifiedReason: 'The visual review found the banner still visible.',
                },
            }),
        ],
        [BenchmarkCaseStatus.Reproduced, runResult({ symptomObservation: 'reproduced' })],
        [BenchmarkCaseStatus.NotReproduced, runResult({ symptomObservation: 'not_reproduced' })],
        [BenchmarkCaseStatus.NotReproduced, runResult({ verificationStatus: 'verified' })],
    ])('reads %s from the agent result', (status, result) => {
        expect(classifyAgentOutcome(result)).toEqual({ status, failureKind: null, detail: null });
    });

    it('fails a run whose visual review could not run, naming what the provider did', () => {
        const rationale = `${VISUAL_REVIEW_UNAVAILABLE_PREFIX} the vision provider timed out.`;
        expect(
            classifyAgentOutcome(
                runResult({
                    candidateForReview: { rule: candidate.rule, unverifiedReason: rationale },
                    candidateVisualReview: {
                        verdict: 'inconclusive',
                        rationale,
                    } as NonNullable<FixRunResult['candidateVisualReview']>,
                }),
            ),
        ).toEqual({
            status: BenchmarkCaseStatus.InfrastructureFailure,
            failureKind: BenchmarkFailureKind.Transient,
            detail: rationale,
        });
    });

    it('fails a run the browser could not serve with the run reasoning', () => {
        expect(
            classifyAgentOutcome(
                runResult({
                    infrastructureFailureReason: InfrastructureFailureReason.BrowserUnavailable,
                    reasoning: 'Every live navigation timed out.',
                }),
            ),
        ).toMatchObject({
            status: BenchmarkCaseStatus.InfrastructureFailure,
            detail: 'Every live navigation timed out.',
        });
    });
});

describe('benchmarkFailureKind', () => {
    it('tells a provider rejection from a transient failure', () => {
        expect(
            benchmarkFailureKind(
                runResult({ infrastructureFailureReason: InfrastructureFailureReason.LlmRejected }),
            ),
        ).toBe(BenchmarkFailureKind.ProviderRejected);
        expect(
            benchmarkFailureKind(
                runResult({
                    candidateVisualReview: {
                        rationale: `${PROVIDER_REJECTION_PREFIX} unsupported vision`,
                    } as NonNullable<FixRunResult['candidateVisualReview']>,
                }),
            ),
        ).toBe(BenchmarkFailureKind.ProviderRejected);
        expect(benchmarkFailureKind(null)).toBe(BenchmarkFailureKind.Transient);
    });

    it('counts intake rejection and skip as agent failures while retaining input outages', () => {
        const inputUnavailable = (reasoning: string) =>
            runResult({
                infrastructureFailureReason: InfrastructureFailureReason.InputUnavailable,
                reasoning,
            });
        expect(
            benchmarkFailureKind(
                inputUnavailable(`Report extraction ${PROVIDER_REJECTION_PREFIX} unsupported`),
            ),
        ).toBe(BenchmarkFailureKind.ProviderRejected);
        expect(
            benchmarkFailureKind(inputUnavailable(`${INTAKE_SKIPPED_PREFIX} Issue #123: no URL`)),
        ).toBe(BenchmarkFailureKind.IntakeSkipped);
        expect(
            benchmarkFailureKind(
                inputUnavailable('Repository instruction is forbidden for this run.'),
            ),
        ).toBe(BenchmarkFailureKind.Transient);
    });

    it.each([InfrastructureFailureReason.BrowserUnavailable, undefined])(
        'does not classify quoted provider errors outside intake as rejection: %s',
        (infrastructureFailureReason) => {
            expect(
                benchmarkFailureKind(
                    runResult({
                        infrastructureFailureReason,
                        reasoning: `The screenshot tool returned: ${PROVIDER_REJECTION_PREFIX} unsupported vision`,
                    }),
                ),
            ).toBe(BenchmarkFailureKind.Transient);
        },
    );
});
