import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const oxlintBin = join(repoRoot, 'node_modules', '.bin', 'oxlint');
const pluginPath = join(repoRoot, 'lint', 'local-rules.mjs');

/**
 * Write one fixture file under a throwaway lint root.
 */
function writeFixture(root: string, rel: string, content: string): void {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
}

/**
 * Run the real oxlint binary over a fixture root with only the boundary rules enabled.
 */
function lintFixture(files: Record<string, string>): { status: number; output: string } {
    const root = mkdtempSync(join(tmpdir(), 'boundary-lint-'));
    writeFixture(root, 'lab/secret.ts', 'export const secret = 1;\n');
    for (const [rel, content] of Object.entries(files)) {
        writeFixture(root, rel, content);
    }
    writeFixture(
        root,
        '.oxlintrc.json',
        JSON.stringify({
            jsPlugins: [{ name: 'local', specifier: pluginPath }],
            rules: {
                'local/no-lab-imports': 'error',
                'local/no-adguard-cli-vocabulary': 'error',
            },
        }),
    );
    try {
        const output = execFileSync(oxlintBin, ['--config', join(root, '.oxlintrc.json'), 'src'], {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { status: 0, output };
    } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string };
        return {
            status: failure.status ?? -1,
            output: `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
        };
    }
}

describe('public boundary lint', () => {
    it('fails and names the file and the import when src imports lab', () => {
        const { status, output } = lintFixture({
            'src/bad-import.ts':
                "import { secret } from '../lab/secret';\nexport const v = secret;\n",
        });
        expect(status).not.toBe(0);
        expect(output).toContain('bad-import.ts');
        expect(output).toContain('../lab/secret');
    });

    it('passes a clean src tree', () => {
        const { status } = lintFixture({
            'src/ok.ts':
                "export const filters = 'https://filters.adtidy.org/extension/ublock/filters.txt';\n",
        });
        expect(status).toBe(0);
    });

    it('fails and names the file for every non-import route into the lab tree', () => {
        const { status, output } = lintFixture({
            // Each file exercises one route `import`/`export ... from` does not cover: a plain
            // require, a chained createRequire call, a template-literal dynamic import, a
            // type-position import, and the @/* tsconfig alias (which maps onto src/, so `..`
            // cancels it and lands back on the repo-root lab/ tree).
            'src/bad-require.ts': "const r = require('../lab/secret');\nexport { r };\n",
            'src/bad-create-require.ts':
                "import { createRequire } from 'node:module';\n" +
                "const req = createRequire(import.meta.url)('../lab/secret');\n" +
                'export { req };\n',
            'src/bad-template-import.ts': 'const mod = import(`../lab/secret`);\nexport { mod };\n',
            'src/bad-type-import.ts':
                "type Secret = import('../lab/secret').Secret;\nexport type { Secret };\n",
            'src/bad-alias.ts': "import y from '@/../lab/secret';\nexport { y };\n",
        });
        expect(status).not.toBe(0);
        expect(output).toContain('bad-require.ts');
        expect(output).toContain('bad-create-require.ts');
        expect(output).toContain('bad-template-import.ts');
        expect(output).toContain('bad-type-import.ts');
        expect(output).toContain('bad-alias.ts');
        expect(output).toContain('@/../lab/secret');
    });

    it('passes require, createRequire, a type-position import and the @/* alias naming only src', () => {
        const { status } = lintFixture({
            'src/helper.ts': 'export const helper = 1;\nexport type Helper = number;\n',
            'src/ok-require.ts': "const path = require('node:path');\nexport { path };\n",
            'src/ok-create-require.ts':
                "import { createRequire } from 'node:module';\n" +
                "const req = createRequire(import.meta.url)('./helper');\n" +
                'export { req };\n',
            'src/ok-type-import.ts': "type H = import('./helper').Helper;\nexport type { H };\n",
            'src/ok-alias.ts': "import { helper } from '@/helper';\nexport { helper };\n",
        });
        expect(status).toBe(0);
    });

    it('fails and names the file when src mentions the lab executor', () => {
        const { status, output } = lintFixture({
            // Even a throwaway mention of the lab-registered executor name breaks the boundary:
            // src knows executors only through the open executor-name vocabulary.
            'src/bad-executor.ts': "const kind = 'adguard_cli';\nexport { kind };\n",
        });
        expect(status).not.toBe(0);
        expect(output).toContain('bad-executor.ts');
        expect(output).toContain('adguard_cli');
    });

    it('allows the same executor name in the lab tree', () => {
        const { status } = lintFixture({
            'src/ok.ts': 'export const ok = 1;\n',
            'lab/local/blocker-modules.ts': "const kind = 'adguard_cli';\nexport { kind };\n",
        });
        expect(status).toBe(0);
    });

    it('allows the executor name inside the AdGuard CLI module', () => {
        const { status } = lintFixture({
            'src/adguard-cli/executor-name.ts': "const kind = 'adguard_cli';\nexport { kind };\n",
        });
        expect(status).toBe(0);
    });

    it('passes a clean src tree that keeps the command-line capabilities the vocabulary still owns', () => {
        const { status } = lintFixture({
            'src/clean-capabilities.ts':
                "const capabilities = ['cli_installation'] as const;\nconst proxyPath = 'https://filters.adtidy.org/extension/ublock/filters.txt';\nexport { capabilities, proxyPath };\n",
        });
        expect(status).toBe(0);
    });
});
