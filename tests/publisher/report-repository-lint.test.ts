import { describe, expect, it } from 'vitest';
import { FixRunStatus } from '../../src/types/fix-run-result';
import { RepositoryLintStatus } from '../../src/types/repository-lint';
import { BUILT_IN_REPORT_TEMPLATE } from '../../src/publisher/report-template';
import {
    buildReportTemplateValues,
    renderReportComment,
    summarizeReportOutcome,
    type ReportRunResultInput,
} from '../../src/publisher/report-render';

const ARTIFACTS_LINK = 'https://github.com/owner/repo/actions/runs/42#artifacts';

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
