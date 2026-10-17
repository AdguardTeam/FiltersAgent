import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../../src/logger/logger';
import { ExtensionManifestVersion } from '../../../src/environment/extension-preparation';
import { GoldenCaseCheckStatus, checkGoldenCase } from '../../../lab/e2e/golden-case-check';
import { GoldenRunSchemaVersion, loadGoldenRunCase } from '../../../lab/e2e/golden-case';
import * as releases from '../../../lab/local/historical-extension-releases';
import type { withPreparedFiltersCheckout } from '../../../src/local/filters-preparer';
import { CheckoutSource } from '../../../src/types/checkout-source';
import { ExtensionEnvironmentKind } from '../../../src/types/extension-environment-kind';
import type { PrepareHistoricalExtensionBuildOptions } from '../../../lab/local/historical-extension-build';

const roots: string[] = [];
const pin = { version: '5.4.3.99', releaseTag: 'v5.4.3.1', autobuildCommit: 'a'.repeat(40) };
const rule = 'example.com##.ad';

afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

function fixture(current = false, list = '! Clean pre-fix list') {
    const root = mkdtempSync(join(tmpdir(), 'case-check-'));
    roots.push(root);
    const caseDirectory = join(root, 'example-com-4');
    mkdirSync(join(caseDirectory, 'issue'), { recursive: true });
    const run = {
        schemaVersion: current ? GoldenRunSchemaVersion.Current : GoldenRunSchemaVersion.Legacy,
        issueNumber: 4,
        issueFile: 'issue/issue.json',
        filtersBaseSha: 'b'.repeat(40),
        ...(current ? { extensionBuild: pin } : {}),
    };
    writeFileSync(join(caseDirectory, 'run.json'), JSON.stringify(run));
    writeFileSync(
        join(caseDirectory, 'issue', 'issue.json'),
        JSON.stringify({
            schemaVersion: 1,
            rawIssue: {
                number: 4,
                url: 'https://github.com/AdguardTeam/AdguardFilters/issues/4',
                title: 'example.com',
                body: 'Ads remain.',
                state: 'closed',
                labels: [],
                assignee: null,
                comments: [],
            },
            reporterComments: [],
            attachments: [],
        }),
    );
    writeFileSync(
        join(caseDirectory, 'oracle.json'),
        JSON.stringify({
            humanFixCommit: 'c'.repeat(40),
            issueCreatedAt: '2026-07-14T06:08:12Z',
            fixCommittedAt: '2026-07-14T09:08:12Z',
        }),
    );
    const ruleset = join(root, 'extension', 'filters', 'declarative', 'ruleset_2');
    mkdirSync(ruleset, { recursive: true });
    writeFileSync(
        join(ruleset, 'ruleset_2.json'),
        JSON.stringify([{ metadata: { rawFilterList: list } }]),
    );
    writeFileSync(
        join(root, 'extension', 'manifest.json'),
        JSON.stringify({
            declarative_net_request: {
                rule_resources: [
                    {
                        id: 'ruleset_2',
                        enabled: true,
                        path: 'filters/declarative/ruleset_2/ruleset_2.json',
                    },
                ],
            },
        }),
    );
    const base = join(root, 'base');
    mkdirSync(base);
    const prepareBase: typeof withPreparedFiltersCheckout = async (config, callback) => {
        expect(config.environment).toEqual({
            kind: ExtensionEnvironmentKind.Historical,
            baseSha: run.filtersBaseSha,
        });
        return callback({
            filtersPath: base,
            checkoutPath: base,
            provenance: {
                environment: ExtensionEnvironmentKind.Historical,
                source: CheckoutSource.LocalSharedClone,
                sourceLocation: base,
                requestedRevision: run.filtersBaseSha,
                commit: run.filtersBaseSha,
            },
        });
    };
    const dependencies = {
        withPreparedFiltersCheckout: prepareBase,
        resolveAutobuildCommit: vi.fn(async () => pin.autobuildCommit),
        prepareHistoricalExtensionBuild: vi.fn(
            async ({ build }: PrepareHistoricalExtensionBuildOptions) => ({
                extensionDir: join(root, 'extension'),
                manifestVersion: ExtensionManifestVersion.Mv3,
                provenance: {
                    ...build,
                    releaseSha256: 'd'.repeat(64),
                    autobuildTag: `autobuild-v${build.version}`,
                },
            }),
        ),
        readHumanCommitRuleLines: vi.fn(async () => ({ added: [rule], removed: [] as string[] })),
    };
    return {
        caseDirectory,
        base,
        dependencies,
        options: { cacheRoot: join(root, 'cache'), logger: createLogger() },
    };
}

