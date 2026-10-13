import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuleGuidanceSourceKind } from '../../../src/knowledge/guidance-source';
import {
    buildLocalRunRecord,
    collectKnowledgeGuidanceCitations,
    type LocalCoreExecution,
} from '../../../lab/local/local-run-record';
import { readLocalRunOutput, writeLocalRunOutput } from '../../../src/local/run-output';
import type { LocalInstructionProvenance } from '../../../src/local/run-record-guidance-schemas';
import { CheckoutSource } from '../../../src/types/checkout-source';
import { ExtensionEnvironmentKind } from '../../../src/types/extension-environment-kind';
import type { FixRunResult } from '../../../src/types/fix-run-result';

let root: string | undefined;

afterEach(() => {
    if (root !== undefined) {
        rmSync(root, { recursive: true, force: true });
    }
    root = undefined;
});

/**
 * A locked reasoning-only failed run pointing its trace at the given file.
 *
 * @param tracePath - Persisted trace path the run record reads the tool results from.
 * @returns The schema-shaped core result.
 */
function coreWithTrace(tracePath: string): FixRunResult {
    return {
        issueNumber: 4,
        domain: 'example.com',
        runStatus: 'failed',
        requestedBrowserMode: 'auto',
        effectiveMode: 'reasoning',
        verificationStatus: 'unavailable',
        fallbackReason: null,
        fallbackDetail: null,
        candidatePatch: null,
        artifactPaths: {
            screenshots: [],
            domSnapshot: null,
            har: null,
            trace: tracePath,
        },
        reasoning: 'The run failed before any evidence was collected.',
        repository: null,
        baseSha: null,
    };
}

/**
 * Write a persisted trace carrying lookup_rule_guidance tool results.
 *
 * @param events - The tool_result payloads to record, each with its tool and result.
 * @returns Absolute trace path.
 */
function writeTrace(events: { tool: string; result: unknown }[]): string {
    root ??= mkdtempSync(join(tmpdir(), 'local-run-record-'));
    const tracePath = join(root, 'trace.json');
    writeFileSync(
        tracePath,
        JSON.stringify({
            runId: 'run-record-fixture',
            events: events.map((event) => ({
                type: 'tool_result',
                ts: '2026-09-09T10:00:00.000Z',
                payload: event,
            })),
        }),
    );
    return tracePath;
}

/**
 * The minimum the record builder reads from one isolated execution.
 *
 * @param result - Locked core result backing the execution.
 * @returns The single agentic execution.
 */
function agenticExecution(result: FixRunResult): LocalCoreExecution[] {
    return [{ name: 'agentic', settingsProfile: null, result }];
}

