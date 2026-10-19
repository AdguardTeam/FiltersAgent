import { describe, expect, it } from 'vitest';
import {
    BenchmarkCaseStatus,
    BenchmarkFailureKind,
    benchmarkFailureKind,
    classifyAgentOutcome,
} from '../../../lab/e2e/benchmark-outcome';
import { INTAKE_SKIPPED_PREFIX } from '../../../lab/local/local-failure-stage';
import { PROVIDER_REJECTION_PREFIX } from '../../../src/pi/single-shot';
import { EnvironmentProjectionRefusal } from '../../../src/types/environment-projection-refusal';
import { ExtensionMode, type FixRunResult } from '../../../src/types/fix-run-result';
import { InfrastructureFailureReason } from '../../../src/types/infrastructure-failure-reason';
import { ReporterSymptomPresence } from '../../../src/types/reporter-symptom-presence';
import { PhaseLabel } from '../../../src/types/validation';
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

function browserSession(extensionMode: ExtensionMode, symptomPresent: boolean) {
    return {
        extensionMode,
        navigationVerified: true,
        captures: [
            {
                visionVerified: true,
                coverageComplete: true,
                reporterSymptomPresence: symptomPresent
                    ? ReporterSymptomPresence.Present
                    : ReporterSymptomPresence.Absent,
            },
        ],
    };
}

/**
 * One apply_rule experiment as result assembly writes it: the A/B/C phases of the canonical
 * execution, and the browser sessions projected from them in place of the agent's own sessions.
 */
function withExperiment(symptomPresent: Record<PhaseLabel, boolean>): Partial<FixRunResult> {
    const labels = [PhaseLabel.A, PhaseLabel.B, PhaseLabel.C];
    return {
        environmentExecution: {
            phases: labels.map((phase) => ({
                phase,
                completion: {
                    kind: 'observed',
                    navigationVerified: true,
                    targetObservation: { symptomPresent: symptomPresent[phase], pageUsable: true },
                },
            })),
        },
        browserSessions: labels.map((phase) =>
            browserSession(
                phase === PhaseLabel.A ? ExtensionMode.None : ExtensionMode.Prepared,
                symptomPresent[phase],
            ),
        ),
    } as Partial<FixRunResult>;
}

describe('classifyAgentOutcome', () => {
    // Shapes as result assembly writes them: a candidate patch only on a verified patch_proposed
    // result, an unverified rule only as the candidate carried for review, and an indeterminate
    // symptom observation on every analysis-only result.
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
                candidateForReview: {
                    rule: candidate.rule,
                    unverifiedReason: 'The visual review found the banner still visible.',
                },
            }),
        ],
        [
            BenchmarkCaseStatus.NotReproduced,
            runResult({
                runStatus: 'not_reproduced',
                verificationStatus: 'verified',
                symptomObservation: 'not_reproduced',
                browserSessions: [
                    browserSession(ExtensionMode.Prepared, false),
                    browserSession(ExtensionMode.None, false),
                ],
            } as Partial<FixRunResult>),
        ],
    ])('reads %s from the agent result', (status, result) => {
        expect(classifyAgentOutcome(result)).toEqual({ status, failureKind: null, detail: null });
    });

    it('counts reproduction from the baseline phase of a rejected candidate', () => {
        // Every candidate was rejected, so the run ends analysis-only, yet the prepared blocker
        // showed the reported ads before any candidate applied.
        const result = runResult(withExperiment({ A: true, B: true, C: true }));

        expect(classifyAgentOutcome(result).status).toBe(BenchmarkCaseStatus.Reproduced);
    });

    it('counts reproduction from a prepared session when no candidate ran', () => {
        const result = runResult({
            browserSessions: [
                browserSession(ExtensionMode.None, true),
                browserSession(ExtensionMode.Prepared, true),
            ],
        } as Partial<FixRunResult>);

        expect(classifyAgentOutcome(result).status).toBe(BenchmarkCaseStatus.Reproduced);
    });

    it('does not count the symptom without the blocker or with the candidate applied', () => {
        // The unfiltered control shows the site serves the ads, and the candidate phase shows what
        // the candidate did: neither is the problem the reporter had with the blocker.
        const experiment = runResult(withExperiment({ A: true, B: false, C: true }));
        // A run that found the problem already fixed carries `reproduced` from the unfiltered
        // control, beside a prepared session where the ads are gone.
        const alreadyFixed = runResult({
            runStatus: 'already_fixed_current',
            verificationStatus: 'verified',
            symptomObservation: 'reproduced',
            browserSessions: [
                browserSession(ExtensionMode.None, true),
                browserSession(ExtensionMode.Prepared, false),
            ],
        } as Partial<FixRunResult>);

        expect(classifyAgentOutcome(experiment).status).toBe(BenchmarkCaseStatus.NotReproduced);
        expect(classifyAgentOutcome(alreadyFixed).status).toBe(BenchmarkCaseStatus.NotReproduced);
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

    it('fails a run whose environment evidence did not project with the refusal, not the reasoning', () => {
        // The agent's reasoning still describes the verified patch the refusal took away.
        const reasoning = 'The candidate hides the banner and the experiment verified it.';
        const outcome = classifyAgentOutcome(
            runResult({
                runStatus: 'failed',
                verificationStatus: 'unavailable',
                infrastructureFailureReason: InfrastructureFailureReason.EnvironmentUnavailable,
                environmentProjectionRefusal: EnvironmentProjectionRefusal.VerifiedWithoutExactAbc,
                reasoning,
            }),
        );

        expect(outcome.status).toBe(BenchmarkCaseStatus.InfrastructureFailure);
        expect(outcome.detail).toContain(EnvironmentProjectionRefusal.VerifiedWithoutExactAbc);
        expect(outcome.detail).not.toContain(reasoning);
    });

    it('keeps the reasoning of a run that failed for its own reason before a projection refusal', () => {
        // The lifecycle leaves a run it did not fail as it was, so the cause is the run's own.
        const reasoning = 'The reasoning provider stopped answering.';
        const outcome = classifyAgentOutcome(
            runResult({
                runStatus: 'failed',
                verificationStatus: 'unavailable',
                infrastructureFailureReason: InfrastructureFailureReason.LlmUnavailable,
                environmentProjectionRefusal: EnvironmentProjectionRefusal.NoProjectablePhases,
                reasoning,
            }),
        );

        expect(outcome.status).toBe(BenchmarkCaseStatus.InfrastructureFailure);
        expect(outcome.detail).toContain(reasoning);
        expect(outcome.detail).toContain(EnvironmentProjectionRefusal.NoProjectablePhases);
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
