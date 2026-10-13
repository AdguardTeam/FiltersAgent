import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreConfig } from '../../../src/config/config';
import { SingleShotResultKind, type SingleShotClient } from '../../../src/pi/single-shot-types';
import type { LocalIssueSnapshot } from '../../../src/local/issue-snapshot';
import type { GoldenOracleContext } from '../../../lab/e2e/golden-runner';
import {
    analyzeGoldenReporterScreenshots,
    boundedGoldenOracleProfiles,
    buildOracleRunConfig,
    buildGoldenReporterDefect,
    createGoldenBrowserOracleProbe,
    formatGoldenTargetSiteUnavailable,
    GOLDEN_ORACLE_RETRY_POLICY,
    GoldenTargetSiteUnavailableError,
    resolveGoldenOracleReplacedRule,
} from '../../../lab/e2e/golden-browser-oracle';
import {
    HermeticScenario,
    type HermeticProvider,
    ScriptedReplyKind,
    startHermeticProvider,
} from '../../pi/hermetic-provider';
import { VISION_MODEL, createTestVisionClient } from '../../pi/test-runtime';
import { testCoreConfig } from '../../config/test-core-config';

const coreConfig: CoreConfig = testCoreConfig({
    llm: { apiKey: 'secret', visionModel: 'gemini-3.5-flash' },
});

/**
 * The SingleShotClient stub whose text call serves the content strings.
 *
 * @param response - The text completion served for every call.
 * @returns The stub client.
 */
function textStub(response: string): SingleShotClient {
    return {
        modelId: 'vision-test',
        structured: async () => {
            throw new Error('not used by this suite');
        },
        text: async () => ({
            kind: SingleShotResultKind.Parsed,
            value: response,
            usages: [
                {
                    model: 'vision-test',
                    reported: true,
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    reasoningTokens: 0,
                },
            ],
            attempts: 1,
            model: 'vision-test',
        }),
    };
}

let provider: HermeticProvider | undefined;

afterEach(async () => {
    if (!provider) {
        return;
    }
    await provider.close();
    provider = undefined;
});

const context = {
    candidate: {
        rule: 'nettg.pl##.banner',
        syntaxKind: 'element_hiding',
        filePath: 'BaseFilter/sections/foreign.txt',
        repositoryEdit: 'extend_domains',
    },
} as GoldenOracleContext;

describe('createGoldenBrowserOracleProbe', () => {
    it('maps a real verified visual review to a verified oracle result', async () => {
        const validateHumanCandidate = vi.fn().mockResolvedValue({
            verdict: 'verified',
            coverageComplete: true,
            beforeInstanceCount: 13,
            remainingInstanceCount: 0,
            rationale: 'All repeated leftovers disappeared and the page stayed intact.',
        });
        const probe = createGoldenBrowserOracleProbe(coreConfig, { validateHumanCandidate });

        const result = await probe(context);

        expect(result.status).toBe('verified');
        expect(validateHumanCandidate).toHaveBeenCalledWith(coreConfig, context);
    });

    it('reports environment drift when a complete review rejects the human candidate', async () => {
        const probe = createGoldenBrowserOracleProbe(coreConfig, {
            validateHumanCandidate: async () => ({
                verdict: 'rejected',
                coverageComplete: true,
                beforeInstanceCount: 13,
                remainingInstanceCount: 2,
                rationale: 'Two target leftovers remain.',
            }),
        });

        await expect(probe(context)).resolves.toMatchObject({ status: 'not_verified' });
    });

    it('treats complete absence of the historical symptom as environment drift', async () => {
        const probe = createGoldenBrowserOracleProbe(coreConfig, {
            validateHumanCandidate: async () => ({
                verdict: 'inconclusive',
                coverageComplete: true,
                beforeInstanceCount: 0,
                remainingInstanceCount: 0,
                rationale: 'The target family no longer exists on the live page.',
            }),
        });

        await expect(probe(context)).resolves.toMatchObject({ status: 'not_verified' });
    });

    it('keeps incomplete vision and runtime errors as infrastructure failures', async () => {
        const inconclusive = createGoldenBrowserOracleProbe(coreConfig, {
            validateHumanCandidate: async () => ({
                verdict: 'inconclusive',
                coverageComplete: false,
                beforeInstanceCount: 1,
                remainingInstanceCount: 0,
                rationale: 'Full-page coverage was incomplete.',
            }),
        });
        const failed = createGoldenBrowserOracleProbe(coreConfig, {
            validateHumanCandidate: async () => {
                throw new Error('browser failed');
            },
        });

        await expect(inconclusive(context)).resolves.toMatchObject({
            status: 'infrastructure_failure',
        });
        await expect(failed(context)).resolves.toMatchObject({
            status: 'infrastructure_failure',
            detail: 'browser failed',
        });
    });

    it('classifies target navigation exhaustion as an infrastructure failure', async () => {
        const probe = createGoldenBrowserOracleProbe(coreConfig, {
            validateHumanCandidate: async () => {
                throw new GoldenTargetSiteUnavailableError(
                    'Golden oracle target site remained unreachable after three sessions.',
                );
            },
        });

        await expect(probe(context)).resolves.toEqual({
            status: 'infrastructure_failure',
            detail: 'Golden oracle target site remained unreachable after three sessions.',
        });
    });
});

