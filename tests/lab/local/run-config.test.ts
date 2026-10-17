import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GoldenRunSchemaVersion } from '../../../lab/e2e/golden-case';
import { loadLocalRunConfig } from '../../../lab/local/run-config';

const extensionBuild = {
    version: '5.4.3.99',
    releaseTag: 'v5.4.3.1',
    autobuildCommit: 'a'.repeat(40),
};

describe('loadLocalRunConfig', () => {
    it('builds current source boundaries without preselecting a local clone', () => {
        const config = loadLocalRunConfig('current', undefined, false);

        expect(config.environment).toBe('current');
        expect(config.filters.environment).toEqual({ kind: 'current' });
        expect(config.filters.localSourcePath).toBeUndefined();
        expect(config.knowledgeBase.environment).toEqual({ kind: 'current' });
        expect(config.knowledgeBase.localSourcePath).toBeUndefined();
    });

    it('derives the citation repositories from the configured remotes', () => {
        const directory = mkdtempSync(join(tmpdir(), 'local-run-config-fork-'));
        const configPath = join(directory, 'fork.json');
        writeFileSync(
            configPath,
            JSON.stringify({
                filtersBaseSha: '4e28093e719cbb2bab819b6d3a84c12f441343c6',
                extensionBuild,
                filtersRemoteUrl: 'https://github.com/fork-owner/AdguardFilters.git',
                knowledgeBaseRemoteUrl: 'git@github.com:fork-owner/KnowledgeBase.git',
            }),
        );

        const config = loadLocalRunConfig('historical', configPath, false);

        expect(config.knowledgeBase).toMatchObject({
            knowledgeBaseRepository: 'fork-owner/KnowledgeBase',
            filtersRepository: 'fork-owner/AdguardFilters',
        });
    });

    it('names the variable of a remote that yields no citation repository', () => {
        const directory = mkdtempSync(join(tmpdir(), 'local-run-config-mirror-'));
        const configPath = join(directory, 'mirror.json');
        writeFileSync(
            configPath,
            JSON.stringify({
                filtersBaseSha: '4e28093e719cbb2bab819b6d3a84c12f441343c6',
                extensionBuild,
                filtersRemoteUrl: '/tmp/mirror/list.git.bare',
            }),
        );

        expect(() => loadLocalRunConfig('historical', configPath, false)).toThrow(
            /Filters remote/i,
        );
    });

    it('pins the pre-issue filters base and extension build for a historical run', () => {
        const directory = mkdtempSync(join(tmpdir(), 'local-run-config-'));
        const configPath = join(directory, 'historical.json');
        writeFileSync(
            configPath,
            JSON.stringify({
                schemaVersion: GoldenRunSchemaVersion.Current,
                issueNumber: 4,
                issueFile: 'issue/issue.json',
                filtersBaseSha: '4e28093e719cbb2bab819b6d3a84c12f441343c6',
                extensionBuild,
            }),
        );

        const config = loadLocalRunConfig('historical', configPath, true);

        expect(config.filters.environment).toEqual({
            kind: 'historical',
            baseSha: '4e28093e719cbb2bab819b6d3a84c12f441343c6',
        });
        expect(config.extensionBuild).toEqual(extensionBuild);
        expect(config.filters.keepTemporaryFiles).toBe(true);
        expect(config.knowledgeBase.keepTemporaryFiles).toBe(true);
        expect(config).not.toHaveProperty('requiredFilterIds');
    });

    it('refuses a historical config without extensionBuild and names benchmark:case:check', () => {
        const directory = mkdtempSync(join(tmpdir(), 'local-run-config-missing-build-'));
        const configPath = join(directory, 'historical.json');
        writeFileSync(configPath, JSON.stringify({ filtersBaseSha: 'a'.repeat(40) }));

        expect(() => loadLocalRunConfig('historical', configPath, false)).toThrow(
            /benchmark:case:check/,
        );
    });

    it('omits the extension build from current runs even when the config includes it', () => {
        const directory = mkdtempSync(join(tmpdir(), 'local-run-config-current-build-'));
        const configPath = join(directory, 'current.json');
        writeFileSync(configPath, JSON.stringify({ extensionBuild }));

        expect(loadLocalRunConfig('current', configPath, false)).not.toHaveProperty(
            'extensionBuild',
        );
    });

    it('requires filtersBaseSha for historical execution', () => {
        const directory = mkdtempSync(join(tmpdir(), 'local-run-config-invalid-'));
        const configPath = join(directory, 'historical.json');
        writeFileSync(configPath, JSON.stringify({ schemaVersion: 2 }));

        expect(() => loadLocalRunConfig('historical', configPath, false)).toThrow(
            /filtersBaseSha/i,
        );
    });

    it('accepts source overrides without accepting a model choice from config', () => {
        const directory = mkdtempSync(join(tmpdir(), 'local-run-config-source-'));
        const configPath = join(directory, 'historical.json');
        writeFileSync(
            configPath,
            JSON.stringify({
                filtersBaseSha: '4e28093e719cbb2bab819b6d3a84c12f441343c6',
                extensionBuild,
                filtersLocalSourcePath: '/tmp/filters-source',
                filtersRemoteUrl: 'https://github.com/fork-owner/AdguardFilters.git',
            }),
        );

        const config = loadLocalRunConfig('historical', configPath, false);

        expect(config.filters).toEqual(
            expect.objectContaining({
                localSourcePath: '/tmp/filters-source',
                remoteUrl: 'https://github.com/fork-owner/AdguardFilters.git',
            }),
        );
    });

    it('threads an optional instruction path from the case file into the run config', () => {
        const directory = mkdtempSync(join(tmpdir(), 'local-run-config-instruction-'));
        const configPath = join(directory, 'historical.json');
        writeFileSync(
            configPath,
            JSON.stringify({
                filtersBaseSha: '4e28093e719cbb2bab819b6d3a84c12f441343c6',
                extensionBuild,
                instructionPath: 'AGENT-INSTRUCTION.md',
            }),
        );

        const config = loadLocalRunConfig('historical', configPath, false);

        expect(config.instructionPath).toBe('AGENT-INSTRUCTION.md');
    });

    it('leaves the instruction path unset when the case file names none', () => {
        const config = loadLocalRunConfig('current', undefined, false);

        expect(config.instructionPath).toBeUndefined();
    });

    it('still requires an explicit run config for historical mode', () => {
        expect(() => loadLocalRunConfig('historical', undefined, false)).toThrow(/run-config/i);
    });
});
