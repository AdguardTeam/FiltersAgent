import {
    buildProgram,
    type BacklogParsedCommand,
    type ParsedCommand,
    type ExportParsedCommand,
    type RepoParsedCommand,
} from './program';
import { CommandName, RepoSubcommand } from './commands';
import { normalizePackageManagerArgv } from './argv';
import { loadConfig, loadCoreConfig, ConfigError, type AppConfig } from '../../src/config/config';
import type { RepositoryIdentitySources } from '../../src/config/repository-identity';
import { createLogger, type Logger } from '../../src/logger/logger';
import { fetchIssue } from '../../src/github/fetch-issue';
import { buildRepoSearchHandler, runRepoMap } from '../repo/repo-handlers';
import { runExportIssueCommand } from './local-cycle-commands';
import { printAgentEntryResult, printBacklogEntryResult } from './print-helpers';
import { AgentEntryExitCode, runFiltersAgentEntry } from '../../src/entry/entry-run';
import {
    createLabBacklogEntryInputs,
    createLabFixEntryDelegate,
    type LabEntryDelegateDependencies,
} from './entry-delegate';
import {
    createBlockerModuleRunIssue,
    type BlockerModuleRunIssueDependencies,
} from '../../src/proxy-blocker/blocker-module-run-issue';
import { startAdguardCliBlocker } from '../../src/adguard-cli/adguard-cli-module';
import { AdguardCliExecutorName } from '../../src/adguard-cli/executor-name';
import {
    createPiRuntimeFromConfig,
    createConfiguredSingleShotClient,
} from '../../src/pi/llm-wiring';
import { extractReport, IntakeExtractionKind } from '../../src/intake/extract-report';
import type { MainRuntimeContext } from './main-secret-boundary';
import type { GitCheckoutOriginReader } from './repository-origin';
import { readCheckoutOriginUrl } from './repository-origin';

/**
 * Injectable seams of the command runtime. The checkout-origin git adapter feeds identity sources,
 * and the optional lab delegation seams let deterministic tests inject the cycle boundary.
 */
export interface MainRuntimeDependencies {
    /**
     * Injectable checkout-origin reader used as an identity source; production spawns `git remote
     * get-url origin` on the `REPOSITORY_PATH` checkout.
     */
    gitCheckoutOriginReader?: GitCheckoutOriginReader;

    /**
     * Lab delegation seams forwarded into the shared agent entry from the fix and backlog faces.
     */
    entryDelegate?: LabEntryDelegateDependencies;

    /**
     * Injectable seams of the backlog's AdGuard CLI-wired per-issue engine; production passes
     * nothing.
     */
    backlogRunIssue?: BlockerModuleRunIssueDependencies;
}

/**
 * Build the repository-identity sources one non-fix command run feeds into its configuration
 * loader: the parsed `--repository` flag directly, and the checkout origin resolved in this CLI
 * seam only.
 *
 * @param repository - The parsed `--repository` flag value, when given.
 * @param context - Secret-free runtime context with sanitized writers.
 * @param dependencies - Injectable command-runtime seams.
 * @returns The identity sources for the loader.
 */
function repositoryIdentitySources(
    repository: string | undefined,
    context: MainRuntimeContext,
    dependencies: MainRuntimeDependencies,
): RepositoryIdentitySources {
    return {
        flag: repository,
        checkoutOriginUrl: readCheckoutOriginUrl(context.env, dependencies.gitCheckoutOriginReader),
    };
}

/**
 * Fetch an issue, extract the model-filled report, and print it (read-only).
 *
 * The extraction needs LLM configuration; the skip variant prints the reason instead of a report.
 * Makes NO GitHub writes — `fetchIssue` only reads the issue and its comments.
 *
 * @param config - The validated application config.
 * @param issueNumber - The issue number to show.
 * @param context - Secret-free runtime context with sanitized writers.
 * @param logger - Diagnostics sink for the extraction.
 */