describe('golden oracle retry policy', () => {
    it('summarizes a refused target without exposing the Playwright call log or URL query', () => {
        const detail = formatGoldenTargetSiteUnavailable(
            'https://sochi.camera/watch?session=secret#player',
            'page.goto: net::ERR_CONNECTION_REFUSED at https://sochi.camera/watch\n' +
                'Call log:\n  - navigating to target',
            3,
            3,
        );

        expect(detail).toBe(
            'Golden oracle could not reach https://sochi.camera/watch from this runner ' +
                '(ERR_CONNECTION_REFUSED in 3/3 browser profiles).',
        );
        expect(detail).not.toContain('Call log');
        expect(detail).not.toContain('secret');
    });

    it('caps the nested browser work at three total navigation attempts', () => {
        const profiles = boundedGoldenOracleProfiles({
            issueNumber: 234715,
            issueUrl: 'https://github.com/AdguardTeam/AdguardFilters/issues/234715',
            reportedSiteUrls: ['https://sochi.camera/'],
            labels: ['T: Anti Adblock Script'],
            problemType: 'anti-adblock',
            product: 'AdGuard Browser Extension v5.4.3.83 MV3',
            os: 'Windows 10',
            browser: 'Chrome',
            enabledFilters: [
                { name: 'AdGuard Russian filter', officialFilterId: 1 },
                { name: 'AdGuard Base filter', officialFilterId: 2 },
            ],
            screenshots: [],
        });

        expect(GOLDEN_ORACLE_RETRY_POLICY).toEqual({
            profileAttempts: 3,
            openPageRetriesPerProfile: 1,
        });
        expect(profiles).toHaveLength(3);
        expect(profiles.length * GOLDEN_ORACLE_RETRY_POLICY.openPageRetriesPerProfile).toBe(3);
    });
});

describe('resolveGoldenOracleReplacedRule', () => {
    it('returns the first-parent rule only for an exact replacement edit', () => {
        const replacedRule = '||ads.example^$domain=example.com';
        const candidate = {
            ...context.candidate,
            rule: '||ads.example^$domain=example.com|~sub.example.com',
            syntaxKind: 'network',
            repositoryEdit: 'replace',
            replacedRule,
        } as GoldenOracleContext['candidate'];

        expect(resolveGoldenOracleReplacedRule(candidate)).toBe(replacedRule);
        expect(resolveGoldenOracleReplacedRule(context.candidate)).toBeUndefined();
    });

    it('rejects malformed replacement metadata before opening a browser', () => {
        expect(() =>
            resolveGoldenOracleReplacedRule({
                ...context.candidate,
                repositoryEdit: 'replace',
                replacedRule: undefined,
            }),
        ).toThrow(/missing.*first-parent rule/i);
        expect(() =>
            resolveGoldenOracleReplacedRule({
                ...context.candidate,
                replacedRule: 'nettg.pl##.old-banner',
            }),
        ).toThrow(/additive candidate/i);
    });
});

