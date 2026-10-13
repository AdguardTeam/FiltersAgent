import * as v from 'valibot';
import { EXTENSION_MANIFEST_VERSION_VALUES } from '../environment/extension-preparation';
import type { GithubReadConfig } from '../github/fetch-issue';
import { ConfigError } from './config-error';
import {
    REPOSITORY_PATH_VAR,
    requireRepositoryIdentity,
    type RepositoryIdentitySources,
    type RepositorySlug,
} from './repository-identity';
import { ProviderRoutingSchema } from './provider-routing';
import { REASONING_EFFORT_VALUES, ReasoningEffort } from './reasoning-effort';

export { ConfigError };

/**
 * Environment variable naming the LLM provider's OpenAI-compatible base URL. The one place this
 * name is spelled; every other reader (the action's `llmBaseUrl` input binding included) imports it
 * instead of respelling it, so a rename here can never silently strand a caller.
 */
export const LLM_BASE_URL_VAR = 'LLM_BASE_URL';

/**
 * Environment variable naming the LLM provider's API key.
 */
export const LLM_API_KEY_VAR = 'LLM_API_KEY';

/**
 * Environment variable naming the default reasoning-model slug.
 */
export const LLM_MODEL_VAR = 'LLM_MODEL';

/**
 * Environment variable naming the vision-model slug used for screenshot-reading steps.
 */
export const LLM_VISION_MODEL_VAR = 'LLM_VISION_MODEL';

/**
 * Environment variable carrying the gateway routing preferences as one JSON document. The one place
 * this name is spelled; the action's `llmProviderRouting` input binding imports it instead of
 * respelling it.
 */
export const LLM_PROVIDER_ROUTING_VAR = 'LLM_PROVIDER_ROUTING';

/**
 * Environment variable carrying the reasoning model's context window in tokens. The one place this
 * name is spelled; the action's `llmContextWindowTokens` input binding imports it.
 */
export const LLM_CONTEXT_WINDOW_TOKENS_VAR = 'LLM_CONTEXT_WINDOW_TOKENS';

/**
 * Environment variable carrying the reasoning model's completion cap in tokens. The one place this
 * name is spelled; the action's `llmMaxOutputTokens` input binding imports it.
 */
export const LLM_MAX_OUTPUT_TOKENS_VAR = 'LLM_MAX_OUTPUT_TOKENS';

/**
 * Environment variable carrying the vision model's completion cap in tokens. The one place this
 * name is spelled; the action's `llmVisionMaxOutputTokens` input binding imports it.
 */
export const LLM_VISION_MAX_OUTPUT_TOKENS_VAR = 'LLM_VISION_MAX_OUTPUT_TOKENS';

/**
 * Environment variable carrying the reasoning effort of the loop session's requests. The one place
 * this name is spelled; the action's `llmReasoningEffort` input binding imports it.
 */
export const LLM_REASONING_EFFORT_VAR = 'LLM_REASONING_EFFORT';

/**
 * Environment variable carrying the reasoning effort of the single-shot calls. The one place this
 * name is spelled; the action's `llmSingleShotReasoningEffort` input binding imports it.
 */
export const LLM_SINGLE_SHOT_REASONING_EFFORT_VAR = 'LLM_SINGLE_SHOT_REASONING_EFFORT';

/**
 * Environment variable carrying the total provider attempts per request. The one place this name is
 * spelled; the action's `llmRequestMaxAttempts` input binding imports it.
 */
export const LLM_REQUEST_MAX_ATTEMPTS_VAR = 'LLM_REQUEST_MAX_ATTEMPTS';

/**
 * Environment variable carrying the GitHub API token every GitHub-reading seam authenticates with,
 * report comments included. The one place this name is spelled; the action's `githubToken` input
 * binding imports it instead of respelling it.
 */
export const GITHUB_TOKEN_VAR = 'GITHUB_TOKEN';

/**
 * Total provider attempts per request when `LLM_REQUEST_MAX_ATTEMPTS` names none.
 *
 * Two — the initial attempt plus one retry — absorbs a single transient gateway failure without a
 * failing turn being paid for three times.
 *
 * This is the ONLY place the bound is defaulted. `requestMaxAttempts` is a required configuration
 * field, so every consumer derives from a value that is always present — `providerMaxRetries` in
 * `src/pi/llm-wiring` maps it onto pi's retry count for the loop sessions and the single-shot
 * clients alike. No layer downstream may reintroduce a fallback of its own: handing pi no bound at
 * all silently buys pi's own default of three.
 */
const DEFAULT_REQUEST_MAX_ATTEMPTS = 2;

