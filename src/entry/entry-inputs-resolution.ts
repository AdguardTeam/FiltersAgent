/**
 * The entry's input resolution: every way of running — a CLI and the container action alike —
 * resolves its flags and environment into one validated `AgentRunInputs` here before any seam runs.
 * The resolver is pure over `(env, sources)`: no file system, no clock, no network, so a wrong
 * invocation fails during resolution, naming every independent problem in one combined error (the
 * `combinedProblems` pattern of `src/config/config.ts`) instead of leaking a partial load into a
 * paid dispatch. The input contracts and schemas this resolver builds toward live in
 * `entry-inputs.ts`; this module owns only turning flags and environment into them.
 */

import { GITHUB_TOKEN_VAR, type CoreConfig, loadCoreConfig } from '../config/config';
import { ConfigError } from '../config/config-error';
import { buildActionsRunUrl } from '../config/publisher-config';
import { parseNameList } from '../github/github-name-list';
import { DEFAULT_REPORT_SCREENSHOTS_BRANCH } from '../publisher/report-screenshots';
import {
    optionalEnvValue,
    REPOSITORY_PATH_VAR,
    requireRepositoryIdentity,
    resolveRepositoryIdentity,
    type RepositoryIdentitySources,
} from '../config/repository-identity';
import { TRUSTED_ROLE_VALUES } from '../queue/queue-inputs';
import type { RepositorySlug } from '../types/repository-slug';
import {
    AgentRunMode,
    type AgentRunCommentPolicy,
    type AgentRunInputSources,
    type AgentRunInputs,
    type AgentRunQueueOverrides,
} from './entry-inputs';

/**
 * CLI flag naming the single issue to process.
 */
const ISSUE_NUMBER_FLAG = '--issue';

/**
 * CLI flag naming a backlog limit.
 */
const LIMIT_FLAG = '--limit';

/**
 * CLI flag naming the executor set.
 */
const EXECUTORS_FLAG = '--executors';

/**
 * CLI flag naming the backlog trusted-association set.
 */
const TRUSTED_ROLES_FLAG = '--trusted-roles';

/**
 * CLI flag naming the backlog revision budget.
 */
const MAX_REVISIONS_PER_WINDOW_FLAG = '--max-revisions-per-window';

/**
 * CLI flag naming the backlog revision rolling window, in milliseconds.
 */
const REVISION_WINDOW_MS_FLAG = '--revision-window-ms';

/**
 * CLI flag naming the backlog loop's wall-clock budget, in milliseconds.
 */
const BACKLOG_WALL_CLOCK_BUDGET_MS_FLAG = '--backlog-wall-clock-budget-ms';

/**
 * Render the message fired when the request names no run mode.
 *
 * Names the logical input, not a flag: the CLI's is `--issue`/`--backlog`, the action's is the
 * `issueNumber`/`backlog` inputs, and neither spelling means anything on the other face. The
 * leading "Run mode is required" text is a stable prefix the container image's boot proof keys on.
 *
 * @returns The message naming both ways of choosing one.
 */
function nameMissingModeMessage(): string {
    return (
        'Run mode is required: configure either a single issue number to process, or select ' +
        'the backlog mode to process the open queue.'
    );
}

/**
 * Render the message fired when the request names both run modes at once.
 *
 * @returns The message naming the conflict.
 */
function nameExclusiveModeMessage(): string {
    return 'An issue number and the backlog mode cannot be combined: choose one run mode.';
}

/**
 * Render the message fired when a numeric input falls outside its bound.
 *
 * @param flag - The CLI flag whose value was rejected.
 * @param raw - The rejected value.
 * @returns The message naming the flag and the value.
 */
function nameNonPositiveValueMessage(flag: string, raw: number): string {
    return `${flag} must be a positive integer, got '${String(raw)}'.`;
}

/**
 * Render the message fired when the executor set is not a comma-separated list of non-empty names.
 *
 * @param raw - The rejected `--executors` value.
 * @returns The message naming the flag and the rejected value.
 */
function nameBadExecutorSetMessage(raw: string): string {
    return `${EXECUTORS_FLAG} must be a comma-separated list of non-empty executor names, got '${raw}'.`;
}

/**
 * Render the message fired when the executor set names an executor this run's face never
 * registered.
 *
 * @param unknownNames - The requested names absent from the registry.
 * @param knownExecutorNames - The names actually registered for this run's face.
 * @returns The message naming the flag, the unknown names, and the registered set.
 */
