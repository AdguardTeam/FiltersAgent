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
import type { MissingInformationEntry } from '../../src/types/missing-information';
import { RepositoryLintStatus } from '../../src/types/repository-lint';
import { BUILT_IN_REPORT_TEMPLATE } from '../../src/publisher/report-template';
import {
    buildReportTemplateValues,
    renderReportComment,
    summarizeReportOutcome,
} from '../../src/publisher/report-render';
import type { ReportOutcomeSummary, ReportRunResultInput } from '../../src/publisher/report-render';

const ARTIFACTS_LINK = 'https://github.com/owner/repo/actions/runs/42#artifacts';

/**
 * Fix the run shape the version-update hint decision rides on: an executor build whose version tag
 * the report names as the current version, with the symptom observation as the caller decides it.
 */
function olderReportedRun(symptomObservation: SymptomObservation): ReportRunResultInput {
    return {
        runStatus: FixRunStatus.NotReproduced,
        fallbackReason: null,
        fallbackDetail: null,
        symptomObservation,
        candidatePatch: null,
        extensionProvenance: {
            source: PreparedExtensionSource.PinnedRelease,
            extensionPath: '/run/extension',
            manifestVersion: ExtensionManifestVersion.Mv3,
            extensionSourceSha256: 'c'.repeat(64),
            // A real pinned release's tag, never a bare dotted-numeric version; the hint must
            // compare against environmentSelection.actual.productVersion below, not this display
            // value.
            extensionSourceTag: 'v4.6.0',
        },
        environmentSelection: { actual: { productVersion: '4.6.0' } },
    };
}

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
        policyRationale: 'first-party ad with a verified candidate; no paywall',
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

    it('escapes, flattens, and bounds model-authored text', () => {
        const values = buildReportTemplateValues({
            outcome: 'Candidate rule proposed',
            outcomeReason:
                'Fallback — Launch failed: ad & banner <img> injected\nnext line "quoted" text',
            versionUpdateHint: '',
            symptom: 'Reproduced — model summary',
            rule: '',
            listPlace: '',
            executor: '',
            executorVersion: '',
            policyRationale: "policy <reason 'one'>",
            missingInformation: [],
            artifactsLink: ARTIFACTS_LINK,
        });

        expect(values.outcomeReason.includes('&amp;')).toBe(true);
        expect(values.outcomeReason.includes('&lt;img&gt;')).toBe(true);
        expect(values.outcomeReason.includes('&quot;quoted&quot;')).toBe(true);
        expect(values.outcomeReason.includes('\n')).toBe(false);
        expect(values.outcomeReason.length).toBeLessThanOrEqual(500);
        expect(values.policyRationale.includes('&lt;reason &#39;one&#39;&gt;')).toBe(true);
    });

    it('keeps code spans in model-authored text literal and escapes the text around them', () => {
        // GitHub shows entities inside a code span as they are, so an escaped rule would read
        // `delfi.lv&#35;&#35;.logo-row`.
        const symptom = (text: string) =>
            buildReportTemplateValues({
                ...patchProposedSummary(),
                symptom: text,
            }).symptom;

        expect(symptom('Hidden by `delfi.lv##.logo-row` for @user')).toBe(
            'Hidden by `delfi.lv##.logo-row` for &#64;\u2060user',
        );
        // A backtick that opens no span is escaped with the rest of the plain text, so Markdown
        // cannot pair it into a span of its own.
        expect(symptom('one ` tick #1 @user')).toBe('one &#96; tick &#35;\u20601 &#64;\u2060user');
        expect(symptom('``@user` and \\`@user`')).toBe(
            '&#96;&#96;&#64;\u2060user` and \\`&#64;\u2060user&#96;',
        );
        // A span that does not fit is escaped like plain text rather than cut open.
        const long = symptom(`${'x'.repeat(480)} \`a##b ${'y'.repeat(40)}\``);
        expect(long.endsWith('…')).toBe(true);
        expect(long).toContain('a&#35;\u2060&#35;\u2060');
    });

    it('leaves no mention, issue reference or autolink in model-authored text', () => {
        // GitHub decodes `&#64;user` and `&#35;123` before resolving them, so an entity alone still
        // pings the user and cross-references the issue; a word joiner after the character stops
        // both, and an entity in place of the scheme colon stops the URL autolink.
        const symptom = buildReportTemplateValues({
            ...patchProposedSummary(),
            symptom:
                'ping @maintainer, see #123, owner/repo#4 and GH-5, get https://evil.test/fix or ' +
                'www.evil.test, mail a@b.test',
        }).symptom;

        expect(symptom).toBe(
            'ping &#64;\u2060maintainer, see &#35;\u2060123, owner/repo&#35;\u20604 and GH\u2060-5, ' +
                'get https&#58;//evil.test/fix or www\u2060.evil.test, mail a&#64;\u2060b.test',
        );
    });

    it('escapes a backslash so the entity after it still decodes', () => {
        // The model wrote \\" and GitHub showed \\&quot; as "&quot;".
        const symptom = buildReportTemplateValues({
            ...patchProposedSummary(),
            symptom: 'wall (\\"Dein Adblocker\\") shown',
        }).symptom;

        expect(symptom).toBe('wall (&#92;&quot;Dein Adblocker&#92;&quot;) shown');
    });

    it('truncates bounded text with an ellipsis at the 500-character boundary', () => {
        const values = buildReportTemplateValues({
            outcome: 'Candidate rule proposed',
            outcomeReason: 'Fallback — x'.padEnd(900, 'y'),
            versionUpdateHint: '',
            symptom: '',
            rule: '',
            listPlace: '',
            executor: '',
            executorVersion: '',
            policyRationale: '',
            missingInformation: [],
            artifactsLink: ARTIFACTS_LINK,
        });

        expect(values.outcomeReason.length).toBe(500);
        expect(values.outcomeReason.endsWith('…')).toBe(true);
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
        const decision = { reasoning: 'The candidate was applied but never confirmed.' };

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
        const decision = { reasoning: 'The candidate left part of the reported symptom behind.' };
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
                reasoning: 'The candidate resolved the reproduced selector.',
                policyDecision: {
                    decision: 'allow_rule_generation',
                    reasons: ['first-party ad with a verified candidate', 'no paywall'],
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
                candidateVisualReview: { adLayoutResidue: 'present' },
            },
            { summary: 'Ads reproduced.', reasoning: 'The host block removed them.' },
            ARTIFACTS_LINK,
        );

        const comment = renderReportComment(
            BUILT_IN_REPORT_TEMPLATE,
            buildReportTemplateValues(summary),
        );

        expect(comment).toContain(focused.rule);
        expect(comment).toContain('Leftover layout');
    });

    it('falls back from policy reasons to the decision reasoning and from the tag to the manifest version', () => {
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
            { reasoning: 'Negative browser evidence only.' },
            ARTIFACTS_LINK,
        );

        expect(summary.outcome).toBe('The reported defect was not reproduced');
        expect(summary.symptom).toBe('Not reproduced');
        expect(summary.policyRationale).toBe('Negative browser evidence only.');
        expect(summary.executorVersion).toBe('MV3');
        expect(summary.missingInformation).toEqual([]);
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

describe('version update hint', () => {
    // The reported blocker version verbatim, as the run wiring passes it from
    // `Report` → `environment.version`.
    const REPORTED_VERSION = '4.1.2';

    it('renders the update suggestion into the built-in report for an older version that does not reproduce', () => {
        const summary = summarizeReportOutcome(
            olderReportedRun(SymptomObservation.NotReproduced),
            {},
            ARTIFACTS_LINK,
            REPORTED_VERSION,
        );
        const values = buildReportTemplateValues(summary);

        expect(values.versionUpdateHint.length).toBeGreaterThan(0);
        expect(values.versionUpdateHint).toContain('4.1.2');
        expect(values.versionUpdateHint).toContain('4.6.0');

        const rendered = renderReportComment(BUILT_IN_REPORT_TEMPLATE, values);
        expect(rendered).toContain('4.1.2');
        expect(rendered).toContain('4.6.0');
    });

    it('keeps the hint empty and the current version named when the symptom reproduces', () => {
        const summary = summarizeReportOutcome(
            olderReportedRun(SymptomObservation.Reproduced),
            {},
            ARTIFACTS_LINK,
            REPORTED_VERSION,
        );
        const values = buildReportTemplateValues(summary);

        expect(values.versionUpdateHint).toBe('');
        // The display executor version is still the provenance tag, unaffected by the hint's own
        // (unused, since the symptom reproduced) comparison input.
        expect(values.executorVersion).toBe('v4.6.0');

        const rendered = renderReportComment(BUILT_IN_REPORT_TEMPLATE, values);
        expect(rendered).toContain('4.6.0');
    });

    it('escapes html-reserved characters of a reporter-side version inside the rendered hint', () => {
        const values = buildReportTemplateValues({
            ...patchProposedSummary(),
            versionUpdateHint: 'The report declares 4.1."2" — & <update>',
        });
        const rendered = renderReportComment('{{versionUpdateHint}}', values);

        expect(rendered).toContain('&quot;2&quot;');
        expect(rendered).toContain('&amp;');
        expect(rendered).toContain('&lt;update&gt;');
        expect(rendered).not.toContain('<update>');
    });

    it('leaves the hint empty when the run carries no reported version', () => {
        const summary = summarizeReportOutcome(
            olderReportedRun(SymptomObservation.NotReproduced),
            {},
            ARTIFACTS_LINK,
        );

        expect(summary.versionUpdateHint).toBe('');
        expect(buildReportTemplateValues(summary).versionUpdateHint).toBe('');
    });
});

describe('repository lint section', () => {
    it("carries the repository linter's objection to the rule, and nothing when it had none", () => {
        const verifiedRun: ReportRunResultInput = {
            runStatus: FixRunStatus.PatchProposed,
            fallbackReason: null,
            fallbackDetail: null,
            candidatePatch: { rule: 'example.com##.ad', filePath: 'filters/specific.txt' },
        };
        const render = (run: ReportRunResultInput): string =>
            renderReportComment(
                BUILT_IN_REPORT_TEMPLATE,
                buildReportTemplateValues(summarizeReportOutcome(run, {}, ARTIFACTS_LINK)),
            );
        // Output that tries to close the code block and mention someone stays inside it.
        const output = 'filters/a.txt:1 error: modifier is excluded\n```\n@maintainer';

        const flagged = render({
            ...verifiedRun,
            repositoryLint: {
                status: RepositoryLintStatus.Problems,
                command: 'npx aglint',
                exitCode: 1,
                output,
                outputTruncated: false,
            },
        });

        expect(flagged).toContain('## Repository lint');
        expect(flagged).toContain('`npx aglint`');
        expect(flagged).toContain(`\`\`\`\`\n${output}\n\`\`\`\``);
        expect(render(verifiedRun)).not.toContain('## Repository lint');
    });
});
