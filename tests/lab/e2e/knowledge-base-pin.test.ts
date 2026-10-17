import { describe, expect, it, vi } from 'vitest';
import {
    KNOWLEDGE_BASE_REMOTE,
    resolveKnowledgeBaseMasterSha,
} from '../../../lab/e2e/knowledge-base-pin';

describe('resolveKnowledgeBaseMasterSha', () => {
    it('reads the master commit from ls-remote', async () => {
        const sha = 'abcdef0123456789abcdef0123456789abcdef01';
        const run = vi.fn(async () => ({
            exitCode: 0,
            stdout: `${sha.toUpperCase()}\trefs/heads/master\n`,
            stderr: '',
        }));

        await expect(resolveKnowledgeBaseMasterSha({ run })).resolves.toBe(sha);
    });

    it.each([
        { exitCode: 1, stdout: '', stderr: 'remote unavailable' },
        { exitCode: 0, stdout: '', stderr: 'no matching ref' },
    ])('fails naming the remote when ls-remote names no commit ($exitCode)', async (result) => {
        const failure = resolveKnowledgeBaseMasterSha({ run: vi.fn(async () => result) });
        await expect(failure).rejects.toThrow(KNOWLEDGE_BASE_REMOTE);
        await expect(failure).rejects.toThrow(result.stderr);
    });
});