describe('buildOracleRunConfig', () => {
    it('accepts a locked pinned-release provenance and carries exact filters provenance', () => {
        const lockedContext = {
            ...context,
            run: {
                schemaVersion: 2,
                issueNumber: 235988,
                issueFile: 'issue/issue.json',
                filtersBaseSha: '0e06526e359cfb83f2883f7005aeee3feb56b653',
            },
            extension: {
                source: 'pinned_release',
                extensionPath: '/tmp/cache/extensions/prebuilt/v5.5.2.3/unpacked',
                manifestVersion: 3,
                extensionSourceSha256: 'e'.repeat(64),
                extensionSourceTag: 'v5.5.2.3',
            },
        } as GoldenOracleContext;

        const config = buildOracleRunConfig(lockedContext);

        // The extension itself comes from production's pinned-release fetcher seam, not from a
        // per-run build configuration; only the historical filters pin rides the locked record.
        expect(config.filters.environment).toEqual({
            kind: 'historical',
            baseSha: '0e06526e359cfb83f2883f7005aeee3feb56b653',
        });
    });

    it('rejects a locked run that never prepared an extension', () => {
        expect(() => buildOracleRunConfig({ ...context, extension: null })).toThrow(
            /extension provenance/i,
        );
    });

    it('rejects a locked run whose provenance is not a pinned-release build', () => {
        expect(() =>
            buildOracleRunConfig({
                ...context,
                extension: {
                    source: 'preloaded',
                    extensionPath: '/tmp/preloaded',
                    manifestVersion: 3,
                    extensionSourceSha256: 'e'.repeat(64),
                },
            }),
        ).toThrow(/pinned-release/i);
    });
});

