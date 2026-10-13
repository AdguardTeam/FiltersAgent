import {
    EnvironmentCapability,
    EnvironmentPreparationState,
    EnvironmentSelectionState,
    FilteringEnvironmentAvailability,
    type FilteringEnvironmentDescriptor,
} from '../environment/environment-vocabulary';
import { BrowserExtensionExecutorName, type ExecutorName } from '../environment/executor-name';
import { BrowserExtensionEnvironmentAdapter } from '../environment/browser-extension-environment';
import { FirefoxExtensionEnvironmentAdapter } from '../environment/firefox-extension-environment';
import type { FilteringEnvironmentAdapter } from '../environment/filtering-environment';
import type {
    ExecutorActivationContext,
    ExecutorAdapterContext,
    FilteringExecutor,
} from './filtering-executors';
import { filteringExecutors } from './filtering-executors';

/**
 * The browser-extension filtering executor: the one executor this tree registers.
 *
 * Importing this module performs the registration, so a run's registry is never empty; other
 * callers may import it (directly or through the runtime wiring) and register executors of their
 * own beside it.
 */

/**
 * Model-facing routing prose for the extension executor, contributed to the select_environment
 * description when the executor is available.
 */
const SELECTION_GUIDANCE =
    'Browser-extension reports from AdGuard browser products belong to browser_extension: the ' +
    'extension under test reproduces the reported in-browser filtering directly.';

/**
 * Build the extension executor's capability descriptor. Its kind is the executor name; the
 * capabilities are the ones the extension adapter can prove today (browsing, steering, extension
 * filtering, candidate application, baseline integrity, and the phase proof).
 *
 * @returns Fresh descriptor for the browser-extension executor.
 */
function extensionExecutorDescriptor(): FilteringEnvironmentDescriptor {
    return {
        kind: BrowserExtensionExecutorName,
        availability: FilteringEnvironmentAvailability.Available,
        preparationState: EnvironmentPreparationState.NotStarted,
        limitationCode: null,
        capabilities: [
            EnvironmentCapability.BrowserNavigation,
            EnvironmentCapability.FilteringControl,
            EnvironmentCapability.ExtensionFiltering,
            EnvironmentCapability.CandidateApplication,
            EnvironmentCapability.BaselineIntegrity,
            EnvironmentCapability.PhaseProof,
        ],
    };
}

export const extensionFilteringExecutor: FilteringExecutor = {
    name: BrowserExtensionExecutorName,
    descriptor: extensionExecutorDescriptor(),
    selectionGuidance: SELECTION_GUIDANCE,

    /**
     * Expose the extension lifecycle tools once the locked selection is ready.
     *
     * @param context - Locked selection host, run facts, and the runtime host.
     */
    async activate(context: ExecutorActivationContext): Promise<void> {
        const snapshot = context.environmentHost.snapshot();
        if (
            snapshot !== null &&
            snapshot.selectedKind === (BrowserExtensionExecutorName as ExecutorName) &&
            snapshot.state === EnvironmentSelectionState.Ready
        ) {
            context.runtime.enableExtensionLifecycleTools();
        }
    },

    /**
     * Build the adapter of the run's own blocker family from the runtime's verified inputs.
     *
     * One executor name, one adapter per launch family: a Firefox-family run force-installs a
     * signed XPI and credits its phases from the declared file, while the Chromium line loads an
     * unpacked AdGuard build and locks its ruleset bytes. The runtime builds exactly one of the two
     * option sets, so this registration never has to choose between them.
     *
     * @param context - Runtime-resolved adapter inputs.
     * @returns Fresh executing adapter for this run.
     * @throws When the run carries no verified extension session — a non-extension executor or a
     *   control session must never reach adapter construction through this registration.
     */
    createAdapter(context: ExecutorAdapterContext): FilteringEnvironmentAdapter {
        if (context.firefoxExtensionOptions) {
            return new FirefoxExtensionEnvironmentAdapter(context.firefoxExtensionOptions);
        }
        if (!context.extensionOptions) {
            throw new Error(
                'The browser-extension executor executes only from a verified prepared ' +
                    'Extension session.',
            );
        }
        return new BrowserExtensionEnvironmentAdapter(context.extensionOptions);
    },
};

// Side-effectful registration: the module owns how src/ joins the registry.
filteringExecutors.register(extensionFilteringExecutor);
