/**
 * Registry session wiring: adapt one ToolRegistry surface to a frozen pi session tool set —
 * advertisement schemas looked up from TOOL_PARAMETER_SCHEMAS (and checked against the registry
 * definitions the session dispatches into), dispatch through ToolRegistry.dispatch, the shared
 * diagnostic quarantine (evaluate_js policy rejections and inspect_full_page_capture incomplete
 * captures), the gate-refusing stubs of the widened surface (deduped against names the registry
 * already registers), and the retry default. Shared so analyze and replay wire identical semantics
 * instead of copies; the fix-mode twin lives at `orchestrator/fix-session-gates.ts` (the
 * gate-refusing stubs of the universal system.md surface are runner-owned steps, also shared by
 * fix's frozen list).
 */
import type * as v from 'valibot';
import type { RegistrationGuard, ToolRegistry } from '../agent/tool-registry';
import type { TraceRecorder } from '../tracer/trace-recorder';
import { withExecutionRecording } from '../tracer/session-trace';
import type { AdaptedToolInput } from '../pi/session-tools';
import { adaptSessionTools, toolGatedRefusal } from '../pi/session-tools';
import { toAdvertisedSchema } from '../pi/tool-schema';
import { ToolGateCause, type SessionToolSpec, type ToolGateState } from '../pi/session-tool-types';
import { ToolName } from '../agent/tool-names';
import { TOOL_GUIDANCE, TOOL_PARAMETER_SCHEMAS } from '../agent/tool-catalog';
import { EVALUATE_JS_POLICY_REJECTION_KIND } from '../browser/browser-tools';
import { FULL_PAGE_CAPTURE_INCOMPLETE_KIND } from '../analyzer/full-page-capture-inspection';

/**
 * Read-only diagnostic failures tolerated for one tool before it is quarantined for the rest of the
 * run.
 */
const DIAGNOSTIC_QUARANTINE_BUDGET = 3;

/**
 * One diagnostic-quarantine rule: the tool name and the failure `errorKind` the policy matches.
 */
export interface DiagnosticQuarantineRule {
    /**
     * Tool the rule applies to. Typed as the canonical vocabulary rather than a bare string: a
     * misspelled name here matches no dispatch and would silently disable the quarantine.
     */
    tool: ToolName;

    /**
     * Failure kind (`result.errorKind`) that counts toward the quarantine budget.
     */
    errorKind: string;
}

/**
 * The default diagnostic set: evaluate_js read-only policy rejections and inspect_full_page_capture
 * incomplete captures — the exact tool/failure pairs, counted per tool, 3 since last success before
 * the `Quarantined` gate.
 */
export const LEGACY_DIAGNOSTIC_RULES: readonly DiagnosticQuarantineRule[] = [
    { tool: ToolName.EvaluateJs, errorKind: EVALUATE_JS_POLICY_REJECTION_KIND },
    { tool: ToolName.InspectFullPageCapture, errorKind: FULL_PAGE_CAPTURE_INCOMPLETE_KIND },
];

/**
 * Resolve the advertisement schema one session surface uses for a registry tool name. Fix mode
 * layers its frozen shapes over the catalog; every other surface reads the catalog alone.
 */
export type SessionSchemaResolver = (
    name: string,
) => v.GenericSchema<Record<string, unknown>> | undefined;

/**
 * Fail fast when a catalog schema advertises different parameters than the registry definition the
 * session dispatches into.
 *
 * The runtime shapes some definitions at registration (the agentic fix path re-registers
 * analyze_screenshot with `issueScreenshotIndex`), and the session advertises the catalog schema
 * instead. A silent disagreement is not a startup error but an unwinnable run: the model cannot
 * pass a parameter the advertisement omits, so a host gate demanding it rejects every terminal
 * submission until the budget seals the run. Every surface runs the check — the drift is a property
 * of the catalog/registry pair, not of one mode.
 *
 * The sweep alone would only cover what the registry already holds at session build. The lifecycle
 * and browser tools are registered later and would never be compared, so the same check stays armed
 * on the registry: a late registration that drifts throws where the drift is introduced.
 *
 * @param registry - The runtime registry the session dispatches into.
 * @param resolveSchema - The surface's advertisement schema lookup; defaults to the catalog.
 */