/**
 * Default deadline for one provider request, the schema ceiling.
 *
 * The deadline bounds SILENCE, not a response's total length: up to the response headers it is the
 * SDK's own request timeout, and from there it is the run guard's inactivity window, restarted on
 * every streamed delta (`RunBudgets.requestTimeoutMs`). So a model that reasons for longer than
 * this while tokens keep arriving is left alone; a stream that stops producing for this long is
 * not, and the run's total duration is bounded by the wall-clock budget instead.
 *
 * Why the ceiling: with `LLM_REASONING_EFFORT` at `high` the reasoning model's thinking regularly
 * outlives two minutes, and a two-minute deadline leaves most runs carrying "Request timed out."
 * turns — each one a retried request, two more minutes of wall clock and an attempt the usage
 * report can only mark unreported. The ceiling is the honest default until the gateway reports a
 * per-request maximum of its own.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

/**
 * Reasoning effort every loop request carries when `LLM_REASONING_EFFORT` names none.
 *
 * `high` is the maintainer's call, and it is also the ceiling for the model this runtime registers:
 * that catalog entry is `reasoning: true` with no `thinkingLevelMap`, so pi's supported set is `off
 * | minimal | low | medium | high` and `clampThinkingLevel` would fold anything above `high` back
 * down to it. The vision model is registered `reasoning: false`, so pi sends nothing for it
 * whatever this says.
 *
 * This is the ONLY place the loop level is defaulted. `reasoningEffort` is a required configuration
 * field, so its consumer — the loop session's `thinkingLevel` — reads a value that is always
 * present, and no layer downstream may substitute one: handing pi no level at all silently buys
 * pi's own default of `medium`. The single-shot clients carry their own level,
 * {@link DEFAULT_SINGLE_SHOT_REASONING_EFFORT}.
 */
const DEFAULT_REASONING_EFFORT = ReasoningEffort.High;

/**
 * Reasoning effort every single-shot call carries when `LLM_SINGLE_SHOT_REASONING_EFFORT` names
 * none: the intake extraction, the benchmark reviewer and every vision verdict.
 *
 * Two steps below the loop's `high`, at the maintainer's call. A single-shot call answers one
 * bounded structured question — extract the report from an issue, describe one screenshot — and its
 * thinking is paid on the run's critical path with nothing to plan across turns; the loop keeps
 * `high` because it plans an investigation across many turns. Above `medium` a run has spent 22
 * minutes inside the intake extraction and its vision calls 173k of 177k output tokens on
 * reasoning. Even at `medium` the vision calls run away: three a run have streamed past the
 * ten-minute call ceiling — half of a 60-minute investigation — and a candidate review that runs
 * away comes back inconclusive, which throws the whole experiment away. The level reaches the wire
 * on every single shot of a model registered as reasoning, which includes the vision role whenever
 * it shares the reasoning model's slug.
 */
const DEFAULT_SINGLE_SHOT_REASONING_EFFORT = ReasoningEffort.Low;

/**
 * Schema of one model limit in tokens, failing with a message that names the variable to set.
 *
 * @param envVar - The environment variable the limit is read from.
 * @returns The limit's schema.
 */
function tokenLimitSchema(envVar: string) {
    const message = `${envVar} must name the model's limit in tokens`;
    return v.pipe(v.number(message), v.integer(message), v.minValue(1, message));
}

/**
 * Schema of one required provider value, failing with a message that names the variable to set.
 *
 * @param envVar - The environment variable the value is read from.
 * @returns The value's schema.
 */
function providerValueSchema(envVar: string) {
    const message = `${envVar} is required`;
    return v.pipe(v.string(message), v.minLength(1, message));
}

