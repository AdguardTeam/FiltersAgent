import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTrustedValidationContext } from '../../src/validator/trusted-validation-context';

function createCheckout(lines: string[]): string {
    const checkoutPath = mkdtempSync(join(tmpdir(), 'trusted-validation-context-'));
    const filterDir = join(checkoutPath, 'BaseFilter', 'sections');
    mkdirSync(filterDir, { recursive: true });
    writeFileSync(
        join(filterDir, 'foreign.txt'),
        ['! Title: Test filter', '! Section: Domain rules', ...lines, ''].join('\n'),
    );
    return checkoutPath;
}

describe('createTrustedValidationContext', () => {
    it('preserves the exact reported URL and derives a canonical domain baseline', () => {
        const checkoutPath = createCheckout([
            'example.com##.parent-rule',
            'sub.example.com##.exact-rule',
            'example.com,sub.example.com##.parent-rule',
            'example.com,~sub.example.com##.excluded-rule',
            '||cdn.example^$domain=example.com|~blocked.example.com',
            'other.example##.other-rule',
            '##.generic-rule',
        ]);

        try {
            const reportedUrl = 'https://sub.example.com/article?id=7#comments';
            const context = createTrustedValidationContext(reportedUrl, checkoutPath);

            expect(context.reportedUrl).toBe(reportedUrl);
            expect(context.existingRules).toEqual([
                'example.com##.parent-rule',
                'example.com,sub.example.com##.parent-rule',
                'sub.example.com##.exact-rule',
                '||cdn.example^$domain=example.com|~blocked.example.com',
            ]);
            expect(context.baselineHash).toMatch(/^[a-f0-9]{64}$/);
        } finally {
            rmSync(checkoutPath, { recursive: true, force: true });
        }
    });

    it('produces the same baseline hash for equivalent canonical rules', () => {
        const firstCheckout = createCheckout([
            'example.com,sub.example.com##.ad-slot',
            'sub.example.com##.other-slot',
        ]);
        const secondCheckout = createCheckout([
            ' sub.example.com##.other-slot ',
            'sub.example.com,example.com##.ad-slot',
        ]);

        try {
            const first = createTrustedValidationContext(
                'https://sub.example.com/first',
                firstCheckout,
            );
            const second = createTrustedValidationContext(
                'https://sub.example.com/second',
                secondCheckout,
            );

            expect(first.existingRules).toEqual(second.existingRules);
            expect(first.baselineHash).toBe(second.baselineHash);
        } finally {
            rmSync(firstCheckout, { recursive: true, force: true });
            rmSync(secondCheckout, { recursive: true, force: true });
        }
    });

    it('rejects non-http reported URLs before reading a checkout', () => {
        expect(() =>
            createTrustedValidationContext('file:///tmp/issue.html', '/does/not/matter'),
        ).toThrow('HTTP(S)');
    });
});
