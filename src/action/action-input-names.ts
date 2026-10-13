/**
 * The action's input names, declared once, mirroring `AgentRunInputSources` property for property.
 * GitHub Actions exposes each `action.yml` input as an `INPUT_` variable of the uppercased,
 * concatenated camelCase name (`issueNumber` → `INPUT_ISSUENUMBER`).
 *
 * Two entry sources deliberately have no member: `checkoutOriginUrl` is never an input — the
 * binding passes `null` (the fork remote is the workflow's own checkout) — and `issueSnapshotPath`
 * is not offered on the action face, which serves only GitHub-read modes; an exported snapshot is a
 * CLI-face affordance.
 */
export const AgentActionInputName = {
    /**
     * The `repository` input, overriding the runner's `GITHUB_REPOSITORY` identity source.
     */
    repository: 'repository',

    /**
     * The `issueNumber` input selecting the single-issue run mode.
     */
    issueNumber: 'issueNumber',

    /**
     * The `backlog` input selecting the backlog run mode.
     */
    backlog: 'backlog',

    /**
     * The `limit` input bounding a backlog run.
     */
    limit: 'limit',

    /**
     * The `excludedLabels` input naming the issue labels the run never processes.
     */
    excludedLabels: 'excludedLabels',

    /**
     * The `inProgressLabels` input naming the labels a maintainer applies when they pick an issue
     * up.
     */
    inProgressLabels: 'inProgressLabels',

    /**
     * The `reportBots` input naming the logins of the repository's reporting bots.
     */
    reportBots: 'reportBots',

    /**
     * The `trustedRoles` input naming the backlog's trusted-association set.
     */
    trustedRoles: 'trustedRoles',

    /**
     * The `maxRevisionsPerWindow` input bounding the backlog's revision budget.
     */
    maxRevisionsPerWindow: 'maxRevisionsPerWindow',

    /**
     * The `revisionWindowMs` input naming the backlog's revision rolling window.
     */
    revisionWindowMs: 'revisionWindowMs',

    /**
     * The `backlogWallClockBudgetMs` input bounding the whole backlog loop.
     */
    backlogWallClockBudgetMs: 'backlogWallClockBudgetMs',

    /**
     * The `executors` input naming the comma-separated executor set.
     */
    executors: 'executors',

    /**
     * The `instructionPath` input overriding the checkout's default instruction probe.
     */
    instructionPath: 'instructionPath',

    /**
     * The `artifactsDir` input naming the artifacts folder explicitly.
     */
    artifactsDir: 'artifactsDir',

    /**
     * The `model` input carrying the reasoning-model override.
     */
    model: 'model',

    /**
     * The `noComment` input disabling report comments for the run.
     */
    noComment: 'noComment',

    /**
     * The `force` input letting a maintainer-triggered run report on an issue a maintainer is on.
     */
    force: 'force',

    /**
     * The `screenshotsBranch` input naming the branch the report's screenshots are committed to.
     */
    screenshotsBranch: 'screenshotsBranch',

    /**
     * The `lintCommand` input naming the repository's own lint command line.
     */
    lintCommand: 'lintCommand',

    /**
     * The `checkoutPath` input; lands in the `REPOSITORY_PATH` environment variable the entry
     * reads, not in `AgentRunInputSources`.
     */
    checkoutPath: 'checkoutPath',

    /**
     * The `githubToken` input; lands in the `GITHUB_TOKEN` environment variable the resolver reads.
     */
    githubToken: 'githubToken',

    /**
     * The `llmBaseUrl` input; lands in the `LLM_BASE_URL` environment variable `loadCoreConfig`
     * reads the LLM slice from.
     */
    llmBaseUrl: 'llmBaseUrl',

    /**
     * The `llmApiKey` input; lands in the `LLM_API_KEY` environment variable `loadCoreConfig` reads
     * the LLM slice from.
     */
    llmApiKey: 'llmApiKey',

    /**
     * The `llmModel` input; lands in the `LLM_MODEL` environment variable `loadCoreConfig` reads
     * the LLM slice from.
     */
    llmModel: 'llmModel',

    /**
     * The `llmVisionModel` input; lands in the `LLM_VISION_MODEL` environment variable
     * `loadCoreConfig` reads the LLM slice from.
     */
    llmVisionModel: 'llmVisionModel',

    /**
     * The `llmProviderRouting` input; lands in the `LLM_PROVIDER_ROUTING` environment variable
     * `loadCoreConfig` validates the gateway routing document from. Optional like every other
     * environment-channel input: an unset or blank value leaves the variable out, and the run sends
     * no `provider` field at all.
     */
    llmProviderRouting: 'llmProviderRouting',

    /**
     * The `llmContextWindowTokens` input; lands in the `LLM_CONTEXT_WINDOW_TOKENS` environment
     * variable. Mandatory like the completion cap below: a model's limits have no default, so a
     * workflow without them fails at start, naming the variable, before the run spends anything.
     */
    llmContextWindowTokens: 'llmContextWindowTokens',

    /**
     * The `llmMaxOutputTokens` input; lands in the `LLM_MAX_OUTPUT_TOKENS` environment variable.
     */
    llmMaxOutputTokens: 'llmMaxOutputTokens',

    /**
     * The `llmVisionMaxOutputTokens` input; lands in the `LLM_VISION_MAX_OUTPUT_TOKENS` environment
     * variable. Mandatory when the vision model differs from the reasoning model; when both inputs
     * name one model, its value is `llmMaxOutputTokens`.
     */
    llmVisionMaxOutputTokens: 'llmVisionMaxOutputTokens',

    /**
     * The `llmReasoningEffort` input; lands in the `LLM_REASONING_EFFORT` environment variable the
     * loop session's level is read from. `off` is how a workflow runs a model that does not
     * reason.
     */
    llmReasoningEffort: 'llmReasoningEffort',

    /**
     * The `llmSingleShotReasoningEffort` input; lands in the `LLM_SINGLE_SHOT_REASONING_EFFORT`
     * environment variable the intake extraction and vision verdicts read their level from.
     */
    llmSingleShotReasoningEffort: 'llmSingleShotReasoningEffort',

    /**
     * The `llmRequestMaxAttempts` input; lands in the `LLM_REQUEST_MAX_ATTEMPTS` environment
     * variable. A gateway that drops responses mid-stream more than once in a row ends the run
     * without an answer at the default bound, so such a workflow raises it.
     */
    llmRequestMaxAttempts: 'llmRequestMaxAttempts',

    /**
     * The `blockerModules` input naming the manifests of the blocker modules the run plugs in.
     */
    blockerModules: 'blockerModules',
} as const;

/**
 * AgentActionInputName value: one camelCase action input name.
 */
export type AgentActionInputName = (typeof AgentActionInputName)[keyof typeof AgentActionInputName];
