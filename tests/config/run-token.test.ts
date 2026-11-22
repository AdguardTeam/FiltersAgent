import { describe, expect, it } from 'vitest';
import {
    GITHUB_TOKEN_VAR,
    GITHUB_USER_TOKEN_VAR,
    RunTokenSource,
    resolveRunToken,
    runTokenValues,
} from '../../src/config/run-token';

describe('resolveRunToken', () => {
    it.each([
        [GITHUB_TOKEN_VAR, RunTokenSource.GithubToken],
        [GITHUB_USER_TOKEN_VAR, RunTokenSource.GithubUserToken],
    ] as const)(
        'takes the token and its source from the one variable that is set',
        (variable, source) => {
            expect(resolveRunToken({ [variable]: '  test-token  ' })).toEqual({
                token: 'test-token',
                source,
            });
        },
    );

    it('treats a blank value as unset', () => {
        expect(
            resolveRunToken({
                [GITHUB_TOKEN_VAR]: '   ',
                [GITHUB_USER_TOKEN_VAR]: 'user-token',
            }),
        ).toEqual({ token: 'user-token', source: RunTokenSource.GithubUserToken });

        expect(resolveRunToken({})).toEqual({});
    });

    it('reports a problem naming both variables when both hold a value', () => {
        const resolution = resolveRunToken({
            [GITHUB_TOKEN_VAR]: 'actions-token',
            [GITHUB_USER_TOKEN_VAR]: 'user-token',
        });

        expect(resolution.token).toBeUndefined();
        expect(resolution.source).toBeUndefined();
        expect(resolution.problem).toContain(GITHUB_TOKEN_VAR);
        expect(resolution.problem).toContain(GITHUB_USER_TOKEN_VAR);
    });
});

describe('runTokenValues', () => {
    it('lists every token value for redaction, also when both are set', () => {
        expect(
            runTokenValues({
                [GITHUB_TOKEN_VAR]: ' actions-token ',
                [GITHUB_USER_TOKEN_VAR]: 'user-token',
            }),
        ).toEqual(['actions-token', 'user-token']);

        expect(runTokenValues({})).toEqual([]);
    });
});
