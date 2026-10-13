import { describe, expect, it } from 'vitest';
import { parseGoldenCaseAddArgs } from '../../../lab/e2e/case-add-cli';

describe('parseGoldenCaseAddArgs', () => {
    it('parses the required issue and isolated human oracle commit', () => {
        const humanFixCommit = 'a'.repeat(40);
        expect(
            parseGoldenCaseAddArgs(['--issue', '235679', '--human-fix-commit', humanFixCommit]),
        ).toEqual({
            issueNumber: 235679,
            humanFixCommit,
        });
    });

    it('accepts one explicit safe case name', () => {
        const uppercaseCommit = 'A'.repeat(40);
        expect(
            parseGoldenCaseAddArgs([
                '--issue',
                '235679',
                '--human-fix-commit',
                uppercaseCommit,
                '--case-name',
                'money-pl-235679',
            ]),
        ).toEqual({
            issueNumber: 235679,
            humanFixCommit: uppercaseCommit.toLowerCase(),
            caseName: 'money-pl-235679',
        });
    });

    it('rejects missing, ambiguous, and unsafe arguments', () => {
        const commit = 'a'.repeat(40);

        expect(() => parseGoldenCaseAddArgs([])).toThrow(/--issue/i);
        expect(() =>
            parseGoldenCaseAddArgs(['--issue', '4', '--human-fix-commit', 'short']),
        ).toThrow(/full commit/i);
        expect(() =>
            parseGoldenCaseAddArgs([
                '--issue',
                '4',
                '--human-fix-commit',
                commit,
                '--case-name',
                '../escape',
            ]),
        ).toThrow(/case name/i);
        expect(() =>
            parseGoldenCaseAddArgs(['--issue', '4', '--human-fix-commit', commit, '--unknown']),
        ).toThrow(/unknown/i);
    });
});
