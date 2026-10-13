import * as v from 'valibot';
import { ProblemType, IssueFactsSchema, type IssueFacts } from '../types/issue-facts';
import { ReportProblemType, type Report } from './report';

/**
 * The raw-issue identity the mapping reads: only fields the model never touches.
 */
export interface ReportSource {
    /**
     * The GitHub issue number.
     */
    number: number;

    /**
     * The issue's `html_url`.
     */
    url: string;

    /**
     * The issue's label names.
     */
    labels: string[];
}

/**
 * Product placeholder for a report whose environment names no product.
 *
 * The facts schema requires a non-empty product string, so the absence is represented, never
 * silently dropped.
 */
const UNKNOWN_PRODUCT = 'Unknown';

/**
 * Report problem types onto the shared facts vocabulary.
 *
 * The report vocabulary's `other` has no shared counterpart — the shared vocabulary uses `unknown`
 * for exactly this case, and the four shared members map through unchanged.
 */
const REPORT_PROBLEM_TYPE_TO_FACTS: Readonly<Record<ReportProblemType, ProblemType>> = {
    [ReportProblemType.Ads]: ProblemType.Ads,
    [ReportProblemType.AntiAdblock]: ProblemType.AntiAdblock,
    [ReportProblemType.IncorrectBlocking]: ProblemType.IncorrectBlocking,
    [ReportProblemType.Annoyance]: ProblemType.Annoyance,
    [ReportProblemType.Other]: ProblemType.Unknown,
};

/**
 * Map the model-filled report onto the runtime `IssueFacts`.
 *
 * Pure mapping plus schema validation — no issue-format knowledge lives here. Identity fields
 * (issue number, url, labels) come from the source, never from the model; everything else comes
 * from the report. The product is never synthesized: an absent environment product is represented
 * by the named placeholder.
 *
 * @param source - The raw issue's identity fields.
 * @param report - The model-filled, already schema-validated report.
 * @returns The schema-validated issue facts.
 */
export function reportToIssueFacts(source: ReportSource, report: Report): IssueFacts {
    const facts: IssueFacts = {
        issueNumber: source.number,
        issueUrl: source.url,
        reportedSiteUrls: report.siteUrls,
        labels: source.labels,
        declaredIssueType: report.declaredType,
        problemType: REPORT_PROBLEM_TYPE_TO_FACTS[report.problemType],
        product: report.environment.product ?? UNKNOWN_PRODUCT,
        os: report.environment.os,
        browser: report.environment.browser,
        enabledFilters: report.enabledLists,
        settingsImportUrl: report.settingsImportUrl,
        userComment: report.comment,
        screenshots: report.screenshots,
        reproductionSteps: report.reproductionSteps,
    };
    return v.parse(IssueFactsSchema, facts);
}
