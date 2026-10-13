import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeGuidanceSource } from '../../src/knowledge/rule-guidance';
import { RuleGuidanceSourceKind } from '../../src/knowledge/guidance-source';
import type { PreparedFiltersCheckout } from '../../src/local/filters-preparer';
import { runPreparationSubprocess } from '../../src/local/preparation-subprocess';
import type { KnowledgeBasePreparationConfig } from '../../src/local/run-config-types';
import { ExtensionEnvironmentKind } from '../../src/types/extension-environment-kind';
import { CheckoutSource } from '../../src/types/checkout-source';
import { KnowledgeBaseEnvironmentKind } from '../../src/types/knowledge-base-environment-kind';
import {
    parseRepositorySlugFromGitUrl,
    REPOSITORY_SLUG_PATTERN,
} from '../../src/types/repository-slug';

/**
 * Resolve the `owner/repo` slug one configured git remote points at or fail with a named error.
 *
 * @param url - Configured remote URL of one source repository.
 * @param label - Human-readable source name used in the thrown error.
 * @returns The owner/repo slug string citations are built from.
 * @throws {KnowledgeBasePreparationError} When the remote does not yield an owner/repo pair.
 */
export function guidanceRepositorySlugFromRemote(url: string, label: string): string {
    const slug = parseRepositorySlugFromGitUrl(url);
    if (!slug) {
        throw new KnowledgeBasePreparationError(
            `${label} remote URL does not name an owner/repo repository: ${url}`,
        );
    }
    return `${slug.owner}/${slug.repo}`;
}

/**
 * Repository-relative KnowledgeBase documents available to the agent.
 */
const KNOWLEDGE_BASE_DOCUMENTS = [
    'docs/general/ad-filtering/create-own-filters.md',
    'docs/general/ad-filtering/filter-policy.md',
] as const;

/**
 * One subprocess invocation used for disposable KnowledgeBase preparation.
 */
export interface KnowledgeBaseCommand {
    /**
     * Executable invoked without a shell.
     */
    executable: string;

    /**
     * Arguments passed directly to the executable.
     */
    args: string[];

    /**
     * Optional subprocess working directory.
     */
    cwd?: string;
}

/**
 * Captured result of one KnowledgeBase preparation command.
 */
export interface KnowledgeBaseCommandResult {
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
 * Command adapter used by the disposable checkout lifecycle.
 */
export interface KnowledgeBaseCommandRunner {
    /**
     * Run one argv-based command without shell expansion.
     *
     * @param command - Safe executable, arguments, and working directory.
     * @returns Captured command result.
     */
    run(command: KnowledgeBaseCommand): Promise<KnowledgeBaseCommandResult>;
}

/**
 * Minimal filesystem effects used by KnowledgeBase preparation.
 */
export interface KnowledgeBaseFileSystem {
    /**
     * Allocate one unique temporary directory.
     *
     * @param prefix - Directory name prefix.
     * @returns Absolute created path.
     */
    createTemporaryDirectory(prefix: string): Promise<string>;

    /**
     * Test whether a trusted source or prepared file exists.
     *
     * @param path - Absolute path to inspect.
     * @returns Whether the path is accessible.
     */
    exists(path: string): Promise<boolean>;

    /**
     * Remove one disposable tree recursively.
     *
     * @param path - Temporary root to remove.
     * @returns Promise settled after cleanup.
     */
    remove(path: string): Promise<void>;
}

/**
 * Injectable effects for deterministic preparer tests.
 */
export interface KnowledgeBasePreparationDependencies {
    /**
     * Safe subprocess adapter.
     */
    commandRunner: KnowledgeBaseCommandRunner;

    /**
     * Temporary filesystem adapter.
     */
    fileSystem: KnowledgeBaseFileSystem;
}

/**
 * Auditable revision and allowlist metadata for one prepared guide.
 */
export interface KnowledgeBaseProvenance {
    /**
     * Current-master or explicit pinned selection strategy.
     */
    environment: KnowledgeBasePreparationConfig['environment']['kind'];

    /**
     * Whether git objects came from a local shared clone or the remote repository.
     */
    source: CheckoutSource;