describe('collectKnowledgeGuidanceCitations', () => {
    it('harvests instruction citations whose commit is absent', () => {
        const url = 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters.txt';
        const tracePath = writeTrace([
            {
                tool: 'lookup_rule_guidance',
                result: {
                    topic: 'element_hiding',
                    citations: [
                        {
                            repository: 'uBlockOrigin/uAssets',
                            filePath: 'filters.txt',
                            anchor: 'whole-document',
                            url,
                        },
                    ],
                },
            },
        ]);

        const citations = collectKnowledgeGuidanceCitations(
            agenticExecution(coreWithTrace(tracePath)),
        );

        expect(citations).toEqual([
            {
                topic: 'element_hiding',
                repository: 'uBlockOrigin/uAssets',
                commit: undefined,
                filePath: 'filters.txt',
                anchor: 'whole-document',
                url,
            },
        ]);
    });

    it('drops citation entries that carry no URL locator instead of fabricating one', () => {
        // A checkout-origin instruction document has no citation: its locator is a moving local
        // path and its identity is the source digest. A result shape without a URL therefore
        // names nothing citable, and the harvester must not synthesize repository or path data.
        const tracePath = writeTrace([
            {
                tool: 'lookup_rule_guidance',
                result: {
                    topic: 'placement',
                    citations: [
                        {
                            repository: 'uBlockOrigin/uAssets',
                            filePath: 'filters.txt',
                            anchor: 'whole-document',
                        },
                    ],
                },
            },
        ]);

        const citations = collectKnowledgeGuidanceCitations(
            agenticExecution(coreWithTrace(tracePath)),
        );

        expect(citations).toEqual([]);
    });

    it('deduplicates harvested citations on topic and url', () => {
        const url = 'https://wiki.example.test/Static-filter-syntax';
        const tracePath = writeTrace([
            {
                tool: 'lookup_rule_guidance',
                result: {
                    topic: 'element_hiding',
                    citations: [
                        {
                            repository: 'wiki.example.test',
                            filePath: 'syntax',
                            anchor: 'whole-document',
                            url,
                        },
                    ],
                },
            },
            {
                tool: 'lookup_rule_guidance',
                result: {
                    topic: 'element_hiding',
                    citations: [
                        {
                            repository: 'wiki.example.test',
                            filePath: 'syntax',
                            anchor: 'whole-document',
                            url,
                        },
                    ],
                },
            },
            {
                tool: 'lookup_rule_guidance',
                result: {
                    topic: 'network',
                    citations: [
                        {
                            repository: 'wiki.example.test',
                            filePath: 'syntax',
                            anchor: 'whole-document',
                            url,
                        },
                    ],
                },
            },
        ]);

        const citations = collectKnowledgeGuidanceCitations(
            agenticExecution(coreWithTrace(tracePath)),
        );

        expect(citations).toHaveLength(2);
        expect(citations.map((citation) => citation.topic)).toEqual(['element_hiding', 'network']);
    });

    it('keeps a KnowledgeBase citation with its immutable commit unchanged', () => {
        const knowledgeBaseSha = 'c'.repeat(40);
        const tracePath = writeTrace([
            {
                tool: 'lookup_rule_guidance',
                result: {
                    topic: 'exception',
                    citations: [
                        {
                            repository: 'fork-owner/knowledge-base',
                            commit: knowledgeBaseSha,
                            filePath: 'docs/general/ad-filtering/create-own-filters.md',
                            anchor: 'exception-modifiers',
                            url:
                                'https://github.com/fork-owner/knowledge-base/blob/' +
                                `${knowledgeBaseSha}/docs/general/ad-filtering/` +
                                'create-own-filters.md#exception-modifiers',
                        },
                    ],
                },
            },
        ]);

        const citations = collectKnowledgeGuidanceCitations(
            agenticExecution(coreWithTrace(tracePath)),
        );

        expect(citations).toEqual([
            {
                topic: 'exception',
                repository: 'fork-owner/knowledge-base',
                commit: knowledgeBaseSha,
                filePath: 'docs/general/ad-filtering/create-own-filters.md',
                anchor: 'exception-modifiers',
                url:
                    'https://github.com/fork-owner/knowledge-base/blob/' +
                    `${knowledgeBaseSha}/docs/general/ad-filtering/` +
                    'create-own-filters.md#exception-modifiers',
            },
        ]);
    });

    it('ignores a trace that cannot be read instead of failing the record', () => {
        root = mkdtempSync(join(tmpdir(), 'local-run-record-'));
        const tracePath = join(root, 'unreadable.json');
        writeFileSync(tracePath, '{not json');

        expect(
            collectKnowledgeGuidanceCitations(agenticExecution(coreWithTrace(tracePath))),
        ).toEqual([]);
    });
});