async function showIssue(
    config: AppConfig,
    issueNumber: number,
    context: MainRuntimeContext,
    logger: Logger,
): Promise<void> {
    const raw = await fetchIssue(config.github, issueNumber);
    const runtime = await createPiRuntimeFromConfig(config.llm);
    const client = createConfiguredSingleShotClient(runtime, runtime.reasoningModel, config.llm, {
        logger,
    });
    const outcome = await extractReport(raw, { client, logger, signal: context.signal });
    if (outcome.kind === IntakeExtractionKind.Report) {
        context.stdout.write(JSON.stringify(outcome.report, null, 2) + '\n');
        return;
    }
    context.stdout.write(`Issue #${issueNumber} skipped: ${outcome.reason}\n`);
}

/**
 * Execute the parsed CLI command.
 *
 * @param parsed - The successfully parsed command with issue number and flags.
 * @param context - Secret-free runtime context with sanitized writers.
 * @param dependencies - Injectable command-runtime seams.
 */
async function runCommand(
    parsed: ParsedCommand,
    context: MainRuntimeContext,
    dependencies: MainRuntimeDependencies = {},
): Promise<void> {
    const logger = createLogger({ verbose: parsed.flags.verbose });

    if (parsed.command === CommandName.Fix) {
        const delegate = createLabFixEntryDelegate(
            parsed,
            {
                env: context.env as Record<string, string | undefined>,
                workspaceRoot: context.workspaceRoot,
                signal: context.signal,
            },
            dependencies.entryDelegate,
        );
        const result = await runFiltersAgentEntry(delegate.inputs, delegate.dependencies);
        logger.info(
            {
                command: parsed.command,
                issueNumber: parsed.issueNumber,
                entryStatus: result.status,
                exitCode: result.exitCode,
            },
            'agent entry run sealed',
        );
        printAgentEntryResult(result, context, parsed.flags.output);
        // Lab `fix` exits 0 for any sealed cycle. A caller that retries on a non-zero exit would
        // start a second attempt, whose `runExportedSnapshotCycle` clears the output directory
        // first — deleting the first attempt's `cycle-result.json` before anyone reads it. The
        // outcome lives in that file's own `status` field instead, so a typed per-issue outcome
        // recorded here — an unsupported report, a bounded infrastructure failure, anything short
        // of a raw uncaught exception — must still leave the process exit at zero. Only a throw out of
        // `runFiltersAgentEntry` above (caught by `runMainRuntime`'s dispatch, never reaching this
        // line) is an unsealed crash and gets the non-zero exit. `result.exitCode` stays
        // informational here (logged above); it drives the backlog and action faces
        // (`printBacklogEntryResult`, `action-main.ts`), never the lab `fix` exit code.
        return;
    }

    let config: AppConfig;
    try {
        config = loadConfig(
            context.env as Record<string, string | undefined>,
            repositoryIdentitySources(parsed.flags.repository, context, dependencies),
        );
    } catch (err) {
        if (err instanceof ConfigError) {
            context.stderr.write(`${err.message}\n`);
            context.setFailureExitCode();
        }
        throw err;
    }

    logger.info(
        {
            command: parsed.command,
            issueNumber: parsed.issueNumber,
            dryRun: parsed.flags.dryRun,
            repo: `${config.github.owner}/${config.github.repo}`,
            model: parsed.flags.model ?? config.llm.model,
        },
        'agent starting',
    );

    if (parsed.command === CommandName.Show) {
        await showIssue(config, parsed.issueNumber, context, logger);
        return;
    }
}

/**
 * Dispatch a parsed `repo` command: load the core configuration (no GitHub section required — repo
 * commands read only the checkout path and never the GitHub-reading configuration, whose repository
 * identity is mandatory) and route to the search or map handler. Errors are reported to stderr with
 * a non-zero exit.
 *
 * @param repoCmd - The parsed `repo` CLI command.
 * @param context - Secret-free runtime context with sanitized writers.
 */
async function handleRepoCommand(
    repoCmd: RepoParsedCommand,
    context: MainRuntimeContext,
): Promise<void> {
    let config;
    try {
        config = loadCoreConfig(context.env as Record<string, string | undefined>);
    } catch (err) {
        reportError(err, context);
        return;
    }
    if (repoCmd.subcommand === RepoSubcommand.Search) {
        await buildRepoSearchHandler(config)(repoCmd);
    } else {
        await runRepoMap(config);
    }
}

