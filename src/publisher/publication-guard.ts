/**
 * Publication guard: whether a report may still be posted on an issue as it stands now.
 *
 * A bot comment on an issue that is closed, that a fix already references, or that a maintainer is
 * already handling only adds noise, so the guard names the reason to stay silent. An issue that
 * carries a label the run excludes gets no report either, even when the label came while the run
 * worked. A run a maintainer triggered may set the maintainer silence aside, never the others. It
 * is a pure decision over a snapshot `github/issue-publication-facts.ts` reads; the repository, the
 * trusted roles, both label sets and the reporting bots come from the caller.
 */

import { isGithubBotAccount } from '../github/fetch-issue';
import { matchingNames } from '../github/github-name-list';
import { IssueState } from '../types/issue-state';

/**
 * Reasons the guard keeps a report silent.
 */
export const PublicationSilence = {
    /**
     * The issue carries a label the run excludes.
     */
    ExcludedLabel: 'excluded_label',

    /**
     * The issue is closed.
     */
    IssueClosed: 'issue_closed',

    /**
     * A commit or pull request in the repository references the issue.
     */
    FixReferenced: 'fix_referenced',

    /**
     * A maintainer commented, was assigned, or labelled the issue as in progress.
     */
    MaintainerEngaged: 'maintainer_engaged',
} as const;

/**
 * PublicationSilence value.
 */
export type PublicationSilence = (typeof PublicationSilence)[keyof typeof PublicationSilence];

/**
 * What the guard measures an issue against.
 */
export interface PublicationGuardPolicy {
    /**
     * `owner/name` of the repository whose commits and pull requests count as fixes. Mirror forks
     * re-reference the same commit under their own name, so references from elsewhere are ignored.
     */
    repository: string;

    /**
     * Author associations (`OWNER`, `MEMBER`, ...) whose comments count as maintainer engagement.
     */
    trustedRoles: readonly string[];

    /**
     * Labels a maintainer applies when they pick an issue up, compared case-insensitively; empty
     * when the repository has none.
     */
    inProgressLabels: readonly string[];

    /**
     * Labels the run never reports on; empty when the run excludes none.
     */
    excludedLabels: readonly string[];

    /**
     * Logins whose comments never count as engagement: the reporting identity itself, when it is a
     * maintainer's own account rather than a bot.
     */
    ignoredAuthors: readonly string[];

    /**
     * Logins of the repository's reporting bots: automation whose comments never count as
     * engagement, whatever association GitHub stamps on them.
     */
    reportBots: readonly string[];
}

/**
 * Abbreviated commit length used when a signal names a commit.
 *
 * Seven characters matches how the repository's own tooling abbreviates commits.
 */
export const SHORT_COMMIT_LENGTH = 7;

/**
 * Timeline event kinds the guard reads; every other kind is dropped by the reader.
 */
export const IssueEventKind = {
    Closed: 'closed',
    Referenced: 'referenced',
    CrossReferenced: 'cross_referenced',
    Commented: 'commented',
} as const;

/**
 * IssueEventKind value.
 */
export type IssueEventKind = (typeof IssueEventKind)[keyof typeof IssueEventKind];

/**
 * The issue was closed, by a commit message or by hand.
 */
export interface IssueClosedEvent {
    /**
     * Discriminant.
     */
    kind: typeof IssueEventKind.Closed;

    /**
     * Login of whoever closed the issue, when GitHub reports one.
     */
    actor: string | null;

    /**
     * Commit whose message closed the issue, when it was closed that way.
     */
    commitSha: string | null;

    /**
     * ISO timestamp of the event.
     */
    at: string;
}

/**
 * A commit message mentioned the issue.
 */
export interface IssueReferencedEvent {
    /**
     * Discriminant.
     */
    kind: typeof IssueEventKind.Referenced;

    /**
     * Login GitHub attributes the commit to, when known.
     */
    actor: string | null;

    /**
     * Full commit identifier.
     */
    commitSha: string;

    /**
     * `owner/name` of the repository holding the commit, parsed from its API URL; null when the URL
     * did not carry one. Mirror forks re-reference the same commit under their own name, so the
     * repository, not the identifier, says whether the commit belongs to the guarded repository.
     */
    commitRepository: string | null;

    /**
     * ISO timestamp of the event.
     */
    at: string;
}

/**
 * Another issue or pull request mentioned the issue.
 */
export interface IssueCrossReferencedEvent {
    /**
     * Discriminant.
     */
    kind: typeof IssueEventKind.CrossReferenced;

    /**
     * `owner/name` of the repository holding the referencing item, when reported.
     */
    sourceRepository: string | null;

    /**
     * Number of the referencing issue or pull request, when reported.
     */
    sourceNumber: number | null;