    /**
     * Local source path or remote URL used by the initial clone.
     */
    sourceLocation: string;

    /**
     * Requested branch name or exact pinned commit.
     */
    requestedRevision: string;

    /**
     * Verified detached KnowledgeBase commit.
     */
    commit: string;

    /**
     * Exact filter commit supplying CONTRIBUTING.md.
     */
    filtersCommit: string;

    /**
     * Complete repository-relative document allowlist.
     */
    documents: [
        'docs/general/ad-filtering/create-own-filters.md',
        'docs/general/ad-filtering/filter-policy.md',
        'CONTRIBUTING.md',
    ];
}

/**
 * Disposable verified KnowledgeBase source and its bounded reader inputs.
 */
export interface PreparedKnowledgeBase {
    /**
     * Root of the detached sparse checkout.
     */
    checkoutPath: string;

    /**
     * Trusted file paths and exact commits consumed by lookup_rule_guidance.
     */
    guidanceSource: KnowledgeGuidanceSource;

    /**
     * Verified preparation provenance.
     */
    provenance: KnowledgeBaseProvenance;
}

/**
 * Signals unsafe, incomplete, or mismatched KnowledgeBase preparation.
 */
export class KnowledgeBasePreparationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'KnowledgeBasePreparationError';
    }
}

/**
 * Run a callback with a detached sparse KnowledgeBase checkout and clean it afterward.
 *
 * @param config - Source and exact revision selection.
 * @param filters - Exact filters checkout supplying the pinned contributing guide.
 * @param callback - Local run performed while the documentation files exist.
 * @param dependencies - Optional command and filesystem test adapters.
 * @returns Callback result.
 */
export async function withPreparedKnowledgeBase<T>(
    config: KnowledgeBasePreparationConfig,
    filters: PreparedFiltersCheckout,
    callback: (prepared: PreparedKnowledgeBase) => Promise<T>,
    dependencies: KnowledgeBasePreparationDependencies = defaultDependencies,
): Promise<T> {
    validateConfig(config);
    assertFullCommit(filters.provenance.commit, 'Pinned filters commit');
    const contributingPath = join(filters.filtersPath, 'CONTRIBUTING.md');
    if (!(await dependencies.fileSystem.exists(contributingPath))) {
        throw new KnowledgeBasePreparationError(
            `Pinned filters checkout does not contain CONTRIBUTING.md: ${contributingPath}`,
        );
    }
    const temporaryDirectory =
        await dependencies.fileSystem.createTemporaryDirectory('adguard-knowledge-base-');
    try {
        const prepared = await prepareInDirectory(
            config,
            filters,
            contributingPath,
            temporaryDirectory,
            dependencies,
        );
        return await callback(prepared);
    } finally {
        if (!config.keepTemporaryFiles) {
            await dependencies.fileSystem.remove(temporaryDirectory);
        }
    }
}

/**
 * Clone, sparse-checkout, and verify one selected KnowledgeBase revision.
 *
 * @param config - Source and revision selection.
 * @param filters - Exact filters checkout used by this run.
 * @param contributingPath - Verified contributing guide path in the filters checkout.
 * @param temporaryDirectory - Root of the disposable lifecycle.
 * @param dependencies - Command and filesystem adapters.
 * @returns Prepared source and immutable provenance.
 */
