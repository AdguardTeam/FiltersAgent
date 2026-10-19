import * as v from 'valibot';
import { runAgentSession } from '../../src/pi/session-runner';
import { buildTerminalTool } from '../../src/pi/terminal-tool';
import { LlmApi } from '../../src/config/llm-api';
import { ReasoningEffort } from '../../src/config/reasoning-effort';
import type { RunBudgets } from '../../src/pi/guard-types';
import { createPiRuntime, type PiRuntime, type PiRuntimeConfig } from '../../src/pi/runtime';
import { createSingleShotClient } from '../../src/pi/single-shot';
import type { SingleShotClient } from '../../src/pi/single-shot-types';
import type { RunRetryBounds } from '../../src/pi/session-runner';

/**
 * The hermetic pi runtime every suite that drives a real session builds: the credential and the two
 * model ids are test fixtures with no meaning beyond being echoed back by the hermetic provider, so
 * they are declared once here and a suite states only what it needs to differ.
 */

/**
 * Credential handed to the hermetic provider. Nothing authenticates it; it exists so the runtime's
 * in-memory credential store is populated and the `authorization` header is assertable.
 */
export const TEST_API_KEY = 'test-llm-key';

/**
 * Reasoning-model id registered on the hermetic runtime: a real provider slug, so a suite reading
 * the wire `model` field sees a production-shaped value.
 */
export const REASONING_MODEL = 'deepseek-v4-flash';

/**
 * Vision-model id registered on the hermetic runtime, likewise a real slug — it must differ from
 * `REASONING_MODEL` so a suite can tell the two resolved handles apart.
 */
export const VISION_MODEL = 'gemini-3.7-flash';

/**
 * Context window registered on the hermetic runtime. Production-shaped, so nothing a suite sends is
 * anywhere near it and pi's clamp of the completion cap to the remaining window never fires; a
 * suite that IS testing compaction registers its own small window.
 */
export const TEST_CONTEXT_WINDOW_TOKENS = 1_048_576;

/**
 * Completion cap registered for the hermetic runtime's REASONING model — the cap every loop request
 * carries. Deliberately not the production default: a suite reading `max_completion_tokens` off the
 * wire proves the configured per-role value reached it, which restating the default cannot.
 */
export const TEST_MAX_OUTPUT_TOKENS = 32_768;

/**
 * Completion cap registered for the hermetic runtime's VISION model, distinct from the loop cap for
 * the same reason: the two roles are configured apart, and only different values can show that a
 * single-shot vision call carries its own.
 */
export const TEST_VISION_MAX_OUTPUT_TOKENS = 4_096;

/**
 * Run bounds for a hermetic session that is not itself testing a bound. The deadline is the
 * schema's floor — far above any hermetic turn, so it never fires, while still keeping a wedged
 * provider from hanging the suite. The retry count is pi's own default, so a suite that does not
 * script a transient failure behaves exactly as it did while these bounds were optional.
 */
export const TEST_RUN_BUDGETS: RunBudgets = { requestTimeoutMs: 30_000 };

/**
 * Retry bounds paired with `TEST_RUN_BUDGETS`; see its note on the retry count.
 */
export const TEST_RUN_RETRIES: RunRetryBounds = { maxRetries: 3 };

/**
 * Reasoning effort for a hermetic session that is not itself testing the level. It is the
 * production default, so a suite reading a recorded request sees the level a real run sends; a
 * suite that IS testing the level passes its own.
 */
export const TEST_REASONING_EFFORT: ReasoningEffort = ReasoningEffort.High;

/**
 * Runtime configuration for one hermetic suite: the provider base URL is always the suite's own,
 * everything else falls back to the shared fixtures above.
 */
export type TestPiRuntimeOptions = Partial<PiRuntimeConfig> & Pick<PiRuntimeConfig, 'baseUrl'>;

/**
 * Build a pi runtime pointed at a hermetic provider.
 *
 * @param options - The provider base URL, plus any fixture field the suite needs to differ.
 * @returns The configured pi runtime handle.
 */
export async function createTestPiRuntime(options: TestPiRuntimeOptions): Promise<PiRuntime> {
    return await createPiRuntime({
        api: LlmApi.OpenAiCompletions,
        apiKey: TEST_API_KEY,
        model: REASONING_MODEL,
        visionModel: VISION_MODEL,
        contextWindowTokens: TEST_CONTEXT_WINDOW_TOKENS,
        maxOutputTokens: TEST_MAX_OUTPUT_TOKENS,
        visionMaxOutputTokens: TEST_VISION_MAX_OUTPUT_TOKENS,
        reasoningEffort: TEST_REASONING_EFFORT,
        ...options,
    });
}

