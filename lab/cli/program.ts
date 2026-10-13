import { Command } from 'commander';
import * as v from 'valibot';
import { COMMAND_DESCRIPTIONS, CommandName, RepoSubcommand } from './commands';
import { registerToolingCommands } from './tooling-commands';
import type { SearchQuery } from '../../src/types/repo-context';
import { REPOSITORY_SLUG_PATTERN } from '../../src/types/repository-slug';
import { BrowserMode } from '../../src/types/browser-mode';
import { ExtensionEnvironmentKind } from '../../src/types/extension-environment-kind';

/**
 * Repository/filter time horizon used by a local browser-first run.
 */
export type LocalRunEnvironment = ExtensionEnvironmentKind;

/**
 * A successfully parsed CLI invocation.
 */
export interface ParsedCommand {
    /**
     * The top-level command that was invoked.
     */
    command: CommandName;

    /**
     * The issue number parsed from the `<number>` argument.
     */
    issueNumber: number;

    /**
     * CLI flags passed after the issue number.
     */
    flags: {
        /**
         * Run the full investigation but make no writes.
         */
        dryRun: boolean;

        /**
         * Override the LLM model for this run.
         */
        model?: string;

        /**
         * Enable debug-level logging.
         */
        verbose: boolean;

        /**
         * Browser execution policy for this run.
         */
        browserMode: BrowserMode;

        /**
         * Stop right after the environment selection is accepted.
         */
        routingCheck?: boolean;

        /**
         * Path where a serialized fix result should be written.
         */
        output?: string;

        /**
         * Local raw issue snapshot used instead of GitHub reads.
         */
        issueFile?: string;

        /**
         * Current or historical browser/filter environment.
         */
        environment: LocalRunEnvironment;

        /**
         * Directory where local report and evidence files are written.
         */
        outputDir?: string;

        /**
         * Local current/historical extension and filters configuration file.
         */
        runConfig?: string;

        /**
         * Repository identity override as `owner/repo`; also read from the environment or the
         * checkout origin when absent.
         */
        repository?: string;

        /**
         * Comma-separated executor names this run locks; absent hands the declared lab set to the
         * entry resolver.
         */
        executors?: string;

        /**
         * Whether the temporary disposable checkouts should be retained for debugging.
         */
        keepTemporaryFiles: boolean;

        /**
         * Path of the run instruction file, relative to the checkout; absent loads the checkout's
         * default instruction when present.
         */
        instructionPath?: string;

        /**
         * The repository's own lint command line, run over each candidate rule; absent runs no
         * lint.
         */
        lintCommand?: string;

        /**
         * Skip posting the report as an issue comment; the report is still written to the artifacts
         * directory.
         */
        noComment: boolean;
    };
}

/**
 * A parsed read-only GitHub issue export command.
 */
export interface ExportParsedCommand {
    /**
     * GitHub issue number to export.
     */
    issueNumber: number;

    /**
     * Absolute external directory where the replay bundle will be written.
     */
    outputDir: string;

    /**
     * Trusted human-solution comment identities excluded only from agent-visible context.
     */
    humanSolutionComments: Array<{
        /**
         * GitHub login of the solution author.
         */
        author: string;

        /**
         * Immutable GitHub comment creation timestamp.
         */
        createdAt: string;
    }>;

    /**
     * Additional trusted automation logins excluded from agent-visible context.
     */
    additionalBotAuthors: string[];

    /**
     * Repository identity override as `owner/repo`; also read from the environment or the checkout
     * origin when absent.
     */
    repository?: string;

    /**
     * Whether the persisted bundle must omit raw comments, markers, and hidden attachments.
     */
    promptSafeOnly: boolean;
}

/**
 * A successfully parsed `backlog` read-write local queue invocation.
 */
export interface BacklogParsedCommand {
    /**
     * Backlog command discriminator.
     */
    command: typeof CommandName.Backlog;

