import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../src/agent/tool-registry';
import { ToolName } from '../../src/agent/tool-names';
import { registerReportMissingInformationTool } from '../../src/agent/missing-information-tool';
import { FIX_TOOL_PARAMETER_SCHEMAS } from '../../src/agent/tool-catalog';
import { toAdvertisedSchema } from '../../src/pi/tool-schema';

/**
 * The missing-information entry the echo tests round-trip.
 */
const VALID_ENTRY = {
    subject: 'No syntax document is linked for rule guidance topic element_hiding',
    detail:
        'The run instruction links only a policy document, so the element-hiding guidance ' +
        'cannot be served.',
};

describe('registerReportMissingInformationTool', () => {
    it('registers the tool with the parameters its fix session advertises', () => {
        const registry = new ToolRegistry();
        registerReportMissingInformationTool(registry);

        const definition = registry
            .getDefinitions()
            .find((candidate) => candidate.function.name === ToolName.ReportMissingInformation);
        expect(definition).toBeDefined();
        expect(definition?.function.parameters).toEqual(
            toAdvertisedSchema(
                FIX_TOOL_PARAMETER_SCHEMAS[ToolName.ReportMissingInformation]!,
                ToolName.ReportMissingInformation,
            ),
        );
    });

    it('echoes the validated entry to the dispatching caller', async () => {
        const registry = new ToolRegistry();
        registerReportMissingInformationTool(registry);

        await expect(
            registry.dispatch(ToolName.ReportMissingInformation, VALID_ENTRY),
        ).resolves.toEqual(VALID_ENTRY);
    });

    it('records an entry reported before any guidance lookup', async () => {
        const registry = new ToolRegistry();
        registerReportMissingInformationTool(registry);

        await expect(
            registry.dispatch(ToolName.ReportMissingInformation, {
                subject: 'The instruction lacks a contributing guide link',
                detail: 'The run cannot state where placement rules belong without it.',
            }),
        ).resolves.toEqual({
            subject: 'The instruction lacks a contributing guide link',
            detail: 'The run cannot state where placement rules belong without it.',
        });
    });

    it('answers the typed invalid-arguments error for an over-bounded entry', async () => {
        const registry = new ToolRegistry();
        registerReportMissingInformationTool(registry);

        const result = await registry.dispatch(ToolName.ReportMissingInformation, {
            subject: 's'.repeat(201),
            detail: VALID_ENTRY.detail,
        });
        expect(result).toMatchObject({ error: expect.stringMatching(/invalid arguments/) });
    });

    it('registers exactly the missing-information tool and nothing else', () => {
        const registry = new ToolRegistry();
        registerReportMissingInformationTool(registry);

        expect(registry.getToolNames()).toEqual([ToolName.ReportMissingInformation]);
    });
});
