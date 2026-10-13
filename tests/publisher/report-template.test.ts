import { describe, expect, it } from 'vitest';
import { renderTemplate } from '../../src/prompts/template';
import {
    BUILT_IN_REPORT_TEMPLATE,
    REPORT_TEMPLATE_FILL,
    ReportTemplateSource,
    extractReportTemplateSection,
    resolveReportTemplate,
} from '../../src/publisher/report-template';

describe('extractReportTemplateSection', () => {
    it('extracts the verbatim body of the first report template heading, case-insensitively', () => {
        const content = [
            '# Instruction',
            '',
            '## My REPORT TEMPLATE (rules for the comment)',
            'Post one short outcome for the issue.',
            '',
            '- the run artifacts links',
            '',
            '## Next section',
            'Not part of the template.',
        ].join('\n');

        expect(extractReportTemplateSection(content)).toBe(
            'Post one short outcome for the issue.\n\n- the run artifacts links\n',
        );
    });

    it('is fence-aware: a ## line inside a fenced block neither bounds nor starts a section', () => {
        const content = [
            '## REPORT Template',
            'Start with the outcome line.',
            '',
            '```text',
            '## not a heading',
            'a fenced step',
            '```',
            '',
            '## After',
            'Irrelevant.',
        ].join('\n');

        expect(extractReportTemplateSection(content)).toBe(
            'Start with the outcome line.\n\n```text\n## not a heading\na fenced step\n```\n',
        );
    });

    it('returns undefined when the instruction carries no report template section', () => {
        expect(
            extractReportTemplateSection('# Instruction\n\n## Guidance\n\nNothing here.\n'),
        ).toBeUndefined();
    });

    it('returns undefined when the report template section is whitespace-only', () => {
        const content = '## Report template\n   \n\n## Other section\nBody.\n';

        expect(extractReportTemplateSection(content)).toBeUndefined();
    });
});

describe('BUILT_IN_REPORT_TEMPLATE', () => {
    it('renders without error against the fixed fill skeleton', () => {
        expect(() =>
            renderTemplate(BUILT_IN_REPORT_TEMPLATE, REPORT_TEMPLATE_FILL, 'test template'),
        ).not.toThrow();
    });

    it('spells the six content sections of the report', () => {
        for (const heading of [
            '## Reproduced symptom',
            '## Rule',
            '## Executor and version',
            '## Policy rationale',
            '## Place in the list',
            '## Artifacts',
        ]) {
            expect(BUILT_IN_REPORT_TEMPLATE).toContain(heading);
        }
    });
});

describe('resolveReportTemplate', () => {
    it('picks the instruction section when present and labels the source', () => {
        const resolved = resolveReportTemplate(
            '# Title\n\n## Report template\nOne line and the artifact links.\n',
        );

        expect(resolved.source).toBe(ReportTemplateSource.Instruction);
        expect(resolved.template).toBe('One line and the artifact links.\n');
    });

    it('falls back to the built-in template when the instruction is absent or carries no section', () => {
        const builtIn = {
            template: BUILT_IN_REPORT_TEMPLATE,
            source: ReportTemplateSource.BuiltIn,
        };

        expect(resolveReportTemplate(undefined)).toEqual(builtIn);
        expect(resolveReportTemplate('# Instruction\n\n## Guidance\n\nNothing here.\n')).toEqual(
            builtIn,
        );
    });
});
