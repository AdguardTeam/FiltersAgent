/**
 * The per-issue seam of an action run that plugs blocker modules in: the workflow names the
 * manifests in the `blockerModules` input, `loadBlockerModules` reads them before the run resolves
 * its inputs, and every enabled module starts for each investigation.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEntryDependencies } from '../entry/entry-run';
import type { Logger } from '../logger/logger';
import { enableBlockerModules } from '../proxy-blocker/blocker-module-loader';
import type { LoadedBlockerModule } from '../proxy-blocker/blocker-module-manifest';
import { createBlockerModuleRunIssue } from '../proxy-blocker/blocker-module-run-issue';

/**
 * Where the step sets the variables a module needs, named in the error when one is missing.
 */
export const ACTION_MODULE_ENVIRONMENT_NAME = "the action step's env";

/**
 * Prefix of the temp directory a run with blocker modules uses as its agent workspace root: the
 * filter cache lives there, outside the analyzed checkout.
 */
const MODULE_RUN_WORKSPACE_PREFIX = 'filters-agent-modules-';

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
    const enabled = enableBlockerModules(executors, modules, environment, logger);
    if (enabled.length === 0) {
        return {};
    }
    const workspaceRoot = mkdtempSync(join(tmpdir(), MODULE_RUN_WORKSPACE_PREFIX));
    return { runIssue: createRunIssue(workspaceRoot, enabled) };
}