/**
 * Build a single-shot client bound to the hermetic runtime's vision model — what every suite that
 * exercises a vision call over the hermetic provider needs and nothing more.
 *
 * The reasoning-effort default and the role's completion cap match what
 * `createConfiguredSingleShotClient` wires in production, so a suite reading the recorded request
 * sees the real shape.
 *
 * @param baseUrl - The hermetic provider base URL.
 * @param reasoningEffort - Client-wide reasoning effort; defaults to the shared fixture.
 * @returns The vision-bound single-shot client.
 */
export async function createTestVisionClient(
    baseUrl: string,
    reasoningEffort: ReasoningEffort = TEST_REASONING_EFFORT,
): Promise<SingleShotClient> {
    const runtime = await createTestPiRuntime({ baseUrl });
    return createSingleShotClient(runtime, runtime.visionModel, {
        reasoningEffort,
    });
}

/**
 * Build both single-shot clients of ONE hermetic runtime: one bound to the reasoning model, one to
 * the vision model.
 *
 * A suite comparing what the two roles put on the wire — a reasoning parameter, a completion cap —
 * needs the model to be the only difference between the two calls, which one runtime and one
 * client-wide configuration is what guarantees.
 *
 * @param baseUrl - The hermetic provider base URL.
 * @param reasoningEffort - Client-wide reasoning effort for both; defaults to the shared fixture.
 * @returns The reasoning-bound and vision-bound clients.
 */
export async function createTestSingleShotClients(
    baseUrl: string,
    reasoningEffort: ReasoningEffort = TEST_REASONING_EFFORT,
): Promise<{
    /**
     * Client bound to the runtime's reasoning model.
     */
    reasoning: SingleShotClient;

    /**
     * Client bound to the runtime's vision model.
     */
    vision: SingleShotClient;
}> {
    const runtime = await createTestPiRuntime({ baseUrl });
    return {
        reasoning: createSingleShotClient(runtime, runtime.reasoningModel, {
            reasoningEffort,
        }),
        vision: createSingleShotClient(runtime, runtime.visionModel, {
            reasoningEffort,
        }),
    };
}

/**
 * Terminal tool shared by scripted provider-session tests.
 */
export const TEST_TERMINAL_TOOL_NAME = 'submit_verdict';

const ScriptedVerdictSchema = v.object({
    verdict: v.picklist(['ok', 'retry']),
    summary: v.string(),
});

/**
 * Provider endpoint and run controls for the shared scripted-session scenario.
 */
export interface ScriptedSessionOptions {
    /**
     * Local provider URL, including the version path when its API needs one.
     */
    baseUrl: string;

    /**
     * Adapter the scripted provider serves.
     */
    api: LlmApi;

    /**
     * Temporary working directory owned by the calling suite.
     */
    workDir: string;

    /**
     * Retry bounds under test.
     */
    retries: RunRetryBounds;

    /**
     * Run bounds under test; absent keeps `TEST_RUN_BUDGETS`.
     */
    budgets?: RunBudgets;
}

/**
 * Run the shared terminal-verdict scenario against a scripted provider on either API.
 *
 * @param options - Provider endpoint, adapter and session controls.
 * @returns The sealed outcome; provider ownership and recorded requests stay with the caller.
 */
export async function runScriptedSession(options: ScriptedSessionOptions) {
    const runtime = await createTestPiRuntime({ api: options.api, baseUrl: options.baseUrl });
    const terminal = buildTerminalTool<v.InferOutput<typeof ScriptedVerdictSchema>>({
        name: TEST_TERMINAL_TOOL_NAME,
        description: 'Submit the final verdict.',
        schema: ScriptedVerdictSchema,
    });
    return runAgentSession({
        runtime,
        systemPrompt: 'You are a test agent. Finish by calling submit_verdict.',
        userTask: 'Work the tools, then submit the verdict.',
        nudge: 'Call submit_verdict now.',
        terminal,
        budgets: options.budgets ?? TEST_RUN_BUDGETS,
        retries: options.retries,
        reasoningEffort: TEST_REASONING_EFFORT,
        workDir: options.workDir,
    });
}
