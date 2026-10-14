/**
 * The filtering executor of one blocker module: whatever proxy blocker the module wraps, the agent
 * selects it, prepares it and verifies rules through it the same way, through the blocker
 * contract.
 *
 * The module's name and the model-facing routing guidance come from its definition; everything the
 * agent learns about the blocker itself comes from the module's own description. A run wires the
 * module per activation through `ExecutorActivationContext.executorDependencies`, keyed by the
 * executor's name, never through module state, so two runs in one process never share a blocker.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
    BLOCKER_CONTRACT_VERSION,
    type BlockerContract,
    type BlockerDescription,
} from '../blocker-contract/blocker-contract';
import {
    EnvironmentCapability,
    EnvironmentPreparationState,
    FilteringEnvironmentAvailability,
    type FilteringEnvironmentDescriptor,
} from '../environment/environment-vocabulary';
import { EVIDENCE_ROUTE_CAPABILITIES } from '../environment/environment-selection-support';
import type { ExecutorName } from '../environment/executor-name';
import type { ExecutorPreparationOutcome } from '../environment/executor-preparation';
import { FilterBaselineStatus } from '../environment/filter-baseline-status';
import type {
    ExecutorActivationContext,
    ExecutorAdapterContext,
    FilteringExecutor,
} from '../orchestrator/filtering-executors';
import {
    ProxyBlockerPreparationLimitationCode,
    ProxyBlockerPreparationStage,
} from './preparation-limitation';
import { ProxyBlockerEnvironmentAdapter } from './proxy-environment-adapter';
import {
    createProxyBlockerEvidenceRoute,
    evidenceRouteFilterIds,
    type CreateProxyBlockerEvidenceRouteInput,
} from './proxy-evidence-route';

/**
 * Source label the published preparation provenance carries for a blocker module.
 */
const MODULE_PROVENANCE_SOURCE = 'blocker_module';

/**
 * RFC 4648 base32 alphabet. The published digest uses base32 rather than hex so the durable
 * provenance is visibly a bounded token rather than a raw hash channel.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * What a blocker module declares about itself before it runs.
 */
export interface BlockerModuleDefinition {
    /**
     * Executor name the module registers under.
     */
    executor: ExecutorName;

    /**
     * Model-facing routing prose: which reports this blocker verifies and how to drive it.
     */
    selectionGuidance: string;
}

/**
 * What one run provides for a blocker module's executor.
 */
export interface BlockerModuleRunDependencies {
    /**
     * Start the run's own instance of the module.
     *
     * @param workspaceDir - Private directory the module may keep its own files in.
     * @returns The started module.
     */
    startBlocker: (workspaceDir: string) => BlockerContract;

    /**
     * Private directory the evidence route keeps its catalog and browser profiles in.
     */
    workspaceDir: string;

    /**
     * Directory official filter lists are cached in across runs.
     */
    filterCacheDir: string;

    /**
     * Deterministic seams of the evidence route; production passes none.
     */
    routeDependencies?: CreateProxyBlockerEvidenceRouteInput['dependencies'];
}

/**
 * Encode a lowercase hex SHA-256 digest as canonical (unpadded) base32.
 *
 * @param hexDigest - Lowercase hex digest of the executing binary.
 * @returns Deterministic unpadded base32 token for the published provenance.
 */
function digestToB32(hexDigest: string): string {
    const bytes = Buffer.from(hexDigest, 'hex');
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) {
        output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }
    return output;
}

/**
 * Build one preparation limitation.
 *
 * @param stage - The stage the preparation reached.
 * @param code - Why it stopped.
 * @param detail - Fixed, path-free sentence naming the failure.
 * @returns The limited outcome.
 */
function limited(
    stage: ProxyBlockerPreparationStage,
    code: ProxyBlockerPreparationLimitationCode,
    detail: string,
): ExecutorPreparationOutcome {
    return { ready: false, limitation: { stage, code, detail } };
}

/**
 * Read the module's description, or the limitation that ends the preparation.
 *
 * @param blocker - The started module.
 * @returns The description, or the limited outcome.
 */
async function describeModule(
    blocker: BlockerContract,
): Promise<BlockerDescription | ExecutorPreparationOutcome> {
    let description: BlockerDescription;
    try {
        description = await blocker.describe();
    } catch (error) {
        // The typed outcome below is path-free; the module's own failure is kept here.
        console.error('blocker module failed to describe itself', error);
        return limited(
            ProxyBlockerPreparationStage.Module,
            ProxyBlockerPreparationLimitationCode.ModuleFailed,
            'The blocker module failed to describe itself.',
        );
    }
    if (description.contractVersion !== BLOCKER_CONTRACT_VERSION) {
        return limited(
            ProxyBlockerPreparationStage.Module,
            ProxyBlockerPreparationLimitationCode.ContractVersionMismatch,
            `The blocker module speaks contract version ${description.contractVersion}, ` +
                `the agent speaks ${BLOCKER_CONTRACT_VERSION}.`,
        );
    }
    return description;
}

