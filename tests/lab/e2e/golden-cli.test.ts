import { describe, expect, it } from 'vitest';
import { parseGoldenE2EArgs } from '../../../lab/e2e/golden-cli';

describe('parseGoldenE2EArgs', () => {
    it('requires exactly one explicit case selection mode', () => {
        expect(parseGoldenE2EArgs(['--case', 'nettg-pl-235988'])).toEqual({
            selection: 'case',
            caseName: 'nettg-pl-235988',
        });
        expect(parseGoldenE2EArgs(['--all'])).toEqual({ selection: 'all' });
        expect(() => parseGoldenE2EArgs([])).toThrow(/--case.*--all/i);
        expect(() => parseGoldenE2EArgs(['--case', 'one', '--all'])).toThrow(/exactly one/i);
    });

    it('rejects unsafe or unknown arguments', () => {
        expect(() => parseGoldenE2EArgs(['--case', '../escape'])).toThrow(/case name/i);
        expect(() => parseGoldenE2EArgs(['--case'])).toThrow(/value/i);
        expect(() => parseGoldenE2EArgs(['--wat'])).toThrow(/unknown/i);
    });
});
