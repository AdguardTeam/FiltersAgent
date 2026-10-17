import { ConfigError, loadCoreConfig, type CoreConfig } from '../../src/config/config';

/**
 * Prefix for the independent golden judge's provider configuration.
 */
export const JUDGE_ENV_PREFIX = 'E2E_JUDGE_';

/**
 * Prefix accepted by the shared provider configuration loader.
 */
export const AGENT_LLM_ENV_PREFIX = 'LLM_';

/**
 * Load an independent judge configuration through the shared provider validation boundary.
 *
 * @param env - Environment source, including judge variables and shared browser settings.
 * @returns Validated judge configuration with no fallback to agent provider variables.
 */
export function loadJudgeCoreConfig(
    env: Record<string, string | undefined> = process.env,
): CoreConfig {
    const judgeEnv = Object.fromEntries(
        Object.entries(env).filter(([name]) => !name.startsWith(AGENT_LLM_ENV_PREFIX)),
    );
    for (const [name, value] of Object.entries(env)) {
        if (name.startsWith(JUDGE_ENV_PREFIX)) {
            judgeEnv[`${AGENT_LLM_ENV_PREFIX}${name.slice(JUDGE_ENV_PREFIX.length)}`] = value;
        }
    }
    try {
        return loadCoreConfig(judgeEnv);
    } catch (error) {
        if (error instanceof ConfigError) {
            throw new ConfigError(
                error.message
                    .replace('Invalid configuration:', 'Invalid judge configuration:')
                    .replaceAll(AGENT_LLM_ENV_PREFIX, JUDGE_ENV_PREFIX),
            );
        }
        throw error;
    }
}

/**
 * Load the judge and, when requested, the agent before starting selected cases.
 *
 * @param env - Explicit environment source for both independent configurations.
 * @param oracleOnly - Whether the invocation evaluates only the independent human oracle.
 * @returns Judge configuration and a nullable agent configuration.
 */
export function loadGoldenE2EConfigs(
    env: Record<string, string | undefined>,
    oracleOnly: boolean,
): {
    /**
     * Independent judge configuration required by every invocation.
     */
    judge: CoreConfig;
    /**
     * Agent configuration omitted for independent oracle evaluation.
     */
    agent: CoreConfig | null;
} {
    return { judge: loadJudgeCoreConfig(env), agent: oracleOnly ? null : loadCoreConfig(env) };
}
