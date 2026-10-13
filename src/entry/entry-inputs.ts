/**
 * The entry's shared input contracts and schemas: the raw sources a caller (a CLI, the container
 * action) hands the resolver, the Valibot shapes `entry-run.ts` re-asserts before any seam runs,
 * and the plain `AgentRunInputs` type the resolved run carries from then on.
 * `entry-inputs-resolution.ts` owns turning flags and environment into these — this module only
 * declares what they look like, so the contract and its resolution can each stay a manageable
 * size.
 */

import * as v from 'valibot';
import type { CoreConfig } from '../config/config';
import { TRUSTED_ROLE_VALUES } from '../queue/queue-inputs';
import type { RepositorySlug } from '../types/repository-slug';

/**
 * The run modes one entry accepts: exactly one issue, or the open queue up to a limit.
 */
export const AgentRunMode = {
    /**
     * Process the one numbered issue.
     */
    SingleIssue: 'single_issue',

    /**
     * Process open issues without an agent report, newest first, up to the queue limit.
     */
    Backlog: 'backlog',
} as const;

/**
 * AgentRunMode value.
 */
export type AgentRunMode = (typeof AgentRunMode)[keyof typeof AgentRunMode];

/**
 * Explicit non-environment sources a caller hands to the resolver: the CLI face maps its parsed
 * command onto these, and the action adapter maps workflow inputs the same way. Environment
 * variables stay the channel for secrets — argv carries no token.
 */
export interface AgentRunInputSources {
    /**
     * The `--repository <owner/repo>` flag value; the highest-precedence identity source.
     */
    repository?: string | undefined;

    /**
     * Origin URL of the checkout named by {@link REPOSITORY_PATH_VAR}, as read by the CLI seam's
     * git adapter; the lowest-precedence identity source. `null` means the adapter had no origin to
     * read, never a failure.
     */
    checkoutOriginUrl?: string | null | undefined;

    /**
     * Number of the one issue to process; absent in backlog mode.
     */
    issueNumber?: number | undefined;

    /**
     * Select the backlog run mode: open issues without an agent report, newest first.
     */
    backlog?: boolean | undefined;

    /**
     * Backlog limit; absent falls back to the queue default at dispatch.
     */
    limit?: number | undefined;

    /**
     * Comma-separated executor names this run locks; absent locks every registered executor.
     */
    executors?: string | undefined;

    /**
     * Run instruction path overriding the checkout default probe.
     */
    instructionPath?: string | undefined;

    /**
     * Explicit artifacts folder; absent resolves at run time for a single issue and stays mandatory
     * for backlog runs, so the resolver needs no clock.
     */
    artifactsDir?: string | undefined;

    /**
     * Exported issue snapshot path; a snapshot-sourced issue needs no GitHub read, lifting the
     * read-token and repository-identity requirements.
     */
    issueSnapshotPath?: string | undefined;

    /**
     * Reasoning-model override; the only LLM-adjacent flag.
     */
    model?: string | undefined;

    /**
     * The repository's own lint command line (e.g. `npx aglint`); absent or blank runs no lint.
     */
    lintCommand?: string | undefined;

    /**
     * Publish nothing for the whole run. Flips only posting off: GitHub reads may still need the
     * token, and a token accompanying the flag is accepted, not an error.
     */
    noComment?: boolean | undefined;

    /**
     * Report even on an issue a maintainer is already on: the run was triggered by a maintainer.
     * Applies to the single-issue mode only; the backlog mode ignores it.
     */
    force?: boolean | undefined;

    /**
     * Branch the report's before and after screenshots are committed to; absent or blank falls back
     * to `DEFAULT_REPORT_SCREENSHOTS_BRANCH`.
     */
    screenshotsBranch?: string | undefined;

    /**
     * Comma-separated issue labels the run never processes; absent or blank excludes none.
     */
    excludedLabels?: string | undefined;

    /**
     * Comma-separated labels a maintainer applies when they pick an issue up; absent or blank names
     * none.
     */
    inProgressLabels?: string | undefined;

    /**
     * Comma-separated logins of the repository's reporting bots; absent or blank names none.
     */
    reportBots?: string | undefined;

    /**
     * Comma-separated GitHub author-association names trusted to change a backlog issue's revision
     * (e.g. `OWNER,MEMBER`); absent falls back to `QUEUE_DEFAULTS.trustedRoles` at dispatch.
     * Backlog mode only.
     */
    trustedRoles?: string | undefined;

