/**
 * The blocker modules a local run plugs in: the manifests `--blocker-module` names, loaded by the
 * same code as the action's `blockerModules` input, and the executor set a run locks when it names
 * none. The browser extension is the one executor every run registers; any other executor, AdGuard
 * CLI included, joins only as a module.
 */
import { join } from 'node:path';
import '../../src/orchestrator/extension-filtering-executor';
import {
    BrowserExtensionExecutorName,
    type ExecutorName,
} from '../../src/environment/executor-name';
import { loadBlockerModules } from '../../src/proxy-blocker/blocker-module-loader';
import type { LoadedBlockerModule } from '../../src/proxy-blocker/blocker-module-manifest';

/**
 * Where a local run takes the variables a module needs from, named in the error when one is
 * missing: the shell environment or the workspace `.env`.
 */
const LAB_MODULE_ENVIRONMENT_NAME = 'the environment or .env';

/**
 * Load the manifests a local run names and register their executors.
 *
 * @param paths - Manifest paths, relative to the workspace root or absolute.
 * @param workspaceRoot - The agent workspace root relative paths resolve against.
 * @param environment - The environment the modules' variables come from.
 * @returns The loaded modules.
 * @throws {ConfigError} Naming every manifest that could not be read and every missing variable.
 */
export function loadLabBlockerModules(
    paths: readonly string[],
    workspaceRoot: string,
    environment: Readonly<Record<string, string | undefined>>,
): LoadedBlockerModule[] {
    return loadBlockerModules(paths, workspaceRoot, environment, LAB_MODULE_ENVIRONMENT_NAME);
}

/**
 * The executor set a local run locks when it names none: the browser extension and every module it
 * plugs in.
 *
 * @param moduleExecutors - Executor names of the plugged-in modules.
 * @returns The executor names, the browser extension first.
 */
export function labExecutorSet(moduleExecutors: readonly ExecutorName[]): ExecutorName[] {
    return [BrowserExtensionExecutorName, ...moduleExecutors];
}

/**
 * Directory below the workspace root the official filter lists are cached in across local runs.
 *
 * @param workspaceRoot - The agent workspace root.
 * @returns The filter cache directory.
 */
export function labFilterCacheDir(workspaceRoot: string): string {
    return join(workspaceRoot, 'tmp', 'filter-cache');
}
