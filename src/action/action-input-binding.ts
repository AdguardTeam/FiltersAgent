/**
 * The action face's input binding. The workflow inputs of the `filters-agent` action are declared
 * once in `action-input-names.ts` — as a camelCase table mirroring `AgentRunInputSources` — and
 * `mapAgentRunSources` reads only the environment a GitHub Actions runner provides: `INPUT_<NAME>`
 * variables for the `action.yml` inputs plus the runner's guaranteed variables. It returns the
 * explicit `AgentRunInputSources`, the environment additions the resolver and `loadCoreConfig`
 * read, and the workspace the face's paths anchor on. The mapping is pure over `actionEnv` — a
 * missing mandatory input is left to the resolver, whose combined `ConfigError` fails the job named
 * before any seam runs — except the runner's workspace: the action face has exactly one runtime
 * (the container image) and every path anchors on the workspace GitHub binds, so a run without it
 * fails named right here at the binding.
 */

import {
    GITHUB_TOKEN_VAR,
    LLM_API_KEY_VAR,
    LLM_BASE_URL_VAR,
    LLM_CONTEXT_WINDOW_TOKENS_VAR,
    LLM_MAX_OUTPUT_TOKENS_VAR,
    LLM_MODEL_VAR,
    LLM_PROVIDER_ROUTING_VAR,
    LLM_REASONING_EFFORT_VAR,
    LLM_REQUEST_MAX_ATTEMPTS_VAR,
    LLM_SINGLE_SHOT_REASONING_EFFORT_VAR,
    LLM_VISION_MAX_OUTPUT_TOKENS_VAR,
    LLM_VISION_MODEL_VAR,
} from '../config/config';
import { ConfigError } from '../config/config-error';
import {
    GITHUB_REPOSITORY_VAR,
    optionalEnvValue,
    REPOSITORY_PATH_VAR,
} from '../config/repository-identity';
import type { AgentRunInputSources } from '../entry/entry-inputs';
import { BrowserExtensionExecutorName } from '../environment/executor-name';
import { AgentActionInputName } from './action-input-names';
import { GITHUB_WORKSPACE_VAR, workspaceArtifactsDefault } from './container-context';

/**
 * Environment variable cloakbrowser consults before self-updating; pinned for every action run.
 */
const CLOAKBROWSER_AUTO_UPDATE_VAR = 'CLOAKBROWSER_AUTO_UPDATE';

/**
 * The value pinning {@link CLOAKBROWSER_AUTO_UPDATE_VAR} off: an auto-update mid-run would swap the
 * browser binary under the run and silently invalidate it. The Docker image installs the browser at
 * build time; the action face verifies its presence only and never downloads.
 */
const CLOAKBROWSER_AUTO_UPDATE_DISABLED = 'false';

/**
 * Which entry environment variable each environment-channel input feeds, keyed by the input-name
 * vocabulary above. The sources-channel inputs are absent on purpose: they travel in
 * `AgentRunInputSources`, not in the environment, and only `checkoutPath` carries a runner fallback
 * here. The variable names themselves come from `config/config.ts`, the one place each is spelled.
 */
const AGENT_ACTION_INPUT_ENV_VAR: Partial<Record<AgentActionInputName, string>> = {
    [AgentActionInputName.checkoutPath]: REPOSITORY_PATH_VAR,
    [AgentActionInputName.githubToken]: GITHUB_TOKEN_VAR,
    [AgentActionInputName.llmBaseUrl]: LLM_BASE_URL_VAR,
    [AgentActionInputName.llmApiKey]: LLM_API_KEY_VAR,
    [AgentActionInputName.llmModel]: LLM_MODEL_VAR,
    [AgentActionInputName.llmVisionModel]: LLM_VISION_MODEL_VAR,
    [AgentActionInputName.llmProviderRouting]: LLM_PROVIDER_ROUTING_VAR,
    [AgentActionInputName.llmContextWindowTokens]: LLM_CONTEXT_WINDOW_TOKENS_VAR,
    [AgentActionInputName.llmMaxOutputTokens]: LLM_MAX_OUTPUT_TOKENS_VAR,
    [AgentActionInputName.llmVisionMaxOutputTokens]: LLM_VISION_MAX_OUTPUT_TOKENS_VAR,
    [AgentActionInputName.llmReasoningEffort]: LLM_REASONING_EFFORT_VAR,
    [AgentActionInputName.llmSingleShotReasoningEffort]: LLM_SINGLE_SHOT_REASONING_EFFORT_VAR,
    [AgentActionInputName.llmRequestMaxAttempts]: LLM_REQUEST_MAX_ATTEMPTS_VAR,
};

/**
 * The result of binding one action environment: the values one entry resolution consumes plus the
 * workspace the face's paths anchor on.
 */
export interface AgentActionBinding {
    /**
     * Explicit sources handed to `resolveAgentRunInputs`, carrying the parsed workflow inputs and
     * the runner fallbacks.
     */
    sources: AgentRunInputSources;

