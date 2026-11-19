import { pino } from 'pino';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolRegistry } from '../../src/agent/tool-factory';
import type { GithubReadConfig, RawIssue } from '../../src/github/fetch-issue';
import { ConsoleCoverage, type IBrowserSession } from '../../src/browser/browser-interfaces';
import type { SiteAnalyzer } from '../../src/analyzer/site-analyzer';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import { buildRegistrySessionTools } from '../../src/session/registry-session-tools';
import { ToolName } from '../../src/agent/tool-names';
import {
    GuidanceDocumentOrigin,
    GuidanceDocumentRole,
    RuleGuidanceSourceKind,
} from '../../src/knowledge/guidance-source';
import { toAdvertisedSchema } from '../../src/pi/tool-schema';
import { DEFAULT_SAFE_INTERACTION_BOUNDS } from '../../src/environment/safe-interaction';
import { VISION_TOOL_DEADLINE_MS } from '../../src/agent/vision-tool-deadline';
import { createSingleShotClient } from '../../src/pi/single-shot';
import { SingleShotResultKind, type SingleShotClient } from '../../src/pi/single-shot-types';
import {
    HermeticScenario,
    type HermeticProvider,
    ScriptedReplyKind,
    startHermeticProvider,
} from '../pi/hermetic-provider';
import { VISION_MODEL, createTestPiRuntime } from '../pi/test-runtime';
import { MIN_SORTED_SECTION_RULES } from '../../src/repo/sorted-insertion';
import { FILE_WINDOW_RADIUS_LINES } from '../../src/repo/search';
import {
    MAX_OUTLINE_HEADER_BYTES,
    MAX_OUTLINE_LABEL_BYTES,
    MAX_WINDOW_LINE_BYTES,
} from '../../src/agent/rule-search-compact';
import { MAX_TOOL_RESULT_BYTES } from '../../src/pi/tool-result-envelope';

const githubConfig: GithubReadConfig = {
    owner: 'AdguardTeam',
    repo: 'AdguardFilters',
    token: 'test-token',
};

/**
 * 1x1 transparent PNG, the smallest valid image part for wire assertions.
 */
const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * A SingleShotClient stub whose structured call resolves to one fixed result.
 *
 * @param result - The structured result served for every call.
 * @returns The stub client.
 */
const visionStub = (result: unknown): SingleShotClient => ({
    modelId: 'vision-stub',
    structured: async () => result as never,
    text: async () => {
        throw new Error('not used by this suite');
    },
});

/**
 * A 1x1 PNG written into a fresh temp directory; returns the dir and the file path.
 */
function pngFixture(): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), 'tool-factory-vision-'));
    const path = join(dir, 'shot.png');
    writeFileSync(path, Buffer.from(PNG_1PX, 'base64'));
    return { dir, path };
}

let provider: HermeticProvider | undefined;

afterEach(async () => {
    if (!provider) {
        return;
    }
    await provider.close();
    provider = undefined;
});

/**
 * Write the pinned guidance documents with every section the allowlisted topics resolve.
 *
 * The guidance session validates the whole allowlist at construction so a renamed upstream heading
 * fails before any model spend; any registry test with a KnowledgeBase source needs these files.
 *
 * @param syntaxPath - Destination for the pinned syntax document.
 * @param policyPath - Destination for the pinned policy document.
 * @param contributingPath - Destination for the contributing guide.
 */
function writePinnedGuidanceDocuments(
    syntaxPath: string,
    policyPath: string,
    contributingPath: string,
): void {
    writeFileSync(
        syntaxPath,
        [
            '### Basic rule syntax {#basic-rules-syntax}',
            'Network rule guidance.',
            '### Element hiding rules {#cosmetic-elemhide-rules}',
            'Use domain-scoped ## first.',
            '### CSS rules {#cosmetic-css-rules}',
            'Use CSS only when hiding is insufficient.',
            '### Extended CSS selectors {#extended-css-selectors}',
            'Extended selector guidance.',
            '### Scriptlet rules {#scriptlets}',
            'Scriptlet guidance.',
            '### Exception rules modifiers {#exception-modifiers}',
            'Exception rules begin with @@.',
            '### Restrictions and limitations',
            'Platform restrictions.',
            '### Compatibility tables legend {#compatibility-tables-legend}',
            'Compatibility guidance.',
        ].join('\n'),
    );
    writeFileSync(policyPath, '## Common criteria\nDo not break pages.\n');
    writeFileSync(
        contributingPath,
        [
            '## Rule placement',
            'Inspect similar rules.',
            '## Repository structure',
            'Use the proper section.',
        ].join('\n') + '\n',
    );
}

/**
 * A temp checkout holding one list file, with the registry that searches it.
 *
 * @param prefix - Prefix of the temp directory name.
 * @param relativePath - Checkout-relative path of the list file.
 * @param lines - Exact lines of the file; a trailing newline is added.
 * @returns The registry over the checkout and the checkout root the test must remove.
 */
async function searchCheckout(
    prefix: string,
    relativePath: string,
    lines: readonly string[],
): Promise<{ registry: Awaited<ReturnType<typeof createToolRegistry>>; root: string }> {
    const root = mkdtempSync(join(tmpdir(), prefix));
    mkdirSync(join(root, relativePath, '..'), { recursive: true });
    writeFileSync(join(root, relativePath), `${lines.join('\n')}\n`, 'utf8');
    const registry = await createToolRegistry({
        githubConfig: githubConfig,
        allowedIssueNumber: 1,
        checkoutPath: root,
    });
    return { registry, root };
}

