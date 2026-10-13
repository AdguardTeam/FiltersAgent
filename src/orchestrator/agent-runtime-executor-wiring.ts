/**
 * The runtime's executor wiring: the one module that imports the browser-extension executor
 * registration for its side effect and resolves the run's executor set into a selection host.
 *
 * `AgentRuntime.create` consumes this module, so every entry point reaching `AgentRuntime` joins
 * the browser-extension registration before the set resolves; other callers may add registrations
 * of their own beside it by importing their modules. The resolution is the run's executor-set
 * input: names the run requests, or every registered executor when the run names none.
 */
import './extension-filtering-executor';
import type { IssueFacts } from '../types/issue-facts';
import type { SelectionFilterBaseline } from '../environment/declared-filter-baseline';
import { EnvironmentSelectionHost } from '../environment/environment-selection';
import {
    filteringExecutors,
    resolveRunExecutors,
    type FilteringExecutor,
    type FilteringExecutorRegistry,
} from './filtering-executors';

/**
 * The executor wiring a runtime locks at construction: the resolved registrations and the selection
 * host built over their descriptors.
 */
export interface RuntimeExecutorWiring {
    /**
     * The run's resolved executor registrations in run-set order.
     */
    executors: FilteringExecutor[];

    /**
     * Selection host holding one descriptor per resolved executor.
     */
    environmentHost: EnvironmentSelectionHost;
}

/**
 * Inputs of the executor wiring: the run's issue facts, its requested executor names, and an
 * optional hermetic registry.
 */
export interface RuntimeExecutorWiringInput {
    /**
     * Parser-owned issue facts the selection host reads its evidence from.
     */
    issueFacts: IssueFacts;

    /**
     * Executor names the run requests, or undefined to use every registered executor.
     */
    requestedExecutors?: readonly string[];

    /**
     * Hermetic registry resolving the set instead of the process registry; tests inject one to keep
     * their runs off the global registration.
     */
    registry?: FilteringExecutorRegistry;

    /**
     * The executable filter baseline the run supplies, when its blocker declares its own list
     * selection instead of naming lists the official AdGuard catalog can resolve. Absent for every
     * run whose reported selection is resolved against that catalog.
     */
    filterBaseline?: SelectionFilterBaseline;
}

/**
 * Resolve the run's executor set and build its selection host.
 *
 * A one-element set locks its sole executor without a model turn: the same snapshot shape a model
 * selection produces, recorded before the first turn because there is nothing to choose.
 *
 * @param input - The run's issue facts, its requested executor names, and an optional hermetic
 *   registry used instead of the process registry.
 * @returns The resolved registrations and the selection host keyed by their descriptors.
 * @throws When the registry is empty, a requested name is unknown, or a name repeats — each failure
 *   names the run's input and the registered set.
 */
export function wireRuntimeExecutors(input: RuntimeExecutorWiringInput): RuntimeExecutorWiring {
    const executors = resolveRunExecutors(
        input.requestedExecutors,
        input.registry ?? filteringExecutors,
    );
    const environmentHost = new EnvironmentSelectionHost(
        input.issueFacts,
        executors.map((executor) => executor.descriptor),
        input.filterBaseline === undefined ? {} : { filterBaseline: input.filterBaseline },
    );
    if (executors.length === 1) {
        const lock = environmentHost.lockSoleExecutor(executors[0]!.name);
        if (!lock.accepted) {
            throw new Error(
                `The run's sole executor "${executors[0]!.name}" could not be locked: ` +
                    String('error' in lock ? lock.error : lock.errorKind),
            );
        }
    }
    return { executors, environmentHost };
}
