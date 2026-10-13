import * as v from 'valibot';
import { OFFICIAL_ADGUARD_FILTERS } from '../environment/official-filter-table';
import { ReportedFilterSchema } from '../types/issue-facts';

/**
 * Problem-type vocabulary of the model-filled report, per the PRD's Report entity.
 *
 * Deliberately separate from the shared `ProblemType` (issue-facts): the report vocabulary uses
 * `other` where the facts vocabulary uses `unknown`, and the mapping between the two lives in
 * `report-facts.ts`.
 */
export const ReportProblemType = {
    /**
     * The report is about ads that are not blocked.
     */
    Ads: 'ads',

    /**
     * The report is about an anti-adblock wall or script.
     */
    AntiAdblock: 'anti-adblock',

    /**
     * The report is about filtering that breaks the page.
     */
    IncorrectBlocking: 'incorrect-blocking',

    /**
     * The report is about an annoyance, not ads.
     */
    Annoyance: 'annoyance',

    /**
     * The report carries no recognizable problem class.
     */
    Other: 'other',
} as const;

/**
 * ReportProblemType value.
 */
export type ReportProblemType = (typeof ReportProblemType)[keyof typeof ReportProblemType];

/**
 * Every report problem type, for the picklist schema.
 */
export const REPORT_PROBLEM_TYPE_VALUES = Object.values(ReportProblemType);

/**
 * Extraction verdicts of the intake envelope: whether the issue is a filter report at all.
 */
export const IntakeVerdict = {
    /**
     * The issue is a filter report; the payload carries the filled report.
     */
    FilterReport: 'filter-report',

    /**
     * The issue is not a filter report; the payload carries the reason.
     */
    NotAFilterReport: 'not-a-filter-report',
} as const;

/**
 * IntakeVerdict value.
 */
export type IntakeVerdict = (typeof IntakeVerdict)[keyof typeof IntakeVerdict];

/**
 * One reporter screenshot reference carried by the report.
 */
export const ReportScreenshotSchema = v.object({
    /**
     * The screenshot's image URL.
     */
    url: v.pipe(v.string(), v.url()),

    /**
     * The reporter's caption, when one exists.
     */
    description: v.optional(v.string()),
});

/**
 * The reporter's environment as the report declares it, copied verbatim.
 */
export const ReportEnvironmentSchema = v.object({
    /**
     * The product name, verbatim including any version or MV markers.
     */
    product: v.optional(v.string()),

    /**
     * The browser name, verbatim.
     */
    browser: v.optional(v.string()),

    /**
     * The operating system, verbatim.
     */
    os: v.optional(v.string()),

    /**
     * The product version, verbatim.
     */
    version: v.optional(v.string()),
});

/**
 * The model-filled, code-validated report extracted from one issue.
 *
 * `siteUrls` is mandatory with at least one entry: an issue without a site URL is the skip variant
 * of the extraction envelope, never an empty-array report.
 */
/**
 * The ids of the official AdGuard filter catalog the extraction prompt lists.
 */
const OFFICIAL_FILTER_IDS: ReadonlySet<number> = new Set(
    OFFICIAL_ADGUARD_FILTERS.map((filter) => filter.filterId),
);

/**
 * One enabled list as the model fills it: the name copied from the report and, when the model
 * recognises the list as one of AdGuard's own, its id from the catalog the prompt carries.
 *
 * Which reported name is which official list is the model's reading — a localized name, a name with
 * a version suffix or a settings-link id all mean the same list. Code checks only that an id it
 * returns is one the catalog has, so the structured call's repair asks again for anything else.
 */
const ReportedListSchema = v.object({
    ...ReportedFilterSchema.entries,
    officialFilterId: v.optional(
        v.pipe(
            v.number(),
            v.integer(),
            v.check(
                (filterId) => OFFICIAL_FILTER_IDS.has(filterId),
                'must be an id from the official filter catalog in the prompt; leave it out for ' +
                    'a list the catalog does not name',
            ),
        ),
    ),
});

