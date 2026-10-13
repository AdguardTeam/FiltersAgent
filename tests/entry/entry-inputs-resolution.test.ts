import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/config-error';
import { resolveAgentRunInputs } from '../../src/entry/entry-inputs-resolution';

/**
 * The four mandatory LLM environment variables a real load carries, spelled once so every scenario
 * starts from a load that misses nothing but the slice under test.
 */
const LLM_ENV = {
    LLM_BASE_URL: 'https://llm.example.test/v1',
    LLM_API_KEY: 'test-llm-key',
    LLM_MODEL: 'deepseek-v4-flash',
    LLM_VISION_MODEL: 'gemini-3.7-flash',
    LLM_CONTEXT_WINDOW_TOKENS: '1048576',
    LLM_MAX_OUTPUT_TOKENS: '384000',
    LLM_VISION_MAX_OUTPUT_TOKENS: '65536',
} as const;

/**
 * Build one environment source for the resolver.
 *
 * @param overrides - Variables this scenario sets or unsets (`undefined` clears).
 * @returns The composed environment source.
 */
function rawEnv(
    overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
    return { ...LLM_ENV, ...overrides };
}

/**
 * Run one resolver call and return the thrown error.
 *
 * @param run - The resolver call expected to fail.
 * @returns The single thrown error.
 */
function captureFailure(run: () => unknown): Error {
    try {
        run();
    } catch (error) {
        return error as Error;
    }
    throw new Error('Expected the resolver call to fail.');
}

