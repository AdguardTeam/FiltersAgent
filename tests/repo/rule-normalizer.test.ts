import { describe, it, expect } from 'vitest';
import {
    effectiveRuleScopes,
    normalizeRule,
    COSMETIC_SEPARATORS,
} from '../../src/repo/rule-normalizer';

describe('normalizeRule', () => {
    it('classifies comments and empty lines', () => {
        expect(normalizeRule('! Title: Base').kind).toBe('comment');
        expect(normalizeRule('   ').kind).toBe('empty');
    });

    it('detects a network rule and lowercases the pattern', () => {
        const n = normalizeRule('||ADS.Example.com^');
        expect(n.kind).toBe('network');
        expect(n.syntaxKind).toBe('network');
        expect(n.urlPattern).toBe('||ads.example.com^');
        expect(n.isException).toBe(false);
    });

    it('detects a network exception', () => {
        const n = normalizeRule('@@||ads.example.com^');
        expect(n.isException).toBe(true);
        expect(n.urlPattern).toBe('||ads.example.com^');
    });

    it('sorts modifiers and domain= values (AC2 equivalence)', () => {
        const a = normalizeRule('||ads.com^$domain=b.com|c.com,script');
        const b = normalizeRule('||ads.com^$script,domain=c.com|b.com');
        expect(a.canonical).toBe(b.canonical);
        expect(a.canonical).toBe('||ads.com^$domain=b.com|c.com,script');
    });

    it('detects a cosmetic rule and sorts domains (AC2 equivalence)', () => {
        const a = normalizeRule('example.com,sub.example.com##.ad-banner');
        const b = normalizeRule('sub.example.com,example.com##.ad-banner');
        expect(a.canonical).toBe(b.canonical);
        expect(a.kind).toBe('cosmetic');
        expect(a.syntaxKind).toBe('element_hiding');
        expect(a.selector).toBe('.ad-banner');
        expect(a.domains).toEqual(['example.com', 'sub.example.com']);
    });

    it('treats an empty domain list as generic', () => {
        const n = normalizeRule('##.generic-ad');
        expect(n.domains).toEqual([]);
        expect(n.selector).toBe('.generic-ad');
    });

    it('detects a cosmetic exception', () => {
        const n = normalizeRule('example.com#@#.ad-banner');
        expect(n.kind).toBe('cosmetic');
        expect(n.isException).toBe(true);
    });

    it('extracts a scriptlet name', () => {
        const n = normalizeRule("example.com#%#//scriptlet('abort-on-property-read', 'I10C')");
        expect(n.kind).toBe('scriptlet');
        expect(n.syntaxKind).toBe('scriptlet');
        expect(n.scriptletName).toBe('abort-on-property-read');
    });

    it('classifies #$# as scriptlet injection and extracts the name', () => {
        const n = normalizeRule("example.com#$#//scriptlet('abort-current-inline-script', 'atob')");
        expect(n.kind).toBe('scriptlet');
        expect(n.scriptletName).toBe('abort-current-inline-script');
    });

    it("classifies uBO's ##+js(...) injection as a scriptlet and keeps its uBO spelling", () => {
        const rule = 'example.com##+js(set-constant, aipAPItag.sdkBlocked, false)';
        const n = normalizeRule(rule);

        expect(n.kind).toBe('scriptlet');
        expect(n.syntaxKind).toBe('scriptlet');
        expect(n.scriptletName).toBe('set-constant');
        // A uAssets maintainer is shown the canonical string, so it stays in their own dialect.
        expect(n.canonical).toBe(rule);

        const manyArgs = normalizeRule("example.com##+js(rpnt, script, PerformanceTracker, '')");
        expect(manyArgs.scriptletName).toBe('rpnt');
    });

    it('classifies a uBO scriptlet exception, whether it names a scriptlet or not', () => {
        const named = normalizeRule('example.com#@#+js(set-constant, foo, false)');
        expect(named.kind).toBe('scriptlet');
        expect(named.isException).toBe(true);
        expect(named.scriptletName).toBe('set-constant');
        expect(named.canonical).toBe('example.com#@#+js(set-constant, foo, false)');

        // An argument-less `+js()` disables every scriptlet on the site and names none.
        const siteWide = normalizeRule('example.com#@#+js()');
        expect(siteWide.kind).toBe('scriptlet');
        expect(siteWide.isException).toBe(true);
        expect(siteWide.scriptletName).toBeUndefined();
    });

    it("reads +js as an injection only where uBO's marker opens the body", () => {
        expect(normalizeRule('example.com##+jsx(set-constant, foo)').kind).toBe('cosmetic');
        expect(normalizeRule('example.com##.promo[data-tag="+js("]').kind).toBe('cosmetic');
    });

    it('classifies #$# CSS injection as cosmetic and preserves its full body', () => {
        const rule = 'example.com#$#.ad-slot { min-height: 0 !important; }';
        const n = normalizeRule(rule);

        expect(n.kind).toBe('cosmetic');
        expect(n.syntaxKind).toBe('css_injection');
        expect(n.selector).toBe('.ad-slot');
        expect(n.cssInjectionBody).toBe('.ad-slot { min-height: 0 !important; }');
        expect(n.canonical).toBe(rule);
    });

    it('classifies #@?# as a procedural exception', () => {
        const n = normalizeRule('example.com#@?#.ad-banner:has-text(/promoted/i)');
        expect(n.kind).toBe('cosmetic');
        expect(n.syntaxKind).toBe('extended_element_hiding');
        expect(n.isException).toBe(true);
        expect(n.selector).toBe('.ad-banner:has-text(/promoted/i)');
    });

    it('distinguishes ExtendedCSS from procedural element hiding', () => {
        const extendedCss = normalizeRule(
            'example.com#$?#.banner:has(.creative) { min-height: 0 !important; }',
        );
        const procedural = normalizeRule('example.com#?#.banner:has(.creative)');

        expect(extendedCss.kind).toBe('cosmetic');
        expect(extendedCss.syntaxKind).toBe('extended_css');
        expect(procedural.kind).toBe('cosmetic');
        expect(procedural.syntaxKind).toBe('extended_element_hiding');
    });

    it('does not confuse #@?# with #@# (ordering regression guard)', () => {
        const procedural = normalizeRule('example.com#@?#.ad-banner');
        expect(procedural.kind).toBe('cosmetic');
        expect(procedural.isException).toBe(true);
        expect(procedural.selector).toBe('.ad-banner');

        const regular = normalizeRule('example.com#@#.ad-banner');
        expect(regular.kind).toBe('cosmetic');
        expect(regular.isException).toBe(true);
        expect(regular.selector).toBe('.ad-banner');
    });

    it('exports COSMETIC_SEPARATORS in longest-first order', () => {
        expect(COSMETIC_SEPARATORS).toEqual([
            '#@$?#',
            '#$?#',
            '#@?#',
            '#@%#',
            '#@$#',
            '#@#',
            '#%#',
            '#$#',
            '#?#',
            '##',
        ]);
    });
});

