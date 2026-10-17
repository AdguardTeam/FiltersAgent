import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    benchmarkFailureKind,
    BenchmarkFailureKind,
    benchmarkLevel,
    collectBenchmarkRecord,
    writeBenchmarkRecord,
    type CollectBenchmarkRecordInput,
} from '../../../lab/e2e/benchmark-record';
import { GoldenE2EStatus, type GoldenE2EResult } from '../../../lab/e2e/golden-comparator';
import { InfrastructureFailureReason } from '../../../src/types/infrastructure-failure-reason';
import { ReasoningEffort } from '../../../src/config/reasoning-effort';
import type { HumanFixCandidate } from '../../../lab/e2e/human-commit-oracle';
import type { FixRunResult } from '../../../src/types/fix-run-result';
import type { LocalRunRecord } from '../../../src/local/run-output';
import { createRunUsageCollector } from '../../../src/pi/usage-collector';
import { PROVIDER_REJECTION_PREFIX } from '../../../src/pi/single-shot';
import { testCoreConfig } from '../../config/test-core-config';
import { INTAKE_SKIPPED_PREFIX } from '../../../lab/local/local-failure-stage';

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

const human: HumanFixCandidate = {
    rule: 'example.com##.banner',
    syntaxKind: 'element_hiding',
    filePath: 'BaseFilter/sections/specific.txt',
    repositoryEdit: 'insert',
    sourceRule: 'example.com##.banner',
};

function runResult(overrides: Partial<FixRunResult> = {}): FixRunResult {
    return {
        domain: 'example.com',
        verificationStatus: 'partial',
        symptomObservation: 'indeterminate',
        candidatePatch: null,
        reasoning: '',
        artifactPaths: { trace: null },
        ...overrides,
    } as FixRunResult;
}

function classification(overrides: Partial<GoldenE2EResult> = {}): GoldenE2EResult {
    return {
        status: 'agent_regression',
        exitCode: 1,
        detail: 'Different candidate.',
        actualRule: null,
        expectedRule: null,
        humanFixCommit: null,
        humanFixFirstParent: null,
        humanCandidate: null,
        ...overrides,
    };
}

const candidate = {
    rule: 'example.com##.different-banner',
    syntaxKind: 'element_hiding',
    filePath: human.filePath,
} as NonNullable<FixRunResult['candidatePatch']>;

function input(): CollectBenchmarkRecordInput {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'benchmark-record-'));
    temporaryRoots.push(outputDirectory);
    const llm = testCoreConfig({
        llm: {
            model: 'example-agent-model',
            visionModel: undefined,
            reasoningEffort: ReasoningEffort.High,
            singleShotReasoningEffort: ReasoningEffort.Medium,
        },
    }).llm;
    return {
        caseName: 'sample',
        startedAt: 1_000,
        runReturnedAt: 5_000,
        evaluatedAt: 6_000,
        outputDirectory,
        record: { result: runResult() } as LocalRunRecord,
        result: classification(),
        run: {
            extensionBuild: {
                version: '1.2.3',
                releaseTag: 'v1.2.0',
                autobuildCommit: 'a'.repeat(40),
            },
            filtersBaseSha: 'b'.repeat(40),
        },
        series: {
            judgeConfig: testCoreConfig({
                llm: {
                    model: 'example-judge-model',
                    visionModel: undefined,
                    baseUrl: 'https://example.com/judge-private',
                    apiKey: 'fake-judge-private-key',
                    reasoningEffort: ReasoningEffort.Off,
                    singleShotReasoningEffort: ReasoningEffort.High,
                },
            }),
            judgeCacheRoot: null,
            refreshJudgeCache: false,
            runEnvironment: {
                agent: { commit: 'c'.repeat(40), dirty: true },
                browser: 'cloakbrowser 1.2.3, chromium 123.4',
            },
        },
        knowledgeBaseSha: 'd'.repeat(40),
        llm,
        judge: { verdict: 'not_checked', fromCache: false },
        oracle: {
            humanFixCommit: 'e'.repeat(40),
            issueCreatedAt: '2026-07-14T06:00:00Z',
            fixCommittedAt: '2026-07-14T09:00:00Z',
        },
    };
}