describe('resolveAgentRunInputs', () => {
    it('resolves a single-issue run from a repository flag, an issue number, and a token', () => {
        const inputs = resolveAgentRunInputs(rawEnv({ GITHUB_TOKEN: 'test-token' }), {
            repository: 'example/list',
            issueNumber: 12,
            artifactsDir: '/tmp/runs/issue-12',
        });

        expect(inputs.slug).toEqual({ owner: 'example', repo: 'list' });
        expect(inputs.mode).toEqual({ kind: 'single_issue', issueNumber: 12 });
        expect(inputs.comments).toEqual({
            enabled: true,
            token: 'test-token',
            screenshotsBranch: 'filters-agent-screenshots',
        });
        expect(inputs.artifactsDir).toBe('/tmp/runs/issue-12');
        expect(inputs.config.llm.model).toBe('deepseek-v4-flash');
    });

    it('carries the GitHub Actions run URL when the runner variables exist', () => {
        const inputs = resolveAgentRunInputs(
            rawEnv({
                GITHUB_TOKEN: 'test-token',
                GITHUB_SERVER_URL: 'https://github.com/',
                GITHUB_REPOSITORY: 'example/list',
                GITHUB_RUN_ID: '123456789',
            }),
            { repository: 'example/list', issueNumber: 12 },
        );

        expect(inputs.actionsRunUrl).toBe('https://github.com/example/list/actions/runs/123456789');
    });

    it('carries no run URL without the runner variables', () => {
        const inputs = resolveAgentRunInputs(rawEnv({ GITHUB_TOKEN: 'test-token' }), {
            repository: 'example/list',
            issueNumber: 12,
        });

        expect(inputs.actionsRunUrl).toBeUndefined();
    });

    it('prefers the explicit repository flag over the workflow environment', () => {
        const inputs = resolveAgentRunInputs(
            rawEnv({ GITHUB_REPOSITORY: 'workflow/repo', GITHUB_TOKEN: 'test-token' }),
            { repository: 'flagged/repo', issueNumber: 3 },
        );

        expect(inputs.slug).toEqual({ owner: 'flagged', repo: 'repo' });
    });

    it('carries the checkout path and resolves the identity from the checkout origin', () => {
        const inputs = resolveAgentRunInputs(
            rawEnv({ REPOSITORY_PATH: '/tmp/forks/list', GITHUB_TOKEN: 'test-token' }),
            { issueNumber: 5, checkoutOriginUrl: 'https://github.com/owner/list.git' },
        );

        expect(inputs.checkoutPath).toBe('/tmp/forks/list');
        expect(inputs.slug).toEqual({ owner: 'owner', repo: 'list' });
    });

    it('resolves the backlog mode with the caller limit', () => {
        const inputs = resolveAgentRunInputs(rawEnv({ GITHUB_TOKEN: 'test-token' }), {
            repository: 'example/list',
            backlog: true,
            limit: 25,
        });

        expect(inputs.slug).toEqual({ owner: 'example', repo: 'list' });
        expect(inputs.mode).toEqual({ kind: 'backlog', limit: 25 });
    });

    it('leaves the backlog limit unset for the queue defaults', () => {
        const inputs = resolveAgentRunInputs(rawEnv({ GITHUB_TOKEN: 'test-token' }), {
            repository: 'example/list',
            backlog: true,
        });

        expect(inputs.mode).toEqual({ kind: 'backlog' });
    });

    it('keeps publishing disabled when --no-comment accompanies the token, without failing', () => {
        const inputs = resolveAgentRunInputs(rawEnv({ GITHUB_TOKEN: 'test-token' }), {
            repository: 'example/list',
            issueNumber: 9,
            noComment: true,
        });

        expect(inputs.comments).toEqual({
            enabled: false,
            token: 'test-token',
            screenshotsBranch: 'filters-agent-screenshots',
        });
    });

    it('lifts the repository identity and the read token for a snapshot-sourced issue', () => {
        const inputs = resolveAgentRunInputs(rawEnv(), {
            issueNumber: 7,
            issueSnapshotPath: 'fixtures/issue.json',
        });

        expect(inputs.slug).toBeNull();
        expect(inputs.comments).toEqual({
            enabled: false,
            screenshotsBranch: 'filters-agent-screenshots',
        });
        expect(inputs.issueSnapshotPath).toBe('fixtures/issue.json');
    });

    it('parses a comma-separated executor set into a trimmed non-empty list', () => {
        const inputs = resolveAgentRunInputs(rawEnv({ GITHUB_TOKEN: 'test-token' }), {
            repository: 'example/list',
            issueNumber: 2,
            executors: ' adguard-desktop , browser-extension ',
        });

        expect(inputs.executors).toEqual(['adguard-desktop', 'browser-extension']);
    });

    it("names an executor absent from this run face's registry before any seam runs", () => {
        const failure = captureFailure(() =>
            resolveAgentRunInputs(rawEnv({ GITHUB_TOKEN: 'test-token' }), {
                repository: 'example/list',
                issueNumber: 2,
                executors: 'browser_extension,typo_executor',
                knownExecutorNames: ['browser_extension'],
            }),
        );

        expect(failure).toBeInstanceOf(ConfigError);
        expect(failure.message).toContain('--executors');
        expect(failure.message).toContain('typo_executor');
    });

    it('accepts every requested executor already registered for this run face', () => {
        const inputs = resolveAgentRunInputs(rawEnv({ GITHUB_TOKEN: 'test-token' }), {
            repository: 'example/list',
            issueNumber: 2,
            executors: 'browser_extension',
            knownExecutorNames: ['browser_extension', 'adguard_desktop'],
        });

        expect(inputs.executors).toEqual(['browser_extension']);
    });

    it('names a malformed --executors value', () => {
        const failure = captureFailure(() =>
            resolveAgentRunInputs(rawEnv({ GITHUB_TOKEN: 'test-token' }), {
                repository: 'example/list',
                issueNumber: 2,
                executors: 'adguard-desktop,,',
            }),
        );

        expect(failure).toBeInstanceOf(ConfigError);
        expect(failure.message).toContain('--executors');
        expect(failure.message).toContain('non-empty');
    });

    it.each([
        {
            name: 'both an issue number and backlog mode',
            sources: { issueNumber: 1, backlog: true },
            expected: 'cannot be combined',
        },
        {
            name: 'neither an issue number nor backlog mode',
            sources: {},
            expected: 'Run mode is required',
        },
        {
            name: 'a non-positive backlog limit',
            sources: { backlog: true, limit: 0 },
            expected: 'must be a positive integer',
        },
    ])('names a wrong run mode: $name', ({ sources, expected }) => {
        const failure = captureFailure(() =>
            resolveAgentRunInputs(rawEnv({ GITHUB_TOKEN: 'test-token' }), {
                repository: 'example/list',
                ...sources,
            }),
        );

        expect(failure).toBeInstanceOf(ConfigError);
        expect(failure.message).toContain(expected);
    });

    it('fails once naming every missing mandatory input, so one read tells the operator all of them', () => {
        const failure = captureFailure(() => resolveAgentRunInputs({}, {}));

        expect(failure).toBeInstanceOf(ConfigError);
        expect(failure.message).toContain('llm.baseUrl');
        expect(failure.message).toContain('Repository identity');
        expect(failure.message).toContain('Run mode is required');
        // Nothing reads GitHub yet: no mode was determined, so no read-token problem may fire.
        expect(failure.message).not.toContain('GITHUB_TOKEN');
    });

    it('names the read token when the fetch seam reads an issue without one', () => {
        const failure = captureFailure(() => resolveAgentRunInputs({}, { issueNumber: 4 }));

        expect(failure).toBeInstanceOf(ConfigError);
        expect(failure.message).toContain('llm.baseUrl');
        expect(failure.message).toContain('Repository identity');
        expect(failure.message).toContain('GITHUB_TOKEN');
    });

    it('lifts a malformed repository slug into the combined failure with its neighbors', () => {
        const failure = captureFailure(() =>
            resolveAgentRunInputs(rawEnv(), { repository: 'no-slash' }),
        );

        expect(failure).toBeInstanceOf(ConfigError);
        expect(failure.message).toContain("must be an 'owner/repo' slug");
        expect(failure.message).toContain('Run mode is required');
    });
});
