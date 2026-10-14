/**
 * Plug blocker modules into a run by manifest: read each manifest, register its executor so the
 * run's executor set may name it, and check that the environment sets every variable the module
 * needs, all before the run resolves its inputs. The action and the local tools load modules here,
 * so a module behaves the same wherever it is plugged in.
 */
import { isAbsolute, resolve } from 'node:path';
import { ConfigError } from '../config/config-error';
import type { Logger } from '../logger/logger';
import { filteringExecutors } from '../orchestrator/filtering-executors';
import { createBlockerModuleExecutor } from './blocker-module-executor';
import {
    blockerModuleDefinition,
    enableBlockerModule,
    loadBlockerModuleManifest,
    missingModuleEnvironment,
    type LoadedBlockerModule,
} from './blocker-module-manifest';
import type { EnabledBlockerModule } from './blocker-module-run-issue';

/**
 * Load the manifests a run names and register their executors.
 *
 * @param paths - Manifest paths, relative to `baseDir` or absolute.
 * @param baseDir - Directory relative manifest paths resolve against.
 * @param environment - The environment the modules' variables come from.
 * @param environmentName - Where the caller sets those variables, named in the error.
 * @returns The loaded modules.
 * @throws {ConfigError} Naming every manifest that could not be read and every missing variable.
 */
export function loadBlockerModules(
    paths: readonly string[],
    baseDir: string,
    environment: Readonly<Record<string, string | undefined>>,
    environmentName: string,
): LoadedBlockerModule[] {
    const problems: string[] = [];
    const modules: LoadedBlockerModule[] = [];
    for (const path of paths) {
        let module: LoadedBlockerModule;
        try {
            module = loadBlockerModuleManifest(isAbsolute(path) ? path : resolve(baseDir, path));
        } catch (error) {
            problems.push(error instanceof Error ? error.message : String(error));
            continue;
        }
        const missing = missingModuleEnvironment(module, environment);
        if (missing.length > 0) {
            problems.push(
                `Blocker module ${module.manifest.executor} needs ${missing.join(', ')} in ` +
                    `${environmentName}.`,
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
 * Enable the loaded modules whose executor the run locks.
 *
 * @param executors - Executor names the run locks.
 * @param modules - The loaded modules.
 * @param environment - The environment the modules' variables come from.
 * @param logger - Run logger the modules' output reaches.
 * @returns The modules the run starts, empty when it locks none of them.
 */
export function enableBlockerModules(
    executors: readonly string[] | undefined,
    modules: readonly LoadedBlockerModule[],
    environment: Readonly<Record<string, string | undefined>>,
    logger: Logger,
): EnabledBlockerModule[] {
    return modules
        .filter((module) => executors?.includes(module.manifest.executor))
        .map((module) => enableBlockerModule(module, environment, logger));
}
