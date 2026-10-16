import * as v from 'valibot';

/**
 * Environment variable naming the LLM API. The one place this name is spelled; config and the
 * action's optional `llmApi` binding import it.
 */
export const LLM_API_VAR = 'LLM_API';

/**
 * Supported wire APIs for both LLM model roles.
 */
export const LlmApi = {
    /**
     * OpenAI chat completions, including compatible gateways.
     */
    OpenAiCompletions: 'openai-completions',

    /**
     * Native Anthropic Messages API.
     */
    AnthropicMessages: 'anthropic-messages',
} as const;

/**
 * One supported LLM wire API.
 */
export type LlmApi = (typeof LlmApi)[keyof typeof LlmApi];

export const LLM_API_VALUES = Object.values(LlmApi);

/**
 * Existing gateway deployments keep their wire API when no API is configured.
 */
export const DEFAULT_LLM_API = LlmApi.OpenAiCompletions;

export const LlmApiSchema = v.picklist(
    LLM_API_VALUES,
    `${LLM_API_VAR} must be one of: ${LLM_API_VALUES.join(', ')}`,
);

/**
 * Endpoint fields needed to check an API's base URL contract.
 */
export interface LlmEndpoint {
    /**
     * Wire API selected for this endpoint.
     */
    api: LlmApi;

    /**
     * Validated absolute provider base URL.
     */
    baseUrl: string;
}

/**
 * Anthropic appends /v1/messages, so a versioned base path would duplicate the version segment.
 */
const ANTHROPIC_VERSIONED_PATH_PATTERN = /\/v1\/?$/u;

/**
 * Check whether a validated endpoint omits the version segment appended by the Anthropic SDK.
 *
 * @param endpoint - API and valid absolute base URL from the configuration schema.
 * @returns True unless the Anthropic base URL already ends in /v1, with or without a slash.
 */
export function isLlmBaseUrlSupported(endpoint: LlmEndpoint): boolean {
    return (
        endpoint.api !== LlmApi.AnthropicMessages ||
        !ANTHROPIC_VERSIONED_PATH_PATTERN.test(new URL(endpoint.baseUrl).pathname)
    );
}