describe('effectiveRuleScopes', () => {
    it('treats an exact anchored first-party path as the reported-domain scope', () => {
        const normalized = normalizeRule('||sochi.camera/adblock-detector.js');

        expect(effectiveRuleScopes(normalized, 'sochi.camera')).toEqual(['sochi.camera']);
    });

    it('allows one trailing separator anchor on an exact first-party path', () => {
        const normalized = normalizeRule('||sochi.camera/adblock-detector.js^');

        expect(effectiveRuleScopes(normalized, 'sochi.camera')).toEqual(['sochi.camera']);
    });

    it.each([
        '||sochi.camera/adblock-detector.js$script',
        '||sochi.camera/adblock-detector.js^$script',
    ])('allows the narrowing script modifier on an exact first-party path: %s', (rule) => {
        expect(effectiveRuleScopes(normalizeRule(rule), 'sochi.camera')).toEqual(['sochi.camera']);
    });

    it('does not infer scope for an anchored third-party path', () => {
        const normalized = normalizeRule('||cdn.example.net/adblock-detector.js');

        expect(effectiveRuleScopes(normalized, 'sochi.camera')).toEqual([]);
    });

    it.each([
        '||sochi.camera^',
        '||*.sochi.camera/adblock-detector.js',
        '||sochi.camera/adblock-*.js',
        '||sochi.camera/adblock^detector.js',
        '||sochi.camera/adblock-detector.js^^',
        '||sochi.camera/adblock-detector.js$redirect=noopjs',
        '||sochi.camera/adblock-detector.js$removeparam=source',
        '||sochi.camera/adblock-detector.js$script,important',
    ])('does not infer scope for a broad network pattern: %s', (rule) => {
        expect(effectiveRuleScopes(normalizeRule(rule), 'sochi.camera')).toEqual([]);
    });

    it('preserves explicit domain modifiers instead of inferring a target-host scope', () => {
        const normalized = normalizeRule(
            '||cdn.example.net/adblock-detector.js$domain=sochi.camera',
        );

        expect(effectiveRuleScopes(normalized, 'sochi.camera')).toEqual(['sochi.camera']);
    });
});
