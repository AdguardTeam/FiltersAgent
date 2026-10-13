import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapAgentRunSources } from '../../src/action/action-input-binding';
import { ConfigError } from '../../src/config/config-error';
import { ReasoningEffort } from '../../src/config/reasoning-effort';
import { AgentRunMode } from '../../src/entry/entry-inputs';
import { resolveAgentRunInputs } from '../../src/entry/entry-inputs-resolution';
import { BrowserExtensionExecutorName } from '../../src/environment/executor-name';

/**
 * Repository slug the runner guarantees through `GITHUB_REPOSITORY`; the fork's own slug.
 */
const GITHUB_REPOSITORY_SLUG = 'AdguardTeam/filters-agent-demo';

/**
 * Runner workspace path (`github.workspace`); the fallback for an unset `checkoutPath` input and
 * the base of the artifacts default.
 */
const GITHUB_WORKSPACE_DIR = '/home/runner/work/filters-agent-demo/filters-agent-demo';

/**
 * The `checkoutPath` input a workflow may pass; distinct from the workspace so the fallback case
 * cannot pass by coincidence.
 */
const INPUT_CHECKOUT_DIR = '/home/runner/actions-checkout/filters';

/**
 * The `artifactsDir` input a workflow may pass; distinct from the workspace default.
 */
const INPUT_ARTIFACTS_DIR = '/home/runner/artifacts-direct';

/**
 * LLM quartet values byte-identical through `config.llm`.
 */
const INPUT_LLM_BASE_URL = 'https://llm.example.test/v1';
const INPUT_LLM_API_KEY = 'llm-api-key';
const INPUT_LLM_MODEL = 'llm-model-a';
const INPUT_LLM_VISION_MODEL = 'llm-vision-a';

/**
 * Passthrough string inputs the validated inputs must carry unchanged.
 */
const INPUT_EXECUTORS = 'adguard-extension';
const INPUT_INSTRUCTION_PATH = 'docs/run-instruction.md';
const INPUT_MODEL_OVERRIDE = 'reasoning-model-b';
const INPUT_GITHUB_TOKEN = 'gh-token-123';
const INPUT_LIMIT = '25';

/**
 * Compose one runner-shaped action environment: the runner's guaranteed variables plus the
 * `INPUT_*` names of the example workflow, overridable per case.
 *
 * @param overrides - Variable overrides for one scenario; `undefined` removes a variable.
 * @returns The composed environment.
 */
function runnerEnv(
    overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
    return {
        GITHUB_REPOSITORY: GITHUB_REPOSITORY_SLUG,
        GITHUB_WORKSPACE: GITHUB_WORKSPACE_DIR,
        INPUT_ISSUENUMBER: '42',
        INPUT_BACKLOG: 'false',
        INPUT_LIMIT: INPUT_LIMIT,
        INPUT_EXECUTORS: INPUT_EXECUTORS,
        INPUT_INSTRUCTIONPATH: INPUT_INSTRUCTION_PATH,
        INPUT_ARTIFACTSDIR: INPUT_ARTIFACTS_DIR,
        INPUT_MODEL: INPUT_MODEL_OVERRIDE,
        INPUT_NOCOMMENT: 'false',
        INPUT_GITHUBTOKEN: INPUT_GITHUB_TOKEN,
        INPUT_CHECKOUTPATH: INPUT_CHECKOUT_DIR,
        INPUT_REPOSITORY: GITHUB_REPOSITORY_SLUG,
        INPUT_LLMBASEURL: INPUT_LLM_BASE_URL,
        INPUT_LLMAPIKEY: INPUT_LLM_API_KEY,
        INPUT_LLMMODEL: INPUT_LLM_MODEL,
        INPUT_LLMVISIONMODEL: INPUT_LLM_VISION_MODEL,
        INPUT_LLMCONTEXTWINDOWTOKENS: '131072',
        INPUT_LLMMAXOUTPUTTOKENS: '32768',
        INPUT_LLMVISIONMAXOUTPUTTOKENS: '8192',
        ...overrides,
    };
}

/**
 * Bind one action environment and resolve it through the real entry resolver — no mocks on the
 * resolver; the merged environment is what the action face hands it (`mapAgentRunSources`, then
 * `resolveAgentRunInputs`).
 *
 * @param actionEnv - The runner-shaped environment.
 * @returns The binding result plus the resolver's validated inputs.
 */