export function assertParametersMatchRegistry(
    registry: ToolRegistry,
    resolveSchema: SessionSchemaResolver = (name) => TOOL_PARAMETER_SCHEMAS[name],
): void {
    const guard: RegistrationGuard = (tool) => {
        const schema = resolveSchema(tool.name);
        if (schema === undefined) {
            return;
        }
        const advertised = Object.keys(
            (tool.parameters.properties ?? {}) as Record<string, unknown>,
        );
        const declared = new Set(Object.keys(advertisedProperties(schema)));
        const missing = advertised.filter((property) => !declared.has(property));
        if (missing.length > 0) {
            throw new Error(
                `Session schema for '${tool.name}' omits registry parameter(s) ` +
                    `${missing.join(', ')}: the model could never pass them. Update the catalog ` +
                    'schema to match.',
            );
        }
    };
    for (const tool of registry.getRegisteredTools()) {
        guard(tool);
    }
    registry.setRegistrationGuard(guard);
}

/**
 * Read the property names a session schema actually advertises.
 *
 * The projection the session advertises is what the comparison must read: a schema's own Valibot
 * internals are private and shaped differently per schema kind (`v.pipe(v.object(...))` carries no
 * top-level entries at all), so reading them made a wrapped object schema look like it declared
 * nothing and failed the check for every registered parameter.
 *
 * @param schema - The advertisement schema for one tool.
 * @returns The advertised property names, empty when the schema advertises no object.
 */
function advertisedProperties(
    schema: v.GenericSchema<Record<string, unknown>>,
): Record<string, unknown> {
    const properties = toAdvertisedSchema(schema)['properties'];
    return typeof properties === 'object' && properties !== null
        ? (properties as Record<string, unknown>)
        : {};
}

/**
 * Resolve one session tool's advertisement schema, failing fast and naming the tool when the
 * surface advertises a name no schema map covers — a run whose model cannot see a tool's parameters
 * is unwinnable, so it must never start.
 *
 * @param name - The tool name being advertised.
 * @param resolveSchema - The surface's advertisement schema lookup.
 * @returns The advertisement schema.
 */
export function resolveSessionSchema(
    name: string,
    resolveSchema: SessionSchemaResolver,
): v.GenericSchema<Record<string, unknown>> {
    const parameters = resolveSchema(name);
    if (parameters === undefined) {
        throw new Error(
            `No parameter schema for session tool '${name}': add it to TOOL_PARAMETER_SCHEMAS.`,
        );
    }
    return parameters;
}

/**
 * What one registry-backed session tool needs beyond the registry and the run's quarantine.
 */
export interface RegistryToolAdaptation {
    /**
     * The registry name the session advertises and dispatches.
     */
    name: string;

    /**
     * The advertisement schema for that name.
     */
    parameters: v.GenericSchema<Record<string, unknown>>;

    /**
     * Model-facing description for this surface only, for a tool whose registered shape differs
     * from the shared one (the fix runtime's reporter-aware analyze_screenshot). Left unset, the
     * tool keeps its `TOOL_GUIDANCE` text.
     */
    description?: string;

    /**
     * Extra availability check for this tool, consulted only after the quarantine has declined to
     * refuse. The order is the rule: the quarantine is a run-lifetime decision about the tool
     * itself, so a relaunch that restores a tool's browser session must not restore the budget the
     * model already spent on three rejected diagnostics.
     */
    availability?: () => ToolGateState | undefined;

    /**
     * Observer of the redacted result the model receives, for a caller that keeps the delivered
     * frontier (the agentic fix run's observation sink).
     */
    onResult?: (redacted: Record<string, unknown>) => void;

    /**
     * Observer of one executed dispatch result, after the quarantine has seen it.
     */
    onDispatched?: (result: Record<string, unknown>) => void;

