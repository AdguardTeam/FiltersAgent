import { describe, expect, it } from 'vitest';
import { parseGoldenE2EArgs } from '../../../lab/e2e/golden-cli';

describe('parseGoldenE2EArgs', () => {
    it('requires exactly one explicit case selection mode', () => {
        expect(parseGoldenE2EArgs(['--case', 'nettg-pl-235988'])).toEqual({
            selection: 'case',
            caseName: 'nettg-pl-235988',
            outputRoot: null,
            knowledgeBaseSha: null,
        });
        expect(parseGoldenE2EArgs(['--all'])).toEqual({
            selection: 'all',
            outputRoot: null,
            knowledgeBaseSha: null,
        });
        expect(() => parseGoldenE2EArgs([])).toThrow(/--case.*--all/i);
        expect(() => parseGoldenE2EArgs(['--case', 'one', '--all'])).toThrow(/exactly one/i);
    });

    it('parses --output-root', () => {
        expect(parseGoldenE2EArgs(['--all', '--output-root', 'tmp/comparison']).outputRoot).toBe(
            'tmp/comparison',
        );
        expect(() => parseGoldenE2EArgs(['--all', '--output-root'])).toThrow(/value/i);
    });

    it('parses --knowledge-base-sha and refuses a short one', () => {
        const sha = 'abcdef0123456789abcdef0123456789abcdef01';
        expect(
            parseGoldenE2EArgs(['--all', '--knowledge-base-sha', sha.toUpperCase()])
                .knowledgeBaseSha,
        ).toBe(sha);
        for (const invalid of ['abcdef0', 'g'.repeat(40)]) {
            expect(() => parseGoldenE2EArgs(['--all', '--knowledge-base-sha', invalid])).toThrow(
                '--knowledge-base-sha must be a full 40-character commit.',
            );
        }
    });

    it('rejects unsafe or unknown arguments', () => {
        expect(() => parseGoldenE2EArgs(['--case', '../escape'])).toThrow(/case name/i);
        expect(() => parseGoldenE2EArgs(['--case'])).toThrow(/value/i);
        expect(() => parseGoldenE2EArgs(['--wat'])).toThrow(/unknown/i);
    });
});
