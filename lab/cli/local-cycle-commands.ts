import { join } from 'node:path';
import { loadCoreConfig, loadGithubReadConfig, type CoreConfig } from '../../src/config/config';
import type { RepositoryIdentitySources } from '../../src/config/repository-identity';
import {
    exportGithubIssue,
    type GithubIssueExporterDependencies,
} from '../local/github-issue-exporter';
import {
    runExportedSnapshotCycle,
    type LocalCycleDependencies,
    type LocalCycleResult,
} from '../local/local-cycle';
import { resolveLocalRunOutputDir } from '../../src/local/output-directory';
import type { EnabledBlockerModule } from '../../src/proxy-blocker/blocker-module-run-issue';
import { runTargetedLiveIssueCycle, type LiveCycleDependencies } from '../local/live-cycle';
import type { ExportedLocalIssueSnapshot } from '../../src/local/issue-snapshot';
import { CommandName } from './commands';
import type { ExportParsedCommand, ParsedCommand } from './program';
import type { GitCheckoutOriginReader } from './repository-origin';
import { readCheckoutOriginUrl } from './repository-origin';
import { ExtensionEnvironmentKind } from '../../src/types/extension-environment-kind';
import { loadUsagePricing } from '../pricing/usage-pricing';

/**
 * Host-owned process context passed explicitly from the CLI entry point.
 */
export interface LocalCycleCommandContext {
    /**
     * Raw environment read only by pure configuration loaders.
     */
    env: Record<string, string | undefined>;

    /**
     * Canonical agent workspace root.
     */
    workspaceRoot: string;

    /**
     * Optional deterministic clock for exported capture time.
     */
    now?: () => string;

    /**
     * Optional merged command interruption signal.
     */
    signal?: AbortSignal;

    /**
     * Resolved executor set a `fix` command locks, already validated against the registered names;
     * absent locks the browser extension and every module in `blockerModules`. Not read by faces
     * without an `--executors` flag.
     */
    executors?: readonly string[];

    /**
     * The blocker modules a `fix` command's locked selections start; absent starts none.
     */
    blockerModules?: readonly EnabledBlockerModule[];

    /**
     * The repository's own lint command line a `fix` command runs over each candidate; absent runs
     * no lint.
     */
    lintCommand?: string;
}

/**
 * Dependencies used by the two production local-cycle command operations.
 */
export interface LocalCycleCommandDependencies {
    /**
     * Revision-aware read-only GitHub exporter.
     */
    exportGithubIssue?: typeof exportGithubIssue;

    /**
     * Pure GitHub read configuration loader.
     */
    loadGithubReadConfig?: typeof loadGithubReadConfig;

    /**
     * Pure provider configuration loader; the explicit `LLM_*` environment by default.
     */
    loadLocalCoreConfig?: (env: Record<string, string | undefined>) => CoreConfig;

    /**
     * Production exported-snapshot cycle coordinator.
     */
    runExportedSnapshotCycle?: typeof runExportedSnapshotCycle;

    /**
     * Production targeted-live cycle coordinator.
     */
    runTargetedLiveIssueCycle?: typeof runTargetedLiveIssueCycle;

    /**
     * Additional non-config coordinator seams used by integration tests.
     */
    cycleDependencies?: Omit<LocalCycleDependencies, 'loadLocalCoreConfig'>;

    /**
     * Additional read-only live coordinator seams used by integration tests.
     */
    liveCycleDependencies?: Omit<LiveCycleDependencies, 'loadLocalCoreConfig'>;

    /**
     * Injectable checkout-origin reader used as an identity source; production spawns `git remote
     * get-url origin` on the `REPOSITORY_PATH` checkout. Null-tolerant: an unreadable checkout
     * leaves the origin slot empty instead of failing the load.
     */
    gitCheckoutOriginReader?: GitCheckoutOriginReader;

    /**
     * Optional lower-level exporter seams retained for direct adapter integration tests.
     */
    exporterDependencies?: GithubIssueExporterDependencies;
}

/**
 * Paths and typed result returned by one exported-snapshot fix command.
 */
export interface ExportedSnapshotFixCommandResult {
    /**
     * Terminal typed local cycle result.
     */
    result: LocalCycleResult;

    /**
     * Canonical cycle output root.
     */
    outputDir: string;

    /**
     * Atomic terminal result path.
     */
    cycleResultPath: string;
}

/**
 * Paths and typed result returned by one targeted live command.
 */
export interface LiveCycleCommandResult {
    /**
     * Terminal typed local cycle result.
     */
    result: LocalCycleResult;

    /**
     * Exact cycle output directory.
     */
    outputDir: string;

    /**
     * Fixed terminal result path when publication completed.
     */
    cycleResultPath: string;
}

/**
 * Build the repository-identity sources one command run feeds into its configuration loaders: the
 * parsed `--repository` flag directly, and the checkout origin resolved in this CLI seam only — the
 * loaders parse it, the seam never merges slugs itself.
 *
 * @param repository - The parsed `--repository` flag value, when given.
 * @param context - Explicit environment, workspace, and clock.
 * @param dependencies - Optional seams, including the injectable checkout-origin reader.
 * @returns The identity sources for the loader.
 */
function repositoryIdentitySources(
    repository: string | undefined,
    context: LocalCycleCommandContext,
    dependencies: LocalCycleCommandDependencies,
): RepositoryIdentitySources {
    return {
        flag: repository,
        checkoutOriginUrl: readCheckoutOriginUrl(context.env, dependencies.gitCheckoutOriginReader),
    };
}

