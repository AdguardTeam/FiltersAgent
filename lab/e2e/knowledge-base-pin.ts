import type { FiltersCommandRunner } from '../../src/local/filters-preparer';
import { runPreparationSubprocess } from '../../src/local/preparation-subprocess';
import { parseUpstreamCommit } from '../local/upstream-drift';

/**
 * Public KnowledgeBase remote used by historical benchmark agent runs.
 */
export const KNOWLEDGE_BASE_REMOTE = 'https://github.com/AdguardTeam/KnowledgeBase.git';

/**
 * KnowledgeBase branch resolved once before a benchmark series starts.
 */
export const KNOWLEDGE_BASE_MASTER_REF = 'refs/heads/master';

/**
 * Resolve the current KnowledgeBase master commit without changing any local repository.
 *
 * @param runner - Read-only Git subprocess adapter, replaceable for offline tests.
 * @returns Lowercased full commit shared by every agent run in a series.
 * @throws {Error} When the remote cannot provide a full commit.
 */
export async function resolveKnowledgeBaseMasterSha(
    runner: FiltersCommandRunner = { run: runPreparationSubprocess },
): Promise<string> {
    const result = await runner.run({
        executable: 'git',
        args: ['ls-remote', KNOWLEDGE_BASE_REMOTE, KNOWLEDGE_BASE_MASTER_REF],
    });
    const sha = result.exitCode === 0 ? parseUpstreamCommit(result.stdout) : null;
    if (sha === null) {
        throw new Error(
            `Cannot resolve KnowledgeBase commit from ${KNOWLEDGE_BASE_REMOTE}: ${result.stderr}`,
        );
    }
    return sha;
}
