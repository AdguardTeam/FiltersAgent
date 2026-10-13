import type { RawIssue } from '../github/fetch-issue';
import type { Logger } from '../logger/logger';
import { createLogger } from '../logger/logger';
import { createConfiguredSingleShotClient, createPiRuntimeFromConfig } from '../pi/llm-wiring';
import type { LlmConfig } from '../config/config';
import { extractReport, type ExtractReportOptions, type IntakeExtraction } from './extract-report';
import { IntakeExtractionKind } from './extract-report';
import type { Report } from './report';
import type { RunUsageCollector } from '../pi/usage-collector';
import type { TrustedRole } from '../queue/queue-inputs';

/**
 * The production extraction callable its options can replace in tests.
 */
export type ExtractReport = typeof extractReport;

/**
 * Options for one wired intake extraction.
 */
export interface ExtractIntakeReportOptions {
    /**
     * Validated LLM provider configuration the extraction's single-shot client is built from.
     */
    llm: LlmConfig;

    /**
     * Optional reasoning-model override; defaults to the configured model.
     */
    model?: string;

    /**
     * Diagnostics sink forwarded to the extraction and the client.
     */
    logger?: Logger;

    /**
     * Caller cancellation for the provider call.
     */
    signal?: ExtractReportOptions['signal'];

    /**
     * Token usage the extraction's requests generate, metered into the caller's own run collector
     * when one is threaded (the run's extraction and investigation share one summary).
     */
    usageCollector?: RunUsageCollector;

    /**
     * Scripted extraction seam; tests replace the model extraction here, production leaves it unset
     * for the real one.
     */
    extractReport?: ExtractReport;

    /**
     * Trusted-association set forwarded to the extraction; defaults to `DEFAULT_TRUSTED_ROLES` when
     * absent. Threaded from the same resolved backlog policy fetching and the revision digest use.
     */
    trustedRoles?: readonly TrustedRole[];
}

/**
 * Run one intake extraction with a client built for the request.
 *
 * This is the runtime wiring every post-runner tooling flow shares: a pi runtime and single-shot
 * client created from the same configuration the runs use, driving one `extractReport` call. The
 * skip verdict arrives as data (`IntakeExtractionKind.Skipped`); a reply that never validates or a
 * provider failure throws with the field names or the stop reason.
 *
 * @param raw - The raw, prompt-safe issue.
 * @param options - LLM configuration, optional model override, logger, signal, run usage collector,
 *   and the scripted extraction seam.
 * @returns The extraction outcome: a filled report or an explicit skip with a reason.
 */
export async function extractIntakeReport(
    raw: RawIssue,
    options: ExtractIntakeReportOptions,
): Promise<IntakeExtraction> {
    const runtime = await createPiRuntimeFromConfig(options.llm, options.model);
    const client = createConfiguredSingleShotClient(runtime, runtime.reasoningModel, options.llm, {
        logger: options.logger ?? createLogger({ verbose: false }),
        ...(options.usageCollector !== undefined ? { usageCollector: options.usageCollector } : {}),
    });
    const extract = options.extractReport ?? extractReport;
    return await extract(raw, {
        client,
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.trustedRoles !== undefined ? { trustedRoles: options.trustedRoles } : {}),
    });
}

/**
 * Bind the intake extraction seam post-runner tooling consumes.
 *
 * The seam answers "what did the model read in this issue" as a filled report, or null when the
 * extraction skipped the issue; call sites map the report onto facts with `reportToIssueFacts`.
 * Every runtime consumer binds once per LLM configuration instead of re-deriving the verdict from
 * the issue body.
 *
 * @param llm - Validated LLM provider configuration for the extraction.
 * @param model - Optional reasoning-model override.
 * @returns The bound extraction seam.
 */
export function bindExtractReport(
    llm: LlmConfig,
    model?: string,
): (raw: RawIssue) => Promise<Report | null> {
    return async (raw) => {
        const extraction = await extractIntakeReport(raw, {
            llm,
            ...(model !== undefined ? { model } : {}),
        });
        return extraction.kind === IntakeExtractionKind.Report ? extraction.report : null;
    };
}
