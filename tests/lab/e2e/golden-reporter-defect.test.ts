import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SingleShotResultKind, type SingleShotClient } from '../../../src/pi/single-shot-types';
import type { LocalIssueSnapshot } from '../../../src/local/issue-snapshot';
import {
    analyzeGoldenReporterScreenshots,
    buildGoldenReporterDefect,
} from '../../../lab/e2e/golden-reporter-defect';
import {
    HermeticScenario,
    type HermeticProvider,
    ScriptedReplyKind,
    startHermeticProvider,
} from '../../pi/hermetic-provider';
import { VISION_MODEL, createTestVisionClient } from '../../pi/test-runtime';

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
