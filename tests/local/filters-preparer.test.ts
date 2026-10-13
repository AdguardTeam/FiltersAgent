import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    FiltersPreparationError,
    withPreparedFiltersCheckout,
    type FiltersCommand,
    type FiltersCommandResult,
    type FiltersFileSystem,
    type FiltersPreparationDependencies,
} from '../../src/local/filters-preparer';
import type { FiltersPreparationConfig } from '../../src/local/run-config-types';

const CURRENT_COMMIT = '1111111111111111111111111111111111111111';
const HISTORICAL_COMMIT = '2222222222222222222222222222222222222222';
const OTHER_COMMIT = '3333333333333333333333333333333333333333';
const LOCAL_SOURCE = '/repo/AdguardFilters';
const REMOTE_URL = 'https://github.com/AdguardTeam/AdguardFilters.git';
const TEMP_ROOT = '/tmp/adguard-filters-test';
const CHECKOUT_PATH = `${TEMP_ROOT}/source`;

interface FakeEnvironmentOptions {
    localSourceExists?: boolean;
    historicalObjectExists?: boolean;
    fetchedCommit?: string;
    headCommit?: string;
}

function makeConfig(
    environment: FiltersPreparationConfig['environment'],
    overrides: Partial<FiltersPreparationConfig> = {},
): FiltersPreparationConfig {
    return {
        environment,
        localSourcePath: LOCAL_SOURCE,
        remoteUrl: REMOTE_URL,
        currentRef: 'master',
        keepTemporaryFiles: false,
        ...overrides,
    };
}

function makeFakeEnvironment(options: FakeEnvironmentOptions = {}): {
    commands: FiltersCommand[];
    createdDirectoryPrefixes: string[];
    dependencies: FiltersPreparationDependencies;
    removedPaths: string[];
} {
    const commands: FiltersCommand[] = [];
    const createdDirectoryPrefixes: string[] = [];
    const removedPaths: string[] = [];
    const fetchedCommit = options.fetchedCommit ?? CURRENT_COMMIT;
    const headCommit = options.headCommit ?? fetchedCommit;

    const fileSystem: FiltersFileSystem = {
        async createTemporaryDirectory(prefix) {
            createdDirectoryPrefixes.push(prefix);
            return TEMP_ROOT;
        },
        async exists(path) {
            return path === LOCAL_SOURCE ? (options.localSourceExists ?? true) : false;
        },
        async remove(path) {
            removedPaths.push(path);
        },
    };

    return {
        commands,
        createdDirectoryPrefixes,
        removedPaths,
        dependencies: {
            fileSystem,
            commandRunner: {
                async run(command): Promise<FiltersCommandResult> {
                    commands.push(command);
                    if (command.args[0] === 'cat-file') {
                        return {
                            exitCode: options.historicalObjectExists === false ? 1 : 0,
                            stdout: '',
                            stderr: '',
                        };
                    }
                    if (command.args[0] === 'rev-parse' && command.args[1] === 'FETCH_HEAD') {
                        return { exitCode: 0, stdout: `${fetchedCommit}\n`, stderr: '' };
                    }
                    if (command.args[0] === 'rev-parse' && command.args[1] === 'HEAD') {
                        return { exitCode: 0, stdout: `${headCommit}\n`, stderr: '' };
                    }
                    return { exitCode: 0, stdout: '', stderr: '' };
                },
            },
        },
    };
}

