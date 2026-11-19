import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePlacementMap } from '../../src/repo/placement-map';
import {
    FILE_WINDOW_RADIUS_LINES,
    outlineListFile,
    readListFileWindow,
    searchRules,
} from '../../src/repo/search';

const here = dirname(fileURLToPath(import.meta.url));
const checkout = resolve(here, 'fixtures', 'checkout');
const map = generatePlacementMap(checkout);

describe('searchRules', () => {
    it('throws on an empty query', () => {
        expect(() => searchRules({}, map, checkout)).toThrow();
    });

    it('returns an applicable cross-syntax inventory for a domain-only query', () => {
        const matches = searchRules({ domain: 'example.com' }, map, checkout);
        const rules = matches.map((match) => match.rule);

        expect(rules).toContain('||ads.example.com^');
        expect(rules).toContain('example.com##.ad-banner');
        expect(rules).toContain("example.com#%#//scriptlet('abort-on-property-read', 'I10C')");
        expect(rules).not.toContain('news.com##.ad-banner');
    });

    it('includes parent-domain scopes in a subdomain-only inventory', () => {
        const matches = searchRules({ domain: 'sub.example.com' }, map, checkout);
        const rules = matches.map((match) => match.rule);

        expect(rules).toContain('||ads.example.com^');
        expect(rules).toContain('example.com##.ad-banner');
        expect(rules).toContain("example.com#%#//scriptlet('abort-on-property-read', 'I10C')");
        expect(rules).not.toContain('news.com##.ad-banner');
    });

    it('finds an entity-scoped rule for the hostname it already covers', () => {
        // The rule that fixed shellshock.io upstream is scoped `shellshock.*`, so a
        // `{ domain: 'shellshock.io' }` search that cannot see it lets the model spend a run
        // proposing a duplicate of a rule the repository already carries.
        const entityRule =
            'shellshock.*,shellshockers.*##+js(set-constant, aipAPItag.sdkBlocked, false)';
        const rulesFor = (domain: string): string[] =>
            searchRules({ domain }, map, checkout).map((match) => match.rule);

        expect(rulesFor('shellshock.io')).toContain(entityRule);
        expect(rulesFor('www.shellshock.io')).toContain(entityRule);
        expect(rulesFor('shellshockers.com')).toContain(entityRule);
        expect(rulesFor('shell.io')).not.toContain(entityRule);
        expect(rulesFor('shellshock.io.example')).not.toContain(entityRule);
    });

    it('returns every rule with the queried target, in any scope and of either polarity', () => {
        const rules = searchRules({ urlPattern: '||ads.example.com^' }, map, checkout).map(
            (match) => match.rule,
        );

        // Which of these duplicates, narrows, broadens or contradicts a candidate is the agent's
        // reading: the search hands over the rules, not a relationship label.
        expect(rules).toEqual(
            expect.arrayContaining([
                '||ads.example.com^',
                '||ads.example.com^$script',
                '@@||ads.example.com^',
            ]),
        );
        expect(rules).not.toContain('||ads.example.com/banner^');
    });

    it('returns a selector from every list that carries it, each with its own file', () => {
        const matches = searchRules(
            { selector: '.ad-banner', domain: 'example.com' },
            map,
            checkout,
        );

        expect(matches.map((match) => [match.rule, match.filePath])).toEqual(
            expect.arrayContaining([
                ['example.com##.ad-banner', 'CosmeticFilter/filter.txt'],
                ['example.com#@#.ad-banner', 'ExceptionFilter/filter.txt'],
            ]),
        );
    });

    it('ranks exact-selector rules from the reported domain locale before unrelated matches', () => {
        const rankedCheckout = mkdtempSync(join(tmpdir(), 'rule-search-rank-'));
        try {
            mkdirSync(join(rankedCheckout, 'BaseFilter', 'sections'), { recursive: true });
            writeFileSync(
                join(rankedCheckout, 'BaseFilter', 'sections', 'foreign.txt'),
                [
                    'one.de,two.de##.banner',
                    'one.com##.banner',
                    'morizon.pl,prawo.pl,telepolis.pl##.banner',
                    'other.pl##.banner',
                    '',
                ].join('\n'),
            );
            const rankedMap = generatePlacementMap(rankedCheckout);

            const matches = searchRules(
                { domain: 'nettg.pl', selector: '.banner' },
                rankedMap,
                rankedCheckout,
            );

            expect(matches.slice(0, 2).map((match) => match.rule)).toEqual([
                'morizon.pl,prawo.pl,telepolis.pl##.banner',
                'other.pl##.banner',
            ]);
        } finally {
            rmSync(rankedCheckout, { recursive: true, force: true });
        }
    });

    it('AC2: textually-different equivalent rules both match as exact', () => {
        // query with domains in one order; existing rule has them in another order
        const matches = searchRules(
            { selector: '.ad-banner', domain: 'sub.example.com' },
            map,
            checkout,
        );
        // example.com,sub.example.com##.ad-banner is an exact match for a
        // candidate "sub.example.com##.ad-banner"? No — different domain set.
        // The bare example.com##.ad-banner is semantic (overlapping domains).
        const overlap = matches.find((m) => m.rule === 'example.com,sub.example.com##.ad-banner');
        expect(overlap).toBeDefined();
    });

    it('scriptlet search by name', () => {
        const matches = searchRules(
            { scriptlet: 'abort-on-property-read', domain: 'example.com' },
            map,
            checkout,
        );
        expect(matches.some((m) => m.rule.includes('scriptlet'))).toBe(true);
    });

    it('finds a uBO +js scriptlet by name', () => {
        // uAssets spells scriptlet injection `##+js(name, ...)`. While that spelling normalized as
        // element hiding, no `{ scriptlet }` query could reach a single uBO scriptlet in the
        // checkout, and the model proposed duplicates of rules the repository already carried.
        const matches = searchRules({ scriptlet: 'set-constant' }, map, checkout);

        expect(matches.map((match) => match.rule)).toContain(
            'shellshock.*,shellshockers.*##+js(set-constant, aipAPItag.sdkBlocked, false)',
        );
    });

    it('attaches the file location to matches without naming a section', () => {
        const matches = searchRules({ urlPattern: '||ads.example.com^' }, map, checkout);
        const bare = matches.find((m) => m.rule === '||ads.example.com^');
        expect(bare?.filter).toBe('BaseFilter');
        expect(bare).not.toHaveProperty('section');
        expect(bare?.line).toBe(3);
    });

    it('refuses an empty target string instead of searching for nothing', () => {
        expect(() => searchRules({ domain: '' }, map, checkout)).toThrow();
        expect(() =>
            searchRules({ selector: '', filePath: 'BaseFilter/filter.txt' }, map, checkout),
        ).toThrow();
    });

    it('limits matches to the named file', () => {
        const everyFile = searchRules(
            { selector: '.ad-banner', domain: 'example.com' },
            map,
            checkout,
        );
        const oneFile = searchRules(
            {
                selector: '.ad-banner',
                domain: 'example.com',
                filePath: 'CosmeticFilter/filter.txt',
            },
            map,
            checkout,
        );

        expect(oneFile.length).toBeGreaterThan(0);
        expect(oneFile.length).toBeLessThan(everyFile.length);
        expect(new Set(oneFile.map((match) => match.filePath))).toEqual(
            new Set(['CosmeticFilter/filter.txt']),
        );
    });

    it('numbers lines through the same line model as a window', () => {
        const crCheckout = mkdtempSync(join(tmpdir(), 'rule-search-cr-'));
        try {
            mkdirSync(join(crCheckout, 'BaseFilter', 'sections'), { recursive: true });
            writeFileSync(
                join(crCheckout, 'BaseFilter', 'sections', 'foreign.txt'),
                '||ads.example^\rexample.org##.ad',
                'utf8',
            );
            const crMap = generatePlacementMap(crCheckout);
            const matches = searchRules({ selector: '.ad' }, crMap, crCheckout);
            const window = readListFileWindow(
                crMap,
                crCheckout,
                'BaseFilter/sections/foreign.txt',
                1,
            );

            expect(matches[0]?.line).toBe(2);
            expect(window.lines[1]).toEqual({ line: 2, text: 'example.org##.ad' });
        } finally {
            rmSync(crCheckout, { recursive: true, force: true });
        }
    });

    it('refuses a file path that is not one of the checkout list files, naming it', () => {
        expect(() => outlineListFile(map, checkout, 'BaseFilter/sections/missing.txt')).toThrow(
            /BaseFilter\/sections\/missing\.txt/,
        );
        expect(() =>
            searchRules(
                { selector: '.ad-banner', filePath: 'BaseFilter/sections/missing.txt' },
                map,
                checkout,
            ),
        ).toThrow(/BaseFilter\/sections\/missing\.txt/);
    });
});

