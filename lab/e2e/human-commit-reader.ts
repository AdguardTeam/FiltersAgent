import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FULL_COMMIT_SHA_PATTERN } from '../../src/environment/environment-proofs';
import { runPreparationSubprocess } from '../../src/local/preparation-subprocess';
import {
    parseHumanCommitDiffChanges,
    parseHumanCommitRuleLines,
    type ExtractedHumanFix,
    type HumanCommitRuleLines,
} from './human-commit-oracle';

/**
 * Human fixes come from the public filter repository, never from the run's historical checkout.
 */
const DEFAULT_FILTERS_REMOTE = 'https://github.com/AdguardTeam/AdguardFilters.git';

/**
 * Injectable read-only git seam used by human oracle tests and production extraction.
 */
export interface HumanCommitGitReader {
    /**
     * Reads commit parents in the order recorded by git.
     *
     * @param commit - Full commit to inspect.
     * @returns Ordered full parent SHAs.
     */
    readParents(commit: string): Promise<string[]>;

    /**
     * Reads a zero-context text-filter diff between one parent and its child.
     *
     * @param parent - Selected first parent.
     * @param commit - Human fix commit.
     * @returns Unified diff containing modified text filter files.
     */
    readDiff(parent: string, commit: string): Promise<string>;
}

/**
 * Require one immutable full git object identifier.
 *
 * @param commit - Commit string supplied by trusted post-run metadata or git.
 * @param label - Diagnostic field label.
 * @returns Nothing when the identifier is valid.
 */
function assertFullCommit(commit: string, label: string): void {
    if (!FULL_COMMIT_SHA_PATTERN.test(commit)) {
        throw new Error(`${label} must be a full 40-character SHA.`);
    }
}

/**
 * Run one read-only git command and surface bounded diagnostics.
 *
 * @param cwd - Disposable repository directory.
 * @param args - Git arguments passed without a shell.
 * @returns Captured stdout.
 */
async function runGit(cwd: string, args: string[]): Promise<string> {
    const result = await runPreparationSubprocess({ executable: 'git', args, cwd });
    if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || 'no command output';
        throw new Error(
            `git ${args.join(' ')} failed with exit code ${result.exitCode}: ${detail}`,
        );
    }
    return result.stdout;
}

/**
 * Build the shallow fetch used by the disposable human-commit reader.
 *
 * The requested commit and its first parent are small enough to fetch with blobs. Avoiding a
 * partial clone prevents a later `git diff` from making an implicit lazy network request whose
 * transport failure would hide the already-locked fix-agent result.
 *
 * @param commit - Full human fix commit.
 * @returns Git arguments for a complete depth-two fetch.
 */
function buildHumanCommitFetchArgs(commit: string): string[] {
    return ['fetch', '--quiet', '--depth', '2', '--no-tags', DEFAULT_FILTERS_REMOTE, commit];
}

/**
 * Create a disposable shallow repository containing the human commit and its first parent.
 *
 * @param commit - Full human fix commit.
 * @param callback - Extraction work performed while the repository exists.
 * @returns Callback result.
 */
async function withDisposableGitReader<T>(
    commit: string,
    callback: (reader: HumanCommitGitReader) => Promise<T>,
): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), 'adguard-human-oracle-'));
    try {
        await runGit(directory, ['init', '--quiet']);
        await runGit(directory, buildHumanCommitFetchArgs(commit));
        const reader: HumanCommitGitReader = {
            async readParents(targetCommit) {
                const output = await runGit(directory, [
                    'show',
                    '--no-patch',
                    '--format=%P',
                    targetCommit,
                ]);
                return output.trim().split(/\s+/u).filter(Boolean);
            },
            async readDiff(parent, targetCommit) {
                return await runGit(directory, [
                    'diff',
                    '--no-ext-diff',
                    '--unified=0',
                    '--no-renames',
                    parent,
                    targetCommit,
                    '--',
                    '*.txt',
                ]);
            },
        };
        return await callback(reader);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

/**
 * Extract actionable candidates from the first-parent diff of one human fix commit.
 *
 * The optional reader is the injectable git seam. Without it, a disposable shallow fetch of the
 * public AdguardFilters repository is used and removed after extraction.
 *
 * @param commit - Full human fix commit loaded only after the agent result is locked.
 * @param reader - Optional test or caller-provided read-only git adapter.
 * @returns Verified first-parent identity and every actionable human candidate.
 */
export async function extractHumanCommitFix(
    commit: string,
    reader?: HumanCommitGitReader,
): Promise<ExtractedHumanFix> {
    assertFullCommit(commit, 'Human fix commit');
    const extract = async (git: HumanCommitGitReader): Promise<ExtractedHumanFix> => {
        const parents = await git.readParents(commit);
        const firstParent = parents[0];
        if (!firstParent) {
            throw new Error(`Human fix commit ${commit} has no first parent.`);
        }
        assertFullCommit(firstParent, 'Human fix first parent');
        const rawDiff = await git.readDiff(firstParent, commit);
        const parsed = parseHumanCommitDiffChanges(rawDiff);
        if (parsed.candidates.length === 0 && parsed.removedRules.length === 0) {
            throw new Error(`Human fix commit ${commit} adds no actionable filter rules.`);
        }
        return {
            firstParent,
            candidates: parsed.candidates,
            removedRules: parsed.removedRules,
        };
    };
    return reader ? await extract(reader) : await withDisposableGitReader(commit, extract);
}

/**
 * Read every original actionable line on both sides of a human commit's first-parent diff.
 *
 * @param commit - Full human fix commit recorded in the closed oracle.
 * @param reader - Optional caller-provided read-only git adapter.
 * @returns Complete added and removed rule lines without candidate transformations.
 */
export async function readHumanCommitRuleLines(
    commit: string,
    reader?: HumanCommitGitReader,
): Promise<HumanCommitRuleLines> {
    assertFullCommit(commit, 'Human fix commit');
    const read = async (git: HumanCommitGitReader): Promise<HumanCommitRuleLines> => {
        const parents = await git.readParents(commit);
        const firstParent = parents[0];
        if (!firstParent) {
            throw new Error(`Human fix commit ${commit} has no first parent.`);
        }
        assertFullCommit(firstParent, 'Human fix first parent');
        return parseHumanCommitRuleLines(await git.readDiff(firstParent, commit));
    };
    return reader ? await read(reader) : await withDisposableGitReader(commit, read);
}
