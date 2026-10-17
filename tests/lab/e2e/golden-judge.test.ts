import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReasoningEffort } from '../../../src/config/reasoning-effort';
import { testCoreConfig } from '../../config/test-core-config';
import {
    cachedHumanFixJudgement,
    HumanFixVerdict,
    judgeHumanFix,
    judgeReporterEnvironment,
    replayHumanFixJudgement,
    type GoldenJudgeCaseContext,
} from '../../../lab/e2e/golden-judge';
import {
    classifyGoldenResult,
    GoldenOracleProbeStatus,
    type GoldenOracleProbe,
} from '../../../lab/e2e/golden-comparator';
import type { ExtractedHumanFix } from '../../../lab/e2e/human-commit-oracle';
import type { FixRunResult } from '../../../src/types/fix-run-result';
import type { Report } from '../../../src/intake/report';

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const humanFix: ExtractedHumanFix = {
    commit: 'a'.repeat(40),
    firstParent: 'b'.repeat(40),
    candidates: [
        {
            rule: 'example.com##.banner',
            syntaxKind: 'element_hiding',
            filePath: 'filters.txt',
            repositoryEdit: 'insert',
            sourceRule: 'example.com##.banner',
        },
        {
            rule: 'example.com##.ad',
            syntaxKind: 'element_hiding',
            filePath: 'filters.txt',
            repositoryEdit: 'insert',
            sourceRule: 'example.com##.ad',
        },
    ],
};

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'judge-test-'));
    roots.push(root);
    const issueFile = join(root, 'issue.json');
    writeFileSync(
        issueFile,
        JSON.stringify({
            schemaVersion: 1,
            rawIssue: {
                number: 1,
                url: 'https://github.com/example-owner/example-repo/issues/1',
                title: 'example.com',
                body: 'An advert remains.',
                state: 'closed',
                labels: [],
                assignee: null,
                comments: [],
            },
            reporterComments: [],
            attachments: [],
        }),
    );
    let nowMs = Date.parse('2026-01-01T00:00:00Z');
    const context: GoldenJudgeCaseContext = {
        series: {
            judgeConfig: testCoreConfig({
                llm: {
                    baseUrl: 'https://example.com/v1',
                    model: 'example-judge-model',
                    visionModel: 'example-judge-vision-model',
                },
            }),
            judgeCacheRoot: join(root, 'cache'),
            refreshJudgeCache: false,
        },
        caseName: 'example-case',
        humanFixCommit: humanFix.commit,
        extensionBuild: {
            version: '1.2.3.4',
            releaseTag: 'v1.2.3.1',
            autobuildCommit: 'c'.repeat(40),
        },
        issueFile,
        now: () => nowMs,
    };
    const probe = vi.fn<GoldenOracleProbe>(async () => ({
        status: GoldenOracleProbeStatus.Verified,
        detail: 'The banner disappeared.',
    }));
    const extract = vi.fn(
        async (): Promise<Report> => ({
            siteUrls: ['https://example.com'],
            problemType: 'ads',
            screenshots: [],
            environment: {},
            enabledLists: [],
            userRules: [],
            reproductionSteps: [],
            settingsImportUrl:
                'https://reports.adguard.com/settings/import.html?' +
                'product_version=1.2.3.4&ext.manifest_version=3&regular_filters=2&stealth.enabled=0',
        }),
    );
    return {
        context,
        probe,
        extract,
        advance: (ms: number) => {
            nowMs += ms;
        },
    };
}