    /**
     * Environment additions merged into the entry environment before resolution; only variables
     * with a bound value are present.
     */
    envAdditions: Record<string, string>;

    /**
     * The workspace directory the runner bound (`GITHUB_WORKSPACE`), absent-or-blank collapsed; the
     * base of the artifacts default and the root the `artifacts-dir` output relativizes against.
     */
    workspaceDir: string;

    /**
     * Paths of the blocker module manifests the workflow plugs in, relative to the workspace or
     * absolute, in the order given; empty when it plugs in none.
     */
    blockerModulePaths: string[];
}

/**
 * Separator between manifest paths in the `blockerModules` input: commas or line breaks, so a
 * workflow may list one per line in a YAML block scalar.
 */
const MODULE_PATH_SEPARATOR = /[,\n]/u;

/**
 * The `INPUT_` environment key of one action input, the same mapping GitHub Actions applies:
 * uppercase the camelCase input name and concatenate without separators.
 *
 * @param inputName - CamelCase input name from the {@link AgentActionInputName} table.
 * @returns The environment variable holding the input's value.
 */
function inputEnvKey(inputName: AgentActionInputName): string {
    return `INPUT_${inputName.toUpperCase()}`;
}

/**
 * Read one action input's value, absent-or-blank collapsed to `undefined`.
 *
 * @param actionEnv - The runner-shaped environment.
 * @param inputName - CamelCase input name.
 * @returns The trimmed input value, or `undefined` when unset.
 */
function readActionInput(
    actionEnv: Readonly<Record<string, string | undefined>>,
    inputName: AgentActionInputName,
): string | undefined {
    return optionalEnvValue(actionEnv[inputEnvKey(inputName)]);
}

/**
 * Parse one numeric action input. A malformed value is left malformed on purpose: the resolver
 * rejects it with a named combined problem instead of a binding-local guess.
 *
 * @param raw - The raw input value, or `undefined` when unset.
 * @returns The numeric value, or `undefined` when unset.
 */
function numericActionInput(raw: string | undefined): number | undefined {
    return raw === undefined ? undefined : Number(raw);
}

/**
 * Parse one boolean action input. Workflows pass YAML booleans that reach the `INPUT_` variable as
 * `'true'`/`'false'` strings; any other value counts as false.
 *
 * @param raw - The raw input value, or `undefined` when unset.
 * @returns Whether the input is the string `'true'`.
 */
function booleanActionInput(raw: string | undefined): boolean {
    return raw?.trim().toLowerCase() === 'true';
}

/**
 * Render the message fired when the runner's workspace variable is missing or blank. GitHub binds
 * `GITHUB_WORKSPACE` for every action it runs; a run without it was started outside the runner, and
 * the face has no workspace to anchor its paths on, so the binding fails named before resolution.
 *
 * @returns The message naming the variable and what anchors on it.
 */
function nameMissingWorkspaceMessage(): string {
    return (
        `${GITHUB_WORKSPACE_VAR} is required: GitHub binds the checkout directory to it, ` +
        'and the artifacts default and the workspace-relative outputs anchor on it.'
    );
}

/**
 * Resolve the repository source: the explicit `repository` input, falling back to the runner's
 * `GITHUB_REPOSITORY` (the resolver reads that variable itself, but the binding fills the mapped
 * value so the action face and the CLI flag face carry the same source shape).
 *
 * @param actionEnv - The runner-shaped environment.
 * @returns The `owner/repo` value, or `undefined` when neither source has one.
 */
function repositorySource(
    actionEnv: Readonly<Record<string, string | undefined>>,
): string | undefined {
    return (
        readActionInput(actionEnv, AgentActionInputName.repository) ??
        optionalEnvValue(actionEnv[GITHUB_REPOSITORY_VAR])
    );
}

/**
 * Resolve the artifacts directory by precedence: the explicit `artifactsDir` input first, else the
 * workspace default (`<GITHUB_WORKSPACE>/filters-agent-artifacts/artifacts`) — the one default the
 * face's one runtime has, required for every run on the face.
 *
 * @param actionEnv - The runner-shaped environment.
 * @param workspaceDir - The bound workspace directory the default anchors on.
 * @returns The artifacts directory.
 */
function artifactsDirSource(
    actionEnv: Readonly<Record<string, string | undefined>>,
    workspaceDir: string,
): string {
    const fromInput = readActionInput(actionEnv, AgentActionInputName.artifactsDir);
    return fromInput !== undefined ? fromInput : workspaceArtifactsDefault(workspaceDir);
}

/**
 * Resolve one environment-channel input's value: the input, plus — for `checkoutPath` only — the
 * runner's `GITHUB_WORKSPACE` fallback (`github.workspace` is runner-guaranteed). The token and the
 * LLM inputs have no runner fallback, so a workflow missing them fails named in the resolver.
 *
 * @param actionEnv - The runner-shaped environment.
 * @param inputName - The environment-channel input being mapped.
 * @param workspaceDir - The bound workspace directory the checkout fallback carries.
 * @returns The trimmed value, or `undefined` when neither the input nor a fallback has one.
 */
