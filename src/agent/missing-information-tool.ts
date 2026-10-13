/**
 * Registration of the fix-only `report_missing_information` tool: what the model calls to record a
 * gap in the run instruction. The tool belongs to the fix runtime's registry — not the shared tool
 * factory — like every other fix-only name, because the factory's registry also feeds the analyze,
 * replay, and observation-only surfaces, whose session schema maps declare only catalog shapes.
 */
import * as v from 'valibot';
import type { ToolRegistry } from './tool-registry';
import { ToolName } from './tool-names';
import { registeredParameters } from './registered-parameters';
import {
    MAX_MISSING_INFORMATION_DETAIL_CHARACTERS,
    MAX_MISSING_INFORMATION_SUBJECT_CHARACTERS,
    MissingInformationEntrySchema,
    type MissingInformationEntry,
} from '../types/missing-information';

/**
 * Register the missing-information tool on one registry.
 *
 * Deliberately outside the pre-candidate gated set: recording a gap must never be refused for want
 * of a prior lookup_rule_guidance call. The handler only validates and echoes the bound entry; the
 * observation sink the fix session attaches is what carries the entry into the run result.
 *
 * @param registry - The fix runtime's registry the tool dispatches from.
 */
export function registerReportMissingInformationTool(registry: ToolRegistry): void {
    registry.register({
        definition: {
            type: 'function',
            function: {
                name: ToolName.ReportMissingInformation,
                description:
                    'Record exactly what the run instruction lacks: a needed document, section, or ' +
                    'fact. The bounded subject names the gap and the bounded detail describes it.',
                parameters: registeredParameters(ToolName.ReportMissingInformation),
            },
        },
        handler: async (args) => {
            const parsed = v.safeParse(MissingInformationEntrySchema, args);
            if (!parsed.success) {
                return {
                    error:
                        `report_missing_information: invalid arguments (${parsed.issues
                            .map((issue) => issue.message)
                            .join('; ')}) — subject accepts at most ` +
                        `${MAX_MISSING_INFORMATION_SUBJECT_CHARACTERS} characters and detail at ` +
                        `most ${MAX_MISSING_INFORMATION_DETAIL_CHARACTERS}.`,
                };
            }
            return parsed.output satisfies MissingInformationEntry as Record<string, unknown>;
        },
    });
}
