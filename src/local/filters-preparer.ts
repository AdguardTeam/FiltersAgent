import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FiltersPreparationConfig } from './run-config-types';
import { runPreparationSubprocess } from './preparation-subprocess';
import { ExtensionEnvironmentKind } from '../types/extension-environment-kind';
import { CheckoutSource } from '../types/checkout-source';

/**
 * A subprocess invocation used to prepare an AdguardFilters checkout.
 */
export interface FiltersCommand {
    /**
     * The executable started without an intermediate shell.
     */
    executable: string;

    /**
     * Arguments passed directly to the executable.
     */
    args: string[];

    /**
     * Optional working directory for the command.
     */
    cwd?: string;

    /**
     * The explicit host-scoped GitHub token a runner wrapper attaches; the command runner uses it
     * only for git commands in place of a `GITHUB_TOKEN` from the subprocess source environment.
     * The token travels only through this field and must never be logged or serialized.
     */
    gitCredentialToken?: string;
}

/**
 * Captured output from a filters preparation command.
 */
export interface FiltersCommandResult {
    /**
     * Process exit status.
     */
    exitCode: number;

    /**
     * Captured standard output.
     */
    stdout: string;

    /**
     * Captured standard error.
     */
    stderr: string;
}

/**
 * Executes subprocesses for filters source preparation.
 */
export interface FiltersCommandRunner {
    /**
     * Runs one argv-based command without invoking a shell.
     *
     * @param command - Executable, arguments, and working directory.
     * @returns Completed process result.
     */
    run(command: FiltersCommand): Promise<FiltersCommandResult>;
}

/**
 * Minimal filesystem operations required by the disposable checkout lifecycle.
 */
export interface FiltersFileSystem {
    /**
     * Creates one unique temporary directory.
     *
     * @param prefix - Directory name prefix.
     * @returns Absolute path to the created directory.
     */
    createTemporaryDirectory(prefix: string): Promise<string>;

    /**
     * Checks whether a source path is accessible.
     *
     * @param path - Path to inspect.
     * @returns Whether the path is accessible.
     */
    exists(path: string): Promise<boolean>;

    /**
     * Removes a disposable path recursively.
     *
     * @param path - Path to remove.
     * @returns A promise that resolves after removal.
     */
    remove(path: string): Promise<void>;
}

/**
 * Injectable effects used to prepare and clean an AdguardFilters checkout.
 */
export interface FiltersPreparationDependencies {
    /**
     * Command execution adapter.
     */
    commandRunner: FiltersCommandRunner;

    /**
     * Filesystem lifecycle adapter.
     */
    fileSystem: FiltersFileSystem;
}

/**
 * Auditable revision information for a prepared AdguardFilters checkout.
 */
export interface FiltersProvenance {
    /**
     * Current or historical selection strategy.
     */
    environment: FiltersPreparationConfig['environment']['kind'];

    /**
     * Whether the disposable repository was prepared from a local or remote source.
     */
    source: CheckoutSource;

    /**
     * Local source path or remote repository URL used to prepare the checkout.
     */
    sourceLocation: string;

    /**
     * Requested remote ref or exact historical commit.
     */
    requestedRevision: string;

    /**
     * Exact detached checkout commit.
     */
    commit: string;
}

/**
 * A temporary exact AdguardFilters checkout and its verified provenance.
 */
export interface PreparedFiltersCheckout {
    /**
     * Root path containing the selected filter files.
     */
    filtersPath: string;

    /**
     * Root path of the disposable git checkout.
     */
    checkoutPath: string;

    /**
     * Verified source and revision metadata.
     */
    provenance: FiltersProvenance;
}

/**
 * Signals unsafe or incomplete filters source preparation.
 */
export class FiltersPreparationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FiltersPreparationError';
    }
}

/**
 * Runs a callback with an exact disposable AdguardFilters checkout and cleans it afterward.
 *
 * @param config - Source and revision selection configuration.
 * @param callback - Local browser work performed while the checkout exists.
 * @param dependencies - Optional command and filesystem adapters for tests.
 * @returns Callback result.
 */
export async function withPreparedFiltersCheckout<T>(
    config: FiltersPreparationConfig,
    callback: (prepared: PreparedFiltersCheckout) => Promise<T>,
    dependencies: FiltersPreparationDependencies = defaultDependencies,
): Promise<T> {
    validateConfig(config);
    const temporaryDirectory =
        await dependencies.fileSystem.createTemporaryDirectory('adguard-filters-');

    try {
        const prepared = await prepareInDirectory(config, temporaryDirectory, dependencies);
        return await callback(prepared);
    } finally {
        if (!config.keepTemporaryFiles) {
            await dependencies.fileSystem.remove(temporaryDirectory);
        }
    }
}

