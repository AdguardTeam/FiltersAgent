/**
 * The lab's declared executor set: the two filtering executors a lab entry-driven run locks. The
 * entry delegate threads the set's names into the entry inputs, so entry-driven faces lock exactly
 * this set instead of whatever happens to be registered when the run resolves.
 *
 * Importing this module performs the registration: the two registration imports below join their
 * executor modules for the side effect of registering into the process registry, and ESM evaluates
 * a module graph exactly once per process — the import IS the registration, and it can never run
 * twice, so importing the set from several modules cannot double-register.
 */

import { BrowserExtensionExecutorName } from '../../src/environment/executor-name';
import { AdguardCliExecutorName } from '../../src/adguard-cli/executor-name';
import '../../src/orchestrator/extension-filtering-executor';
import { ADGUARD_CLI_MODULE } from '../../src/adguard-cli/adguard-cli-module';
import { filteringExecutors } from '../../src/orchestrator/filtering-executors';
import { createBlockerModuleExecutor } from '../../src/proxy-blocker/blocker-module-executor';

/**
 * The two-member executor set every lab entry-driven run locks, in registration order: the browser
 * extension every run registers first, then the AdGuard CLI proxy registration the lab owns. Passed
 * explicitly — the set is a run input — so a run whose AdGuard CLI binary is absent still resolves
 * the proxy executor and reaches its typed preparation limitation instead of silently losing the
 * desktop executor.
 */
export const LAB_EXECUTOR_SET = [BrowserExtensionExecutorName, AdguardCliExecutorName] as const;

// The lab drives the AdGuard CLI module in-process; registering it here, once per process, is what
// lets a lab run lock the set above.
if (!filteringExecutors.has(AdguardCliExecutorName)) {
    filteringExecutors.register(createBlockerModuleExecutor(ADGUARD_CLI_MODULE));
}