function nameUnknownExecutorMessage(
    unknownNames: readonly string[],
    knownExecutorNames: readonly string[],
): string {
    return (
        `${EXECUTORS_FLAG} names an executor this run never registered: ${unknownNames.join(', ')}. ` +
        `Registered executors: ${knownExecutorNames.length > 0 ? knownExecutorNames.join(', ') : '(none)'}.`
    );
}

/**
 * Render the message fired when a GitHub seam has to read but no token configured.
 *
 * Names the `GITHUB_TOKEN` environment variable every face genuinely reads (the action's
 * `githubToken` input lands there too) rather than a `--no-comment` flag, which no face of the
 * entry has.
 *
 * @param reason - What reads through GitHub.
 * @returns The message naming the variable and how it is shared with report comments.
 */
function nameMissingReadTokenMessage(reason: string): string {
    return (
        `${GITHUB_TOKEN_VAR} is required: ${reason}. Set ${GITHUB_TOKEN_VAR}; the same token ` +
        'enables report comments unless comments are disabled for the run.'
    );
}

/**
 * Derive the report-comment policy for one run. A token alone enables comments; the flag alone
 * turns publishing off without demanding a token; a token with the flag keeps posting off and is
 * accepted — the token still travels for GitHub reads.
 *
 * @param env - Environment source supplied by the caller.
 * @param noComment - Whether publishing is disabled.
 * @param screenshotsBranch - Branch named for the screenshots, or undefined for the default.
 * @returns The comment policy.
 */
function resolveCommentPolicy(
    env: Readonly<Record<string, string | undefined>>,
    noComment: boolean,
    screenshotsBranch: string | undefined,
): AgentRunCommentPolicy {
    const token = optionalEnvValue(env[GITHUB_TOKEN_VAR]);
    return {
        enabled: !noComment && token !== undefined,
        ...(token !== undefined ? { token } : {}),
        screenshotsBranch: screenshotsBranch?.trim() || DEFAULT_REPORT_SCREENSHOTS_BRANCH,
    };
}

/**
 * One executor-set parse outcome: the names, or the problem to fold into the failure.
 */
interface ParsedExecutorSet {
    /**
     * Executor names in request order, when the value was parseable.
     */
    names?: readonly string[];

    /**
     * The problem naming the malformed value, when it was not.
     */
    problem?: string;
}

/**
 * One repository-identity resolution outcome: the slug, or the problem to fold into the failure.
 */
interface ResolvedIdentity {
    /**
     * The resolved slug, when a source provided one.
     */
    slug?: RepositorySlug;

    /**
     * The problem naming the identity failure, when none did.
     */
    problem?: string;
}

/**
 * Parse the executor set. An absent value leaves every registered executor unlocked; a present
 * value must split into non-empty names, and a malformed value is named by the caller that collects
 * the problem. When `knownExecutorNames` is provided, every name must already be registered — never
 * reached during resolution, so a typo names itself before any network or paid work runs instead of
 * surfacing deep inside `AgentRuntime.create`.
 *
 * @param raw - The `--executors` value, or `undefined`.
 * @param knownExecutorNames - Executor names actually registered for this run's face, or undefined
 *   to skip the registry check.
 * @returns The parsed names, or a problem string naming the malformed or unregistered value.
 */
function parseExecutorSet(
    raw: string | undefined,
    knownExecutorNames: readonly string[] | undefined,
): ParsedExecutorSet {
    if (raw === undefined) {
        return {};
    }
    const names = raw.split(',').map((name) => name.trim());
    if (names.some((name) => name.length === 0)) {
        return { problem: nameBadExecutorSetMessage(raw) };
    }
    if (knownExecutorNames !== undefined) {
        const known = new Set(knownExecutorNames);
        const unknownNames = names.filter((name) => !known.has(name));
        if (unknownNames.length > 0) {
            return { problem: nameUnknownExecutorMessage(unknownNames, knownExecutorNames) };
        }
    }
    return { names };
}

/**
 * Validate one optional positive integer flag value.
 *
 * @param flag - The CLI flag the value came from.
 * @param raw - The value, or `undefined`.
 * @returns The value, or a problem string naming the bound.
 */
function positiveIntegerFlag(flag: string, raw: number | undefined): number | string | undefined {
    if (raw === undefined) {
        return undefined;
    }
    return Number.isSafeInteger(raw) && raw > 0 ? raw : nameNonPositiveValueMessage(flag, raw);
}

/**
 * Render the message fired when the trusted-roles set names an association GitHub does not use.
 *
 * @param raw - The rejected `--trusted-roles` value.
 * @returns The message naming the flag, the rejected value, and the allowed set.
 */
function nameBadTrustedRolesMessage(raw: string): string {
    return (
        `${TRUSTED_ROLES_FLAG} must be a comma-separated list of ${TRUSTED_ROLE_VALUES.join('/')}, ` +
        `got '${raw}'.`
    );
}