describe('outlineListFile', () => {
    it('returns the file header and every marker of a named list file', () => {
        const outline = outlineListFile(map, checkout, 'BaseFilter/filter.txt');

        expect(outline.filePath).toBe('BaseFilter/filter.txt');
        expect(outline.lineCount).toBe(9);
        expect(outline.header).toBe('! Title: AdGuard Base Filter (fixture)');
        expect(
            outline.markers.map(({ line, kind, text, ruleCount, sorted }) => ({
                line,
                kind,
                text,
                ruleCount,
                sorted,
            })),
        ).toEqual([
            {
                line: 2,
                kind: 'section',
                text: '! Section: Generic network rules',
                ruleCount: 4,
                sorted: false,
            },
            {
                line: 7,
                kind: 'section',
                text: '! Section: Domain-specific rules',
                ruleCount: 2,
                sorted: false,
            },
        ]);
    });
});

describe('readListFileWindow', () => {
    it('returns about fifteen numbered lines either side of a line, clipped at the file edges', () => {
        const windowCheckout = mkdtempSync(join(tmpdir(), 'rule-search-window-'));
        try {
            mkdirSync(join(windowCheckout, 'BaseFilter', 'sections'), { recursive: true });
            const lines = Array.from({ length: 80 }, (_unused, index) => `||ads-${index}.example^`);
            writeFileSync(
                join(windowCheckout, 'BaseFilter', 'sections', 'foreign.txt'),
                `${lines.join('\n')}\n`,
                'utf8',
            );
            const windowMap = generatePlacementMap(windowCheckout);
            const middle = readListFileWindow(
                windowMap,
                windowCheckout,
                'BaseFilter/sections/foreign.txt',
                40,
            );
            const start = readListFileWindow(
                windowMap,
                windowCheckout,
                'BaseFilter/sections/foreign.txt',
                1,
            );
            const end = readListFileWindow(
                windowMap,
                windowCheckout,
                'BaseFilter/sections/foreign.txt',
                80,
            );

            expect(middle.lineCount).toBe(80);
            expect(middle.lines[0]).toEqual({
                line: 40 - FILE_WINDOW_RADIUS_LINES,
                text: `||ads-${40 - FILE_WINDOW_RADIUS_LINES - 1}.example^`,
            });
            expect(middle.lines).toHaveLength(2 * FILE_WINDOW_RADIUS_LINES + 1);
            expect(middle.lines.at(-1)?.line).toBe(40 + FILE_WINDOW_RADIUS_LINES);
            expect(start.lines[0]).toEqual({ line: 1, text: '||ads-0.example^' });
            expect(start.lines.at(-1)?.line).toBe(1 + FILE_WINDOW_RADIUS_LINES);
            expect(end.lines[0]?.line).toBe(80 - FILE_WINDOW_RADIUS_LINES);
            expect(end.lines.at(-1)).toEqual({ line: 80, text: '||ads-79.example^' });
        } finally {
            rmSync(windowCheckout, { recursive: true, force: true });
        }
    });

    it('refuses a window line outside the file, giving its line count', () => {
        expect(() => readListFileWindow(map, checkout, 'BaseFilter/filter.txt', 10)).toThrow(/9/u);
        expect(() => readListFileWindow(map, checkout, 'BaseFilter/filter.txt', 0)).toThrow(/9/u);
    });
});