function boundAndResolved(actionEnv: Record<string, string | undefined>): {
    sources: ReturnType<typeof mapAgentRunSources>['sources'];
    envAdditions: ReturnType<typeof mapAgentRunSources>['envAdditions'];
    inputs: ReturnType<typeof resolveAgentRunInputs>;
} {
    const { sources, envAdditions } = mapAgentRunSources(actionEnv);
    const inputs = resolveAgentRunInputs({ ...actionEnv, ...envAdditions }, sources);
    return { sources, envAdditions, inputs };
}

describe('mapAgentRunSources with the real entry resolver', () => {
    it('carries every workflow input into the validated entry inputs without loss', () => {
        const { inputs, envAdditions } = boundAndResolved(runnerEnv());

        expect(inputs.mode).toEqual({ kind: AgentRunMode.SingleIssue, issueNumber: 42 });
        expect(inputs.executors).toEqual(['adguard-extension']);
        expect(inputs.instructionPath).toBe(INPUT_INSTRUCTION_PATH);
        expect(inputs.artifactsDir).toBe(INPUT_ARTIFACTS_DIR);
        expect(inputs.model).toBe(INPUT_MODEL_OVERRIDE);
        expect(inputs.comments).toEqual({
            enabled: true,
            token: INPUT_GITHUB_TOKEN,
            screenshotsBranch: 'filters-agent-screenshots',
        });
        expect(inputs.slug).toEqual({ owner: 'AdguardTeam', repo: 'filters-agent-demo' });
        expect(inputs.checkoutPath).toBe(INPUT_CHECKOUT_DIR);
        expect(inputs.config.llm.baseUrl).toBe(INPUT_LLM_BASE_URL);
        expect(inputs.config.llm.apiKey).toBe(INPUT_LLM_API_KEY);
        expect(inputs.config.llm.model).toBe(INPUT_LLM_MODEL);
        expect(inputs.config.llm.visionModel).toBe(INPUT_LLM_VISION_MODEL);
        expect(envAdditions.CLOAKBROWSER_AUTO_UPDATE).toBe('false');
    });

    it('carries the lint command input into the validated inputs, unset when blank', () => {
        const { inputs } = boundAndResolved(runnerEnv({ INPUT_LINTCOMMAND: ' npx aglint ' }));
        expect(inputs.lintCommand).toBe('npx aglint');

        expect(boundAndResolved(runnerEnv()).inputs.lintCommand).toBeUndefined();
        expect(
            boundAndResolved(runnerEnv({ INPUT_LINTCOMMAND: '   ' })).inputs.lintCommand,
        ).toBeUndefined();
    });

    it('carries the excluded labels input into the validated inputs, unset when blank', () => {
        const { inputs } = boundAndResolved(runnerEnv({ INPUT_EXCLUDEDLABELS: ' NSFW, Spam ' }));
        expect(inputs.excludedLabels).toEqual(['NSFW', 'Spam']);

        expect(boundAndResolved(runnerEnv()).inputs.excludedLabels).toBeUndefined();
        expect(
            boundAndResolved(runnerEnv({ INPUT_EXCLUDEDLABELS: ' , ' })).inputs.excludedLabels,
        ).toBeUndefined();
    });

    it('carries the in-progress labels and report bots inputs into the validated inputs, unset when blank', () => {
        const { inputs } = boundAndResolved(
            runnerEnv({
                INPUT_INPROGRESSLABELS: ' A: In progress , Triaged ',
                INPUT_REPORTBOTS: 'adguard-bot, ',
            }),
        );
        expect(inputs.inProgressLabels).toEqual(['A: In progress', 'Triaged']);
        expect(inputs.reportBots).toEqual(['adguard-bot']);

        const unset = boundAndResolved(runnerEnv()).inputs;
        expect(unset.inProgressLabels).toBeUndefined();
        expect(unset.reportBots).toBeUndefined();
        const blank = boundAndResolved(
            runnerEnv({ INPUT_INPROGRESSLABELS: ' , ', INPUT_REPORTBOTS: ' ' }),
        ).inputs;
        expect(blank.inProgressLabels).toBeUndefined();
        expect(blank.reportBots).toBeUndefined();
    });

    it('carries the force input onto the single-issue mode only', () => {
        expect(boundAndResolved(runnerEnv({ INPUT_FORCE: 'true' })).inputs.mode).toEqual({
            kind: AgentRunMode.SingleIssue,
            issueNumber: 42,
            force: true,
        });
        expect(boundAndResolved(runnerEnv({ INPUT_FORCE: 'false' })).inputs.mode).toEqual({
            kind: AgentRunMode.SingleIssue,
            issueNumber: 42,
        });
        expect(
            boundAndResolved(
                runnerEnv({
                    INPUT_FORCE: 'true',
                    INPUT_BACKLOG: 'true',
                    INPUT_ISSUENUMBER: undefined,
                }),
            ).inputs.mode,
        ).toEqual({ kind: AgentRunMode.Backlog, limit: 25 });
    });

    it('carries the gateway routing input into the validated configuration, unset when blank', () => {
        // Plain configuration, not a secret: a workflow steers its OpenRouter routing from the
        // action inputs, and a faulting upstream provider is excluded by one JSON value. An empty
        // input must stay unset all the way down, or a gateway that does not understand the
        // `provider` field would be sent one on every request.
        const { inputs } = boundAndResolved(
            runnerEnv({ INPUT_LLMPROVIDERROUTING: '{"ignore":["Together"]}' }),
        );
        expect(inputs.config.llm.providerRouting).toEqual({ ignore: ['Together'] });

        const blank = boundAndResolved(runnerEnv({ INPUT_LLMPROVIDERROUTING: '   ' }));
        expect(blank.envAdditions.LLM_PROVIDER_ROUTING).toBeUndefined();
        expect(blank.inputs.config.llm.providerRouting).toBeUndefined();
    });

    it('carries the model limit inputs into the validated configuration', () => {
        const { inputs } = boundAndResolved(
            runnerEnv({
                INPUT_LLMCONTEXTWINDOWTOKENS: '262144',
                INPUT_LLMMAXOUTPUTTOKENS: '32768',
                INPUT_LLMVISIONMAXOUTPUTTOKENS: '65536',
            }),
        );
        expect(inputs.config.llm.contextWindowTokens).toBe(262_144);
        expect(inputs.config.llm.maxOutputTokens).toBe(32_768);
        expect(inputs.config.llm.visionMaxOutputTokens).toBe(65_536);
    });

    it('fails at start naming a model limit the workflow left out', () => {
        // No limit has a default: one above the provider's own would fail every request with HTTP
        // 400 after the run had started, so the resolver refuses the run before it spends anything.
        expect(() =>
            boundAndResolved(runnerEnv({ INPUT_LLMCONTEXTWINDOWTOKENS: undefined })),
        ).toThrow(/LLM_CONTEXT_WINDOW_TOKENS/u);
        expect(() => boundAndResolved(runnerEnv({ INPUT_LLMMAXOUTPUTTOKENS: '' }))).toThrow(
            /LLM_MAX_OUTPUT_TOKENS/u,
        );
    });

    it('carries the reasoning effort inputs into the validated configuration', () => {
        const { inputs } = boundAndResolved(
            runnerEnv({
                INPUT_LLMREASONINGEFFORT: 'off',
                INPUT_LLMSINGLESHOTREASONINGEFFORT: 'medium',
            }),
        );
        expect(inputs.config.llm.reasoningEffort).toBe(ReasoningEffort.Off);
        expect(inputs.config.llm.singleShotReasoningEffort).toBe(ReasoningEffort.Medium);
    });

    it('carries the screenshots branch into the comment policy, defaulted when unset', () => {
        const { inputs } = boundAndResolved(
            runnerEnv({ INPUT_SCREENSHOTSBRANCH: 'agent-screenshots' }),
        );
        expect(inputs.comments.screenshotsBranch).toBe('agent-screenshots');

        const unset = boundAndResolved(runnerEnv({ INPUT_SCREENSHOTSBRANCH: '  ' }));
        expect(unset.inputs.comments.screenshotsBranch).toBe('filters-agent-screenshots');
    });

    it('carries the request attempt bound into the validated configuration, defaulted when unset', () => {
        // A gateway that drops responses mid-stream twice in a row ends the run at the default
        // bound, so a workflow on such a gateway raises it.
        const { inputs } = boundAndResolved(runnerEnv({ INPUT_LLMREQUESTMAXATTEMPTS: '3' }));
        expect(inputs.config.llm.requestMaxAttempts).toBe(3);

        const unset = boundAndResolved(runnerEnv({}));
        expect(unset.inputs.config.llm.requestMaxAttempts).toBe(2);
    });

    it('resolves the backlog variant from the backlog flag with its limit', () => {
        const { inputs } = boundAndResolved(
            runnerEnv({ INPUT_BACKLOG: 'true', INPUT_ISSUENUMBER: undefined }),
        );

        expect(inputs.mode).toEqual({ kind: AgentRunMode.Backlog, limit: 25 });
    });

    it('fails the combined ConfigError naming every dropped mandatory input', () => {
        let failure: unknown;
        try {
            boundAndResolved(
                runnerEnv({ INPUT_LLMAPIKEY: undefined, INPUT_GITHUBTOKEN: undefined }),
            );
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(ConfigError);
        const message = (failure as Error).message;
        expect(message).toContain('llm.apiKey');
        expect(message).toContain('GITHUB_TOKEN');
    });

    it('fails the combined ConfigError naming a missing run mode next to an LLM input', () => {
        let failure: unknown;
        try {
            boundAndResolved(
                runnerEnv({ INPUT_ISSUENUMBER: undefined, INPUT_LLMVISIONMODEL: undefined }),
            );
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(ConfigError);
        const message = (failure as Error).message;
        expect(message).toContain('Run mode is required');
        expect(message).toContain('llm.visionModel');
    });

    it('resolves with the token still traveling when noComment disables posting', () => {
        const { inputs } = boundAndResolved(runnerEnv({ INPUT_NOCOMMENT: 'true' }));

        expect(inputs.comments.enabled).toBe(false);
        expect(inputs.comments.token).toBe(INPUT_GITHUB_TOKEN);
    });

    it('binds no checkout origin while identity still resolves from the repository channel', () => {
        const { sources, inputs } = boundAndResolved(runnerEnv({ INPUT_REPOSITORY: undefined }));

        expect(sources.checkoutOriginUrl).toBeNull();
        expect(inputs.slug).toEqual({ owner: 'AdguardTeam', repo: 'filters-agent-demo' });
    });

    it('falls back to the runner environment for repository, checkout path and artifacts dir', () => {
        const { inputs } = boundAndResolved(
            runnerEnv({
                INPUT_REPOSITORY: undefined,
                INPUT_CHECKOUTPATH: undefined,
                INPUT_ARTIFACTSDIR: undefined,
            }),
        );

        expect(inputs.slug).toEqual({ owner: 'AdguardTeam', repo: 'filters-agent-demo' });
        expect(inputs.checkoutPath).toBe(GITHUB_WORKSPACE_DIR);
        expect(inputs.artifactsDir).toBe(
            join(GITHUB_WORKSPACE_DIR, 'filters-agent-artifacts', 'artifacts'),
        );
    });

    it('locks the browser extension alone when the workflow names no executors', () => {
        const { inputs } = boundAndResolved(runnerEnv({ INPUT_EXECUTORS: undefined }));

        expect(inputs.executors).toEqual([BrowserExtensionExecutorName]);
    });

    it('reads one blocker module manifest per line or comma, none when unset', () => {
        const listed = mapAgentRunSources(
            runnerEnv({
                INPUT_BLOCKERMODULES:
                    '.filters-agent/cli/blocker-module.json\n other.json ,third.json',
            }),
        );

        expect(listed.blockerModulePaths).toEqual([
            '.filters-agent/cli/blocker-module.json',
            'other.json',
            'third.json',
        ]);
        expect(mapAgentRunSources(runnerEnv()).blockerModulePaths).toEqual([]);
    });

    it('fails named at the binding when the runner workspace is missing', () => {
        let failure: unknown;
        try {
            mapAgentRunSources(runnerEnv({ GITHUB_WORKSPACE: undefined }));
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(ConfigError);
        const message = (failure as Error).message;
        expect(message).toContain('GITHUB_WORKSPACE is required');
    });
});
