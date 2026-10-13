/**
 * Command definitions for the lab CLI's deterministic tooling group `repo` (search / map). It is
 * read-only and never performs writes; it registers commander options and hands its parsed
 * invocation to the handler supplied by `buildProgram`, keeping the program assembly distinct from
 * this group.
 */

import { Command } from 'commander';
import { COMMAND_DESCRIPTIONS, CommandName, RepoSubcommand } from './commands';
import type { ActionOpts, RepoParsedCommand } from './program';
import type { SearchQuery } from '../../src/types/repo-context';

/**
 * Options for the `repo search` action callback as parsed by commander.
 *
 * Every search field is optional and arrives as `string | undefined`; `verbose` is a boolean
 * defaulting to `false`.
 */
interface RepoSearchActionOpts {
    /**
     * Domain search term.
     */
    domain?: string;

    /**
     * CSS selector search term.
     */
    selector?: string;

    /**
     * Network URL pattern search term.
     */
    urlPattern?: string;

    /**
     * Scriptlet name search term.
     */
    scriptlet?: string;

    /**
     * Whether verbose logging is enabled.
     */
    verbose?: boolean;
}

/**
 * Optional callbacks receiving each parsed deterministic tooling invocation.
 */
export interface ToolingCommandHandlers {
    /**
     * Called with a parsed `repo` subcommand (search/map). Optional.
     */
    onRepoCommand?: (parsed: RepoParsedCommand) => void;
}

/**
 * Register the deterministic tooling command group `repo` on the program. It declares its commander
 * options and validation, then delivers exactly one parsed invocation to its handler. The commands
 * never write anywhere.
 *
 * @param program - The commander program the groups are registered on.
 * @param configure - The test-hook wrapper every registered command passes through.
 * @param handlers - The optional callbacks receiving each parsed tooling invocation.
 */
export function registerToolingCommands(
    program: Command,
    configure: (command: Command) => Command,
    handlers: ToolingCommandHandlers,
): void {
    const { onRepoCommand } = handlers;

    const repo = configure(
        program.command(CommandName.Repo).description(COMMAND_DESCRIPTIONS[CommandName.Repo]),
    );
    configure(repo.command('search'))
        .description('Search rules in the AdguardFilters checkout')
        .option('--domain <domain>', 'Domain to search for')
        .option('--selector <selector>', 'CSS selector to search for')
        .option('--url-pattern <pattern>', 'Network URL pattern to search for')
        .option('--scriptlet <name>', 'Scriptlet name to search for')
        .option('--verbose', 'Verbose (debug-level) logging', false)
        .action((opts: RepoSearchActionOpts) => {
            const query: SearchQuery = {};
            if (typeof opts.domain === 'string') {
                query.domain = opts.domain;
            }
            if (typeof opts.selector === 'string') {
                query.selector = opts.selector;
            }
            if (typeof opts.urlPattern === 'string') {
                query.urlPattern = opts.urlPattern;
            }
            if (typeof opts.scriptlet === 'string') {
                query.scriptlet = opts.scriptlet;
            }
            onRepoCommand?.({
                subcommand: RepoSubcommand.Search,
                query,
                verbose: Boolean(opts.verbose),
            });
        });
    configure(repo.command('map'))
        .description('Generate placement-map.json from the checkout')
        .option('--verbose', 'Verbose (debug-level) logging', false)
        .action((opts: ActionOpts) => {
            onRepoCommand?.({
                subcommand: RepoSubcommand.Map,
                verbose: Boolean(opts.verbose),
            });
        });
}
