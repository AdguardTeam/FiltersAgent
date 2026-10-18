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
    type BenchmarkRecord,
} from '../../../lab/e2e/benchmark-record';
import { BenchmarkCaseStatus, BenchmarkFailureKind } from '../../../lab/e2e/benchmark-outcome';
import { GoldenAgentEnvironmentStatus } from '../../../lab/e2e/golden-agent-environment';
import { BenchmarkPin } from '../../../lab/benchmark/benchmark-summary-pins';
import { ReasoningEffort } from '../../../src/config/reasoning-effort';
import { RuleType } from '../../../src/types/rule-proposal';
import { RepositoryEditKind } from '../../../src/types/repository-edit-kind';
import { RuleSyntaxKind } from '../../../src/types/rule-syntax-kind';
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
        environment: {
            extensionBuild: null,
            browser: 'example-browser',
            knowledgeBaseCommit: 'b'.repeat(40),
            filtersBaseSha: null,
        },
        timings: {
            siteCheckMs: 0,
            preparationMs: 60_000,
            agentMs: 120_000,
            finalizeMs: 3_000,
            evaluationMs: 6_000,
            totalMs: 189_000,
        },
        turns: 7,
        site: { url: 'https://example.org/', reachable: true, answer: 'HTTP 200' },
        usage: {
            tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoningTokens: 5 },
            requests: 8,
            costUsd: 0.25,
            costStatus: RunCostStatus.Priced,
        },
        outcome: {
            status: BenchmarkCaseStatus.Verified,
            failureKind: null,
            detail: null,
            reporterEnvironment: {
                status: GoldenAgentEnvironmentStatus.Matched,
                detail: 'Matched.',
            },
            candidate: {
                rule: 'example.org##.ad',
                ruleType: RuleType.Cosmetic,
                filePath: 'filters/example.txt',
            },
            candidateForReview: null,
        },
        human: {
            fixCommit: 'c'.repeat(40),
            firstParent: 'd'.repeat(40),
            issueCreatedAt: '2026-10-01T00:00:00Z',
            fixCommittedAt: '2026-10-01T02:00:00Z',
            elapsedMs: 7_200_000,
            rules: [
                {
                    rule: 'example.org##.ad',
                    syntaxKind: RuleSyntaxKind.ElementHiding,
                    filePath: 'filters/example.txt',
                    repositoryEdit: RepositoryEditKind.Insert,
                    sourceRule: 'example.org##.ad',
                },
            ],
            removedRules: [],
            rulesError: null,
        },
    };
}

function loaded(value: BenchmarkRecord, root = 'example-root'): LoadedBenchmarkRecord {
    return { record: value, root };
}

function failed(caseName: string, kind: BenchmarkFailureKind): BenchmarkRecord {
    const value = record(caseName);
    value.outcome = {
        ...value.outcome,
        status: BenchmarkCaseStatus.InfrastructureFailure,
        failureKind: kind,
        detail: 'Example failure.',
        candidate: null,
    };
    return value;
}