/**
 * Prepares and resolves a selected filters revision inside disposable storage.
 *
 * @param config - Source and revision selection configuration.
 * @param temporaryDirectory - Root of the disposable lifecycle.
 * @param dependencies - Command and filesystem adapters.
 * @returns Exact detached checkout and provenance.
 */
async function prepareInDirectory(
    config: FiltersPreparationConfig,
    temporaryDirectory: string,
    dependencies: FiltersPreparationDependencies,
): Promise<PreparedFiltersCheckout> {
    const checkoutPath = join(temporaryDirectory, 'source');
    const localSourceAvailable =
        config.localSourcePath !== undefined &&
        (await dependencies.fileSystem.exists(config.localSourcePath));
    const sourceLocation = localSourceAvailable
        ? resolve(config.localSourcePath!)
        : config.remoteUrl;
    const source = localSourceAvailable
        ? CheckoutSource.LocalSharedClone
        : CheckoutSource.RemoteShallowClone;

    if (config.environment.kind === ExtensionEnvironmentKind.Historical) {
        await runChecked(dependencies.commandRunner, {
            executable: 'git',
            args: ['init', '--quiet', checkoutPath],
        });
    } else {
        await runChecked(
            dependencies.commandRunner,
            createCloneCommand(sourceLocation, checkoutPath, localSourceAvailable),
        );
    }

    const requestedRevision =
        config.environment.kind === ExtensionEnvironmentKind.Current
            ? config.currentRef
            : config.environment.baseSha;
    const selectedCommit =
        config.environment.kind === ExtensionEnvironmentKind.Current
            ? await fetchCurrentCommit(config, checkoutPath, dependencies.commandRunner)
            : await fetchHistoricalCommit(
                  config,
                  sourceLocation,
                  checkoutPath,
                  dependencies.commandRunner,
              );

    await runChecked(dependencies.commandRunner, {
        executable: 'git',
        args: ['checkout', '--detach', selectedCommit],
        cwd: checkoutPath,
    });
    const headCommit = (
        await runChecked(dependencies.commandRunner, {
            executable: 'git',
            args: ['rev-parse', 'HEAD'],
            cwd: checkoutPath,
        })
    ).stdout.trim();
    assertFullCommit(headCommit, 'Detached filters checkout HEAD');
    if (headCommit.toLowerCase() !== selectedCommit.toLowerCase()) {
        throw new FiltersPreparationError(
            `Detached checkout HEAD ${headCommit} does not match selected commit ` +
                `${selectedCommit}.`,
        );
    }

    return {
        filtersPath: checkoutPath,
        checkoutPath,
        provenance: {
            environment: config.environment.kind,
            source,
            sourceLocation,
            requestedRevision,
            commit: headCommit,
        },
    };
}

/**
 * Creates an initial clone without checking out or mutating the source worktree.
 *
 * @param sourceLocation - Local source path or remote URL.
 * @param checkoutPath - Disposable clone destination.
 * @param useSharedClone - Whether a local repository supplies shared objects.
 * @returns Safe argv-based clone command.
 */
function createCloneCommand(
    sourceLocation: string,
    checkoutPath: string,
    useSharedClone: boolean,
): FiltersCommand {
    if (useSharedClone) {
        return {
            executable: 'git',
            args: ['clone', '--shared', '--no-checkout', sourceLocation, checkoutPath],
        };
    }
    return {
        executable: 'git',
        args: [
            'clone',
            '--filter=blob:none',
            '--no-checkout',
            '--depth',
            '1',
            '--no-tags',
            sourceLocation,
            checkoutPath,
        ],
    };
}

/**
 * Fetches the actual configured remote branch head and returns its exact commit.
 *
 * @param config - Current filters configuration.
 * @param checkoutPath - Disposable checkout root.
 * @param commandRunner - Git command adapter.
 * @returns Full commit fetched from the configured remote ref.
 */