    /**
     * Last word on the result the model receives, after the quarantine and the dispatch observer
     * have seen the executed one: the fix surface's enumeration backstop adds its notice here.
     */
    deliver?: (result: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Adapt one registry name to a pi session tool input: the gate order, the dispatch closure, and the
 * quarantine bookkeeping every registry-backed surface shares.
 *
 * @param registry - The registry the session dispatches into.
 * @param quarantine - The run's diagnostic quarantine.
 * @param adaptation - The tool's name, advertisement schema, and optional observers.
 * @returns The adapted tool input.
 */
export function adaptRegistryTool(
    registry: ToolRegistry,
    quarantine: DiagnosticQuarantine,
    adaptation: RegistryToolAdaptation,
): AdaptedToolInput {
    const { name } = adaptation;
    return {
        name,
        parameters: adaptation.parameters,
        ...(adaptation.description === undefined ? {} : { description: adaptation.description }),
        gate: () => quarantine.refusalFor(name) ?? adaptation.availability?.(),
        ...(adaptation.onResult === undefined ? {} : { onResult: adaptation.onResult }),
        execute: async (args) => {
            const result = await registry.dispatch(name, args);
            quarantine.observe(name, result);
            adaptation.onDispatched?.(result);
            return adaptation.deliver === undefined ? result : adaptation.deliver(result);
        },
    };
}

/**
 * Adapt the session surface of a ToolRegistry to pi session tools: the catalog-versus-registry
 * parameter check, schema lookup with fail-fast naming the missing tool, dispatch closures, the
 * evaluate_js diagnostic quarantine, the gate-refusing stubs of the widened surface (appended in
 * key order, minus any name the registry already registered — a configured guidance source makes
 * lookup_rule_guidance a real tool and filters its stub), and per-execution trace recording.
 *
 * @param registry - The mode's registry from createToolRegistry.
 * @param recorder - The run trace recorder.
 * @param stubStates - The gate-refusing stubs to append; defaults to SESSION_GATED_STUBS.
 * @returns The adapted session tools, in advertisement order.
 */
export function buildRegistrySessionTools(
    registry: ToolRegistry,
    recorder: TraceRecorder,
    stubStates: Readonly<Record<string, ToolGateState>> = SESSION_GATED_STUBS,
): SessionToolSpec[] {
    assertParametersMatchRegistry(registry);
    const quarantine = createDiagnosticQuarantine();
    const registered = new Set(registry.getToolNames());
    const inputs: AdaptedToolInput[] = registry.getToolNames().map((name) =>
        adaptRegistryTool(registry, quarantine, {
            name,
            parameters: resolveSessionSchema(name, (lookup) => TOOL_PARAMETER_SCHEMAS[lookup]),
        }),
    );
    // The mandated-but-inapplicable steps of the widened surface: advertised, never executing.
    // Appended AFTER the registry tools in the stub states' key order; a name the registry already
    // registered (e.g. a real lookup_rule_guidance from a configured guidance source) wins over
    // its stub because adaptSessionTools throws on duplicate names. Each stub's gate callback
    // answers its fixed state, so the refusal is in force before the first request.
    const stubStatesForMode = Object.fromEntries(
        Object.entries(stubStates).filter(([name]) => !registered.has(name)),
    );
    inputs.push(...buildSessionStubInputs(stubStatesForMode));
    return adaptSessionTools(inputs, { guidance: TOOL_GUIDANCE }).map((spec) =>
        withExecutionRecording(spec, recorder),
    );
}

/**
 * The diagnostic quarantine: the latch the dispatch closures report results to, and the refusal it
 * answers for a tool it has disabled.
 */
export interface DiagnosticQuarantine {
    /**
     * Observe one executed tool result for the quarantine policy.
     *
     * @param tool - The tool name that produced the result.
     * @param result - The tool's model-facing result record.
     */
    observe: (tool: string, result: Record<string, unknown>) => void;

    /**
     * The quarantine refusal a tool answers with, or `undefined` while it is not quarantined.
     *
     * @param tool - The tool name being called.
     * @returns The `Quarantined` gate state, or `undefined`.
     */
    refusalFor: (tool: string) => ToolGateState | undefined;
}

/**
 * The gate state a quarantined diagnostic tool answers every later call with.
 *
 * @param tool - The quarantined tool name.
 * @returns The `Quarantined` gate state.
 */
function quarantineRefusal(tool: string): ToolGateState {
    return {
        cause: ToolGateCause.Quarantined,
        reason: [
            `${tool} is disabled for the remainder of this run after`,
            `${DIAGNOSTIC_QUARANTINE_BUDGET} read-only policy rejections since its last`,
            'success.',
        ].join(' '),
        remedy: [
            'Continue with the typed DOM, HAR, screenshot, and vision evidence already',
            'collected. Do not retry the disabled tool and do not classify this as',
            'browser unavailability. Continue to candidate validation when the evidence',
            'supports it.',
        ].join(' '),
    };
}

/**
 * The diagnostic-quarantine policy: after three matching failures since the tool's last success the
 * tool is disabled for the rest of the run, with a notice as the gate reason/remedy. Failure kinds
 * and counters are per tool: quarantining evaluate_js never resets or disables
 * inspect_full_page_capture. Other failures neither count nor reset, and there is deliberately no
 * run-ending per-tool failure budget — the run is bounded by maxTurns and request timeouts
 * instead.
 *
 * The latch belongs to the quarantine alone, so "for the remainder of this run" is literal: a
 * browser relaunch that re-registers evaluate_js re-establishes availability, not the budget the
 * model already spent on three rejected diagnostics.
 *
 * @param diagnostics - The rule set to match; defaults to the evaluate_js/capture diagnostic pair.
 * @returns The quarantine latch.
 */
export function createDiagnosticQuarantine(
    diagnostics: readonly DiagnosticQuarantineRule[] = LEGACY_DIAGNOSTIC_RULES,
): DiagnosticQuarantine {
    const countsByTool = new Map<string, number>();
    const quarantined = new Map<string, ToolGateState>();
    return {
        observe: (tool, result) => {
            const rule = diagnostics.find((entry) => entry.tool === tool);
            if (rule === undefined || quarantined.has(tool)) {
                return;
            }
            const failuresSinceSuccess = countsByTool.get(tool) ?? 0;
            if (result['errorKind'] === rule.errorKind) {
                if (failuresSinceSuccess + 1 < DIAGNOSTIC_QUARANTINE_BUDGET) {
                    countsByTool.set(tool, failuresSinceSuccess + 1);
                    return;
                }
                countsByTool.delete(tool);
                quarantined.set(tool, quarantineRefusal(tool));
                return;
            }
            if (result['error'] === undefined) {
                countsByTool.delete(tool);
            }
        },
        refusalFor: (tool) => quarantined.get(tool),
    };
}

/**
 * Gate-refusing stubs of the widened session surface: the fixed gate state (cause, reason, remedy)
 * for the steps the universal system.md mandates but the session runner owns instead or forbids for
 * one mode, plus the factory that advertises them as adapted session tools. A stub never executes
 * real behavior: its gate callback answers the same state for the session's whole life, so every
 * call returns the typed tool_gated refusal naming why the step is runner-owned and what to do
 * first — the document's "read that refusal and adapt" contract. The cause is always
 * ToolGateCause.NotApplicable: the tool is not merely currently unavailable, it can never become
 * usable in this mode's run.
 */

/**
 * Build the stub adapted inputs, appended after the registry-derived tools in `states` key order.
 * The defensive execute never runs (the gate callback refuses first); it returns the identical
 * typed refusal so a wiring mistake can never degrade into a silent no-op or an untyped pi error.
 *
 * @param states - The gate-refusing stub states of the mode.
 * @returns The stub session-tool inputs.
 */
export function buildSessionStubInputs(
    states: Readonly<Record<string, ToolGateState>>,
): AdaptedToolInput[] {
    return Object.entries(states).map(([name, stub]) => ({
        name,
        parameters: resolveSessionSchema(name, (lookup) => TOOL_PARAMETER_SCHEMAS[lookup]),
        gate: () => stub,
        execute: async () => toolGatedRefusal(name, stub),
    }));
}

/**
 * The four shared gate-refusing stubs, keyed by tool name in advertisement order: the steps every
 * registry session mode's runner owns (environment and browser session are established in code
 * before the session; there is no rule-guidance session unless the registry registered a real tool;
 * captures are read per artifact).
 */
export const SESSION_GATED_STUBS: Readonly<Record<string, ToolGateState>> = {
    [ToolName.SelectEnvironment]: {
        cause: ToolGateCause.NotApplicable,
        reason:
            'this mode locks the environment before the session from the fetched issue; ' +
            'there is nothing for the model to select',
        remedy:
            "Adopt the runner-locked environment and continue with the repository's policy and " +
            'the evidence tools. Do not call select_environment.',
    },
    [ToolName.LookupRuleGuidance]: {
        cause: ToolGateCause.NotApplicable,
        reason:
            'this run has no rule-guidance session; the policy and knowledge it works from are ' +
            'stated in the task document',
        remedy:
            'Proceed to candidate work using the documented policy and knowledge. Do not call ' +
            'lookup_rule_guidance.',
    },
    [ToolName.LaunchBrowser]: {
        cause: ToolGateCause.NotApplicable,
        reason:
            'this mode owns the browser session: it launches the browser before the run when ' +
            'live evidence is possible, and a reasoning-only run has no browser at all',
        remedy:
            'Use open_page and the advertised browser tools on the already-running session. If ' +
            'there is no live session, base the result on the fetched issue and policy ' +
            'evidence. Do not call launch_browser.',
    },
    [ToolName.InspectFullPageCapture]: {
        cause: ToolGateCause.NotApplicable,
        reason:
            'this mode inspects captures per artifact through analyze_screenshot and get_detail; ' +
            'there is no full-page tile inventory in this mode',
        remedy:
            'Call analyze_screenshot on the registered capture and get_detail for bounded ' +
            'slices. Do not call inspect_full_page_capture.',
    },
};
