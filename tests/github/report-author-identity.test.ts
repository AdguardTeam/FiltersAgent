import type { Octokit } from '@octokit/rest';
import { describe, expect, it } from 'vitest';
import {
    GITHUB_ACTIONS_BOT_LOGIN,
    resolveReportAuthorLogin,
} from '../../src/github/report-author-identity';

function octokitWhere(getAuthenticated: () => Promise<{ data: { login: string } }>): Octokit {
    return { rest: { users: { getAuthenticated } } } as unknown as Octokit;
}

function httpError(status: number): Error {
    return Object.assign(new Error(`HTTP ${String(status)}`), { status });
}

describe('resolveReportAuthorLogin', () => {
    it('returns the login a user token authenticates as', async () => {
        const octokit = octokitWhere(async () => ({ data: { login: 'maintainer' } }));

        await expect(resolveReportAuthorLogin(octokit)).resolves.toBe('maintainer');
    });

    it('treats the 403 refusal of GET /user as the Actions token, which posts as the bot', async () => {
        const octokit = octokitWhere(async () => {
            throw httpError(403);
        });

        await expect(resolveReportAuthorLogin(octokit)).resolves.toBe(GITHUB_ACTIONS_BOT_LOGIN);
    });

    it('rethrows any other failure instead of guessing the identity', async () => {
        const failure = httpError(502);
        const octokit = octokitWhere(async () => {
            throw failure;
        });

        await expect(resolveReportAuthorLogin(octokit)).rejects.toBe(failure);
    });
});