/**
 * One trusted-roles parse outcome: the associations, or the problem to fold into the failure.
 */
interface ParsedTrustedRoles {
    /**
     * Trusted GitHub author associations, when the value was parseable.
     */
    roles?: readonly string[];

    /**
     * The problem naming the malformed value, when it was not.
     */
    problem?: string;
}

/**
 * Parse the backlog trusted-association set. An absent value leaves `QUEUE_DEFAULTS.trustedRoles`
 * in force at dispatch; a present value must split into names from the fixed association
 * vocabulary, compared case-insensitively.
 *
 * @param raw - The `--trusted-roles` value, or `undefined`.
 * @returns The parsed associations, or a problem string naming the malformed value.
 */
function parseTrustedRoles(raw: string | undefined): ParsedTrustedRoles {
    if (raw === undefined) {
        return {};
    }
    const names = raw.split(',').map((name) => name.trim().toUpperCase());
    if (names.some((name) => !(TRUSTED_ROLE_VALUES as readonly string[]).includes(name))) {
        return { problem: nameBadTrustedRolesMessage(raw) };
    }
    return { roles: names };
}

/**
 * Resolve the repository identity without throwing, so schema problems about the remaining slices
 * still join the same combined failure.
 *
 * @param env - Environment source supplied by the caller.
 * @param identitySources - Explicit identity sources.
 * @returns The resolved slug, or the problem string to fold into the failure.
 */
