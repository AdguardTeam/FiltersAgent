import { join } from 'node:path';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type * as v from 'valibot';
import { spawnBlockerProcess } from '../../src/blocker-contract/blocker-process';
import type {
    BLOCKER_RESULT_SCHEMAS,
    BlockerMethod,
    BlockerResults,
} from '../../src/blocker-contract/blocker-wire';
import type { Logger } from '../../src/logger/logger';

const MODULE = join(import.meta.dirname, 'fixtures', 'fake-blocker-module.ts');
const TSX_LOADER = join(
    import.meta.dirname,
    '..',
    '..',
    'node_modules',
    'tsx',
    'dist',
    'loader.mjs',
);

function logger(): Logger & { info: ReturnType<typeof vi.fn> } {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger & {
        info: ReturnType<typeof vi.fn>;
    };
}

function fakeModule(mode: string, log: Logger) {
    return spawnBlockerProcess({
        command: process.execPath,
        args: ['--import', TSX_LOADER, MODULE],
        env: { ...process.env, FAKE_BLOCKER_MODE: mode },
        logger: log,
    });
}

describe('spawnBlockerProcess', () => {
    it('drives a module process through the six operations and stops it', async () => {
        const log = logger();
        const blocker = fakeModule('ok', log);

        expect((await blocker.describe()).product).toBe('Fake blocker');
        const started = await blocker.start({
            lists: [
                { id: 2, content: '||ads.example^\n' },
                { id: 14, content: '##.cookie\n' },
            ],
            enabledListIds: [2],
            userRules: [],
            listReplacement: null,
        });
        expect(started.revision).toBe(1);
        const applied = await blocker.apply({
            enabledListIds: null,
            userRules: ['##.ad'],
            listReplacement: null,
        });
        expect(applied).toMatchObject({ revision: 2, restarted: true });
        expect(await blocker.state()).toMatchObject({
            lists: [{ id: 2 }, { id: 14 }],
            userRules: ['##.ad'],
        });
        const cursor = (await blocker.log(null)).cursor;
        expect((await blocker.log(cursor)).events).toEqual([
            expect.objectContaining({ rule: '||ads.example^' }),
            {
                kind: 'unfiltered_host',
                host: 'tunnelled.example',
                reason: "server doesn't have valid certificate",
            },
        ]);
        expect(await blocker.stop()).toEqual({ licenceReleased: true });

        const output = log.info.mock.calls.map(([fields]) => (fields as { line?: string }).line);
        expect(output).toContain('fake blocker stopped');
        await expect(blocker.state()).rejects.toThrow(/no longer running/u);
    }, 30_000);

    it('fails a module whose command cannot start and stops it at once', async () => {
        const blocker = spawnBlockerProcess({
            command: join(import.meta.dirname, 'fixtures', 'no-such-module'),
            args: [],
            env: {},
            logger: logger(),
        });

        await expect(blocker.describe()).rejects.toThrow(/could not run/u);
        expect(await blocker.stop()).toEqual({ licenceReleased: false });
        await expect(blocker.state()).rejects.toThrow(/no longer running/u);
    });

    it('fails a request whose module died before answering', async () => {
        const blocker = fakeModule('exit-on-describe', logger());

        await expect(blocker.describe()).rejects.toThrow(/exited \(code 3/u);
    }, 30_000);

    it('refuses a result that breaks the contract and names the operation', async () => {
        const blocker = fakeModule('invalid-describe', logger());

        await expect(blocker.describe()).rejects.toThrow(/describe with an invalid result/u);
        await blocker.stop();
    }, 30_000);

    it('ends the module process even when its Stop fails', async () => {
        const blocker = fakeModule('fail-on-stop', logger());
        await blocker.describe();

        await expect(blocker.stop()).rejects.toThrow(/native cleanup failed/u);
        await expect(blocker.state()).rejects.toThrow(/no longer running/u);
    }, 30_000);

    it('parses every result into exactly the contract type', () => {
        expectTypeOf<{
            [M in BlockerMethod]: v.InferOutput<(typeof BLOCKER_RESULT_SCHEMAS)[M]>;
        }>().toMatchTypeOf<BlockerResults>();
    });
});