describe('buildLocalRunRecord instruction provenance', () => {
    const instructionProvenance: LocalInstructionProvenance = {
        path: 'AGENTS.md',
        sha256: 'b'.repeat(64),
        documents: [
            {
                role: 'syntax',
                origin: 'url',
                url: 'https://github.com/uBlockOrigin/uBlock/wiki/Static-filter-syntax',
                digest: 'd'.repeat(64),
            },
        ],
    };

    it('rides the instruction provenance into the record when the run loaded one', () => {
        const knowledgeBaseSha = 'c'.repeat(40);
        const tracePath = writeTrace([
            {
                tool: 'lookup_rule_guidance',
                result: { topic: 'element_hiding', citations: [] },
            },
        ]);

        const record = buildLocalRunRecord(
            ExtensionEnvironmentKind.Historical,
            {
                filtersPath: '/tmp/filters',
                checkoutPath: '/tmp/filters-checkout',
                provenance: {
                    environment: ExtensionEnvironmentKind.Historical,
                    source: CheckoutSource.RemoteShallowClone,
                    sourceLocation: 'https://example.test/adguard-filters.git',
                    requestedRevision: 'master',
                    commit: 'f'.repeat(40),
                },
            },
            {
                checkoutPath: '/tmp/knowledge-base',
                guidanceSource: {
                    kind: RuleGuidanceSourceKind.KnowledgeBase,
                    knowledgeBaseCommit: knowledgeBaseSha,
                    filtersCommit: 'f'.repeat(40),
                    knowledgeBaseRepository: 'fork-owner/knowledge-base',
                    filtersRepository: 'fork-owner/adguard-filters',
                    syntaxPath: '/tmp/knowledge-base/create-own-filters.md',
                    policyPath: '/tmp/knowledge-base/filter-policy.md',
                    contributingPath: '/tmp/filters/CONTRIBUTING.md',
                },
                provenance: {
                    environment: 'pinned',
                    source: 'local-shared-clone',
                    sourceLocation: '/tmp/KnowledgeBase',
                    requestedRevision: 'master',
                    commit: knowledgeBaseSha,
                    filtersCommit: 'f'.repeat(40),
                    documents: [
                        'docs/general/ad-filtering/create-own-filters.md',
                        'docs/general/ad-filtering/filter-policy.md',
                        'CONTRIBUTING.md',
                    ],
                },
            },
            agenticExecution(coreWithTrace(tracePath)),
            [],
            coreWithTrace(tracePath),
            instructionProvenance,
        );

        expect(record.provenance.instruction).toEqual(instructionProvenance);
    });

    it('leaves the instruction block absent for a built-in KnowledgeBase run', () => {
        const knowledgeBaseSha = 'c'.repeat(40);
        const tracePath = writeTrace([
            {
                tool: 'lookup_rule_guidance',
                result: { topic: 'element_hiding', citations: [] },
            },
        ]);

        const record = buildLocalRunRecord(
            ExtensionEnvironmentKind.Historical,
            {
                filtersPath: '/tmp/filters',
                checkoutPath: '/tmp/filters-checkout',
                provenance: {
                    environment: ExtensionEnvironmentKind.Historical,
                    source: CheckoutSource.RemoteShallowClone,
                    sourceLocation: 'https://example.test/adguard-filters.git',
                    requestedRevision: 'master',
                    commit: 'f'.repeat(40),
                },
            },
            {
                checkoutPath: '/tmp/knowledge-base',
                guidanceSource: {
                    kind: RuleGuidanceSourceKind.KnowledgeBase,
                    knowledgeBaseCommit: knowledgeBaseSha,
                    filtersCommit: 'f'.repeat(40),
                    knowledgeBaseRepository: 'fork-owner/knowledge-base',
                    filtersRepository: 'fork-owner/adguard-filters',
                    syntaxPath: '/tmp/knowledge-base/create-own-filters.md',
                    policyPath: '/tmp/knowledge-base/filter-policy.md',
                    contributingPath: '/tmp/filters/CONTRIBUTING.md',
                },
                provenance: {
                    environment: 'pinned',
                    source: 'local-shared-clone',
                    sourceLocation: '/tmp/KnowledgeBase',
                    requestedRevision: 'master',
                    commit: knowledgeBaseSha,
                    filtersCommit: 'f'.repeat(40),
                    documents: [
                        'docs/general/ad-filtering/create-own-filters.md',
                        'docs/general/ad-filtering/filter-policy.md',
                        'CONTRIBUTING.md',
                    ],
                },
            },
            agenticExecution(coreWithTrace(tracePath)),
            [],
            coreWithTrace(tracePath),
        );

        expect(record.provenance.instruction).toBeUndefined();
    });

    it('persists and re-reads the instruction provenance through the locked record', () => {
        const knowledgeBaseSha = 'c'.repeat(40);
        const tracePath = writeTrace([
            {
                tool: 'lookup_rule_guidance',
                result: { topic: 'element_hiding', citations: [] },
            },
        ]);
        const baseRecord = buildLocalRunRecord(
            ExtensionEnvironmentKind.Historical,
            {
                filtersPath: '/tmp/filters',
                checkoutPath: '/tmp/filters-checkout',
                provenance: {
                    environment: ExtensionEnvironmentKind.Historical,
                    source: CheckoutSource.RemoteShallowClone,
                    sourceLocation: 'https://example.test/adguard-filters.git',
                    requestedRevision: 'master',
                    commit: 'f'.repeat(40),
                },
            },
            {
                checkoutPath: '/tmp/knowledge-base',
                guidanceSource: {
                    kind: RuleGuidanceSourceKind.KnowledgeBase,
                    knowledgeBaseCommit: knowledgeBaseSha,
                    filtersCommit: 'f'.repeat(40),
                    knowledgeBaseRepository: 'fork-owner/knowledge-base',
                    filtersRepository: 'fork-owner/adguard-filters',
                    syntaxPath: '/tmp/knowledge-base/create-own-filters.md',
                    policyPath: '/tmp/knowledge-base/filter-policy.md',
                    contributingPath: '/tmp/filters/CONTRIBUTING.md',
                },
                provenance: {
                    environment: 'pinned',
                    source: 'local-shared-clone',
                    sourceLocation: '/tmp/KnowledgeBase',
                    requestedRevision: 'master',
                    commit: knowledgeBaseSha,
                    filtersCommit: 'f'.repeat(40),
                    documents: [
                        'docs/general/ad-filtering/create-own-filters.md',
                        'docs/general/ad-filtering/filter-policy.md',
                        'CONTRIBUTING.md',
                    ],
                },
            },
            agenticExecution(coreWithTrace(tracePath)),
            [],
            coreWithTrace(tracePath),
            instructionProvenance,
        );

        root ??= mkdtempSync(join(tmpdir(), 'local-run-record-'));
        writeLocalRunOutput(baseRecord, {
            outputDir: join(root, 'out'),
            // A real directory on every OS: the writer canonicalizes the workspace root with
            // realpath, so a path that exists only on one developer machine fails elsewhere.
            workspaceRoot: process.cwd(),
        });
        const record = readLocalRunOutput(join(root, 'out', 'run-result.json'));

        expect(record.provenance.instruction).toEqual(instructionProvenance);
        expect(readFileSync(join(root, 'out', 'run-result.json'), 'utf8')).toContain('AGENTS.md');
    });
});