function envChannelValue(
    actionEnv: Readonly<Record<string, string | undefined>>,
    inputName: AgentActionInputName,
    workspaceDir: string,
): string | undefined {
    const fromInput = readActionInput(actionEnv, inputName);
    if (fromInput !== undefined) {
        return fromInput;
    }
    return inputName === AgentActionInputName.checkoutPath ? workspaceDir : undefined;
}

/**
 * Map the runner-shaped action environment onto the shared entry vocabulary. Pure over `actionEnv`:
 * no file system, no clock, no network, and no run seam — resolution happens in the entry's
 * `resolveAgentRunInputs`, whose combined `ConfigError` names every missing mandatory input. The
 * runner's workspace is the one variable the binding itself requires: the face's paths all anchor
 * on it, so a run without one fails named here, before any other input is examined.
 *
 * @param actionEnv - The environment a GitHub Actions runner provides to the action step: `INPUT_*`
 *   variables plus the runner's guaranteed variables.
 * @returns The bound sources, environment additions and workspace for one entry resolution.
 * @throws {ConfigError} When the runner's workspace variable is missing or blank.
 */
export function mapAgentRunSources(
    actionEnv: Readonly<Record<string, string | undefined>>,
): AgentActionBinding {
    const workspaceDir = optionalEnvValue(actionEnv[GITHUB_WORKSPACE_VAR]);
    if (workspaceDir === undefined) {
        throw new ConfigError(nameMissingWorkspaceMessage());
    }
    const sources: AgentRunInputSources = {
        repository: repositorySource(actionEnv),
        // Tolerated-absence contract: an origin URL would need a git adapter the action face does
        // not have, and precedence makes it unreachable behind the runner-guaranteed
        // GITHUB_REPOSITORY. `null` means "no origin to read, never a
        // failure" to the resolver.
        checkoutOriginUrl: null,
        issueNumber: numericActionInput(
            readActionInput(actionEnv, AgentActionInputName.issueNumber),
        ),
        backlog: booleanActionInput(readActionInput(actionEnv, AgentActionInputName.backlog)),
        limit: numericActionInput(readActionInput(actionEnv, AgentActionInputName.limit)),
        excludedLabels: readActionInput(actionEnv, AgentActionInputName.excludedLabels),
        inProgressLabels: readActionInput(actionEnv, AgentActionInputName.inProgressLabels),
        reportBots: readActionInput(actionEnv, AgentActionInputName.reportBots),
        trustedRoles: readActionInput(actionEnv, AgentActionInputName.trustedRoles),
        maxRevisionsPerWindow: numericActionInput(
            readActionInput(actionEnv, AgentActionInputName.maxRevisionsPerWindow),
        ),
        revisionWindowMs: numericActionInput(
            readActionInput(actionEnv, AgentActionInputName.revisionWindowMs),
        ),
        backlogWallClockBudgetMs: numericActionInput(
            readActionInput(actionEnv, AgentActionInputName.backlogWallClockBudgetMs),
        ),
        // The action registers executors a workflow plugs in through blocker modules, so an unset
        // input locks the browser extension alone instead of every registration.
        executors:
            readActionInput(actionEnv, AgentActionInputName.executors) ??
            BrowserExtensionExecutorName,
        instructionPath: readActionInput(actionEnv, AgentActionInputName.instructionPath),
        artifactsDir: artifactsDirSource(actionEnv, workspaceDir),
        model: readActionInput(actionEnv, AgentActionInputName.model),
        noComment: booleanActionInput(readActionInput(actionEnv, AgentActionInputName.noComment)),
        force: booleanActionInput(readActionInput(actionEnv, AgentActionInputName.force)),
        screenshotsBranch: readActionInput(actionEnv, AgentActionInputName.screenshotsBranch),
        lintCommand: readActionInput(actionEnv, AgentActionInputName.lintCommand),
    };

    const envAdditions: Record<string, string> = {
        [CLOAKBROWSER_AUTO_UPDATE_VAR]: CLOAKBROWSER_AUTO_UPDATE_DISABLED,
    };
    // `Object.entries` always widens object keys to `string`; the cast recovers the input-name
    // vocabulary `AGENT_ACTION_INPUT_ENV_VAR` is itself keyed by, since every key it can ever
    // produce is one of this module's own declared input names.
    const inputEnvVarEntries = Object.entries(AGENT_ACTION_INPUT_ENV_VAR) as Array<
        [AgentActionInputName, string]
    >;
    for (const [inputName, envVar] of inputEnvVarEntries) {
        const value = envChannelValue(actionEnv, inputName, workspaceDir);
        if (value !== undefined) {
            envAdditions[envVar] = value;
        }
    }

    const blockerModulePaths = (
        readActionInput(actionEnv, AgentActionInputName.blockerModules) ?? ''
    )
        .split(MODULE_PATH_SEPARATOR)
        .map((path) => path.trim())
        .filter((path) => path.length > 0);

    return { sources, envAdditions, workspaceDir, blockerModulePaths };
}
