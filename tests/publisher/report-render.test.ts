import { describe, expect, it } from 'vitest';
import { PromptRenderError } from '../../src/prompts/template';
import {
    ExtensionManifestVersion,
    PreparedExtensionSource,
} from '../../src/environment/extension-preparation';
import { AgentTerminationReason } from '../../src/types/agent-termination-reason';
import { BrowserFallbackReason } from '../../src/types/browser-fallback-reason';
import { FixRunStatus, SymptomObservation } from '../../src/types/fix-run-result';
import { InfrastructureFailureReason } from '../../src/types/infrastructure-failure-reason';
import {
    MAX_MISSING_INFORMATION_DETAIL_CHARACTERS,
    type MissingInformationEntry,
} from '../../src/types/missing-information';
import {
    FixOutcomeKind,
    MAX_SUMMARY_LENGTH,
    ReproductionStatus,
    type FixOutcome,
} from '../../src/types/fix-outcome';
import { PolicyDecisionKind } from '../../src/types/policy';
import { CandidateVisualAdLayoutResidue } from '../../src/types/candidate-visual-review';
import { BUILT_IN_REPORT_TEMPLATE } from '../../src/publisher/report-template';
import {
    buildReportTemplateValues,
    renderReportComment,
    summarizeReportOutcome,
} from '../../src/publisher/report-render';
import type { ReportOutcomeSummary, ReportRunResultInput } from '../../src/publisher/report-render';
import { CHARACTER_REFERENCE_PATTERN, liveGitHubConstructs, readerView } from './rendered-markdown';

const ARTIFACTS_LINK = 'https://github.com/owner/repo/actions/runs/42#artifacts';

function patchProposedSummary(): ReportOutcomeSummary {
    return {
        outcome: 'Candidate rule proposed',
        outcomeReason: '',
        versionUpdateHint: '',
        symptom: 'Reproduced — Ad banner reproduced with the prepared extension.',
        rule: 'example.com##.ad-banner',
        listPlace: 'BaseFilter/sections/specific.txt',
        executor: 'Pinned prebuilt release',
        executorVersion: '1.2.89',
        policyRationale: 'A first-party ad with a verified candidate. No paywall.',
        missingInformation: [],
        artifactsLink: ARTIFACTS_LINK,
    };
}

