import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    readBenchmarkRecords,
    renderBenchmarkSummaryMarkdown,
    summarizeBenchmark,
    wilsonInterval,
    type LoadedBenchmarkRecord,
} from '../../../lab/benchmark/benchmark-summary';
import {
    BENCHMARK_CSV_COLUMNS,
    renderBenchmarkCsv,
} from '../../../lab/benchmark/benchmark-summary-csv';
import {
    BENCHMARK_RECORD_FILE_NAME,
    BENCHMARK_RECORD_SCHEMA_VERSION,
    BenchmarkFailureKind,
    BenchmarkLevel,
    type BenchmarkRecord,
} from '../../../lab/e2e/benchmark-record';
import { BenchmarkPin } from '../../../lab/benchmark/benchmark-summary-pins';
import { ReasoningEffort } from '../../../src/config/reasoning-effort';
import { GoldenE2EStatus } from '../../../lab/e2e/golden-comparator';
import { HumanFixVerdict } from '../../../lab/e2e/golden-judge';
import { RunCostStatus } from '../../../lab/pricing/run-cost';
import { LlmApi } from '../../../src/config/llm-api';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'benchmark-summary-'));
    temporaryRoots.push(root);
    return root;
}

function record(caseName = 'example-case', model = 'example-agent-model'): BenchmarkRecord {
    return {
        schemaVersion: BENCHMARK_RECORD_SCHEMA_VERSION,
        case: caseName,
        startedAt: '2026-10-01T12:00:00Z',
        agent: { commit: 'a'.repeat(40), dirty: false },
        model: {
            api: LlmApi.OpenAiCompletions,
            loop: model,
            vision: model,
            reasoningEffort: ReasoningEffort.High,
            singleShotReasoningEffort: ReasoningEffort.Medium,
        },
        judge: {
            api: LlmApi.OpenAiCompletions,
            model: 'example-judge-model',
            visionModel: 'example-judge-model',
            reasoningEffort: ReasoningEffort.High,
            singleShotReasoningEffort: ReasoningEffort.Medium,
        },
        environment: {
            extensionBuild: null,
            browser: 'example-browser',
            knowledgeBaseCommit: 'b'.repeat(40),
            filtersBaseSha: null,
        },
        timings: {
            preparationMs: 60_000,
            agentMs: 120_000,
            finalizeMs: 3_000,
            evaluationMs: 6_000,
            totalMs: 189_000,
        },
        turns: 7,
        usage: {
            tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoningTokens: 5 },
            requests: 8,
            costUsd: 0.25,
            costStatus: RunCostStatus.Priced,
        },
        outcome: {
            status: GoldenE2EStatus.Pass,
            failureKind: null,
            level: BenchmarkLevel.Pass,
            humanFixVerdict: HumanFixVerdict.Verified,
            verdictFromCache: false,
        },
        human: {
            issueCreatedAt: '2026-10-01T00:00:00Z',
            fixCommittedAt: '2026-10-01T02:00:00Z',
            elapsedMs: 7_200_000,
        },
    };
}

function loaded(value: BenchmarkRecord, root = 'example-root'): LoadedBenchmarkRecord {
    return { record: value, root };
}

function rejected(caseName: string, kind: BenchmarkFailureKind): BenchmarkRecord {
    const value = record(caseName);
    value.outcome = {
        ...value.outcome,
        status: GoldenE2EStatus.InfrastructureFailure,
        failureKind: kind,
        level: BenchmarkLevel.Failed,
    };
    return value;
}

function writeRecord(root: string, layout: string, value: BenchmarkRecord): void {
    const directory = join(root, layout, value.case);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, BENCHMARK_RECORD_FILE_NAME), JSON.stringify(value));
}

