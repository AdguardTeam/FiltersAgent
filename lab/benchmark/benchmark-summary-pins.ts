import type { BenchmarkRecord } from '../e2e/benchmark-record';

/**
 * Series-wide conditions whose differences affect comparisons across saved runs.
 */
export const BenchmarkPin = {
    /**
     * Judge API, model roles and reasoning settings.
     */
    Judge: 'judge',
    /**
     * Agent source revision and local-change state.
     */
    AgentRevision: 'agentRevision',
    /**
     * Guidance revision supplied to the agent.
     */
    KnowledgeBase: 'knowledgeBaseCommit',
    /**
     * Browser package and binary build.
     */
    Browser: 'browser',
} as const;

/**
 * A series-wide comparison condition.
 */
export type BenchmarkPin = (typeof BenchmarkPin)[keyof typeof BenchmarkPin];

/**
 * One comparison condition that differs across the loaded records.
 */
export interface MixedBenchmarkPin {
    /**
     * Condition whose values differ.
     */
    pin: BenchmarkPin;
    /**
     * Distinct recorded values in input order.
     */
    values: string[];
}

/**
 * Identify a judge independently of object property order.
 *
 * @param judge - Recorded judge configuration without credentials.
 * @returns JSON containing both model roles and reasoning settings.
 */
export function benchmarkJudgeIdentity(judge: BenchmarkRecord['judge']): string {
    return JSON.stringify({
        api: judge.api,
        model: judge.model,
        visionModel: judge.visionModel,
        reasoningEffort: judge.reasoningEffort,
        singleShotReasoningEffort: judge.singleShotReasoningEffort,
    });
}

/**
 * Include local source changes when naming the agent revision.
 *
 * @param agent - Recorded source commit and dirty flag.
 * @returns Commit with a dirty marker when local changes were present.
 */
export function benchmarkAgentRevision(agent: BenchmarkRecord['agent']): string {
    return agent.dirty ? `${agent.commit} (dirty)` : agent.commit;
}

/**
 * Read the recorded value of one series-wide comparison condition.
 *
 * @param record - Trusted comparison artifact.
 * @param pin - Condition to inspect.
 * @returns Stable identity for that condition.
 */
function pinValue(record: BenchmarkRecord, pin: BenchmarkPin): string {
    switch (pin) {
        case BenchmarkPin.Judge:
            return benchmarkJudgeIdentity(record.judge);
        case BenchmarkPin.AgentRevision:
            return benchmarkAgentRevision(record.agent);
        case BenchmarkPin.KnowledgeBase:
            return record.environment.knowledgeBaseCommit;
        case BenchmarkPin.Browser:
            return record.environment.browser;
    }
}

/**
 * Detect mixed series conditions globally, including differences between model groups.
 *
 * @param records - Every loaded record, including excluded and transient runs.
 * @returns Conditions having multiple distinct values; case-specific pins are not compared.
 */
export function mixedBenchmarkPins(records: readonly BenchmarkRecord[]): MixedBenchmarkPin[] {
    return Object.values(BenchmarkPin).flatMap((pin) => {
        const values = [...new Set(records.map((record) => pinValue(record, pin)))];
        return values.length > 1 ? [{ pin, values }] : [];
    });
}
