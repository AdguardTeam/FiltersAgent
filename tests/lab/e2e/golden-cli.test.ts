import { describe, expect, it } from 'vitest';
import { parseGoldenE2EArgs } from '../../../lab/e2e/golden-cli';

describe('parseGoldenE2EArgs', () => {
    it('requires exactly one explicit case selection mode', () => {
        expect(parseGoldenE2EArgs(['--case', 'nettg-pl-235988'])).toEqual({
            selection: 'case',
            caseName: 'nettg-pl-235988',
            blockerModules: [],
        });
        expect(parseGoldenE2EArgs(['--all'])).toEqual({ selection: 'all', blockerModules: [] });
        expect(() => parseGoldenE2EArgs([])).toThrow(/--case.*--all/i);
        expect(() => parseGoldenE2EArgs(['--case', 'one', '--all'])).toThrow(/exactly one/i);
    });

    it('collects every repeated --blocker-module manifest for the selected cases', () => {
        expect(
            parseGoldenE2EArgs([
                '--all',
                '--blocker-module',
                'adguard-cli/blocker-module.json',
                '--blocker-module',
                '/opt/demo-module/blocker-module.json',
            ]),
        ).toEqual({
            selection: 'all',
            blockerModules: [
                'adguard-cli/blocker-module.json',
                '/opt/demo-module/blocker-module.json',
            ],
        });
        expect(() => parseGoldenE2EArgs(['--all', '--blocker-module'])).toThrow(/value/i);
    });

    it('rejects unsafe or unknown arguments', () => {
        expect(() => parseGoldenE2EArgs(['--case', '../escape'])).toThrow(/case name/i);
        expect(() => parseGoldenE2EArgs(['--case'])).toThrow(/value/i);
        expect(() => parseGoldenE2EArgs(['--wat'])).toThrow(/unknown/i);
    });
});
