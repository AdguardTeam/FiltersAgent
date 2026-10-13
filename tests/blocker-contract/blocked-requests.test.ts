import { describe, expect, it, vi } from 'vitest';
import { followBlockedRequests } from '../../src/blocker-contract/blocked-requests';
import {
    BlockerEventKind,
    type BlockerContract,
} from '../../src/blocker-contract/blocker-contract';
import type { Logger } from '../../src/logger/logger';

function logger(): Logger & { warn: ReturnType<typeof vi.fn> } {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger & {
        warn: ReturnType<typeof vi.fn>;
    };
}

describe('followBlockedRequests', () => {
    it('reads the requests a blocking rule stopped, not those an exception let through', async () => {
        const blocker = {
            log: vi.fn(async () => ({
                revision: 1,
                cursor: 'next',
                events: [
                    {
                        kind: BlockerEventKind.Request,
                        url: 'https://ads.example/a.js',
                        rule: '||ads.example^',
                        handshakeBlock: false,
                    },
                    {
                        kind: BlockerEventKind.Request,
                        url: 'https://ads.example/ok.js',
                        rule: '@@||ads.example/ok.js',
                        handshakeBlock: false,
                    },
                ],
            })),
        } as unknown as BlockerContract;
        const follower = followBlockedRequests(blocker, 'start', 1, logger());

        follower.read();
        await vi.waitFor(() => expect([...follower.read()]).toEqual(['https://ads.example/a.js']));
        follower.stop();
    });

    it('stays quiet once stopped, so the blocker shutting down reads as no failure', async () => {
        const blocker = {
            log: vi.fn(async () => {
                throw new Error('The blocker module is no longer running, so log cannot reach it.');
            }),
        } as unknown as BlockerContract;
        const log = logger();
        const follower = followBlockedRequests(blocker, 'start', 1, log);

        follower.stop();
        follower.read();
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(blocker.log).not.toHaveBeenCalled();
        expect(log.warn).not.toHaveBeenCalled();
    });
});