    /**
     * Backlog run controls.
     */
    flags: {
        /**
         * Maximum open issues one run processes; absent falls back to the queue default.
         */
        limit?: number;

        /**
         * Repository identity override as `owner/repo`; also read from the environment or the
         * checkout origin when absent.
         */
        repository?: string;

        /**
         * Explicit artifacts directory; mandatory for a backlog run.
         */
        outputDir?: string;

        /**
         * Optional reasoning model override.
         */
        model?: string;

        /**
         * Comma-separated executor names each per-issue run locks; absent hands the declared lab
         * set to the entry resolver.
         */
        executors?: string;

        /**
         * Comma-separated GitHub author-association names trusted to change a backlog issue's
         * revision; absent falls back to the queue default.
         */
        trustedRoles?: string;

        /**
         * Maximum revision-marked reports one backlog issue may receive inside the rolling window;
         * absent falls back to the queue default.
         */
        maxRevisionsPerWindow?: number;

        /**
         * Length of the rolling revision-budget window, in milliseconds; absent falls back to the
         * queue default.
         */
        revisionWindowMs?: number;

        /**
         * Whether verbose operational logging is enabled.
         */
        verbose: boolean;

        /**
         * Path of the run instruction file, relative to the checkout; absent loads the checkout's
         * default instruction when present.
         */
        instructionPath?: string;

        /**
         * The repository's own lint command line, run over each candidate rule; absent runs no
         * lint.
         */
        lintCommand?: string;

        /**
         * Skip posting the report as an issue comment; the report is still written to the artifacts
         * directory.
         */
        noComment: boolean;
    };
}

/**
 * A successfully parsed `repo` CLI invocation.
 *
 * The `repo` command group does not take an issue number; it exposes `search` (find existing rules)
 * and `map` (generate placement-map.json).
 */
export type RepoParsedCommand =
    | {
          /**
           * The repo subcommand that was invoked.
           */
          subcommand: typeof RepoSubcommand.Search;

          /**
           * The parsed search query.
           */
          query: SearchQuery;

          /**
           * Whether verbose logging is enabled.
           */
          verbose: boolean;
      }
    | {
          /**
           * The repo subcommand that was invoked.
           */
          subcommand: typeof RepoSubcommand.Map;

          /**
           * Whether verbose logging is enabled.
           */
          verbose: boolean;
      };

/**
 * Hooks used by tests to make commander throw instead of exiting, and to mute output.
 */
export interface BuildProgramOptions {
    /**
     * When true, commander throws `CommanderError` instead of calling `process.exit`.
     */
    exitOverride?: boolean;

    /**
     * When true, commander output (stdout/stderr) is suppressed.
     */
    suppressOutput?: boolean;
}

/**
 * Options for the action callback as parsed by commander.
 */
export interface ActionOpts {
    /**
     * Whether to run in dry-run mode (no writes).
     */
    dryRun?: boolean;

    /**
     * Stop right after the environment selection is accepted.
     */
    routingCheck?: boolean;

    /**
     * Model override name.
     */
    model?: string;

    /**
     * Whether verbose logging is enabled.
     */
    verbose?: boolean;

    /**
     * Requested browser execution policy.
     */
    browser?: string;

    /**
     * Path for serialized run output.
     */
    output?: string;

    /**
     * Path to a local raw issue snapshot.
     */
    issueFile?: string;

    /**
     * Requested local run environment.
     */
    environment?: string;

    /**
     * Directory for local run outputs.
     */
    outputDir?: string;

    /**
     * Path to the filters provenance configuration.
     */
    runConfig?: string;

    /**
     * Repository identity override as `owner/repo`.
     */
    repository?: string;

    /**
     * Comma-separated executor names this run locks.
     */
    executors?: string;

    /**
     * Whether to retain the temporary disposable checkouts.
     */
    keepTemporaryFiles?: boolean;

    /**
     * Path of the run instruction file, relative to the checkout.
     */
    instruction?: string;

    /**
     * The repository's own lint command line (`--lint-command`).
     */
    lintCommand?: string;

    /**
     * Commander's negated attribute for `--no-comment`: defaults `true`, becomes `false` when the
     * flag is passed.
     */
    comment?: boolean;
}

/**
 * Options parsed for the read-only `export issue` command.
 */
interface ExportActionOpts {
    /**
     * Absolute destination directory for the local replay bundle.
     */
    outputDir: string;

    /**
     * Repeated `author@created-at` human-solution identities.
     */
    humanSolutionComment: string[];

    /**
     * Repeated additional bot login exclusions.
     */
    additionalBot: string[];

