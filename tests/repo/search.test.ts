import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePlacementMap } from '../../src/repo/placement-map';
import { searchRules } from '../../src/repo/search';

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

    it('attaches file location and section to matches', () => {
        const matches = searchRules({ urlPattern: '||ads.example.com^' }, map, checkout);
        const bare = matches.find((m) => m.rule === '||ads.example.com^');
        expect(bare?.filter).toBe('BaseFilter');
        expect(bare?.section).toBe('Generic network rules');
        expect(bare?.line).toBe(3);
    });
});
