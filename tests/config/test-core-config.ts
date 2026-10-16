import type { CoreConfig, LlmConfig } from '../../src/config/config';
import { LlmApi } from '../../src/config/llm-api';
import { ReasoningEffort } from '../../src/config/reasoning-effort';

/**
 * The hand-built runtime configuration test suites hand to a runner or a core entry point instead
 * of going through `loadCoreConfig`. Every required field is defaulted here exactly once, so adding
 * a required field to `CoreConfigSchema` is a one-line change rather than an edit to twenty
 * literals; a suite states only the fields its assertions actually depend on.
 */

/**
 * Provider slice defaults. The bounds, the reasoning level and the three catalog limits mirror what
 * `loadCoreConfig` applies at the env boundary, so a fixture-driven run is bounded — and thinks,
 * and caps its completions — exactly like a real one.
 */
const DEFAULT_LLM_CONFIG: LlmConfig = {
    api: LlmApi.OpenAiCompletions,
    baseUrl: 'https://llm.example.test/v1',
    apiKey: 'test-llm-key',
    model: 'deepseek-v4-flash',
    visionModel: 'gemini-3.7-flash',
    requestTimeoutMs: 120_000,
    requestMaxAttempts: 2,
    reasoningEffort: ReasoningEffort.High,
    singleShotReasoningEffort: ReasoningEffort.Medium,
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 384_000,
    visionMaxOutputTokens: 8_192,
};

/**
 * Per-suite deviations from the core fixture. The provider slice is merged field by field so a
 * suite can name just its base URL.
 */
export type TestCoreConfigOverrides = Omit<Partial<CoreConfig>, 'llm'> & {
    /**
     * Provider fields this suite needs to differ from `DEFAULT_LLM_CONFIG`.
     */
    llm?: Partial<LlmConfig>;
};

/**
 * Build a complete `CoreConfig` for a test.
 *
 * @param overrides - Fields this suite needs to differ from the defaults.
 * @returns The validated-shape core configuration.
 */
export function testCoreConfig(overrides: TestCoreConfigOverrides = {}): CoreConfig {
    const { llm, ...rest } = overrides;
    return {
        headless: true,
        noSandbox: false,
        ...rest,
        llm: { ...DEFAULT_LLM_CONFIG, ...llm },
    };
}

/**
 * A complete explicit provider environment, as a user of the benchmark sets it. Every variable
 * `loadCoreConfig` requires is present; a suite spreads it and overrides or deletes what it tests.
 */
export const TEST_PROVIDER_ENV = {
    LLM_BASE_URL: 'https://llm.example.test/v1',
    LLM_API_KEY: 'test-llm-key',
    LLM_MODEL: 'example-reasoning-model',
    LLM_VISION_MODEL: 'example-vision-model',
    LLM_CONTEXT_WINDOW_TOKENS: '131072',
    LLM_MAX_OUTPUT_TOKENS: '32768',
    LLM_VISION_MAX_OUTPUT_TOKENS: '8192',
} as const;
