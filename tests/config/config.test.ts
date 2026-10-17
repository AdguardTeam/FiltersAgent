import { describe, it, expect } from 'vitest';
import {
    loadConfig,
    loadCoreConfig,
    loadGithubReadConfig,
    ConfigError,
} from '../../src/config/config';
import { LlmApi } from '../../src/config/llm-api';
import { ReasoningEffort } from '../../src/config/reasoning-effort';

const validEnv = {
    GITHUB_TOKEN: 'ghp_test',
    GITHUB_REPO_OWNER: 'example-owner',
    GITHUB_REPO_NAME: 'example-repo',
    LLM_API_KEY: 'sk-test',
    LLM_BASE_URL: 'https://llm.example.com/v1',
    LLM_MODEL: 'example-reasoning-model',
    LLM_VISION_MODEL: 'example-vision-model',
    LLM_CONTEXT_WINDOW_TOKENS: '1048576',
    LLM_MAX_OUTPUT_TOKENS: '384000',
    LLM_VISION_MAX_OUTPUT_TOKENS: '65536',
};

describe('loadConfig', () => {
    it('loads GitHub-only read configuration without any LLM credentials', () => {
        expect(
            loadGithubReadConfig({
                GITHUB_TOKEN: 'read-token',
                GITHUB_REPO_OWNER: 'example',
                GITHUB_REPO_NAME: 'filters',
            }),
        ).toEqual({
            token: 'read-token',
            owner: 'example',
            repo: 'filters',
        });
    });

    it('requires only the GitHub token for GitHub-only read configuration', () => {
        expect(() => loadGithubReadConfig({})).toThrow(/github\.token/i);
        try {
            loadGithubReadConfig({});
        } catch (error) {
            expect((error as Error).message).not.toContain('llm.apiKey');
        }
    });

    it('resolves owner/repo from GITHUB_REPOSITORY when the checkout names a fork', () => {
        // A workflow environment (GITHUB_REPOSITORY) must alone drive which repository the agent
        // works with: no literal in code names it.
        const github = loadGithubReadConfig({
            GITHUB_TOKEN: 'read-token',
            GITHUB_REPOSITORY: 'fork-owner/list-repo',
        });
        expect(github.owner).toBe('fork-owner');
        expect(github.repo).toBe('list-repo');
    });

    it('prefers the explicit GITHUB_REPO_OWNER/GITHUB_REPO_NAME pair over GITHUB_REPOSITORY', () => {
        const config = loadConfig({
            ...validEnv,
            GITHUB_REPO_OWNER: 'pair-owner',
            GITHUB_REPO_NAME: 'pair-repo',
            GITHUB_REPOSITORY: 'github-owner/github-repo',
        });
        expect(config.github.owner).toBe('pair-owner');
        expect(config.github.repo).toBe('pair-repo');
    });

    it('fails naming GITHUB_REPOSITORY when it carries no owner/repo slug', () => {
        expect(() =>
            loadGithubReadConfig({ GITHUB_TOKEN: 'read-token', GITHUB_REPOSITORY: 'just-a-name' }),
        ).toThrow(/GITHUB_REPOSITORY/);
    });

    it('fails naming every candidate variable when no identity source is present', () => {
        try {
            loadGithubReadConfig({ GITHUB_TOKEN: 'read-token' });
            expect.unreachable('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(ConfigError);
            const message = (err as Error).message;
            expect(message).toContain('GITHUB_REPO_OWNER');
            expect(message).toContain('GITHUB_REPO_NAME');
            expect(message).toContain('GITHUB_REPOSITORY');
            expect(message).toContain('REPOSITORY_PATH');
        }
    });

    it('defaults the LLM API to openai-completions and accepts anthropic-messages', () => {
        expect(loadCoreConfig({ ...validEnv }).llm.api).toBe(LlmApi.OpenAiCompletions);
        expect(
            loadCoreConfig({
                ...validEnv,
                LLM_API: LlmApi.AnthropicMessages,
                LLM_BASE_URL: 'https://api.anthropic.com',
            }).llm.api,
        ).toBe(LlmApi.AnthropicMessages);
    });

    it.each(['https://api.anthropic.com/v1', 'https://api.anthropic.com/v1/'])(
        'refuses a versioned Anthropic base URL at startup (%s)',
        (baseUrl) => {
            const load = () =>
                loadCoreConfig({
                    ...validEnv,
                    LLM_API: LlmApi.AnthropicMessages,
                    LLM_BASE_URL: baseUrl,
                });
            expect(load).toThrow(ConfigError);
            expect(load).toThrow(/LLM_BASE_URL.*drop \/v1/u);
        },
    );

    it('accepts the unversioned Anthropic base URL and keeps versioned OpenAI URLs', () => {
        expect(
            loadCoreConfig({
                ...validEnv,
                LLM_API: LlmApi.AnthropicMessages,
                LLM_BASE_URL: 'https://api.anthropic.com',
            }).llm.baseUrl,
        ).toBe('https://api.anthropic.com');
        expect(loadCoreConfig(validEnv).llm.baseUrl).toBe(validEnv.LLM_BASE_URL);
    });

    it('rejects an unknown LLM_API, naming the variable', () => {
        const load = () => loadCoreConfig({ ...validEnv, LLM_API: 'anthropic' });
        expect(load).toThrow(ConfigError);
        expect(load).toThrow(/LLM_API/u);
    });

    it('preserves an omitted vision model for runtime resolution with its shared completion cap', () => {
        const env: Record<string, string | undefined> = { ...validEnv };
        delete env.LLM_VISION_MODEL;
        delete env.LLM_VISION_MAX_OUTPUT_TOKENS;
        const config = loadCoreConfig(env);
        expect(config.llm.visionModel).toBeUndefined();
        expect(config.llm.visionMaxOutputTokens).toBe(Number(validEnv.LLM_MAX_OUTPUT_TOKENS));
        expect(loadCoreConfig({ ...env, LLM_VISION_MODEL: '' })).toEqual(config);
    });

    it('parses explicit provider-neutral LLM configuration', () => {
        const config = loadConfig({ ...validEnv });
        expect(config.github.token).toBe('ghp_test');
        expect(config.github.owner).toBe('example-owner');
        expect(config.github.repo).toBe('example-repo');
        expect(config.llm.baseUrl).toBe('https://llm.example.com/v1');
        expect(config.llm.apiKey).toBe(validEnv.LLM_API_KEY);
        expect(config.llm.model).toBe('example-reasoning-model');
        expect(config.llm.visionModel).toBe('example-vision-model');
        expect(config.llm.requestTimeoutMs).toBe(300_000);
        expect(config.llm.requestMaxAttempts).toBe(2);
        expect(config.headless).toBe(true);
        expect(config.repositoryPath).toBeUndefined();
        expect(config.phaseReadinessBudgetMs).toBe(90_000);
        expect(config.agentInvestigationBudgetMs).toBeUndefined();
    });

    it('respects overrides for optional vars', () => {
        const config = loadConfig({
            ...validEnv,
            GITHUB_REPO_OWNER: 'me',
            LLM_BASE_URL: 'https://llm.example/api/v1',
            LLM_MODEL: 'google/gemini-3-flash-preview',
            LLM_VISION_MODEL: 'google/gemini-3.1-pro-preview',
            LLM_REQUEST_TIMEOUT_MS: '180000',
            LLM_REQUEST_MAX_ATTEMPTS: '3',
            LLM_CONTEXT_WINDOW_TOKENS: '262144',
            LLM_MAX_OUTPUT_TOKENS: '16384',
            LLM_VISION_MAX_OUTPUT_TOKENS: '4096',
            HEADLESS: 'false',
            REPOSITORY_PATH: '/repos/AdguardFilters',
            ADGUARD_EXTENSION_MANIFEST_VERSION: '2',
            PHASE_EXTENSION_READINESS_BUDGET_MS: '120000',
            AGENT_INVESTIGATION_BUDGET_MS: '2100000',
        });
        expect(config.github.owner).toBe('me');
        expect(config.llm.baseUrl).toBe('https://llm.example/api/v1');
        expect(config.llm.model).toBe('google/gemini-3-flash-preview');
        expect(config.llm.visionModel).toBe('google/gemini-3.1-pro-preview');
        expect(config.llm.requestTimeoutMs).toBe(180_000);
        expect(config.llm.requestMaxAttempts).toBe(3);
        expect(config.llm.contextWindowTokens).toBe(262_144);
        expect(config.llm.maxOutputTokens).toBe(16_384);
        expect(config.llm.visionMaxOutputTokens).toBe(4_096);
        expect(config.headless).toBe(false);
        expect(config.repositoryPath).toBe('/repos/AdguardFilters');
        expect(config.adguardExtensionManifestVersion).toBe(2);
        expect(config.phaseReadinessBudgetMs).toBe(120_000);
        expect(config.agentInvestigationBudgetMs).toBe(2_100_000);
    });

    it('rejects an agent investigation budget outside its safe bounds', () => {
        expect(() =>
            loadCoreConfig({
                ...validEnv,
                AGENT_INVESTIGATION_BUDGET_MS: '60000',
            }),
        ).toThrow(ConfigError);
    });

    it('rejects a phase readiness budget outside its safe bounds', () => {
        expect(() =>
            loadCoreConfig({
                ...validEnv,
                PHASE_EXTENSION_READINESS_BUDGET_MS: '1000',
            }),
        ).toThrow(ConfigError);
    });

    it('rejects an unsupported extension manifest generation', () => {
        expect(() =>
            loadCoreConfig({
                ...validEnv,
                ADGUARD_EXTENSION_MANIFEST_VERSION: '4',
            }),
        ).toThrow(ConfigError);
    });

    it('throws ConfigError naming a missing required var', () => {
        const { GITHUB_TOKEN: _, ...rest } = validEnv;
        try {
            loadConfig(rest);
            expect.unreachable('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(ConfigError);
            expect((err as Error).message).toContain('github.token');
        }
    });

    it('throws ConfigError listing all missing required vars at once', () => {
        expect(() => loadConfig({})).toThrow(ConfigError);
        try {
            loadConfig({});
        } catch (err) {
            const msg = (err as Error).message;
            expect(msg).toContain('github.token');
            expect(msg).toContain('llm.baseUrl');
            expect(msg).toContain('llm.apiKey');
            expect(msg).toContain('llm.model');
            expect(msg).not.toContain('llm.visionModel');
        }
    });

    it('rejects a non-URL LLM_BASE_URL', () => {
        expect(() => loadConfig({ ...validEnv, LLM_BASE_URL: 'not-a-url' })).toThrow(ConfigError);
    });

    it('loads core LLM configuration without GitHub credentials', () => {
        const config = loadCoreConfig({
            LLM_API_KEY: 'local-token',
            LLM_BASE_URL: 'https://llm.example.com/api/v1',
            LLM_MODEL: 'example-reasoning-model',
            LLM_VISION_MODEL: 'example-vision-model',
            LLM_CONTEXT_WINDOW_TOKENS: '1048576',
            LLM_MAX_OUTPUT_TOKENS: '384000',
            LLM_VISION_MAX_OUTPUT_TOKENS: '65536',
        });

        expect(config.llm).toEqual({
            api: LlmApi.OpenAiCompletions,
            apiKey: 'local-token',
            baseUrl: 'https://llm.example.com/api/v1',
            model: 'example-reasoning-model',
            requestMaxAttempts: 2,
            requestTimeoutMs: 300_000,
            visionModel: 'example-vision-model',
            reasoningEffort: ReasoningEffort.High,
            singleShotReasoningEffort: ReasoningEffort.Low,
            // The catalog limits pi acts on for every request: the window its auto-compaction
            // threshold is measured against, and the completion cap it always sends — one per
            // role, because the loop shares its budget between thinking and the terminal payload
            // while a vision call returns one bounded verdict.
            contextWindowTokens: 1_048_576,
            maxOutputTokens: 384_000,
            visionMaxOutputTokens: 65_536,
        });
        expect(config.headless).toBe(true);
    });

    it('always carries the request bounds, defaulted here and overridable from the env', () => {
        // `requestTimeoutMs` and `requestMaxAttempts` are required fields, so this loader is the
        // single place they are defaulted: every consumer — pi's retry wiring, the per-request
        // guard, the campaign manifest — reads a value that is always present and may not invent a
        // fallback of its own. Both halves are the contract: the defaults land when the env is
        // silent, and an explicit env value wins.
        const defaulted = loadCoreConfig({ ...validEnv });
        expect(defaulted.llm.requestTimeoutMs).toBe(300_000);
        expect(defaulted.llm.requestMaxAttempts).toBe(2);

        const overridden = loadCoreConfig({
            ...validEnv,
            LLM_REQUEST_TIMEOUT_MS: '240000',
            LLM_REQUEST_MAX_ATTEMPTS: '1',
        });
        expect(overridden.llm.requestTimeoutMs).toBe(240_000);
        expect(overridden.llm.requestMaxAttempts).toBe(1);
    });

    it.each(['LLM_CONTEXT_WINDOW_TOKENS', 'LLM_MAX_OUTPUT_TOKENS'] as const)(
        'requires %s, naming it, because a limit has no default',
        (key) => {
            // A limit belongs to the model the deployment names: a default above the provider's
            // own fails every request with HTTP 400, so the load fails first and names the variable.
            const env: Record<string, string | undefined> = { ...validEnv };
            delete env[key];
            expect(() => loadCoreConfig(env)).toThrow(new RegExp(key, 'u'));
        },
    );

    it('rejects a limit that is not a positive integer, naming the variable', () => {
        expect(() =>
            loadCoreConfig({ ...validEnv, LLM_MAX_OUTPUT_TOKENS: '<completion cap in tokens>' }),
        ).toThrow(/LLM_MAX_OUTPUT_TOKENS/u);
        expect(() => loadCoreConfig({ ...validEnv, LLM_CONTEXT_WINDOW_TOKENS: '0' })).toThrow(
            /LLM_CONTEXT_WINDOW_TOKENS/u,
        );
    });

    it('requires the vision cap only for a vision model of its own', () => {
        const env: Record<string, string | undefined> = { ...validEnv };
        delete env.LLM_VISION_MAX_OUTPUT_TOKENS;
        expect(() => loadCoreConfig(env)).toThrow(/LLM_VISION_MAX_OUTPUT_TOKENS/u);

        // One model serving both roles has one completion cap, stated once.
        const shared = loadCoreConfig({ ...env, LLM_VISION_MODEL: validEnv.LLM_MODEL });
        expect(shared.llm.visionMaxOutputTokens).toBe(384_000);
    });

    it('always carries a reasoning effort, defaulted to high and overridable from the env', () => {
        // What the model is asked to think with on every request of every run. It is required for
        // the same reason the request bounds are: absent, pi silently applies its own `medium`,
        // and no consumer downstream may invent a fallback. `high` is the deliberate default —
        // and the ceiling the registered reasoning model can carry.
        expect(loadCoreConfig({ ...validEnv }).llm.reasoningEffort).toBe(ReasoningEffort.High);

        const overridden = loadCoreConfig({
            ...validEnv,
            LLM_REASONING_EFFORT: ReasoningEffort.Low,
        });
        expect(overridden.llm.reasoningEffort).toBe(ReasoningEffort.Low);
    });

    it('carries a separate single-shot reasoning effort, defaulted to low', () => {
        // A single-shot call answers one bounded question; its thinking sits on the critical path
        // of the run, so it sits below the loop by default and is settable on its own.
        expect(loadCoreConfig({ ...validEnv }).llm.singleShotReasoningEffort).toBe(
            ReasoningEffort.Low,
        );
        const overridden = loadCoreConfig({
            ...validEnv,
            LLM_SINGLE_SHOT_REASONING_EFFORT: ReasoningEffort.Off,
        });
        expect(overridden.llm.singleShotReasoningEffort).toBe(ReasoningEffort.Off);
        expect(overridden.llm.reasoningEffort).toBe(ReasoningEffort.High);
        expect(() =>
            loadCoreConfig({ ...validEnv, LLM_SINGLE_SHOT_REASONING_EFFORT: 'xhigh' }),
        ).toThrow(/llm\.singleShotReasoningEffort/u);
    });

    it('ignores a leftover LLM_PROVIDER_ROUTING value', () => {
        expect(loadCoreConfig({ ...validEnv, LLM_PROVIDER_ROUTING: 'not json' })).toEqual(
            loadCoreConfig({ ...validEnv }),
        );
    });

    it('rejects a reasoning effort outside the levels this model supports', () => {
        // External input, so it fails loudly at the boundary instead of degrading. `xhigh` is the
        // interesting rejection: it is a real pi thinking level, but unsupported for a catalog
        // entry with no thinking-level map, where pi would fold it back down to `high` — a
        // configured value that silently means something else is exactly what must not load.
        expect(() => loadCoreConfig({ ...validEnv, LLM_REASONING_EFFORT: 'xhigh' })).toThrow(
            ConfigError,
        );
        expect(() => loadCoreConfig({ ...validEnv, LLM_REASONING_EFFORT: 'HIGH' })).toThrow(
            /llm\.reasoningEffort/u,
        );
    });

    it('ignores retired provider aliases entirely', () => {
        expect(() =>
            loadCoreConfig({
                OPENROUTER_API_KEY: 'legacy-key',
                OPENROUTER_BASE_URL: 'https://legacy.example/v1',
                OPENROUTER_MODEL: 'legacy-main-model',
                OPENROUTER_VISION_MODEL: 'legacy-vision-model',
            }),
        ).toThrow(ConfigError);
    });

    it.each(['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'] as const)(
        'requires explicit %s configuration, naming the variable',
        (key) => {
            // No provider has a default: whoever runs the agent names their own endpoint, key and
            // models, and a missing one fails the load with the name of the variable to set.
            const env: Record<string, string | undefined> = { ...validEnv };
            delete env[key];

            expect(() => loadCoreConfig(env)).toThrow(ConfigError);
            expect(() => loadCoreConfig(env)).toThrow(new RegExp(`${key} is required`, 'u'));
        },
    );

    it('rejects empty model identifiers', () => {
        expect(() => loadCoreConfig({ ...validEnv, LLM_MODEL: '' })).toThrow(ConfigError);
    });

    it.each([
        ['LLM_REQUEST_TIMEOUT_MS', '29999'],
        ['LLM_REQUEST_TIMEOUT_MS', '300001'],
        ['LLM_REQUEST_TIMEOUT_MS', 'not-a-number'],
        ['LLM_REQUEST_MAX_ATTEMPTS', '0'],
        ['LLM_REQUEST_MAX_ATTEMPTS', '4'],
        ['LLM_REASONING_EFFORT', 'unsupported'],
        ['LLM_SINGLE_SHOT_REASONING_EFFORT', 'unsupported'],
    ])('names the invalid provider tuning variable %s=%s', (key, value) => {
        expect(() => loadCoreConfig({ ...validEnv, [key]: value })).toThrow(ConfigError);
        expect(() => loadCoreConfig({ ...validEnv, [key]: value })).toThrow(key);
    });

    it('does not disable the Chromium sandbox merely because CI is set', () => {
        const config = loadConfig({ ...validEnv, CI: 'true' });
        expect(config.noSandbox).toBe(false);
    });

    it('sets noSandbox to false when CI is not set', () => {
        const config = loadConfig({ ...validEnv });
        expect(config.noSandbox).toBe(false);
    });

    it('allows an explicit NO_SANDBOX opt-in', () => {
        const config = loadConfig({ ...validEnv, CI: 'true', NO_SANDBOX: 'true' });
        expect(config.noSandbox).toBe(true);
    });
});
