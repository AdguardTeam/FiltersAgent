import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import {
    HistoricalBuildError,
    HistoricalBuildFailureCode,
} from '../../../lab/local/historical-build-error';
import { prepareHistoricalExtensionBuild } from '../../../lab/local/historical-extension-build';
import type { HistoricalExtensionRelease } from '../../../lab/local/historical-extension-releases';
import { ExtensionManifestVersion } from '../../../src/environment/extension-preparation';
import { readBundledListLines } from '../../../src/browser/extension-list-text';

const roots: string[] = [];
const marker = ';// CONCATENATED MODULE: ./Extension/filters/chromium-mv3/local_script_rules.js';
const oldBlock = 'const bundledRules = { "old": "old rule" };';
const normalBackground = `const before = true;\n${marker}\n${oldBlock}\n;// CONCATENATED MODULE: ./after.js\nconst after = true;`;
const tagScript =
    'export const localScriptRules = { "example.com": "tag script", shared: "shared script" };';
const logger = pino({ level: 'silent' });

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
    options: {
        background?: string;
        script?: string;
        keys?: string[];
        releaseOnlyResource?: boolean;
        module?: boolean;
    } = {},
) {
    const root = await mkdtemp(join(tmpdir(), 'historical-build-test-'));
    roots.push(root);
    const releaseDir = join(root, 'release');
    const remote = join(root, 'remote');
    const filters = join(remote, 'Extension/filters/chromium-mv3');
    const manifest = {
        manifest_version: 3,
        version: '5.4.3.1',
        name: 'Fixture extension',
        background: {
            service_worker: 'pages/background.js',
            ...(options.module ? { type: 'module' } : {}),
        },
        declarative_net_request: {
            rule_resources: [
                {
                    id: 'ruleset_1',
                    enabled: true,
                    path: 'filters/declarative/ruleset_1/ruleset_1.json',
                },
                ...(options.releaseOnlyResource
                    ? [
                          {
                              id: 'ruleset_99',
                              enabled: false,
                              path: 'filters/declarative/ruleset_99/ruleset_99.json',
                          },
                      ]
                    : []),
            ],
        },
    };
    const entries = {
        'manifest.json': JSON.stringify(manifest),
        'pages/background.js': options.background ?? normalBackground,
        'filters/declarative/ruleset_1/ruleset_1.json':
            '[{"metadata":{"rawFilterList":"release rule"}}]',
        'filters/declarative/ruleset_99/ruleset_99.json': '[]',
    };
    for (const [path, value] of Object.entries(entries)) {
        await mkdir(dirname(join(releaseDir, path)), { recursive: true });
        await writeFile(join(releaseDir, path), value);
    }
    const zipPath = join(root, 'release.zip');
    execFileSync('zip', ['-qr', zipPath, '.'], { cwd: releaseDir });
    const bytes = new Uint8Array(await readFile(zipPath));
    await mkdir(join(filters, 'declarative/ruleset_1'), { recursive: true });
    await writeFile(
        join(filters, 'declarative/ruleset_1/ruleset_1.json'),
        '[{"metadata":{"rawFilterList":"tag rule\\nsecond tag rule"}}]',
    );
    await writeFile(join(filters, 'local_script_rules.js'), options.script ?? tagScript);
    await writeFile(
        join(filters, 'local_script_rules.json'),
        JSON.stringify({
            rules: Object.fromEntries(
                (options.keys ?? ['example.com', 'shared']).map((key) => [key, 'rule']),
            ),
        }),
    );
    execFileSync('git', ['init', '--quiet', '--initial-branch=master', remote]);
    execFileSync('git', ['add', '.'], { cwd: remote });
    execFileSync(
        'git',
        [
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.com',
            'commit',
            '--quiet',
            '-m',
            'Add fixture lists',
        ],
        { cwd: remote },
    );
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: remote,
        encoding: 'utf8',
    }).trim();
    const release: HistoricalExtensionRelease = {
        codeLine: '5.4.3',
        tag: 'v5.4.3.1',
        assetName: 'chrome-mv3.zip',
        downloadUrl: 'https://example.com/chrome-mv3.zip',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        manifestVersion: ExtensionManifestVersion.Mv3,
    };
    let downloads = 0;
    const fetchImpl: typeof fetch = async () => {
        downloads += 1;
        return new Response(bytes);
    };
    return {
        root,
        remote,
        release,
        downloads: () => downloads,
        options: {
            build: { version: '5.4.3.99', releaseTag: release.tag, autobuildCommit: commit },
            cacheRoot: join(root, 'cache'),
            logger,
            fetchImpl,
            releases: [release],
            autobuildRemoteUrl: remote,
        },
    };
}

