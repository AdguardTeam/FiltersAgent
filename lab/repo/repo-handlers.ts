import { ConfigError, type CoreConfig } from '../../src/config/config';
import { REPOSITORY_PATH_VAR } from '../../src/config/repository-identity';
import { generatePlacementMap, writePlacementMap } from '../../src/repo/placement-map';
import { searchRules } from '../../src/repo/search';
import type { RepoParsedCommand } from '../cli/program';

/**
 * Throw a ConfigError when the checkout path is missing.
 *
 * Repo commands require a local checkout; the core config keeps the path optional (other commands
 * never need it), so it is validated here.
 *
 * @param config - The GitHub-independent core configuration.
 * @returns The validated checkout path.
 */
export function assertCheckoutPath(config: CoreConfig): string {
    const path = config.repositoryPath;
    if (!path) {
        throw new ConfigError(`${REPOSITORY_PATH_VAR} is required for repo commands`);
    }
    return path;
}

/**
 * Build a handler for `repo search` commands.
 *
 * Generates a placement map from the checkout, runs the normalized search, and writes the
 * JSON-encoded matches to stdout.
 *
 * @param config - The GitHub-independent core configuration.
 * @returns An async handler for a parsed `repo search` command.
 */
export function buildRepoSearchHandler(
    config: CoreConfig,
): (cmd: RepoParsedCommand) => Promise<void> {
    return async (cmd) => {
        if (cmd.subcommand !== 'search') {
            return;
        }
        const checkoutPath = assertCheckoutPath(config);
        const map = generatePlacementMap(checkoutPath);
        const matches = searchRules(cmd.query, map, checkoutPath);
        process.stdout.write(JSON.stringify(matches, null, 2) + '\n');
    };
}

/**
 * Run a `repo map` command: generate and write `placement-map.json`.
 *
 * @param config - The GitHub-independent core configuration.
 * @returns A resolved promise once the map is written.
 */
export async function runRepoMap(config: CoreConfig): Promise<void> {
    const checkoutPath = assertCheckoutPath(config);
    const map = generatePlacementMap(checkoutPath);
    writePlacementMap(map);
    process.stdout.write(`Wrote placement-map.json (${map.files.length} files)\n`);
}