// A CSV consumer reads quoted delimiters, doubled quotes and embedded line breaks.
function parseCsv(csv: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    for (let index = 0; index < csv.length; index += 1) {
        const character = csv[index];
        if (character === '"') {
            if (quoted && csv[index + 1] === '"') {
                field += '"';
                index += 1;
            } else {
                quoted = !quoted;
            }
        } else if (!quoted && (character === ',' || character === '\r')) {
            row.push(field);
            field = '';
            if (character === '\r') {
                rows.push(row);
                row = [];
                expect(csv[index + 1]).toBe('\n');
                index += 1;
            }
        } else {
            field += character;
        }
    }
    expect(quoted).toBe(false);
    expect(field).toBe('');
    expect(row).toEqual([]);
    return rows;
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('benchmark summaries', () => {
    it('computes 50% (24–76%) for 5 passes in 10 runs', () => {
        const records = Array.from({ length: 10 }, (_, index) => {
            const value = record(`example-case-${index}`);
            if (index >= 5) {
                value.outcome.status = GoldenE2EStatus.AgentRegression;
                value.outcome.level = BenchmarkLevel.Proposed;
            }
            return loaded(value);
        });
        const interval = wilsonInterval(5, 10);
        expect(interval.low).toBeCloseTo(0.2366, 4);
        expect(interval.high).toBeCloseTo(0.7634, 4);
        const summary = summarizeBenchmark(records);
        expect(summary.models[0]).toMatchObject({ runs: 10, pass: 5, meanLevel: 3.5 });
        expect(renderBenchmarkSummaryMarkdown(summary)).toContain('50% (24–76%)');
        expect(summary.agentMedianMinutes).toBe(3);
        expect(summary.humanMedianHours).toBe(2);
    });

    it('keeps transient failures out of the denominator and provider rejections in it', () => {
        const summary = summarizeBenchmark([
            loaded(record()),
            loaded(rejected('example-rejected', BenchmarkFailureKind.ProviderRejected)),
            loaded(rejected('example-transient', BenchmarkFailureKind.Transient)),
        ]);
        expect(summary.models[0]).toMatchObject({
            runs: 2,
            pass: 1,
            meanLevel: 2.5,
            rejected: 1,
            transient: 1,
            totalCostUsd: 0.75,
        });
        expect(summary.cases.find((item) => item.caseName === 'example-transient')?.cells).toEqual({
            'example-agent-model': null,
        });
    });

    it('counts intake skips as failed runs and exposes them in the summary and CSV', () => {
        const skipped = rejected('example-skipped', BenchmarkFailureKind.IntakeSkipped);
        const records = [loaded(record()), loaded(skipped)];
        const summary = summarizeBenchmark(records);
        expect(summary.models[0]).toMatchObject({
            runs: 2,
            pass: 1,
            passRate: 0.5,
            intakeSkipped: 1,
            transient: 0,
        });
        expect(renderBenchmarkSummaryMarkdown(summary)).toContain('intake skipped');
        const rows = parseCsv(renderBenchmarkCsv(records));
        const values = Object.fromEntries(
            rows[0]!.map((column, index) => [column, rows[2]![index]]),
        );
        expect(values.failureKind).toBe('intake_skipped');
    });

    it('keeps identical pins quiet across repetitions', () => {
        const summary = summarizeBenchmark([loaded(record()), loaded(record())]);
        expect(summary.mixedPins).toEqual([]);
        expect(renderBenchmarkSummaryMarkdown(summary)).not.toContain('mixed pins:');
    });

    it.each([
        [
            BenchmarkPin.Judge,
            (value: BenchmarkRecord) => {
                value.judge.model = 'example-other-judge';
            },
        ],
        [
            BenchmarkPin.Judge,
            (value: BenchmarkRecord) => {
                value.judge.visionModel = 'example-other-vision';
            },
        ],
        [
            BenchmarkPin.Judge,
            (value: BenchmarkRecord) => {
                value.judge.reasoningEffort = ReasoningEffort.Off;
            },
        ],
        [
            BenchmarkPin.Judge,
            (value: BenchmarkRecord) => {
                value.judge.singleShotReasoningEffort = ReasoningEffort.Low;
            },
        ],
        [
            BenchmarkPin.AgentRevision,
            (value: BenchmarkRecord) => {
                value.agent.commit = 'c'.repeat(40);
            },
        ],
        [
            BenchmarkPin.AgentRevision,
            (value: BenchmarkRecord) => {
                value.agent.dirty = true;
            },
        ],
        [
            BenchmarkPin.KnowledgeBase,
            (value: BenchmarkRecord) => {
                value.environment.knowledgeBaseCommit = 'd'.repeat(40);
            },
        ],
        [
            BenchmarkPin.Browser,
            (value: BenchmarkRecord) => {
                value.environment.browser = 'example-other-browser';
            },
        ],
    ] as const)('warns about mixed %s pins across model groups', (pin, change) => {
        const first = record();
        const second = record('example-second-case', 'example-second-model');
        change(second);
        const summary = summarizeBenchmark([loaded(first), loaded(second)]);
        expect(summary.models).toHaveLength(2);
        expect(summary.mixedPins).toMatchObject([{ pin }]);
        expect(renderBenchmarkSummaryMarkdown(summary)).toContain(`mixed pins: ${pin} (2 values)`);
    });

    it('excludes a case the judge found dead for every model', () => {
        const dead = record('example-dead');
        const excludedTransient = rejected('example-dead', BenchmarkFailureKind.Transient);
        dead.outcome.status = GoldenE2EStatus.EnvironmentDrift;
        dead.outcome.humanFixVerdict = HumanFixVerdict.NotVerified;
        const excludedRejection = rejected('example-dead', BenchmarkFailureKind.ProviderRejected);
        const second = record('example-dead', 'example-second-model');
        const summary = summarizeBenchmark([
            loaded(record()),
            loaded(dead),
            loaded(excludedTransient),
            loaded(excludedRejection),
            loaded(second),
        ]);
        expect(summary.excludedCases).toEqual(['example-dead']);
        expect(summary.cases.map((item) => item.caseName)).toEqual(['example-case']);
        expect(summary.models[0]).toMatchObject({
            runs: 1,
            pass: 1,
            rejected: 1,
            transient: 1,
            totalCostUsd: 1,
        });
        expect(summary.models[1]).toMatchObject({ runs: 0, pass: 0, totalCostUsd: 0.25 });
        expect(summary.cases[0]?.cells['example-second-model']).toBeNull();
        expect(renderBenchmarkSummaryMarkdown(summary)).toContain(
            'excluded cases (drift): example-dead',
        );
    });

    it('counts records of one model configuration and case as repetitions', () => {
        const firstRoot = temporaryRoot();
        const secondRoot = temporaryRoot();
        const first = record();
        const repeated = record();
        repeated.outcome.status = GoldenE2EStatus.AgentRegression;
        repeated.outcome.level = BenchmarkLevel.Proposed;
        repeated.usage.costUsd = 0.75;
        repeated.timings.agentMs = 240_000;
        const otherConfig = record();
        otherConfig.model.reasoningEffort = ReasoningEffort.Low;
        otherConfig.human = { ...otherConfig.human!, elapsedMs: 36_000_000 };
        writeRecord(firstRoot, 'evaluations', first);
        writeRecord(secondRoot, 'e2e-evaluations', repeated);
        const records = readBenchmarkRecords([firstRoot, join(secondRoot, 'e2e-evaluations')]);
        expect(records.map((item) => item.root)).toEqual([firstRoot, secondRoot]);
        const summary = summarizeBenchmark([...records, loaded(otherConfig)]);
        expect(summary.models).toHaveLength(2);
        expect(summary.models[0]).toMatchObject({
            runs: 2,
            pass: 1,
            meanLevel: 3.5,
            medianCostUsd: 0.5,
            medianMinutes: 4,
        });
        expect(summary.models.map((row) => row.label)).toEqual([
            'example-agent-model (openai-completions, example-agent-model, high/medium)',
            'example-agent-model (openai-completions, example-agent-model, low/medium)',
        ]);
        const cell = summary.cases[0]?.cells[summary.models[0]!.label];
        expect(cell).toMatchObject({
            runs: 2,
            pass: 1,
            maxLevel: 5,
            medianCostUsd: 0.5,
            medianMinutes: 4,
        });
        expect(summary.humanMedianHours).toBe(2);
    });

    it('writes a CSV that reads back to the same values', () => {
        const value = record('example,"quoted"\ncase');
        const missing = record('example-missing');
        missing.usage.tokens = null;
        missing.usage.costUsd = null;
        missing.timings.preparationMs = null;
        missing.turns = null;
        missing.human = null;
        const rows = parseCsv(
            renderBenchmarkCsv([loaded(value, 'example,"root"\r\nrepeat'), loaded(missing)]),
        );
        expect(rows[0]).toEqual([...BENCHMARK_CSV_COLUMNS]);
        const values = Object.fromEntries(
            rows[0]!.map((column, index) => [column, rows[1]![index]]),
        );
        expect(values).toMatchObject({
            case: value.case,
            model: value.model.loop,
            api: value.model.api,
            loop: value.model.loop,
            vision: value.model.vision,
            reasoningEffort: ReasoningEffort.High,
            singleShotReasoningEffort: ReasoningEffort.Medium,
            judge: JSON.stringify(value.judge),
            agentCommit: value.agent.commit,
            knowledgeBaseCommit: value.environment.knowledgeBaseCommit,
            root: 'example,"root"\r\nrepeat',
            status: GoldenE2EStatus.Pass,
            failureKind: '',
            level: '5',
            inputTokens: '10',
            outputTokens: '20',
            cacheReadTokens: '30',
            cacheWriteTokens: '40',
            reasoningTokens: '5',
            requests: '8',
            costUsd: '0.25',
            preparationMinutes: '1',
            agentMinutes: '2',
            finalizeMinutes: '0.05',
            evaluationMinutes: '0.1',
            totalMinutes: '3.15',
            turns: '7',
            humanElapsedMs: '7200000',
        });
        const missingValues = Object.fromEntries(
            rows[0]!.map((column, index) => [column, rows[2]![index]]),
        );
        expect(missingValues).toMatchObject({
            inputTokens: '',
            costUsd: '',
            preparationMinutes: '',
            turns: '',
            humanElapsedMs: '',
        });
    });

    it('fails naming a root without records', () => {
        const root = temporaryRoot();
        expect(() => readBenchmarkRecords([root])).toThrow(root);
        expect(() => readBenchmarkRecords([join(root, 'absent')])).toThrow(join(root, 'absent'));
    });

    it('retains unavailable measurements as null and renders empty denominators without NaN', () => {
        const value = rejected('example-case', BenchmarkFailureKind.Transient);
        value.usage.costUsd = null;
        value.timings.preparationMs = null;
        value.timings.agentMs = null;
        value.human = null;
        const summary = summarizeBenchmark([loaded(value)]);
        expect(summary.models[0]).toMatchObject({
            runs: 0,
            pass: 0,
            passRate: null,
            interval: null,
            meanLevel: null,
            medianCostUsd: null,
            medianMinutes: null,
        });
        expect(summary.agentMedianMinutes).toBeNull();
        expect(summary.humanMedianHours).toBeNull();
        expect(renderBenchmarkSummaryMarkdown(summary)).not.toMatch(/NaN|Infinity/);
    });
});