    /**
     * Maximum revision-marked reports one backlog issue may receive inside the rolling window;
     * absent falls back to `QUEUE_DEFAULTS.maxRevisionsPerWindow` at dispatch. Backlog mode only.
     */
    maxRevisionsPerWindow?: number | undefined;

    /**
     * Length of the rolling window the revision budget counts against, in milliseconds; absent
     * falls back to `QUEUE_DEFAULTS.revisionWindowMs` at dispatch. Backlog mode only.
     */
    revisionWindowMs?: number | undefined;

    /**
     * Wall-clock budget for the whole backlog loop, in milliseconds; absent falls back to
     * `DEFAULT_BACKLOG_WALL_CLOCK_BUDGET_MS` at dispatch. Backlog mode only.
     */
    backlogWallClockBudgetMs?: number | undefined;

    /**
     * Executor names actually registered for this run's face — the action's own registry, or
     * another caller's richer one. The registry is deliberately open (other callers may register
     * executors of their own), so this always travels from the caller's own registry snapshot
     * rather than a fixed list; omitted skips the check (only test fixtures should omit it).
     * Checked before any seam runs, so a typo names itself instead of surfacing after a paid run.
     */
    knownExecutorNames?: readonly string[] | undefined;
}

/**
 * Run mode selecting the one numbered issue.
 */
const SingleIssueModeSchema = v.strictObject({
    kind: v.literal(AgentRunMode.SingleIssue),
    issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
    force: v.optional(v.boolean()),
});

/**
 * Run mode selecting the open queue, bounded by the caller limit when one is named.
 */