describe('prepareHistoricalExtensionBuild', () => {
    it("assembles the release with the tag's lists, script rules and reporter version", async () => {
        const f = await fixture();
        const result = await prepareHistoricalExtensionBuild(f.options);
        expect(readBundledListLines(result.extensionDir, 1)).toEqual([
            'tag rule',
            'second tag rule',
        ]);
        const background = await readFile(join(result.extensionDir, 'pages/background.js'), 'utf8');
        expect(background).toContain(
            'const bundledRules = { "example.com": "tag script", shared: "shared script" };',
        );
        expect(background).toContain('const before = true;');
        expect(background).toContain('const after = true;');
        expect(
            JSON.parse(await readFile(join(result.extensionDir, 'manifest.json'), 'utf8')).version,
        ).toBe(f.options.build.version);
        expect(result.manifestVersion).toBe(ExtensionManifestVersion.Mv3);
        expect(result.provenance).toEqual({
            version: f.options.build.version,
            releaseTag: f.release.tag,
            releaseSha256: f.release.sha256,
            autobuildTag: 'autobuild-v5.4.3.99',
            autobuildCommit: f.options.build.autobuildCommit,
        });
        expect(result.extensionDir).toBe(
            join(
                f.options.cacheRoot,
                'extensions/historical',
                `${f.release.sha256}-${f.options.build.autobuildCommit}`,
            ),
        );
    });

    it('retains dollar signs in the script-rule binding used by the release code', async () => {
        const f = await fixture({
            background:
                normalBackground.replaceAll('bundledRules', () => 'bundled$$Rules') +
                '\nglobalThis.loadedRules = bundled$$Rules;',
        });
        const result = await prepareHistoricalExtensionBuild(f.options);
        const background = await readFile(join(result.extensionDir, 'pages/background.js'), 'utf8');
        const context: { loadedRules?: Record<string, string> } = {};
        runInNewContext(background, context);
        expect(context.loadedRules).toEqual({
            'example.com': 'tag script',
            shared: 'shared script',
        });
    });

    it('reuses the cached build without downloading or fetching again', async () => {
        const f = await fixture();
        const first = await prepareHistoricalExtensionBuild(f.options);
        await rm(f.remote, { recursive: true });
        expect(await prepareHistoricalExtensionBuild(f.options)).toEqual(first);
        expect(f.downloads()).toBe(1);
    });

    it('two concurrent builds of one pin return the same complete directory', async () => {
        const f = await fixture();
        const [a, b] = await Promise.all([
            prepareHistoricalExtensionBuild(f.options),
            prepareHistoricalExtensionBuild(f.options),
        ]);
        expect(a).toEqual(b);
        expect(readBundledListLines(a.extensionDir, 1)).toEqual(['tag rule', 'second tag rule']);
        expect(await readFile(join(a.extensionDir, 'pages/background.js'), 'utf8')).toContain(
            'tag script',
        );
        expect(
            JSON.parse(await readFile(join(a.extensionDir, 'manifest.json'), 'utf8')).version,
        ).toBe(f.options.build.version);
    });

    it('refuses a version whose code line has no listed release', async () => {
        const f = await fixture();
        await expect(
            prepareHistoricalExtensionBuild({
                ...f.options,
                build: { ...f.options.build, version: '5.9.1.2' },
            }),
        ).rejects.toMatchObject({ code: HistoricalBuildFailureCode.ReleaseUnknown });
        expect(f.downloads()).toBe(0);
    });

    it('refuses a release whose digest does not match the table', async () => {
        const f = await fixture();
        await expect(
            prepareHistoricalExtensionBuild({
                ...f.options,
                releases: [{ ...f.release, sha256: 'a'.repeat(64) }],
            }),
        ).rejects.toMatchObject({
            code: HistoricalBuildFailureCode.ReleaseUnavailable,
            cause: expect.any(Error),
            message: expect.stringContaining('digest_mismatch'),
        });
    });

    it('refuses an autobuild commit the remote does not have', async () => {
        const f = await fixture();
        const error = await prepareHistoricalExtensionBuild({
            ...f.options,
            build: { ...f.options.build, autobuildCommit: 'a'.repeat(40) },
        }).catch((cause) => cause);
        expect(error).toBeInstanceOf(HistoricalBuildError);
        expect(error.code).toBe(HistoricalBuildFailureCode.AutobuildUnavailable);
        expect(error.message).toContain('fetch');
        expect(error.message).toContain('stderr');
    });

    it.each([
        { background: normalBackground.replace(marker, '// missing') },
        { background: `${normalBackground}\n${marker}\nconst duplicate = {};` },
        { background: normalBackground.replace(oldBlock, `${oldBlock}\nconst extra = {};`) },
        { script: 'const localScriptRules = {};' },
    ])(
        'refuses a bundle whose script-rules module or variable is not found exactly once: %j',
        async (variant) => {
            const f = await fixture(variant);
            await expect(prepareHistoricalExtensionBuild(f.options)).rejects.toMatchObject({
                code: HistoricalBuildFailureCode.BundleLayoutMismatch,
            });
        },
    );

    it('refuses a spliced bundle that does not parse', async () => {
        const f = await fixture({ script: 'export const localScriptRules = { broken: ; };' });
        await expect(prepareHistoricalExtensionBuild(f.options)).rejects.toMatchObject({
            code: HistoricalBuildFailureCode.BundleParseFailed,
        });
    });

    it("refuses script rules that do not cover the tag's rule keys", async () => {
        const f = await fixture({ keys: ['example.com', 'missing.example.org'] });
        await expect(prepareHistoricalExtensionBuild(f.options)).rejects.toMatchObject({
            code: HistoricalBuildFailureCode.ScriptRulesNotCovered,
            message: expect.stringContaining('missing.example.org'),
        });
    });

    it('refuses helper object keys as coverage for an empty script-rule object', async () => {
        const f = await fixture({
            script: 'const helper = { expected: 1 }; export const localScriptRules = {};',
            keys: ['expected'],
        });
        await expect(prepareHistoricalExtensionBuild(f.options)).rejects.toMatchObject({
            code: HistoricalBuildFailureCode.BundleLayoutMismatch,
        });
    });

    it('replaces the release filters with the tag tree instead of overlaying it', async () => {
        const f = await fixture();
        const result = await prepareHistoricalExtensionBuild(f.options);
        await expect(
            access(join(result.extensionDir, 'filters/declarative/ruleset_99')),
        ).rejects.toThrow();
    });

    it('refuses a manifest that names a ruleset only the release had', async () => {
        const f = await fixture({ releaseOnlyResource: true });
        await expect(prepareHistoricalExtensionBuild(f.options)).rejects.toMatchObject({
            code: HistoricalBuildFailureCode.RulesetMissing,
            message: expect.stringContaining('ruleset_99'),
        });
    });

    it('parses a module background using its manifest source type', async () => {
        const f = await fixture({
            module: true,
            background: `import './other.js';\n${normalBackground}`,
        });
        await expect(prepareHistoricalExtensionBuild(f.options)).resolves.toMatchObject({
            manifestVersion: ExtensionManifestVersion.Mv3,
        });
    });
});