async function prepareInDirectory(
    config: KnowledgeBasePreparationConfig,
    filters: PreparedFiltersCheckout,
    contributingPath: string,
    temporaryDirectory: string,
    dependencies: KnowledgeBasePreparationDependencies,
): Promise<PreparedKnowledgeBase> {
    const checkoutPath = join(temporaryDirectory, 'source');
    const localSourceAvailable =
        config.localSourcePath !== undefined &&
        (await dependencies.fileSystem.exists(config.localSourcePath));
    const sourceLocation = localSourceAvailable ? config.localSourcePath! : config.remoteUrl;
    const source = localSourceAvailable
        ? CheckoutSource.LocalSharedClone
        : CheckoutSource.RemoteShallowClone;
    await runChecked(
        dependencies.commandRunner,
        createCloneCommand(sourceLocation, checkoutPath, localSourceAvailable),
    );
    const requestedRevision =
        config.environment.kind === ExtensionEnvironmentKind.Current
            ? config.currentRef
            : config.environment.commit;
    const selectedCommit =
        config.environment.kind === ExtensionEnvironmentKind.Current
            ? await fetchCurrentCommit(config, checkoutPath, dependencies.commandRunner)
            : await resolvePinnedCommit(config, checkoutPath, dependencies.commandRunner);

    await runChecked(dependencies.commandRunner, {
        executable: 'git',
        args: ['sparse-checkout', 'set', '--no-cone', ...KNOWLEDGE_BASE_DOCUMENTS],
        cwd: checkoutPath,
    });
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
    assertFullCommit(headCommit, 'Detached KnowledgeBase checkout HEAD');
    if (headCommit.toLowerCase() !== selectedCommit.toLowerCase()) {
        throw new KnowledgeBasePreparationError(
            `Detached KnowledgeBase HEAD ${headCommit} does not match selected commit ` +
                `${selectedCommit}.`,
        );
    }
    const syntaxPath = join(checkoutPath, KNOWLEDGE_BASE_DOCUMENTS[0]);
    const policyPath = join(checkoutPath, KNOWLEDGE_BASE_DOCUMENTS[1]);
    for (const documentPath of [syntaxPath, policyPath]) {
        if (!(await dependencies.fileSystem.exists(documentPath))) {
            throw new KnowledgeBasePreparationError(
                `Sparse KnowledgeBase checkout is missing an allowlisted document: ${documentPath}`,
            );
        }
    }
    return {
        checkoutPath,
        guidanceSource: {
            kind: RuleGuidanceSourceKind.KnowledgeBase,
            knowledgeBaseCommit: headCommit,
            filtersCommit: filters.provenance.commit,
            knowledgeBaseRepository: config.knowledgeBaseRepository,
            filtersRepository: config.filtersRepository,
            syntaxPath,
            policyPath,
            contributingPath,
        },
        provenance: {
            environment: config.environment.kind,
            source,
            sourceLocation,
            requestedRevision,
            commit: headCommit,
            filtersCommit: filters.provenance.commit,
            documents: [...KNOWLEDGE_BASE_DOCUMENTS, 'CONTRIBUTING.md'],
        },
    };
}

/**
 * Construct the initial shared or remote shallow clone invocation.
 *
 * @param sourceLocation - Local source path or remote repository URL.
 * @param checkoutPath - Disposable clone destination.
 * @param shared - Whether a local repository supplies shared objects.
 * @returns Safe argv-based git clone command.
 */