describe('buildReportTemplateValues', () => {
    it('maps a patch-proposed outcome to the rule, list place, executor, and artifacts link', () => {
        const values = buildReportTemplateValues(patchProposedSummary());

        expect(values.outcome.length).toBeGreaterThan(0);
        // Rendered in a code span (a backtick fence) so Markdown never reinterprets the rule.
        expect(values.rule).toBe('`example.com##.ad-banner`');
        expect(values.listPlace).toBe('BaseFilter/sections/specific.txt');
        expect(values.executor).toBe('Pinned prebuilt release');
        expect(values.executorVersion).toBe('1.2.89');
        expect(values.artifactsLink).toBe(ARTIFACTS_LINK);
        expect(values.missingInformation).toBe('');
    });

    it('always computes every key of the fixed fill set', () => {
        const values = buildReportTemplateValues(patchProposedSummary());

        expect(Object.keys(values).sort()).toEqual(
            [
                'artifactsLink',
                'candidateForReview',
                'executor',
                'executorVersion',
                'listPlace',
                'missingInformation',
                'outcome',
                'outcomeReason',
                'policyRationale',
                'repositoryLint',
                'rule',
                'screenshots',
                'stillVisible',
                'symptom',
                'versionUpdateHint',
            ].sort(),
        );
    });

    it('renders a subset template through the computed fills, ignoring the rest', () => {
        const values = buildReportTemplateValues(patchProposedSummary());

        const rendered = renderReportComment(
            'Rule: {{rule}} — artifacts: {{artifactsLink}}',
            values,
        );

        expect(rendered).toBe(`Rule: \`example.com##.ad-banner\` — artifacts: ${ARTIFACTS_LINK}`);
    });

    it('renders the built-in template end to end with real fill values', () => {
        const rendered = renderReportComment(
            BUILT_IN_REPORT_TEMPLATE,
            buildReportTemplateValues(patchProposedSummary()),
        );

        expect(rendered).toContain('Candidate rule proposed');
        expect(rendered).toContain('example.com##.ad-banner');
        expect(rendered).toContain(ARTIFACTS_LINK);
    });

    it('omits the trailing built-in Artifacts section when the run carries no artifacts link', () => {
        const rendered = renderReportComment(BUILT_IN_REPORT_TEMPLATE, {
            ...buildReportTemplateValues(patchProposedSummary()),
            artifactsLink: '',
        });

        expect(rendered).not.toContain('## Artifacts');
        expect(rendered).toContain('Candidate rule proposed');
    });

    it('omits an empty Artifacts section without dropping the section that follows it', () => {
        const template = `${BUILT_IN_REPORT_TEMPLATE}\n## Footer\n\nfooter text\n`;
        const rendered = renderReportComment(template, {
            ...buildReportTemplateValues(patchProposedSummary()),
            artifactsLink: '',
        });

        expect(rendered).not.toContain('## Artifacts');
        expect(rendered).toContain('## Footer');
        expect(rendered).toContain('footer text');
    });

    it('omits every empty section of a failed run and keeps the outcome', () => {
        // What the first live runs posted: a run that never reached a candidate still rendered
        // "Rule", "Policy rationale", "Place in the list" and "Executor and version" headings with
        // nothing under them.
        const rendered = renderReportComment(BUILT_IN_REPORT_TEMPLATE, {
            ...buildReportTemplateValues(patchProposedSummary()),
            rule: '',
            listPlace: '',
            executor: '',
            executorVersion: '',
            policyRationale: '',
            missingInformation: '',
        });

        expect(rendered).not.toContain('## Rule');
        expect(rendered).not.toContain('## Policy rationale');
        expect(rendered).not.toContain('## Place in the list');
        expect(rendered).not.toContain('## Executor and version');
        expect(rendered).not.toContain('## Missing information');
        expect(rendered).toContain('Candidate rule proposed');
        // The sections the run did fill survive intact.
        expect(rendered).toContain('## Reproduced symptom');
        expect(rendered).toContain('## Artifacts');
        expect(rendered).toContain(ARTIFACTS_LINK);
    });

    it('keeps a parent heading whose only content is a filled subsection', () => {
        const template = ['## Details', '', '### Rule', '', '{{rule}}', ''].join('\n');

        const rendered = renderReportComment(
            template,
            buildReportTemplateValues(patchProposedSummary()),
        );

        expect(rendered).toContain('## Details');
        expect(rendered).toContain('### Rule');
    });

    it('omits a deeper empty subsection together with the parent it empties', () => {
        const template = ['## Details', '', '### Rule', '', '{{rule}}', ''].join('\n');

        const rendered = renderReportComment(template, {
            ...buildReportTemplateValues(patchProposedSummary()),
            rule: '',
        });

        expect(rendered).not.toContain('### Rule');
        expect(rendered).not.toContain('## Details');
    });

    it('keeps the Artifacts section and its link when the link is present', () => {
        const template = `${BUILT_IN_REPORT_TEMPLATE}\n## Footer\n\nfooter text\n`;
        const rendered = renderReportComment(
            template,
            buildReportTemplateValues(patchProposedSummary()),
        );

        expect(rendered).toContain('## Artifacts');
        expect(rendered).toContain(ARTIFACTS_LINK);
        expect(rendered).toContain('## Footer');
    });

    it('names the fallback reason and its detail for an unreachable target', () => {
        const values = buildReportTemplateValues({
            ...patchProposedSummary(),
            outcome: 'The reported target URL was unreachable',
            outcomeReason:
                'Fallback — The page host was unreachable: the host refused the connection',
            rule: '',
            listPlace: '',
        });

        expect(values.rule).toBe('');
        expect(values.outcomeReason).toContain('The page host was unreachable');
        expect(values.outcomeReason).toContain('the host refused the connection');
    });

    it('names the infrastructure failure reason for a failed run', () => {
        const values = buildReportTemplateValues({
            ...patchProposedSummary(),
            outcome: 'The run failed',
            outcomeReason:
                'Infrastructure failure: The locked execution environment could not be prepared',
            symptom: '',
            rule: '',
            listPlace: '',
            executor: '',
            executorVersion: '',
            policyRationale: '',
        });

        expect(values.outcomeReason).toContain(
            'The locked execution environment could not be prepared',
        );
    });

    it('renders missing information as a "- subject: detail" block, empty when absent', () => {
        const missing: MissingInformationEntry[] = [
            { subject: 'settings import link', detail: 'no linked filter settings' },
            { subject: 'rule context', detail: 'first seen too late' },
        ];

        const values = buildReportTemplateValues({
            ...patchProposedSummary(),
            missingInformation: missing,
        });

        expect(values.missingInformation).toBe(
            '- settings import link: no linked filter settings\n- rule context: first seen too late',
        );
        expect(buildReportTemplateValues(patchProposedSummary()).missingInformation).toBe('');
    });

    it('shows model-authored text in the raw comment without HTML character references', () => {
        // What a published comment showed to anyone reading its Markdown: the summary of a
        // verified rule read `the site&#39;s own script` and `tftacademy.com&#35;&#35;img&#91;`.
        const summary =
            "On tftacademy.com the site's own script detects that the blocked loader never sets " +
            'window.nitroAds.loaded: the rule tftacademy.com##img[alt^="Custom skyscraperWide Ad"] ' +
            'hides the notice — 2 > 1, A & B, C:\\path, \\"quoted\\".';
        const comment = renderReportComment(
            BUILT_IN_REPORT_TEMPLATE,
            buildReportTemplateValues({
                ...patchProposedSummary(),
                symptom: `Reproduced — ${summary}`,
                policyRationale: summary,
            }),
        );

        expect(comment).not.toMatch(CHARACTER_REFERENCE_PATTERN);
        expect(readerView(comment)).toContain(summary);
    });

    it('renders text within every schema ceiling whole, however much of it the escape touches', () => {
        // Published comments cut a 481-character summary mid-word: the bound counted the escaped
        // characters, five or six for each quote, colon and hash.
        const sentence =
            'The site\'s script reads window.nitroAds.loaded: tftacademy.com##img[alt^="Ad"] hides it. ';
        const summary = sentence.repeat(Math.floor(MAX_SUMMARY_LENGTH / sentence.length)).trim();
        const detail = sentence
            .repeat(Math.floor(MAX_MISSING_INFORMATION_DETAIL_CHARACTERS / sentence.length))
            .trim();
        const reasons = [
            "The report is an anti-adblock wall on an English-language site (not a German wall), so the German-wall 'no rule' branch does not apply.",
            "The captured requests show the mechanism: the ad component loads NitroPay (s.nitropay.com/ads-2118.js, blocked by ||nitropay.com^$third-party) and the site's script polls window.nitroAds.loaded up to 10x/300ms before it sets hasAdBlocker.",
            "The defect is not the site's own advertising: the creative reads 'PLEASE DISABLE ADBLOCK' and renders only when the site concludes a blocker is present.",
            'A cosmetic element-hiding rule is the preferred fix: the content is never gated and stays usable after hiding.',
        ];

        const comment = renderReportComment(
            BUILT_IN_REPORT_TEMPLATE,
            buildReportTemplateValues(
                summarizeReportOutcome(
                    {
                        runStatus: FixRunStatus.PatchProposed,
                        symptomObservation: SymptomObservation.Reproduced,
                        candidatePatch: {
                            rule: 'tftacademy.com##img[alt^="Custom skyscraperWide Ad"]',
                            filePath: 'AnnoyancesFilter/Popups/sections/antiadblock.txt',
                        },
                        missingInformation: [{ subject: 'settings import link', detail }],
                    },
                    {
                        summary,
                        policyDecision: {
                            decision: PolicyDecisionKind.AllowRuleGeneration,
                            reasons,
                        },
                    },
                    ARTIFACTS_LINK,
                ),
            ),
        );

        const shown = readerView(comment);
        expect(summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);
        expect(shown).toContain(summary);
        expect(shown).toContain(detail);
        for (const reason of reasons) {
            expect(shown).toContain(reason);
        }
    });

    it('keeps html out of a reporter-side version inside the rendered hint', () => {
        const values = buildReportTemplateValues({
            ...patchProposedSummary(),
            versionUpdateHint: 'The report declares 4.1."2" — & <update>',
        });
        const rendered = renderReportComment('{{versionUpdateHint}}', values);

        expect(liveGitHubConstructs(rendered)).toEqual([]);
        expect(readerView(rendered)).toBe('The report declares 4.1."2" — & <update>');
    });

    it('throws a named PromptRenderError for a template token outside the fixed fill set', () => {
        const values = buildReportTemplateValues(patchProposedSummary());

        expect(() => renderReportComment('Sample: {{mysteryToken}}', values)).toThrowError(
            PromptRenderError,
        );
    });

    it('renders the candidate an analysis-only run could not verify, and nothing without one', () => {
        // A sarkisozleri.bbs.tr run: the rule the run found reached the reader only
        // inside the "Reproduced symptom" prose, under the heading "Analysis-only findings, no
        // verified change".
        const candidateForReview = {
            rule: '||increase-rev.cv3-ecf.workers.dev^$domain=sarkisozleri.bbs.tr',
            placement: { filePath: 'filters/2026/general_extensions.txt' },
            unverifiedReason:
                'The bound visual review returned inconclusive and page integrity stayed unclear.',
        };
        const analysisOnlyRun: ReportRunResultInput = {
            runStatus: FixRunStatus.AnalysisOnly,
            fallbackReason: null,
            fallbackDetail: null,
            symptomObservation: SymptomObservation.Reproduced,
            candidatePatch: null,
        };
        const decision = { summary: 'The candidate was applied but never confirmed.' };

        const carried = renderReportComment(
            BUILT_IN_REPORT_TEMPLATE,
            buildReportTemplateValues(
                summarizeReportOutcome(
                    { ...analysisOnlyRun, candidateForReview },
                    decision,
                    ARTIFACTS_LINK,
                ),
            ),
        );
        const bare = renderReportComment(
            BUILT_IN_REPORT_TEMPLATE,
            buildReportTemplateValues(
                summarizeReportOutcome(analysisOnlyRun, decision, ARTIFACTS_LINK),
            ),
        );

        expect(carried).toContain(candidateForReview.rule);
        expect(carried).toContain(candidateForReview.placement.filePath);
        expect(carried).toContain(candidateForReview.unverifiedReason);
        expect(bare).not.toContain(candidateForReview.rule);
        expect(bare).not.toContain('Candidate for review');
    });

    it('lists what the review still saw after an unverified candidate, and nothing when it saw none', () => {
        // Two published comments read as complete fixes because nothing in them said what the review had
        // seen after the rule. The header banner and the repeated placeholder bands were in the
        // review record all along.
        const analysisOnlyRun: ReportRunResultInput = {
            runStatus: FixRunStatus.AnalysisOnly,
            fallbackReason: null,
            fallbackDetail: null,
            symptomObservation: SymptomObservation.Reproduced,
            candidatePatch: null,
        };
        const decision = { summary: 'The candidate left part of the reported symptom behind.' };
        const remaining = [
            {
                landmark: 'Header, under the site navigation',
                description: 'The blue SerpApi banner still spans the page',
            },
            ...Array.from({ length: 6 }, (_, index) => ({
                landmark: `Between article sections ${index + 1} and ${index + 2}`,
                description: 'An empty grey placeholder band of the same height',
            })),
        ];

        const rejected = renderReportComment(
            BUILT_IN_REPORT_TEMPLATE,
            buildReportTemplateValues(
                summarizeReportOutcome(
                    {
                        ...analysisOnlyRun,
                        candidateVisualReview: { remainingInstances: remaining },
                    },
                    decision,
                    ARTIFACTS_LINK,
                ),
            ),
        );
        const verified = renderReportComment(
            BUILT_IN_REPORT_TEMPLATE,
            buildReportTemplateValues(
                summarizeReportOutcome(
                    { ...analysisOnlyRun, candidateVisualReview: { remainingInstances: [] } },
                    decision,
                    ARTIFACTS_LINK,
                ),
            ),
        );

        expect(rejected).toContain('Still visible after the rule');
        expect(rejected).toContain('Header, under the site navigation');
        expect(rejected).toContain('The blue SerpApi banner still spans the page');
        expect(rejected).toContain('Between article sections 1 and 2');
        // Bounded: the run's later repeats are summarized as a count, never printed one by one.
        expect(rejected).not.toContain('Between article sections 6 and 7');
        expect(rejected).toContain('2 more');
        expect(verified).not.toContain('Still visible after the rule');
    });
});

