import type { IssueFacts } from '../types/issue-facts';
import type { ExecutorName } from '../environment/executor-name';
import type { FilteringEnvironmentDescriptor } from '../environment/environment-vocabulary';
import type { EnvironmentSelectionHost } from '../environment/environment-selection';
import type { BrowserExtensionEnvironmentOptions } from '../environment/browser-extension-environment';
import type { FirefoxExtensionEnvironmentOptions } from '../environment/firefox-extension-environment';
import type { FilteringEnvironmentAdapter } from '../environment/filtering-environment';
import type { FilterListRef } from '../environment/filter-list-ref';
import type { EvidenceRouteHost } from '../local/evidence-route-contract';
import type { BrowserSession } from '../browser/browser-session';

/**
 * The runtime host executors direct their model-loop effects at: adopting an evidence route and
 * exposing the extension lifecycle tools. The agent runtime implements it; fakes implement it in
 * tests.
 */
export interface ExecutorRuntimeHost {
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
}

/**
 * Opaque per-executor dependency bag threaded from the run into its activation context, keyed by
 * executor name. `src/` never inspects a value here — an executor reads only its own name's entry
 * and casts it back to the shape it defined, exactly as it would cast any other same-process,
 * self-authored value. This is how an executor registered outside this tree receives per-run host
 * wiring without `src/` importing its module to type it, and without the wiring living in module
 * state shared — and clobbered — across concurrent runs.
 */
export type ExecutorDependenciesByName = Readonly<Partial<Record<ExecutorName, unknown>>>;

/**
 * Trusted facts one executor's activation runs against: the locked selection host, the run's issue
 * inputs, and the runtime host to direct effects at.
 */
export interface ExecutorActivationContext {
    /**
     * Locked environment selection the executor was activated for.
     */
    environmentHost: EnvironmentSelectionHost;

    /**
     * Parser-owned issue facts the run was started from.
     */
    issueFacts: IssueFacts;

    /**
     * First trusted issue target URL the run locked.
     */
    targetUrl: string;

    /**
     * Official filter identifiers the reporter had enabled — from the settings link, or the filters
     * the report names when it has none — possibly empty.
     */
    reporterFilterIds: readonly number[];

    /**
     * Runtime host the executor directs its model-loop effects at.
     */
    runtime: ExecutorRuntimeHost;

    /**
     * The run's opaque per-executor dependency bag, when the run wired one; absent for a run that
     * needs no host wiring beyond the registration's own defaults.
     */
    executorDependencies?: ExecutorDependenciesByName;
}

/**
 * One launched proxied evidence session and its freshly minted identity.
 */
export interface LaunchedEvidenceSession {
    /**
     * Live session the caller owns and closes.
     */
    session: BrowserSession;

    /**
     * Fresh run-scoped session identity for evidence binding.
     */
    sessionId: string;
}

/**
 * Exact target one launched proxied evidence session may open.
 */
export interface EvidenceSessionLaunchRequest {
    /**
     * Exact locked HTTPS target the session may open.
     */
    targetUrl: string;
}

/**
 * Inputs one executing adapter is built from for a run.
 */
export interface ExecutorAdapterContext {
    /**
     * Official list references the run's projection resolved for the executing baseline.
     */
    requestedLists: readonly FilterListRef[];

    /**
     * Verified browser-extension adapter inputs, when the run's session verified them. A run
     * executing through a non-extension executor carries no extension proof to build them from, so
     * the field is absent; the extension executor refuses to build its adapter without it, and
     * executors of other shapes never read it.
     */
    extensionOptions?: BrowserExtensionEnvironmentOptions;

    /**
     * Verified Firefox-family blocker environment inputs, when the run's prepared build is a signed
     * XPI force-installed through enterprise policies. Exactly one of this and
     * {@link ExecutorAdapterContext.extensionOptions} is present for an extension-executing run: the
     * two families share an executor name but not an adapter.
     */
    firefoxExtensionOptions?: FirefoxExtensionEnvironmentOptions;

    /**
     * Prepared evidence route for CLI-shaped executors, or null when the run has none. The adapter
     * binds its command ports to the route's environment ports.
     */
    evidenceRoute: EvidenceRouteHost | null;

    /**
     * Launch one proxied evidence session for a CLI-shaped executor.
     *
     * The runtime owns the launch facts — the locked session profile, artifacts directory, head
     * flags, and logger — and resolves them per launch; the executor identifies only the exact
     * target.
     *
     * @param request - Exact target the proxied session may open.
     * @returns The opened session and its freshly minted session identity.
     */
    launchEvidenceSession(request: EvidenceSessionLaunchRequest): Promise<LaunchedEvidenceSession>;
}