function createCloneCommand(
    sourceLocation: string,
    checkoutPath: string,
    shared: boolean,
): KnowledgeBaseCommand {
    if (shared) {
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
 * Fetch the configured current branch and return its exact remote head.
 *
 * @param config - KnowledgeBase source configuration.
 * @param checkoutPath - Disposable checkout root.
 * @param commandRunner - Safe subprocess adapter.
 * @returns Full fetched commit.
 */
async function fetchCurrentCommit(
    config: KnowledgeBasePreparationConfig,
    checkoutPath: string,
    commandRunner: KnowledgeBaseCommandRunner,
): Promise<string> {
    await runChecked(commandRunner, {
        executable: 'git',
        args: ['fetch', '--depth', '1', '--no-tags', config.remoteUrl, config.currentRef],
        cwd: checkoutPath,
    });
    const commit = (
        await runChecked(commandRunner, {
            executable: 'git',
            args: ['rev-parse', 'FETCH_HEAD'],
            cwd: checkoutPath,
        })
    ).stdout.trim();
    assertFullCommit(commit, `Fetched KnowledgeBase ref ${config.currentRef}`);
    return commit;
}

/**
 * Resolve an exact pinned commit locally or through a shallow remote fetch.
 *
 * @param config - Pinned KnowledgeBase source configuration.
 * @param checkoutPath - Disposable checkout root.
 * @param commandRunner - Safe subprocess adapter.
 * @returns Exact configured commit.
 */
async function resolvePinnedCommit(
    config: KnowledgeBasePreparationConfig,
    checkoutPath: string,
    commandRunner: KnowledgeBaseCommandRunner,
): Promise<string> {
    if (config.environment.kind !== KnowledgeBaseEnvironmentKind.Pinned) {
        throw new KnowledgeBasePreparationError('Pinned commit resolution requires pinned mode.');
    }
    const expected = config.environment.commit;
    const localObject = await commandRunner.run({
        executable: 'git',
        args: ['cat-file', '-e', `${expected}^{commit}`],
        cwd: checkoutPath,
    });
    if (localObject.exitCode === 0) {
        return expected;
    }
    await runChecked(commandRunner, {
        executable: 'git',
        args: ['fetch', '--depth', '1', '--no-tags', config.remoteUrl, expected],
        cwd: checkoutPath,
    });
    const fetched = (
        await runChecked(commandRunner, {
            executable: 'git',
            args: ['rev-parse', 'FETCH_HEAD'],
            cwd: checkoutPath,
        })
    ).stdout.trim();
    assertFullCommit(fetched, `Fetched pinned KnowledgeBase commit ${expected}`);
    if (fetched.toLowerCase() !== expected.toLowerCase()) {
        throw new KnowledgeBasePreparationError(
            `Pinned KnowledgeBase fetch resolved to ${fetched}, but expected ${expected}.`,
        );
    }
    return expected;
}

/**
 * Run one command and normalize non-zero status into a preparation error.
 *
 * @param commandRunner - Safe subprocess adapter.
 * @param command - Exact command to execute.
 * @returns Successful command result.
 */
async function runChecked(
    commandRunner: KnowledgeBaseCommandRunner,
    command: KnowledgeBaseCommand,
): Promise<KnowledgeBaseCommandResult> {
    const result = await commandRunner.run(command);
    if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || 'no command output';
        throw new KnowledgeBasePreparationError(
            `KnowledgeBase preparation command ${command.executable} ` +
                `${command.args.join(' ')} failed with exit code ` +
                `${result.exitCode}: ${detail}`,
        );
    }
    return result;
}

/**
 * Validate source and revision settings before allocating disposable storage.
 *
 * @param config - KnowledgeBase preparation configuration.
 */
function validateConfig(config: KnowledgeBasePreparationConfig): void {
    if (config.remoteUrl.trim().length === 0) {
        throw new KnowledgeBasePreparationError('KnowledgeBase remote URL must not be empty.');
    }
    if (!REPOSITORY_SLUG_PATTERN.test(config.knowledgeBaseRepository)) {
        throw new KnowledgeBasePreparationError(
            'KnowledgeBase citation repository must be a validated owner/repo slug: ' +
                `${config.knowledgeBaseRepository}`,
        );
    }
    if (!REPOSITORY_SLUG_PATTERN.test(config.filtersRepository)) {
        throw new KnowledgeBasePreparationError(
            'Filters citation repository must be a validated owner/repo slug: ' +
                `${config.filtersRepository}`,
        );
    }
    if (config.currentRef.trim().length === 0) {
        throw new KnowledgeBasePreparationError('KnowledgeBase current ref must not be empty.');
    }
    if (config.environment.kind === KnowledgeBaseEnvironmentKind.Pinned) {
        assertFullCommit(config.environment.commit, 'Pinned KnowledgeBase commit');
    }
}

/**
 * Require one full hexadecimal commit identifier.
 *
 * @param commit - Commit value to inspect.
 * @param label - Human-readable name used in errors.
 */
function assertFullCommit(commit: string, label: string): void {
    if (!/^[0-9a-f]{40}$/iu.test(commit)) {
        throw new KnowledgeBasePreparationError(`${label} must be a full 40-character SHA.`);
    }
}

/**
 * Production filesystem adapter for disposable documentation preparation.
 */
const defaultFileSystem: KnowledgeBaseFileSystem = {
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
 * Production command and filesystem effects.
 */
const defaultDependencies: KnowledgeBasePreparationDependencies = {
    commandRunner: { run: runPreparationSubprocess },
    fileSystem: defaultFileSystem,
};
