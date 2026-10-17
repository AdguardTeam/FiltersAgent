import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LlmConfig } from '../../src/config/config';
import type { LocalRunRecord } from '../../src/local/run-output';
import { LLM_USAGE_SUMMARY_FILE_NAME } from '../../src/local/run-manifest';
import { PROVIDER_REJECTION_PREFIX } from '../../src/pi/single-shot';
import { InfrastructureFailureReason } from '../../src/types/infrastructure-failure-reason';
import {
    SymptomObservation,
    VerificationStatus,
    type FixRunResult,
} from '../../src/types/fix-run-result';
import { TraceEventType, type RunTrace } from '../../src/types/trace';
import { readRunUsageSummary, type TokenTotals } from '../../src/types/usage-summary';
import { writeAtomicJson } from '../atomic-json';
import { effectiveVisionModel } from '../effective-vision-model';
import { INTAKE_SKIPPED_PREFIX } from '../local/local-failure-stage';
import { readRunCost, type RunCostStatus } from '../pricing/run-cost';
import { GoldenE2EStatus, type GoldenE2EResult } from './golden-comparator';
import { matchesHumanRuleScope } from './golden-candidate-comparison';
import { type GoldenE2ERun, type GoldenHumanOracle } from './golden-case';
import { HumanFixVerdict } from './golden-judge';
import type { GoldenSeries } from './golden-runner';

export const BENCHMARK_RECORD_FILE_NAME = 'benchmark-record.json';
export const BENCHMARK_RECORD_SCHEMA_VERSION = 1;
export const BenchmarkLevel = {
    Failed: 0,
    Reproduced: 1,
    Proposed: 2,
    SelfVerified: 3,
    MatchesHumanScope: 4,
    Pass: 5,
} as const;
/**
 * Highest observable milestone achieved by one benchmark run.
 */
export type BenchmarkLevel = (typeof BenchmarkLevel)[keyof typeof BenchmarkLevel];
export const BenchmarkFailureKind = {
    ProviderRejected: 'provider_rejected',
    /**
     * The agent's intake declined a golden issue as outside its task.
     */
    IntakeSkipped: 'intake_skipped',
    Transient: 'transient',
} as const;
/**
 * Whether a failed run is an agent rejection, intake skip, or retryable outage.
 */
export type BenchmarkFailureKind = (typeof BenchmarkFailureKind)[keyof typeof BenchmarkFailureKind];
/**
 * Source and browser provenance captured once for an ordinary model-run series.
 */
export interface BenchmarkRunEnvironment {
    /**
     * FiltersAgent revision and local-change state.
     */
    agent: {
        /**
         * FiltersAgent source commit.
         */
        commit: string;
        /**
         * Whether uncommitted changes affect the source checkout.
         */
        dirty: boolean;
    };
    /**
     * CloakBrowser package and Chromium binary versions.
     */
    browser: string;
}

/**
 * Self-contained comparison record written after independent case evaluation.
 */
export interface BenchmarkRecord {
    /**
     * Persisted document version.
     */
    schemaVersion: typeof BENCHMARK_RECORD_SCHEMA_VERSION;
    /**
     * Stable golden case name.
     */
    case: string;
    /**
     * ISO timestamp at the beginning of the case lifecycle.
     */
    startedAt: string;
    /**
     * Source revision executing the benchmark.
     */
    agent: BenchmarkRunEnvironment['agent'];
    /**
     * Agent provider configuration excluding credentials and endpoint.
     */
    model: {
        /**
         * Provider protocol.
         */
        api: LlmConfig['api'];
        /**
         * Agent loop model.
         */
        loop: string;
        /**
         * Effective agent vision model.
         */
        vision: string;
        /**
         * Agent-loop reasoning setting.
         */
        reasoningEffort: LlmConfig['reasoningEffort'];
        /**
         * Single-shot reasoning setting.
         */
        singleShotReasoningEffort: LlmConfig['singleShotReasoningEffort'];
    };
    /**
     * Independent judge identity without endpoint or credentials.
     */
    judge: {
        /**
         * Judge provider protocol.
         */
        api: LlmConfig['api'];
        /**
         * Judge text model.
         */
        model: string;
        /**
         * Effective judge vision model.
         */
        visionModel: string;
        /**
         * Judge loop reasoning setting, including whether reasoning is disabled.
         */
        reasoningEffort: LlmConfig['reasoningEffort'];
        /**
         * Judge extraction and visual-review reasoning setting.
         */
        singleShotReasoningEffort: LlmConfig['singleShotReasoningEffort'];
    };
    /**
     * Immutable runtime environment pins.
     */
    environment: {
        /**
         * Historical extension build selected by the case.
         */
        extensionBuild: GoldenE2ERun['extensionBuild'] | null;
        /**
         * Browser package and binary versions.
         */
        browser: string;
        /**
         * Shared KnowledgeBase commit supplied to the agent.
         */
        knowledgeBaseCommit: string;
        /**
         * Filters checkout before the human fix.
         */
        filtersBaseSha: string | null;
    };
    /**
     * Wall-clock stages; unavailable trace stages remain null.
     */
    timings: {
        /**
         * Case start to agent trace start.
         */
        preparationMs: number | null;
        /**
         * Agent trace start to trace end.
         */
        agentMs: number | null;
        /**
         * Trace end to local runner return.
         */
        finalizeMs: number | null;
        /**
         * Local runner return to completed independent evaluation.
         */
        evaluationMs: number;
        /**
         * Complete case duration including preparation and evaluation.
         */
        totalMs: number;
    };
    /**
     * Agent LLM responses in the trace, or null without a trace.
     */
    turns: number | null;
    /**
     * Agent-only usage and cost read from the locked usage summary.
     */
    usage: {
        /**
         * Aggregated provider-reported tokens, or null when unavailable.
         */
        tokens: TokenTotals | null;
        /**
         * Logical usage requests, or null when unavailable.
         */
        requests: number | null;
        /**
         * Priced dollars, or null without priceable usage.
         */
        costUsd: number | null;
        /**
         * Completeness of the recorded cost.
         */
        costStatus: RunCostStatus;
    };
    /**
     * Independent classification and partial-credit outcome.
     */
    outcome: {
        /**
         * Golden comparison classification.
         */
        status: GoldenE2EStatus;
        /**
         * Infrastructure failure classification, otherwise null.
         */
        failureKind: BenchmarkFailureKind | null;
        /**
         * Highest achieved benchmark level.
         */
        level: BenchmarkLevel;
        /**
         * Independent human-rule validation state.
         */
        humanFixVerdict: HumanFixVerdict;
        /**
         * Whether the human-rule verdict came from the shared cache.
         */
        verdictFromCache: boolean;
    };
    /**
     * Human issue-to-fix timing from the closed oracle, or null when not supplied.
     */
    human: {
        /**
         * Issue creation timestamp.
         */
        issueCreatedAt: string;
        /**
         * Human fix committer timestamp.
         */
        fixCommittedAt: string;
        /**
         * Issue creation to human fix duration.
         */
        elapsedMs: number;
    } | null;
}