const CoreConfigSchema = v.object({
    llm: v.object({
        baseUrl: v.pipe(
            providerValueSchema(LLM_BASE_URL_VAR),
            v.url(`${LLM_BASE_URL_VAR} must be a URL`),
        ),
        apiKey: providerValueSchema(LLM_API_KEY_VAR),
        model: providerValueSchema(LLM_MODEL_VAR),
        visionModel: providerValueSchema(LLM_VISION_MODEL_VAR),
        // Absent by default and absent on the wire: a routing document is an OpenAI-compatible
        // GATEWAY feature (OpenRouter's `provider` request object), and a gateway that is not
        // OpenRouter ignores or rejects the field, so only a deployment whose gateway understands
        // it sets one. See `provider-routing.ts` for the document's shape.
        providerRouting: v.optional(ProviderRoutingSchema),
        requestTimeoutMs: v.pipe(v.number(), v.integer(), v.minValue(30_000), v.maxValue(300_000)),
        requestMaxAttempts: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3)),
        reasoningEffort: v.picklist(REASONING_EFFORT_VALUES),
        singleShotReasoningEffort: v.picklist(REASONING_EFFORT_VALUES),
        // The three model limits have no default: they belong to the model the deployment names,
        // and a limit above the provider's own fails every request with HTTP 400. See
        // `buildRawLlmLimits` for the one derived value.
        contextWindowTokens: tokenLimitSchema(LLM_CONTEXT_WINDOW_TOKENS_VAR),
        maxOutputTokens: tokenLimitSchema(LLM_MAX_OUTPUT_TOKENS_VAR),
        visionMaxOutputTokens: tokenLimitSchema(LLM_VISION_MAX_OUTPUT_TOKENS_VAR),
    }),
    headless: v.boolean(),
    /**
     * Pass --no-sandbox to Chromium (only for CI/Docker; default false).
     */
    noSandbox: v.optional(v.boolean(), false),
    /**
     * Local checkout of the repository the run works with, mapped from `REPOSITORY_PATH`.
     */
    repositoryPath: v.optional(v.string()),
    adguardExtensionManifestVersion: v.optional(v.picklist(EXTENSION_MANIFEST_VERSION_VALUES)),
    /**
     * Shared wall-clock budget for one extension-configuration pass in apply_rule phase sessions.
     *
     * Analysis sessions keep the built-in short budget; phase sessions need tens of seconds because
     * a fresh-install MV3 bootstrap under CI matrix load routinely outlives it. The ceiling keeps
     * the worst case of one experiment (phases B and C each pay up to one budget, phase C user
     * rules another) inside the fixed fifteen-minute apply_rule tool deadline.
     */
    phaseReadinessBudgetMs: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(5_000), v.maxValue(120_000)),
    ),
    /**
     * Wall-clock budget for one agent investigation before the loop seals it over the collected
     * evidence.
     *
     * Unset, the in-code 60-minute default applies (local runs, benchmarks). A CI analysis
     * container must set it lower when it runs up to two whole-process agent attempts inside one CI
     * job bounded at 90 minutes and evidence ships only after the container script finishes — with
     * the 60-minute default, two attempts arithmetically outgrow the job (2×60 > 90) and the CI
     * backstop kills the second one with every artifact lost. Each layer must end well before the
     * one above it: this budget < the per-attempt shell timeout < the CI job timeout.
     */
    agentInvestigationBudgetMs: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(300_000), v.maxValue(3_600_000)),
    ),
});

/**
 * GitHub-only configuration used by read-only issue commands. The repository comes from the
 * resolved repository identity, never from a stored default.
 */
const GithubReadConfigSchema = v.object({
    token: v.pipe(v.string(), v.minLength(1)),
    owner: v.pipe(v.string(), v.minLength(1)),
    repo: v.pipe(v.string(), v.minLength(1)),
});

/**
 * Named GitHub section shared by the GitHub-only and complete configuration loaders.
 */
const GithubReadContainerSchema = v.object({
    github: GithubReadConfigSchema,
});

const AppConfigSchema = v.intersect([CoreConfigSchema, GithubReadContainerSchema]);

/**
 * Runtime configuration required by local and hosted investigation cores.
 */
export type CoreConfig = v.InferOutput<typeof CoreConfigSchema>;

/**
 * Complete hosted configuration including GitHub read credentials.
 */
export type AppConfig = v.InferOutput<typeof AppConfigSchema>;

/**
 * The validated LLM provider slice every pi runtime and single-shot client is wired from. Named
 * here so the wiring helpers take exactly the fields they map instead of a whole configuration.
 */
export type LlmConfig = CoreConfig['llm'];

/**
 * Represents a Valibot path segment that carries a `key` property.
 */
interface PathSegment {
    /**
     * The key name in the path segment.
     */
    key: unknown;
}

/**
 * Coerce a string environment variable into a boolean.
 *
 * @param value - The raw env-var value (may be undefined).
 * @param fallback - Value to use when `value` is undefined.
 * @returns `false` when the value is a known falsy string, `true` otherwise.
 */
function parseBool(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) {
        return fallback;
    }
    return !['false', '0', 'no', 'off'].includes(value.trim().toLowerCase());
}

/**
 * Convert one optional numeric environment value before schema validation.
 *
 * @param value - Raw environment value.
 * @returns Numeric value, or undefined when the variable is absent.
 */
function parseOptionalNumber(value: string | undefined): number | undefined {
    return value === undefined ? undefined : Number(value);
}

