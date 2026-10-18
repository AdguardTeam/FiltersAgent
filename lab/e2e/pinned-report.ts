import type { RawIssue } from '../../src/github/fetch-issue';
import { StructuredReportHeadingPattern } from '../../src/github/structured-report-template';
import { reporterSettingsImportUrls } from '../../src/orchestrator/reporter-import-url';

/**
 * Settings import parameters, and their exact values, a benchmark case's report must carry: a
 * browser extension report of the MV3 builds the historical replay assembles.
 */
const PINNABLE_REPORT_PARAMETERS = {
    product_type: 'ext',
    'ext.manifest_version': '3',
} as const;

/**
 * Settings import parameter naming the reporter's browser, compared case-insensitively.
 */
const BROWSER_PARAMETER = 'browser';

/**
 * The only reporter browser the historical builds replay.
 */
const PINNABLE_BROWSER = 'chrome';

/**
 * Settings import parameter naming the reported product version.
 */
const PRODUCT_VERSION_PARAMETER = 'product_version';

/**
 * Decide whether a reporter settings import link can pin a benchmark case to an extension version.
 *
 * `benchmark:case:add` selects a case's report with this rule and writes the version to `run.json`;
 * the benchmark finds the same report again with it, so the two cannot drift apart.
 *
 * @param importUrl - Reporter settings import link, `&amp;` separators already decoded.
 * @param extensionVersion - Exact extension version the case pins.
 * @returns Whether the link is a Chrome MV3 extension report of that version.
 */
export function isPinnableImportLink(importUrl: URL, extensionVersion: string): boolean {
    const parameters = importUrl.searchParams;
    return (
        parameters.get(PRODUCT_VERSION_PARAMETER) === extensionVersion &&
        parameters.get(BROWSER_PARAMETER)?.toLowerCase() === PINNABLE_BROWSER &&
        Object.entries(PINNABLE_REPORT_PARAMETERS).every(
            ([name, value]) => parameters.get(name) === value,
        )
    );
}

/**
 * Narrow an issue to the report its case was pinned to.
 *
 * `benchmark:case:add` reads the issue body and every reporter comment as separate reports and pins
 * the latest one whose settings import link passes {@link isPinnableImportLink} for the version it
 * writes to `run.json`. A reporter who re-reported after an update leaves several reports in one
 * issue; the case's site and environment are the pinned one's. Only text in the report form, under
 * its `### Issue URL (<type>)` heading, counts, so a comment that quotes the report is not taken
 * for it. Code finds the report without a model; whether the intake would accept it is the one
 * case:add check this cannot repeat.
 *
 * @param issue - Prompt-safe issue of the case.
 * @param extensionVersion - Extension version `run.json` pins.
 * @returns The issue reduced to the pinned report's text, without comments.
 * @throws {Error} When no report carries an import link for the pinned version.
 */
export function pinnedReport(issue: RawIssue, extensionVersion: string): RawIssue {
    const pinned = [issue.body ?? '', ...issue.comments.map((comment) => comment.body)]
        .map((body): RawIssue => ({ ...issue, body, comments: [] }))
        .filter(
            (report) =>
                StructuredReportHeadingPattern.IssueUrlStart.test(report.body ?? '') &&
                [...reporterSettingsImportUrls(report).values()].some((link) =>
                    isPinnableImportLink(new URL(link), extensionVersion),
                ),
        )
        .at(-1);
    if (!pinned) {
        throw new Error(
            'Golden issue has no report form under "### Issue URL" whose settings import link is ' +
                `a Chrome MV3 report of the pinned extension version ${extensionVersion}.`,
        );
    }
    return pinned;
}
