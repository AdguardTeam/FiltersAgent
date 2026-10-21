import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
import { readerView } from '../publisher/rendered-markdown';
import {
    extractedReportSeam,
    ISSUE_COMMIT_FIXTURE,
    issueCommentOctokit,
    preparedWorkspace,
    processedRunResult,
    rawIssueFixture,
    removeScratchDirs,
    scratchDir,
} from './single-issue-run-fixtures';

afterEach(removeScratchDirs);

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
                screenshotsBranch: 'filters-agent-screenshots',
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
                screenshotsBranch: 'filters-agent-screenshots',
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
                screenshotsBranch: 'filters-agent-screenshots',
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
