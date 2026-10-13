import {
    FiltersPreparationError,
    defaultDependencies,
    runChecked,
    type FiltersCommand,
    type FiltersCommandRunner,
} from './filters-preparer';

/**
 * The symbolic-ref line prefix of `git ls-remote --symref` output.
 */
const LS_REMOTE_SYMREF_PREFIX = 'ref: ';

/**
 * The ref namespace every branch name lives under.
 */
const BRANCH_REF_PREFIX = 'refs/heads/';

/**
 * The column separator of one `git ls-remote` output line: `<ref><tab><object>`.
 */
const LS_REMOTE_FIELD_SEPARATOR = '\t';

/**
 * Resolve the remote's default branch through `git ls-remote --symref <remoteUrl> HEAD`.
 *
 * The resolution rides the supplied command runner, which production defaults to the same adapter
 * the preparer's own fetch uses — the one that attaches the derived GitHub credential to git
 * commands (`buildPreparationSubprocessEnvironment`). No fallback ref exists: an unreachable remote
 * or an output naming no branch fails named instead of guessing.
 *
 * @param remoteUrl - Remote repository URL.
 * @param commandRunner - Git command adapter; defaults to the production one.
 * @returns The branch name the remote HEAD points at.
 * @throws {FiltersPreparationError} When the command exits non-zero or names no branch.
 */
export async function resolveRemoteDefaultRef(
    remoteUrl: string,
    commandRunner: FiltersCommandRunner = defaultDependencies.commandRunner,
): Promise<string> {
    const command: FiltersCommand = {
        executable: 'git',
        args: ['ls-remote', '--symref', remoteUrl, 'HEAD'],
    };
    const result = await runChecked(commandRunner, command);
    const symrefField = result.stdout
        .split('\n')
        .find((line) => line.startsWith(LS_REMOTE_SYMREF_PREFIX))
        ?.slice(LS_REMOTE_SYMREF_PREFIX.length)
        .split(LS_REMOTE_FIELD_SEPARATOR)[0];
    if (
        symrefField === undefined ||
        !symrefField.startsWith(BRANCH_REF_PREFIX) ||
        symrefField.length === BRANCH_REF_PREFIX.length
    ) {
        throw new FiltersPreparationError(
            `${command.executable} ${command.args.join(' ')} named no branch: ` +
                `${result.stdout.trim() || 'no command output'}`,
        );
    }
    return symrefField.slice(BRANCH_REF_PREFIX.length);
}