    /**
     * Repository identity override as `owner/repo`.
     */
    repository?: string;

    /**
     * Whether to persist only the model-safe issue subset.
     */
    promptSafeOnly: boolean;
}

/**
 * Options parsed for the backlog command.
 */
interface BacklogActionOpts {
    /**
     * Maximum open issues one run processes.
     */
    limit?: string;

    /**
     * Repository identity override as `owner/repo`.
     */
    repository?: string;

    /**
     * Explicit artifacts directory.
     */
    outputDir?: string;

    /**
     * Optional reasoning model override.
     */
    model?: string;

    /**
     * Comma-separated executor names each per-issue run locks.
     */
    executors?: string;

    /**
     * Comma-separated GitHub author-association names trusted to change a backlog issue's revision;
     * absent falls back to the queue default.
     */
    trustedRoles?: string;

    /**
     * Maximum revision-marked reports one backlog issue may receive inside the rolling window;
     * absent falls back to the queue default.
     */
    maxRevisionsPerWindow?: string;

    /**
     * Length of the rolling revision-budget window, in milliseconds; absent falls back to the queue
     * default.
     */
    revisionWindowMs?: string;

    /**
     * Whether verbose operational logging is enabled.
     */
    verbose?: boolean;

    /**
     * Path of the run instruction file, relative to the checkout.
     */
    instruction?: string;

    /**
     * The repository's own lint command line (`--lint-command`).
     */
    lintCommand?: string;

    /**
     * Commander's negated attribute for `--no-comment`: defaults `true`, becomes `false` when the
     * flag is passed.
     */
    comment?: boolean;
}

/**
 * Help text of the `--lint-command` option the `fix` and `backlog` commands share.
 */
const LINT_COMMAND_OPTION_HELP =
    "The repository's own lint command line, run in the checkout over each candidate rule with " +
    "the candidate file's path appended; unset runs no lint";

/**
 * Accumulate one repeated Commander option without mutating the previous array.
 *
 * @param value - Newly parsed option value.
 * @param previous - Values parsed earlier in the same invocation.
 * @returns A new array containing every parsed value.
 */
function collectOption(value: string, previous: string[]): string[] {
    return [...previous, value];
}

/**
 * Reject a `--repository` value that is not an `owner/repo` slug, so a malformed identity is caught
 * at parse time with its own error code instead of failing later at load.
 *
 * @param cmd - The commander command, used to raise the parse error.
 * @param repository - The parsed `--repository` value, when given.
 */
function errorOnMalformedRepository(cmd: Command, repository: string | undefined): void {
    if (repository !== undefined && !REPOSITORY_SLUG_PATTERN.test(repository)) {
        cmd.error(`error: invalid repository identity '${repository}'`, {
            code: 'agent.invalidRepositoryIdentity',
        });
    }
}

/**
 * Parse the stable identity used to exclude one known human-solution comment.
 *
 * @param value - CLI value in `github-login@ISO-timestamp` form.
 * @returns Parsed identity, or null when the value is ambiguous or malformed.
 */
function parseHumanSolutionIdentity(
    value: string,
): ExportParsedCommand['humanSolutionComments'][number] | null {
    const separator = value.indexOf('@');
    if (separator <= 0 || separator !== value.lastIndexOf('@')) {
        return null;
    }
    const author = value.slice(0, separator).trim();
    const createdAt = value.slice(separator + 1).trim();
    if (!/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(author)) {
        return null;
    }
    if (!v.safeParse(v.pipe(v.string(), v.isoTimestamp()), createdAt).success) {
        return null;
    }
    return { author, createdAt };
}

/**
 * Build the commander program for the agent CLI.
 *
 * @param onCommand - Called with the parsed command when a subcommand runs.
 * @param options - Optional test hooks (exit override / output suppression).
 * @param onRepoCommand - Called with a parsed `repo` command (search/map). Optional.
 * @param onExportCommand - Called with a parsed read-only issue export. Optional.
 * @param onBacklogCommand - Called with a parsed backlog queue run. Optional.
 * @returns A configured commander `Command`; call `.parse()` on it.
 */
