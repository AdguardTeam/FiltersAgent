/**
 * The environment-selection model tools: locking exactly one filtering executor for the run when
 * the run's executor set offers a choice, and refining the observed issue type afterwards without
 * disturbing that lock.
 *
 * They register through `EnvironmentSelectionToolsHost` rather than against the runtime class, so
 * the dispatch through the chosen registration's activation can be exercised against a constructed
 * host with fake registrations. The executor set itself is the run's resolved registrations: the
 * description composes their `selectionGuidance`, and an accepted non-reserved selection dispatches
 * through that registration's `activate` — no executor-specific branch lives here.
 *
 * Both tools read their JSON parameters from the shared catalog through `registeredParameters`,
 * which reaches their strict `FIX_TOOL_PARAMETER_SCHEMAS` shapes through
 * `REGISTERED_SHAPE_OVERRIDES` — `update_observed_intent` has no `TOOL_PARAMETER_SCHEMAS` entry,
 * and `select_environment`'s entry there is the widened gate stub whose every property is optional.
 * Nothing advertises the registry `parameters` (the session adapter advertises the catalog schema
 * itself and the drift guard is its only reader), so deriving both from one schema makes them agree
 * by construction.
 */
import {
    EnvironmentLimitationCode,
    EnvironmentSelectionReservedCase,
    EnvironmentSelectionState,
    FilteringEnvironmentAvailability,
} from '../environment/environment-vocabulary';
import { type EnvironmentSelectionHost } from '../environment/environment-selection';
import { ExecutorPreparationState } from '../environment/executor-preparation';
import type { EvidenceRouteHost } from '../local/evidence-route-contract';
import { registeredParameters } from '../agent/registered-parameters';
import { ToolName } from '../agent/tool-names';
import { ToolRegistry } from '../agent/tool-registry';
import type { FilteringExecutor } from './filtering-executors';

/**
 * Executor-agnostic opening of the select_environment description: the routing instruction every
 * executor's guidance then completes.
 */
const SELECT_ENVIRONMENT_DESCRIPTION_SKELETON =
    'Choose and lock exactly one environment after interpreting issue evidence. Labels and ' +
    'reported products are signals, not routing commands. Match the environment to where ' +
    'the reported product executes filtering:';

/**
 * The reserved-case routing sentence of the select_environment description: the one outcome that
 * locks no executor at all.
 */
const SELECT_ENVIRONMENT_RESERVED_CASE_SENTENCE =
    'Reserve unsupported_product_case for reports that are not website-filtering problems at ' +
    'all.';

/**
 * Closing instruction of the select_environment description, kept from the two-executor surface: an
 * executor advertising more capabilities is not a reason to pick it.
 */
const SELECT_ENVIRONMENT_CAPABILITY_CLOSER =
    'Never choose an environment because it advertises more capabilities.';

/**
 * The runtime seam the environment-selection tools act through.
 */
export interface EnvironmentSelectionToolsHost {
    /**
     * Environment selection state machine that owns the lock and the observed intent.
     */
    readonly environmentHost: EnvironmentSelectionHost;

    /**
     * The run's resolved executor registrations, in run-set order: the description composes their
     * guidance and an accepted selection dispatches through the chosen one.
     */
    readonly executors: readonly FilteringExecutor[];

    /**
     * Record one tool name as runtime-owned rather than inherited from the base registry.
     *
     * @param name - Registered tool name.
     */
    markBaseTool(name: string): void;

    /**
     * Adopt a prepared evidence route and expose its proxied browser tools.
     *
     * @param route - Route whose pinned configuration is already prepared.
     * @param reporterFilterIds - Official filters the route runs, which apply_rule's baseline
     *   prepares too.
     */
    activateEvidenceRoute(route: EvidenceRouteHost, reporterFilterIds: readonly number[]): void;

    /**
     * Expose the extension lifecycle tools once a browser-extension selection is ready.
     */
    enableExtensionLifecycleTools(): void;

    /**
     * Activate one resolved executor for an accepted selection, applying the model-loop effects a
     * lock through select_environment implies — the same activation the sole-executor run applies
     * deterministically at construction, so both paths build the activation context in one place.
     *
     * @param registration - The executor registration the accepted selection resolved to.
     */
    activateExecutor(registration: FilteringExecutor): Promise<void>;
}

