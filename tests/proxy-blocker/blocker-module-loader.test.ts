import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/config-error';
import { filteringExecutors } from '../../src/orchestrator/filtering-executors';
import { loadBlockerModules } from '../../src/proxy-blocker/blocker-module-loader';
import { blockerModuleProcessEnvironment } from '../../src/proxy-blocker/blocker-module-manifest';

const temporaryRoots: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
});

/**
 * A directory holding one module manifest file with the given content.
 */
async function directoryWithManifest(content: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'blocker-module-loader-'));
    temporaryRoots.push(directory);
    await writeFile(join(directory, 'blocker-module.json'), content);
    return directory;
}

const MANIFEST = {
    executor: 'loader_proxy',
    selectionGuidance: 'Desktop reports belong to loader_proxy.',
    command: ['node', './module.mjs'],
    env: ['DEMO_LICENSE_KEY'],
};

const ENVIRONMENT_NAME = 'the test environment';

describe('loadBlockerModules', () => {
    it('registers the executor of a manifest given by a relative path', async () => {
        const directory = await directoryWithManifest(JSON.stringify(MANIFEST));

        const modules = loadBlockerModules(
            ['blocker-module.json'],
            directory,
            { DEMO_LICENSE_KEY: 'licence-1' },
            ENVIRONMENT_NAME,
        );

        expect(modules.map((module) => module.manifest.executor)).toEqual(['loader_proxy']);
        expect(filteringExecutors.has('loader_proxy')).toBe(true);
    });

    it('fails named when the environment lacks a variable the module needs', async () => {
        const directory = await directoryWithManifest(
            JSON.stringify({ ...MANIFEST, executor: 'needy_proxy' }),
        );

        expect(() =>
            loadBlockerModules(['blocker-module.json'], directory, {}, ENVIRONMENT_NAME),
        ).toThrow(
            new ConfigError(
                'Blocker module needy_proxy needs DEMO_LICENSE_KEY in the test environment.',
            ),
        );
        expect(filteringExecutors.has('needy_proxy')).toBe(false);
    });

    it.each([
        ['is not a manifest', JSON.stringify({ executor: 'broken_proxy' })],
        ['is not JSON', '{ "executor": '],
    ])('fails with the manifest path when the file %s', async (_, content) => {
        const directory = await directoryWithManifest(content);
        const path = join(directory, 'blocker-module.json');

        expect(() =>
            loadBlockerModules(['blocker-module.json'], directory, {}, ENVIRONMENT_NAME),
        ).toThrow(ConfigError);
        expect(() =>
            loadBlockerModules(['blocker-module.json'], directory, {}, ENVIRONMENT_NAME),
        ).toThrow(path);
    });

    it('fails with the manifest path when the file does not exist', async () => {
        const directory = await directoryWithManifest(JSON.stringify(MANIFEST));
        const path = join(directory, 'missing', 'blocker-module.json');

        expect(() => loadBlockerModules([path], directory, {}, ENVIRONMENT_NAME)).toThrow(path);
    });

    it('passes an optional variable only when the environment sets it', async () => {
        const directory = await directoryWithManifest(
            JSON.stringify({ ...MANIFEST, optionalEnv: ['DEMO_CACHED_STATE'] }),
        );
        const [module] = loadBlockerModules(
            ['blocker-module.json'],
            directory,
            { DEMO_LICENSE_KEY: 'licence-1' },
            ENVIRONMENT_NAME,
        );

        expect(
            blockerModuleProcessEnvironment(
                module!,
                { PATH: '/bin', DEMO_LICENSE_KEY: 'licence-1', UNRELATED_SECRET: 'nope' },
                '/private/workspace',
            ),
        ).toEqual({
            PATH: '/bin',
            DEMO_LICENSE_KEY: 'licence-1',
            FILTERS_AGENT_BLOCKER_WORKSPACE: '/private/workspace',
        });
        expect(
            blockerModuleProcessEnvironment(
                module!,
                { DEMO_LICENSE_KEY: 'licence-1', DEMO_CACHED_STATE: '/cache/state.tar.gz' },
                '/private/workspace',
            ),
        ).toEqual({
            DEMO_LICENSE_KEY: 'licence-1',
            DEMO_CACHED_STATE: '/cache/state.tar.gz',
            FILTERS_AGENT_BLOCKER_WORKSPACE: '/private/workspace',
        });
    });
});
