/**
 * Fix-session gate wiring: the frozen fix surface, the live availability latch behind the lifecycle
 * verbs, and the adapted session-tool builder — the availability half of the fix session, split
 * from fix-session.ts so every module stays under the repo's 500-line ceiling. The surface is the
 * one place the fix tool list is declared: the fail-fast asserts every registry name at session
 * build resolves in it, and every surface name resolves in the parameter-schema maps and
 * TOOL_GUIDANCE. `select_environment` is advertising-priced rather than lifecycle-priced: a
 * multi-executor run offers it from the first turn, a sole-executor run never does.
 */
import type { ToolEnumerationBackstop } from './tool-enumeration-backstop';
import type * as v from 'valibot';
import type { ToolRegistry } from '../agent/tool-registry';
import { adaptSessionTools, type AdaptedToolInput } from '../pi/session-tools';
import {
    FIX_TOOL_GUIDANCE,
    FIX_TOOL_PARAMETER_SCHEMAS,
    TOOL_GUIDANCE,
    TOOL_PARAMETER_SCHEMAS,
} from '../agent/tool-catalog';
import {
    adaptRegistryTool,
    assertParametersMatchRegistry,
    buildSessionStubInputs,
    createDiagnosticQuarantine,
    resolveSessionSchema,
    SESSION_GATED_STUBS,
} from '../session/registry-session-tools';
import { ToolGateCause, type SessionToolSpec, type ToolGateState } from '../pi/session-tool-types';
import { ToolName } from '../agent/tool-names';
import type { ObservationSink } from './fix-session-observations';

/**
 * The frozen fix session surface: every tool a fix runtime registry can hold at any lifecycle point
 * — from-start tools (base registry, selection, policy, vision, guidance), the environment
 * lifecycle tools, and the browser-session tools — in advertisement order. Lifecycle and browser
 * tools are not in the registry before an environment is accepted; they stay advertised and refuse
 * calls with the typed gate refusals. `finish_fix` is separate (the terminal).
 */
const FIX_SESSION_SURFACE: readonly ToolName[] = [
    // From start
    ToolName.FetchIssue,
    ToolName.SelectEnvironment,
    ToolName.UpdateObservedIntent,
    ToolName.GetDetail,
    ToolName.LookupRuleGuidance,
    ToolName.ReportMissingInformation,
    ToolName.SearchRules,
    ToolName.LintRule,
    ToolName.AnalyzeScreenshot,
    ToolName.InspectFullPageCapture,
    // Environment lifecycle
    ToolName.LaunchBrowser,
    ToolName.CloseBrowser,
    // Browser session
    ToolName.OpenPage,
    ToolName.Screenshot,
    ToolName.StabilizePage,
    ToolName.GetDom,
    ToolName.InspectAdSlots,
    ToolName.GetNetworkLog,
    ToolName.GetAppliedRules,
    ToolName.GetConsoleLog,
    ToolName.InspectPageState,
    ToolName.EvaluateJs,
    ToolName.InteractPage,
    ToolName.ReportFinding,
    ToolName.ApplyRule,
];

/**
 * The gate state a not-yet-available lifecycle or browser tool is refused with.
 *
 * @param name - The tool name being refused.
 * @returns The environment-pending gate state.
 */
function environmentPendingRefusal(name: string): ToolGateState {
    return {
        cause: ToolGateCause.EnvironmentPending,
        reason: [
            `${name} needs a locked environment; this run has not accepted an environment`,
            'selection yet.',
        ].join(' '),
        remedy: [
            'Call select_environment with the observed issue type first. Use the newly exposed',
            'tools only after an accepted selection.',
        ].join(' '),
    };
}

/**
 * The gate state a browser tool is refused with once its session disappeared.
 *
 * @param name - The tool name being refused.
 * @returns The browser-closed gate state.
 */
function browserClosedRefusal(name: string): ToolGateState {
    return {
        cause: ToolGateCause.BrowserClosed,
        reason: `${name} belongs to a browser session that is no longer active.`,
        remedy: 'Start a new browser session with launch_browser before using it.',
    };
}

