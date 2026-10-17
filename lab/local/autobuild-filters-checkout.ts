import { access, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../../src/logger/logger';
import { runPreparationSubprocess } from '../../src/local/preparation-subprocess';
import { HistoricalBuildError, HistoricalBuildFailureCode } from './historical-build-error';

/**
 * Only this official autobuild subtree supplies compiled historical filter data.
 */
const AUTOBUILD_FILTERS_PATH = 'Extension/filters/chromium-mv3';

/**
 * Incomplete checkouts remain siblings of the commit-keyed cache until verified.
 */
const CHECKOUT_TEMP_PREFIX = 'checkout-';

/**
 * Keep source checkouts separate from completed historical assemblies and release archives.
 */
const AUTOBUILD_CACHE_SEGMENTS = ['extensions', 'autobuild'] as const;

/**
 * Inputs for an isolated, commit-pinned autobuild filters checkout.
 */
export interface FetchAutobuildFiltersOptions {
    /**
     * Exact full commit id already resolved from an official autobuild tag.
     */
    commit: string;
    /**
     * Host-only cache outside run tool roots.
     */
    cacheRoot: string;
    /**
     * Official repository URL or a local offline fixture repository.
     */
    remoteUrl: string;
    /**
     * Receives commands, full output, and checkout identity.
     */
    logger: Logger;
}

/**
 * Fetch only the pinned autobuild filter tree and publish its checkout atomically.
 *
 * @param options - Full commit pin, repository, cache, and diagnostic logger.
 * @returns Path to the verified compiled filter subtree.
 */
export async function fetchAutobuildFilters(
    options: FetchAutobuildFiltersOptions,
): Promise<string> {
    const { commit, cacheRoot, remoteUrl, logger } = options;
    const parent = join(cacheRoot, ...AUTOBUILD_CACHE_SEGMENTS);
    const destination = join(parent, commit);
    const filters = join(destination, AUTOBUILD_FILTERS_PATH);
    if (
        await access(filters).then(
            () => true,
            () => false,
        )
    ) {
        logger.info({ commit, filters }, 'Reusing verified autobuild filters');
        return filters;
    }
    await mkdir(parent, { recursive: true });
    const temporary = await mkdtemp(join(parent, CHECKOUT_TEMP_PREFIX));
    const commands = [
        ['init', '--quiet'],
        ['remote', 'add', 'origin', remoteUrl],
        ['sparse-checkout', 'set', '--no-cone', `/${AUTOBUILD_FILTERS_PATH}/`],
        ['fetch', '--depth', '1', '--filter=blob:none', 'origin', commit],
        ['checkout', '--detach', commit],
        ['rev-parse', 'HEAD'],
    ];
    try {
        for (const args of commands) {
            let result;
            try {
                result = await runPreparationSubprocess({
                    executable: 'git',
                    args,
                    cwd: temporary,
                });
            } catch (error) {
                logger.error(
                    { err: error, command: ['git', ...args], commit, remoteUrl, temporary },
                    'Autobuild git command failed to start',
                );
                throw new HistoricalBuildError(
                    HistoricalBuildFailureCode.AutobuildUnavailable,
                    `Autobuild ${commit}: git ${args.join(' ')} failed: ${(error as Error).message}`,
                    error,
                );
            }
            logger.info(
                {
                    command: ['git', ...args],
                    commit,
                    remoteUrl,
                    temporary,
                    stdout: result.stdout,
                    stderr: result.stderr,
                },
                'Autobuild git subprocess output',
            );
            if (
                result.exitCode !== 0 ||
                (args[0] === 'rev-parse' && result.stdout.trim() !== commit)
            ) {
                throw new HistoricalBuildError(
                    HistoricalBuildFailureCode.AutobuildUnavailable,
                    `Autobuild ${commit}: git ${args.join(' ')} exited ${result.exitCode}; stdout: ${result.stdout}; stderr: ${result.stderr}`,
                );
            }
        }
        try {
            await access(join(temporary, AUTOBUILD_FILTERS_PATH));
        } catch (error) {
            logger.error(
                { err: error, commit, temporary },
                'Autobuild commit lacks the filters subtree',
            );
            throw new HistoricalBuildError(
                HistoricalBuildFailureCode.AutobuildUnavailable,
                `Autobuild ${commit} has no ${AUTOBUILD_FILTERS_PATH}: ${(error as Error).message}`,
                error,
            );
        }
        try {
            await rename(temporary, destination);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'EEXIST' && code !== 'ENOTEMPTY') {
                throw error;
            }
            await access(filters);
        }
        logger.info({ commit, filters }, 'Verified autobuild filters ready');
        return filters;
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}
