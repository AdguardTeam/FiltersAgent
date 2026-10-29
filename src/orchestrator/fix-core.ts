import { BrowserMode } from '../types/browser-mode';
import type { CoreConfig } from '../config/config';
import { createLogger } from '../logger/logger';
import { reportRepositorySkills } from '../pi/repository-skills-report';
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
    // Once per issue run, before the preparation session: every session reloads the skills
    // directory, so reporting it there would repeat each warning per session. A backlog reports
    // once per issue, each from its own checkout.
    if (options.skillsDir !== undefined) {
        reportRepositorySkills(
            options.skillsDir,
            createLogger({ verbose: options.verbose ?? false }),
        );
    }
    return await runAgenticFixCore(config, issue, options, dependencies);
}