/**
 * Surface tools a browser session offers only when what it runs can serve them, each with the
 * refusal its absence answers. The generic refusals would be wrong for them: an active session may
 * simply not offer the tool, and relaunching the same kind of session would not offer it either.
 */
const SESSION_OPTIONAL_REFUSALS: Readonly<Partial<Record<ToolName, ToolGateState>>> = {
    [ToolName.GetAppliedRules]: {
        cause: ToolGateCause.NotOffered,
        reason: [
            'get_applied_rules exists only in a browser session whose filtering engine reports the',
            'rules it applied, and no active session does.',
        ].join(' '),
        remedy: [
            'launch_browser lists what a session offers in availableBrowserTools. When no session',
            'of this run offered get_applied_rules, the run cannot report applied rules: do not',
            'relaunch for it, and decide from get_network_log, get_console_log and list bisection.',
        ].join(' '),
    },
};

/**
 * Which refusal an unavailable surface tool answers with, decided from registry membership alone.
 */
interface FixSurfaceAvailability {
    /**
     * The availability refusal for one surface tool, or `undefined` while the registry holds it.
     *
     * @param name - A surface tool name.
     * @returns The gate state, or `undefined` when the tool is dispatchable right now.
     */
    refusalFor: (name: ToolName) => ToolGateState | undefined;
}

/**
 * Track fix-surface availability against the runtime's own registry, the only source of what exists
 * now: a name the registry holds is available, a name it does not hold is refused.
 *
 * Membership is read live, at the moment of the call, so the withdrawals the runtime performs on
 * paths of its own — a retired failed-navigation session, a disposed runtime — are covered exactly
 * like the lifecycle verbs, and the model never meets a bare "Tool not found".
 *
 * Which refusal an absent tool gets comes from one monotonic history of every name the registry has
 * ever held: never registered means the environment is still pending, registered and now gone means
 * its browser session ended. That history is a per-tool fact — deriving the cause from whether
 * `launch_browser` is registered would answer for a different tool than the one being called.
 *
 * @param registry - The runtime registry the session dispatches into.
 * @returns The availability view over that registry.
 */
function createFixSurfaceAvailability(registry: ToolRegistry): FixSurfaceAvailability {
    const everRegistered = new Set<string>();
    const readMembership = (): Set<string> => {
        const current = new Set(registry.getToolNames());
        for (const name of current) {
            everRegistered.add(name);
        }
        return current;
    };
    readMembership();
    return {
        refusalFor: (name) => {
            if (readMembership().has(name)) {
                return undefined;
            }
            const optional = SESSION_OPTIONAL_REFUSALS[name];
            if (optional !== undefined) {
                return optional;
            }
            return everRegistered.has(name)
                ? browserClosedRefusal(name)
                : environmentPendingRefusal(name);
        },
    };
}

/**
 * What building the fix session tools needs from the run's options.
 */
export interface FixSessionToolsOptions {
    /**
     * The runtime registry the session advertises from and dispatches into.
     */
    registry: ToolRegistry;

    /**
     * Whether this run is a routing check, which halts right after an accepted environment
     * selection instead of continuing into the fix work.
     */
    routingCheck: boolean;

    /**
     * Per-run model-facing description overrides the runtime composed from its own state, keyed by
     * tool name. Read before the static fix guidance, so a per-run composition wins.
     */
    descriptionOverrides?: Readonly<Record<string, string>>;

    /**
     * Per-run advertisement schemas the runtime composed from its own state, keyed by tool name.
     *
     * `launch_browser` is the one shape that is not a property of the catalog alone: whether a
     * request may carry `settings` depends on the blocker family this run prepared. The same map
     * feeds the registry drift guard, so the shape the model is shown and the shape the registry
     * records stay the same shape rather than two that happen to agree.
     */
    parameterOverrides?: Readonly<Record<string, v.GenericSchema<Record<string, unknown>>>>;

    /**
     * The run's enumeration backstop. Every tool on the surface passes its result through it, so a
     * same-tool streak is counted whatever registered the tool: a repository search, a browser
     * probe or a lifecycle call.
     */
    enumerationBackstop?: ToolEnumerationBackstop;
}

