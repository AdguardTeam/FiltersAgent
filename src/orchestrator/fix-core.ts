import { BrowserMode } from '../types/browser-mode';
import type { CoreConfig } from '../config/config';
import { type FixRunResult } from '../types/fix-run-result';
import { runAgenticFixCore } from './agentic-fix-core';
import type { FixCoreDependencies, FixCoreIssueInput, FixCoreOptions } from './fix-core-inputs';
/**
 * The fix mode's entry point: one call that runs a local browser-first fix investigation with no
 * GitHub adapter or publication logic. The investigation itself lives in `agentic-fix-core.ts`
 * (model-owned lifecycle); its input vocabulary lives in `fix-core-inputs.ts` and
 * `fix-core-context.ts`.
 */

/**
 * Run one local browser-first fix investigation without any GitHub adapter or publication logic.
 *
 * The only issue visible to fetch_issue is the caller-supplied local snapshot. Human benchmark
 * references are intentionally absent from this API and must be consumed by a post-run comparator.
 *
 * @param config - GitHub-independent LLM and browser configuration.
 * @param issue - Local raw issue snapshot and optional pre-parsed facts.
 * @param options - Local artifact and execution options.
 * @param dependencies - Optional provider and browser test seams.
 * @returns A typed terminal result and paths to local evidence.
 */
export async function runFixCore(
    config: CoreConfig,
    issue: FixCoreIssueInput,
    options: FixCoreOptions,
    dependencies: FixCoreDependencies = {},
): Promise<FixRunResult> {
    if (options.browserMode === BrowserMode.Off) {
        throw new Error('Model-driven fix requires browser mode auto or on.');
    }
    return await runAgenticFixCore(config, issue, options, dependencies);
}
