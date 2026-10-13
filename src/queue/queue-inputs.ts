import * as v from 'valibot';
import { IssueSelectionNarrowingSchema } from '../knowledge/instruction-selection';

/**
 * Queue-input vocabulary and defaults for backlog selection.
 *
 * The scheduled-queue module derives everything from the agent's comments and the issue history, so
 * its only configuration is the pair of work bounds and the revision budget: how many issues one
 * run may take, how often one issue may be reported during a rolling window, and which
 * author-association roles count as trusted. Every unset field falls back to {@link QUEUE_DEFAULTS}
 * before validation, and `capturedAt` — the run's clock capture — comes from the caller so window
 * arithmetic stays deterministic.
 */

/**
 * GitHub author-association roles whose members are trusted to change an issue revision.
 *
 * The issue author needs no entry here: the reporter is always trusted, so only the associations
 * GitHub stamps on other commenters and editors appear in this vocabulary.
 */
export const TrustedRole = {
    Owner: 'OWNER',
    Member: 'MEMBER',
    Collaborator: 'COLLABORATOR',
} as const;

/**
 * TrustedRole value.
 */
export type TrustedRole = (typeof TrustedRole)[keyof typeof TrustedRole];

/**
 * Every trusted-role value, for schemas and exhaustive listings.
 */
export const TRUSTED_ROLE_VALUES: readonly TrustedRole[] = Object.values(TrustedRole);

/**
 * Author associations trusted by default.
 *
 * Owners, members, and collaborators of the filter list may change an issue revision; untrusted
 * associations such as `NONE` are simply absent, so unknown values fail closed.
 */
export const DEFAULT_TRUSTED_ROLES: readonly TrustedRole[] = [
    TrustedRole.Owner,
    TrustedRole.Member,
    TrustedRole.Collaborator,
];

/**
 * Length of the rolling window that bounds paid revisions per issue.
 *
 * Why 24 hours: paid revisions per report are bounded by a rolling one-day budget, so "not more
 * than three a day" is this window, not a calendar day.
 */
export const REVISION_ROLLING_WINDOW_MS = 1000 * 60 * 60 * 24;

/**
 * Applied per missing queue field before validation.
 *
 * `maxIssuesPerRun` is the batch size one run takes, `maxRevisionsPerWindow` and the window
 * (`revisionWindowMs`) the paid-revision budget per issue — at most three revisions in a rolling
 * day — and `trustedRoles` the trusted-association set above.
 */
export const QUEUE_DEFAULTS = {
    maxIssuesPerRun: 50,
    maxRevisionsPerWindow: 3,
    revisionWindowMs: REVISION_ROLLING_WINDOW_MS,
    trustedRoles: DEFAULT_TRUSTED_ROLES,
} as const;

/**
 * Wall-clock budget for one backlog job's loop: 5 hours 30 minutes, leaving headroom under GitHub's
 * 6-hour hosted-runner cap for checkout, setup, and the last taken issue's own investigation
 * budget.
 */
export const DEFAULT_BACKLOG_WALL_CLOCK_BUDGET_MS = 5 * 60 * 60 * 1_000 + 30 * 60 * 1_000;

/**
 * Valibot schema for the queue inputs accepted by backlog selection.
 */
export const QueueInputsSchema = v.strictObject({
    maxIssuesPerRun: v.pipe(v.number(), v.integer(), v.minValue(1)),
    maxRevisionsPerWindow: v.pipe(v.number(), v.integer(), v.minValue(1)),
    revisionWindowMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
    trustedRoles: v.array(v.picklist(TRUSTED_ROLE_VALUES)),
    narrowing: v.optional(IssueSelectionNarrowingSchema),
    excludedLabels: v.array(v.string()),
    capturedAt: v.pipe(v.string(), v.isoTimestamp()),
    // No static default exists for this one (unlike every other field here): it is the run's own
    // resolved GitHub identity (see `github/report-author-identity.ts`), so the caller must resolve
    // and provide it fresh for every run, exactly like `capturedAt`.
    reportAuthorLogin: v.pipe(v.string(), v.minLength(1)),
});

/**
 * Queue inputs as backlog selection consumes them.
 */
export type QueueInputs = v.InferOutput<typeof QueueInputsSchema>;

/**
 * Queue inputs after defaults are applied, before schema validation.
 */
export interface DefaultedQueueInputs extends Omit<
    QueueInputs,
    'capturedAt' | 'reportAuthorLogin'
> {
    /**
     * The run's clock capture, still the caller's to provide: a missing or malformed value fails
     * the schema parse with a message naming it rather than slipping a silently wrong window into
     * the revision budget.
     */
    capturedAt?: string;

    /**
     * The run's own resolved report-author login, still the caller's to provide: like `capturedAt`,
     * a missing value fails the schema parse by name rather than silently trusting every marker.
     */
    reportAuthorLogin?: string;
}

/**
 * Apply {@link QUEUE_DEFAULTS} to every unset queue field.
 *
 * @param inputs - Queue inputs as configured; fields left undefined are filled from
 *   `{@link QUEUE_DEFAULTS}`, and already-present values — valid or not — pass through for the
 *   schema to validate and, when wrong, to name.
 * @returns The defaulted record feeding `{@link QueueInputsSchema}`.
 */
export function applyQueueDefaults(inputs: Partial<QueueInputs>): DefaultedQueueInputs {
    return {
        maxIssuesPerRun: inputs.maxIssuesPerRun ?? QUEUE_DEFAULTS.maxIssuesPerRun,
        maxRevisionsPerWindow: inputs.maxRevisionsPerWindow ?? QUEUE_DEFAULTS.maxRevisionsPerWindow,
        revisionWindowMs: inputs.revisionWindowMs ?? QUEUE_DEFAULTS.revisionWindowMs,
        trustedRoles: inputs.trustedRoles ?? [...QUEUE_DEFAULTS.trustedRoles],
        narrowing: inputs.narrowing,
        excludedLabels: inputs.excludedLabels ?? [],
        capturedAt: inputs.capturedAt,
        reportAuthorLogin: inputs.reportAuthorLogin,
    };
}
