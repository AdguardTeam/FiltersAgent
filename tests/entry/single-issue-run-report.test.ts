import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    FixRunStatus,
    SymptomObservation,
    type FixRunResult,
} from '../../src/types/fix-run-result';
import { FixOutcomeKind, ReproductionStatus } from '../../src/types/fix-outcome';
import { PolicyDecisionKind } from '../../src/types/policy';
import { PlacementBasis } from '../../src/types/placement-basis';
import { RepositoryEditKind } from '../../src/types/repository-edit-kind';
import { RuleType } from '../../src/types/rule-proposal';
import { testCoreConfig } from '../config/test-core-config';
import { runDefaultSingleIssue } from '../../src/entry/single-issue-run';
import { ScreenshotsStorage } from '../../src/publisher/report-screenshots';
import { readerView } from '../publisher/rendered-markdown';
import {
    extractedReportSeam,
    ISSUE_COMMIT_FIXTURE,
    issueCommentOctokit,
    preparedWorkspace,
    processedRunResult,
    rawIssueFixture,
    removeScratchDirs,
    REQUEST_DEFAULTS,
    scratchDir,
} from './single-issue-run-fixtures';

afterEach(removeScratchDirs);

/**
 * What one user-token run with a verified rule left behind.
 */
interface UserTokenRun {
    /**
     * Whether the report was posted.
     */
    posted: boolean;

    /**
     * Body of the posted report.
     */
    body: string;

    /**
     * Address the upload answered for the page without the rule.
     */
    beforeUrl: string;

    /**
     * Address the upload answered for the page with the rule.
     */
    afterUrl: string;

    /**
     * The upload spy.
     */
    upload: ReturnType<typeof vi.fn>;

    /**
     * The branch spies: a run with the attachments storage writes nothing to git.
     */
    git: Record<string, ReturnType<typeof vi.fn>>;
}

/**
 * Run one issue with a verified rule under a user account's token.
 *
 * @param withInstruction - Whether the checkout carries the fixture instruction, whose report
 *   template shows no screenshots.
 * @returns What the run posted and which requests it made.
 */
async function runVerifiedRuleUnderUserToken(withInstruction: boolean): Promise<UserTokenRun> {
    const beforeUrl =
        'https://github.com/user-attachments/assets/33333333-3333-4333-8333-333333333333';
    const afterUrl =
        'https://github.com/user-attachments/assets/44444444-4444-4444-8444-444444444444';
    const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction });
    const artifactsDir = join(scratchDir('single-issue-artifacts-'), 'out');
    const shotsDir = scratchDir('single-issue-shots-');
    const shot = (name: string): string => {
        const path = join(shotsDir, `${name}.png`);
        writeFileSync(path, name);
        return path;
    };
    const issueOctokit = issueCommentOctokit();
    // The branch spies must stay untouched: a run with the attachments storage uploads the pair
    // and writes nothing to git.
    const git = {
        getRef: vi.fn(),
        getCommit: vi.fn(),
        createBlob: vi.fn(),
        createTree: vi.fn(),
        createCommit: vi.fn(),
        createRef: vi.fn(),
        updateRef: vi.fn(),
    };
    const octokit = {
        ...issueOctokit,
        request: vi
            .fn()
            .mockResolvedValueOnce({ data: { url: beforeUrl } })
            .mockResolvedValueOnce({ data: { url: afterUrl } }),
        rest: {
            ...issueOctokit.rest,
            repos: { get: vi.fn().mockResolvedValue({ data: { id: 4_242 } }) },
            git,
        },
    } as unknown as Octokit;
    const proposed: FixRunResult = {
        ...processedRunResult(4),
        runStatus: FixRunStatus.PatchProposed,
        symptomObservation: SymptomObservation.Reproduced,
        candidatePatch: {
            rule: 'example.com##.ad',
            ruleType: RuleType.Cosmetic,
            filePath: 'PolishFilter/sections/specific.txt',
            repositoryEdit: {
                kind: RepositoryEditKind.Insert,
                insertionPoint: 83,
                anchorRule: 'zywiecinfo.pl,bialobrzegi24.net,bilgoraj.com.pl##.baner',
                basis: PlacementBasis.DomainBlock,
            },
        },
        artifactPaths: {
            screenshots: [],
            domSnapshot: null,
            har: null,
            trace: null,
            verifiedCandidateScreenshots: {
                before: shot('before'),
                after: shot('after'),
                beforeFullPage: shot('before-full'),
                afterFullPage: shot('after-full'),
            },
        },
    };

    const result = await runDefaultSingleIssue(
        {
            config: testCoreConfig(),
            slug: { owner: 'remote-owner', repo: 'remote-list' },
            checkoutPath: workspace.localSourcePath,
            issueNumber: 4,
            token: 'test-token',
            commentsEnabled: true,
            screenshots: { storage: ScreenshotsStorage.Attachments },
            artifactsDir,
        },
        {
            preparationDependencies: workspace.dependencies,
            ...extractedReportSeam(),
            octokit,
            investigate: () => Promise.resolve(proposed),
            fetchIssue: (config, issueNumber) => {
                void config;
                return Promise.resolve(rawIssueFixture(issueNumber));
            },
        },
    );

    return {
        posted: result.kind === 'processed' && result.publication?.action === 'posted',
        body: vi.mocked(octokit.rest.issues.createComment).mock.calls[0]?.[0]?.body ?? '',
        beforeUrl,
        afterUrl,
        upload: vi.mocked(octokit.request) as unknown as ReturnType<typeof vi.fn>,
        git,
    };
}

