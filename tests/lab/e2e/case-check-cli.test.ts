import { describe, expect, it } from 'vitest';
import { CaseCheckSelection, parseGoldenCaseCheckArgs } from '../../../lab/e2e/case-check-cli';

describe('case-check arguments', () => {
    it('parses one case with an optional extension version and the whole corpus', () => {
        expect(parseGoldenCaseCheckArgs(['example-com-4'])).toEqual({
            selection: CaseCheckSelection.Case,
            caseName: 'example-com-4',
        });
        expect(
            parseGoldenCaseCheckArgs(['example-com-4', '--extension-version', '5.4.3.99']),
        ).toEqual({
            selection: CaseCheckSelection.Case,
            caseName: 'example-com-4',
            extensionVersion: '5.4.3.99',
        });
        expect(parseGoldenCaseCheckArgs(['--all'])).toEqual({ selection: CaseCheckSelection.All });
        expect(parseGoldenCaseCheckArgs(['--', '--all'])).toEqual({
            selection: CaseCheckSelection.All,
        });
    });

    it.each([
        ['--all', '--extension-version', '5.4.3.99'],
        ['example-com-4', '--extension-version', '5.4.3'],
        ['--unknown'],
        [],
        ['../example'],
        ['example', '--all'],
        ['example', 'other'],
        ['example', '--extension-version'],
        ['example', '--extension-version', '5.4.3.99', '--extension-version', '5.4.3.98'],
    ])(
        'refuses an extension version with --all, a malformed version and an unknown argument: %j',
        (...args) => {
            expect(() => parseGoldenCaseCheckArgs(args)).toThrow();
        },
    );
});