async function fetchCurrentCommit(
    config: FiltersPreparationConfig,
    checkoutPath: string,
    commandRunner: FiltersCommandRunner,
): Promise<string> {
    await runChecked(commandRunner, {
        executable: 'git',
        args: ['fetch', '--depth', '1', '--no-tags', config.remoteUrl, config.currentRef],
        cwd: checkoutPath,
    });
    const fetchedCommit = (
        await runChecked(commandRunner, {
            executable: 'git',
            args: ['rev-parse', 'FETCH_HEAD'],
            cwd: checkoutPath,
        })
    ).stdout.trim();
    assertFullCommit(fetchedCommit, `Fetched filters ref ${config.currentRef}`);
    return fetchedCommit;
}

/**
 * Shallow-fetches only the exact historical commit without importing source refs or later objects.
 *
 * @param config - Historical filters configuration.
 * @param sourceLocation - Local source path or remote URL supplying the historical commit.
 * @param checkoutPath - Disposable checkout root.
 * @param commandRunner - Git command adapter.
 * @returns Full historical commit selected for checkout.
 */
async function fetchHistoricalCommit(
    config: FiltersPreparationConfig,
    sourceLocation: string,
    checkoutPath: string,
    commandRunner: FiltersCommandRunner,
): Promise<string> {
    if (config.environment.kind !== ExtensionEnvironmentKind.Historical) {
        throw new FiltersPreparationError('Historical commit resolution requires historical mode.');
    }
    const baseSha = config.environment.baseSha;
    await runChecked(commandRunner, {
        executable: 'git',
        args: ['fetch', '--quiet', '--depth', '1', '--no-tags', sourceLocation, baseSha],
        cwd: checkoutPath,
    });
    const fetchedCommit = (
        await runChecked(commandRunner, {
            executable: 'git',
            args: ['rev-parse', 'FETCH_HEAD'],
            cwd: checkoutPath,
        })
    ).stdout.trim();
    assertFullCommit(fetchedCommit, `Fetched historical filters commit ${baseSha}`);
    if (fetchedCommit.toLowerCase() !== baseSha.toLowerCase()) {
        throw new FiltersPreparationError(
            `Historical fetch resolved to ${fetchedCommit}, but expected ${baseSha}.`,
        );
    }
    return baseSha;
}

/**
 * Runs a command and converts non-zero status into a stable preparation error.
 *
 * @param commandRunner - Command execution adapter.
 * @param command - Command to execute.
 * @returns Successful command result.
 */
export async function runChecked(
    commandRunner: FiltersCommandRunner,
    command: FiltersCommand,
): Promise<FiltersCommandResult> {
    const result = await commandRunner.run(command);
    if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || 'no command output';
        throw new FiltersPreparationError(
            `${command.executable} ${command.args.join(' ')} failed with exit code ` +
                `${result.exitCode}: ${detail}`,
        );
    }
    return result;
}

/**
 * Validates source and revision configuration before allocating temporary storage.
 *
 * @param config - Configuration to validate.
 */
function validateConfig(config: FiltersPreparationConfig): void {
    if (config.remoteUrl.trim().length === 0) {
        throw new FiltersPreparationError('The filters remote URL must not be empty.');
    }
    if (config.currentRef.trim().length === 0) {
        throw new FiltersPreparationError('The filters current ref must not be empty.');
    }
    if (config.environment.kind === ExtensionEnvironmentKind.Historical) {
        assertFullCommit(config.environment.baseSha, 'Historical filters base SHA');
    }
}

/**
 * Requires a full hexadecimal git commit identifier.
 *
 * @param commit - Commit identifier to inspect.
 * @param description - Human-readable value name used in errors.
 */
function assertFullCommit(commit: string, description: string): void {
    if (!/^[0-9a-f]{40}$/iu.test(commit)) {
        throw new FiltersPreparationError(`${description} must be a full 40-character SHA.`);
    }
}

/**
 * Default filesystem adapter backed by Node.js promises.
 */
const defaultFileSystem: FiltersFileSystem = {
    async createTemporaryDirectory(prefix) {
        await mkdir(tmpdir(), { recursive: true });
        return await mkdtemp(join(tmpdir(), prefix));
    },
    async exists(path) {
        try {
            await access(path);
            return true;
        } catch {
            return false;
        }
    },
    async remove(path) {
        await rm(path, { recursive: true, force: true });
    },
};

/**
 * Default command and filesystem dependencies used by local runs.
 */
export const defaultDependencies: FiltersPreparationDependencies = {
    commandRunner: { run: runPreparationSubprocess },
    fileSystem: defaultFileSystem,
};