const BacklogModeSchema = v.strictObject({
    kind: v.literal(AgentRunMode.Backlog),
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

/**
 * Report-comment policy: enabled or disabled, carrying the token when one was configured so GitHub
 * reads have it even while posting stays off.
 */
const CommentPolicySchema = v.strictObject({
    enabled: v.boolean(),
    token: v.optional(v.string()),
    screenshotsBranch: v.string(),
});

/**
 * Backlog queue overrides on top of `QUEUE_DEFAULTS`; every field absent means "use the default at
 * dispatch" (mirroring `applyQueueDefaults`'s own contract), so this object itself is optional.
 */
const QueueOverridesSchema = v.strictObject({
    trustedRoles: v.optional(v.array(v.picklist(TRUSTED_ROLE_VALUES))),
    maxRevisionsPerWindow: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    revisionWindowMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    backlogWallClockBudgetMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

/**
 * The complete validated inputs one entry dispatches on. Exported so the dispatch boundary in
 * `entry-run.ts` re-asserts the same shape before any seam runs.
 *
 * `config` and `slug` are deliberately `v.unknown()`: each already has its one real validator
 * (`loadCoreConfig`, `resolveRepositoryIdentity`) that ran during resolution, and every caller of
 * this schema passes resolver output, so a second structural witness here would only restate "some
 * value traveled" without checking anything a hand-rolled guard could get right. The remaining
 * fields are genuine shapes (a discriminated run mode, the comment policy, the queue overrides),
 * not witnesses, so they stay real Valibot schemas.
 */
/**
 * A configured list of GitHub names: present only when it names at least one.
 */
const NameListSchema = v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1));

export const AgentRunInputsSchema = v.strictObject({
    config: v.unknown(),
    slug: v.unknown(),
    checkoutPath: v.optional(v.string()),
    model: v.optional(v.string()),
    mode: v.variant('kind', [SingleIssueModeSchema, BacklogModeSchema]),
    executors: v.optional(v.array(v.string())),
    instructionPath: v.optional(v.string()),
    artifactsDir: v.optional(v.string()),
    lintCommand: v.optional(v.pipe(v.string(), v.minLength(1))),
    excludedLabels: v.optional(NameListSchema),
    inProgressLabels: v.optional(NameListSchema),
    reportBots: v.optional(NameListSchema),
    issueSnapshotPath: v.optional(v.string()),
    actionsRunUrl: v.optional(v.string()),
    comments: CommentPolicySchema,
    queue: v.optional(QueueOverridesSchema),
});

/**
 * Run mode selecting the one numbered issue.
 */
export interface SingleIssueRunModeSelection {
    /**
     * Discriminator: this run processes exactly one issue.
     */
    kind: typeof AgentRunMode.SingleIssue;

    /**
     * The issue number to process.
     */
    issueNumber: number;

    /**
     * A maintainer triggered the run, so a maintainer already on the issue does not silence its
     * report; absent leaves that silence in place.
     */
    force?: boolean;
}

/**
 * Run mode selecting the open queue, bounded by the caller limit when one is named.
 */
export interface BacklogRunModeSelection {
    /**
     * Discriminator: this run processes the open backlog.
     */
    kind: typeof AgentRunMode.Backlog;

    /**
     * Maximum open issues this run processes; absent falls back to the queue default at dispatch.
     */
    limit?: number;
}

/**
 * Backlog queue overrides on top of `QUEUE_DEFAULTS`; every field absent means "use the default at
 * dispatch" (mirroring `applyQueueDefaults`'s own contract).
 */
export interface AgentRunQueueOverrides {
    /**
     * GitHub author associations trusted to change a backlog issue's revision, besides the
     * reporter; absent falls back to `QUEUE_DEFAULTS.trustedRoles`.
     */
    trustedRoles?: string[];

    /**
     * Maximum revision-marked reports one backlog issue may receive inside the rolling window;
     * absent falls back to `QUEUE_DEFAULTS.maxRevisionsPerWindow`.
     */
    maxRevisionsPerWindow?: number;

    /**
     * Length of the rolling revision-budget window, in milliseconds; absent falls back to
     * `QUEUE_DEFAULTS.revisionWindowMs`.
     */
    revisionWindowMs?: number;

    /**
     * Wall-clock budget for the whole backlog loop, in milliseconds; absent falls back to
     * `DEFAULT_BACKLOG_WALL_CLOCK_BUDGET_MS`.
     */
    backlogWallClockBudgetMs?: number;
}

/**
 * Report-comment policy: enabled or disabled, carrying the token when one was configured so GitHub
 * reads have it even while posting stays off.
 */
export interface AgentRunCommentPolicy {
    /**
     * Whether report comments are posted for this run.
     */
    enabled: boolean;

    /**
     * The configured GitHub token, when one exists — present even while `enabled` is false, since
     * GitHub reads may still need it.
     */
    token?: string;

    /**
     * Branch the report's before and after screenshots are committed to.
     */
    screenshotsBranch: string;
}

/**
 * The complete validated inputs one entry dispatches on, as `resolveAgentRunInputs` builds them: a
 * plain type, not a schema inference, since `AgentRunInputsSchema`'s `config`/`slug` fields are
 * intentionally untyped witnesses (see above) and could not otherwise carry `CoreConfig` and
 * `RepositorySlug` at the type level.
 */
export interface AgentRunInputs {
    /**
     * Validated LLM and browser configuration the run investigates under.
     */
    config: CoreConfig;

    /**
     * Resolved repository identity; null only for a snapshot-sourced issue.
     */
    slug: RepositorySlug | null;

    /**
     * Local checkout the run shares objects from, when one exists.
     */
    checkoutPath?: string;

    /**
     * Reasoning-model override.
     */
    model?: string;

    /**
     * The run mode: exactly one issue, or the open backlog.
     */
    mode: SingleIssueRunModeSelection | BacklogRunModeSelection;

    /**
     * Executor names this run locks; absent locks every registered executor.
     */
    executors?: string[];

    /**
     * Run instruction path overriding the checkout default probe.
     */
    instructionPath?: string;

    /**
     * Explicit artifacts directory; absent resolves at run time for a single issue and stays
     * mandatory for backlog runs.
     */
    artifactsDir?: string;

    /**
     * The repository's own lint command line, run in the checkout over each candidate rule; absent
     * runs no lint.
     */
    lintCommand?: string;

    /**
     * Issue labels the run never processes, in a single issue and in the backlog alike; absent
     * excludes none.
     */
    excludedLabels?: string[];

    /**
     * Labels a maintainer applies when they pick an issue up: the publication guard counts one as a
     * maintainer on the issue. Absent names none.
     */
    inProgressLabels?: string[];

    /**
     * Logins of the repository's reporting bots: their comments are automation, kept out of the
     * prompt and never counted as a maintainer on the issue. Absent names none.
     */
    reportBots?: string[];

    /**
     * Exported issue snapshot path; a snapshot-sourced issue needs no GitHub read.
     */
    issueSnapshotPath?: string;

    /**
     * The GitHub Actions run URL serving as the report's artifacts link; absent when the run has no
     * runner variables.
     */
    actionsRunUrl?: string;

    /**
     * Report-comment policy for this run.
     */
    comments: AgentRunCommentPolicy;

    /**
     * Backlog queue overrides on top of `QUEUE_DEFAULTS`; absent uses every default. Backlog mode
     * only.
     */
    queue?: AgentRunQueueOverrides;
}
