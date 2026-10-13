/**
 * The blocker modules a workflow plugs into the action: read each manifest the `blockerModules`
 * input names, register its executor so the `executors` input may name it, and check that the
 * step's `env:` sets every variable the module needs, all before the run resolves its inputs.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { ConfigError } from '../config/config-error';
import type { AgentEntryDependencies } from '../entry/entry-run';
import type { Logger } from '../logger/logger';
import { filteringExecutors } from '../orchestrator/filtering-executors';
import { createBlockerModuleExecutor } from '../proxy-blocker/blocker-module-executor';
import {
    blockerModuleDefinition,
    enableBlockerModule,
    loadBlockerModuleManifest,
    missingModuleEnvironment,
    type LoadedBlockerModule,
} from '../proxy-blocker/blocker-module-manifest';
import { createBlockerModuleRunIssue } from '../proxy-blocker/blocker-module-run-issue';

/**
 * Prefix of the temp directory a run with blocker modules uses as its agent workspace root: the
 * filter cache lives there, outside the analyzed checkout.
 */
const MODULE_RUN_WORKSPACE_PREFIX = 'filters-agent-modules-';

/**
 * Load the manifests a workflow names and register their executors.
 *
 * @param paths - Manifest paths, relative to the workspace or absolute.
 * @param workspaceDir - The runner's workspace.
 * @param environment - The step environment the modules' variables come from.
 * @returns The loaded modules.
 * @throws {ConfigError} Naming every manifest that could not be read and every missing variable.
 */
export function loadActionBlockerModules(
    paths: readonly string[],
    workspaceDir: string,
    environment: Readonly<Record<string, string | undefined>>,
): LoadedBlockerModule[] {
    const problems: string[] = [];
    const modules: LoadedBlockerModule[] = [];
    for (const path of paths) {
        let module: LoadedBlockerModule;
        try {
            module = loadBlockerModuleManifest(
                isAbsolute(path) ? path : resolve(workspaceDir, path),
            );
        } catch (error) {
            problems.push(error instanceof Error ? error.message : String(error));
            continue;
        }
        const missing = missingModuleEnvironment(module, environment);
        if (missing.length > 0) {
            problems.push(
                `Blocker module ${module.manifest.executor} needs ${missing.join(', ')} in the ` +
                    "action step's env.",
            );
            continue;
        }
        if (!filteringExecutors.has(module.manifest.executor)) {
            filteringExecutors.register(
                createBlockerModuleExecutor(blockerModuleDefinition(module)),
            );
        }
        modules.push(module);
    }
    if (problems.length > 0) {
        throw new ConfigError(problems.join('\n'));
    }
    return modules;
}

/**
 * Build the entry dependencies one action run needs. A run that enables a module's executor gets
 * the per-issue seam that starts the module for every investigation; any other run keeps the
 * entry's own default seams.
 *
 * @param executors - Executor names the run locks.
 * @param modules - The loaded modules.
 * @param environment - The step environment the modules' variables come from.
 * @param logger - Run logger the modules' output reaches.
 * @param createRunIssue - Factory of the per-issue seam.
 * @returns Entry dependencies for the run.
 */
export function blockerModuleEntryDependencies(
    executors: readonly string[] | undefined,
    modules: readonly LoadedBlockerModule[],
    environment: Readonly<Record<string, string | undefined>>,
    logger: Logger,
    createRunIssue: typeof createBlockerModuleRunIssue = createBlockerModuleRunIssue,
): AgentEntryDependencies {
    const enabled = modules.filter((module) => executors?.includes(module.manifest.executor));
    if (enabled.length === 0) {
        return {};
    }
    const workspaceRoot = mkdtempSync(join(tmpdir(), MODULE_RUN_WORKSPACE_PREFIX));
    return {
        runIssue: createRunIssue(
            workspaceRoot,
            enabled.map((module) => enableBlockerModule(module, environment, logger)),
        ),
    };
}