export const ReportSchema = v.object({
    /**
     * Target URLs from the issue; at least one is required for a filter report.
     */
    siteUrls: v.pipe(v.array(v.pipe(v.string(), v.url())), v.minLength(1)),

    /**
     * The report's problem class.
     */
    problemType: v.picklist(REPORT_PROBLEM_TYPE_VALUES),

    /**
     * The form-declared type (the bot template's `### Issue URL (…)` parenthetical), copied
     * verbatim; bounded by the same 100-character ceiling the facts schema enforces.
     */
    declaredType: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(100))),

    /**
     * The reporter's description of the problem.
     */
    comment: v.optional(v.string()),

    /**
     * Reporter screenshot references; the prompt caps the count, the schema does not.
     */
    screenshots: v.array(ReportScreenshotSchema),

    /**
     * The reporter's environment, copied verbatim.
     */
    environment: ReportEnvironmentSchema,

    /**
     * Enabled filter lists, including the lists named by the settings-import link, each with its
     * official catalog id when it is one of AdGuard's own lists.
     */
    enabledLists: v.array(ReportedListSchema),

    /**
     * The settings-import link the run seeds the blocker from, when the issue carries one.
     */
    settingsImportUrl: v.optional(v.pipe(v.string(), v.url())),

    /**
     * The reporter's custom or applied rules.
     */
    userRules: v.array(v.string()),

    /**
     * Per-list blocked counts from a uBO-widget YAML block, when present.
     */
    blockedCounts: v.optional(v.record(v.string(), v.number())),

    /**
     * The reporter's reproduction steps.
     */
    reproductionSteps: v.array(v.string()),
});

/**
 * The model-filled report extracted from one issue.
 */
export type Report = v.InferOutput<typeof ReportSchema>;

/**
 * Build the extraction envelope payload schema over one report schema.
 *
 * A variant (discriminated union) on `verdict`, not a plain union: a plain union collapses the
 * failing variant's issues into one pathless message, which would break the contract that a
 * validation failure names the field. The variant keeps the nested paths (`report.siteUrls`,
 * `verdict`) in the issue list.
 *
 * @param report - The report schema the filter-report verdict carries.
 * @returns The envelope schema.
 */
export function intakeExtractionPayloadSchema<TReport extends v.GenericSchema>(report: TReport) {
    return v.variant('verdict', [
        v.object({
            /**
             * Discriminator: the issue is a filter report.
             */
            verdict: v.literal(IntakeVerdict.FilterReport),

            /**
             * The filled report.
             */
            report,
        }),
        v.object({
            /**
             * Discriminator: the issue is not a filter report.
             */
            verdict: v.literal(IntakeVerdict.NotAFilterReport),

            /**
             * Why the issue is not a filter report.
             */
            reason: v.pipe(v.string(), v.minLength(1)),
        }),
    ]);
}

/**
 * The extraction envelope payload: a filled report or an explicit skip with a reason.
 */
export const IntakeExtractionPayloadSchema = intakeExtractionPayloadSchema(ReportSchema);

/**
 * The validated extraction payload, ready for verdict dispatch.
 */
export type IntakeExtractionPayload = v.InferOutput<typeof IntakeExtractionPayloadSchema>;

/**
 * The scheme prefix a site URL may carry that the issue's own text may have omitted.
 */
const URL_SCHEME_PATTERN = /^https?:\/\//u;

/**
 * Whether a site URL was copied from the issue rather than composed by the model.
 *
 * The URL itself, or the URL without its scheme and a trailing slash, occurs in the issue text: a
 * reporter who wrote `example.com` stated the site the model returns as `https://example.com/`,
 * while a query string the model garbled — say a 1.3 KB base64 payload it could not reproduce —
 * occurs nowhere. A faithful copy occurs verbatim in its issue; a garbled one does not.
 *
 * @param url - The site URL the model returned.
 * @param issueText - The issue text the model was shown.
 * @returns Whether the issue states that URL.
 */
function siteUrlCopiedFromIssue(url: string, issueText: string): boolean {
    if (issueText.includes(url)) {
        return true;
    }
    const schemeless = url.replace(URL_SCHEME_PATTERN, '');
    const stated = schemeless.endsWith('/') ? schemeless.slice(0, -1) : schemeless;
    return stated.length > 0 && issueText.includes(stated);
}

/**
 * The report schema whose site URLs must be copied from the given issue text.
 *
 * The model's copy of a site URL is the run's whole navigation allow-list, and the model in the fix
 * loop can only ever echo the issue back — so a copy the issue does not state leaves every browser
 * launch refused. The rule is a schema check so the structured call's bounded repair asks for a
 * faithful copy before the extraction gives up.
 *
 * @param issueText - The issue text the model was shown: title, body and the trusted comments.
 * @returns The report schema bound to that issue.
 */
export function reportSchemaCopiedFrom(issueText: string) {
    return v.object({
        ...ReportSchema.entries,
        siteUrls: v.pipe(
            v.array(
                v.pipe(
                    v.string(),
                    v.url(),
                    v.check(
                        (url) => siteUrlCopiedFromIssue(url, issueText),
                        'must be copied from the issue exactly as the issue states it; ' +
                            'this value does not occur in the issue',
                    ),
                ),
            ),
            v.minLength(1),
        ),
    });
}
