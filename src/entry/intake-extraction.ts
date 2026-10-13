/**
 * The shared composition-layer intake extraction of the per-issue engines: `extractIntakeReport`
 * (the runtime wiring every post-runner tooling flow shares, `src/intake/extract-issue-facts.ts`)
 * followed by the facts projection, so a filled report maps onto the run's issue facts before the
 * outcome returns. The shared entry and other per-issue runners all consume this module, so the
 * intake composition exists exactly once for that role; consumers keep their own failure mappings
 * for skips and extraction errors.
 */

import type { RawIssue } from '../github/fetch-issue';
import { IntakeExtractionKind } from '../intake/extract-report';
import {
    extractIntakeReport,
    type ExtractIntakeReportOptions,
} from '../intake/extract-issue-facts';
import { reportToIssueFacts } from '../intake/report-facts';
import type { IssueFacts } from '../types/issue-facts';
import type { Report } from '../intake/report';

/**
 * Options of one shared composition-layer intake extraction — identical to `extractIntakeReport`'s
 * own options, since this module's whole job is the facts projection on top of it.
 */
export type IntakeExtractionOptions = ExtractIntakeReportOptions;

/**
 * The shared intake extraction's outcome: a filled report with its projected facts, or the skip
 * verdict as data for the consumer's own failure mapping.
 */
export type ExtractedIntakeFacts =
    | {
          /**
           * Discriminator: the issue is a filter report; work continues with the facts.
           */
          kind: typeof IntakeExtractionKind.Report;

          /**
           * The model-filled, schema-validated report the extraction produced.
           */
          report: Report;

          /**
           * The report's facts projected onto the raw issue's identity.
           */
          facts: IssueFacts;
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
 * Run one composition-layer intake extraction for one issue.
 *
 * A filled report maps onto the issue's facts before returning; a skip verdict returns as data. A
 * reply that never validates or a provider failure throws with the field names or the stop reason —
 * the caller owns the failure mapping.
 *
 * @param raw - The raw, prompt-safe issue.
 * @param options - LLM configuration, optional model override, logger, signal, run usage collector,
 *   and the extraction seam.
 * @returns The filled report with its facts, or the explicit skip with a reason.
 */
export async function extractIntakeFacts(
    raw: RawIssue,
    options: IntakeExtractionOptions,
): Promise<ExtractedIntakeFacts> {
    const extraction = await extractIntakeReport(raw, options);
    if (extraction.kind === IntakeExtractionKind.Skipped) {
        return { kind: IntakeExtractionKind.Skipped, reason: extraction.reason };
    }
    return {
        kind: IntakeExtractionKind.Report,
        report: extraction.report,
        facts: reportToIssueFacts(raw, extraction.report),
    };
}
