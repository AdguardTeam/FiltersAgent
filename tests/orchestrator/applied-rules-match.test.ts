import { describe, expect, it } from 'vitest';
import { appliedRulesMatch } from '../../src/orchestrator/applied-rules-match';

// The trusted rules of a domain as a checkout yields them: a cosmetic rule between network ones.
const NETWORK_A = '||ads.example.com^$domain=example.com';
const COSMETIC = 'example.com##.ad-slot';
const NETWORK_B = '||tracker.example.net^$domain=example.com';
const TRUSTED = [NETWORK_A, COSMETIC, NETWORK_B];

describe('appliedRulesMatch', () => {
    it('accepts the rules in the order either producing route writes them', () => {
        // The environment-adapter route writes input order; the in-page applicator wrote network
        // rules first. Both name exactly the trusted rules.
        expect(appliedRulesMatch([NETWORK_A, COSMETIC, NETWORK_B], TRUSTED)).toBe(true);
        expect(appliedRulesMatch([NETWORK_A, NETWORK_B, COSMETIC], TRUSTED)).toBe(true);
    });

    it.each([
        ['a missing rule', [NETWORK_A, COSMETIC]],
        ['a foreign rule', [NETWORK_A, COSMETIC, 'example.com##.other']],
        ['a repeated rule', [NETWORK_A, COSMETIC, COSMETIC]],
        ['no record at all', undefined],
    ])('refuses %s', (_label, applied) => {
        expect(appliedRulesMatch(applied, TRUSTED)).toBe(false);
    });
});
