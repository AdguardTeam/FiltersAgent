import { describe, it, expect, vi } from 'vitest';
import { checkAntiAdblock } from '../../src/validator/anti-adblock-check';
import type { TrustedPageEvaluator } from '../../src/browser/trusted-page-evaluator';

/**
 * Create a mock trusted page evaluator with a controllable result.
 */
function mockEvaluator(result: unknown): TrustedPageEvaluator {
    return { evaluate: vi.fn().mockResolvedValue(result) };
}

describe('checkAntiAdblock', () => {
    it.each([true, false])('returns the trusted probe verdict %s', async (verdict) => {
        await expect(checkAntiAdblock(mockEvaluator(verdict))).resolves.toBe(verdict);
    });

    it('returns true on trusted evaluation failure to block verification', async () => {
        const evaluator = mockEvaluator(false);
        evaluator.evaluate = vi.fn().mockRejectedValue(new Error('timeout'));
        const result = await checkAntiAdblock(evaluator);
        expect(result).toBe(true);
    });

    it('returns true on malformed trusted output to block verification', async () => {
        const result = await checkAntiAdblock(mockEvaluator('false'));
        expect(result).toBe(true);
    });
});
