import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { FindingSchema } from '../../src/types/site-analysis';

describe('FindingSchema', () => {
    it('accepts a valid ad finding', () => {
        const result = v.safeParse(FindingSchema, {
            type: 'ad',
            location: { selector: '.banner-ad' },
            evidence: 'Matches typical ad container pattern',
            confidence: 0.9,
            suggestedApproach: 'cosmetic ## .banner-ad',
        });
        expect(result.success).toBe(true);
    });

    it('rejects invalid type', () => {
        const result = v.safeParse(FindingSchema, {
            type: 'invalid',
            location: {},
            evidence: 'test',
            confidence: 0.5,
        });
        expect(result.success).toBe(false);
    });

    it('rejects confidence out of range', () => {
        const result = v.safeParse(FindingSchema, {
            type: 'ad',
            location: {},
            evidence: 'test',
            confidence: 1.5,
        });
        expect(result.success).toBe(false);
    });
});
