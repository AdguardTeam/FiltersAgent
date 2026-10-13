import { OFFICIAL_ADGUARD_FILTERS } from '../environment/official-filter-table';
import type { RawIssue } from '../github/fetch-issue';
import { selectPromptSafeReporterComments } from '../github/prompt-safety';
import { DEFAULT_TRUSTED_ROLES, type TrustedRole } from '../queue/queue-inputs';
import type { Logger } from '../logger/logger';
import { SingleShotResultKind, type SingleShotClient } from '../pi/single-shot-types';
import {
    createPromptDocumentLoader,
    PromptDocumentName,
    type PromptDocumentLoader,
} from '../prompts/prompt-documents';
import {
    intakeExtractionPayloadSchema,
    IntakeVerdict,
    reportSchemaCopiedFrom,
    type Report,
} from './report';

/**
 * Intake extraction outcomes: the issue becomes a report or is skipped.
 */
export const IntakeExtractionKind = {
    /**
     * The issue is a filter report; work continues with the filled report.
     */
    Report: 'report',

    /**
     * The issue is not a filter report; the run skips it with the reason.
     */
    Skipped: 'skipped',
} as const;

/**
 * IntakeExtractionKind value.
 */
export type IntakeExtractionKind = (typeof IntakeExtractionKind)[keyof typeof IntakeExtractionKind];

/**
 * The outcome of one extraction: a filled report or an explicit skip with a reason.
 */
export type IntakeExtraction =
    | {
          /**
           * Discriminator: the issue is a filter report.
           */
          kind: typeof IntakeExtractionKind.Report;

          /**
           * The model-filled, schema-validated report.
           */
          report: Report;
      }
    | {
          /**
           * Discriminator: the issue is not a filter report.
           */
          kind: typeof IntakeExtractionKind.Skipped;

          /**
           * Why the issue is not a filter report.
           */
          reason: string;
      };

/**
 * The official AdGuard filter catalog as the extraction prompt shows it, one `id: name` per line.
 */
const OFFICIAL_FILTER_CATALOG_TEXT = OFFICIAL_ADGUARD_FILTERS.map(
    (filter) => `- ${filter.filterId}: ${filter.name}`,
).join('\n');

/**
 * Options for one extraction call.
 */
export interface ExtractReportOptions {
    /**
     * The single-shot client the extraction calls (bound to a reasoning model in production).
     */
    client: SingleShotClient;

    /**
     * Prompt-document loader override; defaults to the shipped corpus.
     */
    promptLoader?: PromptDocumentLoader;

    /**
     * Diagnostics sink for the skip note and the client's failure lines.
     */
    logger?: Logger;

    /**
     * Caller cancellation for the provider call.
     */
    signal?: AbortSignal;

    /**
     * Trusted-association set counted beside the reporter's own comments; defaults to
     * `DEFAULT_TRUSTED_ROLES`. Threaded from the same resolved backlog policy `fetchIssue` and the
     * revision digest use, so a stricter caller override (e.g. `OWNER` alone) agrees across all
     * three stages instead of extraction silently falling back to the default.
     */
    trustedRoles?: readonly TrustedRole[];
}

/**
 * The default prompt loader shared by extractions that do not inject one.
 */
const DEFAULT_PROMPT_LOADER = createPromptDocumentLoader();

/**
 * Render the trusted reporter comments as one data block for the prompt.
 *
 * @param comments - The already prompt-safe reporter comments, in chronological order.
 * @returns A Markdown list of author-and-body lines, or an explicit none marker.
 */
function renderTrustedComments(comments: RawIssue['comments']): string {
    if (comments.length === 0) {
        return '(none)';
    }
    return comments.map((comment) => `- ${comment.author}: ${comment.body}`).join('\n');
}

/**
 * Extract the model-filled report from one issue through the structured single-shot mechanism.
 *
 * The trust boundary is reapplied here, on the raw issue's own comments: extraction must not rely
 * on the caller's view of the comments, because the `RawIssue` may not have come from `fetchIssue`.
 * A `not-a-filter-report` verdict ends as a skip with a log note (the no-URL criterion stated in
 * the prompt); a reply that never validates — a malformed field, or a site URL the issue does not
 * state — throws naming the failing field; a provider failure throws with the stop reason and the
 * provider message.
 *
 * @param raw - The raw, prompt-safe issue.
 * @param options - Client, prompt loader, logger and signal.
 * @returns The extraction outcome: a report or a skip with a reason.
 */
export async function extractReport(
    raw: RawIssue,
    options: ExtractReportOptions,
): Promise<IntakeExtraction> {
    const trustedComments = selectPromptSafeReporterComments(
        raw.comments,
        raw.reporterAuthor ?? '',
        // The caller's own resolved trust policy, when threaded, applied again here in case `raw`
        // did not come through `fetchIssue`'s own filtering (e.g. a snapshot-sourced issue), per
        // this module's own re-application contract above; DEFAULT_TRUSTED_ROLES otherwise, for
        // every caller that has none to thread.
        { trustedRoles: options.trustedRoles ?? DEFAULT_TRUSTED_ROLES },
    );
    const loader = options.promptLoader ?? DEFAULT_PROMPT_LOADER;
    const task = loader.render(PromptDocumentName.ExtractReportTask, {
        issueNumber: String(raw.number),
        issueUrl: raw.url,
        issueTitle: raw.title,
        issueBody: raw.body ?? '',
        trustedComments: renderTrustedComments(trustedComments),
        officialFilterCatalog: OFFICIAL_FILTER_CATALOG_TEXT,
    });
    // The site-URL rule is bound to exactly the text the model was shown — the title, the body and
    // the trusted comments — so a copy is judged against what the model could copy from.
    const issueText = [
        raw.title,
        raw.body ?? '',
        ...trustedComments.map((comment) => comment.body),
    ].join('\n');
    const result = await options.client.structured({
        messages: [{ role: 'user', text: task }],
        schema: intakeExtractionPayloadSchema(reportSchemaCopiedFrom(issueText)),
        logger: options.logger,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    if (result.kind === SingleShotResultKind.Parsed) {
        if (result.value.verdict === IntakeVerdict.FilterReport) {
            const report = result.value.report;
            // What the model made of the issue is otherwise invisible in the log: a run that
            // investigated the wrong URL, or one whose reporter screenshots never reached the
            // agent at all, could only be reconstructed from the report at the end of the run.
            options.logger?.info(
                {
                    issueNumber: raw.number,
                    siteUrlCount: report.siteUrls.length,
                    siteUrls: report.siteUrls,
                    screenshotCount: report.screenshots.length,
                    screenshotUrls: report.screenshots.map((screenshot) => screenshot.url),
                },
                'issue extracted as a filter report',
            );
            return { kind: IntakeExtractionKind.Report, report };
        }
        options.logger?.info(
            { issueNumber: raw.number, reason: result.value.reason },
            'issue skipped: not a filter report',
        );
        return { kind: IntakeExtractionKind.Skipped, reason: result.value.reason };
    }
    if (result.kind === SingleShotResultKind.InvalidResult) {
        throw new Error(`Report extraction failed schema validation: ${result.detail}`);
    }
    throw new Error(`Report extraction failed: ${result.stopReason}: ${result.message}`);
}