describe('buildGoldenReporterDefect', () => {
    it('uses raw reporter-owned context rather than final agent reasoning', () => {
        const snapshot = {
            schemaVersion: 1,
            rawIssue: {
                number: 235988,
                url: 'https://github.com/AdguardTeam/AdguardFilters/issues/235988',
                title: 'nettg.pl blank advertising leftovers',
                body: 'The same blank banner appears repeatedly between article cards.',
                state: 'closed',
                labels: ['T: Ads'],
                assignee: null,
                comments: [],
            },
            reporterComments: [
                {
                    author: 'reporter',
                    body: 'The screenshot shows another leftover above NAJNOWSZE.',
                    createdAt: '2026-07-16T08:00:48.000Z',
                },
            ],
            attachments: [],
        } satisfies LocalIssueSnapshot;

        const defect = buildGoldenReporterDefect(snapshot);

        expect(defect).toContain('blank advertising leftovers');
        expect(defect).toContain('repeatedly between article cards');
        expect(defect).toContain('above NAJNOWSZE');
        expect(defect).not.toContain('agent reasoning');
    });

    it('withholds hidden benchmark metadata from the oracle vision prompt', () => {
        const snapshot = {
            schemaVersion: 1,
            rawIssue: {
                number: 235988,
                url: 'https://github.com/AdguardTeam/AdguardFilters/issues/235988',
                title: 'nettg.pl blank advertising leftovers',
                body:
                    'The same blank banner appears repeatedly.\n\n' +
                    '<!-- adguard-agent-benchmark: ' +
                    '{"filtersBaseSha":"0123456789abcdef0123456789abcdef01234567",' +
                    '"humanFixCommit":"89abcdef0123456789abcdef0123456789abcdef"} -->',
                state: 'closed',
                labels: ['T: Ads'],
                assignee: null,
                comments: [],
            },
            reporterComments: [],
            attachments: [],
        } satisfies LocalIssueSnapshot;

        const defect = buildGoldenReporterDefect(snapshot);

        expect(defect).toContain('The same blank banner appears repeatedly.');
        expect(defect).not.toContain('adguard-agent-benchmark');
        expect(defect).not.toContain('humanFixCommit');
        expect(defect).not.toContain('89abcdef0123456789abcdef0123456789abcdef');
    });

    it('places an independent reporter screenshot observation before issue prose', async () => {
        const root = mkdtempSync(join(tmpdir(), 'golden-reporter-screenshot-'));
        const screenshotPath = join(root, 'reporter.png');
        const bytes = Buffer.from('reporter screenshot');
        writeFileSync(screenshotPath, bytes);
        const snapshot = {
            schemaVersion: 1,
            rawIssue: {
                number: 235988,
                url: 'https://github.com/AdguardTeam/AdguardFilters/issues/235988',
                title: 'nettg.pl blank advertising leftovers',
                body: 'The page contains an empty area.',
                state: 'closed',
                labels: ['T: Ads'],
                assignee: null,
                comments: [],
            },
            reporterComments: [],
            attachments: [
                {
                    kind: 'issue_screenshot',
                    sourceUrl: null,
                    localPath: screenshotPath,
                    sha256: createHash('sha256').update(bytes).digest('hex'),
                    promptVisible: true,
                    source: 'body',
                },
            ],
        } satisfies LocalIssueSnapshot;
        const vision = textStub(
            'A large empty advertising gap is visible between two article sections.',
        );
        try {
            const observations = await analyzeGoldenReporterScreenshots(snapshot, vision);
            const defect = buildGoldenReporterDefect(snapshot, observations);

            expect(observations).toHaveLength(1);
            expect(defect.indexOf('Reporter screenshot 1')).toBeLessThan(
                defect.indexOf('Reporter issue title'),
            );
            expect(defect).toContain('large empty advertising gap');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('analyzeGoldenReporterScreenshots on the single-shot client', () => {
    const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
    );

    function screenshotSnapshot(root: string): LocalIssueSnapshot {
        const screenshotPath = join(root, 'reporter.png');
        writeFileSync(screenshotPath, pngBytes);
        return {
            schemaVersion: 1,
            rawIssue: {
                number: 235988,
                url: 'https://github.com/AdguardTeam/AdguardFilters/issues/235988',
                title: 'nettg.pl blank advertising leftovers',
                body: 'The page contains an empty area.',
                state: 'closed',
                labels: ['T: Ads'],
                assignee: null,
                comments: [],
            },
            reporterComments: [],
            attachments: [
                {
                    kind: 'issue_screenshot',
                    sourceUrl: null,
                    localPath: screenshotPath,
                    sha256: createHash('sha256').update(pngBytes).digest('hex'),
                    promptVisible: true,
                    source: 'body',
                },
            ],
        };
    }

    it('describes reporter screenshots through the bound client with an image part on the wire', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                {
                    kind: ScriptedReplyKind.Text,
                    text: 'rendered ad banner top',
                },
            ],
        });
        const root = mkdtempSync(join(tmpdir(), 'golden-oracle-hermetic-'));
        try {
            const observations = await analyzeGoldenReporterScreenshots(
                screenshotSnapshot(root),
                await createTestVisionClient(provider.baseUrl),
            );

            expect(observations).toEqual([
                {
                    sha256: createHash('sha256').update(pngBytes).digest('hex'),
                    analysis: 'rendered ad banner top',
                },
            ]);
            const request = provider.requests[0]!;
            expect(request.model).toBe(VISION_MODEL);
            const wire = JSON.stringify(request.messages);
            expect(wire).toContain('image_url');
            expect(wire).toContain('data:image/png;base64,');
            expect(wire).toContain('Describe only visible reporter evidence');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('throws the empty-analysis error for a blank reply', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [{ kind: ScriptedReplyKind.Text, text: '   ' }],
        });
        const root = mkdtempSync(join(tmpdir(), 'golden-oracle-hermetic-blank-'));
        try {
            await expect(
                analyzeGoldenReporterScreenshots(
                    screenshotSnapshot(root),
                    await createTestVisionClient(provider.baseUrl),
                ),
            ).rejects.toThrow('empty reporter screenshot analysis');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('propagates a provider failure as a typed throw naming the provider message', async () => {
        provider = await startHermeticProvider({ scenario: HermeticScenario.AuthError });
        const root = mkdtempSync(join(tmpdir(), 'golden-oracle-hermetic-auth-'));
        try {
            await expect(
                analyzeGoldenReporterScreenshots(
                    screenshotSnapshot(root),
                    await createTestVisionClient(provider.baseUrl),
                ),
            ).rejects.toThrow('auth failed');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
