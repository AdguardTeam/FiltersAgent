/**
 * Report-template slot of the Publisher.
 *
 * An instruction may carry exactly one `##` section holding the report comment template, under a
 * fixed English keyword heading; its whole body is the report template verbatim — `{{camelCase}}`
 * placeholders inside it are filled at render time (see `report-render.ts`). An instruction without
 * such a heading simply means "use the built-in template": the absence is never a failure. The
 * built-in template spells the same content the instruction templates are expected to spell, so a
 * run with and without an instruction posts equivalent reports.
 */

import { extractInstructionSection } from '../knowledge/instruction-preparation';

/**
 * Keywords binding a Markdown `##` heading to the report-template role, checked case-insensitively
 * in the heading text.
 *
 * Mirrors the role-keyword binding of the instruction's preparation section: the instruction author
 * names the section naturally ("Report template", "Report template for the bot comment") and the
 * binding stays fixed on these keywords.
 */
const REPORT_TEMPLATE_SECTION_KEYWORDS = ['report template'] as const;

/**
 * Source of a report template.
 */
export const ReportTemplateSource = {
    /**
     * The template was extracted verbatim from the instruction's report-template section.
     */
    Instruction: 'instruction',

    /**
     * The template is the built-in one shipped by this module.
     */
    BuiltIn: 'builtin',
} as const;

/**
 * ReportTemplateSource value.
 */
export type ReportTemplateSource = (typeof ReportTemplateSource)[keyof typeof ReportTemplateSource];

/**
 * The fixed fill skeleton every report render builds from.
 *
 * Every fill is always computed — the value may be the empty string when the run outcome carries
 * nothing for it, but no key is ever missing — so a custom template may use any subset of these
 * placeholders without the render ever failing on a missing fill. The empty-string values make the
 * skeleton directly renderable.
 */
export const REPORT_TEMPLATE_FILL = {
    outcome: '',
    outcomeReason: '',
    versionUpdateHint: '',
    symptom: '',
    rule: '',
    repositoryLint: '',
    candidateForReview: '',
    stillVisible: '',
    executor: '',
    executorVersion: '',
    policyRationale: '',
    listPlace: '',
    artifactsLink: '',
    missingInformation: '',
    screenshots: '',
} as const;

/**
 * One report placeholder name.
 */
export type ReportTemplateFill = keyof typeof REPORT_TEMPLATE_FILL;

/**
 * Fill values for one report render, keyed by placeholder name — every fill always present, any
 * value possibly the empty string.
 */
export type ReportTemplateValues = Record<ReportTemplateFill, string>;

/**
 * The built-in fallback template: content-equivalent to well-formed instruction templates —
 * outcome, why the run ended as it did, the version-update hint when the reported version is
 * outdated and the defect does not reproduce, reproduced symptom, rule, what the repository's own
 * lint command said against it when it objected or could not run, the unverified candidate an
 * analysis-only run wants reviewed, what the review still saw on the page after that candidate,
 * executor and version, policy rationale, place in the list, missing information block, the
 * verified candidate's before and after screenshots, and the link to the run artifacts.
 */
export const BUILT_IN_REPORT_TEMPLATE = [
    '{{outcome}}',
    '',
    '{{outcomeReason}}',
    '',
    '{{versionUpdateHint}}',
    '',
    '## Reproduced symptom',
    '',
    '{{symptom}}',
    '',
    '## Rule',
    '',
    '{{rule}}',
    '',
    '## Repository lint',
    '',
    '{{repositoryLint}}',
    '',
    '## Candidate for review',
    '',
    '{{candidateForReview}}',
    '',
    '## Still visible after the rule',
    '',
    '{{stillVisible}}',
    '',
    '## Executor and version',
    '',
    '{{executor}} {{executorVersion}}',
    '',
    '## Policy rationale',
    '',
    '{{policyRationale}}',
    '',
    '## Place in the list',
    '',
    '{{listPlace}}',
    '',
    '## Missing information',
    '',
    '{{missingInformation}}',
    '',
    '## Screenshots',
    '',
    '{{screenshots}}',
    '',
    '## Artifacts',
    '',
    '{{artifactsLink}}',
    '',
].join('\n');

/**
 * One report template together with where it came from.
 */
export interface ResolvedReportTemplate {
    /**
     * Template text as rendered later — the verbatim instruction body or the built-in template.
     */
    template: string;

    /**
     * Which of the two sources the template came from.
     */
    source: ReportTemplateSource;
}

/**
 * Extract the instruction's report-template section: the body of the first `##` heading whose text
 * contains the report-template keyword, up to the next `##` heading or the end of the instruction.
 *
 * A thin wrapper over the one shared section parser (`knowledge/instruction-preparation.ts`) every
 * other instruction role already uses, so a grammar fix (CRLF, `~~~` fences, say) changes every
 * role at once instead of drifting between two copies.
 *
 * @param content - Instruction text as loaded.
 * @returns The verbatim template body, or undefined when the instruction carries no non-empty
 *   report-template section.
 */
export function extractReportTemplateSection(content: string): string | undefined {
    return extractInstructionSection(content, REPORT_TEMPLATE_SECTION_KEYWORDS);
}

/**
 * Resolve the report template for a run: the instruction's report-template section when present,
 * the built-in template otherwise. An absent or whitespace-only section silently falls back — the
 * built-in template spells the same content.
 *
 * @param instructionContent - Instruction text as loaded, or undefined for runs without an
 *   instruction.
 * @returns The template with its source label.
 */
export function resolveReportTemplate(instructionContent?: string): ResolvedReportTemplate {
    if (instructionContent !== undefined) {
        const section = extractReportTemplateSection(instructionContent);
        if (section !== undefined) {
            return { template: section, source: ReportTemplateSource.Instruction };
        }
    }
    return { template: BUILT_IN_REPORT_TEMPLATE, source: ReportTemplateSource.BuiltIn };
}