describe('withPreparedFiltersCheckout', () => {
    it('uses a shared clone but fetches the current ref from the configured remote', async () => {
        const { commands, dependencies, removedPaths } = makeFakeEnvironment();

        const provenance = await withPreparedFiltersCheckout(
            makeConfig({ kind: 'current' }),
            async (prepared) => {
                expect(prepared.filtersPath).toBe(CHECKOUT_PATH);
                return prepared.provenance;
            },
            dependencies,
        );

        expect(commands[0]).toEqual({
            executable: 'git',
            args: ['clone', '--shared', '--no-checkout', LOCAL_SOURCE, CHECKOUT_PATH],
        });
        expect(commands).toContainEqual({
            executable: 'git',
            args: ['fetch', '--depth', '1', '--no-tags', REMOTE_URL, 'master'],
            cwd: CHECKOUT_PATH,
        });
        expect(commands).toContainEqual({
            executable: 'git',
            args: ['checkout', '--detach', CURRENT_COMMIT],
            cwd: CHECKOUT_PATH,
        });
        expect(commands.every((command) => command.cwd !== LOCAL_SOURCE)).toBe(true);
        expect(provenance).toEqual({
            environment: 'current',
            source: 'local-shared-clone',
            sourceLocation: LOCAL_SOURCE,
            requestedRevision: 'master',
            commit: CURRENT_COMMIT,
        });
        expect(removedPaths).toEqual([TEMP_ROOT]);
    });

    it('uses a shallow remote clone before resolving the latest current ref', async () => {
        const { commands, dependencies } = makeFakeEnvironment({ localSourceExists: false });

        const provenance = await withPreparedFiltersCheckout(
            makeConfig({ kind: 'current' }),
            async (prepared) => prepared.provenance,
            dependencies,
        );

        expect(commands[0]).toEqual({
            executable: 'git',
            args: [
                'clone',
                '--filter=blob:none',
                '--no-checkout',
                '--depth',
                '1',
                '--no-tags',
                REMOTE_URL,
                CHECKOUT_PATH,
            ],
        });
        expect(provenance.source).toBe('remote-shallow-clone');
        expect(provenance.sourceLocation).toBe(REMOTE_URL);
    });

    it('checks out a historical commit already present in the local shared object store', async () => {
        const { commands, dependencies } = makeFakeEnvironment({
            fetchedCommit: HISTORICAL_COMMIT,
            headCommit: HISTORICAL_COMMIT,
            historicalObjectExists: true,
        });

        const provenance = await withPreparedFiltersCheckout(
            makeConfig({ kind: 'historical', baseSha: HISTORICAL_COMMIT }),
            async (prepared) => prepared.provenance,
            dependencies,
        );

        expect(commands).toContainEqual({
            executable: 'git',
            args: ['cat-file', '-e', `${HISTORICAL_COMMIT}^{commit}`],
            cwd: CHECKOUT_PATH,
        });
        expect(commands.some((command) => command.args[0] === 'fetch')).toBe(false);
        expect(commands).toContainEqual({
            executable: 'git',
            args: ['checkout', '--detach', HISTORICAL_COMMIT],
            cwd: CHECKOUT_PATH,
        });
        expect(provenance).toMatchObject({
            environment: 'historical',
            requestedRevision: HISTORICAL_COMMIT,
            commit: HISTORICAL_COMMIT,
        });
    });

    it('shallow-fetches an exact historical commit when the clone does not contain it', async () => {
        const { commands, dependencies } = makeFakeEnvironment({
            historicalObjectExists: false,
            fetchedCommit: HISTORICAL_COMMIT,
            headCommit: HISTORICAL_COMMIT,
        });

        await withPreparedFiltersCheckout(
            makeConfig({ kind: 'historical', baseSha: HISTORICAL_COMMIT }),
            async () => undefined,
            dependencies,
        );

        expect(commands).toContainEqual({
            executable: 'git',
            args: ['fetch', '--depth', '1', '--no-tags', REMOTE_URL, HISTORICAL_COMMIT],
            cwd: CHECKOUT_PATH,
        });
    });

    it('rejects a detached HEAD mismatch and still cleans the disposable checkout', async () => {
        const { dependencies, removedPaths } = makeFakeEnvironment({ headCommit: OTHER_COMMIT });

        await expect(
            withPreparedFiltersCheckout(
                makeConfig({ kind: 'current' }),
                async () => undefined,
                dependencies,
            ),
        ).rejects.toThrow(/does not match/i);
        expect(removedPaths).toEqual([TEMP_ROOT]);
    });

    it('cleans after consumer failure unless explicit debug retention is enabled', async () => {
        const first = makeFakeEnvironment();
        await expect(
            withPreparedFiltersCheckout(
                makeConfig({ kind: 'current' }),
                async () => {
                    throw new Error('browser failed');
                },
                first.dependencies,
            ),
        ).rejects.toThrow('browser failed');
        expect(first.removedPaths).toEqual([TEMP_ROOT]);

        const retained = makeFakeEnvironment();
        await withPreparedFiltersCheckout(
            makeConfig({ kind: 'current' }, { keepTemporaryFiles: true }),
            async () => undefined,
            retained.dependencies,
        );
        expect(retained.removedPaths).toEqual([]);
    });

    it('rejects an invalid historical SHA before creating temporary files', async () => {
        const { createdDirectoryPrefixes, dependencies } = makeFakeEnvironment();

        await expect(
            withPreparedFiltersCheckout(
                makeConfig({ kind: 'historical', baseSha: 'short' }),
                async () => undefined,
                dependencies,
            ),
        ).rejects.toBeInstanceOf(FiltersPreparationError);
        expect(createdDirectoryPrefixes).toEqual([]);
    });
});

const GENERAL_FILE = 'BaseFilter/sections/general.txt';
const FOREIGN_FILE = 'BaseFilter/sections/foreign.txt';

/**
 * Run Git in one test-owned repository.
 *
 * @param cwd - Repository path.
 * @param args - Git arguments.
 * @returns UTF-8 standard output.
 */