/**
 * Read the three model limits, raw for the schema to validate.
 *
 * None has a default: a limit is a property of the model the deployment names, and a value above
 * the provider's own fails every request with HTTP 400. The vision cap is the one derived value:
 * when both roles name one model it is that model's cap, so a deployment on a single model states
 * each limit once.
 *
 * @param env - Environment source supplied by the caller.
 * @returns The raw `contextWindowTokens`, `maxOutputTokens` and `visionMaxOutputTokens` values.
 */
function buildRawLlmLimits(env: Record<string, string | undefined>): Record<string, unknown> {
    const maxOutputTokens = parseOptionalNumber(env[LLM_MAX_OUTPUT_TOKENS_VAR]);
    const sharesModel = env[LLM_VISION_MODEL_VAR] === env[LLM_MODEL_VAR];
    return {
        contextWindowTokens: parseOptionalNumber(env[LLM_CONTEXT_WINDOW_TOKENS_VAR]),
        maxOutputTokens,
        visionMaxOutputTokens:
            parseOptionalNumber(env[LLM_VISION_MAX_OUTPUT_TOKENS_VAR]) ??
            (sharesModel ? maxOutputTokens : undefined),
    };
}

/**
 * Build the GitHub-independent raw configuration shared by both loaders.
 *
 * @param env - Environment source supplied by the caller.
 * @returns Unvalidated core configuration values.
 */
function buildRawCoreConfig(env: Record<string, string | undefined>): Record<string, unknown> {
    return {
        llm: {
            baseUrl: env.LLM_BASE_URL,
            apiKey: env.LLM_API_KEY,
            model: env.LLM_MODEL,
            visionModel: env.LLM_VISION_MODEL,
            // Passed through raw, like the reasoning level below: the JSON document is parsed and
            // validated by the schema, so a malformed document or a misspelled routing key fails
            // the load naming `llm.providerRouting` instead of being quietly discarded.
            providerRouting: env[LLM_PROVIDER_ROUTING_VAR],
            requestTimeoutMs:
                parseOptionalNumber(env.LLM_REQUEST_TIMEOUT_MS) ?? DEFAULT_REQUEST_TIMEOUT_MS,
            requestMaxAttempts:
                parseOptionalNumber(env[LLM_REQUEST_MAX_ATTEMPTS_VAR]) ??
                DEFAULT_REQUEST_MAX_ATTEMPTS,
            // Passed through raw: an unknown level must reach the picklist and fail the load
            // loudly. Coercing a typo to the default here would leave the operator believing a
            // level is in force that no request ever carries — the exact drift this field exists
            // to make visible.
            reasoningEffort: env[LLM_REASONING_EFFORT_VAR] ?? DEFAULT_REASONING_EFFORT,
            singleShotReasoningEffort:
                env[LLM_SINGLE_SHOT_REASONING_EFFORT_VAR] ?? DEFAULT_SINGLE_SHOT_REASONING_EFFORT,
            ...buildRawLlmLimits(env),
        },
        headless: parseBool(env.HEADLESS, true),
        noSandbox: parseBool(env.NO_SANDBOX, false),
        repositoryPath: env[REPOSITORY_PATH_VAR],
        adguardExtensionManifestVersion:
            env.ADGUARD_EXTENSION_MANIFEST_VERSION === undefined
                ? undefined
                : Number(env.ADGUARD_EXTENSION_MANIFEST_VERSION),
        phaseReadinessBudgetMs:
            parseOptionalNumber(env.PHASE_EXTENSION_READINESS_BUDGET_MS) ?? 90_000,
        agentInvestigationBudgetMs: parseOptionalNumber(env.AGENT_INVESTIGATION_BUDGET_MS),
    };
}

/**
 * Render Valibot configuration issues with stable field paths.
 *
 * @param issues - Validation issues returned by Valibot.
 * @returns Human-readable multi-line error details.
 */
function formatConfigIssues(issues: readonly v.BaseIssue<unknown>[]): string {
    return issues
        .map((issue) => {
            const path =
                issue.path
                    ?.map((part) => {
                        if (typeof part === 'object' && part !== null && 'key' in part) {
                            return String((part as PathSegment).key);
                        }
                        return String(part);
                    })
                    .join('.') || '(root)';
            return `  - ${path}: ${issue.message}`;
        })
        .join('\n');
}

/**
 * Build the raw GitHub section for one loader from the token and the resolved repository identity.
 * Values stay raw and may be `undefined`; Valibot reports them alongside the identity failure, so
 * one failed load names every independent problem.
 *
 * @param env - Environment source supplied by the caller.
 * @param identity - The resolved repository identity, or `null` while unresolved.
 * @returns The raw, unvalidated GitHub section.
 */