describe('benchmark record', () => {
    it('assigns levels 0 through 5 from the run result and the classification', () => {
        const fixtures: [Partial<GoldenE2EResult>, FixRunResult | null, number][] = [
            [{}, null, 0],
            [{}, runResult(), 0],
            [{}, runResult({ symptomObservation: 'reproduced' }), 1],
            [{}, runResult({ candidatePatch: candidate }), 2],
            [{}, runResult({ candidatePatch: candidate, verificationStatus: 'verified' }), 3],
            [{ humanCandidate: human }, runResult({ candidatePatch: candidate }), 4],
            [{ status: 'pass' }, runResult(), 5],
            [{ status: 'infrastructure_failure' }, runResult({ candidatePatch: candidate }), 0],
            [
                { humanCandidate: human },
                runResult({
                    candidatePatch: { ...candidate, filePath: 'OtherFilter/sections/specific.txt' },
                    verificationStatus: 'verified',
                }),
                3,
            ],
        ];
        for (const [result, run, level] of fixtures) {
            expect(benchmarkLevel(classification(result), run)).toBe(level);
        }
    });

    it('tells a provider rejection from a transient failure', () => {
        const failure = classification({ status: 'infrastructure_failure' });
        expect(
            benchmarkFailureKind(
                failure,
                runResult({
                    infrastructureFailureReason: 'llm_rejected',
                }),
            ),
        ).toBe('provider_rejected');
        const visual = runResult({
            candidateVisualReview: {
                rationale: `${PROVIDER_REJECTION_PREFIX} unsupported vision`,
            } as NonNullable<FixRunResult['candidateVisualReview']>,
        });
        expect(benchmarkFailureKind(failure, visual)).toBe('provider_rejected');
        expect(
            benchmarkFailureKind(
                {
                    ...failure,
                    detail: `${PROVIDER_REJECTION_PREFIX} judge request`,
                },
                runResult(),
            ),
        ).toBe('transient');
        expect(benchmarkFailureKind(failure, null)).toBe('transient');
        expect(benchmarkFailureKind(classification(), visual)).toBeNull();
    });

    it('counts intake rejection and skip as agent failures while retaining input outages', () => {
        const failure = classification({ status: 'infrastructure_failure' });
        const rejected = runResult({
            infrastructureFailureReason: 'input_unavailable',
            reasoning: `Report extraction ${PROVIDER_REJECTION_PREFIX} unsupported parameter (stop reason error)`,
        });
        const skipped = runResult({
            infrastructureFailureReason: 'input_unavailable',
            reasoning: `${INTAKE_SKIPPED_PREFIX} Issue #123: not a filter report`,
        });
        expect(benchmarkFailureKind(failure, rejected)).toBe('provider_rejected');
        expect(benchmarkFailureKind(failure, skipped)).toBe('intake_skipped');
        expect(benchmarkLevel(failure, skipped)).toBe(0);
        expect(
            benchmarkFailureKind(
                failure,
                runResult({
                    infrastructureFailureReason: 'input_unavailable',
                    reasoning: 'Repository instruction is forbidden for this run.',
                }),
            ),
        ).toBe('transient');
    });

    it.each([InfrastructureFailureReason.BrowserUnavailable, undefined])(
        'does not classify quoted provider errors outside intake as rejection: %s',
        (infrastructureFailureReason) => {
            const result = runResult({
                infrastructureFailureReason,
                reasoning: `The screenshot tool returned: ${PROVIDER_REJECTION_PREFIX} unsupported vision`,
            });
            expect(
                benchmarkFailureKind(
                    classification({ status: GoldenE2EStatus.InfrastructureFailure }),
                    result,
                ),
            ).toBe(BenchmarkFailureKind.Transient);
        },
    );

    it('keeps the judge base URL and key out of the record', () => {
        const data = input();
        const record = collectBenchmarkRecord(data);
        const evaluationDirectory = join(data.outputDirectory, 'evaluation');
        writeBenchmarkRecord(evaluationDirectory, record);
        const saved = readFileSync(join(evaluationDirectory, 'benchmark-record.json'), 'utf8');
        expect(saved).not.toContain(data.series.judgeConfig.llm.baseUrl);
        expect(saved).not.toContain(data.series.judgeConfig.llm.apiKey);
        expect(JSON.parse(saved)).toMatchObject({
            schemaVersion: 1,
            model: { loop: 'example-agent-model', vision: 'example-agent-model' },
            judge: {
                model: 'example-judge-model',
                visionModel: 'example-judge-model',
                reasoningEffort: ReasoningEffort.Off,
                singleShotReasoningEffort: ReasoningEffort.High,
            },
            agent: data.series.runEnvironment.agent,
            environment: { knowledgeBaseCommit: data.knowledgeBaseSha },
            timings: {
                preparationMs: null,
                agentMs: null,
                finalizeMs: null,
                evaluationMs: 1_000,
                totalMs: 5_000,
            },
            turns: null,
            usage: { tokens: null, requests: null, costUsd: null, costStatus: 'no_usage' },
            human: { elapsedMs: 10_800_000 },
        });
        expect(collectBenchmarkRecord({ ...data, oracle: null }).human).toBeNull();
    });

    it('measures the stages from the runner clock and the trace', () => {
        const data = input();
        data.record!.result.artifactPaths.trace = 'trace.json';
        writeFileSync(
            join(data.outputDirectory, 'trace.json'),
            JSON.stringify({
                startedAt: new Date(2_000).toISOString(),
                endedAt: new Date(4_000).toISOString(),
                events: [{ type: 'llm_response' }, { type: 'tool_call' }, { type: 'llm_response' }],
            }),
        );
        const collector = createRunUsageCollector({
            rates: {
                'example-agent-model': {
                    inputUsdPerMillionTokens: 2,
                    outputUsdPerMillionTokens: 4,
                },
            },
        });
        collector.addSession({
            completions: [
                {
                    model: 'example-agent-model',
                    reported: true,
                    input: 100,
                    output: 50,
                    cacheRead: 0,
                    cacheWrite: 0,
                    reasoningTokens: 10,
                },
            ],
            durationMs: 2_000,
        });
        writeFileSync(
            join(data.outputDirectory, 'llm-usage-summary.json'),
            JSON.stringify(collector.summary()),
        );
        const record = collectBenchmarkRecord(data);
        expect(record.timings).toEqual({
            preparationMs: 1_000,
            agentMs: 2_000,
            finalizeMs: 1_000,
            evaluationMs: 1_000,
            totalMs: 5_000,
        });
        expect(record.turns).toBe(2);
        expect(record.usage).toMatchObject({
            tokens: { input: 100, output: 50, reasoningTokens: 10 },
            requests: 1,
            costUsd: 0.0004,
            costStatus: 'priced',
        });
    });
});