/**
 * Post-evaluation sources needed to assemble a comparison record.
 */
export interface CollectBenchmarkRecordInput {
    /**
     * Golden case identity.
     */
    caseName: string;
    /**
     * Wall-clock case start in milliseconds.
     */
    startedAt: number;
    /**
     * Wall-clock local runner return or failure in milliseconds.
     */
    runReturnedAt: number;
    /**
     * Wall-clock evaluation completion in milliseconds.
     */
    evaluatedAt: number;
    /**
     * Agent artifact directory.
     */
    outputDirectory: string;
    /**
     * Validated sealed agent output, or null when the run could not be read.
     */
    record: LocalRunRecord | null;
    /**
     * Independent golden classification.
     */
    result: GoldenE2EResult;
    /**
     * Loaded run-side pins, or null when case loading failed.
     */
    run: Pick<GoldenE2ERun, 'extensionBuild' | 'filtersBaseSha'> | null;
    /**
     * Shared judge and runtime provenance.
     */
    series: GoldenSeries;
    /**
     * KnowledgeBase commit passed to the agent.
     */
    knowledgeBaseSha: string;
    /**
     * Agent LLM configuration.
     */
    llm: LlmConfig;
    /**
     * Independent judge outcome and cache provenance.
     */
    judge: {
        /**
         * Human fix validation outcome.
         */
        verdict: HumanFixVerdict;
        /**
         * Whether the verdict was reused.
         */
        fromCache: boolean;
    };
    /**
     * Closed human oracle loaded only after the agent seals.
     */
    oracle: GoldenHumanOracle | null;
}

/**
 * Assign the highest achieved milestone without crediting infrastructure failures.
 *
 * @param result - Final independent golden classification.
 * @param runResult - Sealed agent result when available.
 * @returns Highest observed level.
 */
export function benchmarkLevel(
    result: GoldenE2EResult,
    runResult: FixRunResult | null,
): BenchmarkLevel {
    if (result.status === GoldenE2EStatus.InfrastructureFailure || !runResult) {
        return BenchmarkLevel.Failed;
    }
    if (result.status === GoldenE2EStatus.Pass) {
        return BenchmarkLevel.Pass;
    }
    if (result.humanCandidate && matchesHumanRuleScope(runResult, result.humanCandidate)) {
        return BenchmarkLevel.MatchesHumanScope;
    }
    if (runResult.verificationStatus === VerificationStatus.Verified) {
        return BenchmarkLevel.SelfVerified;
    }
    if (runResult.candidatePatch) {
        return BenchmarkLevel.Proposed;
    }
    return runResult.symptomObservation === SymptomObservation.Reproduced
        ? BenchmarkLevel.Reproduced
        : BenchmarkLevel.Failed;
}

/**
 * Distinguish agent provider rejections and intake skips from retryable failures.
 *
 * @param result - Final golden classification, including judge failures.
 * @param runResult - Agent-only evidence used to identify deterministic rejection.
 * @returns Agent rejection, intake skip, transient failure, or null for other results.
 */