/**
 * Build the frozen fix session tools.
 *
 * A sole-executor run never advertises `select_environment`: its executor was locked at
 * construction, so the choice tool would offer a decision the model cannot make, and a routing
 * check recognizes that deterministic acceptance right away. Likewise a run whose repository
 * configured no lint command never advertises `lint_rule`: the registry decides it once, at
 * construction, and no later lifecycle step could make the tool usable.
 *
 * @param options - The registry the session dispatches into, the routing-check flag, and any
 *   per-run description overrides.
 * @param sink - The observation sink collecting dispatched results.
 * @param onSelectionAccepted - Fired when an accepted select_environment result returns (routing),
 *   or immediately for a sole-executor run whose selection was accepted at construction.
 * @returns The adapted frozen tools in surface order.
 */
export function buildFixSessionTools(
    options: FixSessionToolsOptions,
    sink: ObservationSink,
    onSelectionAccepted: () => void,
): SessionToolSpec[] {
    const { registry } = options;
    const surface = new Set<string>(FIX_SESSION_SURFACE);
    const registered = new Set(registry.getToolNames());
    for (const name of registered) {
        if (!surface.has(name)) {
            throw new Error(
                `Fix session surface is missing registry tool '${name}': add it to ` +
                    'FIX_SESSION_SURFACE or the registry definition drifts from the frozen list.',
            );
        }
    }
    // The selection tool is advertisement-priced, not lifecycle-priced: a run either chooses from
    // the start (multi-executor set) or never offers the choice (sole executor locked at
    // construction). Every other unregistered surface name waits behind the environment lock.
    const soleExecutorRun = !registered.has(ToolName.SelectEnvironment);
    const lintOffered = registered.has(ToolName.LintRule);
    if (options.routingCheck && soleExecutorRun) {
        onSelectionAccepted();
    }
    const resolveFixSchema = (name: string): v.GenericSchema<Record<string, unknown>> | undefined =>
        options.parameterOverrides?.[name] ??
        FIX_TOOL_PARAMETER_SCHEMAS[name] ??
        TOOL_PARAMETER_SCHEMAS[name];
    assertParametersMatchRegistry(registry, resolveFixSchema);
    const quarantine = createDiagnosticQuarantine();
    const availability = createFixSurfaceAvailability(registry);
    // The seeded rule-guidance stub: a registry without a guidance source never registers the
    // real tool, so the name is advertised and answers the typed NotApplicable refusal instead
    // of pi's untyped not-found error.
    const stubStates: Readonly<Record<string, ToolGateState>> = registered.has(
        ToolName.LookupRuleGuidance,
    )
        ? {}
        : { [ToolName.LookupRuleGuidance]: SESSION_GATED_STUBS[ToolName.LookupRuleGuidance] };
    const stubNames = new Set(Object.keys(stubStates));
    const inputs: AdaptedToolInput[] = FIX_SESSION_SURFACE.filter(
        (name) =>
            !stubNames.has(name) &&
            !(name === ToolName.SelectEnvironment && soleExecutorRun) &&
            !(name === ToolName.LintRule && !lintOffered),
    ).map((name) => {
        if (TOOL_GUIDANCE[name] === undefined) {
            throw new Error(`No usage guidance for fix session tool '${name}'.`);
        }
        const override = options.descriptionOverrides?.[name];
        const fixDescription = FIX_TOOL_GUIDANCE[name];
        return adaptRegistryTool(registry, quarantine, {
            name,
            parameters: resolveSessionSchema(name, resolveFixSchema),
            description: override ?? fixDescription,
            availability: () => availability.refusalFor(name),
            onResult: (redacted) => sink.collect(name, redacted),
            ...(options.enumerationBackstop === undefined
                ? {}
                : {
                      deliver: (result: Record<string, unknown>) =>
                          options.enumerationBackstop!.observe(name, result),
                  }),
            onDispatched: (result) => {
                if (
                    options.routingCheck &&
                    name === ToolName.SelectEnvironment &&
                    result['accepted'] === true
                ) {
                    onSelectionAccepted();
                }
            },
        });
    });
    inputs.push(...buildSessionStubInputs(stubStates));
    return adaptSessionTools(inputs, { guidance: TOOL_GUIDANCE });
}