/**
 * Stop a module whose preparation ended, keeping its own failure in the log.
 *
 * @param blocker - The started module.
 */
async function stopQuietly(blocker: BlockerContract): Promise<void> {
    await blocker.stop().catch((error: unknown) => {
        console.error('blocker module stop after a failed preparation', error);
    });
}

/**
 * Create the filtering executor of one blocker module.
 *
 * @param definition - The module's executor name and routing guidance.
 * @returns The executor, to register in the run's registry.
 */
export function createBlockerModuleExecutor(
    definition: BlockerModuleDefinition,
): FilteringExecutor {
    const descriptor: FilteringEnvironmentDescriptor = {
        kind: definition.executor,
        availability: FilteringEnvironmentAvailability.Available,
        preparationState: EnvironmentPreparationState.Preparable,
        limitationCode: null,
        capabilities: [EnvironmentCapability.CliInstallation, EnvironmentCapability.CliActivation],
        // The evidence route grants these once it is ready (`attachCliEvidenceRouteReady`).
        preparedCapabilities: [
            EnvironmentCapability.CliInstallation,
            EnvironmentCapability.CliActivation,
            ...EVIDENCE_ROUTE_CAPABILITIES,
        ],
    };

    /**
     * Prepare the run's module and activate its evidence route.
     *
     * @param context - The run's activation context.
     * @returns The outcome the selection host records.
     */
    const prepare = async (
        context: ExecutorActivationContext,
    ): Promise<ExecutorPreparationOutcome> => {
        const dependencies = context.executorDependencies?.[definition.executor] as
            | BlockerModuleRunDependencies
            | undefined;
        if (dependencies === undefined) {
            return limited(
                ProxyBlockerPreparationStage.Module,
                ProxyBlockerPreparationLimitationCode.ModuleNotProvided,
                'The run provided no blocker module for this executor.',
            );
        }
        const blocker = dependencies.startBlocker(join(dependencies.workspaceDir, 'blocker'));
        const description = await describeModule(blocker);
        if ('ready' in description) {
            await stopQuietly(blocker);
            return description;
        }
        const reporterFilterIds = context.reporterFilterIds;
        const route = createProxyBlockerEvidenceRoute({
            cycleId: randomUUID(),
            blocker,
            workspaceDir: dependencies.workspaceDir,
            filterCacheDir: dependencies.filterCacheDir,
            reporterFilterIds,
            dependencies: dependencies.routeDependencies,
        });
        try {
            // The lists and the module's description must be in place before the first session.
            await route.prepareConfiguration();
        } catch (error) {
            console.error('blocker module evidence route configuration failed', error);
            await stopQuietly(blocker);
            return limited(
                ProxyBlockerPreparationStage.Route,
                ProxyBlockerPreparationLimitationCode.RouteConfigurationFailed,
                'The evidence route over the blocker module could not be configured.',
            );
        }
        context.runtime.activateEvidenceRoute(route, evidenceRouteFilterIds(reporterFilterIds));
        return {
            ready: true,
            provenance: {
                source: MODULE_PROVENANCE_SOURCE,
                product: description.product,
                version: description.version,
                digestB32: digestToB32(description.binarySha256),
            },
        };
    };

    return {
        name: definition.executor,
        descriptor,
        selectionGuidance: definition.selectionGuidance,

        async activate(context: ExecutorActivationContext): Promise<void> {
            const host = context.environmentHost;
            const snapshot = host.snapshot();
            // Preparation runs only for a locked selection of this executor whose reported filter
            // selection has an executable official baseline: the host has already degraded every
            // other case, and preparing a route would bind evidence to a baseline that cannot run.
            if (
                snapshot === null ||
                snapshot.selectedKind !== definition.executor ||
                snapshot.filterBaseline?.status !== FilterBaselineStatus.Executable
            ) {
                return;
            }
            host.attachExecutorPreparation(await prepare(context));
        },

        createAdapter(context: ExecutorAdapterContext): ProxyBlockerEnvironmentAdapter {
            const route = context.evidenceRoute;
            if (route === null) {
                throw new Error('A blocker module executes only from an activated evidence route.');
            }
            const ports = route.environmentPorts();
            return new ProxyBlockerEnvironmentAdapter({
                executor: definition.executor,
                cliVersion: ports.cliVersion,
                product: ports.product,
                installationDigest: ports.installationDigest,
                baselineHost: ports.baselineHost,
                applyCandidate: (rule) => ports.applyCandidate(rule),
                revokeCandidate: () => ports.revokeCandidate(),
                applyBaselineEdit: (originalRule, replacementRule) =>
                    ports.applyBaselineEdit(originalRule, replacementRule),
                applyBaselineRemoval: (originalRule) => ports.applyBaselineRemoval(originalRule),
                revokeBaselineEdit: () => ports.revokeBaselineEdit(),
                createSession: async (request) => {
                    return await context.launchEvidenceSession({ targetUrl: request.targetUrl });
                },
            });
        },
    };
}