describe('runDefaultSingleIssue report content', () => {
    it("shows the run's own reasoning when the session ended without a model decision", async () => {
        // The host sealed the session, so no model decision reached the report, and the comment
        // would show nothing of what the run found.
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const artifactsDir = join(scratchDir('single-issue-artifacts-'), 'out');
        const sealedResult: FixRunResult = {
            ...processedRunResult(4),
            runStatus: FixRunStatus.AnalysisOnly,
            reasoning: 'The article shows an empty .module_ad container in the sidebar.',
        };

        await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                commentsEnabled: false,
                ...REQUEST_DEFAULTS,
                artifactsDir,
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                investigate: () => Promise.resolve(sealedResult),
                fetchIssue: (config, issueNumber) => {
                    void config;
                    return Promise.resolve(rawIssueFixture(issueNumber));
                },
            },
        );

        const report = readFileSync(join(artifactsDir, 'report-comment.md'), 'utf8');
        expect(report).toContain('empty .module_ad container');
        // What the run found, not a policy rationale it never had.
        expect(report).not.toContain('## Policy rationale');
    });

    it("posts the decision's policy reasons as the policy rationale, not its reasoning", async () => {
        // Published comments carried the agent's reasoning about the environment under "Policy
        // rationale": the policy reasons never reached the report.
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const octokit = issueCommentOctokit();
        const artifactsDir = join(scratchDir('single-issue-artifacts-'), 'out');
        const reasons = [
            "Filter policy: the site's own advertising (first-party ads) gets no rule.",
            'Not an anti-adblock case: no wall, overlay or detector script appeared.',
        ];
        const reasoning =
            'Routing: the report is filed for AdGuard for iOS, so the run locked adguard_cli.';

        const result = await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                token: 'test-token',
                commentsEnabled: true,
                ...REQUEST_DEFAULTS,
                artifactsDir,
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                octokit,
                investigate: async (config, issue, options, coreDependencies) => {
                    void config;
                    void issue;
                    void options;
                    coreDependencies.onAgentRunArtifacts?.({
                        decision: {
                            outcome: FixOutcomeKind.ProposeClose,
                            reproductionStatus: ReproductionStatus.PolicyBlocked,
                            summary: "The page's only ad-like content is the site's own promotion.",
                            reasoning,
                            policyDecision: { decision: PolicyDecisionKind.ProposeClose, reasons },
                            evidenceSummary: 'The page serves no third-party ads.',
                        },
                        observations: [],
                    });
                    return {
                        ...processedRunResult(4),
                        runStatus: FixRunStatus.AnalysisOnly,
                        symptomObservation: SymptomObservation.Indeterminate,
                        reasoning,
                    };
                },
                fetchIssue: async (config, issueNumber) => {
                    void config;
                    return rawIssueFixture(issueNumber);
                },
            },
        );

        expect(result.kind === 'processed' && result.publication).toMatchObject({
            action: 'posted',
        });
        const posted = readerView(
            vi.mocked(octokit.rest.issues.createComment).mock.calls[0]?.[0]?.body ?? '',
        );
        for (const reason of reasons) {
            expect(posted).toContain(reason);
        }
        expect(posted).not.toContain(reasoning);
    });

    it('attaches the screenshots of a verified rule when the run works under a user token', async () => {
        const run = await runVerifiedRuleUnderUserToken(false);

        expect(run.posted).toBe(true);
        expect(run.body).toContain(run.beforeUrl);
        expect(run.body).toContain(run.afterUrl);
        for (const method of Object.values(run.git)) {
            expect(method).not.toHaveBeenCalled();
        }
    });

    it('uploads nothing when the report template shows no screenshots', async () => {
        const run = await runVerifiedRuleUnderUserToken(true);

        expect(run.posted).toBe(true);
        expect(run.upload).not.toHaveBeenCalled();
        expect(run.body).not.toContain(run.beforeUrl);
    });

    it('links the place in the list to its line at the commit the run analyzed', async () => {
        // The lists come from the repository the action runs on, at the commit the run pinned: a
        // permalink there shows the maintainer the exact line, in a fork as much as upstream.
        const workspace = preparedWorkspace({ localSourceAvailable: true, withInstruction: false });
        const artifactsDir = join(scratchDir('single-issue-artifacts-'), 'out');
        const filePath = 'PolishFilter/sections/specific.txt';
        const anchorRule = 'zywiecinfo.pl,bialobrzegi24.net,bilgoraj.com.pl##.baner';
        const proposed: FixRunResult = {
            ...processedRunResult(4),
            runStatus: FixRunStatus.PatchProposed,
            symptomObservation: SymptomObservation.Reproduced,
            candidatePatch: {
                rule: 'example.com##.ad',
                ruleType: RuleType.Cosmetic,
                filePath,
                repositoryEdit: {
                    kind: RepositoryEditKind.Insert,
                    insertionPoint: 83,
                    anchorRule,
                    basis: PlacementBasis.DomainBlock,
                },
            },
        };

        await runDefaultSingleIssue(
            {
                config: testCoreConfig(),
                slug: { owner: 'remote-owner', repo: 'remote-list' },
                checkoutPath: workspace.localSourcePath,
                issueNumber: 4,
                commentsEnabled: false,
                ...REQUEST_DEFAULTS,
                artifactsDir,
            },
            {
                preparationDependencies: workspace.dependencies,
                ...extractedReportSeam(),
                investigate: () => Promise.resolve(proposed),
                fetchIssue: (config, issueNumber) => {
                    void config;
                    return Promise.resolve(rawIssueFixture(issueNumber));
                },
            },
        );

        const report = readFileSync(join(artifactsDir, 'report-comment.md'), 'utf8');
        const fileUrl = `https://github.com/remote-owner/remote-list/blob/${ISSUE_COMMIT_FIXTURE}/${filePath}`;
        expect(report).toContain(`](${fileUrl})`);
        expect(report).toContain(`](${fileUrl}#L84)`);
        expect(report).not.toContain(anchorRule);
    });
});
