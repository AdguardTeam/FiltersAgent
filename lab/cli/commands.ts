/**
 * Central definition of the agent's top-level CLI commands.
 *
 * Keeping the command names in one const object avoids magic strings scattered across the CLI
 * parser ({@link module:cli/program}), the command dispatcher (`main.ts`), and tests. Named members
 * (e.g. {@link CommandName.Show}) are used at comparison sites; the derived {@link CommandName} union
 * is used in type positions.
 */

/**
 * The top-level commands accepted by the agent CLI.
 *
 * Each value is the exact string the user types on the command line and that commander registers as
 * a subcommand. `fix`/`show` share an `issue <number>` subcommand shape; `repo` has its own
 * `search`/`map` subcommands, `policy` has its own `check` subcommand, and `export` uses a
 * dedicated read-only snapshot interface. These groups are registered separately in
 * {@link module:cli/program}.
 */
export const CommandName = {
    /**
     * Run the browser-first fix investigation without publishing directly.
     */
    Fix: 'fix',

    /**
     * Fetch an issue and print its LLM-extracted report; read-only, but needs the LLM config and
     * costs tokens.
     */
    Show: 'show',

    /**
     * Export a read-only GitHub issue snapshot for local browser-first runs.
     */
    Export: 'export',

    /**
     * Process open issues without an agent report, newest first, bounded by a limit.
     */
    Backlog: 'backlog',

    /**
     * Repo context tools (search rules / generate placement map).
     */
    Repo: 'repo',
} as const;

/**
 * A single top-level CLI command name (one of the {@link CommandName} values).
 */
export type CommandName = (typeof CommandName)[keyof typeof CommandName];

/**
 * Subcommands of the `repo` CLI command.
 */
export const RepoSubcommand = {
    /**
     * Search AdguardFilters by domain, selector, URL pattern, or scriptlet.
     */
    Search: 'search',

    /**
     * Print the repository map used for placement decisions.
     */
    Map: 'map',
} as const;

/**
 * RepoSubcommand value.
 */
export type RepoSubcommand = (typeof RepoSubcommand)[keyof typeof RepoSubcommand];

/**
 * Human-facing description for every top-level CLI command, keyed by command name. The program
 * builder and the command-definition modules share it, so one command keeps one description.
 */
export const COMMAND_DESCRIPTIONS: Record<CommandName, string> = {
    [CommandName.Fix]: 'Run a browser-first fix investigation without publishing directly',
    [CommandName.Show]:
        'Run an LLM extraction of the issue and print its report (read-only; needs the LLM config and costs tokens)',
    [CommandName.Export]: 'Export an auditable issue snapshot for a local run (read-only)',
    [CommandName.Backlog]:
        'Process open issues without an agent report, newest first, bounded by a limit',
    [CommandName.Repo]: 'Repo context tools (search rules / generate placement map)',
};