describe('summarizeReportOutcome', () => {
    it('projects the narrow summary from a verified fix run result and its decision', () => {
        const focused = patchProposedSummary();
        const summary = summarizeReportOutcome(
            {
                runStatus: FixRunStatus.PatchProposed,
                fallbackReason: null,
                fallbackDetail: null,
                symptomObservation: SymptomObservation.Reproduced,
                candidatePatch: { rule: focused.rule, filePath: focused.listPlace },
                extensionProvenance: {
                    source: PreparedExtensionSource.PinnedRelease,
                    extensionPath: '/run/extension',
                    manifestVersion: ExtensionManifestVersion.Mv3,
                    extensionSourceSha256: 'a'.repeat(64),
                    extensionSourceTag: '1.2.89',
                },
            },
            {
                summary: 'Ad banner reproduced with the prepared extension.',
                policyDecision: {
                    decision: 'allow_rule_generation',
                    reasons: ['A first-party ad with a verified candidate.', 'No paywall'],
                },
            },
            ARTIFACTS_LINK,
        );

        expect(summary).toEqual(focused);
    });

    it('notes leftover advertising layout beside a verified rule', () => {
        // Only a third-party host block is verified with residue present; the report tells the
        // maintainer the space is still there and leaves the cosmetic rule to them.
        const focused = patchProposedSummary();
        const summary = summarizeReportOutcome(
            {
                runStatus: FixRunStatus.PatchProposed,
                candidatePatch: { rule: focused.rule, filePath: focused.listPlace },
                candidateVisualReview: { adLayoutResidue: CandidateVisualAdLayoutResidue.Present },
            },
            { summary: 'Ads reproduced; the host block removed them.' },
            ARTIFACTS_LINK,
        );

        const comment = renderReportComment(
            BUILT_IN_REPORT_TEMPLATE,
            buildReportTemplateValues(summary),
        );

        expect(comment).toContain(focused.rule);
        expect(comment).toContain('Leftover layout');
    });

    it('keeps the policy rationale to the policy reasons and falls back from the tag to the manifest version', () => {
        // Published comments carried the agent's reasoning about which environment to lock under
        // "Policy rationale" whenever the policy reasons did not reach the report.
        const decision: FixOutcome = {
            outcome: FixOutcomeKind.ProposeClose,
            reproductionStatus: ReproductionStatus.NotReproduced,
            policyDecision: { decision: PolicyDecisionKind.AllowRuleGeneration, reasons: [] },
            reasoning: 'Environment: locked browser_extension, the report names the extension.',
            summary: 'The banner did not appear in either session.',
            evidenceSummary: 'Negative browser evidence only.',
        };
        const summary = summarizeReportOutcome(
            {
                runStatus: FixRunStatus.NotReproduced,
                fallbackReason: null,
                fallbackDetail: null,
                symptomObservation: SymptomObservation.NotReproduced,
                candidatePatch: null,
                extensionProvenance: {
                    source: PreparedExtensionSource.PinnedRelease,
                    extensionPath: '/run/extension',
                    manifestVersion: ExtensionManifestVersion.Mv3,
                    extensionSourceSha256: 'b'.repeat(64),
                },
            },
            decision,
            ARTIFACTS_LINK,
        );

        expect(summary.outcome).toBe('The reported defect was not reproduced');
        expect(summary.symptom).toContain('Not reproduced');
        expect(summary.symptom).toContain('The banner did not appear in either session.');
        expect(summary.policyRationale).toBe('');
        expect(JSON.stringify(summary)).not.toContain('Environment: locked');
        expect(
            renderReportComment(BUILT_IN_REPORT_TEMPLATE, buildReportTemplateValues(summary)),
        ).not.toContain('## Policy rationale');
        expect(summary.executorVersion).toBe('MV3');
        expect(summary.missingInformation).toEqual([]);
    });

    it.each([
        [PolicyDecisionKind.ProposeClose, /clos/iu],
        [PolicyDecisionKind.NeedsHumanReview, /maintainer/iu],
    ] as const)(
        'heads a run the %s policy verdict decided with that verdict, not with an observation it never made',
        (verdict, headline) => {
            // A published comment read "Analysis-only findings, no verified change" and
            // "Indeterminate — … so the report is recommended for closing": the policy verdict
            // decided the run, and the host binds no symptom observation to it.
            const summary = summarizeReportOutcome(
                {
                    runStatus: FixRunStatus.AnalysisOnly,
                    symptomObservation: SymptomObservation.Indeterminate,
                    candidatePatch: null,
                },
                {
                    summary: "The page's only ad-like content is the site's own promotion.",
                    policyDecision: {
                        decision: verdict,
                        reasons: ["Filter policy: the site's own advertising gets no rule."],
                    },
                },
                ARTIFACTS_LINK,
            );
            const analysisOnly = summarizeReportOutcome(
                { runStatus: FixRunStatus.AnalysisOnly, candidatePatch: null },
                {},
                ARTIFACTS_LINK,
            );

            expect(summary.outcome).not.toBe(analysisOnly.outcome);
            expect(summary.outcome).toMatch(headline);
            expect(summary.symptom).toBe(
                "The page's only ad-like content is the site's own promotion.",
            );
            expect(summary.policyRationale).toBe(
                "Filter policy: the site's own advertising gets no rule.",
            );
        },
    );

    it('keeps the run status as the outcome of a run its status speaks for, whatever the policy verdict', () => {
        // A run that never reached the page ends target_url_unavailable even when its decision
        // carried a closing verdict: the report says first what the run could not do.
        const run: ReportRunResultInput = {
            runStatus: FixRunStatus.TargetUrlUnavailable,
            symptomObservation: SymptomObservation.Indeterminate,
            candidatePatch: null,
        };
        const decided = summarizeReportOutcome(
            run,
            {
                summary: 'The page refused to load.',
                policyDecision: { decision: PolicyDecisionKind.ProposeClose, reasons: [] },
            },
            ARTIFACTS_LINK,
        );
        const undecided = summarizeReportOutcome(
            run,
            { summary: 'The page refused to load.' },
            ARTIFACTS_LINK,
        );

        expect(decided.outcome).toBe(undecided.outcome);
        expect(decided.symptom).toBe(undecided.symptom);
    });

    it("shows the decision's evidence summary as what the run found when it carries no summary", () => {
        // The summary is optional; the reasoning behind it walks through tools and environments.
        const reasoning =
            'Environment: locked browser_extension; then open_page, inspect_ad_slots.';
        const evidenceSummary = 'The banner was absent in the control and the prepared session.';
        const decision: FixOutcome = {
            outcome: FixOutcomeKind.ProposeClose,
            reproductionStatus: ReproductionStatus.NotReproduced,
            policyDecision: { decision: PolicyDecisionKind.AllowRuleGeneration, reasons: [] },
            reasoning,
            evidenceSummary,
        };

        const summary = summarizeReportOutcome(
            {
                runStatus: FixRunStatus.NotReproduced,
                symptomObservation: SymptomObservation.NotReproduced,
                candidatePatch: null,
            },
            decision,
            ARTIFACTS_LINK,
        );

        expect(summary.symptom).toContain(evidenceSummary);
        expect(summary.symptom).not.toContain(reasoning);
    });

    it("shows a sealed session's host reasoning as what the run found, never a model decision's", () => {
        // A model's reasoning is its working notes — environments, tools, steps — and a published
        // comment showed it as a finding. Only a session the host ended itself has nothing better.
        const run: ReportRunResultInput = {
            runStatus: FixRunStatus.AnalysisOnly,
            symptomObservation: SymptomObservation.Indeterminate,
            candidatePatch: null,
        };
        const modelReasoning =
            'Environment: adguard_cli (accepted, ready); then open_page and inspect_ad_slots.';
        const hostReasoning = 'Run sealed without an accepted fix outcome (aborted): wall clock.';
        const modelDecision: FixOutcome = {
            outcome: FixOutcomeKind.AnalysisOnly,
            reasoning: modelReasoning,
        };

        const fromModel = renderReportComment(
            BUILT_IN_REPORT_TEMPLATE,
            buildReportTemplateValues(summarizeReportOutcome(run, modelDecision, ARTIFACTS_LINK)),
        );
        const fromHost = summarizeReportOutcome(run, { hostReasoning }, ARTIFACTS_LINK);

        expect(readerView(fromModel)).not.toContain(modelReasoning);
        expect(fromHost.symptom).toContain(hostReasoning);
    });

    it('renders the manifest generation into the executor-version fill when the provenance records no source tag', () => {
        // The tag-wins direction is already pinned (the pinned-release projection and the
        // version-hint render above); this pins the no-tag fallback at the rendered fill: the
        // manifest generation, not an empty or arbitrary version. A tagged MV2 provenance would
        // name its tag here instead.
        const summary = summarizeReportOutcome(
            {
                runStatus: FixRunStatus.NotReproduced,
                fallbackReason: null,
                fallbackDetail: null,
                symptomObservation: SymptomObservation.NotReproduced,
                candidatePatch: null,
                extensionProvenance: {
                    source: PreparedExtensionSource.PinnedRelease,
                    extensionPath: '/run/extension',
                    manifestVersion: ExtensionManifestVersion.Mv2,
                    extensionSourceSha256: 'd'.repeat(64),
                },
            },
            {},
            ARTIFACTS_LINK,
        );

        const rendered = renderReportComment(
            '{{executorVersion}}',
            buildReportTemplateValues(summary),
        );

        expect(rendered).toBe('MV2');
        expect(summary.executorVersion).toBe('MV2');
    });

    it('composes the outcome reason from the infrastructure failure and the agent termination', () => {
        const summary = summarizeReportOutcome(
            {
                runStatus: FixRunStatus.Failed,
                fallbackReason: null,
                fallbackDetail: null,
                infrastructureFailureReason: InfrastructureFailureReason.EnvironmentUnavailable,
                agentTerminationReason: AgentTerminationReason.Interrupted,
                candidatePatch: null,
                missingInformation: [{ subject: 'rule context', detail: 'none' }],
            },
            {},
            ARTIFACTS_LINK,
        );

        expect(summary.outcome).toBe('The run failed');
        expect(summary.outcomeReason).toContain(
            'The locked execution environment could not be prepared',
        );
        expect(summary.outcomeReason).toContain('The host aborted the run');
        expect(summary.symptom).toBe('');
        expect(summary.missingInformation).toEqual([{ subject: 'rule context', detail: 'none' }]);
        expect(summary.executor).toBe('');
    });

    it('names the billing cause for a provider failure status, never "unreachable" or the provider body', () => {
        // The live run this guards against: OpenRouter answered 402 with a body naming the
        // reporter's account and a key-management URL. `ReportRunResultInput` only ever carries the
        // three-digit `providerFailureStatus`, never that body — this both documents the invariant
        // and proves the rendered wording for it names the billing cause instead of "unreachable".
        const providerBody =
            'This request requires more credits, or fewer max_tokens. ' +
            'See https://openrouter.ai/settings/keys for your account.';
        const summary = summarizeReportOutcome(
            {
                runStatus: FixRunStatus.Failed,
                fallbackReason: null,
                fallbackDetail: null,
                infrastructureFailureReason: InfrastructureFailureReason.LlmUnavailable,
                agentTerminationReason: AgentTerminationReason.LlmError,
                providerFailureStatus: 402,
                candidatePatch: null,
            },
            {},
            ARTIFACTS_LINK,
        );

        expect(summary.outcomeReason).not.toContain('unreachable');
        expect(summary.outcomeReason).toContain('402');
        expect(summary.outcomeReason.toLowerCase()).toContain('credit');
        expect(summary.outcomeReason).not.toContain(providerBody);
        expect(summary.outcomeReason).not.toContain('openrouter.ai');

        const rendered = renderReportComment(
            BUILT_IN_REPORT_TEMPLATE,
            buildReportTemplateValues(summary),
        );

        expect(rendered).not.toContain('unreachable');
        expect(rendered).toContain('402');
        expect(rendered).not.toContain(providerBody);
        expect(rendered).not.toContain('openrouter.ai');
    });

    it('tells the three run budgets apart in the rendered outcome reason', () => {
        // Every budget seal used to report `max_iterations_exceeded`, so the comment read "The
        // agent loop reached its budget" whether one provider response had stalled, the wall clock
        // had expired, or the loop had genuinely gone in circles. A maintainer reading the issue
        // has only this line, and it has to say which.
        const reasonFor = (agentTerminationReason: AgentTerminationReason): string =>
            summarizeReportOutcome(
                {
                    runStatus: FixRunStatus.Failed,
                    fallbackReason: null,
                    fallbackDetail: null,
                    agentTerminationReason,
                    candidatePatch: null,
                },
                {},
                ARTIFACTS_LINK,
            ).outcomeReason;

        const deadline = reasonFor(AgentTerminationReason.RequestDeadlineExceeded);
        const wallClock = reasonFor(AgentTerminationReason.WallClockExceeded);
        const iterations = reasonFor(AgentTerminationReason.MaxIterationsExceeded);

        expect(new Set([deadline, wallClock, iterations]).size).toBe(3);
        expect(deadline).toMatch(/deadline/i);
        expect(wallClock).toMatch(/wall-clock/i);
        expect(iterations).toMatch(/iteration/i);
    });

    it('names the fallback reason and detail for an unreachable target URL', () => {
        const summary = summarizeReportOutcome(
            {
                runStatus: FixRunStatus.TargetUrlUnavailable,
                fallbackReason: BrowserFallbackReason.TargetUnreachable,
                fallbackDetail: 'connection refused by the page host',
                candidatePatch: null,
            },
            { summary: 'geo-blocked' },
            ARTIFACTS_LINK,
        );

        expect(summary.outcomeReason).toContain('The page host was unreachable');
        expect(summary.outcomeReason).toContain('connection refused by the page host');
        expect(summary.symptom).toBe('geo-blocked');
    });

    it('names a regional restriction block in the summary and the rendered comment', () => {
        const summary = summarizeReportOutcome(
            {
                runStatus: FixRunStatus.NotReproduced,
                fallbackReason: BrowserFallbackReason.GeoBlocked,
                fallbackDetail: 'The main document returned HTTP 451.',
                candidatePatch: null,
            },
            {},
            ARTIFACTS_LINK,
        );

        const rendered = renderReportComment(
            '{{outcomeReason}}',
            buildReportTemplateValues(summary),
        );

        expect(rendered).toContain('Regional restriction blocked the page');
        expect(rendered).toContain('The main document returned HTTP 451.');
    });

    it('names a bot challenge block in the summary and the rendered comment', () => {
        const summary = summarizeReportOutcome(
            {
                runStatus: FixRunStatus.NotReproduced,
                fallbackReason: BrowserFallbackReason.BotChallenge,
                fallbackDetail: 'The page content indicates an anti-bot challenge.',
                candidatePatch: null,
            },
            {},
            ARTIFACTS_LINK,
        );

        const rendered = renderReportComment(
            '{{outcomeReason}}',
            buildReportTemplateValues(summary),
        );

        expect(rendered).toContain('A bot challenge blocked the page');
        expect(rendered).toContain('The page content indicates an anti-bot challenge.');
    });
});
