import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../../src/config/config';
import { LlmApi } from '../../../src/config/llm-api';
import { loadGoldenE2EConfigs, loadJudgeCoreConfig } from '../../../lab/e2e/judge-config';

const agentEnv = {
    LLM_BASE_URL: 'https://example.com/v1',
    LLM_API_KEY: 'fake-agent-key',
    LLM_MODEL: 'example-agent-model',
    LLM_VISION_MODEL: 'example-agent-vision-model',
    LLM_CONTEXT_WINDOW_TOKENS: '131072',
    LLM_MAX_OUTPUT_TOKENS: '32768',
    LLM_VISION_MAX_OUTPUT_TOKENS: '8192',
};

const judgeEnv = {
    E2E_JUDGE_BASE_URL: 'https://example.com/v1',
    E2E_JUDGE_API_KEY: 'fake-judge-key',
    E2E_JUDGE_MODEL: 'example-judge-model',
    E2E_JUDGE_CONTEXT_WINDOW_TOKENS: '65536',
    E2E_JUDGE_MAX_OUTPUT_TOKENS: '8192',
};

describe('loadJudgeCoreConfig', () => {
    it('names the missing judge variable instead of the agent one', () => {
        const { E2E_JUDGE_MODEL: _, ...missingModel } = judgeEnv;
        const load = () => loadJudgeCoreConfig({ ...agentEnv, ...missingModel });

        expect(load).toThrow(ConfigError);
        try {
            load();
        } catch (error) {
            const message = (error as Error).message;
            expect(message).toMatch(/^Invalid judge configuration:/u);
            expect(message).toContain('E2E_JUDGE_MODEL is required');
            expect(message).not.toContain('LLM_MODEL');
        }
    });

    it('names an invalid judge timeout using its own environment variable', () => {
        const load = () => loadJudgeCoreConfig({ ...judgeEnv, E2E_JUDGE_REQUEST_TIMEOUT_MS: '5' });

        expect(load).toThrow(ConfigError);
        expect(load).toThrow('E2E_JUDGE_REQUEST_TIMEOUT_MS');
        expect(load).not.toThrow(/LLM_REQUEST_TIMEOUT_MS/u);
    });

    it('reads only E2E_JUDGE_* for the judge', () => {
        const config = loadJudgeCoreConfig({
            ...agentEnv,
            ...judgeEnv,
            HEADLESS: 'false',
            NO_SANDBOX: 'true',
        });

        expect(config.llm.model).toBe('example-judge-model');
        expect(config.llm.visionModel ?? config.llm.model).toBe('example-judge-model');
        expect(config.llm.visionMaxOutputTokens).toBe(8192);
        expect(config.headless).toBe(false);
        expect(config.noSandbox).toBe(true);
    });

    it('rejects an anthropic-messages judge base URL ending in /v1', () => {
        const load = () =>
            loadJudgeCoreConfig({
                ...judgeEnv,
                E2E_JUDGE_API: LlmApi.AnthropicMessages,
            });

        expect(load).toThrow(ConfigError);
        expect(load).toThrow(/E2E_JUDGE_BASE_URL/u);
    });
});

describe('loadGoldenE2EConfigs', () => {
    it('needs only E2E_JUDGE_* in oracle-only mode', () => {
        const configs = loadGoldenE2EConfigs(judgeEnv, true);
        expect(configs.judge.llm.model).toBe('example-judge-model');
        expect(configs.agent).toBeNull();
        expect(() => loadGoldenE2EConfigs(judgeEnv, false)).toThrow(/LLM_MODEL/u);
    });
});
