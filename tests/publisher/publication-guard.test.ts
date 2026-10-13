import { describe, expect, it } from 'vitest';
import {
    decideForcedPublication,
    decidePublication,
    IssueEventKind,
    PublicationSilence,
    type IssuePublicationFacts,
    type IssueTimelineEvent,
    type PublicationGuardPolicy,
} from '../../src/publisher/publication-guard';
import { IssueState } from '../../src/types/issue-state';

const POLICY: PublicationGuardPolicy = {
    repository: 'owner/filters',
    trustedRoles: ['OWNER', 'MEMBER', 'COLLABORATOR'],
    inProgressLabels: [],
    excludedLabels: [],
    ignoredAuthors: ['owner'],
    reportBots: [],
};

function openIssue(events: readonly IssueTimelineEvent[] = []): IssuePublicationFacts {
    return {
        issueNumber: 7,
        state: IssueState.Open,
        stateReason: null,
        closedAt: null,
        closedBy: null,
        assignees: [],
        labels: [],
        events,
    };
}

function comment(author: string, association: string): IssueTimelineEvent {
    return {
        kind: IssueEventKind.Commented,
        id: 1,
        author,
        authorType: 'User',
        authorAssociation: association,
        at: '2026-10-05T10:00:00Z',
    };
}

function reference(repository: string): IssueTimelineEvent {
    return {
        kind: IssueEventKind.Referenced,
        actor: 'maintainer',
        commitSha: 'abcdef1234567',
        commitRepository: repository,
        at: '2026-10-05T10:00:00Z',
    };
}

describe('decidePublication', () => {
    it('lets a report through on an open issue nobody touched', () => {
        expect(decidePublication(openIssue(), POLICY)).toEqual({ reason: null, signals: [] });
    });

    it('counts only references from the guarded repository as a fix', () => {
        expect(decidePublication(openIssue([reference('mirror/filters')]), POLICY).reason).toBe(
            null,
        );
        expect(decidePublication(openIssue([reference('owner/filters')]), POLICY).reason).toBe(
            PublicationSilence.FixReferenced,
        );
    });

    it('counts a trusted human comment as engagement, but not the reporting identity itself', () => {
        expect(decidePublication(openIssue([comment('owner', 'OWNER')]), POLICY).reason).toBe(null);
        expect(decidePublication(openIssue([comment('reporter', 'NONE')]), POLICY).reason).toBe(
            null,
        );
        expect(decidePublication(openIssue([comment('maintainer', 'member')]), POLICY).reason).toBe(
            PublicationSilence.MaintainerEngaged,
        );
    });

    it('reads in-progress labels from the policy, ignoring case like GitHub does', () => {
        const labelled = { ...openIssue(), labels: ['a: in progress'] };

        expect(decidePublication(labelled, POLICY).reason).toBe(null);
        expect(
            decidePublication(labelled, { ...POLICY, inProgressLabels: ['A: In progress'] }),
        ).toEqual({
            reason: PublicationSilence.MaintainerEngaged,
            signals: ['labelled "a: in progress"'],
        });
    });

    it('does not count a configured report bot stamped MEMBER as a maintainer', () => {
        const botComment = openIssue([comment('Reporting-Bot', 'MEMBER')]);

        expect(decidePublication(botComment, POLICY).reason).toBe(
            PublicationSilence.MaintainerEngaged,
        );
        expect(decidePublication(botComment, { ...POLICY, reportBots: ['reporting-bot'] })).toEqual(
            { reason: null, signals: [] },
        );
    });

    it('silences a report on an issue labelled with an excluded label', () => {
        const labelled = { ...openIssue(), labels: ['nsfw'] };

        expect(decidePublication(labelled, POLICY).reason).toBe(null);
        expect(decidePublication(labelled, { ...POLICY, excludedLabels: ['NSFW'] })).toEqual({
            reason: PublicationSilence.ExcludedLabel,
            signals: ['labelled "nsfw", which the run excludes'],
        });
    });

    it('names the close first and still lists every signal', () => {
        const closed = {
            ...openIssue([comment('maintainer', 'MEMBER')]),
            state: IssueState.Closed,
            closedBy: 'maintainer',
        };

        const decision = decidePublication(closed, POLICY);

        expect(decision.reason).toBe(PublicationSilence.IssueClosed);
        expect(decision.signals).toHaveLength(2);
    });
});

describe('decideForcedPublication', () => {
    it('lets a report through on an issue a maintainer is on, naming what it overrode', () => {
        const engaged = {
            ...openIssue([comment('maintainer', 'MEMBER')]),
            assignees: ['maintainer'],
            labels: ['A: In progress'],
        };

        const forced = decideForcedPublication(engaged, {
            ...POLICY,
            inProgressLabels: ['A: In progress'],
        });

        expect(forced.decision).toEqual({ reason: null, signals: [] });
        expect(forced.overridden).toHaveLength(3);
    });

    it('still silences a closed issue and an excluded label, overriding nothing', () => {
        const assignedAndClosed = {
            ...openIssue(),
            assignees: ['maintainer'],
            state: IssueState.Closed,
            closedBy: 'maintainer',
        };
        const assignedAndExcluded = { ...openIssue(), assignees: ['maintainer'], labels: ['NSFW'] };

        const closed = decideForcedPublication(assignedAndClosed, POLICY);
        const excluded = decideForcedPublication(assignedAndExcluded, {
            ...POLICY,
            excludedLabels: ['NSFW'],
        });

        expect(closed.decision.reason).toBe(PublicationSilence.IssueClosed);
        expect(closed.overridden).toEqual([]);
        expect(excluded.decision.reason).toBe(PublicationSilence.ExcludedLabel);
        expect(excluded.overridden).toEqual([]);
    });
});
