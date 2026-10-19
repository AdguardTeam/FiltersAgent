import { describe, it, expect } from 'vitest';
import {
    extractAdSelector,
    resolveValidatedSelector,
} from '../../src/validator/candidate-selector';

// ── extractAdSelector ────────────────────────────────────────────────────

describe('extractAdSelector', () => {
    it('extracts selector from ## (hiding) rule', () => {
        expect(extractAdSelector('example.com##.ad-banner')).toBe('.ad-banner');
    });

    it('extracts selector from #@# (exception) rule', () => {
        expect(extractAdSelector('example.com#@#.ad-banner')).toBe('.ad-banner');
    });

    it('extracts selector from #?# (extended CSS) rule', () => {
        expect(extractAdSelector('example.com#?#.ad-banner:has(img)')).toBe('.ad-banner:has(img)');
    });

    it('extracts selector from #@?# (extended CSS exception) rule', () => {
        expect(extractAdSelector('example.com#@?#.override')).toBe('.override');
    });

    it('returns null for #%# (scriptlet) rule', () => {
        const rule = "example.com#%#//scriptlet('abort-on-property-read','ads')";
        expect(extractAdSelector(rule)).toBeNull();
    });

    it('returns null for network rule', () => {
        expect(extractAdSelector('||ads.example.com^')).toBeNull();
    });

    it('returns null for comment', () => {
        expect(extractAdSelector('! comment')).toBeNull();
    });

    it('returns null for empty string', () => {
        expect(extractAdSelector('')).toBeNull();
    });

    it('extracts selector from multi-domain cosmetic rule', () => {
        expect(extractAdSelector('sub.example.com,other.example.com##.ads')).toBe('.ads');
    });

    it('extracts only the selector from a #$# CSS injection rule', () => {
        const rule = 'example.com#$#.ad-slot { min-height: 0 !important; }';
        expect(extractAdSelector(rule)).toBe('.ad-slot');
    });

    it.each([
        ['example.com###ad', '#ad'],
        ['###ad', '#ad'],
        ['example.com#@##ad', '#ad'],
        ['example.com#?##ad:has(img)', '#ad:has(img)'],
        ['example.com#@?##ad', '#ad'],
        ['example.com##div#ad', 'div#ad'],
    ])('keeps the id hash of the selector in %s', (rule, selector) => {
        expect(extractAdSelector(rule)).toBe(selector);
    });

    it('returns null for a #$# scriptlet rule', () => {
        const rule = "example.com#$#//scriptlet('abort-on-property-read','ads')";
        expect(extractAdSelector(rule)).toBeNull();
    });
});

// ── resolveValidatedSelector ─────────────────────────────────────────────

describe('resolveValidatedSelector', () => {
    it('binds a cosmetic candidate to its own selector, ignoring a model selector', () => {
        expect(resolveValidatedSelector('example.com##.ad-slot', '#main-content')).toBe('.ad-slot');
    });

    it('binds a CSS injection candidate to its selector without the declarations', () => {
        expect(
            resolveValidatedSelector('example.com#$#.ad-slot { height: 0 !important; }', '#other'),
        ).toBe('.ad-slot');
    });

    it('lets a network candidate use the model selector of the affected element', () => {
        expect(resolveValidatedSelector('||ads.example.com^', ' .sidebar-ad ')).toBe('.sidebar-ad');
    });

    it('binds no selector to a scriptlet candidate', () => {
        expect(
            resolveValidatedSelector(
                "example.com#%#//scriptlet('abort-on-property-read', 'ads')",
                '.ad-slot',
            ),
        ).toBe('');
    });
});
