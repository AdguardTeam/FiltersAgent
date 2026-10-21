import { describe, expect, it } from 'vitest';
import { FixRunStatus, SymptomObservation } from '../../src/types/fix-run-result';
import { RepositoryLintStatus } from '../../src/types/repository-lint';
import { collapseBlankLines } from '../../src/publisher/report-empty-sections';
import { BUILT_IN_REPORT_TEMPLATE } from '../../src/publisher/report-template';
import {
    buildReportTemplateValues,
    renderReportComment,
    summarizeReportOutcome,
    type ReportDecisionInput,
    type ReportRunResultInput,
} from '../../src/publisher/report-render';
import { ARTIFACTS_LINK, LIST_SOURCE } from './report-fixtures';

/**
 * Two blank lines in a row: what a Markdown reader sees as padding.
 */
const BLANK_LINE_RUN_PATTERN = /\n[ \t]*\n[ \t]*\n/u;

/**
 * Render the built-in report for one run and decision.
 */
function renderBuiltIn(run: ReportRunResultInput, decision: ReportDecisionInput): string {
    return renderReportComment(
        BUILT_IN_REPORT_TEMPLATE,
        buildReportTemplateValues(
            summarizeReportOutcome(run, decision, ARTIFACTS_LINK, LIST_SOURCE),
        ),
    );
}

describe('blank lines', () => {
    it('leaves no run of blank lines where the fills a run had nothing for rendered empty', () => {
        // Published comments put five blank lines under the outcome: the outcome reason and the
        // version-update hint are their own paragraphs in the template and rendered empty.
        const comment = renderBuiltIn(
            {
                runStatus: FixRunStatus.NotReproduced,
                symptomObservation: SymptomObservation.NotReproduced,
                candidatePatch: null,
            },
            { summary: 'The banner did not appear in either session.' },
        );

        expect(comment).not.toMatch(BLANK_LINE_RUN_PATTERN);
    });

    it('keeps the blank lines of a command output inside its code block', () => {
        const output = 'filters/a.txt:1 error: modifier is excluded\n\n\n1 problem';
        const comment = renderBuiltIn(
            {
                runStatus: FixRunStatus.PatchProposed,
                candidatePatch: { rule: 'example.com##.ad', filePath: 'filters/a.txt' },
                repositoryLint: {
                    status: RepositoryLintStatus.Problems,
                    command: 'npx aglint',
                    exitCode: 1,
                    output,
                    outputTruncated: false,
                },
            },
            {},
        );

        expect(comment).toContain(output);
    });

    it('reads a line opening with a code span as text, not as a code block', () => {
        // A policy reason that quotes a rule first starts its line with a triple-backtick span.
        // Read as a fence, it would keep the padding after it and take the next real block's
        // opening fence for its own end, collapsing the command output inside that block.
        const output = 'filters/a.txt:1 error: modifier is excluded\n\n\n1 problem';
        const body = [
            "```example.com##.promo``` would hide the site's own promotion.",
            '',
            '',
            '',
            'Next paragraph.',
            '',
            '````',
            output,
            '````',
            '',
        ].join('\n');

        const collapsed = collapseBlankLines(body);

        expect(collapsed).toContain(`\`\`\`\`\n${output}\n\`\`\`\``);
        expect(collapsed.replace(output, '')).not.toMatch(BLANK_LINE_RUN_PATTERN);
    });
});
