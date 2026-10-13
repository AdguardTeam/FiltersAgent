/**
 * The missing-information harvest: the post-seal read over the delivered-frontier observations that
 * turns the run's recorded gaps into the capped `FixRunResult.missingInformation` block.
 *
 * Two channels carry the same record shape, in role: the model-owned `report_missing_information`
 * tool result — the primary channel for agent-discovered gaps — and the deterministic not-linked
 * guidance notice, whose tool result embeds the subject/detail the run harvests even when the model
 * never calls the tool.
 */
import * as v from 'valibot';
import type { Logger } from 'pino';
import type { AgentObservation } from '../types/agent-run-artifacts';
import { ToolName } from '../agent/tool-names';
import { RuleGuidanceNotice } from '../knowledge/instruction-serving';
import {
    MAX_MISSING_INFORMATION_ENTRIES,
    MissingInformationEntrySchema,
    type MissingInformationEntry,
} from '../types/missing-information';

/**
 * The harvest a run's observations yielded.
 */
export interface MissingInformationHarvest {
    /**
     * Capped, deduplicated missing-information records in dispatch order.
     */
    entries: MissingInformationEntry[];

    /**
     * How many distinct records the report ceiling dropped; the observations and trace keep them.
     */
    droppedCount: number;
}

/**
 * Read one missing-information record out of a tool result when the record carries one.
 *
 * @param result - The redacted structured tool result.
 * @returns The validated entry, or undefined when the result carries no well-formed record.
 */
function entryFromReportResult(
    result: Record<string, unknown>,
): MissingInformationEntry | undefined {
    const parsed = v.safeParse(MissingInformationEntrySchema, {
        subject: result.subject,
        detail: result.detail,
    });
    return parsed.success ? parsed.output : undefined;
}

/**
 * Read the missing-information record out of one nested tool-result field.
 *
 * @param record - The candidate nested record.
 * @returns The validated entry, or undefined when the value is not a well-formed record.
 */
function entryFromNestedRecord(record: unknown): MissingInformationEntry | undefined {
    if (typeof record !== 'object' || record === null) {
        return undefined;
    }
    const fields = record as Record<string, unknown>;
    const parsed = v.safeParse(MissingInformationEntrySchema, {
        subject: fields.subject,
        detail: fields.detail,
    });
    return parsed.success ? parsed.output : undefined;
}

/**
 * Read the missing-information record a not-linked guidance notice carries.
 *
 * @param result - The redacted structured tool result.
 * @returns The validated entry when the result is a signed not-linked notice carrying one.
 */
function entryFromGuidanceNotice(
    result: Record<string, unknown>,
): MissingInformationEntry | undefined {
    if (result.notice !== RuleGuidanceNotice.NotLinked) {
        return undefined;
    }
    return entryFromNestedRecord(result.missingInformation);
}

/**
 * Collect the run's recorded missing-information records from the delivered observations.
 *
 * The collection parses both channels, keeps the first of identical subjects in dispatch order, and
 * caps the list at the report ceiling, counting what the ceiling dropped — the observations keep
 * every record, so the dropped count is a report-sizing fact, not lost evidence.
 *
 * @param observations - The delivered-frontier observations the seal drained.
 * @returns The capped, deduplicated harvest.
 */
export function collectMissingInformation(
    observations: readonly AgentObservation[],
): MissingInformationHarvest {
    const entries: MissingInformationEntry[] = [];
    const seenSubjects = new Set<string>();
    for (const observation of observations) {
        let entry: MissingInformationEntry | undefined;
        if (observation.tool === ToolName.ReportMissingInformation) {
            entry = entryFromReportResult(observation.result);
        } else if (observation.tool === ToolName.LookupRuleGuidance) {
            entry = entryFromGuidanceNotice(observation.result);
        }
        if (!entry || seenSubjects.has(entry.subject)) {
            continue;
        }
        seenSubjects.add(entry.subject);
        entries.push(entry);
    }
    if (entries.length <= MAX_MISSING_INFORMATION_ENTRIES) {
        return { entries, droppedCount: 0 };
    }
    return {
        entries: entries.slice(0, MAX_MISSING_INFORMATION_ENTRIES),
        droppedCount: entries.length - MAX_MISSING_INFORMATION_ENTRIES,
    };
}

/**
 * Log one harvest with the session pino logger: every entry at info level with rich context, and
 * the dropped count beside it so a report that shrank names the shrink.
 *
 * @param logger - The session pino logger.
 * @param harvest - The collected missing-information harvest.
 */
export function logMissingInformation(logger: Logger, harvest: MissingInformationHarvest): void {
    for (const entry of harvest.entries) {
        logger.info(
            {
                subject: entry.subject,
                detail: entry.detail,
            },
            'missing information recorded',
        );
    }
    if (harvest.droppedCount > 0) {
        logger.warn(
            {
                droppedCount: harvest.droppedCount,
                reportCeiling: MAX_MISSING_INFORMATION_ENTRIES,
            },
            'missing information records dropped at the report ceiling',
        );
    }
}
