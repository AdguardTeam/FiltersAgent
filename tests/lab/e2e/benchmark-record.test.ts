import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    collectBenchmarkRecord,
    readBenchmarkHumanRules,
    writeBenchmarkRecord,
    type CollectBenchmarkRecordInput,
} from '../../../lab/e2e/benchmark-record';
import { BenchmarkCaseStatus } from '../../../lab/e2e/benchmark-outcome';
import { ReasoningEffort } from '../../../src/config/reasoning-effort';
import type { ExtractedHumanFix, HumanFixCandidate } from '../../../lab/e2e/human-commit-oracle';
import type { FixRunResult } from '../../../src/types/fix-run-result';
import type { LocalRunRecord } from '../../../src/local/run-output';
import { createRunUsageCollector } from '../../../src/pi/usage-collector';
import { testCoreConfig } from '../../config/test-core-config';

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
            baseUrl: 'https://example.com/agent-private',
            apiKey: 'fake-agent-private-key',
            reasoningEffort: ReasoningEffort.High,
            singleShotReasoningEffort: ReasoningEffort.Medium,
        },
    }).llm;
    return {
        caseName: 'sample',
        startedAt: 1_000,
        siteCheckedAt: 1_500,
        runReturnedAt: 5_000,
        evaluatedAt: 6_000,
        outputDirectory,
        record: { result: runResult({ candidatePatch: candidate }) } as LocalRunRecord,
        outcome: { status: BenchmarkCaseStatus.Proposed, failureKind: null, detail: null },
        site: { url: 'https://example.com/', reachable: true, answer: 'HTTP 200' },
        reporterEnvironment: null,
        run: {
            extensionBuild: {
                version: '1.2.3',
                releaseTag: 'v1.2.0',
                autobuildCommit: 'a'.repeat(40),
            },
            filtersBaseSha: 'b'.repeat(40),
        },
        runEnvironment: {
            agent: { commit: 'c'.repeat(40), dirty: true },
            browser: 'cloakbrowser 1.2.3, chromium 123.4',
        },
        knowledgeBaseSha: 'd'.repeat(40),
        llm,
        oracle: {
            humanFixCommit: 'e'.repeat(40),
            issueCreatedAt: '2026-07-14T06:00:00Z',
            fixCommittedAt: '2026-07-14T09:00:00Z',
        },
        humanRules: {
            firstParent: 'f'.repeat(40),
            rules: [human],
            removedRules: [],
            rulesError: null,
        },
    };
}

describe('benchmark record', () => {
    it('keeps the provider base URL and key out of the record', () => {
        const data = input();
        const record = collectBenchmarkRecord(data);
        const evaluationDirectory = join(data.outputDirectory, 'evaluation');
        writeBenchmarkRecord(evaluationDirectory, record);
        const saved = readFileSync(join(evaluationDirectory, 'benchmark-record.json'), 'utf8');
        expect(saved).not.toContain(data.llm.baseUrl);
        expect(saved).not.toContain(data.llm.apiKey);
        expect(JSON.parse(saved)).toMatchObject({
            schemaVersion: 2,
            model: {
                loop: 'example-agent-model',
                vision: 'example-agent-model',
                reasoningEffort: ReasoningEffort.High,
                singleShotReasoningEffort: ReasoningEffort.Medium,
            },
            agent: data.runEnvironment.agent,
            environment: { knowledgeBaseCommit: data.knowledgeBaseSha },
            timings: {
                siteCheckMs: 500,
                preparationMs: null,
                agentMs: null,
                finalizeMs: null,
                evaluationMs: 1_000,
                totalMs: 5_000,
            },
            turns: null,
            usage: { tokens: null, requests: null, costUsd: null, costStatus: 'no_usage' },
            site: { url: 'https://example.com/', reachable: true, answer: 'HTTP 200' },
            outcome: { status: BenchmarkCaseStatus.Proposed, candidate },
            human: { fixCommit: 'e'.repeat(40), elapsedMs: 10_800_000, rules: [human] },
        });
    });

    it('records the human rules of a readable commit and the error of an unreadable one', async () => {
        const commit = 'e'.repeat(40);
        const fix: ExtractedHumanFix = {
            firstParent: 'f'.repeat(40),
            candidates: [human],
            removedRules: [],
        };
        expect(await readBenchmarkHumanRules(commit, async () => fix)).toEqual({
            firstParent: fix.firstParent,
            rules: [human],
            removedRules: [],
            rulesError: null,
        });
        expect(
            await readBenchmarkHumanRules(commit, async () => {
                throw new Error('git fetch failed');
            }),
        ).toEqual({
            firstParent: null,
            rules: null,
            removedRules: null,
            rulesError: 'git fetch failed',
        });
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
            siteCheckMs: 500,
            preparationMs: 500,
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
