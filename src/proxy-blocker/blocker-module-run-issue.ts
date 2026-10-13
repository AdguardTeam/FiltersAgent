/**
 * The per-issue engine of a run that enables blocker-module executors: the shared public
 * `runDefaultSingleIssue` composition, unchanged, with each module wired into every issue's own
 * investigation through `FixCoreOptions.agentRuntime.executorDependencies`. Without this wiring a
 * locked module selection finds no module and ends capability-limited. Every other behavior —
 * workspace preparation, GitHub publication, the durable revision marker — stays exactly the public
 * engine's own; only the investigation seam is wrapped. The action and any other caller build their
 * `runIssue` seam here, so they never drift.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BlockerContract } from '../blocker-contract/blocker-contract';
import { runDefaultSingleIssue } from '../entry/single-issue-run';
import type {
    DefaultSingleIssueRequest,
    DefaultSingleIssueResult,
} from '../entry/single-issue-run-types';
import type { ExecutorName } from '../environment/executor-name';
import { extractReport } from '../intake/extract-report';
import { runFixCore } from '../orchestrator/fix-core';
import type { BlockerModuleRunDependencies } from './blocker-module-executor';
import { redactText } from '../tracer/redact-text';
import { reservePrivateWorkspace } from './private-workspace';

/**
 * Directory below the agent workspace the official filter lists are cached in across runs.
 */
const FILTER_CACHE_DIRECTORY = join('tmp', 'filter-cache');

/**
 * Directory under the issue's artifacts the modules' own logs are copied to.
 */
const BLOCKER_LOGS_DIRECTORY = 'blocker-logs';

/**
 * Extension of the files a module's workspace keeps its logs in.
 */
const LOG_FILE_EXTENSION = '.log';

/**
 * Copy every log a module left in its workspace into the issue's artifacts before the workspace is
 * removed.
 *
 * A module's own logs say what the blocker did with each request: whether it filtered a page or let
 * it through. Without them a page the blocker never filtered looked the same as a rule that did not
 * work. The copy is redacted the way every persisted log is. Diagnostics never fail a run, so a
 * copy that fails is only reported.
 *
 * @param moduleWorkspace - The module's workspace.
 * @param destination - Directory under the artifacts the logs go to.
 */
function copyModuleLogs(moduleWorkspace: string, destination: string): void {
    if (!existsSync(moduleWorkspace)) {
        return;
    }
    try {
        const logs = readdirSync(moduleWorkspace, { recursive: true, encoding: 'utf8' }).filter(
            (path) => path.endsWith(LOG_FILE_EXTENSION),
        );
        for (const path of logs) {
            const target = join(destination, path);
            mkdirSync(dirname(target), { recursive: true });
            // The artifacts are published with the run, and a blocker logs every URL it saw, query
            // and referrer included: a session token in a page's request must not travel with it.
            writeFileSync(target, redactText(readFileSync(join(moduleWorkspace, path), 'utf8')));
        }
    } catch (error) {
        console.warn(
            `blocker module logs not copied from ${moduleWorkspace}: ` +
                `${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/**
 * One blocker module a run enables.
 */
export interface EnabledBlockerModule {
    /**
     * Executor name the module registered under.
     */
    executor: ExecutorName;

    /**
     * Start the module for one issue.
     *
     * @param workspaceDir - Private directory the module may keep its own files in.
     * @returns The started module.
     */
    startBlocker: (workspaceDir: string) => BlockerContract;
}

/**
 * Injectable seams of the per-issue engine; production passes nothing.
 */
export interface BlockerModuleRunIssueDependencies {
    /**
     * Per-issue investigation seam; production composes the shared public engine.
     */
    runDefaultSingleIssue?: typeof runDefaultSingleIssue;

    /**
     * Private workspace reservation; production reserves a fresh mode-0700 temp directory.
     */
    reservePrivateWorkspace?: typeof reservePrivateWorkspace;

    /**
     * GitHub-independent investigation core; production investigates through runFixCore.
     */
    runFixCore?: typeof runFixCore;
}

/**
 * Build the per-issue `runIssue` seam: the shared public engine, with every enabled module wired
 * into every issue's own investigation. Each issue gets its own private workspace and its own
 * module instance, so two issues running back to back never share blocker state.
 *
 * @param workspaceRoot - Agent workspace root the filter cache lives under.
 * @param modules - The modules the run enables.
 * @param dependencies - Injectable seams; production passes nothing.
 * @returns The per-issue seam.
 */
export function createBlockerModuleRunIssue(
    workspaceRoot: string,
    modules: readonly EnabledBlockerModule[],
    dependencies: BlockerModuleRunIssueDependencies = {},
): (request: DefaultSingleIssueRequest) => Promise<DefaultSingleIssueResult> {
    const runIssue = dependencies.runDefaultSingleIssue ?? runDefaultSingleIssue;
    const reserve = dependencies.reservePrivateWorkspace ?? reservePrivateWorkspace;
    const investigateCore = dependencies.runFixCore ?? runFixCore;
    const filterCacheDir = join(workspaceRoot, FILTER_CACHE_DIRECTORY);

    return async (request: DefaultSingleIssueRequest): Promise<DefaultSingleIssueResult> => {
        // The reservation resolves every forbidden root, and the action hands over an artifacts
        // path the entry has not created yet; creating it here, with the entry's own mode, lets
        // the overlap check see it.
        mkdirSync(request.artifactsDir, { recursive: true, mode: 0o700 });
        const workspaceDir = reserve([workspaceRoot, request.artifactsDir]);
        const moduleDependencies = Object.fromEntries(
            modules.map((module): [ExecutorName, BlockerModuleRunDependencies] => [
                module.executor,
                {
                    startBlocker: module.startBlocker,
                    workspaceDir: join(workspaceDir, module.executor),
                    filterCacheDir,
                },
            ]),
        );
        try {
            return await runIssue(request, {
                extractReport,
                investigate: (config, issue, options, coreDependencies) =>
                    investigateCore(
                        config,
                        issue,
                        {
                            ...options,
                            agentRuntime: {
                                ...options.agentRuntime,
                                executorDependencies: {
                                    ...options.agentRuntime?.executorDependencies,
                                    ...moduleDependencies,
                                },
                            },
                        },
                        coreDependencies,
                    ),
            });
        } finally {
            for (const module of modules) {
                copyModuleLogs(
                    join(workspaceDir, module.executor),
                    join(request.artifactsDir, BLOCKER_LOGS_DIRECTORY, module.executor),
                );
            }
            // The route stopped every module it started when the run ended; what is left is files.
            rmSync(workspaceDir, { recursive: true, force: true });
        }
    };
}