export function buildProgram(
    onCommand: (parsed: ParsedCommand) => void,
    options: BuildProgramOptions = {},
    onRepoCommand?: (parsed: RepoParsedCommand) => void,
    onExportCommand?: (parsed: ExportParsedCommand) => void,
    onBacklogCommand?: (parsed: BacklogParsedCommand) => void,
): Command {
    const configure = (command: Command): Command => {
        if (options.exitOverride) {
            command.exitOverride();
        }
        if (options.suppressOutput) {
            command.configureOutput({ writeOut: () => {}, writeErr: () => {} });
        }
        return command;
    };

    const program = configure(new Command());
    program
        .name('filters-agent')
        .description('AdGuard Filters Agent — fix a single issue')
        .showHelpAfterError();

    for (const name of Object.values(CommandName)) {
        if (
            name === CommandName.Repo ||
            name === CommandName.Export ||
            name === CommandName.Backlog
        ) {
            continue;
        }
        const parent = configure(program.command(name).description(COMMAND_DESCRIPTIONS[name]));
        configure(parent.command('issue <number>'))
            .description(`Run "${name}" against issue <number>`)
            .option('--dry-run', 'Compatibility flag; fix analysis never publishes directly', false)
            .option('--model <name>', 'Override the LLM model for this run')
            .option(
                '--executors <names>',
                'Comma-separated executor names this run locks; absent locks the declared lab set',
            )
            .option('--verbose', 'Verbose (debug-level) logging', false)
            .option('--browser <mode>', 'Browser mode (auto, on, off)', 'auto')
            .option(
                '--routing-check',
                'Stop right after the agent locks its environment selection',
                false,
            )
            .option('--output <path>', 'Write an unlocked compatibility copy of the fix result')
            .option('--issue-file <path>', 'Read the issue from a local snapshot instead of GitHub')
            .option(
                '--environment <mode>',
                'Local environment (current or historical)',
                ExtensionEnvironmentKind.Current,
            )
            .option(
                '--output-dir <path>',
                'Write local output (default: ./tmp/adguard-agent-runs/issue-<n>-<environment>)',
            )
            .option('--run-config <path>', 'Read the filters provenance from the JSON case file')
            .option(
                '--repository <owner/repo>',
                'Repository identity override; also read from GITHUB_REPO_OWNER/GITHUB_REPO_NAME, GITHUB_REPOSITORY, or the checkout origin',
            )
            .option(
                '--keep-temporary-files',
                'Retain the disposable checkouts for debugging',
                false,
            )
            .option(
                '--instruction <path>',
                'Path of the run instruction file, relative to the checkout; when unset, the ' +
                    "checkout's default instruction at .github/filters-agent/AGENTS.md is loaded " +
                    'when present',
            )
            .option('--lint-command <command>', LINT_COMMAND_OPTION_HELP)
            .option(
                '--no-comment',
                'Skip posting the report as an issue comment; the report is still written to the ' +
                    'artifacts directory',
            )
            .action((numberRaw: string, opts: ActionOpts, cmd: Command) => {
                const issueNumber = Number(numberRaw);
                if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
                    cmd.error(`error: invalid issue number '${numberRaw}'`, {
                        code: 'agent.invalidIssue',
                    });
                    return;
                }
                errorOnMalformedRepository(cmd, opts.repository);
                if (!['auto', 'on', 'off'].includes(opts.browser ?? 'auto')) {
                    cmd.error(`error: invalid browser mode '${opts.browser}'`, {
                        code: 'agent.invalidBrowserMode',
                    });
                    return;
                }
                if (name === CommandName.Fix && opts.browser === BrowserMode.Off) {
                    cmd.error('error: fix is browser-first; --browser must be auto or on', {
                        code: 'agent.invalidBrowserMode',
                    });
                    return;
                }
                const validLocalEnvironments: string[] = [
                    ExtensionEnvironmentKind.Current,
                    ExtensionEnvironmentKind.Historical,
                ];
                if (
                    !validLocalEnvironments.includes(
                        opts.environment ?? ExtensionEnvironmentKind.Current,
                    )
                ) {
                    cmd.error(`error: invalid local environment '${opts.environment}'`, {
                        code: 'agent.invalidEnvironment',
                    });
                    return;
                }
                if (
                    !opts.issueFile &&
                    (name === CommandName.Fix
                        ? opts.environment === ExtensionEnvironmentKind.Historical ||
                          opts.runConfig !== undefined
                        : cmd.getOptionValueSource('environment') === 'cli' ||
                          opts.outputDir !== undefined ||
                          opts.runConfig !== undefined ||
                          opts.keepTemporaryFiles === true)
                ) {
                    cmd.error('error: live runs do not accept historical options', {
                        code: 'agent.invalidLocalRun',
                    });
                    return;
                }
                if (opts.issueFile && name !== CommandName.Fix) {
                    cmd.error('error: --issue-file is supported only by the fix command', {
                        code: 'agent.invalidLocalRun',
                    });
                    return;
                }
                if (
                    opts.issueFile &&
                    opts.environment === ExtensionEnvironmentKind.Historical &&
                    !opts.runConfig
                ) {
                    cmd.error('error: historical local runs require --run-config', {
                        code: 'agent.invalidLocalRun',
                    });
                    return;
                }
                onCommand({
                    command: name,
                    issueNumber,
                    flags: {
                        dryRun: Boolean(opts.dryRun),
                        model: opts.model,
                        verbose: Boolean(opts.verbose),
                        browserMode: (opts.browser ?? 'auto') as BrowserMode,
                        routingCheck: opts.routingCheck === true,
                        output: opts.output,
                        issueFile: opts.issueFile,
                        environment: (opts.environment ??
                            ExtensionEnvironmentKind.Current) as LocalRunEnvironment,
                        outputDir: opts.outputDir,
                        runConfig: opts.runConfig,
                        repository: opts.repository,
                        executors: opts.executors,
                        keepTemporaryFiles: Boolean(opts.keepTemporaryFiles),
                        instructionPath: opts.instruction,
                        lintCommand: opts.lintCommand,
                        // Commander negates a `--no-x` flag onto the positive attribute `x`
                        // (defaulting true), so `opts.comment === false` is exactly "the flag was
                        // passed".
                        noComment: opts.comment === false,
                    },
                });
            });
    }

    const backlogCommand = configure(
        program.command(CommandName.Backlog).description(COMMAND_DESCRIPTIONS[CommandName.Backlog]),
    );
    configure(backlogCommand)
        .option('--limit <n>', 'Process at most this many open issues (default: the queue limit)')
        .option(
            '--repository <owner/repo>',
            'Repository identity override; also read from GITHUB_REPO_OWNER/GITHUB_REPO_NAME, GITHUB_REPOSITORY, or the checkout origin',
        )
        .option(
            '--output-dir <path>',
            'Explicit artifacts directory; every per-issue run writes beneath it',
        )
        .option('--model <name>', 'Override the LLM model for this run')
        .option(
            '--executors <names>',
            'Comma-separated executor names each per-issue run locks; absent locks the declared lab set',
        )
        .option(
            '--trusted-roles <names>',
            'Comma-separated GitHub author associations trusted to change a backlog revision (default: OWNER,MEMBER,COLLABORATOR)',
        )
        .option(
            '--max-revisions-per-window <n>',
            'Maximum revision-marked reports one backlog issue may receive inside the rolling window (default: the queue limit)',
        )
        .option(
            '--revision-window-ms <ms>',
            'Length of the rolling revision-budget window, in milliseconds (default: the queue window)',
        )
        .option('--verbose', 'Verbose (debug-level) logging', false)
        .option(
            '--instruction <path>',
            'Path of the run instruction file, relative to the checkout; when unset, the ' +
                "checkout's default instruction at .github/filters-agent/AGENTS.md is loaded " +
                'when present',
        )
        .option('--lint-command <command>', LINT_COMMAND_OPTION_HELP)
        .option(
            '--no-comment',
            'Skip posting the report as an issue comment; the report is still written to the ' +
                'artifacts directory',
        )
        .action((opts: BacklogActionOpts, cmd: Command) => {
            errorOnMalformedRepository(cmd, opts.repository);
            let limit: number | undefined;
            if (opts.limit !== undefined) {
                const parsed = Number(opts.limit);
                if (!Number.isInteger(parsed) || parsed <= 0) {
                    cmd.error(`error: invalid limit '${opts.limit}'`, {
                        code: 'agent.invalidLimit',
                    });
                    return;
                }
                limit = parsed;
            }
            let maxRevisionsPerWindow: number | undefined;
            if (opts.maxRevisionsPerWindow !== undefined) {
                const parsed = Number(opts.maxRevisionsPerWindow);
                if (!Number.isInteger(parsed) || parsed <= 0) {
                    cmd.error(
                        `error: invalid max-revisions-per-window '${opts.maxRevisionsPerWindow}'`,
                        { code: 'agent.invalidMaxRevisionsPerWindow' },
                    );
                    return;
                }
                maxRevisionsPerWindow = parsed;
            }
            let revisionWindowMs: number | undefined;
            if (opts.revisionWindowMs !== undefined) {
                const parsed = Number(opts.revisionWindowMs);
                if (!Number.isInteger(parsed) || parsed <= 0) {
                    cmd.error(`error: invalid revision-window-ms '${opts.revisionWindowMs}'`, {
                        code: 'agent.invalidRevisionWindowMs',
                    });
                    return;
                }
                revisionWindowMs = parsed;
            }
            onBacklogCommand?.({
                command: CommandName.Backlog,
                flags: {
                    limit,
                    repository: opts.repository,
                    outputDir: opts.outputDir,
                    model: opts.model,
                    executors: opts.executors,
                    trustedRoles: opts.trustedRoles,
                    maxRevisionsPerWindow,
                    revisionWindowMs,
                    verbose: Boolean(opts.verbose),
                    instructionPath: opts.instruction,
                    lintCommand: opts.lintCommand,
                    // Commander negates a `--no-x` flag onto the positive attribute `x`
                    // (defaulting true), so `opts.comment === false` is exactly "the flag was
                    // passed".
                    noComment: opts.comment === false,
                },
            });
        });

    const exportCommand = configure(
        program.command(CommandName.Export).description(COMMAND_DESCRIPTIONS[CommandName.Export]),
    );
    configure(exportCommand.command('issue <number>'))
        .description('Export a complete GitHub issue and its user images without GitHub writes')
        .requiredOption('--output-dir <path>', 'Write the replay bundle outside the workspace')
        .option(
            '--human-solution-comment <author@created-at>',
            'Exclude a trusted human solution from prompt context while retaining it raw',
            collectOption,
            [],
        )
        .option(
            '--additional-bot <login>',
            'Exclude an additional trusted automation login from prompt context',
            collectOption,
            [],
        )
        .option(
            '--repository <owner/repo>',
            'Repository identity override; also read from GITHUB_REPO_OWNER/GITHUB_REPO_NAME, GITHUB_REPOSITORY, or the checkout origin',
        )
        .option(
            '--prompt-safe-only',
            'Persist only marker-free reporter context and prompt-visible attachments',
            false,
        )
        .action((numberRaw: string, opts: ExportActionOpts, cmd: Command) => {
            const issueNumber = Number(numberRaw);
            if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
                cmd.error(`error: invalid issue number '${numberRaw}'`, {
                    code: 'agent.invalidIssue',
                });
                return;
            }
            errorOnMalformedRepository(cmd, opts.repository);
            const humanSolutionComments = opts.humanSolutionComment.map(parseHumanSolutionIdentity);
            if (humanSolutionComments.some((identity) => identity === null)) {
                cmd.error('error: --human-solution-comment must use github-login@ISO-timestamp', {
                    code: 'agent.invalidCommentIdentity',
                });
                return;
            }
            if (opts.additionalBot.some((author) => !/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(author))) {
                cmd.error('error: --additional-bot must be a GitHub login', {
                    code: 'agent.invalidBotAuthor',
                });
                return;
            }
            onExportCommand?.({
                issueNumber,
                outputDir: opts.outputDir,
                humanSolutionComments: humanSolutionComments.filter(
                    (identity): identity is ExportParsedCommand['humanSolutionComments'][number] =>
                        identity !== null,
                ),
                additionalBotAuthors: opts.additionalBot,
                repository: opts.repository,
                promptSafeOnly: Boolean(opts.promptSafeOnly),
            });
        });

    registerToolingCommands(program, configure, {
        onRepoCommand,
    });

    return program;
}