function resolveIdentityOrProblem(
    env: Readonly<Record<string, string | undefined>>,
    identitySources: RepositoryIdentitySources,
): ResolvedIdentity {
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
 * Resolve flags and environment into the validated run inputs, failing combined when anything
 * mandatory is missing: the LLM schema problems, the repository-identity problem, the run-mode
 * shape (issue number, backlog shape, `--limit <= 0`), and the read token whenever issue
 * acquisition or backlog reading resolves through a GitHub seam. With a snapshot sourced the
 * identity requirement lifts. Pure over `(env, sources)`.
 *
 * @param env - Environment source (defaults to `process.env`); injectable for tests.
 * @param sources - Explicit non-environment sources.
 * @returns The validated run inputs.
 * @throws {ConfigError} One combined error naming every independent problem.
 */
export function resolveAgentRunInputs(
    env: Record<string, string | undefined> = process.env,
    sources: AgentRunInputSources = {},
): AgentRunInputs {
    const problems: string[] = [];

    let config: CoreConfig | undefined;
    try {
        config = loadCoreConfig(env);
    } catch (error) {
        if (!(error instanceof ConfigError)) {
            throw error;
        }
        problems.push(error.message);
    }

    const snapshotGiven = sources.issueSnapshotPath !== undefined;
    const identitySources: RepositoryIdentitySources = {
        flag: sources.repository,
        checkoutOriginUrl: sources.checkoutOriginUrl,
    };
    const identity: ResolvedIdentity = snapshotGiven
        ? { slug: resolveRepositoryIdentity(env, identitySources) ?? undefined }
        : resolveIdentityOrProblem(env, identitySources);
    if (identity.problem !== undefined) {
        problems.push(identity.problem);
    }
    const slug = identity.slug ?? null;

    const backlogRequested = sources.backlog === true;
    const issueNumberBound = positiveIntegerFlag(ISSUE_NUMBER_FLAG, sources.issueNumber);
    if (typeof issueNumberBound === 'string') {
        problems.push(issueNumberBound);
    }
    const issueNumber = typeof issueNumberBound === 'number' ? issueNumberBound : undefined;
    const backlogLimitBound = positiveIntegerFlag(LIMIT_FLAG, sources.limit);
    if (typeof backlogLimitBound === 'string') {
        problems.push(backlogLimitBound);
    }
    const backlogLimit = typeof backlogLimitBound === 'number' ? backlogLimitBound : undefined;

    if (backlogRequested && issueNumber !== undefined) {
        problems.push(nameExclusiveModeMessage());
    } else if (!backlogRequested && issueNumber === undefined) {
        problems.push(nameMissingModeMessage());
    }

    const executorSet = parseExecutorSet(sources.executors, sources.knownExecutorNames);
    if (executorSet.problem !== undefined) {
        problems.push(executorSet.problem);
    }

    const trustedRoles = parseTrustedRoles(sources.trustedRoles);
    if (trustedRoles.problem !== undefined) {
        problems.push(trustedRoles.problem);
    }
    const maxRevisionsPerWindowBound = positiveIntegerFlag(
        MAX_REVISIONS_PER_WINDOW_FLAG,
        sources.maxRevisionsPerWindow,
    );
    if (typeof maxRevisionsPerWindowBound === 'string') {
        problems.push(maxRevisionsPerWindowBound);
    }
    const revisionWindowMsBound = positiveIntegerFlag(
        REVISION_WINDOW_MS_FLAG,
        sources.revisionWindowMs,
    );
    if (typeof revisionWindowMsBound === 'string') {
        problems.push(revisionWindowMsBound);
    }
    const backlogWallClockBudgetMsBound = positiveIntegerFlag(
        BACKLOG_WALL_CLOCK_BUDGET_MS_FLAG,
        sources.backlogWallClockBudgetMs,
    );
    if (typeof backlogWallClockBudgetMsBound === 'string') {
        problems.push(backlogWallClockBudgetMsBound);
    }

    const comments = resolveCommentPolicy(
        env,
        sources.noComment === true,
        sources.screenshotsBranch,
    );
    const readsGitHubIssue = backlogRequested || (issueNumber !== undefined && !snapshotGiven);
    if (readsGitHubIssue && comments.token === undefined) {
        problems.push(
            nameMissingReadTokenMessage(
                backlogRequested
                    ? 'the backlog reader lists open issues through GitHub'
                    : 'issue acquisition resolves through the GitHub fetch seam (no exported snapshot was given)',
            ),
        );
    }

    if (problems.length > 0) {
        throw new ConfigError(problems.join('\n'));
    }

    const checkoutPath = optionalEnvValue(env[REPOSITORY_PATH_VAR]);
    const model =
        sources.model !== undefined && sources.model.trim().length > 0
            ? sources.model.trim()
            : undefined;
    const lintCommand =
        sources.lintCommand !== undefined && sources.lintCommand.trim().length > 0
            ? sources.lintCommand.trim()
            : undefined;
    const excludedLabels = parseNameList(sources.excludedLabels);
    const inProgressLabels = parseNameList(sources.inProgressLabels);
    const reportBots = parseNameList(sources.reportBots);
    const actionsRunUrl = buildActionsRunUrl(env);
    const maxRevisionsPerWindow =
        typeof maxRevisionsPerWindowBound === 'number' ? maxRevisionsPerWindowBound : undefined;
    const revisionWindowMs =
        typeof revisionWindowMsBound === 'number' ? revisionWindowMsBound : undefined;
    const backlogWallClockBudgetMs =
        typeof backlogWallClockBudgetMsBound === 'number'
            ? backlogWallClockBudgetMsBound
            : undefined;
    const queue: AgentRunQueueOverrides = {
        ...(trustedRoles.roles !== undefined ? { trustedRoles: [...trustedRoles.roles] } : {}),
        ...(maxRevisionsPerWindow !== undefined ? { maxRevisionsPerWindow } : {}),
        ...(revisionWindowMs !== undefined ? { revisionWindowMs } : {}),
        ...(backlogWallClockBudgetMs !== undefined ? { backlogWallClockBudgetMs } : {}),
    };
    const candidate: AgentRunInputs = {
        config: config!,
        slug,
        ...(checkoutPath !== undefined ? { checkoutPath } : {}),
        ...(model !== undefined ? { model } : {}),
        mode:
            backlogRequested === true
                ? backlogLimit === undefined
                    ? { kind: AgentRunMode.Backlog }
                    : { kind: AgentRunMode.Backlog, limit: backlogLimit }
                : {
                      kind: AgentRunMode.SingleIssue,
                      issueNumber: issueNumber!,
                      // The backlog mode ignores force, like the single-issue mode ignores limit.
                      ...(sources.force === true ? { force: true } : {}),
                  },
        ...(executorSet.names !== undefined ? { executors: [...executorSet.names] } : {}),
        ...(sources.instructionPath !== undefined
            ? { instructionPath: sources.instructionPath }
            : {}),
        ...(sources.artifactsDir !== undefined ? { artifactsDir: sources.artifactsDir } : {}),
        ...(lintCommand !== undefined ? { lintCommand } : {}),
        ...(excludedLabels.length > 0 ? { excludedLabels } : {}),
        ...(inProgressLabels.length > 0 ? { inProgressLabels } : {}),
        ...(reportBots.length > 0 ? { reportBots } : {}),
        ...(snapshotGiven ? { issueSnapshotPath: sources.issueSnapshotPath } : {}),
        ...(actionsRunUrl !== undefined ? { actionsRunUrl } : {}),
        comments,
        ...(Object.keys(queue).length > 0 ? { queue } : {}),
    };
    return candidate;
}