export function benchmarkFailureKind(
    result: GoldenE2EResult,
    runResult: FixRunResult | null,
): BenchmarkFailureKind | null {
    if (result.status !== GoldenE2EStatus.InfrastructureFailure) {
        return null;
    }
    if (
        runResult?.infrastructureFailureReason === InfrastructureFailureReason.LlmRejected ||
        (runResult?.infrastructureFailureReason === InfrastructureFailureReason.InputUnavailable &&
            runResult.reasoning.includes(PROVIDER_REJECTION_PREFIX)) ||
        runResult?.candidateVisualReview?.rationale.includes(PROVIDER_REJECTION_PREFIX)
    ) {
        return BenchmarkFailureKind.ProviderRejected;
    }
    if (
        runResult?.infrastructureFailureReason === InfrastructureFailureReason.InputUnavailable &&
        runResult.reasoning.includes(INTAKE_SKIPPED_PREFIX)
    ) {
        return BenchmarkFailureKind.IntakeSkipped;
    }
    return BenchmarkFailureKind.Transient;
}

/**
 * Assemble a record from trusted agent artifacts and the independent judgement.
 *
 * @param input - Completed lifecycle sources and timestamps.
 * @returns Self-contained comparison record without credentials or provider endpoints.
 */
export function collectBenchmarkRecord(input: CollectBenchmarkRecordInput): BenchmarkRecord {
    const { record, outputDirectory, llm, series, oracle } = input;
    const tracePath = record?.result.artifactPaths.trace;
    const trace =
        tracePath && existsSync(resolve(outputDirectory, tracePath))
            ? (JSON.parse(readFileSync(resolve(outputDirectory, tracePath), 'utf8')) as RunTrace)
            : null;
    const summaryPath = join(outputDirectory, LLM_USAGE_SUMMARY_FILE_NAME);
    const usage = existsSync(summaryPath)
        ? readRunUsageSummary(JSON.parse(readFileSync(summaryPath, 'utf8')))
        : null;
    const cost = readRunCost(outputDirectory);
    const traceStartedAt = trace ? Date.parse(trace.startedAt) : null;
    const traceEndedAt = trace?.endedAt ? Date.parse(trace.endedAt) : null;
    return {
        schemaVersion: BENCHMARK_RECORD_SCHEMA_VERSION,
        case: input.caseName,
        startedAt: new Date(input.startedAt).toISOString(),
        agent: series.runEnvironment.agent,
        model: {
            api: llm.api,
            loop: llm.model,
            vision: effectiveVisionModel(llm),
            reasoningEffort: llm.reasoningEffort,
            singleShotReasoningEffort: llm.singleShotReasoningEffort,
        },
        judge: {
            api: series.judgeConfig.llm.api,
            model: series.judgeConfig.llm.model,
            visionModel: effectiveVisionModel(series.judgeConfig.llm),
            reasoningEffort: series.judgeConfig.llm.reasoningEffort,
            singleShotReasoningEffort: series.judgeConfig.llm.singleShotReasoningEffort,
        },
        environment: {
            extensionBuild: input.run?.extensionBuild ?? null,
            browser: series.runEnvironment.browser,
            knowledgeBaseCommit: input.knowledgeBaseSha,
            filtersBaseSha: input.run?.filtersBaseSha ?? null,
        },
        timings: {
            preparationMs: traceStartedAt === null ? null : traceStartedAt - input.startedAt,
            agentMs:
                traceStartedAt === null || traceEndedAt === null
                    ? null
                    : traceEndedAt - traceStartedAt,
            finalizeMs: traceEndedAt === null ? null : input.runReturnedAt - traceEndedAt,
            evaluationMs: input.evaluatedAt - input.runReturnedAt,
            totalMs: input.evaluatedAt - input.startedAt,
        },
        turns: trace
            ? trace.events.filter((event) => event.type === TraceEventType.LlmResponse).length
            : null,
        usage: {
            tokens: usage?.tokens ?? null,
            requests: usage?.requests ?? null,
            costUsd: cost.usd,
            costStatus: cost.status,
        },
        outcome: {
            status: input.result.status,
            failureKind: benchmarkFailureKind(input.result, record?.result ?? null),
            level: benchmarkLevel(input.result, record?.result ?? null),
            humanFixVerdict: input.judge.verdict,
            verdictFromCache: input.judge.fromCache,
        },
        human: oracle
            ? {
                  issueCreatedAt: oracle.issueCreatedAt,
                  fixCommittedAt: oracle.fixCommittedAt,
                  elapsedMs: Date.parse(oracle.fixCommittedAt) - Date.parse(oracle.issueCreatedAt),
              }
            : null,
    };
}

/**
 * Atomically persist the final comparison record beside the independent golden result.
 *
 * @param evaluationDirectory - Evaluator-owned output directory.
 * @param record - Completed self-contained benchmark record.
 * @returns Nothing after the final artifact replaces its temporary file.
 */
export function writeBenchmarkRecord(evaluationDirectory: string, record: BenchmarkRecord): void {
    writeAtomicJson(join(evaluationDirectory, BENCHMARK_RECORD_FILE_NAME), record);
}