/**
 * Execute the parsed read-only export command as a mandatory version-two envelope export.
 *
 * @param command - Parsed `export issue` command.
 * @param context - Explicit environment, workspace, and clock.
 * @param dependencies - Optional deterministic config and exporter seams.
 * @returns Persisted portable revision bundle.
 */
export async function runExportIssueCommand(
    command: ExportParsedCommand,
    context: LocalCycleCommandContext,
    dependencies: LocalCycleCommandDependencies = {},
): Promise<ExportedLocalIssueSnapshot> {
    const loadGithub = dependencies.loadGithubReadConfig ?? loadGithubReadConfig;
    const github = loadGithub(
        context.env,
        repositoryIdentitySources(command.repository, context, dependencies),
    );
    const exportIssue = dependencies.exportGithubIssue ?? exportGithubIssue;
    return await exportIssue(
        github,
        command.issueNumber,
        {
            outputDir: command.outputDir,
            workspaceRoot: context.workspaceRoot,
            outputFormat: 'revision-envelope',
            capturedAt: (context.now ?? (() => new Date().toISOString()))(),
            humanSolutionComments: command.humanSolutionComments,
            additionalBotAuthors: command.additionalBotAuthors,
            promptSafeOnly: command.promptSafeOnly,
        },
        dependencies.exporterDependencies,
    );
}

/**
 * Execute one parsed `fix --issue-file` command through the offline cycle boundary.
 *
 * Provider configuration is supplied as a lazy coordinator dependency, so malformed or tampered
 * revisions terminate before provider credentials or runtime configuration are resolved.
 *
 * @param command - Parsed local fix command.
 * @param context - Explicit environment and workspace root.
 * @param dependencies - Optional deterministic coordinator seams.
 * @returns Typed cycle result and its local paths.
 */
export async function runExportedSnapshotFixCommand(
    command: ParsedCommand,
    context: LocalCycleCommandContext,
    dependencies: LocalCycleCommandDependencies = {},
): Promise<ExportedSnapshotFixCommandResult> {
    if (command.command !== CommandName.Fix || !command.flags.issueFile) {
        throw new Error('Exported snapshot execution requires `fix --issue-file`.');
    }
    const outputDir = resolveLocalRunOutputDir(
        context.workspaceRoot,
        command.issueNumber,
        command.flags.environment,
        command.flags.outputDir,
    );
    const runCycle = dependencies.runExportedSnapshotCycle ?? runExportedSnapshotCycle;
    const loadLocal = dependencies.loadLocalCoreConfig ?? loadCoreConfig;
    const result = await runCycle(
        {
            issueNumber: command.issueNumber,
            issueFile: command.flags.issueFile,
            outputDir,
            environment: command.flags.environment,
            runConfig: command.flags.runConfig,
            keepTemporaryFiles: command.flags.keepTemporaryFiles,
            browserMode: command.flags.browserMode,
            routingCheck: command.flags.routingCheck,
            model: command.flags.model,
            verbose: command.flags.verbose,
            pricingSnapshot: loadUsagePricing(context.env, context.workspaceRoot) ?? undefined,
            signal: context.signal,
            executors: context.executors,
            blockerModules: context.blockerModules,
            lintCommand: context.lintCommand,
        },
        {
            ...dependencies.cycleDependencies,
            loadLocalCoreConfig: () => loadLocal(context.env),
        },
    );
    return {
        result,
        outputDir,
        cycleResultPath: join(outputDir, 'cycle-result.json'),
    };
}

/**
 * Execute `fix issue <number>` without an issue file through read-only live capture.
 *
 * @param command - Parsed current live fix command.
 * @param context - Explicit environment and workspace root.
 * @param dependencies - Optional deterministic config and coordinator seams.
 * @returns Typed targeted cycle result and its local paths.
 */
export async function runTargetedLiveIssueFixCommand(
    command: ParsedCommand,
    context: LocalCycleCommandContext,
    dependencies: LocalCycleCommandDependencies = {},
): Promise<LiveCycleCommandResult> {
    if (command.command !== CommandName.Fix || command.flags.issueFile) {
        throw new Error('Targeted live execution requires `fix issue <number>` without a file.');
    }
    if (command.flags.environment !== ExtensionEnvironmentKind.Current || command.flags.runConfig) {
        throw new Error('Targeted live cycles do not accept historical authority.');
    }
    const outputDir = resolveLocalRunOutputDir(
        context.workspaceRoot,
        command.issueNumber,
        'current',
        command.flags.outputDir,
    );
    const loadGithub = dependencies.loadGithubReadConfig ?? loadGithubReadConfig;
    const github = loadGithub(
        context.env,
        repositoryIdentitySources(command.flags.repository, context, dependencies),
    );
    const loadLocal = dependencies.loadLocalCoreConfig ?? loadCoreConfig;
    const runCycle = dependencies.runTargetedLiveIssueCycle ?? runTargetedLiveIssueCycle;
    const result = await runCycle(
        {
            github,
            issueNumber: command.issueNumber,
            outputDir,
            browserMode: command.flags.browserMode,
            keepTemporaryFiles: command.flags.keepTemporaryFiles,
            model: command.flags.model,
            verbose: command.flags.verbose,
            pricingSnapshot: loadUsagePricing(context.env, context.workspaceRoot) ?? undefined,
            signal: context.signal,
            executors: context.executors,
            blockerModules: context.blockerModules,
            lintCommand: context.lintCommand,
        },
        {
            ...dependencies.liveCycleDependencies,
            loadLocalCoreConfig: () => loadLocal(context.env),
        },
    );
    return {
        result,
        outputDir,
        cycleResultPath: join(outputDir, 'cycle-result.json'),
    };
}