    /**
     * Whether the referencing item is a pull request.
     */
    sourceIsPullRequest: boolean;

    /**
     * Login of the referencing item's author, when reported.
     */
    sourceAuthor: string | null;

    /**
     * Repository association of the referencing item's author, when reported.
     */
    sourceAuthorAssociation: string | null;

    /**
     * ISO timestamp of the event.
     */
    at: string;
}

/**
 * Somebody commented on the issue.
 */
export interface IssueCommentEvent {
    /**
     * Discriminant.
     */
    kind: typeof IssueEventKind.Commented;

    /**
     * GitHub comment identifier.
     */
    id: number;

    /**
     * Comment author's login.
     */
    author: string;

    /**
     * Comment author's account type as GitHub reports it (`User`, `Bot`), when known.
     */
    authorType: string | null;

    /**
     * Comment author's repository association (`MEMBER`, `NONE`, ...), when reported.
     */
    authorAssociation: string | null;

    /**
     * ISO timestamp of the comment.
     */
    at: string;
}

/**
 * One timeline event the guard reasons about.
 */
export type IssueTimelineEvent =
    | IssueClosedEvent
    | IssueReferencedEvent
    | IssueCrossReferencedEvent
    | IssueCommentEvent;

/**
 * The issue as it stands at decision time: the slice of GitHub state the guard reads.
 */
export interface IssuePublicationFacts {
    /**
     * Issue number.
     */
    issueNumber: number;

    /**
     * Current issue state.
     */
    state: IssueState;

    /**
     * GitHub's close reason (`completed`, `not_planned`), when closed.
     */
    stateReason: string | null;

    /**
     * ISO timestamp of the close, when closed.
     */
    closedAt: string | null;

    /**
     * Login of whoever closed the issue, when closed and reported.
     */
    closedBy: string | null;

    /**
     * Current assignee logins.
     */
    assignees: readonly string[];

    /**
     * Current label names.
     */
    labels: readonly string[];

    /**
     * Timeline events of the kinds the guard reads, in timeline order.
     */
    events: readonly IssueTimelineEvent[];
}

/**
 * The guard's verdict over one issue snapshot.
 */
export interface PublicationDecision {
    /**
     * Why the comment stays silent, or null when nothing on the issue stands in the way.
     */
    reason: PublicationSilence | null;

    /**
     * Every signal found, as host-fact sentences for the rehearsal notice — not only the one that
     * decided. Empty exactly when the decision is to publish.
     */
    signals: readonly string[];
}

/**
 * Abbreviate a commit identifier for a signal sentence.
 *
 * @param sha - Full commit identifier.
 * @returns Its leading characters.
 */
function shortCommit(sha: string): string {
    return sha.slice(0, SHORT_COMMIT_LENGTH);
}

/**
 * Describe the close, when the issue is closed.
 *
 * @param facts - Issue snapshot.
 * @returns At most one signal sentence.
 */
function closedSignals(facts: IssuePublicationFacts): string[] {
    if (facts.state !== IssueState.Closed) {
        return [];
    }
    const closing = facts.events.find(
        (event): event is IssueClosedEvent => event.kind === IssueEventKind.Closed,
    );
    const via =
        closing?.commitSha === null || closing === undefined
            ? ''
            : ` via ${shortCommit(closing.commitSha)}`;
    return [
        `closed by ${facts.closedBy ?? 'unknown'} at ${facts.closedAt ?? 'unknown time'}` +
            ` (${facts.stateReason ?? 'no reason'})${via}`,
    ];
}

/**
 * Describe every fix landed or in flight: commits and pull requests of the guarded repository that
 * reference the issue. Fork mirrors re-reference the same commit under their own repository and are
 * ignored, as is any pull request outside the guarded repository.
 *
 * @param facts - Issue snapshot.
 * @param repository - `owner/name` of the guarded repository.
 * @returns One signal sentence per reference.
 */
function fixSignals(facts: IssuePublicationFacts, repository: string): string[] {
    const signals: string[] = [];
    for (const event of facts.events) {
        if (event.kind === IssueEventKind.Referenced && event.commitRepository === repository) {
            signals.push(
                `commit ${shortCommit(event.commitSha)} by ${event.actor ?? 'unknown'} at ${event.at}`,
            );
        }
        if (
            event.kind === IssueEventKind.CrossReferenced &&
            event.sourceIsPullRequest &&
            event.sourceRepository === repository
        ) {
            signals.push(
                `pull request #${event.sourceNumber ?? '?'} by ${event.sourceAuthor ?? 'unknown'}` +
                    ` (${event.sourceAuthorAssociation ?? 'no association'}) at ${event.at}`,
            );
        }
    }
    return signals;
}