function withStatus(value: BenchmarkRecord, status: BenchmarkCaseStatus): BenchmarkRecord {
    value.outcome.status = status;
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
    it('computes 50% (24–76%) for 5 verified in 10 runs', () => {
        const records = Array.from({ length: 10 }, (_, index) => {
            const value = record(`example-case-${index}`);
            return loaded(index >= 5 ? withStatus(value, BenchmarkCaseStatus.Proposed) : value);
        });
        const interval = wilsonInterval(5, 10);
        expect(interval.low).toBeCloseTo(0.2366, 4);
        expect(interval.high).toBeCloseTo(0.7634, 4);
        const summary = summarizeBenchmark(records);
        expect(summary.models[0]).toMatchObject({ runs: 10, verified: 5, proposed: 5 });
        expect(renderBenchmarkSummaryMarkdown(summary)).toContain('50% (24–76%)');
        expect(summary.agentMedianMinutes).toBe(3);
        expect(summary.humanMedianHours).toBe(2);
    });

    it('keeps transient failures out of the denominator and provider rejections in it', () => {
        const summary = summarizeBenchmark([
            loaded(record()),
            loaded(failed('example-rejected', BenchmarkFailureKind.ProviderRejected)),
            loaded(failed('example-transient', BenchmarkFailureKind.Transient)),
        ]);
        expect(summary.models[0]).toMatchObject({
            runs: 2,
            verified: 1,
            rejected: 1,
            transient: 1,
            totalCostUsd: 0.75,
        });
        expect(summary.cases.find((item) => item.caseName === 'example-transient')?.cells).toEqual({
            'example-agent-model': null,
        });
    });

    it('counts intake skips as failed runs and exposes them in the summary and CSV', () => {
        const skipped = failed('example-skipped', BenchmarkFailureKind.IntakeSkipped);
        const records = [loaded(record()), loaded(skipped)];
        const summary = summarizeBenchmark(records);
        expect(summary.models[0]).toMatchObject({
            runs: 2,
            verified: 1,
            verifiedRate: 0.5,
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

    it('keeps an unreachable site out of the denominator and lists the case', () => {
        const unreachable = failed('example-offline', BenchmarkFailureKind.Transient);
        unreachable.outcome = {
            ...unreachable.outcome,
            status: BenchmarkCaseStatus.SiteUnreachable,
            failureKind: null,
            reporterEnvironment: null,
        };
        unreachable.usage.costUsd = null;
        unreachable.human.elapsedMs = 360_000_000;
        const summary = summarizeBenchmark([loaded(record()), loaded(unreachable)]);
        // The agent median has no run of the unreachable case, so the human median has none either.
        expect(summary.humanMedianHours).toBe(2);
        expect(summary.models[0]).toMatchObject({ runs: 1, verified: 1, siteUnreachable: 1 });
        expect(summary.unreachableCases).toEqual(['example-offline']);
        expect(summary.cases.find((item) => item.caseName === 'example-offline')?.cells).toEqual({
            'example-agent-model': null,
        });
        expect(renderBenchmarkSummaryMarkdown(summary)).toContain(
            'site unreachable: example-offline',
        );
    });

    it('lists a case no model reproduced, as a stale case would show', () => {
        const stale = [
            withStatus(record('example-stale'), BenchmarkCaseStatus.NotReproduced),
            withStatus(
                record('example-stale', 'example-second-model'),
                BenchmarkCaseStatus.NotReproduced,
            ),
            failed('example-stale', BenchmarkFailureKind.ProviderRejected),
        ];
        const reached = withStatus(
            record('example-reached', 'example-second-model'),
            BenchmarkCaseStatus.Reproduced,
        );
        // Every run refused before the investigation says nothing about the human fix.
        const refused = [
            failed('example-refused', BenchmarkFailureKind.ProviderRejected),
            failed('example-refused', BenchmarkFailureKind.IntakeSkipped),
        ];
        const summary = summarizeBenchmark(
            [record(), ...stale, reached, ...refused].map((value) => loaded(value)),
        );
        expect(summary.notReproducedCases).toEqual(['example-stale']);
        expect(summary.cases.find((item) => item.caseName === 'example-stale')?.cells).toEqual(
            expect.objectContaining({
                'example-agent-model': expect.objectContaining({
                    runs: 2,
                    verified: 0,
                    best: BenchmarkCaseStatus.NotReproduced,
                }),
            }),
        );
        expect(renderBenchmarkSummaryMarkdown(summary)).toContain(
            'no model reproduced: example-stale',
        );
    });

    it('counts runs whose verified session missed the reporter environment', () => {
        const mismatch = record('example-mismatch');
        mismatch.outcome.reporterEnvironment = {
            status: GoldenAgentEnvironmentStatus.AgentMismatch,
            detail: 'Stealth state enabled does not match reporter state disabled.',
        };
        const summary = summarizeBenchmark([loaded(record()), loaded(mismatch)]);
        expect(summary.models[0]).toMatchObject({ runs: 2, verified: 2, environmentMismatches: 1 });
    });

    it('names every record written before the judge was removed at once', () => {
        const root = temporaryRoot();
        writeRecord(root, 'evaluations', record());
        for (const caseName of ['example-old-a', 'example-old-b']) {
            writeRecord(root, 'evaluations', {
                ...record(caseName),
                schemaVersion: 1,
            } as unknown as BenchmarkRecord);
        }
        expect(() => readBenchmarkRecords([root])).toThrow(
            /example-old-a[^\n]*version 1\)\n.*example-old-b[^\n]*version 1\)/u,
        );
    });

    it('keeps a case without agent time out of the human median', () => {
        // An intake skip ends before a trace, so it adds nothing to the agent median either.
        const skipped = failed('example-skipped', BenchmarkFailureKind.IntakeSkipped);
        skipped.timings.preparationMs = null;
        skipped.timings.agentMs = null;
        skipped.human.elapsedMs = 360_000_000;
        const summary = summarizeBenchmark([loaded(record()), loaded(skipped)]);
        expect(summary.agentMedianMinutes).toBe(3);
        expect(summary.humanMedianHours).toBe(2);
    });

    it('counts records of one model configuration and case as repetitions', () => {
        const firstRoot = temporaryRoot();
        const secondRoot = temporaryRoot();
        const first = record();
        const repeated = record();
        repeated.outcome.status = BenchmarkCaseStatus.Proposed;
        repeated.usage.costUsd = 0.75;
        repeated.timings.agentMs = 240_000;
        const otherConfig = record();
        otherConfig.model.reasoningEffort = ReasoningEffort.Low;
        otherConfig.human = { ...otherConfig.human, elapsedMs: 36_000_000 };
        writeRecord(firstRoot, 'evaluations', first);
        writeRecord(secondRoot, 'e2e-evaluations', repeated);
        const records = readBenchmarkRecords([firstRoot, join(secondRoot, 'e2e-evaluations')]);
        expect(records.map((item) => item.root)).toEqual([firstRoot, secondRoot]);
        const summary = summarizeBenchmark([...records, loaded(otherConfig)]);
        expect(summary.models).toHaveLength(2);
        expect(summary.models[0]).toMatchObject({
            runs: 2,
            verified: 1,
            proposed: 1,
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
            verified: 1,
            best: BenchmarkCaseStatus.Verified,
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
        missing.outcome.candidate = null;
        missing.outcome.reporterEnvironment = null;
        missing.human.rules = null;
        missing.human.removedRules = null;
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
            agentCommit: value.agent.commit,
            knowledgeBaseCommit: value.environment.knowledgeBaseCommit,
            root: 'example,"root"\r\nrepeat',
            status: BenchmarkCaseStatus.Verified,
            failureKind: '',
            reporterEnvironment: GoldenAgentEnvironmentStatus.Matched,
            agentRule: 'example.org##.ad',
            agentFilePath: 'filters/example.txt',
            humanFixCommit: 'c'.repeat(40),
            agentEdit: '',
            humanRules: JSON.stringify([
                { rule: 'example.org##.ad', repositoryEdit: 'insert', replacedRule: null },
            ]),
            humanRemovedRules: '[]',
            humanRulesError: '',
            inputTokens: '10',
            outputTokens: '20',
            cacheReadTokens: '30',
            cacheWriteTokens: '40',
            reasoningTokens: '5',
            requests: '8',
            costUsd: '0.25',
            siteCheckMinutes: '0',
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
            reporterEnvironment: '',
            agentRule: '',
            humanRules: '',
            humanRemovedRules: '',
        });
    });

    it('fails naming a root without records', () => {
        const root = temporaryRoot();
        expect(() => readBenchmarkRecords([root])).toThrow(root);
        expect(() => readBenchmarkRecords([join(root, 'absent')])).toThrow(join(root, 'absent'));
    });

    it('retains unavailable measurements as null and renders empty denominators without NaN', () => {
        const value = failed('example-case', BenchmarkFailureKind.Transient);
        value.usage.costUsd = null;
        value.timings.preparationMs = null;
        value.timings.agentMs = null;
        const summary = summarizeBenchmark([loaded(value)]);
        expect(summary.models[0]).toMatchObject({
            runs: 0,
            verified: 0,
            verifiedRate: null,
            interval: null,
            medianCostUsd: null,
            medianMinutes: null,
        });
        expect(summary.agentMedianMinutes).toBeNull();
        expect(summary.humanMedianHours).toBeNull();
        expect(renderBenchmarkSummaryMarkdown(summary)).not.toMatch(/NaN|Infinity/);
    });
});