/**
 * Export one GitHub issue into an external, auditable local replay bundle.
 *
 * This path loads only GitHub read credentials: it requires no LLM configuration and performs no
 * GitHub writes.
 *
 * @param exportCmd - Parsed issue number, output directory, and trusted exclusions.
 * @param context - Secret-free runtime context with sanitized writers.
 */
async function handleExportCommand(
    exportCmd: ExportParsedCommand,
    context: MainRuntimeContext,
): Promise<void> {
    const exported = await runExportIssueCommand(exportCmd, {
        env: context.env as Record<string, string | undefined>,
        workspaceRoot: context.workspaceRoot,
        signal: context.signal,
    });
    context.stdout.write(`Local issue snapshot written to: ${exported.snapshotPath}\n`);
    context.stdout.write(`Downloaded user images: ${exported.snapshot.attachments.length}\n`);
}

/**
 * Run the backlog command through the shared agent entry: the resolver validates the shared input
 * surface (the lab inherits the combined mandatory-input checks), the per-issue engine is the
 * public composition wrapped with the lab's own AdGuard CLI wiring so a locked `adguard_cli`
 * selection activates against this run's configuration instead of the module state only `fix`'s
 * local cycle used to set, and the exit contract follows the result's exit code.
 *
 * @param backlogCmd - Parsed backlog queue run.
 * @param context - Secret-free runtime context with sanitized writers.
 * @param dependencies - Injectable command-runtime seams.
 */
async function handleBacklogCommand(
    backlogCmd: BacklogParsedCommand,
    context: MainRuntimeContext,
    dependencies: MainRuntimeDependencies,
): Promise<void> {
    const inputs = createLabBacklogEntryInputs(
        backlogCmd,
        {
            env: context.env as Record<string, string | undefined>,
            workspaceRoot: context.workspaceRoot,
        },
        dependencies.entryDelegate,
    );
    const env = context.env as Record<string, string | undefined>;
    const logger = createLogger();
    const runIssue = createBlockerModuleRunIssue(
        context.workspaceRoot,
        [
            {
                executor: AdguardCliExecutorName,
                startBlocker: (workspaceDir) => startAdguardCliBlocker(env, workspaceDir, logger),
            },
        ],
        dependencies.backlogRunIssue,
    );
    const result = await runFiltersAgentEntry(inputs, { runIssue });
    printBacklogEntryResult(result, context);
    if (result.exitCode !== AgentEntryExitCode.Success) {
        context.setFailureExitCode();
    }
}

/**
 * Write an error's message to stderr and set a non-zero exit code.
 *
 * @param err - The error caught from an async command handler.
 * @param context - Secret-free runtime context with sanitized writers.
 */
function reportError(err: unknown, context: MainRuntimeContext): void {
    context.stderr.write(`${(err as Error).message ?? err}\n`);
    context.setFailureExitCode();
}

/**
 * Parse, dispatch, and await one complete command while the outer secret scope remains live.
 *
 * @param context - Frozen secret-free environment, opaque capabilities, signal, and safe writers.
 * @param dependencies - Injectable command-runtime seams.
 */
export async function runMainRuntime(
    context: MainRuntimeContext,
    dependencies: MainRuntimeDependencies = {},
): Promise<void> {
    let completion = Promise.resolve();
    buildProgram(
        (parsed) => {
            completion = runCommand(parsed, context, dependencies).catch((error) =>
                reportError(error, context),
            );
        },
        {},
        (repoCommand) => {
            completion = handleRepoCommand(repoCommand, context).catch((error) =>
                reportError(error, context),
            );
        },
        (exportCommand) => {
            completion = handleExportCommand(exportCommand, context).catch((error) =>
                reportError(error, context),
            );
        },
        (backlogCommand) => {
            completion = handleBacklogCommand(backlogCommand, context, dependencies).catch(
                (error) => reportError(error, context),
            );
        },
    ).parse(normalizePackageManagerArgv([...context.argv]));
    await completion;
}
