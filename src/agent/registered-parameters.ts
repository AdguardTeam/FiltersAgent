/**
 * The one derivation of a registration's JSON `parameters` from the shared tool catalog. Every
 * registry registration — the factory's own tools and the ones the standalone tool modules build —
 * reads its parameters here, so the catalog stays the single place a tool's arguments are
 * declared.
 */
import type * as v from 'valibot';
import { FIX_TOOL_PARAMETER_SCHEMAS, TOOL_PARAMETER_SCHEMAS } from './tool-catalog';
import { ToolName } from './tool-names';
import { toAdvertisedSchema } from '../pi/tool-schema';

/**
 * Tools whose registered shape here is not the one the shared catalog entry declares.
 *
 * Two reasons put a name here, and {@link FIX_TOOL_PARAMETER_SCHEMAS} answers both, so it is reused
 * rather than restated as a third copy of the shape.
 *
 * `lookup_rule_guidance` and `select_environment` have a {@link TOOL_PARAMETER_SCHEMAS} entry, but
 * it is the WIDENED stub shape for the sessions that never register the tool — every property
 * optional, so a call reaches the gate refusal instead of bouncing at validation. These
 * registrations are the real tools and require what the runtime requires. `launch_browser` has the
 * same widened stub entry but no override here: its registered shape is per-run (a Firefox-family
 * run's request takes no `settings`), so the runtime hands the registration its own advertisement
 * instead of looking one up.
 *
 * `update_observed_intent`, `close_browser` and `report_missing_information` are fix-only names
 * with no {@link TOOL_PARAMETER_SCHEMAS} entry at all. The preparation names `run_command` and
 * `write_file` have every entry committed in the shared catalog (strict — there is no widened stub
 * for them), and their overrides pin exactly the same schemas, following the fix-preparation
 * convention that a registry registration reads its shape from {@link FIX_TOOL_PARAMETER_SCHEMAS}
 * by way of this map.
 */
export const REGISTERED_SHAPE_OVERRIDES: Readonly<
    Partial<Record<ToolName, v.GenericSchema<Record<string, unknown>>>>
> = {
    [ToolName.LookupRuleGuidance]: FIX_TOOL_PARAMETER_SCHEMAS[ToolName.LookupRuleGuidance],
    [ToolName.SelectEnvironment]: FIX_TOOL_PARAMETER_SCHEMAS[ToolName.SelectEnvironment],
    [ToolName.UpdateObservedIntent]: FIX_TOOL_PARAMETER_SCHEMAS[ToolName.UpdateObservedIntent],
    [ToolName.RunCommand]: FIX_TOOL_PARAMETER_SCHEMAS[ToolName.RunCommand],
    [ToolName.WriteFile]: FIX_TOOL_PARAMETER_SCHEMAS[ToolName.WriteFile],
    [ToolName.CloseBrowser]: FIX_TOOL_PARAMETER_SCHEMAS[ToolName.CloseBrowser],
    [ToolName.ReportMissingInformation]:
        FIX_TOOL_PARAMETER_SCHEMAS[ToolName.ReportMissingInformation],
};

/**
 * Derive the JSON Schema a registration records for its parameters from that tool's catalog schema.
 *
 * The registry's `parameters` is never advertised to a model — the session adapters build the
 * advertisement from the catalog itself — so its only reader is the drift check, whose whole job is
 * to prove that the registered shape and the advertised one agree. Deriving both from one schema
 * makes them agree by construction instead of by review, and leaves the catalog the single place a
 * tool's parameters are declared.
 *
 * @param name - The tool being registered.
 * @returns The JSON Schema recorded as that tool's registered parameters.
 * @throws When no catalog schema is declared for the name — a missing catalog entry, not something
 *   a run can recover from.
 */
export function registeredParameters(name: ToolName): Record<string, unknown> {
    const schema = REGISTERED_SHAPE_OVERRIDES[name] ?? TOOL_PARAMETER_SCHEMAS[name];
    if (schema === undefined) {
        throw new Error(`No catalog parameter schema is declared for tool ${name}.`);
    }
    return toAdvertisedSchema(schema);
}