function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Write one file, creating the directories it needs.
 *
 * @param root - Repository path.
 * @param filePath - Repository-relative file.
 * @param content - Exact bytes to write.
 */
function write(root: string, filePath: string, content: string): void {
    mkdirSync(join(root, filePath, '..'), { recursive: true });
    writeFileSync(join(root, filePath), content, 'utf8');
}

/**
 * Build an operator checkout with two commits, a staged file, an edit, and an untracked file.
 *
 * @returns Repository path and the commit preparation will be asked to pin.
 */
function createDirtyOperatorCheckout(): { path: string; firstCommit: string } {
    const path = mkdtempSync(join(tmpdir(), 'operator-filters-'));
    git(path, 'init', '-q');
    write(path, GENERAL_FILE, '! first\n');
    git(path, 'add', '-A');
    git(
        path,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-qm',
        '1',
    );
    const firstCommit = git(path, 'rev-parse', 'HEAD').trim();

    write(path, GENERAL_FILE, '! second\n');
    write(path, FOREIGN_FILE, '! foreign\n');
    git(path, 'add', '-A');
    git(
        path,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-qm',
        '2',
    );

    write(path, 'staged.txt', 'staged\n');
    git(path, 'add', 'staged.txt');
    write(path, GENERAL_FILE, '! second\n! operator edit\n');
    write(path, 'untracked.txt', 'untracked\n');
    return { path, firstCommit };
}

/**
 * Capture every piece of operator state preparation must preserve.
 *
 * The same six probes review publication is already judged by, so both halves of the guarantee —
 * source snapshot and review checkout — are held to one standard.
 *
 * @param path - Operator repository path.
 * @returns Stable state fingerprint.
 */
function operatorFingerprint(path: string): string {
    return [
        git(path, 'rev-parse', 'HEAD'),
        git(path, 'symbolic-ref', 'HEAD'),
        git(path, 'status', '--porcelain=v2', '--untracked-files=all'),
        git(path, 'diff', '--binary'),
        git(path, 'diff', '--cached', '--binary'),
        git(path, 'show-ref'),
    ].join('\0');
}

describe('withPreparedFiltersCheckout against real Git', () => {
    it('preparing a source snapshot from a dirty operator checkout changes neither its files nor its index', async () => {
        const operator = createDirtyOperatorCheckout();
        const before = operatorFingerprint(operator.path);
        // The fingerprint is only worth comparing if it captured a genuinely dirty checkout.
        expect(before).toContain('untracked.txt');
        expect(before).toContain('staged.txt');
        expect(before).toContain('operator edit');

        await withPreparedFiltersCheckout(
            {
                environment: { kind: 'historical', baseSha: operator.firstCommit },
                localSourcePath: operator.path,
                remoteUrl: 'https://example.invalid/never-reached.git',
                currentRef: 'master',
                keepTemporaryFiles: false,
            },
            async (prepared) => {
                expect(prepared.provenance.commit).toBe(operator.firstCommit);
                expect(prepared.provenance.source).toBe('local-shared-clone');
                expect(git(prepared.checkoutPath, 'rev-parse', 'HEAD').trim()).toBe(
                    operator.firstCommit,
                );
                // The snapshot is the commit, not the operator's desk: their in-progress edit,
                // staged file, and untracked file are nowhere in it.
                expect(readFileSync(join(prepared.checkoutPath, GENERAL_FILE), 'utf8')).toBe(
                    '! first\n',
                );
                expect(existsSync(join(prepared.checkoutPath, 'staged.txt'))).toBe(false);
                expect(existsSync(join(prepared.checkoutPath, 'untracked.txt'))).toBe(false);
                expect(existsSync(join(prepared.checkoutPath, FOREIGN_FILE))).toBe(false);
            },
        );

        expect(operatorFingerprint(operator.path)).toBe(before);
    });

    it('prepares a source snapshot with no primary checkout to fall back to', async () => {
        const operator = createDirtyOperatorCheckout();
        const before = operatorFingerprint(operator.path);

        // A local path stands in for the configured remote, so the fallback clone is exercised for
        // real without a network round-trip.
        await withPreparedFiltersCheckout(
            {
                environment: { kind: 'historical', baseSha: operator.firstCommit },
                localSourcePath: join(operator.path, 'absent-checkout'),
                remoteUrl: operator.path,
                currentRef: 'master',
                keepTemporaryFiles: false,
            },
            async (prepared) => {
                expect(prepared.provenance.source).toBe('remote-shallow-clone');
                expect(prepared.provenance.commit).toBe(operator.firstCommit);
            },
        );

        expect(operatorFingerprint(operator.path)).toBe(before);
    });
});
