import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LlmConfig } from '../../src/config/config';
import type { LocalRunRecord } from '../../src/local/run-output';
import { LLM_USAGE_SUMMARY_FILE_NAME } from '../../src/local/run-manifest';
import type { CandidateForReview } from '../../src/types/candidate-for-review';
import type { CandidatePatch } from '../../src/types/fix-run-result';
import { TraceEventType, type RunTrace } from '../../src/types/trace';
import { readRunUsageSummary, type TokenTotals } from '../../src/types/usage-summary';
import { writeAtomicJson } from '../atomic-json';
import { effectiveVisionModel } from '../effective-vision-model';
import { readRunCost, type RunCostStatus } from '../pricing/run-cost';
import type { AgentOutcome } from './benchmark-outcome';
import type { SiteReachability } from './case-site';
import type { GoldenAgentEnvironmentAssessment } from './golden-agent-environment';
import { type GoldenE2ERun, type GoldenHumanOracle } from './golden-case';
import type { ExtractedHumanFix, HumanFixCandidate, HumanRemovedRule } from './human-commit-oracle';

export const BENCHMARK_RECORD_FILE_NAME = 'benchmark-record.json';
export const BENCHMARK_RECORD_SCHEMA_VERSION = 2;
/**
 * The page a case's site check requested, and what came back.
 */
export interface CheckedSite extends SiteReachability {
    /**
     * Reported page from the case's pinned report.
     */
    url: string;
}

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
 * Self-contained record of one benchmark case: who ran it, in which environment, what it cost, what
 * the agent reached, and the human fix beside it.
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
         * Case start to the end of the site check.
         */
        siteCheckMs: number;
        /**
         * Site check end to agent trace start.
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
         * Local runner return to the written record: environment comparison and human fix read.
         */
        evaluationMs: number;
        /**
         * Complete case duration including the site check, preparation and evaluation.
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
     * The site check before the run: the page, whether a host answered, and what came back; null
     * when the case failed before the check.
     */
    site: CheckedSite | null;
    /**
     * The agent's own outcome and the environment it ran in.
     */
    outcome: AgentOutcome & {
        /**
         * Whether the agent's verified session used the reporter's extension build, filters and
         * Stealth state; null when no sealed run was read.
         */
        reporterEnvironment: GoldenAgentEnvironmentAssessment | null;
        /**
         * The verified rule the agent proposed, as it proposed it; null without one.
         */
        candidate: CandidatePatch | null;
        /**
         * The rule the agent found but could not verify, with the reason; null without one.
         */
        candidateForReview: CandidateForReview | null;
    };
    /**
     * The human fix as committed, recorded beside the agent's rule for the comparison after a
     * series; the benchmark trusts it and never checks it in a browser.
     */
    human: {
        /**
         * Human fix commit from the closed oracle.
         */
        fixCommit: string;
        /**
         * First parent the rules were read against, or null when the commit could not be read.
         */
        firstParent: string | null;
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
        /**
         * Rule additions of the commit's first-parent diff, or null when it could not be read.
         */
        rules: HumanFixCandidate[] | null;
        /**
         * Rule removals of the diff without a replacement, or null when it could not be read.
         */
        removedRules: HumanRemovedRule[] | null;
        /**
         * Why the commit could not be read; null when it was.
         */
        rulesError: string | null;
    };
}

/**
 * The human fix's rules as the benchmark record keeps them.
 */
type BenchmarkHumanRules = Pick<
    BenchmarkRecord['human'],
    'firstParent' | 'rules' | 'removedRules' | 'rulesError'
>;