/**
 * Describe every sign that a maintainer is on the issue: a comment by a trusted-association human,
 * an assignee, or an in-progress label.
 *
 * Bots are excluded before the association is consulted: a bot that files reports can carry
 * `MEMBER`, and otherwise every reported issue would count as engaged. Such a bot posting as an
 * ordinary user is recognized through the policy's reporting bots.
 *
 * @param facts - Issue snapshot.
 * @param policy - Trusted roles, ignored authors, reporting bots and in-progress labels.
 * @returns One signal sentence per sign.
 */
function engagementSignals(facts: IssuePublicationFacts, policy: PublicationGuardPolicy): string[] {
    const trusted = new Set(policy.trustedRoles.map((role) => role.toUpperCase()));
    const ignored = new Set(policy.ignoredAuthors.map((login) => login.toLowerCase()));
    const signals: string[] = [];
    for (const event of facts.events) {
        if (
            event.kind === IssueEventKind.Commented &&
            !isGithubBotAccount(
                { login: event.author, type: event.authorType },
                policy.reportBots,
            ) &&
            !ignored.has(event.author.toLowerCase()) &&
            trusted.has(event.authorAssociation?.trim().toUpperCase() ?? '')
        ) {
            signals.push(
                `comment ${event.id} by ${event.author} (${event.authorAssociation}) at ${event.at}`,
            );
        }
    }
    if (facts.assignees.length > 0) {
        signals.push(`assigned to ${facts.assignees.join(', ')}`);
    }
    for (const label of matchingNames(facts.labels, policy.inProgressLabels)) {
        signals.push(`labelled "${label}"`);
    }
    return signals;
}

/**
 * Describe every label on the issue the run excludes.
 *
 * @param issueLabels - Labels the issue carries.
 * @param excludedLabels - Labels the run never reports on.
 * @returns One signal sentence per excluded label the issue carries.
 */
export function exclusionSignals(
    issueLabels: readonly string[],
    excludedLabels: readonly string[],
): string[] {
    return matchingNames(issueLabels, excludedLabels).map(
        (label) => `labelled "${label}", which the run excludes`,
    );
}

/**
 * Decide whether a report may still be posted, given the issue as it stands now.
 *
 * The first matching rule names the reason - an excluded label, then closed, then a fix referenced,
 * then a maintainer engaged - while every signal found is returned, so a log or notice shows the
 * whole picture and not only the rule that fired.
 *
 * @param facts - Issue snapshot read right before the decision.
 * @param policy - Repository, trusted roles and both label sets to measure against.
 * @returns The reason to stay silent with every signal, or no reason and no signals.
 */
export function decidePublication(
    facts: IssuePublicationFacts,
    policy: PublicationGuardPolicy,
): PublicationDecision {
    const excluded = exclusionSignals(facts.labels, policy.excludedLabels);
    const closed = closedSignals(facts);
    const fixes = fixSignals(facts, policy.repository);
    const engaged = engagementSignals(facts, policy);
    const reason =
        excluded.length > 0
            ? PublicationSilence.ExcludedLabel
            : closed.length > 0
              ? PublicationSilence.IssueClosed
              : fixes.length > 0
                ? PublicationSilence.FixReferenced
                : engaged.length > 0
                  ? PublicationSilence.MaintainerEngaged
                  : null;
    return { reason, signals: [...excluded, ...closed, ...fixes, ...engaged] };
}

/**
 * What a forced run makes of the guard's decision.
 */
export interface ForcedPublicationDecision {
    /**
     * The decision the run acts on, with the maintainer-engaged silence lifted.
     */
    decision: PublicationDecision;

    /**
     * The maintainer signals the force overrode; empty when it overrode none.
     */
    overridden: readonly string[];
}

/**
 * Decide for a run a maintainer triggered themselves — by label or by a manual dispatch — and so
 * asked for the report: a maintainer on the issue no longer silences it. A closed issue, a fix
 * referenced and an excluded label still do.
 *
 * @param facts - Issue snapshot read right before the decision.
 * @param policy - Repository, trusted roles and both label sets to measure against.
 * @returns The decision, and the maintainer signals the force overrode.
 */
export function decideForcedPublication(
    facts: IssuePublicationFacts,
    policy: PublicationGuardPolicy,
): ForcedPublicationDecision {
    const decision = decidePublication(facts, policy);
    if (decision.reason !== PublicationSilence.MaintainerEngaged) {
        return { decision, overridden: [] };
    }
    // The maintainer rule fires last, so every signal of a decision it names is a maintainer's.
    return { decision: { reason: null, signals: [] }, overridden: decision.signals };
}