/**
 * One filtering executor: a registration the run locks, prepares, and executes filtering through.
 * Registrations own their model-facing descriptor and routing prose, so the executor set is open
 * and the closed two-executor list is gone.
 */
export interface FilteringExecutor {
    /**
     * Executor name this registration is keyed by; equals its descriptor kind.
     */
    name: ExecutorName;

    /**
     * Immutable capability descriptor advertised for this executor.
     */
    descriptor: FilteringEnvironmentDescriptor;

    /**
     * Model-facing routing prose contributed to the select_environment description for an available
     * executor.
     */
    selectionGuidance: string;

    /**
     * Activate the executor's model-loop effects for a locked, accepted selection.
     *
     * @param context - Locked selection host, run facts, and the runtime host.
     */
    activate(context: ExecutorActivationContext): Promise<void>;

    /**
     * Build the executing adapter for a run.
     *
     * @param context - Runtime-resolved adapter inputs.
     * @returns Fresh executing adapter owned by the run.
     */
    createAdapter(context: ExecutorAdapterContext): FilteringEnvironmentAdapter;
}

/**
 * Registry of the filtering executors the process knows about, keyed by executor name.
 */
export class FilteringExecutorRegistry {
    /**
     * Registered executors in registration order.
     */
    private readonly executors = new Map<ExecutorName, FilteringExecutor>();

    /**
     * Register one executor under its name.
     *
     * @param executor - Executor registration; its descriptor must name the executor itself.
     * @throws When the name is already registered or the descriptor names another executor.
     */
    register(executor: FilteringExecutor): void {
        if (this.executors.has(executor.name)) {
            throw new Error(`Executor "${executor.name}" is already registered.`);
        }
        if (executor.descriptor.kind !== executor.name) {
            throw new Error(
                `Executor "${executor.name}" must register a descriptor for its own kind, ` +
                    `not for "${String(executor.descriptor.kind)}".`,
            );
        }
        this.executors.set(executor.name, executor);
    }

    /**
     * Return the executor registered under a name.
     *
     * @param name - Executor name to look up.
     * @returns The registered executor, or undefined when the name is unknown.
     */
    get(name: ExecutorName): FilteringExecutor | undefined {
        return this.executors.get(name);
    }

    /**
     * Whether an executor is registered under a name.
     *
     * @param name - Executor name to look up.
     * @returns Whether the registry holds that executor.
     */
    has(name: ExecutorName): boolean {
        return this.executors.has(name);
    }

    /**
     * Return the registered executor names in registration order.
     *
     * @returns Fresh executor-name list.
     */
    names(): ExecutorName[] {
        return [...this.executors.keys()];
    }
}

/**
 * The process's executor registry. This tree imports the extension registration; other callers may
 * register executors of their own beside it by importing their modules.
 */
export const filteringExecutors = new FilteringExecutorRegistry();

/**
 * Shared suffix of every resolve failure speaking in registered-executor names, so an error always
 * ends by naming the set the caller actually had.
 */
const REGISTERED_EXECUTORS_SUFFIX = 'Registered executors:';

/**
 * Resolve the executor set one run uses: the requested executor names in requested order, or every
 * registered executor when the run names none.
 *
 * @param requested - Executor names the run requests, or undefined to use the full registry.
 * @param registry - Registry to resolve against; hermetic instances keep tests off the global.
 * @returns The resolved executor registrations.
 * @throws When the registry holds no executor, an explicitly requested name is unknown, or the run
 *   names the same executor twice.
 */
export function resolveRunExecutors(
    requested: readonly string[] | undefined,
    registry: FilteringExecutorRegistry = filteringExecutors,
): FilteringExecutor[] {
    const registered = registry.names();
    if (requested === undefined && registered.length === 0) {
        throw new Error(`${REGISTERED_EXECUTORS_SUFFIX} (none).`);
    }
    if (requested !== undefined && requested.length === 0) {
        throw new Error(
            `No executors named for this run. ${REGISTERED_EXECUTORS_SUFFIX} ${registered.join(', ')}.`,
        );
    }
    const resolved: FilteringExecutor[] = [];
    const names = requested ?? registered;
    for (const name of names) {
        const executor = registry.get(name as ExecutorName);
        if (!executor) {
            throw new Error(
                `Unknown executor "${name}". ${REGISTERED_EXECUTORS_SUFFIX} ${registered.join(', ')}.`,
            );
        }
        if (resolved.some((existing) => existing.name === executor.name)) {
            throw new Error(`Executor "${name}" is named twice in this run's executor set.`);
        }
        resolved.push(executor);
    }
    return resolved;
}