/**
 * Post-run sources needed to assemble a benchmark record.
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
     * Wall-clock end of the site check in milliseconds; the case start when no check ran.
     */
    siteCheckedAt: number;
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
     * Validated sealed agent output, or null when the agent did not run or its run was unreadable.
     */
    record: LocalRunRecord | null;
    /**
     * Case outcome: the agent's own, an infrastructure failure, or an unreachable site.
     */
    outcome: AgentOutcome;
    /**
     * Comparison of the agent's environment with the reporter's, or null without a run.
     */
    reporterEnvironment: GoldenAgentEnvironmentAssessment | null;
    /**
     * Site check before the run, or null when the case failed before it.
     */
    site: CheckedSite | null;
    /**
     * Loaded run-side pins, or null when case loading failed.
     */
    run: Pick<GoldenE2ERun, 'extensionBuild' | 'filtersBaseSha'> | null;
    /**
     * Source and browser provenance of the series.
     */
    runEnvironment: BenchmarkRunEnvironment;
    /**
     * KnowledgeBase commit passed to the agent.
     */
    knowledgeBaseSha: string;
    /**
     * Agent LLM configuration.
     */
    llm: LlmConfig;
    /**
     * The case's closed human oracle.
     */
    oracle: GoldenHumanOracle;
    /**
     * The human fix's rules read from its commit.
     */
    humanRules: BenchmarkHumanRules;
}

/**
 * Read the human fix's rules for the record; a failed read is recorded, not raised, because the
 * agent's result stands without it.
 *
 * @param commit - Human fix commit from the closed oracle.
 * @param extract - Read-only first-parent commit reader.
 * @returns The commit's rule additions and removals, or the reason they could not be read.
 */
export async function readBenchmarkHumanRules(
    commit: string,
    extract: (commit: string) => Promise<ExtractedHumanFix>,
): Promise<BenchmarkHumanRules> {
    try {
        const fix = await extract(commit);
        return {
            firstParent: fix.firstParent,
            rules: fix.candidates,
            removedRules: fix.removedRules,
            rulesError: null,
        };
    } catch (error) {
        return {
            firstParent: null,
            rules: null,
            removedRules: null,
            rulesError: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Assemble a record from trusted agent artifacts, the case outcome and the human fix.
 *
 * @param input - Completed lifecycle sources and timestamps.
 * @returns Self-contained record without credentials or provider endpoints.
 */
export function collectBenchmarkRecord(input: CollectBenchmarkRecordInput): BenchmarkRecord {
    const { record, outputDirectory, llm, runEnvironment, oracle } = input;
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
        agent: runEnvironment.agent,
        model: {
            api: llm.api,
            loop: llm.model,
            vision: effectiveVisionModel(llm),
            reasoningEffort: llm.reasoningEffort,
            singleShotReasoningEffort: llm.singleShotReasoningEffort,
        },
        environment: {
            extensionBuild: input.run?.extensionBuild ?? null,
            browser: runEnvironment.browser,
            knowledgeBaseCommit: input.knowledgeBaseSha,
            filtersBaseSha: input.run?.filtersBaseSha ?? null,
        },
        timings: {
            siteCheckMs: input.siteCheckedAt - input.startedAt,
            preparationMs: traceStartedAt === null ? null : traceStartedAt - input.siteCheckedAt,
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
        site: input.site,
        outcome: {
            ...input.outcome,
            reporterEnvironment: input.reporterEnvironment,
            candidate: record?.result.candidatePatch ?? null,
            candidateForReview: record?.result.candidateForReview ?? null,
        },
        human: {
            fixCommit: oracle.humanFixCommit,
            issueCreatedAt: oracle.issueCreatedAt,
            fixCommittedAt: oracle.fixCommittedAt,
            elapsedMs: Date.parse(oracle.fixCommittedAt) - Date.parse(oracle.issueCreatedAt),
            ...input.humanRules,
        },
    };
}

/**
 * Atomically persist the final benchmark record in the evaluation directory.
 *
 * @param evaluationDirectory - Evaluator-owned output directory.
 * @param record - Completed self-contained benchmark record.
 * @returns Nothing after the final artifact replaces its temporary file.
 */
export function writeBenchmarkRecord(evaluationDirectory: string, record: BenchmarkRecord): void {
    writeAtomicJson(join(evaluationDirectory, BENCHMARK_RECORD_FILE_NAME), record);
}