describe('golden judge cache', () => {
    it('reuses a fresh human-fix verdict without probing', async () => {
        const { context, probe } = fixture();
        const first = await judgeHumanFix(context, humanFix, probe);
        expect(first.fromCache).toBe(false);
        expect(await judgeHumanFix(context, humanFix, probe)).toEqual({
            ...first,
            fromCache: true,
        });
        expect(probe).toHaveBeenCalledOnce();
    });

    it('rechecks and replaces a cached verified candidate absent from current extraction', async () => {
        const { context, probe } = fixture();
        await judgeHumanFix(context, humanFix, probe);
        const currentHumanFix: ExtractedHumanFix = {
            ...humanFix,
            candidates: [{ ...humanFix.candidates[0]!, rule: 'example.com##.normalized-banner' }],
        };
        const result = await judgeHumanFix(context, currentHumanFix, probe);
        expect(result.fromCache).toBe(false);
        expect(result.judgement).toMatchObject({
            status: HumanFixVerdict.Verified,
            candidate: currentHumanFix.candidates[0],
        });
        expect(probe).toHaveBeenCalledTimes(2);
        expect(cachedHumanFixJudgement(context)).toEqual(result.judgement);
        expect((await judgeHumanFix(context, currentHumanFix, probe)).fromCache).toBe(true);
        expect(probe).toHaveBeenCalledTimes(2);
    });

    it('probes again once the cached verdict is older than seven days', async () => {
        const { context, probe, advance } = fixture();
        await judgeHumanFix(context, humanFix, probe);
        advance(SEVEN_DAYS_MS - 1);
        expect(cachedHumanFixJudgement(context)).not.toBeNull();
        advance(1);
        expect(cachedHumanFixJudgement(context)).toBeNull();
        expect((await judgeHumanFix(context, humanFix, probe)).fromCache).toBe(false);
        expect(probe).toHaveBeenCalledTimes(2);
    });

    it.each(['model', 'vision', 'build', 'reasoning', 'single-shot reasoning'])(
        'misses the verdict cache when a judge setting or the extension build changes: %s',
        async (change) => {
            const { context, probe } = fixture();
            await judgeHumanFix(context, humanFix, probe);
            if (change === 'model') {
                context.series.judgeConfig.llm.model = 'example-other-model';
            }
            if (change === 'vision') {
                context.series.judgeConfig.llm.visionModel = 'example-other-vision';
            }
            if (change === 'reasoning') {
                context.series.judgeConfig.llm.reasoningEffort = ReasoningEffort.Off;
            }
            if (change === 'single-shot reasoning') {
                context.series.judgeConfig.llm.singleShotReasoningEffort = ReasoningEffort.High;
            }
            if (change === 'build') {
                context.extensionBuild.autobuildCommit = 'd'.repeat(40);
            }
            expect((await judgeHumanFix(context, humanFix, probe)).fromCache).toBe(false);
            expect(probe).toHaveBeenCalledTimes(2);
        },
    );

    it('never caches an infrastructure_failure verdict', async () => {
        const { context, probe } = fixture();
        probe.mockResolvedValue({
            status: GoldenOracleProbeStatus.InfrastructureFailure,
            detail: 'Timed out.',
        });
        await judgeHumanFix(context, humanFix, probe);
        expect(cachedHumanFixJudgement(context)).toBeNull();
        await judgeHumanFix(context, humanFix, probe);
        expect(probe).toHaveBeenCalledTimes(4);
    });

    it('keeps the reporter environment past the verdict lifetime', async () => {
        const { context, extract, advance } = fixture();
        const first = await judgeReporterEnvironment(context, extract);
        advance(SEVEN_DAYS_MS + 1);
        expect(await judgeReporterEnvironment(context, extract)).toEqual({
            ...first,
            fromCache: true,
        });
        expect(extract).toHaveBeenCalledOnce();
    });

    it('misses the cached reporter environment when issue.json changes', async () => {
        const { context, extract } = fixture();
        await judgeReporterEnvironment(context, extract);
        writeFileSync(context.issueFile, `${readFileSync(context.issueFile, 'utf8')}\n`);
        expect((await judgeReporterEnvironment(context, extract)).fromCache).toBe(false);
        expect(extract).toHaveBeenCalledTimes(2);
    });

    it('misses a cached human verdict when the issue snapshot changes', async () => {
        const { context, probe } = fixture();
        await judgeHumanFix(context, humanFix, probe);
        writeFileSync(context.issueFile, `${readFileSync(context.issueFile, 'utf8')}\n`);
        expect((await judgeHumanFix(context, humanFix, probe)).fromCache).toBe(false);
        expect(probe).toHaveBeenCalledTimes(2);
    });

    it.each(['reasoning', 'single-shot reasoning'])(
        're-extracts reporter settings after changed judge %s effort',
        async (change) => {
            const { context, extract } = fixture();
            await judgeReporterEnvironment(context, extract);
            if (change === 'reasoning') {
                context.series.judgeConfig.llm.reasoningEffort = ReasoningEffort.Off;
            } else {
                context.series.judgeConfig.llm.singleShotReasoningEffort = ReasoningEffort.High;
            }
            expect((await judgeReporterEnvironment(context, extract)).fromCache).toBe(false);
            expect(extract).toHaveBeenCalledTimes(2);
        },
    );

    it('persists all candidate drift rationales in the conclusive verdict', async () => {
        const { context, probe } = fixture();
        probe
            .mockResolvedValueOnce({
                status: GoldenOracleProbeStatus.NotVerified,
                detail: 'The banner moved.',
            })
            .mockResolvedValueOnce({
                status: GoldenOracleProbeStatus.NotVerified,
                detail: 'The ad remains.',
            });
        await judgeHumanFix(context, humanFix, probe);
        expect(cachedHumanFixJudgement(context)?.detail).toContain(
            'The banner moved. | The ad remains.',
        );
    });

    it('probes and rewrites both records on refresh despite a fresh cache', async () => {
        const { context, extract, probe } = fixture();
        await judgeReporterEnvironment(context, extract);
        await judgeHumanFix(context, humanFix, probe);
        context.series.refreshJudgeCache = true;
        probe.mockResolvedValue({
            status: GoldenOracleProbeStatus.NotVerified,
            detail: 'The site changed.',
        });
        extract.mockResolvedValueOnce({
            ...(await extract()),
            settingsImportUrl:
                'https://reports.adguard.com/settings/import.html?' +
                'product_version=1.2.3.4&ext.manifest_version=3&regular_filters=3&stealth.enabled=0',
        });
        extract.mockClear();
        expect((await judgeReporterEnvironment(context, extract)).fromCache).toBe(false);
        expect((await judgeHumanFix(context, humanFix, probe)).fromCache).toBe(false);
        context.series.refreshJudgeCache = false;
        expect(
            (await judgeReporterEnvironment(context, extract)).environment.enabledFilterIds,
        ).toEqual([3]);
        expect(cachedHumanFixJudgement(context)?.status).toBe(HumanFixVerdict.NotVerified);
        expect(extract).toHaveBeenCalledOnce();
        expect(probe).toHaveBeenCalledTimes(3);
    });

    it.each([true, false])(
        'replays a cached verdict into the same classification as the live probe: %s',
        async (verified) => {
            const { context } = fixture();
            const live: GoldenOracleProbe = async (candidate) => ({
                status:
                    verified && candidate.rule === humanFix.candidates[1]!.rule
                        ? GoldenOracleProbeStatus.Verified
                        : GoldenOracleProbeStatus.NotVerified,
                detail: 'Independent observation.',
            });
            await judgeHumanFix(context, humanFix, live);
            const cached = cachedHumanFixJudgement(context)!;
            const result = {
                candidatePatch: null,
                reasoning: 'No rule proposed.',
                runStatus: 'analysis_only',
                fallbackReason: null,
            } as FixRunResult;
            expect(
                await classifyGoldenResult(result, humanFix, replayHumanFixJudgement(cached)),
            ).toEqual(await classifyGoldenResult(result, humanFix, live));
            if (verified) {
                expect(cached).toMatchObject({ candidate: humanFix.candidates[1] });
            }
        },
    );
});