describe('checkGoldenCase', () => {
    it('ignores pre-existing duplicate additions and prints absent removals while migrating', async () => {
        const { caseDirectory, options, dependencies, base } = fixture(false, rule);
        mkdirSync(join(base, 'unmapped', 'nested'), { recursive: true });
        writeFileSync(join(base, 'unmapped', 'nested', 'rules.txt'), ` ${rule} \n`);
        const removed = '||example.org/old-ad^';
        dependencies.readHumanCommitRuleLines.mockResolvedValue({
            added: [rule],
            removed: [removed],
        });
        const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        const result = await checkGoldenCase(
            caseDirectory,
            {
                ...options,
                extensionVersion: pin.version,
                onWarning: (warning) => process.stderr.write(`${warning}\n`),
            },
            dependencies,
        );
        expect(result.status).toBe(GoldenCaseCheckStatus.Updated);
        expect(output).toHaveBeenCalledExactlyOnceWith(`${removed}\n`);
        expect(loadGoldenRunCase(caseDirectory).config.extensionBuild).toEqual(pin);
    });

    it('migrates a v2 case to v3 with the resolved autobuild commit when the guard passes', async () => {
        const { caseDirectory, options, dependencies } = fixture();
        const issue = readFileSync(join(caseDirectory, 'issue', 'issue.json'));
        const oracle = readFileSync(join(caseDirectory, 'oracle.json'));
        const result = await checkGoldenCase(
            caseDirectory,
            { ...options, extensionVersion: pin.version },
            dependencies,
        );
        expect(result).toEqual({
            caseName: 'example-com-4',
            status: GoldenCaseCheckStatus.Updated,
            detail: expect.any(String),
            extensionBuild: pin,
        });
        expect(loadGoldenRunCase(caseDirectory).config.extensionBuild).toEqual(pin);
        expect(dependencies.resolveAutobuildCommit).toHaveBeenCalledWith(pin.version);
        expect(dependencies.readHumanCommitRuleLines).toHaveBeenCalledWith('c'.repeat(40));
        expect(readFileSync(join(caseDirectory, 'issue', 'issue.json'))).toEqual(issue);
        expect(readFileSync(join(caseDirectory, 'oracle.json'))).toEqual(oracle);
    });

    it('refuses a v2 case without an extension version and leaves run.json unchanged', async () => {
        const { caseDirectory, options, dependencies } = fixture();
        const before = readFileSync(join(caseDirectory, 'run.json'));
        const result = await checkGoldenCase(caseDirectory, options, dependencies);
        expect(result.status).toBe(GoldenCaseCheckStatus.Refused);
        expect(result.detail).toContain('--extension-version');
        expect(readFileSync(join(caseDirectory, 'run.json'))).toEqual(before);
        expect(dependencies.prepareHistoricalExtensionBuild).not.toHaveBeenCalled();
    });

    it('refuses a case whose build carries the human fix and leaves run.json unchanged', async () => {
        const { caseDirectory, options, dependencies } = fixture(false, rule);
        const before = readFileSync(join(caseDirectory, 'run.json'));
        const result = await checkGoldenCase(
            caseDirectory,
            { ...options, extensionVersion: pin.version },
            dependencies,
        );
        expect(result.status).toBe(GoldenCaseCheckStatus.Refused);
        expect(result.detail).toContain(rule);
        expect(result.detail).toContain('list 2');
        expect(readFileSync(join(caseDirectory, 'run.json'))).toEqual(before);
    });

    it('passes an unchanged v3 case without rewriting run.json', async () => {
        const { caseDirectory, options, dependencies } = fixture(true);
        const before = readFileSync(join(caseDirectory, 'run.json'));
        const inode = statSync(join(caseDirectory, 'run.json')).ino;
        expect((await checkGoldenCase(caseDirectory, options, dependencies)).status).toBe(
            GoldenCaseCheckStatus.Passed,
        );
        expect(readFileSync(join(caseDirectory, 'run.json'))).toEqual(before);
        expect(statSync(join(caseDirectory, 'run.json')).ino).toBe(inode);
        expect(dependencies.resolveAutobuildCommit).not.toHaveBeenCalled();
    });

    it('rewrites the release tag of a v3 case when the table names another release for its line', async () => {
        const { caseDirectory, options, dependencies } = fixture(true);
        vi.spyOn(releases, 'findHistoricalReleaseForVersion').mockReturnValue({
            ...releases.HISTORICAL_EXTENSION_RELEASES[0]!,
            tag: 'v5.4.3.2',
        });
        const result = await checkGoldenCase(caseDirectory, options, dependencies);
        expect(result.status).toBe(GoldenCaseCheckStatus.Updated);
        expect(loadGoldenRunCase(caseDirectory).config.extensionBuild).toEqual({
            ...pin,
            releaseTag: 'v5.4.3.2',
        });
        expect(dependencies.prepareHistoricalExtensionBuild).toHaveBeenCalledWith(
            expect.objectContaining({ build: { ...pin, releaseTag: 'v5.4.3.2' } }),
        );
        expect(dependencies.resolveAutobuildCommit).not.toHaveBeenCalled();
    });
});
