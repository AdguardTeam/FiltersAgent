import * as v from 'valibot';

/**
 * Canonical problem-type vocabulary shared by the parser, intake scope, and agent tool schemas.
 */
export const ProblemType = {
    /**
     * Ads the filters miss.
     */
    Ads: 'ads',

    /**
     * An anti-adblock wall or detector.
     */
    AntiAdblock: 'anti-adblock',

    /**
     * An annoyance: cookie notices, popups, app banners, widgets.
     */
    Annoyance: 'annoyance',

    /**
     * Filtering breaks the site (a false positive).
     */
    IncorrectBlocking: 'incorrect-blocking',

    /**
     * The report names no recognised class.
     */
    Unknown: 'unknown',
} as const;

/**
 * ProblemType value.
 */
export type ProblemType = (typeof ProblemType)[keyof typeof ProblemType];

/**
 * Every ProblemType value, for the schema.
 */
export const PROBLEM_TYPE_VALUES = Object.values(ProblemType);

export const ProblemTypeSchema = v.picklist(PROBLEM_TYPE_VALUES);

/**
 * Whether a report describes filtering breaking a site rather than failing to block ads.
 *
 * The whole incorrect-blocking path — exception candidates, breakage rubrics, the fix workflow in
 * the system prompt — turns on this single question, so it is asked in one place.
 *
 * @param problemType - Parsed problem type of the report, when known.
 * @returns True for an incorrect-blocking (false positive) report.
 */
export function isIncorrectBlockingReport(problemType?: ProblemType): boolean {
    return problemType === ProblemType.IncorrectBlocking;
}

export const IssueScreenshotSchema = v.object({
    url: v.pipe(v.string(), v.url()),
    description: v.optional(v.string()),
});

export type IssueScreenshot = v.InferOutput<typeof IssueScreenshotSchema>;

export const ReportedFilterSchema = v.object({
    /**
     * The list exactly as the report names it: a list name, or a subscription URL.
     */
    name: v.string(),

    /**
     * The list's id in the official AdGuard filter catalog, when the extraction recognised it as
     * one of those lists; absent for every other list.
     */
    officialFilterId: v.optional(v.number()),
});

/**
 * One filter list the reporter has enabled, with the official catalog id the extraction found for
 * it.
 */
export type ReportedFilter = v.InferOutput<typeof ReportedFilterSchema>;

export const IssueFactsSchema = v.object({
    issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
    issueUrl: v.pipe(v.string(), v.url()),
    reportedSiteUrls: v.array(v.pipe(v.string(), v.url())),
    labels: v.array(v.string()),
    declaredIssueType: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(100))),
    problemType: ProblemTypeSchema,
    product: v.string(),
    os: v.optional(v.string()),
    browser: v.optional(v.string()),
    enabledFilters: v.array(ReportedFilterSchema),
    settingsImportUrl: v.optional(v.pipe(v.string(), v.url())),
    userComment: v.optional(v.string()),
    screenshots: v.array(IssueScreenshotSchema),
    reproductionSteps: v.optional(v.array(v.string())),
});

export type IssueFacts = v.InferOutput<typeof IssueFactsSchema>;