describe('createToolRegistry', () => {
    it('serves a local issue snapshot without GitHub credentials', async () => {
        const localIssue: RawIssue = {
            number: 42,
            url: 'https://github.com/AdguardTeam/AdguardFilters/issues/42',
            title: 'Local issue fixture',
            body: 'Website: https://example.com\nAdGuard Browser Extension',
            state: 'open',
            labels: ['T: Ads', 'N: AdGuard Browser Extension'],
            assignee: null,
            comments: [],
        };
        const registry = await createToolRegistry({
            allowedIssueNumber: 42,
            localIssueTools: { localIssue },
        });

        const result = await registry.dispatch('fetch_issue', { issueNumber: 42 });

        expect(result.raw).toEqual(localIssue);
    });

    it('withholds benchmark metadata from a locally supplied fetch_issue payload', async () => {
        const filtersBaseSha = '0123456789abcdef0123456789abcdef01234567';
        const humanFixCommit = '89abcdef0123456789abcdef0123456789abcdef';
        const localIssue: RawIssue = {
            number: 42,
            url: 'https://github.com/AdguardTeam/AdguardFilters/issues/42',
            title: 'Local issue fixture',
            body:
                'Website: https://example.com\n' +
                `<!-- adguard-agent-benchmark: {"filtersBaseSha":"${filtersBaseSha}","humanFixCommit":"${humanFixCommit}"} -->`,
            state: 'open',
            labels: ['T: Ads', 'N: AdGuard Browser Extension'],
            assignee: null,
            comments: [],
        };
        const registry = await createToolRegistry({
            allowedIssueNumber: 42,
            localIssueTools: { localIssue },
        });

        const result = await registry.dispatch('fetch_issue', { issueNumber: 42 });
        const promptSafeRaw = result.raw as RawIssue;

        expect(promptSafeRaw.body).toBe('Website: https://example.com');
        expect(JSON.stringify(result)).not.toContain(humanFixCommit);
        expect(localIssue.body).toContain(humanFixCommit);
    });

    it('registers the pure fetch_issue tool always and no lint_rule without a lint command', async () => {
        const registry = await createToolRegistry({
            githubConfig: githubConfig,
            allowedIssueNumber: 1,
        });
        const names = registry
            .getDefinitions()
            .map((d) => d.function.name)
            .sort();
        expect(names).toEqual(['fetch_issue']);
    });

    it('registers checkout-dependent tools when checkoutPath is provided', async () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'tool-factory-test-'));
        try {
            mkdirSync(join(tmpDir, 'BaseFilter', 'sections'), { recursive: true });
            writeFileSync(join(tmpDir, 'BaseFilter', 'sections', 'general_url.txt'), '');
            const registry = await createToolRegistry({
                githubConfig: githubConfig,
                allowedIssueNumber: 1,
                checkoutPath: tmpDir,
            });
            const names = registry
                .getDefinitions()
                .map((d) => d.function.name)
                .sort();
            expect(names).toEqual(['fetch_issue', 'search_rules']);
            const searchTool = registry
                .getDefinitions()
                .find((definition) => definition.function.name === 'search_rules');
            expect(searchTool?.function.description).toMatch(
                /compound modifier selector.*stable base selector.*before retry/is,
            );
            expect(searchTool?.function.description).toMatch(
                /multi-domain base rule.*use.*extend/is,
            );
            expect(searchTool?.function.description).toMatch(
                /exact.*base.*element-hiding.*validate.*domain-scoped.*##.*before.*modifier/is,
            );
            expect(searchTool?.function.description).toMatch(
                /reported domain.*absent.*expected.*extend_domains.*not.*ignore/is,
            );
        } finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('bounds selector inventory and ranks it using the trusted reported domain', async () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'tool-factory-search-rank-'));
        try {
            mkdirSync(join(tmpDir, 'BaseFilter', 'sections'), { recursive: true });
            writeFileSync(
                join(tmpDir, 'BaseFilter', 'sections', 'foreign.txt'),
                [
                    ...Array.from({ length: 30 }, (_, index) => `unrelated-${index}.com##.banner`),
                    'morizon.pl,prawo.pl,telepolis.pl##.banner',
                    '',
                ].join('\n'),
            );
            const registry = await createToolRegistry({
                githubConfig: githubConfig,
                allowedIssueNumber: 1,
                checkoutPath: tmpDir,
                browserTools: {
                    session: {} as IBrowserSession,
                    analyzer: {} as SiteAnalyzer,
                    artifactsDir: tmpDir,
                    logger: pino({ level: 'silent' }),
                    recorder: new TraceRecorder({
                        runId: 'search-rank-test',
                        issueNumber: 1,
                        mode: 'fix',
                    }),
                    allowedOrigin: 'https://nettg.pl/reported-page',
                },
            });

            const result = await registry.dispatch('search_rules', { selector: '.banner' });

            expect(result).toMatchObject({
                effectiveDomain: 'nettg.pl',
                totalMatches: 31,
                truncated: true,
            });
            const matches = result.matches as Array<Record<string, unknown>>;
            expect(matches).toHaveLength(20);
            expect(matches[0]).toMatchObject({
                rule: 'morizon.pl,prawo.pl,telepolis.pl##.banner',
                filePath: 'BaseFilter/sections/foreign.txt',
            });
        } finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('returns a grouped bounded domain inventory and keeps complete matches available by detail', async () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'tool-factory-domain-inventory-'));
        try {
            mkdirSync(join(tmpDir, 'BaseFilter', 'sections'), { recursive: true });
            writeFileSync(
                join(tmpDir, 'BaseFilter', 'sections', 'foreign.txt'),
                [
                    'example.com##.sponsor',
                    "example.com#%#//scriptlet('abort-on-property-read', 'adConfig')",
                    // uBO spells the same injection `##+js(...)`; it belongs under `scriptlet`,
                    // not under the element-hiding count its separator would suggest.
                    'example.com##+js(set-constant, aipAPItag.sdkBlocked, false)',
                    '||ads.example.com^$domain=example.com',
                    ...Array.from({ length: 20 }, (_, index) => `example.com##.banner-${index}`),
                    '',
                ].join('\n'),
            );
            const recorder = new TraceRecorder({
                runId: 'domain-inventory-test',
                issueNumber: 1,
                mode: 'fix',
            });
            const registry = await createToolRegistry({
                githubConfig: githubConfig,
                allowedIssueNumber: 1,
                checkoutPath: tmpDir,
                visionTools: {
                    artifactsDir: tmpDir,
                    recorder,
                    vision: visionStub({}),
                },
            });

            const result = await registry.dispatch('search_rules', { domain: 'example.com' });

            expect(result).toMatchObject({
                effectiveDomain: 'example.com',
                totalMatches: 24,
                truncated: true,
                groupedInventory: {
                    cosmetic: 21,
                    network: 1,
                    scriptlet: 2,
                },
                topMatches: expect.any(Array),
                artifactId: expect.any(String),
            });
            expect(result.topMatches).toHaveLength(8);
            expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(6 * 1024);

            const detail = await registry.dispatch('get_detail', {
                artifactId: result.artifactId,
                filter: { key: 'matches', limit: 1 },
            });
            expect(JSON.parse(String(detail.content))).toHaveLength(1);
            expect(recorder.getArtifacts()).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        id: result.artifactId,
                        type: 'rule-search-inventory',
                    }),
                ]),
            );
        } finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('uses a runner-bound reported domain for offline repository search', async () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'tool-factory-offline-search-rank-'));
        const localIssue: RawIssue = {
            number: 1,
            url: 'https://github.com/AdguardTeam/AdguardFilters/issues/1',
            title: 'Local selector issue',
            body: 'Website: https://nettg.pl/',
            state: 'open',
            labels: ['T: Ads'],
            assignee: null,
            comments: [],
        };
        try {
            mkdirSync(join(tmpDir, 'BaseFilter', 'sections'), { recursive: true });
            writeFileSync(
                join(tmpDir, 'BaseFilter', 'sections', 'foreign.txt'),
                ['unrelated.com##.banner', 'morizon.pl,prawo.pl,telepolis.pl##.banner', ''].join(
                    '\n',
                ),
            );
            const registry = await createToolRegistry({
                allowedIssueNumber: 1,
                checkoutPath: tmpDir,
                localIssueTools: { localIssue, reportedDomain: 'nettg.pl' },
            });

            const result = await registry.dispatch('search_rules', { selector: '.banner' });
            const matches = result.matches as Array<Record<string, unknown>>;

            expect(result.effectiveDomain).toBe('nettg.pl');
            expect(matches[0]).toMatchObject({
                rule: 'morizon.pl,prawo.pl,telepolis.pl##.banner',
                filePath: 'BaseFilter/sections/foreign.txt',
            });
        } finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('passes filePath and line through search_rules to the outline and the window', async () => {
        const { registry, root } = await searchCheckout(
            'tool-factory-search-outline-',
            'BaseFilter/sections/foreign.txt',
            [
                '! Title: Example list',
                '! SECTION: Example widgets',
                '! NOTE: Regular rules',
                'example.org##.first',
                'example.org##.second',
                '! !SECTION: Example widgets',
            ],
        );
        try {
            const typedPath = 'BaseFilter\\sections\\foreign.txt';
            const path = 'BaseFilter/sections/foreign.txt';

            const outline = await registry.dispatch('search_rules', { filePath: typedPath });
            const window = await registry.dispatch('search_rules', {
                filePath: typedPath,
                line: 4,
            });

            expect(outline).toMatchObject({
                filePath: path,
                lineCount: 6,
                header: '! Title: Example list',
                markers: [
                    { l: 2, k: 'section', t: '! SECTION: Example widgets' },
                    { l: 3, k: 'note', t: '! NOTE: Regular rules', r: 2 },
                    { l: 6, k: 'section_end', t: '! !SECTION: Example widgets' },
                ],
            });
            expect(window).toMatchObject({
                filePath: path,
                lineCount: 6,
                lines: [
                    { line: 1, text: '! Title: Example list' },
                    { line: 2, text: '! SECTION: Example widgets' },
                    { line: 3, text: '! NOTE: Regular rules' },
                    { line: 4, text: 'example.org##.first' },
                    { line: 5, text: 'example.org##.second' },
                    { line: 6, text: '! !SECTION: Example widgets' },
                ],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('refuses a line without a filePath and a read mixed with a target', async () => {
        const { registry, root } = await searchCheckout(
            'tool-factory-search-line-',
            'BaseFilter/sections/foreign.txt',
            [],
        );
        try {
            await expect(registry.dispatch('search_rules', { line: 3 })).rejects.toThrow(
                /outline.*window.*match/is,
            );
            await expect(
                registry.dispatch('search_rules', {
                    selector: '.ad',
                    filePath: 'BaseFilter/sections/foreign.txt',
                    line: 3,
                }),
            ).rejects.toThrow(/outline.*window.*match/is);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('names the outline, window and match modes for a call with no arguments', async () => {
        const { registry, root } = await searchCheckout(
            'tool-factory-search-empty-',
            'BaseFilter/sections/foreign.txt',
            [],
        );
        try {
            await expect(registry.dispatch('search_rules', {})).rejects.toThrow(
                /outline.*window.*match/is,
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('refuses a line that is not a positive integer', async () => {
        const { registry, root } = await searchCheckout(
            'tool-factory-search-line-shape-',
            'BaseFilter/sections/foreign.txt',
            ['example.org##.ad'],
        );
        try {
            for (const line of [0, 1.5]) {
                await expect(
                    registry.dispatch('search_rules', {
                        filePath: 'BaseFilter/sections/foreign.txt',
                        line,
                    }),
                ).rejects.toThrow();
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('cuts an overlong window line and flags it', async () => {
        const overlong = `example.com##.${'a'.repeat(MAX_WINDOW_LINE_BYTES)}`;
        const { registry, root } = await searchCheckout(
            'tool-factory-search-window-cut-',
            'BaseFilter/sections/foreign.txt',
            ['! SECTION: Long rule', overlong],
        );
        try {
            const window = await registry.dispatch('search_rules', {
                filePath: 'BaseFilter/sections/foreign.txt',
                line: 2,
            });
            const lines = window.lines as Array<{
                line: number;
                text: string;
                truncated?: boolean;
            }>;

            expect(lines[1]).toMatchObject({ line: 2, truncated: true });
            expect(Buffer.byteLength(lines[1]!.text, 'utf8')).toBe(MAX_WINDOW_LINE_BYTES);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('keeps section headings that differ only late in the line apart', async () => {
        const { registry, root } = await searchCheckout(
            'tool-factory-search-labels-',
            'BaseFilter/sections/foreign.txt',
            [
                '! SECTION: Cookies - Specific rules (JS)',
                '! SECTION: Cookies - Specific rules (HTML)',
                '! SECTION: Cookies - Specific rules (replace)',
            ],
        );
        try {
            const outline = await registry.dispatch('search_rules', {
                filePath: 'BaseFilter/sections/foreign.txt',
            });
            const markers = outline.markers as Array<Record<string, unknown>>;

            expect(markers.map((marker) => marker.t)).toEqual([
                '! SECTION: Cookies - Specific rules (JS)',
                '! SECTION: Cookies - Specific rules (HTML)',
                '! SECTION: Cookies - Specific rules (replace)',
            ]);
            expect(markers.every((marker) => marker.tt === undefined)).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('shows a banner label with the framing stripped from both ends', async () => {
        const { registry, root } = await searchCheckout(
            'tool-factory-search-banner-',
            'BaseFilter/sections/foreign.txt',
            ['!------- JS rules ---------------------!', 'example.org##.ad'],
        );
        try {
            const outline = await registry.dispatch('search_rules', {
                filePath: 'BaseFilter/sections/foreign.txt',
            });
            const markers = outline.markers as Array<Record<string, unknown>>;

            expect(markers[0]).toMatchObject({ k: 'banner', t: 'JS rules' });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('returns every marker of an outline past the old count cap', async () => {
        const markerCount = 687;
        const lines: string[] = [];
        for (let marker = 0; marker < markerCount; marker += 1) {
            lines.push(`!#else m${String(marker).padStart(3, '0')}`);
            lines.push('||ads.example^');
        }
        const { registry, root } = await searchCheckout(
            'tool-factory-search-outline-labels-',
            'BaseFilter/sections/foreign.txt',
            lines,
        );
        try {
            const outline = await registry.dispatch('search_rules', {
                filePath: 'BaseFilter/sections/foreign.txt',
            });

            expect(outline.markers).toHaveLength(markerCount);
            expect(outline.truncated).toBeUndefined();
            expect(Buffer.byteLength(JSON.stringify(outline), 'utf8')).toBeLessThanOrEqual(
                MAX_TOOL_RESULT_BYTES,
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('keeps a worst-case outline under the tool result limit by dropping markers', async () => {
        const markerCount = 1000;
        const lines: string[] = [];
        for (let marker = 0; marker < markerCount; marker += 1) {
            lines.push(`!#else ${'"\\'.repeat(200)}`);
            for (let rule = 1; rule <= MIN_SORTED_SECTION_RULES; rule += 1) {
                lines.push(`||ads-${String(rule).padStart(2, '0')}.example^`);
            }
        }
        const { registry, root } = await searchCheckout(
            'tool-factory-search-outline-cap-',
            'BaseFilter/sections/foreign.txt',
            lines,
        );
        try {
            const outline = await registry.dispatch('search_rules', {
                filePath: 'BaseFilter/sections/foreign.txt',
            });
            const markers = outline.markers as Array<Record<string, unknown>>;

            expect(outline.truncated).toBe(true);
            expect(markers.length).toBeGreaterThan(0);
            expect(markers.length).toBeLessThan(markerCount);
            expect(markers[0]).toMatchObject({ k: 'condition', r: 20, s: true, tt: true });
            expect(Buffer.byteLength(String(markers[0]!.t), 'utf8')).toBe(MAX_OUTLINE_LABEL_BYTES);
            expect(Buffer.byteLength(JSON.stringify(outline), 'utf8')).toBeLessThanOrEqual(
                MAX_TOOL_RESULT_BYTES,
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('returns the leading comment header and skips the list header', async () => {
        const { registry, root } = await searchCheckout(
            'tool-factory-search-header-',
            'BaseFilter/sections/foreign.txt',
            [
                '[Adblock Plus 2.0]',
                '',
                '! Title: Example list',
                '! Good: advertising rules',
                '! Bad: tracking rules (should be in tracking.txt)',
                '||ads.example^',
            ],
        );
        try {
            const outline = await registry.dispatch('search_rules', {
                filePath: 'BaseFilter/sections/foreign.txt',
            });

            expect(outline.header).toBe(
                [
                    '! Title: Example list',
                    '! Good: advertising rules',
                    '! Bad: tracking rules (should be in tracking.txt)',
                ].join('\n'),
            );
            expect(outline.headerTruncated).toBeUndefined();
            expect(outline.leading).toMatchObject({ r: 1 });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('caps a long header, flags it, and stays under the limit with no markers', async () => {
        const { registry, root } = await searchCheckout(
            'tool-factory-search-header-cap-',
            'BaseFilter/sections/foreign.txt',
            [`! ${'a'.repeat(MAX_OUTLINE_HEADER_BYTES * 2)}`],
        );
        try {
            const outline = await registry.dispatch('search_rules', {
                filePath: 'BaseFilter/sections/foreign.txt',
            });

            expect(outline.markers).toEqual([]);
            expect(outline.headerTruncated).toBe(true);
            expect(Buffer.byteLength(String(outline.header), 'utf8')).toBe(
                MAX_OUTLINE_HEADER_BYTES,
            );
            expect(Buffer.byteLength(JSON.stringify(outline), 'utf8')).toBeLessThanOrEqual(
                MAX_TOOL_RESULT_BYTES,
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('keeps a full window under the tool result limit', async () => {
        const fullLine = '"\\'.repeat(MAX_WINDOW_LINE_BYTES / 2);
        const { registry, root } = await searchCheckout(
            'tool-factory-search-window-cap-',
            'BaseFilter/sections/foreign.txt',
            Array.from({ length: 40 }, () => fullLine),
        );
        try {
            const window = await registry.dispatch('search_rules', {
                filePath: 'BaseFilter/sections/foreign.txt',
                line: 20,
            });

            expect(window.lines).toHaveLength(2 * FILE_WINDOW_RADIUS_LINES + 1);
            expect(Buffer.byteLength(JSON.stringify(window), 'utf8')).toBeLessThanOrEqual(
                MAX_TOOL_RESULT_BYTES,
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('shrinks the per-line cap so escaped control characters fit the tool result limit', async () => {
        // JSON writes a control character as a six-byte `\u0001` escape, so a window of
        // MAX_WINDOW_LINE_BYTES-long control lines is six times its raw bytes once serialized.
        const controlLine = '\u0001'.repeat(MAX_WINDOW_LINE_BYTES);
        const windowLineCount = 2 * FILE_WINDOW_RADIUS_LINES + 1;
        const { registry, root } = await searchCheckout(
            'tool-factory-search-window-escaped-',
            'BaseFilter/sections/foreign.txt',
            Array.from({ length: windowLineCount }, () => controlLine),
        );
        try {
            const window = await registry.dispatch('search_rules', {
                filePath: 'BaseFilter/sections/foreign.txt',
                line: FILE_WINDOW_RADIUS_LINES + 1,
            });
            const lines = window.lines as Array<{
                line: number;
                text: string;
                truncated?: boolean;
            }>;

            expect(Buffer.byteLength(JSON.stringify(window), 'utf8')).toBeLessThanOrEqual(
                MAX_TOOL_RESULT_BYTES,
            );
            // No numbered line is dropped to buy the bytes: the whole window is still there, each
            // line cut further than the initial cap and flagged as cut.
            expect(lines.map((entry) => entry.line)).toEqual(
                Array.from({ length: windowLineCount }, (_unused, index) => index + 1),
            );
            expect(lines.every((entry) => entry.truncated === true)).toBe(true);
            expect(
                lines.every(
                    (entry) => Buffer.byteLength(entry.text, 'utf8') < MAX_WINDOW_LINE_BYTES,
                ),
            ).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('does NOT register checkout tools when checkoutPath is undefined', async () => {
        const registry = await createToolRegistry({
            githubConfig: githubConfig,
            allowedIssueNumber: 1,
        });
        await expect(registry.dispatch('search_rules', { domain: 'test.com' })).rejects.toThrow(
            'Tool not found',
        );
    });

    it('registers the typed ad-slot inspector and all browser tools', async () => {
        const mockSession: IBrowserSession = {
            getPage: () => {
                throw new Error('not implemented');
            },
            close: async () => {},
            getNetworkLog: () => [],
            resetNetworkLog: () => {},
            getConsoleLog: () => [],
            consoleCoverage: ConsoleCoverage.BrowserLogOnly,
            artifactsDir: '/tmp',
            isClosed: false,
        };
        const mockAnalyzer = {
            addFinding: () => {},
            getFindings: () => [],
            clearFindings: () => {},
            analyze: async () => ({
                url: '',
                reproProfile: {
                    viewport: 'desktop' as const,
                    locale: 'en-US',
                    timezone: 'UTC',
                    userAgentProfile: 'Chrome',
                    consentStrategy: 'untouched' as const,
                },
                screenshots: [],
                findings: [],
                matchedIssueScreenshots: [],
                unreachable: true,
            }),
        } as unknown as SiteAnalyzer;
        const registry = await createToolRegistry({
            githubConfig: githubConfig,
            allowedIssueNumber: 1,
            browserTools: {
                session: mockSession,
                analyzer: mockAnalyzer,
                artifactsDir: '/tmp',
                logger: pino({ level: 'silent' }),
                recorder: new TraceRecorder({
                    runId: 'test',
                    issueNumber: 1,
                    mode: 'fix',
                }),
                allowedOrigin: 'https://example.com',
            },
        });
        const names = registry
            .getDefinitions()
            .map((d) => d.function.name)
            .sort();
        const expected = [
            'apply_rule',
            'evaluate_js',
            'fetch_issue',
            'get_console_log',
            'get_detail',
            'get_dom',
            'get_network_log',
            'inspect_ad_slots',
            'inspect_page_state',
            'interact_page',
            'open_page',
            'report_finding',
            'screenshot',
            'stabilize_page',
        ];
        expect(names).toEqual(expected);

        const getNetworkLog = registry
            .getDefinitions()
            .find((definition) => definition.function.name === 'get_network_log');
        expect(getNetworkLog?.function.description).toMatch(/evidenceRef.*artifact:har:<id>/is);

        const inspectAdSlots = registry
            .getDefinitions()
            .find((definition) => definition.function.name === 'inspect_ad_slots');
        expect(inspectAdSlots?.function.parameters).toEqual({
            type: 'object',
            properties: {},
            required: [],
        });
        expect(inspectAdSlots?.function.description).toMatch(/fixed.*read-only.*isolated/is);
        expect(inspectAdSlots?.function.description).toMatch(
            /id.*classes.*untrusted.*never.*instructions/is,
        );

        const evaluateJs = registry
            .getDefinitions()
            .find((definition) => definition.function.name === 'evaluate_js');
        expect(evaluateJs?.function.description).toMatch(
            /read-only.*assignments.*DOM\/browser mutations.*rejected/is,
        );

        const stabilizePage = registry
            .getDefinitions()
            .find((definition) => definition.function.name === 'stabilize_page');
        expect(stabilizePage?.function.parameters.required).toEqual([]);
        expect(stabilizePage?.function.parameters.properties).toHaveProperty('targetSelector');
        expect(stabilizePage?.function.parameters.properties).toHaveProperty('targetHint');
        expect(stabilizePage?.function.description).toMatch(/missing target.*does not.*retr/is);

        const applyRule = registry
            .getDefinitions()
            .find((definition) => definition.function.name === 'apply_rule');
        expect(applyRule?.function.parameters.required).toEqual(['candidateRule']);
        expect(applyRule?.function.parameters.properties).not.toHaveProperty('url');
        expect(applyRule?.function.parameters.properties).not.toHaveProperty('existingRules');
        expect(applyRule?.function.description).toMatch(/collect.*raw browser facts/is);
        expect(applyRule?.function.description).toMatch(
            /vision.*verified.*rejected.*inconclusive/is,
        );
        expect(applyRule?.function.description).not.toMatch(
            /structural regressions.*hard failures/is,
        );
    });

    it('registers apply_rule as surface-only and refuses direct dispatch', async () => {
        const mockSession = {
            getPage: () => {
                throw new Error('not implemented');
            },
            close: async () => {},
            getNetworkLog: () => [],
            resetNetworkLog: () => {},
            getConsoleLog: () => [],
            consoleCoverage: ConsoleCoverage.BrowserLogOnly,
            artifactsDir: '/tmp',
            isClosed: false,
        } as IBrowserSession;
        const mockAnalyzer = {
            addFinding: () => {},
            getFindings: () => [],
            clearFindings: () => {},
        } as unknown as SiteAnalyzer;

        const registry = await createToolRegistry({
            githubConfig: githubConfig,
            allowedIssueNumber: 1,
            browserTools: {
                session: mockSession,
                analyzer: mockAnalyzer,
                artifactsDir: '/tmp',
                logger: pino({ level: 'silent' }),
                recorder: new TraceRecorder({
                    runId: 'test-surface-only-apply-rule',
                    issueNumber: 1,
                    mode: 'fix',
                }),
                allowedOrigin: 'https://example.com',
            },
        });

        expect(registry.getDefinitions().map((definition) => definition.function.name)).toContain(
            'apply_rule',
        );
        // Production dispatch is intercepted by the agent runtime before this handler; a direct
        // call must fail typed instead of pretending an in-page validator still exists.
        expect(
            await registry.dispatch('apply_rule', { candidateRule: 'a.example##.x' }),
        ).toMatchObject({
            errorKind: 'candidate_operation_unsupported',
            retryable: false,
        });
    });

    it('binds fetch_issue to the current issue number', async () => {
        const registry = await createToolRegistry({
            githubConfig: githubConfig,
            allowedIssueNumber: 42,
        });

        await expect(registry.dispatch('fetch_issue', { issueNumber: 2 })).rejects.toThrow(
            'fetch_issue is restricted to issue 42',
        );
    });

    it('requires bounded pinned guidance before evaluating the first candidate', async () => {
        const root = mkdtempSync(join(tmpdir(), 'tool-guidance-'));
        const syntaxPath = join(root, 'create-own-filters.md');
        const policyPath = join(root, 'filter-policy.md');
        const contributingPath = join(root, 'CONTRIBUTING.md');
        // Every pinned topic must resolve: the guidance session validates the whole allowlist
        // at construction so a renamed upstream heading fails before any model spend.
        writePinnedGuidanceDocuments(syntaxPath, policyPath, contributingPath);
        const checkoutRoot = join(root, 'checkout');
        mkdirSync(join(checkoutRoot, 'filters'), { recursive: true });
        const registry = await createToolRegistry({
            githubConfig: githubConfig,
            allowedIssueNumber: 1,
            repositoryLint: { command: 'true', checkoutRoot },
            knowledgeGuidance: {
                kind: RuleGuidanceSourceKind.KnowledgeBase,
                knowledgeBaseCommit: '1'.repeat(40),
                filtersCommit: '2'.repeat(40),
                knowledgeBaseRepository: 'fork-owner/knowledge-base',
                filtersRepository: 'fork-owner/adguard-filters',
                syntaxPath,
                policyPath,
                contributingPath,
            },
        });

        expect(registry.getDefinitions().map((definition) => definition.function.name)).toContain(
            'lookup_rule_guidance',
        );
        const lintArgs = { rule: 'example.com##.ad', filePath: 'filters/list.txt' };
        await expect(registry.dispatch('lint_rule', lintArgs)).resolves.toEqual(
            expect.objectContaining({
                error: expect.stringMatching(/lookup_rule_guidance/i),
                requiredTool: 'lookup_rule_guidance',
            }),
        );

        const guidance = await registry.dispatch('lookup_rule_guidance', {
            topic: 'element_hiding',
        });
        expect(guidance).toEqual(
            expect.objectContaining({
                topic: 'element_hiding',
                guidance: expect.stringContaining('domain-scoped ## first'),
                citations: [expect.objectContaining({ commit: '1'.repeat(40) })],
            }),
        );
        await expect(registry.dispatch('lint_rule', lintArgs)).resolves.toEqual(
            expect.objectContaining({ status: 'clean' }),
        );
    });

    it('honors the caller-owned physical navigation budget', async () => {
        const page = {
            goto: vi.fn().mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED')),
            context: () => ({
                route: vi.fn().mockResolvedValue(undefined),
                unroute: vi.fn().mockResolvedValue(undefined),
            }),
            waitForTimeout: vi.fn().mockResolvedValue(undefined),
            on: vi.fn(),
            off: vi.fn(),
            mainFrame: vi.fn(),
        };
        const mockSession = {
            getPage: () => page,
            close: async () => {},
            getNetworkLog: () => [],
            resetNetworkLog: () => {},
            getConsoleLog: () => [],
            consoleCoverage: ConsoleCoverage.BrowserLogOnly,
            artifactsDir: '/tmp',
            isClosed: false,
        } as unknown as IBrowserSession;
        const mockAnalyzer = {
            addFinding: () => {},
            getFindings: () => [],
            clearFindings: () => {},
        } as unknown as SiteAnalyzer;
        const registry = await createToolRegistry({
            githubConfig: githubConfig,
            allowedIssueNumber: 1,
            browserTools: {
                session: mockSession,
                analyzer: mockAnalyzer,
                artifactsDir: '/tmp',
                logger: pino({ level: 'silent' }),
                recorder: new TraceRecorder({
                    runId: 'navigation-budget',
                    issueNumber: 1,
                    mode: 'fix',
                }),
                allowedOrigin: 'https://93.184.216.34',
                openPageRetries: 1,
            },
        });

        const result = await registry.dispatch('open_page', {
            url: 'https://93.184.216.34/reported',
        });

        expect(result.fallbackReason).toBe('target_unreachable');
        expect(page.goto).toHaveBeenCalledOnce();
    });

    it('registers every tool with the parameters its session advertises', async () => {
        const runDirectory = mkdtempSync(join(tmpdir(), 'tool-factory-drift-'));
        try {
            mkdirSync(join(runDirectory, 'BaseFilter', 'sections'), { recursive: true });
            writeFileSync(join(runDirectory, 'BaseFilter', 'sections', 'general_url.txt'), '');
            // A checkout and a browser session together, so the checkout tool and the rehearsal
            // tool - search_rules and interact_page - are registered and covered too.
            const registry = await createToolRegistry({
                githubConfig: githubConfig,
                allowedIssueNumber: 1,
                checkoutPath: runDirectory,
                browserTools: {
                    session: {} as IBrowserSession,
                    analyzer: {} as SiteAnalyzer,
                    artifactsDir: runDirectory,
                    logger: pino({ level: 'silent' }),
                    recorder: new TraceRecorder({
                        runId: 'drift-test',
                        issueNumber: 1,
                        mode: 'fix',
                    }),
                    allowedOrigin: 'https://example.com/',
                },
            });

            // The session build is where a registration that advertises a parameter the catalog
            // does not declare becomes an unwinnable run, so it is the boundary that proves the
            // registry and the advertisement still describe the same tools. It throws on drift,
            // naming the tool and the parameter, which is the diagnostic this test exists for.
            const specs = buildRegistrySessionTools(
                registry,
                new TraceRecorder({ runId: 'drift-test', issueNumber: 1, mode: 'fix' }),
            );
            expect(specs.map((spec) => spec.name)).toEqual(
                expect.arrayContaining([ToolName.SearchRules, ToolName.InteractPage]),
            );

            // The rehearsal step limit is enforced by the executor, but the model only ever learns
            // it from the advertisement, so the bound has to survive into the JSON Schema pi sends.
            const rehearsal = specs
                .filter((spec) => spec.name === ToolName.InteractPage)
                .map((spec) => toAdvertisedSchema(spec.parameters, spec.name));
            expect(rehearsal).toHaveLength(1);
            expect(rehearsal[0]).toMatchObject({
                properties: {
                    steps: { maxItems: DEFAULT_SAFE_INTERACTION_BOUNDS.maxSteps },
                },
            });
        } finally {
            rmSync(runDirectory, { recursive: true, force: true });
        }
    });

    describe('interact_page availability', () => {
        it('offers the rehearsal tool whenever a browser session exists', async () => {
            const mockSession = {
                getPage: () => {
                    throw new Error('not implemented');
                },
                close: async () => {},
                getNetworkLog: () => [],
                resetNetworkLog: () => {},
                getConsoleLog: () => [],
                consoleCoverage: ConsoleCoverage.BrowserLogOnly,
                artifactsDir: '/tmp',
                isClosed: false,
            } as unknown as IBrowserSession;
            const mockAnalyzer = {
                addFinding: () => {},
                getFindings: () => [],
                clearFindings: () => {},
            } as unknown as SiteAnalyzer;
            const registry = await createToolRegistry({
                githubConfig: githubConfig,
                allowedIssueNumber: 1,
                browserTools: {
                    session: mockSession,
                    analyzer: mockAnalyzer,
                    artifactsDir: '/tmp',
                    logger: pino({ level: 'silent' }),
                    recorder: new TraceRecorder({
                        runId: 'interaction-rehearsal',
                        issueNumber: 1,
                        mode: 'fix',
                    }),
                    allowedOrigin: 'https://example.com',
                },
            });

            const names = registry.getDefinitions().map((definition) => definition.function.name);
            expect(names).toContain('interact_page');
        });
    });
});

describe('analyze_screenshot on the single-shot client', () => {
    async function registryWithVision(
        baseUrl: string,
        artifactsDir: string,
        recorder: TraceRecorder,
    ) {
        const runtime = await createTestPiRuntime({ baseUrl });
        const client = createSingleShotClient(runtime, runtime.visionModel);
        return createToolRegistry({
            githubConfig: githubConfig,
            allowedIssueNumber: 1,
            visionTools: {
                artifactsDir,
                recorder,
                vision: client,
            },
        });
    }

    function recorderFor(pngPath: string): TraceRecorder {
        return {
            getArtifacts: () => [
                { id: 'shot-1', path: pngPath, type: 'screenshot', bytes: PNG_1PX.length },
            ],
        } as unknown as TraceRecorder;
    }

    it('parses a valid screenshot observation into the typed tool result', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                {
                    kind: ScriptedReplyKind.Text,
                    text: '{"analysis":"a banner top-right","pageObstruction":"none"}',
                },
            ],
        });
        const { dir, path } = pngFixture();
        try {
            const registry = await registryWithVision(provider.baseUrl, dir, recorderFor(path));

            const result = await registry.dispatch('analyze_screenshot', {
                artifactId: 'shot-1',
                prompt: 'inspect',
            });

            expect(result).toMatchObject({
                artifactId: 'shot-1',
                model: VISION_MODEL,
                analysis: 'a banner top-right',
                pageObstruction: 'none',
            });
            const request = provider.requests[0]!;
            expect(request.model).toBe(VISION_MODEL);
            const wire = JSON.stringify(request.messages);
            expect(wire).toContain('image_url');
            expect(wire).toContain('data:image/png;base64,');
            expect(wire).toContain('pageObstruction');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('runs exactly one repair before a corrected observation succeeds', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                { kind: ScriptedReplyKind.Text, text: 'broken' },
                {
                    kind: ScriptedReplyKind.Text,
                    text: '{"analysis":"fixed","pageObstruction":"sign_in_wall"}',
                },
            ],
        });
        const { dir, path } = pngFixture();
        try {
            const registry = await registryWithVision(provider.baseUrl, dir, recorderFor(path));

            const result = await registry.dispatch('analyze_screenshot', {
                artifactId: 'shot-1',
                prompt: 'inspect',
            });

            expect(provider.requests).toHaveLength(2);
            expect(result).toMatchObject({
                artifactId: 'shot-1',
                analysis: 'fixed',
                pageObstruction: 'sign_in_wall',
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('returns a tool error envelope naming the validation failure after persistent malformation', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                { kind: ScriptedReplyKind.Text, text: 'broken' },
                { kind: ScriptedReplyKind.Text, text: 'still broken' },
            ],
        });
        const { dir, path } = pngFixture();
        try {
            const registry = await registryWithVision(provider.baseUrl, dir, recorderFor(path));

            const result = await registry.dispatch('analyze_screenshot', {
                artifactId: 'shot-1',
                prompt: 'inspect',
            });

            expect(result).toMatchObject({
                artifactId: 'shot-1',
                error: expect.stringContaining('Screenshot analysis failed:'),
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('returns the deadline envelope when the vision call never answers', async () => {
        // analyze_screenshot spends its whole duration inside one out-of-loop completion, which no
        // agent-loop guard can end: one live run lost 44 minutes to a stalled vision call
        // and overran its wall-clock budget by 30. The hanging client stands in for that gateway
        // at the seam the tool uses; the streamed-stall half is the single-shot suite's contract.
        const visionSignals: (AbortSignal | undefined)[] = [];
        const hangingVision: SingleShotClient = {
            modelId: 'vision-stub',
            structured: (async (options: { signal?: AbortSignal }) => {
                visionSignals.push(options.signal);
                await new Promise<void>((resolve) => {
                    options.signal?.addEventListener('abort', () => resolve(), { once: true });
                });
                return {
                    kind: SingleShotResultKind.ProviderFailure,
                    stopReason: 'aborted',
                    message: 'Request was aborted',
                    usages: [],
                    model: 'vision-stub',
                };
            }) as never,
            text: async () => {
                throw new Error('not used by this suite');
            },
        };
        const { dir, path } = pngFixture();
        try {
            const registry = await createToolRegistry({
                githubConfig: githubConfig,
                allowedIssueNumber: 1,
                visionTools: {
                    artifactsDir: dir,
                    recorder: recorderFor(path),
                    vision: hangingVision,
                },
            });

            vi.useFakeTimers();
            try {
                const pending = registry.dispatch('analyze_screenshot', {
                    artifactId: 'shot-1',
                    prompt: 'inspect',
                });
                await vi.advanceTimersByTimeAsync(VISION_TOOL_DEADLINE_MS + 1_000);

                await expect(pending).resolves.toMatchObject({
                    errorKind: 'tool_deadline_exceeded',
                    retryable: true,
                    requiredAction: 'choose_a_different_action',
                });
            } finally {
                vi.useRealTimers();
            }
            // The deadline's abort reached the vision request itself, so the call stops instead of
            // running on behind a tool result the model has already been given.
            expect(visionSignals).toHaveLength(1);
            expect(visionSignals[0]?.aborted).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('rule guidance source union and the missing-information tool', () => {
    it('registers lookup_rule_guidance serving whole instruction documents from an instruction source', async () => {
        const registry = await createToolRegistry({
            githubConfig: githubConfig,
            allowedIssueNumber: 1,
            knowledgeGuidance: {
                kind: RuleGuidanceSourceKind.Instruction,
                path: 'AGENTS.md',
                // The loader digests instruction files with SHA-256 (64 hex) — the width the
                // guidance session re-asserts at construction.
                sha256: 'a'.repeat(64),
                documents: [
                    {
                        role: GuidanceDocumentRole.Syntax,
                        origin: GuidanceDocumentOrigin.Url,
                        url: 'https://wiki.example.test/filter-syntax',
                        content: 'uBO-style element hiding uses the ## selector.',
                        sha256: 'b'.repeat(64),
                    },
                ],
            },
        });

        const lookup = registry
            .getDefinitions()
            .find((definition) => definition.function.name === ToolName.LookupRuleGuidance);
        expect(lookup?.function.description).toContain("this run's rule-guidance documents");
        await expect(
            registry.dispatch(ToolName.LookupRuleGuidance, { topic: 'element_hiding' }),
        ).resolves.toEqual(
            expect.objectContaining({
                topic: 'element_hiding',
                guidance: expect.stringContaining('uBO-style element hiding'),
                citations: [
                    expect.objectContaining({
                        repository: 'wiki.example.test',
                        filePath: 'filter-syntax',
                        anchor: 'whole-document',
                        url: 'https://wiki.example.test/filter-syntax',
                        commit: undefined,
                    }),
                ],
            }),
        );
    });

    it('keeps report_missing_information off the shared factory base, beside lookup_rule_guidance', async () => {
        const registry = await createToolRegistry({
            githubConfig: githubConfig,
            allowedIssueNumber: 1,
        });

        const names = registry.getDefinitions().map((definition) => definition.function.name);
        // Both fix-only names register on the fix runtime's own registry, never on the shared
        // base factory: the factory's registry also feeds the other session surfaces, whose
        // session schema maps declare only catalog names.
        expect(names).not.toContain(ToolName.ReportMissingInformation);
        expect(names).not.toContain(ToolName.LookupRuleGuidance);
    });
});