function buildRawGithubConfig(
    env: Record<string, string | undefined>,
    identity: RepositorySlug | null,
): Record<string, unknown> {
    return {
        token: env.GITHUB_TOKEN,
        owner: identity?.owner,
        repo: identity?.repo,
    };
}

/**
 * One GitHub-reading loader's identity resolution outcome: the slug, or the config problem that
 * must join the combined failure message.
 */
interface LoaderIdentityResolution {
    /**
     * The resolved repository slug, when a source provided one.
     */
    slug?: RepositorySlug;

    /**
     * The identity error message, when no source provided an identity.
     */
    problem?: string;
}

/**
 * Resolve the repository identity for a GitHub-reading loader without throwing, so any schema
 * failure about the remaining slices is still collected into the same error.
 *
 * @param env - Environment source supplied by the caller.
 * @param identitySources - Explicit identity sources (CLI flag, checkout origin).
 * @returns The resolved slug, or the config problem to fold into a combined failure.
 */
function resolveIdentityOrProblem(
    env: Record<string, string | undefined>,
    identitySources: RepositoryIdentitySources,
): LoaderIdentityResolution {
    try {
        return { slug: requireRepositoryIdentity(env, identitySources) };
    } catch (error) {
        if (!(error instanceof ConfigError)) {
            throw error;
        }
        return { problem: error.message };
    }
}

/**
 * Render the combined config error when the identity and schema slices failed together. Called for
 * failed parses only, so the joined message is never empty.
 *
 * @param identityProblem - The identity message, or `null` when the identity resolved.
 * @param issues - The schema validation issues of the failed parse.
 * @returns The full problem description.
 */
function combinedProblems(
    identityProblem: string | null,
    issues: readonly v.BaseIssue<unknown>[],
): string {
    const problems: string[] = [];
    if (identityProblem !== null) {
        problems.push(identityProblem);
    }
    if (issues.length > 0) {
        problems.push(`Invalid configuration:\n${formatConfigIssues(issues)}`);
    }
    return problems.join('\n');
}

/**
 * Load configuration needed for a local run without requiring GitHub credentials.
 *
 * The repository identity is not resolved here, so this loader is the seam for commands that read
 * only the checkout path and never GitHub.
 *
 * @param env - Environment source (defaults to `process.env`); injectable for tests.
 * @returns Validated GitHub-independent runtime configuration.
 */
export function loadCoreConfig(env: Record<string, string | undefined> = process.env): CoreConfig {
    const result = v.safeParse(CoreConfigSchema, buildRawCoreConfig(env));
    if (!result.success) {
        throw new ConfigError(`Invalid configuration:\n${formatConfigIssues(result.issues)}`);
    }
    return result.output;
}

/**
 * Load the minimal configuration needed to export an issue without requiring LLM credentials.
 *
 * @param env - Environment source supplied by the caller.
 * @param identitySources - Explicit identity sources (CLI flag, checkout origin); the repository
 *   itself is never taken from code.
 * @returns Validated GitHub issue read credentials.
 */
export function loadGithubReadConfig(
    env: Record<string, string | undefined> = process.env,
    identitySources: RepositoryIdentitySources = {},
): GithubReadConfig {
    const identity = resolveIdentityOrProblem(env, identitySources);
    const raw = {
        github: buildRawGithubConfig(env, identity.slug ?? null),
    };
    const result = v.safeParse(GithubReadContainerSchema, raw);
    if (!result.success) {
        throw new ConfigError(combinedProblems(identity.problem ?? null, result.issues));
    }
    if (identity.problem !== undefined) {
        throw new ConfigError(identity.problem);
    }
    return result.output.github;
}

/**
 * Build and validate the application config from environment variables.
 *
 * The repository identity is resolved away from code — from the CLI flag, the environment, or the
 * checkout origin — and a missing source is a `ConfigError` naming every candidate variable.
 *
 * @param env - Environment source (defaults to `process.env`); injectable for tests.
 * @param identitySources - Explicit identity sources (CLI flag, checkout origin).
 * @returns The validated, identity-resolved application config.
 */
export function loadConfig(
    env: Record<string, string | undefined> = process.env,
    identitySources: RepositoryIdentitySources = {},
): AppConfig {
    const identity = resolveIdentityOrProblem(env, identitySources);
    const raw = {
        ...buildRawCoreConfig(env),
        github: buildRawGithubConfig(env, identity.slug ?? null),
    };

    const result = v.safeParse(AppConfigSchema, raw);
    if (!result.success) {
        throw new ConfigError(combinedProblems(identity.problem ?? null, result.issues));
    }
    if (identity.problem !== undefined) {
        throw new ConfigError(identity.problem);
    }
    return result.output;
}
