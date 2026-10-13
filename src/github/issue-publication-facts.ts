/**
 * GitHub reader of the publication guard: the issue's state and the timeline events
 * `publisher/publication-guard.ts` decides on.
 */

import type { Octokit } from '@octokit/rest';
import type { GithubAccountIdentity } from './fetch-issue';
import { IssueState } from '../types/issue-state';
import {
    IssueEventKind,
    type IssuePublicationFacts,
    type IssueTimelineEvent,
} from '../publisher/publication-guard';

/**
 * Timeline page size: GitHub's maximum, so one request covers the typical issue's history.
 */
const TIMELINE_PAGE_SIZE = 100;

/**
 * Repository slug inside a commit API URL (`.../repos/{owner}/{name}/commits/{sha}`).
 */
const COMMIT_URL_REPOSITORY_PATTERN = /\/repos\/([^/]+\/[^/]+)\/commits\//u;

/**
 * GitHub timeline event names, as the API spells them.
 */
const GithubTimelineEvent = {
    Closed: 'closed',
    Referenced: 'referenced',
    CrossReferenced: 'cross-referenced',
    Commented: 'commented',
} as const;

/**
 * Repository slug of a referencing item.
 */
interface RawTimelineSourceRepository {
    /**
     * `owner/name`.
     */
    full_name?: string;
}

/**
 * Issue or pull request that referenced the issue, on `cross-referenced`.
 */
interface RawTimelineSourceIssue {
    /**
     * Its number.
     */
    number?: number;

    /**
     * Its author.
     */
    user?: GithubAccountIdentity | null;

    /**
     * Its author's repository association.
     */
    author_association?: string | null;

    /**
     * Present when the item is a pull request.
     */
    pull_request?: unknown;

    /**
     * Repository holding the item.
     */
    repository?: RawTimelineSourceRepository | null;
}

/**
 * Referencing item wrapper on `cross-referenced`.
 */
interface RawTimelineSource {
    /**
     * The referencing issue or pull request.
     */
    issue?: RawTimelineSourceIssue | null;
}

/**
 * The fields of a timeline event the reader consumes.
 *
 * Octokit types the timeline as a union of every event schema whose members share no literal
 * discriminant, so nothing narrows on `event`; this structural view over the same typed data is the
 * narrowing, not a validation.
 */
interface RawTimelineEvent {
    /**
     * Event name.
     */
    event: string;

    /**
     * Event or comment timestamp.
     */
    created_at?: string;

    /**
     * Comment identifier, on `commented`.
     */
    id?: number;

    /**
     * Actor of a non-comment event.
     */
    actor?: GithubAccountIdentity | null;

    /**
     * Author of a comment.
     */
    user?: GithubAccountIdentity | null;

    /**
     * Author association of a comment.
     */
    author_association?: string | null;

    /**
     * Commit identifier on `closed` (when closed by a commit) and `referenced`.
     */
    commit_id?: string | null;

    /**
     * Commit API URL naming the repository that holds the commit.
     */
    commit_url?: string | null;

    /**
     * Referencing item on `cross-referenced`.
     */
    source?: RawTimelineSource | null;
}

/**
 * Map one GitHub timeline event to the guard's vocabulary.
 *
 * @param event - Typed GitHub timeline event.
 * @returns The guard event, or null for a kind the guard does not read.
 */
function toIssueEvent(event: RawTimelineEvent): IssueTimelineEvent | null {
    const at = event.created_at ?? '';
    switch (event.event) {
        case GithubTimelineEvent.Closed:
            return {
                kind: IssueEventKind.Closed,
                actor: event.actor?.login ?? null,
                commitSha: event.commit_id ?? null,
                at,
            };
        case GithubTimelineEvent.Referenced: {
            if (!event.commit_id) {
                return null;
            }
            return {
                kind: IssueEventKind.Referenced,
                actor: event.actor?.login ?? null,
                commitSha: event.commit_id,
                commitRepository:
                    COMMIT_URL_REPOSITORY_PATTERN.exec(event.commit_url ?? '')?.[1] ?? null,
                at,
            };
        }
        case GithubTimelineEvent.CrossReferenced: {
            const source = event.source?.issue;
            return {
                kind: IssueEventKind.CrossReferenced,
                sourceRepository: source?.repository?.full_name ?? null,
                sourceNumber: source?.number ?? null,
                sourceIsPullRequest: source?.pull_request != null,
                sourceAuthor: source?.user?.login ?? null,
                sourceAuthorAssociation: source?.author_association ?? null,
                at,
            };
        }
        case GithubTimelineEvent.Commented:
            return {
                kind: IssueEventKind.Commented,
                id: event.id ?? 0,
                author: event.user?.login ?? '',
                authorType: event.user?.type ?? null,
                authorAssociation: event.author_association ?? null,
                at,
            };
        default:
            return null;
    }
}

/**
 * Identity of the issue the guard reads.
 */
export interface IssuePublicationTarget {
    /**
     * Repository owner.
     */
    owner: string;

    /**
     * Repository name.
     */
    repo: string;

    /**
     * Issue number.
     */
    issueNumber: number;
}

/**
 * Read the issue as it stands now: its state and the timeline events the guard reads.
 *
 * Two requests - the issue and its paginated timeline. Errors propagate: the caller decides what an
 * unreadable issue means for publication.
 *
 * @param octokit - Octokit able to read the repository.
 * @param target - Repository and issue to read.
 * @returns The guard's snapshot of the issue.
 */
export async function readIssuePublicationFacts(
    octokit: Octokit,
    target: IssuePublicationTarget,
): Promise<IssuePublicationFacts> {
    const { owner, repo, issueNumber } = target;
    const { data: issue } = await octokit.rest.issues.get({
        owner,
        repo,
        issue_number: issueNumber,
    });
    const timeline = (await octokit.paginate(octokit.rest.issues.listEventsForTimeline, {
        owner,
        repo,
        issue_number: issueNumber,
        per_page: TIMELINE_PAGE_SIZE,
    })) as RawTimelineEvent[];
    return {
        issueNumber,
        state: issue.state === IssueState.Closed ? IssueState.Closed : IssueState.Open,
        stateReason: issue.state_reason ?? null,
        closedAt: issue.closed_at ?? null,
        closedBy: issue.closed_by?.login ?? null,
        assignees: (issue.assignees ?? []).map((assignee) => assignee.login),
        labels: issue.labels.map((label) =>
            typeof label === 'string' ? label : (label.name ?? ''),
        ),
        events: timeline
            .map(toIssueEvent)
            .filter((event): event is IssueTimelineEvent => event !== null),
    };
}