/**
 * Compose the select_environment description for one run's executor set: the generic skeleton, one
 * routing line per available executor registration, and the reserved-case sentence.
 *
 * @param executors - The run's resolved executor registrations.
 * @returns The composed model-facing description.
 */
export function composeSelectEnvironmentDescription(
    executors: readonly FilteringExecutor[],
): string {
    const guidance = executors
        .filter(
            (executor) =>
                executor.descriptor.availability === FilteringEnvironmentAvailability.Available,
        )
        .map((executor) => executor.selectionGuidance);
    return [
        SELECT_ENVIRONMENT_DESCRIPTION_SKELETON,
        ...guidance,
        SELECT_ENVIRONMENT_RESERVED_CASE_SENTENCE,
        SELECT_ENVIRONMENT_CAPABILITY_CLOSER,
    ].join(' ');
}

/**
 * Project one accepted preparing lock response onto the post-activation selection state.
 *
 * The executor's activation ran the preparation pass and attached the durable outcome; the response
 * must carry the state and preparation record the snapshot now holds.
 *
 * @param host - Tools host whose selection host holds the updated snapshot.
 * @returns The post-activation state and preparation record fields.
 */
function refreshPreparingResponse(host: EnvironmentSelectionToolsHost): Record<string, unknown> {
    const snapshot = host.environmentHost.snapshot();
    return {
        state: snapshot?.state ?? EnvironmentSelectionState.CapabilityLimited,
        limitationCode:
            snapshot?.state === EnvironmentSelectionState.CapabilityLimited
                ? snapshot.cliPreparation?.state === ExecutorPreparationState.Limited
                    ? EnvironmentLimitationCode.EnvironmentPreparationFailed
                    : EnvironmentLimitationCode.RequiredCapabilityUnavailable
                : null,
        cliPreparation: snapshot?.cliPreparation ?? null,
    };
}

/**
 * Register the environment-selection surface: update_observed_intent always, and select_environment
 * only when the run's executor set offers a choice.
 *
 * A sole-executor run is locked deterministically at construction, so the choice tool would
 * advertise a decision the model cannot make.
 *
 * @param registry - Registry the model's tool calls dispatch into.
 * @param host - Runtime seam the two handlers act through.
 * @returns The per-run tool descriptions the session surface advertises, empty for a sole executor
 *   run where no choice exists to describe.
 */
export function registerEnvironmentSelectionTools(
    registry: ToolRegistry,
    host: EnvironmentSelectionToolsHost,
): Record<string, string> {
    const descriptions: Record<string, string> = {};
    if (host.executors.length > 1) {
        const description = composeSelectEnvironmentDescription(host.executors);
        descriptions[ToolName.SelectEnvironment] = description;
        registry.register({
            definition: {
                type: 'function',
                function: {
                    name: ToolName.SelectEnvironment,
                    description,
                    parameters: registeredParameters(ToolName.SelectEnvironment),
                },
            },
            handler: async (args) => {
                const response = host.environmentHost.select(args);
                if (
                    !response.accepted ||
                    response.kind === EnvironmentSelectionReservedCase.UnsupportedProductCase
                ) {
                    return { ...response };
                }
                const registration = host.executors.find(
                    (executor) => executor.name === response.kind,
                );
                if (!registration) {
                    // The host already rejects names outside its advertised set, so a missing
                    // registration is a wiring defect, never a model error to bounce.
                    throw new Error(
                        `The accepted executor "${response.kind}" resolved to no registration in ` +
                            `the run's executor set.`,
                    );
                }
                await host.activateExecutor(registration);
                // Only a lock that started `preparing` can have changed across the activation;
                // every other accepted response keeps the host's own metadata verbatim.
                if (response.state !== EnvironmentSelectionState.Preparing) {
                    return { ...response };
                }
                return {
                    ...response,
                    ...refreshPreparingResponse(host),
                };
            },
        });
        host.markBaseTool(ToolName.SelectEnvironment);
    }
    registry.register({
        definition: {
            type: 'function',
            function: {
                name: ToolName.UpdateObservedIntent,
                description:
                    'Refine the observed issue type after new evidence without changing the ' +
                    'locked environment or reported context.',
                parameters: registeredParameters(ToolName.UpdateObservedIntent),
            },
        },
        handler: async (args) => ({ ...host.environmentHost.updateObservedIntent(args) }),
    });
    host.markBaseTool(ToolName.UpdateObservedIntent);
    return descriptions;
}
